/**
 * publish-rpa · TikTok 适配器（接口占位）
 * ⚠ 需真实账号环境联调：TikTok 海外环境/风控指纹与大陆站点差异大，
 *   选择器与登录态探测须在桌包包真实账号会话中联调标定（fusion-design §7 预留位）。
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

export const TIKTOK_PROFILE: PlatformProfile = {
  platform: "tiktok",
  uploadUrl: "https://www.tiktok.com/creator-center/upload",
  selectors: {
    // 占位选择器：需真实账号环境联调标定
    loginIndicator: "[data-e2e='profile-icon']",
    videoInput: "input[type='file'][accept*='video']",
    captionInput: "div[contenteditable='true']",
    publishButton: "button:has-text('Post')",
    successToast: "div:has-text('Posted')",
  },
  captionSpec: { captionMaxChars: 150, maxTags: 8, scheduleMinAheadMinutes: 15 },
  humanPace: { typeDelayMs: 90, pageWaitMs: 3_000, postUploadWaitMs: 8_000 },
};

export function createTiktokAdapter(): PublishAdapter {
  return {
    profile: TIKTOK_PROFILE,
    loginCheck: () => Promise.resolve(false), // 未联调恒未登录 → 转人工
    upload: (_driver: BrowserDriver, _input: UploadInput): Promise<UploadResult> =>
      Promise.reject(new Error("TikTok 适配器为接口占位：需真实账号环境联调（fusion-design §7），联调前禁止自动执行")),
    receiptProbe: (_driver: BrowserDriver, ctx: { taskId: string; upload: UploadResult }): Promise<PublishReceipt> =>
      Promise.resolve({ taskId: ctx.taskId, platform: "tiktok", synced: false }),
  };
}
