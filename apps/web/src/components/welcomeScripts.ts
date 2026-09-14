/**
 * welcomeScripts · 首装欢迎仪式话术配置（基座能力）
 *
 * 结构：S1 简短自我介绍 / S3 官方详细自我介绍 / S4 过渡引出团队 —— 全项目通用；
 *       S2 系统介绍 —— 按 bundle industry 切换（default 兜底）。
 *
 * 同步机制：基座推送到其他项目后零改动可运行（未知行业自动回落 default）；
 *          新项目按《欢迎仪式升级方案》§3.2-B-④ 强约束补充自己的行业话术：
 *          必须基于该项目真实资产（README/配置/代码）撰写，名词数字逐条可溯源。
 */

export interface MateScript {
  /** S1 简短自我介绍（通用） */
  intro: string;
  /** S2 系统介绍（按行业切换，逐行字幕） */
  system: string[];
  /** S2 背景浮现的行业关键词 */
  keywords: string[];
  /** S3 官方详细自我介绍（通用，逐行字幕） */
  detail: string[];
  /** S4 过渡引出团队（通用） */
  bridge: string[];
}

/* ---------------- 通用段（全项目一致） ---------------- */

/** S1 · 简短自我介绍（v1.2 定稿） */
const INTRO =
  "董事长您好，我是织伴，您的 AI 小秘书。经营、团队和进度，我会随时替您盯着。";

/** S3 · 官方详细自我介绍（深入 + 通用，基座默认版） */
const DETAIL: string[] = [
  "您只要告诉我目标，我会找到合适岗位、跟进进度，并把真正需要您拍板的事整理好。",
  "我会记住您的偏好，也守住权限：不替您拍板，不懂就明说。",
];

/** S4 · 过渡引出团队（衔接现有 CEO 带队仪式） */
const BRIDGE: string[] = [
  "接下来，请认识您的 AI 团队。",
];

/* ---------------- S2 · 行业版 ---------------- */

/** 通用默认版（基座兜底） */
const SYSTEM_DEFAULT: string[] = [
  "这是您的 AI 智能经营系统：日常工作由数字团队持续推进。",
  "小事按规则自动完成；关键决策会带着依据请您拍板。",
  "这里不是演示视频，派活、审批和数据都会真实流转。",
];

/**
 * 酒店版（industry=hotel）· 基于 bundles/hotel 真实资产（v2 大白话版）：
 * 7 个 preset 岗位；围栏：涨幅上限/保底熔断/差评必审/大额退款必审/担保异常/新渠道必审
 * （话术铁律：行业黑话一律翻译成大白话，机制说"规矩"，数字保留）。
 */
const SYSTEM_HOTEL: string[] = [
  "这是为酒店准备的 AI 经营团队，房态、房价、评价和流水都有人持续盯守。",
  "常规工作按规则自动推进；异常订单、大额退款和首次改价一定请您确认。",
  "每项操作都有记录，您随时可以追溯。",
];

/**
 * AI 产品经理版（industry=ai-pm）· 基于 bundles/ai-pm 真实资产（v2 大白话版）：
 * 产品总监领队 14 数字员工；14 条基线围栏 + 36 道行业考题（含 16 道 AI 专项）。
 */
const SYSTEM_AIPM: string[] = [
  "这是您的 AI 产品团队：需求、竞品、数据、文档和发布都有专人负责。",
  "每次改动全程留痕，发布前自动检查风险。",
  "团队负责分析和执行；发不发、改不改，由您拍板。",
];

/* ---------------- 关键词（S2 背景浮现） ---------------- */
const KEYWORDS: Record<string, string[]> = {
  default: ["24h 在岗", "规则内自动办", "大事您拍板", "真实流转"],
  hotel: ["房价有人盯", "差评不过夜", "对账不熬夜", "内容常更新"],
  "ai-pm": ["需求不漏", "改动有记录", "上线有人把守", "经验越攒越多"],
};

const INDUSTRY_SYSTEM: Record<string, string[]> = {
  hotel: SYSTEM_HOTEL,
  "ai-pm": SYSTEM_AIPM,
};

/** 按 bundle id 解析话术（未知行业回落 default，保证基座推送任意项目零改动可跑） */
export function mateScriptOf(bundleId: string | null | undefined): MateScript {
  const key = (bundleId ?? "").toLowerCase();
  const hit = Object.keys(INDUSTRY_SYSTEM).find((k) => key.includes(k));
  const industry = hit ?? "default";
  return {
    intro: INTRO,
    system: INDUSTRY_SYSTEM[industry] ?? SYSTEM_DEFAULT,
    keywords: KEYWORDS[industry] ?? KEYWORDS.default!,
    detail: DETAIL,
    bridge: BRIDGE,
  };
}
