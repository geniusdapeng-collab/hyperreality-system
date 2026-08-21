/**
 * llm-adapter.ts —— WorkLoom model-router ↔ SuperMickey LLMEngine 接口适配
 *
 * vendor 侧所有 LLM 调用点都期望 systems/llm-reasoning-engine.js 的接口：
 *   reason(prompt, opts)          → { success, content?, error?, retryable? }
 *   chat(system, user, temp)      → string（失败抛错）
 *   reasonRaw(prompt, opts)       → { success, content? ... }（不强制 JSON 提取）
 *   reasonStructured(prompt, schema, opts) → { success, data?/content? ... }
 * 本适配器用任意 OpenAI 兼容端点（底座 LLM_* 四环境变量）实现同一接口，
 * 不在 TS 层复制 vendor 的模型名等字面值——模型选择交由调用方/配置注入。
 */

export interface LLMReasonOptions {
  model?: string;
  systemPrompt?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  forceJson?: boolean;
  responseFormat?: { type: string };
  thinking?: Record<string, unknown>;
}

export interface LLMReasonResult {
  success: boolean;
  content?: string;
  data?: unknown;
  error?: string;
  retryable?: boolean;
  usage?: { promptTokens?: number; completionTokens?: number };
}

export interface WorkloomLLMEngineConfig {
  /** OpenAI 兼容端点，如 https://api.moonshot.cn/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
  fastModel?: string;
  timeoutMs?: number;
  maxTokens?: number;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

export class WorkloomLLMEngine {
  private readonly cfg: Required<WorkloomLLMEngineConfig>;
  readonly stats = { totalCalls: 0, totalFailures: 0 };

  get model(): string {
    return this.cfg.model;
  }

  get fastModel(): string {
    return this.cfg.fastModel;
  }

  constructor(config: WorkloomLLMEngineConfig) {
    this.cfg = {
      fastModel: config.model,
      timeoutMs: 180_000,
      maxTokens: 8192,
      ...config
    };
  }

  /** 从底座四环境变量构建（LLM_BASE_URL/LLM_API_KEY/LLM_MODEL，LLM_PROVIDER 仅作记录） */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): WorkloomLLMEngine | null {
    const baseUrl = env.LLM_BASE_URL;
    const apiKey = env.LLM_API_KEY;
    const model = env.LLM_MODEL;
    if (!baseUrl || !apiKey || !model) return null;
    return new WorkloomLLMEngine({ baseUrl, apiKey, model });
  }

  private async callChat(prompt: string, opts: LLMReasonOptions): Promise<LLMReasonResult> {
    const body: Record<string, unknown> = {
      model: opts.model ?? this.cfg.model,
      messages: [
        {
          role: "system",
          content:
            opts.systemPrompt ??
            (opts.forceJson
              ? "你是一个严格输出 JSON 的助手。除合法 JSON 外不要输出任何额外文字。"
              : "你是一个可靠的助手。")
        },
        { role: "user", content: prompt }
      ],
      temperature: opts.temperature ?? 1,
      top_p: opts.topP ?? 0.95,
      max_tokens: opts.maxTokens ?? this.cfg.maxTokens
    };
    if (opts.forceJson) body.response_format = { type: "json_object" };
    else if (opts.responseFormat) body.response_format = opts.responseFormat;
    if (opts.thinking && typeof opts.thinking === "object") body.thinking = opts.thinking;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    try {
      const resp = await fetch(`${this.cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.cfg.apiKey}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (!resp.ok) {
        return {
          success: false,
          error: `LLM HTTP ${resp.status}`,
          retryable: resp.status >= 500 || resp.status === 429
        };
      }
      const json = (await resp.json()) as ChatCompletionResponse;
      const content = json.choices?.[0]?.message?.content ?? "";
      if (!content) return { success: false, error: "LLM 返回 content 为空", retryable: true };
      return {
        success: true,
        content,
        usage: {
          promptTokens: json.usage?.prompt_tokens,
          completionTokens: json.usage?.completion_tokens
        }
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg, retryable: true };
    } finally {
      clearTimeout(timer);
    }
  }

  private static extractJson(text: string): unknown {
    const trimmed = text.trim();
    const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidate = fence?.[1] ?? trimmed;
    const start = candidate.search(/[{[]/);
    if (start === -1) throw new Error("响应中未找到 JSON");
    const slice = candidate.slice(start);
    // 从最外层括号尝试整体解析，失败则回退到第一个完整对象
    try {
      return JSON.parse(slice);
    } catch {
      const end = slice.lastIndexOf(slice.startsWith("[") ? "]" : "}");
      if (end > 0) return JSON.parse(slice.slice(0, end + 1));
      throw new Error("JSON 提取失败");
    }
  }

  async reason(prompt: string, options: LLMReasonOptions = {}): Promise<LLMReasonResult> {
    this.stats.totalCalls++;
    const result = await this.callChat(prompt, options);
    if (!result.success) this.stats.totalFailures++;
    if (result.success && options.forceJson && result.content) {
      try {
        result.data = WorkloomLLMEngine.extractJson(result.content);
      } catch (err) {
        this.stats.totalFailures++;
        return {
          success: false,
          error: `JSON 解析失败: ${err instanceof Error ? err.message : String(err)}`,
          retryable: true
        };
      }
    }
    return result;
  }

  async generate(prompt: string, options: LLMReasonOptions = {}): Promise<LLMReasonResult> {
    return this.reason(prompt, options);
  }

  async reasonRaw(prompt: string, options: LLMReasonOptions = {}): Promise<LLMReasonResult> {
    return this.callChat(prompt, { ...options, forceJson: false });
  }

  async chat(systemPrompt: string, userPrompt: string, temperature = 1): Promise<string> {
    const result = await this.reason(userPrompt, { systemPrompt, temperature });
    if (!result.success || !result.content) {
      throw new Error(result.error ?? "LLM chat 调用失败");
    }
    return result.content;
  }

  async reasonStructured(
    prompt: string,
    _schema: unknown,
    options: LLMReasonOptions = {}
  ): Promise<LLMReasonResult> {
    return this.reason(prompt, { ...options, forceJson: true });
  }
}
