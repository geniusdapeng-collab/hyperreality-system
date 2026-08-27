/**
 * computer-use · HTTP 服务模式（增强项，沙箱没有的能力）
 *
 * 把 65 个动作包成 HTTP API，让"大脑"（云端 Agent / CI / captain 夜班节拍）
 * 远程驱动"手"（专用工作站）。生产部署形态：
 *
 *   工作站（Ubuntu 小主机/VM/容器）：
 *     pnpm computer:serve          # 监听 :9763，需 COMPUTER_USE_TOKEN
 *   大脑侧：
 *     curl -X POST http://工作站:9763/action \
 *       -H "authorization: Bearer $COMPUTER_USE_TOKEN" \
 *       -d '{"action":"browser_goto","url":"http://localhost:5173"}'
 *
 * 端点：
 *   GET  /health   —— 存活探针（无需鉴权）
 *   GET  /actions  —— 已注册动作清单（toolkit registry 自省）
 *   POST /action   —— 执行动作，body 即 action JSON，返回 ComputerResult
 *   POST /lifecycle/:name —— install|preflight|start|stop|health
 *
 * 安全纪律：必须设置 COMPUTER_USE_TOKEN（未设置时拒绝启动）；
 * 建议仅监听内网/loopback（COMPUTER_USE_HOST 默认 127.0.0.1）。
 */
import { createServer } from "node:http";
import { runAction, runLifecycle, SCRIPTS } from "./client.js";
import type { ComputerAction } from "./types.js";

const PORT = Number(process.env.COMPUTER_USE_PORT ?? 9763);
const HOST = process.env.COMPUTER_USE_HOST ?? "127.0.0.1";
const TOKEN = process.env.COMPUTER_USE_TOKEN ?? "";

function send(res: import("node:http").ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(text);
}

async function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  let s = "";
  for await (const chunk of req) s += chunk;
  return s;
}

export function createComputerUseServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
    try {
      if (url.pathname === "/health") {
        return send(res, 200, { ok: true, service: "computer-use", scripts: Object.keys(SCRIPTS) });
      }
      // 除 /health 外全部要求鉴权
      if (!TOKEN || req.headers.authorization !== `Bearer ${TOKEN}`) {
        return send(res, 401, { ok: false, error: "unauthorized（需 COMPUTER_USE_TOKEN）" });
      }
      if (url.pathname === "/actions" && req.method === "GET") {
        // 自省：让 toolkit 打印注册表（若不支持则退化为静态提示）
        const r = await runAction({ action: "list_actions" }, { timeoutMs: 15_000 });
        return send(res, r.ok ? 200 : 200, { ok: true, note: "动作清单见 docs/action-reference.md", probe: r.data });
      }
      if (url.pathname.startsWith("/lifecycle/") && req.method === "POST") {
        const name = url.pathname.split("/")[2] as keyof typeof SCRIPTS;
        if (!(name in SCRIPTS)) return send(res, 404, { ok: false, error: `未知生命周期脚本：${name}` });
        const r = await runLifecycle(name);
        return send(res, r.ok ? 200 : 500, r);
      }
      if (url.pathname === "/action" && req.method === "POST") {
        const raw = await readBody(req);
        let action: ComputerAction;
        try {
          action = JSON.parse(raw) as ComputerAction;
        } catch {
          return send(res, 400, { ok: false, error: "body 必须是 action JSON" });
        }
        if (!action.action) return send(res, 400, { ok: false, error: "缺少 action 字段" });
        const r = await runAction(action);
        return send(res, r.ok ? 200 : 500, r);
      }
      return send(res, 404, { ok: false, error: "not found" });
    } catch (err) {
      return send(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}

// 直接执行时启动服务
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/.*\//, ""));
if (isMain || process.argv[1]?.endsWith("serve.ts")) {
  if (!TOKEN) {
    console.error("⛔ 拒绝启动：未设置 COMPUTER_USE_TOKEN（生产服务必须鉴权）");
    process.exit(1);
  }
  createComputerUseServer().listen(PORT, HOST, () => {
    console.log(`computer-use HTTP 服务已就绪：http://${HOST}:${PORT}（/health 探活，/action 执行）`);
  });
}
