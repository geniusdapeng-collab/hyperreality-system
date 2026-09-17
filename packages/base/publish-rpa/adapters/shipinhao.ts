/**
 * publish-rpa · 视频号适配器（接口占位）
 * ⚠ 需真实账号环境联调：视频号助手（channels.weixin.qq.com）强依赖微信扫码会话，
 *   登录态与上传表单须在桌包包真实账号环境中联调标定（fusion-design §7 预留位）。
 *   联调完成前 upload 一律抛错 → runner 转人工，不静默执行。
 */
import {
  type BrowserDriver,
  type PlatformProfile,
  type PublishAdapter,
  type UploadInput,
  type UploadResult,
} from "./base.js";
import type { PublishReceipt } from "../types.js";

export const SHIPINHAO_PROFILE: PlatformProfile = {
  platform: "shipinhao",
  uploadUrl: "https://channels.weixin.qq.com/platform/post/create",
  selectors: {
    // 占位选择器：需真实账号环境联调标定
    loginIndicator: "div.avatar",
    videoInput: "input[type='file'][accept*='video']",
    captionInput: "div[contenteditable='true'][data-placeholder*='描述']",
    publishButton: "button:has-text('发表')",
    successToast: "div:has-text('发表成功')",
  },
  captionSpec: { captionMaxChars: 1000, maxTags: 5, scheduleMinAheadMinutes: 0 },
  humanPace: { typeDelayMs: 100, pageWaitMs: 3_000, postUploadWaitMs: 8_000 },
};

export function createShipinhaoAdapter(): PublishAdapter {
  return {
    profile: SHIPINHAO_PROFILE,
    loginCheck: () => Promise.resolve(false), // 未联调恒未登录 → 转人工
    upload: (_driver: BrowserDriver, _input: UploadInput): Promise<UploadResult> =>
      Promise.reject(new Error("视频号适配器为接口占位：需真实账号环境联调（fusion-design §7），联调前禁止自动执行")),
    receiptProbe: (_driver: BrowserDriver, ctx: { taskId: string; upload: UploadResult }): Promise<PublishReceipt> =>
      Promise.resolve({ taskId: ctx.taskId, platform: "shipinhao", synced: false }),
  };
}
