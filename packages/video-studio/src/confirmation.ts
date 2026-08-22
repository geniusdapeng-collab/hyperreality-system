/**
 * confirmation.ts —— 确认门桥：把 vendor 的 7 个人工确认门挂到宿主审批实现
 *
 * vendor/supermickey/scripts/confirmation-waiter.js 已打「hyperreality 融合桥」补丁：
 * 运行期读取 globalThis.__HR_CONFIRMATION_HANDLER__，存在即改走宿主处理器。
 * 本模块提供类型安全的注入/摘除方法。
 */

import type { GateRequest, GateVerdict } from "./gates.js";

export type ConfirmationHandler = (req: GateRequest) => Promise<GateVerdict>;

declare global {
  // eslint-disable-next-line no-var
  var __HR_CONFIRMATION_HANDLER__: ConfirmationHandler | undefined;
}

/** 注入审批处理器（返回摘除函数，便于一个项目运行结束后清理） */
export function installConfirmationHandler(handler: ConfirmationHandler): () => void {
  globalThis.__HR_CONFIRMATION_HANDLER__ = handler;
  return () => {
    if (globalThis.__HR_CONFIRMATION_HANDLER__ === handler) {
      delete globalThis.__HR_CONFIRMATION_HANDLER__;
    }
  };
}

/** 开发/演示用：全部自动批准的处理器（生产环境禁止——确认门是生产纪律） */
export function autoApproveHandler(): ConfirmationHandler {
  return async (req) => ({
    approved: true,
    reason: `auto-approve(${req.type})`,
    suggestions: []
  });
}
