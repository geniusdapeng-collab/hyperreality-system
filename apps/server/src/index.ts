/**
 * apps/server 最小入口（A6）：Hono + tRPC v11（fetch adapter）+ 健康检查
 * 端口：SERVER_PORT（默认 8787，见 .env.example）
 * 纪律：中间件栈（鉴权/租户解析/版本能力 403/错误规约）在阶段二 B5 挂载；
 *      本卡只保证「起得来、握得上、查得到 DB」。
 */
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { appRouter } from "./trpc/router.js";
import { createContext } from "./trpc/context.js";
import { serviceGateway } from "./service/gateway.js";
import { getOwnerPool } from "@workloom/db";
import { bundlesRoot } from "@workloom/base/bundles";
import { registerFeedbackEnumsFromDisk } from "@workloom/base/evolve";

const app = new Hono();

app.use(
  "*",
  cors({
    origin: (origin) => origin ?? "*", // 本地开发：vite dev server 代理外也允许直连
    credentials: true,
  }),
);

/** 裸健康检查（不进 tRPC，供 start.sh/编排探活） */
app.get("/health", (c) => c.json({ ok: true, service: "workloom-im-server" }));

/** tRPC v11 over HTTP（fetch adapter；httpBatchLink 由客户端侧决定） */
app.all("/trpc/*", async (c) => {
  const res = await fetchRequestHandler({
    endpoint: "/trpc",
    req: c.req.raw,
    router: appRouter,
    createContext: () => createContext(c.req.raw),
  });
  return res;
});

const port = Number(process.env.SERVER_PORT ?? 8787);

/** C 端公开网关（AI 服务前台；独立于员工 tRPC，c-token 鉴权 + 限流） */
app.route("/c", serviceGateway);

/** apps/webc 静态托管（C 端小程序/H5 演示壳；dist 不存在则跳过不报错） */
const webcDist = join(dirname(fileURLToPath(import.meta.url)), "../../webc/dist");
if (existsSync(webcDist)) {
  app.use("/app/c/*", serveStatic({ root: webcDist, rewriteRequestPath: (p) => p.replace(/^\/app\/c/, "") || "/" }));
  app.get("/app/c", (c) => c.redirect("/app/c/"));
  console.log(`apps/webc 静态托管已挂载：/app/c → ${webcDist}`);
}

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`WorkLoom IM 底座 server 已启动：http://localhost:${info.port}（tRPC: /trpc/*，C 端网关: /c/*）`);
});

// D24 自我进化飞轮 M1：启动时为全部已激活行业的工作区装载反馈枚举表（Bundle 第⑧槽）。
// 失败不阻断启动（枚举表缺失 = 该行业未提供第⑧槽，decide 校验自动放行，向后兼容）。
registerFeedbackEnumsFromDisk(getOwnerPool(), bundlesRoot())
  .then((registered) => {
    if (registered.length > 0) {
      console.log(`反馈枚举表已装载：${registered.map((r) => `${r.industry}→${r.workspaceId}（${r.count} 条）`).join("、")}`);
    }
  })
  .catch((err) => {
    console.warn(`反馈枚举表装载失败（不阻断启动，decide 校验按未装配放行）：${err instanceof Error ? err.message : err}`);
  });
