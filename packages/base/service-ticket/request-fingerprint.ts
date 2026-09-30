import { createHash } from "node:crypto";

/**
 * 建单请求的不可变摘要。conversationId 只是会话关联，不参与幂等身份：同一请求重试时
 * 对话服务可能重新建立会话。可选字段按调用方提交值计算，避免默认 SLA 调整后误判重放。
 */
export function ticketRequestFingerprint(input: {
  kind: string;
  title: string;
  payload?: Record<string, unknown>;
  priority?: string;
  slaHours?: number;
}): string {
  const request = JSON.parse(JSON.stringify({
    kind: input.kind,
    title: input.title,
    payload: input.payload ?? {},
    priority: input.priority ?? null,
    slaHours: input.slaHours ?? null,
  })) as unknown;

  // JSONB 对对象属性顺序不敏感；请求摘要也应如此。先 JSON 往返以匹配落库序列化语义。
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value !== null && typeof value === "object") {
      const object = value as Record<string, unknown>;
      return Object.fromEntries(Object.keys(object).sort().map((key) => [key, canonicalize(object[key])]));
    }
    return value;
  };

  return createHash("sha256")
    .update("ticket-create:v1\0")
    .update(JSON.stringify(canonicalize(request)))
    .digest("hex");
}
