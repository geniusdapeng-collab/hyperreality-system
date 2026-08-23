/**
 * service · LLM 调用面（与 trpc/router.ts 的 llmCall() 同范式）
 * LLM_PROVIDER 非 mock 且装配齐备 → 真实模型（model-router providerFromEnv，出站强制脱敏 L6.2）；
 * 默认 mock / 缺配置 → undefined，链路走确定性兜底并在响应里标注 mock:true（D4 离线可跑）。
 */
import { providerFromEnv } from "@workloom/base/model-router";

export type LlmCall = (prompt: string) => Promise<string>;

let cached: LlmCall | null | undefined;

export function llmCall(): LlmCall | undefined {
  if (cached !== undefined) return cached ?? undefined;
  try {
    if ((process.env.LLM_PROVIDER ?? "mock") === "mock") {
      cached = null;
      return undefined;
    }
    const provider = providerFromEnv(process.env.LLM_MODEL ?? "deepseek-chat");
    cached = async (prompt: string) => {
      const res = await provider.chat([{ role: "user", content: prompt }]);
      return res.text;
    };
    return cached;
  } catch {
    cached = null;
    return undefined;
  }
}
