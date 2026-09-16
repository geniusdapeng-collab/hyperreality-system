/**
 * welcomeScripts · 首装欢迎仪式话术配置（基座能力）
 *
 * 结构：S1 简短自我介绍 / S3 官方详细自我介绍 / S4 过渡引出团队 —— 全项目通用；
 *       S2 系统介绍 —— 由已验证的 Bundle UI 投影提供，缺省使用行业无关说明。
 *
 * 同步机制：仪式实现由基座共享；新项目按《欢迎仪式升级方案》§3.2-B-④
 *          在 Bundle 中补充自己的行业话术：
 *          必须基于该项目真实资产（README/配置/代码）撰写，名词数字逐条可溯源。
 */
import { clientChineseText } from "@workloom/ui";

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

/* ---------------- S2 · Bundle 投影 ---------------- */

/** 通用默认版（基座兜底） */
const SYSTEM_DEFAULT: string[] = [
  "这是您的 AI 智能经营系统：日常工作由数字团队持续推进。",
  "小事按规则自动完成；关键决策会带着依据请您拍板。",
  "这里不是演示视频，派活、审批和数据都会真实流转。",
];
const KEYWORDS_DEFAULT = ["全天候在岗", "规则内自动办", "大事您拍板", "过程可追溯"];

export interface BundleWelcomeProjection {
  system: string[];
  keywords: string[];
}

function projectedChineseLines(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((line) => clientChineseText(line, ""))
    .filter((line) => line.length > 0);
}

/** 合并通用仪式文案与 Bundle 行业投影；基座不识别任何具体行业标识。 */
export function mateScriptOf(projection?: BundleWelcomeProjection | null): MateScript {
  const projectedSystem = projectedChineseLines(projection?.system);
  const projectedKeywords = projectedChineseLines(projection?.keywords);
  return {
    intro: INTRO,
    system: projectedSystem.length ? projectedSystem : SYSTEM_DEFAULT,
    keywords: projectedKeywords.length ? projectedKeywords : KEYWORDS_DEFAULT,
    detail: DETAIL,
    bridge: BRIDGE,
  };
}
