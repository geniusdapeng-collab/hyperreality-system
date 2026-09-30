#!/usr/bin/env node
/**
 * CNB Release 发布助手（MC-202）
 *
 * 桌面安装包在 CNB 内构建后，通过本脚本落到 CNB Release（事实源侧下载地址）。
 * 纪律：以「本地字节 == 远端回读字节（sha512）」为唯一成功判据；任一步失败即退出 1，
 * 不静默降级、不留下「登记了但没制品」的半态（调用方负责失败时的回滚/告警）。
 *
 * 用法：
 *   CNB_TOKEN=... node scripts/cnb-release-publish.mjs --tag v1.1.0 [--create] [--body 说明] <file...>
 * 环境：CNB_TOKEN（仓库密钥注入）；CNB_REPO 可覆盖仓库（默认 workloom-ai/workloom-im）。
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";

const API = "https://api.cnb.cool";
const REPO = process.env.CNB_REPO ?? "workloom-ai/workloom-im";

const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const has = (name) => argv.includes(name);
const tag = flag("--tag");
const files = argv.filter((value, index) => !value.startsWith("--") && argv[index - 1] !== "--tag"
  && argv[index - 1] !== "--body" && argv[index - 1] !== "--name");
const body = flag("--body") ?? `WorkLoom 织元桌面安装包（CNB 托管，tag=${tag}）`;
const releaseName = flag("--name") ?? tag;
const token = process.env.CNB_TOKEN?.trim();

if (!tag || files.length === 0) {
  console.error("用法：CNB_TOKEN=... node scripts/cnb-release-publish.mjs --tag vX.Y.Z [--create] <file...>");
  process.exit(2);
}
if (!token) {
  console.error("缺少 CNB_TOKEN（CNB 访问令牌）——发布通道必须显式注入，拒绝匿名上传");
  process.exit(2);
}
for (const file of files) {
  try {
    if (!statSync(file).isFile()) throw new Error("不是文件");
  } catch (err) {
    console.error(`待发布资产不可用：${file}（${err instanceof Error ? err.message : err}）`);
    process.exit(2);
  }
}

const headers = { authorization: `Bearer ${token}`, accept: "application/json", "content-type": "application/json" };
const sha512Base64 = (buffer) => `sha512-${createHash("sha512").update(buffer).digest("base64")}`;

async function api(url, options = {}) {
  const response = await fetch(`${API}${url}`, { ...options, headers: { ...headers, ...(options.headers ?? {}) } });
  const text = await response.text();
  if (!response.ok) throw new Error(`${options.method ?? "GET"} ${url} → ${response.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

async function ensureRelease() {
  try {
    return await api(`/${REPO}/-/releases/tags/${encodeURIComponent(tag)}`);
  } catch {
    if (!has("--create")) {
      throw new Error(`Release ${tag} 不存在；如需创建请显式传 --create（避免误发到错误 tag）`);
    }
    return api(`/${REPO}/-/releases`, {
      method: "POST",
      body: JSON.stringify({
        tag_name: tag, name: releaseName, body, target_commitish: "main", draft: false, prerelease: false,
      }),
    });
  }
}

const release = await ensureRelease();
for (const file of files) {
  const name = basename(file);
  const buffer = readFileSync(file);
  const digest = sha512Base64(buffer);
  const upload = await api(`/${REPO}/-/releases/${release.id}/asset-upload-url`, {
    method: "POST",
    body: JSON.stringify({ asset_name: name, size: buffer.length, overwrite: true }),
  });
  const put = await fetch(upload.upload_url, {
    method: "PUT", body: buffer, headers: { "content-type": "application/octet-stream" },
  });
  if (!put.ok) throw new Error(`上传 ${name} 失败：${put.status} ${(await put.text()).slice(0, 200)}`);
  await api(upload.verify_url, { method: "POST", body: "{}" });

  // 回读复核：远端字节必须与本地逐字节一致（sha512 相同且长度相同）
  const url = `https://cnb.cool/${REPO}/-/releases/download/${tag}/${encodeURIComponent(name)}`;
  const downloaded = Buffer.from(await (await fetch(url)).arrayBuffer());
  if (downloaded.length !== buffer.length || sha512Base64(downloaded) !== digest) {
    throw new Error(`发布资产与本地字节不一致：${name}（本地 ${buffer.length}B/${digest}，远端 ${downloaded.length}B）`);
  }
  console.log(`✓ ${name} ${buffer.length}B ${digest} → ${url}`);
}
console.log(`发布完成：${files.length} 个资产 → ${REPO}@${tag}`);
