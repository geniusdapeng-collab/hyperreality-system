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
import { createHash } from "node:crypto";
import { startThreadScheduler } from "./runtime/scheduler.js";
import { gatewayAppend } from "@workloom/base/workdata";
import { registerBundleAskFacts } from "./runtime/ask-facts-loader.js";
import { readVoiceFile, synthesizeVoice, voiceStationConfig } from "./voice/station.js";

const app = new Hono();

app.use(
  "*",
  cors({
    // 桌面自包含/生产：仅本机回环来源（web 从 127.0.0.1:5173 跨端口调 8787 属跨域，
    // 必须显式放行回环）；开发期放宽任意来源直连（D-SEC1 交付审计实证：反射 * + 0.0.0.0 = 局域网裸奔）
    origin: (origin) => {
      if (process.env.NODE_ENV === "production") {
        return origin && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin) ? origin : null;
      }
      return origin ?? "*";
    },
    credentials: true,
  }),
);

/** 裸健康检查（不进 tRPC，供 start.sh/编排探活） */
app.get("/health", (c) => c.json({ ok: true, service: "workloom-im-server" }));

/**
 * 本机克隆音色（小织/织伴的默认音色）
 *  - GET /api/voice/status → 工位是否就绪（客户端据此决定是否走克隆音色，不探测就不猜）
 *  - GET /api/voice/speech?text=…&profile=… → 返回 wav；工位不可达/未配置一律 503，
 *    客户端按契约回落到系统女声并锁定同一音色（宁可换声线，也不让播报消失）。
 * 声纹只在本机工位：服务端只传 profile 名与文本，不搬运参考音频。
 */
const voiceConfig = voiceStationConfig();
app.get("/api/voice/status", (c) =>
  c.json({
    enabled: voiceConfig.enabled,
    configured: Boolean(voiceConfig.token),
    profile: voiceConfig.profile,
    bridge: voiceConfig.bridgeUrl,
  }));

app.get("/api/voice/speech", async (c) => {
  const text = c.req.query("text") ?? "";
  const profile = c.req.query("profile") || voiceConfig.profile;
  const result = await synthesizeVoice(text, { config: voiceConfig, profile });
  if (!result.ok) {
    return c.json({ error: result.error, message: result.message, profile: result.profile }, 503);
  }
  const audio = await readVoiceFile(result.file);
  return new Response(audio, {
    status: 200,
    headers: {
      "content-type": "audio/wav",
      "cache-control": "no-store",
      "x-voice-profile": result.profile,
      "x-voice-cached": result.cached ? "1" : "0",
    },
  });
});

/** tRPC v11 over HTTP（fetch adapter；httpBatchLink 由客户端侧决定） */
app.all("/trpc/*", async (c) => {
  const res = await fetchRequestHandler({
    endpoint: "/trpc",
    req: c.req.raw,
    router: appRouter,
    createContext: () => createContext(c.req.raw),
    /**
     * GR-12（2026-09-28 压测）：tRPC 默认把错误交回客户端就完事——实测 12 路并发派遣
     * 打出 10 个 500，服务端日志 0 条记录（客户报障时无从查起）。
     * 这里统一落日志（path/code/消息摘要 + 请求指纹前 8 位，不记 PII），
     * 5xx（INTERNAL_SERVER_ERROR）额外经安全网关写系统域事件（append-only 可审计）。
     * onError 内任何失败都必须吞掉：错误处理路径再抛错会把正常响应也带崩。
     */
    onError: ({ path, error, type, ctx }) => {
      const ref = createHash("sha256")
        .update(`${path ?? "-"}|${error.code}|${error.message}`)
        .digest("hex")
        .slice(0, 8);
      console.error(`[trpc] ${type ?? "unknown"} ${path ?? "-"} → ${error.code}: ${error.message}（ref=${ref}）`);
      if (error.code !== "INTERNAL_SERVER_ERROR") return;
      const identity = ctx?.identity;
      if (!identity) return;
      void gatewayAppend(getGatewayPool(), {
        tenantId: identity.tenantId,
        workspaceId: identity.workspaceId,
        actor: { id: "system", type: "system" },
      }, {
        who: { type: "system", id: "system" },
        context: {
          tenant_id: identity.tenantId, workspace_id: identity.workspaceId,
          time: new Date().toISOString(), channel: "server",
        },
        object: { type: "server_request", id: ref },
        decision: {
          action: "system.error",
          after: { path: path ?? null, code: error.code, ref, message: error.message.slice(0, 200) },
          basis: ["服务端 5xx 统一留痕（GR-12）：错误可见、可审计、可复现"],
        },
        rule_impact: [],
      }).catch((err: unknown) => {
        console.error("[trpc] 5xx 事件留痕失败（不二次抛出）", err instanceof Error ? err.message : String(err));
      });
    },
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

// 桌面自包含默认仅本机回环（D-SEC1 交付审计实证：@hono/node-server 缺省绑 0.0.0.0，
// 客户机上等于对局域网开放 API）；官方服务端部署用 SERVER_HOST=0.0.0.0 显式放开
const host = process.env.SERVER_HOST ?? "127.0.0.1";
serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  console.log(`WorkLoom IM 底座 server 已启动：http://${host}:${info.port}（tRPC: /trpc/*，C 端网关: /c/*）`);
  /**
   * GR-16：本机调度器——没有它，`queued` 线程（agent 模式、任务页派活、非"立即执行"的 quest）
   * 永远不会被执行。启动时顺带把崩溃遗留的 running 线程转 paused（可续跑）。
   */
  startThreadScheduler();
  /**
   * GR-19：装载各行业 ask 事实面——不装的话，右侧对话框问领域问题只会得到
   * 底座通用事实（实测"问什么都是没有相关记录"）。失败不阻塞启动（回落通用事实面）。
   */
  void registerBundleAskFacts()
    .then((industries) => {
      if (industries.length > 0) console.log(`行业 ask 事实面已装载：${industries.join("、")}`);
    })
    .catch((err) => console.error("[ask-facts] 装载失败（不阻塞启动）", err instanceof Error ? err.message : String(err)));
  /**
   * 注：X-04（客户知识库接进 ask 事实面）与行业规划器注册都不在这里——
   * 它们要 import 行业仓保留资产（`service/kb.ts` / `industry/**`），而本文件属于
   * **基座公共分发面**（sync/base-scope.json 的 include），公共面到行业资产之间
   * 不允许新增跨域相对依赖（base-sync 依赖闭包门禁会 fail）。
   * 两类接线改由行业仓保留的 `apps/server/src/trpc/router.ts` 在模块加载时注入，
   * 见该文件底部的「启动期接线」段。
   */
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
