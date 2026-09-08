#!/usr/bin/env node
/**
 * embedded-nats.mjs —— 自包含安装包的内嵌事件总线引导（P0-3 决策点 4：开箱即持久化）
 *
 * 职责：
 *  ① start：以用户态拉起内嵌 nats-server（-js 启用 JetStream，数据目录在可写支持目录），
 *     等待 4222 就绪后输出端点（nats://127.0.0.1:4222）；
 *  ② probe：探测本机内嵌 NATS 是否可用（供基座工厂 embeddedNats 钩子做缺省自动装配）；
 *  ③ download：打包期辅助——按平台下载官方 nats-server 二进制（pin 版本 + 可校验）。
 *
 * 纪律：与内嵌 PG 同级——全部用户态、免安装、免 sudo；二进制缺失/启动失败时
 * 上游降级为 memory 形态（事件总线不是启动阻断项，降级必须显式留痕）。
 *
 * 用法：
 *  node scripts/embedded-nats.mjs start   --bin <nats-server 路径> --data <数据目录> [--port 4222]
 *  node scripts/embedded-nats.mjs probe   [--url nats://127.0.0.1:4222] [--timeout 800]
 *  node scripts/embedded-nats.mjs download --platform darwin-arm64|windows-amd64|linux-amd64 --out <目录>
 */
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, chmodSync } from "node:fs";
import { get } from "node:https";
import { connect } from "node:net";
import { createRequire } from "node:module";
import { resolve } from "node:path";

export const NATS_VERSION = "v2.11.4";
export const NATS_DOWNLOADS = {
  "darwin-arm64": `https://github.com/nats-io/nats-server/releases/download/${NATS_VERSION}/nats-server-${NATS_VERSION}-darwin-arm64.tar.gz`,
  "darwin-amd64": `https://github.com/nats-io/nats-server/releases/download/${NATS_VERSION}/nats-server-${NATS_VERSION}-darwin-amd64.tar.gz`,
  "windows-amd64": `https://github.com/nats-io/nats-server/releases/download/${NATS_VERSION}/nats-server-${NATS_VERSION}-windows-amd64.zip`,
  "linux-amd64": `https://github.com/nats-io/nats-server/releases/download/${NATS_VERSION}/nats-server-${NATS_VERSION}-linux-amd64.tar.gz`,
};

const arg = (name, dft) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dft;
};

/** 探测端点是否可连（默认 127.0.0.1:4222；用于 probe 与启动等待） */
export function probeNats(url = "nats://127.0.0.1:4222", timeoutMs = 800) {
  const u = new URL(url);
  return new Promise((resolve) => {
    const sock = connect({ host: u.hostname, port: Number(u.port || 4222), timeout: timeoutMs });
    let settled = false;
    const done = (ok) => { if (!settled) { settled = true; sock.destroy(); resolve(ok); } };
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

/** 拉起内嵌 nats-server 并等就绪（幂等：已就绪则直接复用） */
async function start() {
  const bin = arg("bin");
  const data = arg("data");
  const port = Number(arg("port", "4222"));
  const url = `nats://127.0.0.1:${port}`;
  if (!bin || !existsSync(bin)) {
    console.log(`⚠️ 内嵌 nats-server 缺失（${bin ?? "未指定"}）——事件总线降级 memory 形态`);
    process.exit(2);
  }
  if (await probeNats(url)) {
    console.log(`✓ 内嵌 NATS 已在运行（${url}）`);
    console.log(url);
    return;
  }
  mkdirSync(data, { recursive: true });
  const out = createWriteStream(resolve(data, "../nats.log"), { flags: "a" });
  // -js 启用 JetStream；-sd 数据目录；-a 仅回环（客户机不暴露网络面）
  const child = spawn(bin, ["-js", "-sd", data, "-a", "127.0.0.1", "-p", String(port)], {
    detached: true, stdio: ["ignore", out, out],
  });
  child.unref();
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await probeNats(url)) {
      console.log(`✓ 内嵌 NATS 就绪（${url}，pid=${child.pid}，JetStream 数据目录 ${data}）`);
      console.log(url);
      return;
    }
  }
  console.error("❌ 内嵌 NATS 启动超时——事件总线降级 memory 形态（详见 nats.log）");
  process.exit(1);
}

/** probe 子命令：可用则输出端点并退出 0，否则退出 2（调用方据此降级） */
async function probe() {
  const url = arg("url", "nats://127.0.0.1:4222");
  const timeout = Number(arg("timeout", "800"));
  if (await probeNats(url, timeout)) {
    console.log(url);
    return;
  }
  process.exit(2);
}

/** download 子命令：打包期下载官方二进制（解压取 nats-server[.exe] 到 --out 目录） */
/** 下载到文件（跟随重定向，最多 5 跳） */
function fetchTo(url, dest, hops = 0) {
  return new Promise((resolveP, rejectP) => {
    if (hops > 5) { rejectP(new Error("重定向过多")); return; }
    get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        fetchTo(res.headers.location, dest, hops + 1).then(resolveP, rejectP);
        return;
      }
      if (res.statusCode !== 200) { res.resume(); rejectP(new Error(`HTTP ${res.statusCode}`)); return; }
      const ws = createWriteStream(dest);
      res.pipe(ws);
      ws.on("finish", resolveP);
      ws.on("error", rejectP);
    }).on("error", rejectP);
  });
}

async function download() {
  const platform = arg("platform");
  const outDir = arg("out");
  const url = NATS_DOWNLOADS[platform];
  if (!url || !outDir) {
    console.error(`用法：download --platform ${Object.keys(NATS_DOWNLOADS).join("|")} --out <目录>`);
    process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });
  const require = createRequire(import.meta.url);
  const { execFileSync } = require("node:child_process");
  const tmp = resolve(outDir, platform.endsWith("amd64") && platform.startsWith("windows") ? "nats.zip" : "nats.tgz");
  console.log(`→ 下载 nats-server ${NATS_VERSION}（${platform}）…`);
  // 镜像回退：github.com 直连受限的环境（如大陆沙箱/构建机）走 gh-proxy 前缀
  const candidates = [url, `https://gh-proxy.com/${url}`];
  let lastErr = null;
  for (const u of candidates) {
    try { await fetchTo(u, tmp); lastErr = null; break; } catch (e) { lastErr = e; }
  }
  if (lastErr) throw lastErr;
  if (tmp.endsWith(".zip")) {
    execFileSync("unzip", ["-o", tmp, "-d", outDir], { stdio: "inherit" });
  } else {
    execFileSync("tar", ["xzf", tmp, "-C", outDir, "--strip-components=1"], { stdio: "inherit" });
  }
  const bin = resolve(outDir, platform.startsWith("windows") ? "nats-server.exe" : "nats-server");
  if (!existsSync(bin)) {
    // zip 解出带目录层级时兜底查找
    const found = execFileSync("find", [outDir, "-name", platform.startsWith("windows") ? "nats-server.exe" : "nats-server", "-type", "f"]).toString().trim().split("\n")[0];
    if (!found) { console.error("❌ 解包后未找到 nats-server 二进制"); process.exit(1); }
    execFileSync("cp", [found, bin]);
  }
  chmodSync(bin, 0o755);
  console.log(`✅ nats-server ${NATS_VERSION} 就绪：${bin}`);
}

const cmd = process.argv[2];
if (cmd === "start") await start();
else if (cmd === "probe") await probe();
else if (cmd === "download") await download();
else {
  console.error("用法：embedded-nats.mjs start|probe|download（见文件头注释）");
  process.exit(1);
}
