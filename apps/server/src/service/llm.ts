/**
 * service · LLM 调用面（v3.0 收口：统一经 routeSmart 路由，禁止裸调 provider）
 *
 * 场景化路由：每个调用点带 scene（model-policy.yml 场景表 key）与 plan（租户套餐）；
 * 计量真实化：每次调用经 GatewayEventSink 写 model.call 事件（账单=事件投影 L6.3）；
 * mock / 缺配置 → undefined，链路走确定性兜底并标注 mock:true（D4 离线可跑）。
 */
import type pg from "pg";
import {
  GatewayEventSink, loadModelPolicy, poolFromEnv, routeSmart,
  type ModelPolicy, type ModelProvider, type PlanId,
} from "@workloom/base/model-router";
import { bundlesRoot } from "@workloom/base/bundles";
import { join } from "node:path";

export type LlmCall = (prompt: string) => Promise<string>;

/* ---------- 模型池与策略缓存（进程级；env/落地向导写盘后由调用方 resetLlmAssembly 复位） ---------- */

let cachedPool: Map<string, ModelProvider> | undefined;
const policyCache = new Map<string, ModelPolicy | null>();

export function resetLlmAssembly(): void {
  cachedPool = undefined;
  policyCache.clear();
}

function pool(): Map<string, ModelProvider> {
  if (!cachedPool) cachedPool = poolFromEnv();
  return cachedPool;
}

/** 行业路由策略：bundle 第⑦槽 model-policy.yml（缺失 → null，路由层落底座默认） */
export function modelPolicyFor(industry: string | null | undefined): ModelPolicy | undefined {
  const slug = industry ?? "_default";
  if (!policyCache.has(slug)) {
    if (!industry) {
      policyCache.set(slug, null);
    } else {
      const r = loadModelPolicy(join(bundlesRoot(), industry));
      if (r.issues.length > 0) console.error(`⚠️ model-policy.yml 非法（${industry}）：${r.issues.join("；")}，落底座默认`);
      policyCache.set(slug, r.policy);
    }
  }
  return policyCache.get(slug) ?? undefined;
}

/**
 * 场景化 LLM 调用面（生产装配入口）。
 * mock 模式 → undefined（via=rule 兜底语义不变）；真实模式 → 经 routeSmart 全链路：
 * 场景表 × 套餐映射 × 复杂度信号 × 降级链 × 真实计量 × 事件留痕。
 */
export function routedLlmCall(deps: {
  gateway: pg.Pool;
  scope: { tenantId: string; workspaceId: string };
  scene: string;
  plan?: PlanId;
  industry?: string | null;
  /** 行业异步解析（工作区 industry 列查询有 IO；惰性求值并缓存） */
  industryResolver?: () => Promise<string | null>;
}): LlmCall | undefined {
  if ((process.env.LLM_PROVIDER ?? "mock") === "mock") return undefined;
  try {
    const sink = new GatewayEventSink(deps.gateway, deps.scope);
    return async (prompt: string) => {
      const industry = deps.industryResolver ? await deps.industryResolver() : deps.industry;
      const policy = modelPolicyFor(industry);
      const r = await routeSmart(
        {
          action: deps.scene, scene: deps.scene, plan: deps.plan,
          messages: [{ role: "user", content: prompt }],
        },
        pool(), sink, { policy },
      );
      if ((r.kind === "answered" || r.kind === "circuit_broken") && r.text !== undefined) return r.text;
      if (r.kind === "reused" && r.text !== undefined) return r.text;
      throw new Error(`模型路由不可用（${r.kind}${r.passthrough ? "/passthrough" : ""}）`);
    };
  } catch {
    return undefined; // 装配失败 → 确定性兜底（via=rule 留痕）
  }
}

/* ---------- 向后兼容：无场景旧接口（等价于 scene=generic 的无 sink 轻量路径） ---------- */

let cached: LlmCall | null | undefined;
let cachedScene = "generic";

export function llmCall(scene = "generic"): LlmCall | undefined {
  if (cached !== undefined && cachedScene === scene) return cached ?? undefined;
  try {
    if ((process.env.LLM_PROVIDER ?? "mock") === "mock") {
      cached = null;
      return undefined;
    }
    // 旧路径仍可用但已标注：新代码一律用 routedLlmCall(scene)（计量/路由纪律）
    const providers = pool();
    cachedScene = scene;
    cached = async (prompt: string) => {
      const { routeSmart: rs } = await import("@workloom/base/model-router");
      const traces: unknown[] = [];
      const r = await rs(
        { action: scene, scene, messages: [{ role: "user", content: prompt }] },
        providers,
        {
          recordModelTrace: async (t) => { traces.push(t); },
          recordDegradation: async () => undefined,
          recordCircuitBreak: async () => undefined,
        },
      );
      if ((r.kind === "answered" || r.kind === "reused" || r.kind === "circuit_broken") && r.text !== undefined) return r.text;
      throw new Error(`模型路由不可用（${r.kind}）`);
    };
    return cached;
  } catch {
    cached = null;
    return undefined;
  }
}
