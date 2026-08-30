/**
 * model-router · 国产三档模型池（v3.0 · 客户侧零配置，平台统一预置）
 *
 * L1 轻量档（0.2×）：DeepSeek-V4-Flash / GLM-5.3-Flash / Qwen3.8 小尺寸 —— 意图分类、改写、客服
 * L2 中坚档（1.0×）：DeepSeek-V4-Pro / GLM-5.2 / MiniMax M3 —— 规划、内容生成、汇报合成
 * L3 旗舰档（3.0×）：GLM-5.3 / Kimi K3 / Qwen3.8-Max —— 六步深度、体检报告、汰换诊断
 *
 * 每档三家互备支撑降级链；长文路由条件优先档内长文款（longContext）。
 * mock 模式下全池为确定性 MockProvider（D4 离线可跑，降级链可故障注入实证）。
 */
import { MockProvider, OpenAiCompatibleProvider, type ModelProvider } from "./providers.js";
import type { Tier3 } from "./policy.js";
import { TIER3_ORDER } from "./policy.js";

export interface ModelSpec {
  id: string;
  tier: Tier3;
  vendor: "deepseek" | "zhipu" | "aliyun" | "moonshot" | "minimax";
  /** 长上下文款（>32K 路由条件优先） */
  longContext?: boolean;
  /** 同结果更快速变体（智能版 L1 体验路由用） */
  fastVariant?: string;
  /** 该 vendor 的 baseURL 环境变量名（缺省回退 LLM_BASE_URL） */
  baseUrlEnv: string;
}

/** 国产三档模型目录（平台预置；客户不可见不可配） */
export const MODEL_CATALOG: readonly ModelSpec[] = [
  // L1 轻量档
  { id: "deepseek-v4-flash", tier: "L1", vendor: "deepseek", baseUrlEnv: "DEEPSEEK_BASE_URL" },
  { id: "glm-5.3-flash", tier: "L1", vendor: "zhipu", baseUrlEnv: "ZHIPU_BASE_URL" },
  { id: "qwen-3.8-flash", tier: "L1", vendor: "aliyun", baseUrlEnv: "DASHSCOPE_BASE_URL" },
  // L2 中坚档
  { id: "deepseek-v4-pro", tier: "L2", vendor: "deepseek", longContext: true, baseUrlEnv: "DEEPSEEK_BASE_URL" },
  { id: "glm-5.2", tier: "L2", vendor: "zhipu", longContext: true, baseUrlEnv: "ZHIPU_BASE_URL" },
  { id: "minimax-m3", tier: "L2", vendor: "minimax", longContext: true, fastVariant: "minimax-m3-highspeed", baseUrlEnv: "MINIMAX_BASE_URL" },
  // L3 旗舰档
  { id: "glm-5.3", tier: "L3", vendor: "zhipu", baseUrlEnv: "ZHIPU_BASE_URL" },
  { id: "kimi-k3", tier: "L3", vendor: "moonshot", baseUrlEnv: "MOONSHOT_BASE_URL" },
  { id: "qwen-3.8-max", tier: "L3", vendor: "aliyun", baseUrlEnv: "DASHSCOPE_BASE_URL" },
] as const;

export function catalogByTier(tier: Tier3): ModelSpec[] {
  return MODEL_CATALOG.filter((m) => m.tier === tier);
}

/** 档内降级链（model_id 有序）；长文需求时长文款前置；链尾跨档兜底（noDowngrade 场景由路由层截断） */
export function chainFor(tier: Tier3, opts: { longContext?: boolean; allowCrossTier?: boolean } = {}): string[] {
  const same = catalogByTier(tier);
  const ordered = opts.longContext
    ? [...same.filter((m) => m.longContext), ...same.filter((m) => !m.longContext)]
    : [...same];
  const chain = ordered.map((m) => m.id);
  if (opts.allowCrossTier !== false) {
    // 跨档兜底：L3→L2→L1 逐档追加（保可用性；金融等 noDowngrade 场景在路由层截断此段）
    const idx = TIER3_ORDER.indexOf(tier);
    for (let i = idx - 1; i >= 0; i--) chain.push(...catalogByTier(TIER3_ORDER[i]!).map((m) => m.id));
  }
  return chain;
}

/** 按 .env 装配模型池（mock → 全池 MockProvider；真实 → 按 vendor 环境变量装配 OpenAI 兼容 Provider） */
export function poolFromEnv(opts: { mockOpts?: Record<string, { failFirst?: number; down?: boolean }> } = {}): Map<string, ModelProvider> {
  const pool = new Map<string, ModelProvider>();
  if ((process.env.LLM_PROVIDER ?? "mock") === "mock") {
    for (const m of MODEL_CATALOG) pool.set(m.id, new MockProvider(m.id, opts.mockOpts?.[m.id]));
    return pool;
  }
  for (const m of MODEL_CATALOG) {
    const baseUrl = process.env[m.baseUrlEnv] ?? process.env.LLM_BASE_URL;
    if (!baseUrl) continue; // 该 vendor 未配置 → 池内缺位，降级链自动跳过（healthy=false 语义）
    pool.set(m.id, new OpenAiCompatibleProvider(m.id, { baseUrl, apiKey: process.env.LLM_API_KEY || undefined }));
  }
  return pool;
}
