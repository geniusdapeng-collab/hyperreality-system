/**
 * publish-rpa · B站适配器（参考实现；选择器为骨架，真实联调按平台 DOM 演进）
 * 文案规格与 platform-profiles 对齐：标题 ≤80 字、话题（标签）≤10、定时须 ≥2h
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

export const BILIBILI_PROFILE: PlatformProfile = {
  platform: "bilibili",
  uploadUrl: "https://member.bilibili.com/platform/upload/video/frame",
  selectors: {
    loginIndicator: "div.header-avatar",
    videoInput: "input[type='file'][accept*='video']",
    coverInput: "input[type='file'][accept*='image']",
    captionInput: "input[placeholder*='标题']",
    tagInput: "input[placeholder*='标签']",
    scheduleToggle: "label:has-text('定时发布')",
    scheduleInput: "input[placeholder*='选择日期']",
    publishButton: "button:has-text('立即投稿')",
    successToast: "div:has-text('投稿成功')",
  },
  captionSpec: { captionMaxChars: 80, maxTags: 10, scheduleMinAheadMinutes: 120 },
  humanPace: { typeDelayMs: 70, pageWaitMs: 2_000, postUploadWaitMs: 5_000 },
};

export function createBilibiliAdapter(): PublishAdapter {
  return {
    profile: BILIBILI_PROFILE,
    loginCheck: (driver: BrowserDriver) =>
      driver.isLoggedIn(BILIBILI_PROFILE.uploadUrl, BILIBILI_PROFILE.selectors.loginIndicator),
    upload: (driver: BrowserDriver, input: UploadInput): Promise<UploadResult> =>
      uploadByProfile(BILIBILI_PROFILE, driver, input),
    receiptProbe: (driver: BrowserDriver, ctx: { taskId: string; upload: UploadResult }): Promise<PublishReceipt> =>
      probeByProfile(BILIBILI_PROFILE, driver, ctx),
  };
}
