/**
 * computer-use · MCP server 模式（增强项，沙箱没有的能力）
 *
 * 把全部动作暴露为标准 MCP tools（stdio JSON-RPC 2.0，无第三方依赖的最小实现），
 * 让 Claude Code / CodeBuddy 等 Agent 原生发现并调用本工作站。
 *
 * 配置示例（.mcp.json）：
 *   {
 *     "mcpServers": {
 *       "computer-use": {
 *         "command": "pnpm",
 *         "args": ["computer:mcp"],
 *         "env": { "DISPLAY": ":1" }
 *       }
 *     }
 *   }
 *
 * 工具集：
 *   computer_action    —— 通用动作执行（透传 65 个 toolkit 动作）
 *   computer_preflight —— 环境预检/自愈（install→desktop→CDP→VNC 一键就绪）
 *   computer_snapshot  —— L1 零 token 读页面结构（快捷方式）
 *   computer_screenshot—— L3 截图取证（返回 base64，高 token 慎用）
 */
import { runAction, runLifecycle } from "./client.js";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "workloom-computer-use", version: "0.1.0" };

const TOOLS = [
  {
    name: "computer_action",
    description:
      "执行 computer-use 动作（L1 浏览器 DOM 级 / L2 AT-SPI 语义级 / L3 像素级）。action 字段为动作名（如 browser_goto/browser_snapshot/browser_click/screenshot 等 65 个），其余字段原样透传。",
    inputSchema: {
      type: "object",
      properties: { action: { type: "string", description: "动作名" } },
      required: ["action"],
      additionalProperties: true,
    },
  },
  {
    name: "computer_preflight",
    description: "环境预检与自愈：安装→Xvfb 桌面→窗口管理→x11vnc→noVNC→Chromium CDP→截图自检。退出码 0 即就绪。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "computer_snapshot",
    description: "L1 零 token 读取当前浏览器页面结构（StaticText/button/link 全量），验证首选。",
    inputSchema: {
      type: "object",
      properties: { root_selector: { type: "string", description: "可选，限定 DOM 子树" } },
    },
  },
  {
    name: "computer_screenshot",
    description: "L3 全屏截图（base64 PNG，约 1000–2000 token，关键节点取证用，勿滥用）。",
    inputSchema: { type: "object", properties: {} },
  },
];

function reply(id: string | number, result: unknown): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
function replyError(id: string | number, code: number, message: string): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

function toolText(text: string, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

async function callTool(name: string, args: Record<string, unknown>) {
  switch (name) {
    case "computer_preflight": {
      const r = await runLifecycle("preflight");
      return toolText(`${r.ok ? "✅ preflight 通过" : "❌ preflight 失败"}\n${r.tail}`, !r.ok);
    }
    case "computer_snapshot": {
      const r = await runAction({ action: "browser_snapshot", ...(args.root_selector ? { root_selector: args.root_selector } : {}) });
      return toolText(typeof r.data === "string" ? r.data : JSON.stringify(r.data), !r.ok);
    }
    case "computer_screenshot": {
      const r = await runAction<{ base64_image?: string }>({ action: "screenshot" });
      if (!r.ok) return toolText(`截图失败：${r.error}`, true);
      const b64 = typeof r.data === "object" && r.data !== null ? r.data.base64_image : undefined;
      if (b64) return { content: [{ type: "image", data: b64, mimeType: "image/png" }] };
      return toolText(typeof r.data === "string" ? r.data : JSON.stringify(r.data));
    }
    case "computer_action": {
      const r = await runAction(args as { action: string } & Record<string, unknown>);
      return toolText(typeof r.data === "string" ? r.data : JSON.stringify(r.data), !r.ok);
    }
    default:
      throw new Error(`未知工具：${name}`);
  }
}

async function handle(req: JsonRpcRequest): Promise<void> {
  const { id, method, params } = req;
  try {
    switch (method) {
      case "initialize":
        return reply(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        });
      case "notifications/initialized":
      case "initialized":
        return; // 通知无响应
      case "ping":
        return reply(id, {});
      case "tools/list":
        return reply(id, { tools: TOOLS });
      case "tools/call": {
        const name = String(params?.name ?? "");
        const args = (params?.arguments ?? {}) as Record<string, unknown>;
        const result = await callTool(name, args);
        return reply(id, result);
      }
      default:
        return replyError(id, -32601, `method not found: ${method}`);
    }
  } catch (err) {
    return replyError(id, -32000, err instanceof Error ? err.message : String(err));
  }
}

// stdio 主循环：按行读取 JSON-RPC
let buf = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk: string) => {
  buf += chunk;
  let idx: number;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      const req = JSON.parse(line) as JsonRpcRequest;
      if (req.id !== undefined) void handle(req);
    } catch {
      /* 忽略非 JSON 行 */
    }
  }
});
process.stderr.write("computer-use MCP server 已启动（stdio）\n");
