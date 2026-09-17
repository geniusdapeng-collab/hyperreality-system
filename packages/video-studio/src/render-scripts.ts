/**
 * render-scripts.ts —— 渲染脚本生成与版本化（融合设计 §6 的引擎侧）
 *
 * 预生产产物（镜头提示词包）→ 逐镜渲染脚本（Markdown），交给 asset-cms 落库做
 * 版本管理/工作台展示/本地编辑，再由 render-operator 按 G8 围栏提交 Seedance。
 *
 * 规范字面值（25/30 字段、2470-3000 字符口径）一律从 vendor config 读取，
 * 本文件不复制任何规范常量。
 */

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface RenderScriptShot {
  shotId: string;
  sceneType: string;
  durationSec: number;
  /** 逐镜完整提示词（组装后） */
  promptText: string;
  /** 结构化字段（25/30 字段原样保留） */
  fields: Record<string, string>;
  /** 定妆照/商品锚点绑定（heroImageId 等） */
  bindings?: Record<string, string>;
}

export interface RenderScript {
  projectId: string;
  shotId: string;
  version: number;
  markdown: string;
  charCount: number;
  withinSpec: boolean;
}

interface PromptLengthSpec {
  HARD_MAX?: number;
  hardMax?: number;
  IDEAL_MIN?: number;
  idealMin?: number;
  IDEAL_MAX?: number;
  idealMax?: number;
  [key: string]: unknown;
}

/** 从 vendor 读取 Prompt 长度口径（唯一真源：config/prompt-length.js） */
export function loadPromptLengthSpec(): { hardMax: number; idealMin: number; idealMax: number } {
  const require = createRequire(import.meta.url);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const spec = require(path.resolve(
    here,
    "../../../vendor/supermickey/hyperreality-system/config/prompt-length.js"
  )) as PromptLengthSpec;
  // vendor 导出键名以实际文件为准，这里做宽容映射
  const nums = Object.values(spec).filter((v): v is number => typeof v === "number");
  const hardMax = spec.HARD_MAX ?? spec.hardMax ?? Math.max(...nums, 3000);
  const idealMin = spec.IDEAL_MIN ?? spec.idealMin ?? 2470;
  const idealMax = spec.IDEAL_MAX ?? spec.idealMax ?? hardMax;
  return { hardMax, idealMin, idealMax };
}

/** 把单个镜头的提示词包渲染成 MD 脚本正文 */
export function buildRenderScriptMarkdown(shot: RenderScriptShot): string {
  const lines: string[] = [
    `# 渲染脚本 · ${shot.shotId}`,
    "",
    `- 场景类型: ${shot.sceneType}`,
    `- 时长: ${shot.durationSec}s`,
    ""
  ];
  if (shot.bindings && Object.keys(shot.bindings).length > 0) {
    lines.push("## 资产绑定", "");
    for (const [k, v] of Object.entries(shot.bindings)) lines.push(`- ${k}: ${v}`);
    lines.push("");
  }
  lines.push("## 镜头提示词", "");
  // 序号+独立行排版（vendor 交付排版纪律）
  const entries = Object.entries(shot.fields);
  if (entries.length > 0) {
    entries.forEach(([k, v], i) => {
      lines.push(`${String(i + 1).padStart(2, "0")}.【${k}】${v}`);
    });
  } else {
    lines.push(shot.promptText);
  }
  lines.push("");
  return lines.join("\n");
}

/** 生成渲染脚本（含口径校验快照） */
export function buildRenderScript(
  projectId: string,
  shot: RenderScriptShot,
  version: number
): RenderScript {
  const markdown = buildRenderScriptMarkdown(shot);
  const spec = loadPromptLengthSpec();
  const charCount = shot.promptText.length;
  return {
    projectId,
    shotId: shot.shotId,
    version,
    markdown,
    charCount,
    withinSpec: charCount <= spec.hardMax
  };
}
