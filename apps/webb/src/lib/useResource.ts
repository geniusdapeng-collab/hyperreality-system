import { useCallback, useEffect, useRef, useState } from "react";

export type ResourceState<T> =
  | { status: "loading"; data?: T }
  | { status: "ready"; data: T }
  | { status: "error"; data?: T; message: string; kind: "error" | "forbidden" | "unauthorized" };

export function safeErrorKind(error: unknown): "error" | "forbidden" | "unauthorized" {
  if (!(error instanceof Error)) return "error";
  if (/unauthorized|未认证|401/i.test(error.message)) return "unauthorized";
  if (/forbidden|无权|403/i.test(error.message)) return "forbidden";
  return "error";
}

export function safeMessage(error: unknown): string {
  if (!(error instanceof Error)) return "服务暂时不可用，请稍后重试。";
  if (/unauthorized|未认证|401/i.test(error.message)) return "登录已失效，请重新登录。";
  if (/forbidden|无权|403/i.test(error.message)) return "当前角色没有执行此操作的权限。";
  return "服务暂时不可用，数据未被当作空结果处理。";
}

export function useResource<T>(loader: () => Promise<T>) {
  const [state, setState] = useState<ResourceState<T>>({ status: "loading" });
  const requestSequence = useRef(0);
  const load = useCallback(async () => {
    const requestId = ++requestSequence.current;
    setState((current) => ({ status: "loading", ...("data" in current ? { data: current.data } : {}) }));
    try {
      const data = await loader();
      if (requestId === requestSequence.current) setState({ status: "ready", data });
    }
    catch (error) {
      if (requestId !== requestSequence.current) return;
      const kind = safeErrorKind(error);
      setState((current) => ({ status: "error", ...(kind === "error" && "data" in current ? { data: current.data } : {}), message: safeMessage(error), kind }));
    }
  }, [loader]);
  useEffect(() => {
    void load();
    return () => { requestSequence.current += 1; };
  }, [load]);
  return { state, reload: load };
}
