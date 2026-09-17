/**
 * publish-rpa · YouTube 适配器（参考实现；选择器为骨架，真实联调按平台 DOM 演进）
 * 文案规格与 platform-profiles 对齐：标题 ≤100 字、话题（标签）≤15、定时须 ≥15min
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

export const YOUTUBE_PROFILE: PlatformProfile = {
  platform: "youtube",
  uploadUrl: "https://studio.youtube.com",
  selectors: {
    loginIndicator: "button#avatar-btn",
    videoInput: "input[type='file'][accept*='video']",
    captionInput: "div#title-textarea div[contenteditable='true']",
    tagInput: "input[placeholder*='标签']",
    scheduleToggle: "ytcp-radio-button[name='SCHEDULE']",
    scheduleInput: "input[aria-label*='日期']",
    publishButton: "button#done-button",
    successToast: "ytcp-snackbar:has-text('已发布')",
  },
  captionSpec: { captionMaxChars: 100, maxTags: 15, scheduleMinAheadMinutes: 15 },
  humanPace: { typeDelayMs: 60, pageWaitMs: 3_000, postUploadWaitMs: 8_000 },
};

export function createYoutubeAdapter(): PublishAdapter {
  return {
    profile: YOUTUBE_PROFILE,
    loginCheck: (driver: BrowserDriver) =>
      driver.isLoggedIn(YOUTUBE_PROFILE.uploadUrl, YOUTUBE_PROFILE.selectors.loginIndicator),
    upload: (driver: BrowserDriver, input: UploadInput): Promise<UploadResult> =>
      uploadByProfile(YOUTUBE_PROFILE, driver, input),
    receiptProbe: (driver: BrowserDriver, ctx: { taskId: string; upload: UploadResult }): Promise<PublishReceipt> =>
      probeByProfile(YOUTUBE_PROFILE, driver, ctx),
  };
}
