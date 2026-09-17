/**
 * publish-rpa · 小红书适配器（参考实现；选择器为骨架，真实联调按平台 DOM 演进）
 * 文案规格与 platform-profiles 对齐：标题 ≤20 字、话题 ≤10、不支持定时（scheduleMinAheadMinutes=0 时忽略）
 */
import {
  probeByProfile,
  uploadByProfile,
  type BrowserDriver,
  type PlatformProfile,
  type PublishAdapter,
  type UploadInput,
  type UploadResult,
} from "./base.js";
import type { PublishReceipt } from "../types.js";

export const XIAOHONGSHU_PROFILE: PlatformProfile = {
  platform: "xiaohongshu",
  uploadUrl: "https://creator.xiaohongshu.com/publish/publish",
  selectors: {
    loginIndicator: "div.user .avatar",
    videoInput: "input[type='file'][accept*='video']",
    coverInput: "input[type='file'][accept*='image']",
    captionInput: "div[contenteditable='true'][data-placeholder*='标题']",
    tagInput: "input[placeholder*='话题']",
    publishButton: "button:has-text('发布')",
    successToast: "div:has-text('发布成功')",
  },
  captionSpec: { captionMaxChars: 20, maxTags: 10, scheduleMinAheadMinutes: 0 },
  humanPace: { typeDelayMs: 100, pageWaitMs: 2_500, postUploadWaitMs: 6_000 },
};

export function createXiaohongshuAdapter(): PublishAdapter {
  return {
    profile: XIAOHONGSHU_PROFILE,
    loginCheck: (driver: BrowserDriver) =>
      driver.isLoggedIn(XIAOHONGSHU_PROFILE.uploadUrl, XIAOHONGSHU_PROFILE.selectors.loginIndicator),
    upload: (driver: BrowserDriver, input: UploadInput): Promise<UploadResult> =>
      uploadByProfile(XIAOHONGSHU_PROFILE, driver, input),
    receiptProbe: (driver: BrowserDriver, ctx: { taskId: string; upload: UploadResult }): Promise<PublishReceipt> =>
      probeByProfile(XIAOHONGSHU_PROFILE, driver, ctx),
  };
}
