/** 首屏并行预取：session + orders + member 并行发起，「我的」页秒开 */
import { api, ensureSession } from "./api";
import { getConfig } from "./config";
import type { BusinessRecord, MemberInfo } from "./types";

export interface PrefetchResult {
  member: MemberInfo | null;
  orders: BusinessRecord[] | null;
  /** 会话是否建立成功（false → 各页面显示连接错误，禁止伪造演示业务数据） */
  sessionOk: boolean;
}

let promise: Promise<PrefetchResult> | null = null;

export function startPrefetch(): Promise<PrefetchResult> {
  if (promise) return promise;
  promise = (async () => {
    const s = await ensureSession();
    if (!s) return { member: null, orders: null, sessionOk: false };
    const profile = getConfig().profile;
    const [m, o] = await Promise.allSettled([
      profile.membership ? api.member() : Promise.resolve(null),
      profile.orders ? api.orders() : Promise.resolve(null),
    ]);
    return {
      member: m.status === "fulfilled" ? m.value : null,
      orders: o.status === "fulfilled" ? o.value?.orders ?? [] : null,
      sessionOk: true,
    };
  })();
  return promise;
}

/** 网络恢复后允许重新预取 */
export function resetPrefetch(): void {
  promise = null;
}
