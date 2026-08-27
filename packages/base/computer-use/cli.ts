/**
 * computer-use · CLI 入口
 *
 * 用法：
 *   pnpm computer preflight            # 环境预检/自愈（首次必跑）
 *   pnpm computer start | stop         # 拉起/停止虚拟桌面
 *   pnpm computer health               # 只诊断不自愈
 *   pnpm computer '{"action":"browser_snapshot"}'   # 执行任意动作
 *   pnpm computer serve                # HTTP 服务模式（需 COMPUTER_USE_TOKEN）
 *   pnpm computer mcp                  # MCP stdio 模式
 */
import { runAction, runLifecycle } from "./client.js";

const [, , cmd, ...rest] = process.argv;

async function main(): Promise<void> {
  switch (cmd) {
    case "preflight":
    case "install":
    case "start":
    case "stop":
    case "health": {
      const r = await runLifecycle(cmd);
      console.log(r.tail);
      console.log(r.ok ? `✅ ${cmd} 通过（${r.ms}ms）` : `❌ ${cmd} 失败（${r.ms}ms）`);
      process.exit(r.ok ? 0 : 1);
    }
    case "serve": {
      await import("./serve.js");
      return;
    }
    case "mcp": {
      await import("./mcp.js");
      return;
    }
    default: {
      const raw = cmd ?? "";
      if (!raw.startsWith("{")) {
        console.error("用法：pnpm computer preflight|start|stop|health|serve|mcp|'<action_json>'");
        process.exit(2);
      }
      const r = await runAction(JSON.parse(raw) as { action: string });
      console.log(typeof r.data === "string" ? r.data : JSON.stringify(r.data, null, 1));
      process.exit(r.ok ? 0 : 1);
    }
  }
}

void main();
