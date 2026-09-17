/**
 * model-router · 多模态生成池（v3.0 下一迭代：视频/图像生成的路由 + 渲染额度台账）
 *
 * 与文本 chat 的两点本质差异（方案 2.3 推论①②）：
 *   ① 模态分池分计量：视频按秒、图像按张，成本超文本 token 百倍量级——单独台账；
 *   ② 异步任务制：submit → task_id → poll → 回填，路由器原生管理任务生命周期。
 *
 * 降级链：Seedance 首选，可灵/即梦备援（env 未配置的供应商池内缺位，链自动跳过）；
 * 额度台账：套餐秒数配额（智享按量 / 标准 100s / 智能 500s 每月），
 *   用量 = render.submit/complete 事件投影（不重算，与积分同纪律）。
 */
import type { EventSink, Window } from "./router.js";
import { currentWindow } from "./router.js";
import { OFF_PEAK_RATE_RATIO } from "@workloom/shared";

/* ================= 异步生成 Provider 抽象 ================= */

export type GenKind = "video" | "image";

export interface GenRequest {
  /** 提示词包（渲染脚本 CMS 内容） */
  prompt: string;
  /** 预计秒数（视频）/张数（图像），额度台账计量基准 */
  estimatedUnits: number;
  /** 业务标识（render_script id 等，回填用） */
  refId?: string;
  /** 其他 vendor 特定参数（透传） */
  params?: Record<string, unknown>;
}

export type GenTaskStatus = "submitted" | "running" | "succeeded" | "failed";

export interface GenProvider {
  readonly providerId: string;
  readonly kind: GenKind;
  healthy(): Promise<boolean>;
  /** 提交生成任务 → task_id（异步任务制第一步） */
  submit(req: GenRequest): Promise<{ taskId: string }>;
  /** 轮询任务状态 → 结果 uri/实际计量（异步任务制第二步；调用方负责节拍） */
  poll(taskId: string): Promise<{ status: GenTaskStatus; uri?: string; actualUnits?: number; error?: string }>;
}

/* ================= Mock 生成 Provider（D4 离线可跑 + 故障注入） ================= */

export class MockGenProvider implements GenProvider {
  private seq = 0;
  constructor(
    public readonly providerId: string,
    public readonly kind: GenKind = "video",
    private readonly opts: { failFirst?: number; down?: boolean } = {},
  ) {}
  async healthy(): Promise<boolean> { return !this.opts.down; }
  async submit(req: GenRequest): Promise<{ taskId: string }> {
    this.seq += 1;
    if (this.opts.failFirst && this.seq <= this.opts.failFirst) {
      throw new Error(`mock 生成故障注入（第 ${this.seq} 次）`);
    }
    return { taskId: `mock-${this.providerId}-${this.seq}` };
  }
  async poll(taskId: string): Promise<{ status: GenTaskStatus; uri?: string; actualUnits?: number }> {
    return { status: "succeeded", uri: `mock://gen/${taskId}.mp4`, actualUnits: 30 };
  }
}

/* ================= Seedance Provider（火山方舟 Ark，任务制异步 API） ================= */

export class SeedanceProvider implements GenProvider {
  readonly providerId = "seedance";
  readonly kind: GenKind = "video";
  constructor(
    private readonly cfg: {
      baseUrl?: string;   // 默认 https://ark.cn-beijing.volces.com/api/v3
      apiKey: string;
      model?: string;     // 默认 seedance-2.0
    },
  ) {}
  private base(): string {
    return (this.cfg.baseUrl ?? "https://ark.cn-beijing.volces.com/api/v3").replace(/\/$/, "");
  }
  async healthy(): Promise<boolean> { return !!this.cfg.apiKey; }
  async submit(req: GenRequest): Promise<{ taskId: string }> {
    const res = await fetch(`${this.base()}/contents/generations/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.apiKey}` },
      body: JSON.stringify({
        model: this.cfg.model ?? "seedance-2.0",
        content: [{ type: "text", text: req.prompt }],
        generate_audio: true,
        ...(req.params ?? {}),
      }),
    });
    if (!res.ok) throw new Error(`Seedance 提交失败：HTTP ${res.status}`);
    const data = (await res.json()) as { id?: string };
    if (!data.id) throw new Error("Seedance 未返回 task_id");
    return { taskId: data.id };
  }
  async poll(taskId: string): Promise<{ status: GenTaskStatus; uri?: string; error?: string }> {
    const res = await fetch(`${this.base()}/contents/generations/tasks/${taskId}`, {
      headers: { authorization: `Bearer ${this.cfg.apiKey}` },
    });
    if (!res.ok) return { status: "failed", error: `Seedance 查询失败：HTTP ${res.status}` };
    const data = (await res.json()) as {
      status?: string;
      content?: { video_url?: string };
      error?: { message?: string };
    };
    if (data.status === "succeeded") return { status: "succeeded", uri: data.content?.video_url };
    if (data.status === "failed") return { status: "failed", error: data.error?.message ?? "生成失败" };
    return { status: "running" };
  }
}

/* ================= Kling Provider（可灵公开 API，任务制异步） ================= */

/**
 * 可灵视频生成（https://app.klingai.com/global/dev/document-api）：
 *   POST /v1/videos/text2video → task_id；GET /v1/videos/text2video/{id} 轮询。
 * 鉴权 Bearer JWT（KLING_API_KEY）；失败语义与 Seedance 一致（降级链接管）。
 */
export class KlingProvider implements GenProvider {
  readonly providerId = "kling";
  readonly kind: GenKind = "video";
  constructor(
    private readonly cfg: {
      baseUrl?: string;   // 默认 https://api.klingai.com
      apiKey: string;
      model?: string;     // 默认 kling-v2
    },
  ) {}
  private base(): string {
    return (this.cfg.baseUrl ?? "https://api.klingai.com").replace(/\/$/, "");
  }
  async healthy(): Promise<boolean> { return !!this.cfg.apiKey; }
  async submit(req: GenRequest): Promise<{ taskId: string }> {
    const res = await fetch(`${this.base()}/v1/videos/text2video`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.apiKey}` },
      body: JSON.stringify({
        model: this.cfg.model ?? "kling-v2",
        prompt: req.prompt,
        duration: String(Math.min(10, Math.max(5, Math.round(req.estimatedUnits)))),
        ...(req.params ?? {}),
      }),
    });
    if (!res.ok) throw new Error(`Kling 提交失败：HTTP ${res.status}`);
    const data = (await res.json()) as { data?: { task_id?: string } };
    const taskId = data.data?.task_id;
    if (!taskId) throw new Error("Kling 未返回 task_id");
    return { taskId };
  }
  async poll(taskId: string): Promise<{ status: GenTaskStatus; uri?: string; error?: string }> {
    const res = await fetch(`${this.base()}/v1/videos/text2video/${taskId}`, {
      headers: { authorization: `Bearer ${this.cfg.apiKey}` },
    });
    if (!res.ok) return { status: "failed", error: `Kling 查询失败：HTTP ${res.status}` };
    const data = (await res.json()) as {
      data?: { task_status?: string; task_result?: { videos?: Array<{ url?: string }> }; task_status_msg?: string };
    };
    const st = data.data?.task_status;
    if (st === "succeed") return { status: "succeeded", uri: data.data?.task_result?.videos?.[0]?.url };
    if (st === "failed") return { status: "failed", error: data.data?.task_status_msg ?? "生成失败" };
    return { status: "running" };
  }
}

/* ================= Jimeng Provider（即梦 · 火山视觉 CV OpenAPI） ================= */

/**
 * 即梦 AI（火山引擎视觉智能 cv.volcengineapi.com，任务制）：
 *   动作 CVSync2AsyncSubmitTask / CVSync2AsyncGetResult（视服务版本而定），
 *   统一经 JimengProvider 封装；env：JIMENG_API_KEY（+ JIMENG_ENDPOINT 可覆盖）。
 */
export class JimengProvider implements GenProvider {
  readonly providerId = "jimeng";
  readonly kind: GenKind = "video";
  constructor(
    private readonly cfg: {
      baseUrl?: string;
      apiKey: string;
      model?: string;     // 默认 jimeng-video-3.0
    },
  ) {}
  private base(): string {
    return (this.cfg.baseUrl ?? "https://visual.volcengineapi.com").replace(/\/$/, "");
  }
  async healthy(): Promise<boolean> { return !!this.cfg.apiKey; }
  async submit(req: GenRequest): Promise<{ taskId: string }> {
    const res = await fetch(`${this.base()}?Action=CVSync2AsyncSubmitTask&Version=2022-08-31`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.apiKey}` },
      body: JSON.stringify({
        req_key: this.cfg.model ?? "jimeng-video-3.0",
        prompt: req.prompt,
        ...(req.params ?? {}),
      }),
    });
    if (!res.ok) throw new Error(`Jimeng 提交失败：HTTP ${res.status}`);
    const data = (await res.json()) as { data?: { task_id?: string }; task_id?: string };
    const taskId = data.data?.task_id ?? data.task_id;
    if (!taskId) throw new Error("Jimeng 未返回 task_id");
    return { taskId };
  }
  async poll(taskId: string): Promise<{ status: GenTaskStatus; uri?: string; error?: string }> {
    const res = await fetch(`${this.base()}?Action=CVSync2AsyncGetResult&Version=2022-08-31`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.apiKey}` },
      body: JSON.stringify({ req_key: this.cfg.model ?? "jimeng-video-3.0", task_id: taskId }),
    });
    if (!res.ok) return { status: "failed", error: `Jimeng 查询失败：HTTP ${res.status}` };
    const data = (await res.json()) as {
      data?: { status?: string; video_url?: string; resp_data?: string; message?: string };
    };
    const st = data.data?.status;
    if (st === "done" || st === "SUCCESS") {
      const uri = data.data?.video_url
        ?? (data.data?.resp_data ? (JSON.parse(data.data.resp_data) as { video_url?: string }).video_url : undefined);
      return { status: "succeeded", uri };
    }
    if (st === "failed" || st === "FAIL") return { status: "failed", error: data.data?.message ?? "生成失败" };
    return { status: "running" };
  }
}

/** 按 env 装配生成池（Seedance 首选；可灵/即梦备援，env 未配置则缺位由降级链跳过） */
export function genPoolFromEnv(opts: { mockOpts?: Record<string, { failFirst?: number; down?: boolean }> } = {}): Map<string, GenProvider> {
  const pool = new Map<string, GenProvider>();
  const arkKey = process.env.VOLCENGINE_ARK_API_KEY;
  if (arkKey) {
    pool.set("seedance", new SeedanceProvider({
      apiKey: arkKey,
      baseUrl: process.env.SEEDANCE_ENDPOINT,
      model: process.env.SEEDANCE_MODEL,
    }));
  } else {
    // 无 key → mock 提交（与 render.submit 既有 mock 口径一致：明确标注不烧真实额度）
    pool.set("seedance", new MockGenProvider("seedance", "video", opts.mockOpts?.["seedance"]));
  }
  // 备援：可灵/即梦真实 Provider（env 配置即接入降级链）
  if (process.env.KLING_API_KEY) {
    pool.set("kling", new KlingProvider({
      apiKey: process.env.KLING_API_KEY,
      baseUrl: process.env.KLING_ENDPOINT,
      model: process.env.KLING_MODEL,
    }));
  }
  if (process.env.JIMENG_API_KEY) {
    pool.set("jimeng", new JimengProvider({
      apiKey: process.env.JIMENG_API_KEY,
      baseUrl: process.env.JIMENG_ENDPOINT,
      model: process.env.JIMENG_MODEL,
    }));
  }
  return pool;
}

/** 生成降级链（首选→备援顺序；env 未配置的供应商池内缺位，链自动跳过） */
export const GEN_CHAIN: readonly string[] = ["seedance", "kling", "jimeng"] as const;

/* ================= 渲染额度台账（套餐秒数配额 × 事件投影用量） ================= */

/** 套餐 → 每月渲染秒数配额（方案 5.3：智享按量实扣 / 标准 100s / 智能 500s） */
export const RENDER_QUOTA_SECONDS: Record<string, number> = {
  lite: 0,        // 智享版：无赠送额度，按量实扣
  standard: 100,  // 标准版：每月含 100 秒
  smart: 500,     // 智能版：每月含 500 秒
};

export interface RenderUsageEvent {
  action: string;
  after?: Record<string, unknown>;
  time?: string;
}

/** 本月渲染用量（秒）：render.submit 事件投影（after.estimated_seconds 合计；不重算） */
export function projectRenderUsage(events: RenderUsageEvent[], now = new Date()): number {
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  let used = 0;
  for (const e of events) {
    if (e.action !== "render.submit") continue;
    if (e.time && new Date(e.time).getTime() < monthStart) continue;
    used += Number(e.after?.estimated_seconds ?? 0);
  }
  return used;
}

export interface BudgetCheck {
  allowed: boolean;
  usedSeconds: number;
  quotaSeconds: number;
  /** 超额度部分（>0 即按量实扣区；智享版全部用量都属此类） */
  overageSeconds: number;
  reason?: string;
}

/** G8 前置预算闸：配额内放行；超额度须显式 allowOverage（按量实扣，事件留痕） */
export function checkRenderBudget(args: {
  plan: string;
  usedSeconds: number;
  requestSeconds: number;
  allowOverage?: boolean;
}): BudgetCheck {
  const quota = RENDER_QUOTA_SECONDS[args.plan] ?? 0;
  const after = args.usedSeconds + args.requestSeconds;
  const overage = Math.max(0, after - quota);
  if (overage > 0 && !args.allowOverage) {
    return {
      allowed: false, usedSeconds: args.usedSeconds, quotaSeconds: quota, overageSeconds: overage,
      reason: `渲染额度不足：本月配额 ${quota}s，已用 ${args.usedSeconds}s，本次 ${args.requestSeconds}s 将超支 ${overage}s——请购买加油包或显式确认按量实扣`,
    };
  }
  return { allowed: true, usedSeconds: args.usedSeconds, quotaSeconds: quota, overageSeconds: overage };
}

/* ================= 生成任务提交（降级链 + 计量留痕） ================= */

export interface GenSubmitResult {
  kind: "submitted" | "unavailable";
  providerId?: string;
  taskId?: string;
  window: Window;
  degraded?: Array<{ from: string; to: string | null; reason: string }>;
}

/**
 * 生成任务提交：降级链（healthy 探针 + 提交失败切换，全程 gen.degraded 事件 L6.1）+
 * 谷时语义（非实时渲染排产谷时，estimatedCredits 按 ×0.2 估算展示）。
 */
export async function routeGenSubmit(
  req: GenRequest,
  chain: string[],
  providers: Map<string, GenProvider>,
  sink: EventSink,
  now = new Date(),
): Promise<GenSubmitResult> {
  const window = currentWindow(now);
  const degraded: Array<{ from: string; to: string | null; reason: string }> = [];
  for (let i = 0; i < chain.length; i++) {
    const pid = chain[i]!;
    const provider = providers.get(pid);
    if (!provider || !(await provider.healthy())) {
      const to = chain[i + 1] ?? null;
      degraded.push({ from: pid, to, reason: "unhealthy" });
      await sink.recordDegradation({ from: pid, to, reason: "unhealthy", action: "gen.submit" });
      continue;
    }
    try {
      const { taskId } = await provider.submit(req);
      await sink.recordModelTrace({
        model_id: `gen:${pid}`, tier: "gen", window,
        credits: Math.max(0.01, req.estimatedUnits * (window === "off-peak" ? OFF_PEAK_RATE_RATIO : 1) * 0.1),
        action: "gen.submit",
      });
      return { kind: "submitted", providerId: pid, taskId, window, degraded };
    } catch (err) {
      const to = chain[i + 1] ?? null;
      const reason = err instanceof Error ? err.message : String(err);
      degraded.push({ from: pid, to, reason });
      await sink.recordDegradation({ from: pid, to, reason, action: "gen.submit" });
    }
  }
  return { kind: "unavailable", window, degraded };
}
