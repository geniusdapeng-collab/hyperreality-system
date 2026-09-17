/**
 * publish-rpa · 抖音适配器（参考实现；选择器为骨架，真实联调按平台 DOM 演进）
 * 文案规格与 platform-profiles 对齐：标题 ≤55 字、话题 ≤5、定时须 ≥2h
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

export const DOUYIN_PROFILE: PlatformProfile = {
  platform: "douyin",
  uploadUrl: "https://creator.douyin.com/creator-micro/content/upload",
  selectors: {
    loginIndicator: "div[data-e2e='avatar']",
    videoInput: "input[type='file'][accept*='video']",
    coverInput: "input[type='file'][accept*='image']",
    captionInput: "div[data-placeholder*='添加作品简介']",
    tagInput: "input[placeholder*='话题']",
    scheduleToggle: "label:has-text('定时发布')",
    scheduleInput: "input[placeholder*='选择时间']",
    publishButton: "button:has-text('发布')",
    successToast: "div:has-text('发布成功')",
  },
  captionSpec: { captionMaxChars: 55, maxTags: 5, scheduleMinAheadMinutes: 120 },
  humanPace: { typeDelayMs: 80, pageWaitMs: 2_000, postUploadWaitMs: 5_000 },
};

export function createDouyinAdapter(): PublishAdapter {
  return {
    profile: DOUYIN_PROFILE,
    loginCheck: (driver: BrowserDriver) =>
      driver.isLoggedIn(DOUYIN_PROFILE.uploadUrl, DOUYIN_PROFILE.selectors.loginIndicator),
    upload: (driver: BrowserDriver, input: UploadInput): Promise<UploadResult> =>
      uploadByProfile(DOUYIN_PROFILE, driver, input),
    receiptProbe: (driver: BrowserDriver, ctx: { taskId: string; upload: UploadResult }): Promise<PublishReceipt> =>
      probeByProfile(DOUYIN_PROFILE, driver, ctx),
  };
}
