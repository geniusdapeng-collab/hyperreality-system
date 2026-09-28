/**
 * model-router · 模型提供方（D4：OpenAI 兼容网关 + 内置确定性 Mock Provider）
 *  - MockProvider：零 Key 全流程可跑（接力开发保险丝）；可编排失败以实证降级链
 *  - OpenAiCompatibleProvider：deepseek/moonshot/zhipu/openai 可切（.env LLM_*）
 *  - F6.6/L6.2：出站内容必经脱敏网关——所有提供方只由 router.execute 调用（模块外不暴露直连）
 */
import { maskDeep } from "../workdata/pii.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
}

export interface ModelProvider {
  readonly modelId: string;
  /** 健康探针（降级链判定用） */
  healthy(): Promise<boolean>;
  /**
   * GR-04（2026-09-28 压测）：调用必须可超时、可取消——
   * 此前 fetch 既无 AbortSignal 也无超时，实测一次 quest-plan 挂 53 秒
   * （IM 侧更糟：慢模型把 dispatch 挂满 3 分 49 秒），整条请求链被单个模型拖死。
   */
  chat(messages: ChatMessage[], opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<ChatResult>;
}

/** Mock 定价（演示口径：积分=token 千分位取整，旗舰 ×4） */
export function mockCredits(modelId: string, r: ChatResult): number {
  const per1k = modelId.includes("flagship") ? 4 : 1;
  return Math.max(1, Math.ceil((r.promptTokens + r.completionTokens) / 1000) * per1k);
}

/**
 * 确定性 Mock Provider（D4）
 * @param opts.failFirst 前 N 次调用抛错（降级链实证用）
 */
export class MockProvider implements ModelProvider {
  private calls = 0;
  constructor(
    public readonly modelId: string,
    private readonly opts: { failFirst?: number; down?: boolean } = {},
  ) {}
  async healthy(): Promise<boolean> {
    return !this.opts.down;
  }
  async chat(messages: ChatMessage[], opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ChatResult> {
    if (opts.signal?.aborted) throw new Error("模型调用已取消");
    this.calls += 1;
    if (this.opts.failFirst && this.calls <= this.opts.failFirst) {
      throw new Error(`mock 故障注入（第 ${this.calls} 次）`);
    }
    const last = messages[messages.length - 1]?.content ?? "";
    const text = `[mock:${this.modelId}] ${last.slice(0, 40)} → 确定性应答`;
    return { text, promptTokens: last.length, completionTokens: text.length };
  }
}

/** OpenAI 兼容 Provider（F6.6：chat 内部强制出站脱敏，插件不可绕过；apiKey 为空适配免 key 网关/本地代理） */
export class OpenAiCompatibleProvider implements ModelProvider {
  constructor(
    public readonly modelId: string,
    private readonly cfg: { baseUrl: string; apiKey?: string },
  ) {}
  private authHeaders(): Record<string, string> {
    return this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {};
  }
  async healthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.cfg.baseUrl}/models`, {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(5_000),
      });
      // 404 视为健康：部分 OpenAI 兼容网关/stub 不实现 /models（端点可达即放行；
      // 真实调用失败仍走降级事件留痕 L6.1，语义不丢）
      return res.ok || res.status === 404;
    } catch {
      return false;
    }
  }
  async chat(messages: ChatMessage[], opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ChatResult> {
    // L6.2 强制出站脱敏（任何调用路径都过这一层）
    const masked = messages.map((m) => ({ ...m, content: maskDeep(m.content).value }));
    // 场景超时（缺省 120s 兜底，避免"没有超时"这种结构性缺陷）+ 外部取消信号合并
    const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 120_000;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;
    let res: Response;
    try {
      res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.authHeaders() },
        body: JSON.stringify({ model: this.modelId, messages: masked, temperature: 0.2 }),
        signal,
      });
    } catch (err) {
      // 超时/取消要给出可读原因（降级链据此记 model.degraded）
      if (opts.signal?.aborted) throw new Error("模型调用已取消（调用方 abort）");
      if (timeoutSignal.aborted) throw new Error(`模型调用超时（>${Math.round(timeoutMs / 1000)}s）`);
      throw err instanceof Error ? err : new Error(String(err));
    }
    if (!res.ok) throw new Error(`模型调用失败：HTTP ${res.status}`);
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      text: data.choices?.[0]?.message?.content ?? "",
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
    };
  }
}

/** 按 .env 装配默认提供方集（mock | deepseek | moonshot | zhipu | openai；apiKey 可空=免 key 网关） */
export function providerFromEnv(modelId: string): ModelProvider {
  const p = process.env.LLM_PROVIDER ?? "mock";
  if (p === "mock") return new MockProvider(modelId);
  const baseUrl = process.env.LLM_BASE_URL;
  const apiKey = process.env.LLM_API_KEY;
  if (!baseUrl) throw new Error(`LLM_PROVIDER=${p} 但缺少 LLM_BASE_URL`);
  return new OpenAiCompatibleProvider(modelId, { baseUrl, apiKey: apiKey || undefined });
}
