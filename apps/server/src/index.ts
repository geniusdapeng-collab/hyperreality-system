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
import { getOwnerPool, getAppPool, getGatewayPool } from "@workloom/db";
import { bundlesRoot } from "@workloom/base/bundles";
import { registerFeedbackEnumsFromDisk } from "@workloom/base/evolve";
import { startSkillDistAutoSync, buildManifest, receiveReflux, type RefluxPayload } from "@workloom/base/skill-ops";

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

/** 官方运营台 HTTP 端点（仅 SKILL_OPS_MODE=official 部署挂载）：
 *  GET  /skill-dist/manifest.json —— 客户端拉取通道（分发包逐一官方签名，客户端 staging① 验签）
 *  POST /skill-ops/reflux        —— 客户回流接收（HMAC 验签，正文即客户预览的「所发」） */
if (process.env.SKILL_OPS_MODE === "official") {
  app.get("/skill-dist/manifest.json", async (c) => {
    const key = process.env.SKILL_DIST_SIGNING_KEY ?? "";
    if (!key) return c.json({ error: "SIGNING_KEY_NOT_CONFIGURED" }, 503);
    const manifest = await buildManifest(getAppPool(), { signingKey: key });
    return c.json(manifest);
  });
  app.post("/skill-ops/reflux", async (c) => {
    const key = process.env.SKILL_DIST_SIGNING_KEY ?? "";
    if (!key) return c.json({ error: "SIGNING_KEY_NOT_CONFIGURED" }, 503);
    const signature = c.req.header("x-reflux-signature") ?? "";
    const payload = (await c.req.json()) as RefluxPayload;
    try {
      // 官方实例以第一个工作区作为事件留痕 scope（运营台部署自带管理区）
      const ws = await getAppPool().query<{ id: string; tenant_id: string }>(`SELECT id, tenant_id FROM workspaces ORDER BY created_at LIMIT 1`);
      const w = ws.rows[0];
      if (!w) return c.json({ error: "OPS_WORKSPACE_MISSING" }, 503);
      const r = await receiveReflux(getAppPool(), getGatewayPool(), { tenantId: w.tenant_id, workspaceId: w.id }, {
        payload, signature, signingKey: key,
      });
      return c.json(r);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 403);
    }
  });
  console.log("官方运营台端点已挂载：GET /skill-dist/manifest.json · POST /skill-ops/reflux");
}

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

// 技能保鲜环 · 夜班窗口自动同步（机制即自动，客户零操作）：
// 每 60s 评估——夜班窗口（22:00→08:30 Asia/Shanghai）内且距上次自动同步 ≥20h 才执行；
// 未配置 SKILL_DIST_REGISTRY_URL / SKILL_DIST_SIGNING_KEY = 整体禁用（不降级跳过验签）；
// 事件归因 system:night-shift（谁干的在事件库一眼可辨）；客户可经 skillOps.setPolicy 关闭（治理主权）。
if (process.env.SKILL_DIST_REGISTRY_URL && process.env.SKILL_DIST_SIGNING_KEY) {
  startSkillDistAutoSync(getAppPool(), getGatewayPool(), {
    registryUrl: process.env.SKILL_DIST_REGISTRY_URL,
    signingKey: process.env.SKILL_DIST_SIGNING_KEY,
    instanceOf: async (scope) => {
      const client = await getAppPool().connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
        const r = await client.query<{ industry: string | null }>(`SELECT industry FROM workspaces WHERE id=$1`, [scope.workspaceId]);
        await client.query("COMMIT");
        return {
          bundles: r.rows[0]?.industry ? [r.rows[0].industry] : [],
          edition: process.env.SKILL_DIST_EDITION ?? "community",
        };
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally { client.release(); }
    },
    onResult: (r) => {
      console.log(`[skill-dist-autosync] ${r.workspaceId} 夜班同步完成：装载 ${r.result?.loaded.length ?? 0} / 待审批 ${r.result?.pending.length ?? 0} / 拦截 ${r.result?.rejected.length ?? 0}`);
    },
  });
  console.log("技能保鲜环夜班自动同步已挂载（60s 评估节拍；窗口 22:00→08:30 Asia/Shanghai）");
}

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
