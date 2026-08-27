/**
 * publish-rpa · 适配器基座（fusion-design §7）
 *
 * 统一接口：loginCheck → upload(video, cover, caption, tags, schedule) → receiptProbe
 * 隔离纪律：适配器只依赖注入的 BrowserDriver 接口——不 import playwright（依赖未装），
 *          生产两条路径：① desktop 桌面包内嵌 Playwright/Chromium 实现本接口（Mac 桌包首发）；
 *          ② 专用工作站：packages/base/computer-use 的 asPublishRpaDriver(ToolkitDriver) 直接注入。
 * 风控纪律：模拟人工节奏（打字延迟/分页等待）、登录态由用户本人在桌面包完成
 *          （凭据只存本机，credentials 表引用不落明文）。
 */
import type { Platform, PublishReceipt } from "../types.js";

/** 浏览器驱动 seam（Playwright 隔离层；测试注入内存 fake） */
export interface BrowserDriver {
  goto(url: string): Promise<void>;
  /** 登录态检测：打开页面后是否存在登录后指示器（头像/创作中心入口） */
  isLoggedIn(pageUrl: string, loginIndicatorSelector: string): Promise<boolean>;
  uploadFile(selector: string, path: string): Promise<void>;
  /** 拟人输入（delayMs = 逐键延迟，模拟人工节奏） */
  typeText(selector: string, text: string, opts?: { delayMs?: number }): Promise<void>;
  click(selector: string): Promise<void>;
  waitForSelector(selector: string, opts?: { timeoutMs?: number }): Promise<boolean>;
  wait(ms: number): Promise<void>;
}

/** 统一上传入参 */
export interface UploadInput {
  videoPath: string;
  coverPath?: string;
  caption: string;
  tags: string[];
  /** 定时发布（ISO；为空=立即） */
  scheduleAt?: string;
}

export interface UploadResult {
  platformPostId?: string;
  url?: string;
  /** 成功证据（截图/归档 URI；回执位 snapshot_uri 来源） */
  evidenceUri?: string;
}

/** 人工节奏参数（每平台可调；数值为机制默认值） */
export interface HumanPace {
  /** 逐键延迟 ms */
  typeDelayMs: number;
  /** 页面跳转后等待 ms */
  pageWaitMs: number;
  /** 点击发布后等待回执 ms */
  postUploadWaitMs: number;
}

/** 平台文案规格约束（与 platform-profiles 对齐；adapter 上传前强校验） */
export interface CaptionSpec {
  /** 标题/文案最大字数 */
  captionMaxChars: number;
  maxTags: number;
  /** 定时发布最小提前分钟数（0=不支持定时） */
  scheduleMinAheadMinutes: number;
}

/** 平台画像：入口 URL + 表单定位器骨架 + 文案规格 + 人工节奏 */
export interface PlatformProfile {
  platform: Platform;
  /** 上传入口 URL */
  uploadUrl: string;
  selectors: {
    /** 登录后指示器（loginCheck 探针） */
    loginIndicator: string;
    videoInput: string;
    coverInput?: string;
    captionInput: string;
    tagInput?: string;
    scheduleToggle?: string;
    scheduleInput?: string;
    publishButton: string;
    /** 成功回执选择器（toast/跳转后的作品页标识） */
    successToast: string;
  };
  captionSpec: CaptionSpec;
  humanPace: HumanPace;
}

/** 适配器接口（loginCheck → upload → receiptProbe 三段） */
export interface PublishAdapter {
  readonly profile: PlatformProfile;
  loginCheck(driver: BrowserDriver): Promise<boolean>;
  upload(driver: BrowserDriver, input: UploadInput): Promise<UploadResult>;
  receiptProbe(driver: BrowserDriver, ctx: { taskId: string; upload: UploadResult }): Promise<PublishReceipt>;
}

export class AdapterSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdapterSpecError";
  }
}

/** 文案规格校验（纯函数）：上传前强制，超长/超标签/非法定时直接拒 */
export function assertCaptionSpec(profile: PlatformProfile, input: UploadInput): void {
  const spec = profile.captionSpec;
  if (input.caption.length > spec.captionMaxChars) {
    throw new AdapterSpecError(
      `${profile.platform} 文案 ${input.caption.length} 字超上限 ${spec.captionMaxChars}（platform-profiles 对齐）`,
    );
  }
  if (input.tags.length > spec.maxTags) {
    throw new AdapterSpecError(`${profile.platform} 话题数 ${input.tags.length} 超上限 ${spec.maxTags}`);
  }
  if (input.scheduleAt && spec.scheduleMinAheadMinutes > 0) {
    const aheadMs = new Date(input.scheduleAt).getTime() - Date.now();
    if (aheadMs < spec.scheduleMinAheadMinutes * 60_000) {
      throw new AdapterSpecError(
        `${profile.platform} 定时发布须至少提前 ${spec.scheduleMinAheadMinutes} 分钟`,
      );
    }
  }
}

/**
 * 适配器公共骨架：按 profile 走「入口 → 传视频 → 传封面 → 文案 → 话题 → 定时 → 发布 → 回执探测」，
 * 每步间插人工节奏延迟。各平台 adapter 只需提供 profile（选择器骨架），流程复用本函数。
 */
export async function uploadByProfile(
  profile: PlatformProfile,
  driver: BrowserDriver,
  input: UploadInput,
): Promise<UploadResult> {
  assertCaptionSpec(profile, input);
  const sel = profile.selectors;
  const pace = profile.humanPace;
  await driver.goto(profile.uploadUrl);
  await driver.wait(pace.pageWaitMs);
  await driver.uploadFile(sel.videoInput, input.videoPath);
  await driver.wait(pace.pageWaitMs);
  if (input.coverPath && sel.coverInput) {
    await driver.uploadFile(sel.coverInput, input.coverPath);
    await driver.wait(pace.pageWaitMs);
  }
  await driver.typeText(sel.captionInput, input.caption, { delayMs: pace.typeDelayMs });
  if (sel.tagInput) {
    for (const tag of input.tags) {
      await driver.typeText(sel.tagInput, `#${tag}`, { delayMs: pace.typeDelayMs });
    }
  }
  if (input.scheduleAt && sel.scheduleToggle && sel.scheduleInput) {
    await driver.click(sel.scheduleToggle);
    await driver.typeText(sel.scheduleInput, input.scheduleAt, { delayMs: pace.typeDelayMs });
  }
  await driver.click(sel.publishButton);
  await driver.wait(pace.postUploadWaitMs);
  const ok = await driver.waitForSelector(sel.successToast, { timeoutMs: 15_000 });
  if (!ok) throw new Error(`${profile.platform} 发布未检测到成功回执选择器（转人工接管点）`);
  return { evidenceUri: `rpa-evidence://${profile.platform}/${Date.now().toString(36)}` };
}

/** 默认回执探测：上传结果为证据，平台帖子 ID 由成功页二次探测（骨架：演示期置空） */
export async function probeByProfile(
  profile: PlatformProfile,
  _driver: BrowserDriver,
  ctx: { taskId: string; upload: UploadResult },
): Promise<PublishReceipt> {
  return {
    taskId: ctx.taskId,
    platform: profile.platform,
    platformPostId: ctx.upload.platformPostId,
    url: ctx.upload.url,
    evidenceUri: ctx.upload.evidenceUri,
    synced: true,
    verifiedAt: new Date().toISOString(),
  };
}
