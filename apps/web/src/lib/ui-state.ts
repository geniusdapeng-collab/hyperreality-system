export type UiFailureKind = "unauthorized" | "forbidden" | "offline" | "conflict" | "rate-limit" | "server";

export interface UiFailure {
  kind: UiFailureKind;
  message: string;
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const record = error as Record<string, unknown>;
  const data = record.data && typeof record.data === "object" ? record.data as Record<string, unknown> : undefined;
  return String(data?.code ?? record.code ?? "").toUpperCase();
}

function rawMessage(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

/**
 * 将传输层错误收敛为面向人的中文结果。
 *
 * 客户端不得释放服务端堆栈、数据库字段、英文错误码或底层消息；详细信息只进受控诊断日志。
 */
export function toUiFailure(error: unknown): UiFailure {
  const code = errorCode(error);
  const message = rawMessage(error);
  if (code === "UNAUTHORIZED" || /unauthorized|未认证|登录.*失效|401/i.test(message)) {
    return { kind: "unauthorized", message: "登录已失效，请重新登录后再试。" };
  }
  if (code === "FORBIDDEN" || /forbidden|无权|没有.*权限|403/i.test(message)) {
    return { kind: "forbidden", message: "当前角色没有执行此操作的权限。" };
  }
  if (code === "CONFLICT" || /conflict|已被.*修改|409/i.test(message)) {
    return { kind: "conflict", message: "数据已被其他操作更新，请刷新后重新确认。" };
  }
  if (code === "TOO_MANY_REQUESTS" || /too many|rate.?limit|429/i.test(message)) {
    return { kind: "rate-limit", message: "操作过于频繁，请稍后再试。" };
  }
  if (/network|failed to fetch|fetch failed|offline|timeout|timed out|断网|超时/i.test(message)) {
    return { kind: "offline", message: "网络连接异常，本次操作尚未确认成功，请检查网络后重试。" };
  }
  return { kind: "server", message: "服务暂时不可用，本次操作尚未确认成功，请稍后重试。" };
}

export function operationFailure(error: unknown, operation: string): string {
  const failure = toUiFailure(error);
  if (failure.kind === "forbidden" || failure.kind === "unauthorized") return failure.message;
  return `${operation}未完成。${failure.message}`;
}
