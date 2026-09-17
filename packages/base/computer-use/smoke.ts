/**
 * computer-use · 端到端冒烟（需图形环境：沙箱或已部署的工作站）
 *
 * 验证链：preflight → browser_connect → 打开 data: 页 → snapshot 读结构 →
 *         fill/eval → screenshot 取证 → HTTP 服务模式 → MCP 握手。
 * 用法：pnpm computer:smoke
 * 退出码：0=全绿，1=存在失败项。
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runAction, runLifecycle } from "./client.js";

let pass = 0;
let fail = 0;
const ok = (name: string) => {
  console.log(`  ✅ ${name}`);
  pass++;
};
const bad = (name: string, detail: string) => {
  console.log(`  ❌ ${name} —— ${detail}`);
  fail++;
};
const check = (name: string, cond: boolean, detail = "") => (cond ? ok(name) : bad(name, detail));

console.log("== computer-use 端到端冒烟 ==");

// 1. 预检（自愈式：装/拉起整套桌面栈）
const pre = await runLifecycle("preflight", { timeoutMs: 300_000 });
check("preflight 环境就绪", pre.ok, pre.tail.split("\n").pop() ?? "");

// 2. L1 浏览器链路
const conn = await runAction({ action: "browser_connect" });
check("browser_connect（CDP 接管）", conn.ok && JSON.stringify(conn.data).includes("connected"), conn.error ?? "");

// 本地起一个小 HTTP 服务供浏览器打开（toolkit 的 browser_goto 仅接受 http/https/about:）
const { createServer: createHttpServer } = await import("node:http");
const pageServer = createHttpServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(
    "<html><title>smoke</title><body><h1 id=t>computer-use-smoke</h1><input id=i /><button id=b>go</button></body></html>",
  );
});
await new Promise<void>((r) => pageServer.listen(19764, "127.0.0.1", () => r()));
const gotoR = await runAction({ action: "browser_goto", url: "http://127.0.0.1:19764/" });
check("browser_goto（本地测试页）", gotoR.ok, gotoR.error ?? JSON.stringify(gotoR.data).slice(0, 120));

const snap = await runAction({ action: "browser_snapshot" });
check("browser_snapshot（零 token 读结构）", snap.ok && JSON.stringify(snap.data).length > 100, `len=${JSON.stringify(snap.data).length}`);

const fill = await runAction({ action: "browser_fill", selector: "#i", value: "hello-agent" });
check("browser_fill（表单填充）", fill.ok, fill.error ?? "");

const evalR = await runAction({ action: "browser_eval", expression: "document.querySelector('#i').value" });
check("browser_eval（回读填充值）", evalR.ok && JSON.stringify(evalR.data).includes("hello-agent"), JSON.stringify(evalR.data).slice(0, 120));

// 3. L3 截图取证
const shot = await runAction({ action: "screenshot" });
check("screenshot（L3 取证）", shot.ok && JSON.stringify(shot.data).length > 500, shot.error ?? "");

// 4. HTTP 服务模式（增强项）
process.env.COMPUTER_USE_TOKEN = "smoke-token";
const { createComputerUseServer } = await import("./serve.js");
const server = createComputerUseServer();
await new Promise<void>((r) => server.listen(19763, "127.0.0.1", () => r()));
try {
  const h = (await fetch("http://127.0.0.1:19763/health").then((r) => r.json())) as { ok?: boolean };
  check("HTTP /health 探活", h.ok === true);
  const unauth = await fetch("http://127.0.0.1:19763/action", { method: "POST", body: "{}" });
  check("HTTP 未鉴权拒绝（401）", unauth.status === 401);
  const ar = (await fetch("http://127.0.0.1:19763/action", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer smoke-token" },
    body: JSON.stringify({ action: "browser_url" }),
  }).then((r) => r.json())) as { ok?: boolean; action?: string };
  check("HTTP /action 远程执行", ar.ok === true && ar.action === "browser_url", JSON.stringify(ar).slice(0, 120));
} finally {
  server.close();
}

// 5. MCP 握手（增强项）
const mcpPath = fileURLToPath(new URL("./mcp.ts", import.meta.url));
const mcp = spawn("node", ["--import", "tsx", mcpPath], { stdio: ["pipe", "pipe", "pipe"] });
let mcpOut = "";
mcp.stdout.on("data", (d: Buffer) => (mcpOut += d.toString()));
mcp.stderr.on("data", () => undefined);
mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
await new Promise((r) => setTimeout(r, 4000));
mcp.kill();
check("MCP initialize 握手", mcpOut.includes("workloom-computer-use"), mcpOut.slice(0, 120));
check(
  "MCP tools/list 四工具",
  (mcpOut.match(/computer_(action|preflight|snapshot|screenshot)/g) ?? []).length >= 4,
  mcpOut.slice(0, 200),
);

pageServer.close();
console.log(`\n结果：PASS=${pass} · FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
