/**
 * 语义标注生成（可移植版）
 *
 * 上游把"读字幕 + 看图写 annotation.json"交给视觉 Agent；这里把它**确定性化**：
 *   ① 元素区域 ground truth 来自 `lineart_tools.py analyze`（连通域 + 确定性聚合 + 阅读序）；
 *   ② 元素 ↔ 字幕事件按幕内顺序一一对应；`narrativeRole` 用上游的四段式受限枚举；
 *   ③ 时序由真实字幕时长派生（元素串行作画、不重叠、结尾留 0.5s 完整画面）；
 *   ④ 生成后过契约校验（画布一致 / 区域在图内 / sequence 连续 / 时长区间 / 可见面积 > 0）。
 *
 * 为什么不让 LLM 猜方位：图像模型不返回 bbox，靠 LLM 猜坐标既不可复现也无法校验；
 * 从像素反推是确定性的、可机检的，人工要微调就改 annotation 后只重渲那一幕。
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { WhiteboardError, readImageSize, runLineartTool } from "./engine.mts";
import type { SrtCue } from "./srt.mts";

export interface Region { x: number; y: number; width: number; height: number }

export interface AnnotationElement {
  id: string; label: string; sequence: number; narrativeRole: string; subtitle: string;
  type: string; region: Region;
  reveal: { direction: "top_to_bottom" | "bottom_to_top" | "left_to_right" | "right_to_left";
            startMs: number; durationMs: number; maskPaddingPx: number; protectedRegions: Region[] };
  handPath: { start: [number, number]; end: [number, number]; easing: "linear" | "easeInOut" | "easeOut" };
}

export interface Annotation {
  sceneId: string; canvas: { width: number; height: number };
  storyBasis: string; sceneDurationMs: number; elements: AnnotationElement[];
}

export const NARRATIVE_ROLES = ["场景铺垫", "关键主体", "动作或变化", "反应或结果"] as const;

function overlapArea(a: Region, b: Region): number {
  const x = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return x * y;
}

/**
 * 区域"可见面积"：region 扣掉全部后续 region 之后的剩余面积（容斥原理精确计算）。
 * 上游渲染器给每个元素算的允许掩码就是 `region − 后续区域`；掩码为空时画不出任何线
 * （上游旧版还会直接崩）。这里把"可见面积为 0"变成可机检的契约。
 */
export function visibleArea(region: Region, laterRegions: Region[]): number {
  const rects = laterRegions.filter((r) => overlapArea(region, r) > 0);
  if (rects.length === 0) return region.width * region.height;
  let area = region.width * region.height;
  const n = rects.length;
  for (let mask = 1; mask < (1 << n); mask += 1) {
    let inter: Region | null = null;
    let bits = 0;
    for (let i = 0; i < n; i += 1) {
      if ((mask & (1 << i)) === 0) continue;
      bits += 1;
      inter = inter ? intersect(inter, rects[i]!) : rects[i]!;
      if (!inter) break;
    }
    if (!inter) continue;
    area += (bits % 2 === 1 ? -1 : 1) * inter.width * inter.height;
  }
  return Math.max(0, area);
}

function intersect(a: Region, b: Region): Region | null {
  const x0 = Math.max(a.x, b.x); const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width); const y1 = Math.min(a.y + a.height, b.y + b.height);
  return x1 <= x0 || y1 <= y0 ? null : { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** 契约校验：返回问题清单（空 = 通过）。不抛异常——调用方要拿清单做返修判断。 */
export function validateAnnotation(ann: Annotation, size: { width: number; height: number }): string[] {
  const problems: string[] = [];
  if (ann.canvas.width !== size.width || ann.canvas.height !== size.height) {
    problems.push(`canvas ${ann.canvas.width}×${ann.canvas.height} 与原图 ${size.width}×${size.height} 不一致`);
  }
  if (!ann.elements.length) problems.push("elements 为空");
  const seqs = ann.elements.map((e) => e.sequence).sort((a, b) => a - b);
  seqs.forEach((s, i) => { if (s !== i + 1) problems.push(`sequence 不连续：期望 ${i + 1}，实际 ${s}`); });
  for (const el of ann.elements) {
    const r = el.region;
    if (r.x + r.width > ann.canvas.width || r.y + r.height > ann.canvas.height) problems.push(`元素 ${el.id} 区域越界`);
    if (el.reveal.durationMs < 800 || el.reveal.durationMs > 6000) problems.push(`元素 ${el.id} durationMs=${el.reveal.durationMs} 超出 [800,6000]`);
  }
  const byStart = [...ann.elements].sort((a, b) => a.reveal.startMs - b.reveal.startMs);
  for (let i = 1; i < byStart.length; i += 1) {
    const prev = byStart[i - 1]!; const cur = byStart[i]!;
    if (cur.reveal.startMs < prev.reveal.startMs + prev.reveal.durationMs) problems.push(`元素 ${cur.id} 与 ${prev.id} 作画区间重叠（应为串行）`);
  }
  const last = byStart[byStart.length - 1]!;
  if (last && ann.sceneDurationMs < last.reveal.startMs + last.reveal.durationMs + 500) {
    problems.push(`sceneDurationMs=${ann.sceneDurationMs} 未给结尾留出 0.5s 完整画面`);
  }
  for (let i = 0; i < ann.elements.length; i += 1) {
    const el = ann.elements[i]!;
    const later = ann.elements.slice(i + 1).map((e) => e.region);
    if (visibleArea(el.region, later) <= 0) problems.push(`元素 ${el.id} 被后续区域完全覆盖（允许掩码为空，画不出内容）`);
    for (let j = i + 1; j < ann.elements.length; j += 1) {
      const other = ann.elements[j]!;
      if (overlapArea(el.region, other.region) > 0
        && !el.reveal.protectedRegions.some((p) => overlapArea(p, other.region) > 0)) {
        problems.push(`元素 ${el.id} 与后续元素 ${other.id} 区域重叠但未用 protectedRegions 保护`);
      }
    }
  }
  return problems;
}

export interface ElementPlanItem { cueIndex: number; subIndex: number; subCount: number; subtitle: string; cueDurationMs: number }

/** 元素计划：一句口播常讲三件事（约每 22 字一笔），整幕上限 maxElements；字幕本身不拆。 */
export function planElements(cues: SrtCue[], maxElements = 8, charsPerElement = 22): ElementPlanItem[] {
  const perCue = cues.map((cue) => Math.max(1, Math.min(3, Math.round(cue.text.replace(/\s/g, "").length / charsPerElement))));
  while (perCue.reduce((a, b) => a + b, 0) > maxElements) {
    let idx = 0;
    for (let i = 1; i < perCue.length; i += 1) {
      if (perCue[i]! > perCue[idx]! || (perCue[i] === perCue[idx] && cues[i]!.text.length > cues[idx]!.text.length)) idx = i;
    }
    if (perCue[idx]! <= 1) break;
    perCue[idx] = perCue[idx]! - 1;
  }
  const plan: ElementPlanItem[] = [];
  cues.forEach((cue, cueIndex) => {
    for (let subIndex = 0; subIndex < perCue[cueIndex]!; subIndex += 1) {
      plan.push({ cueIndex, subIndex, subCount: perCue[cueIndex]!, subtitle: cue.text, cueDurationMs: Math.max(1, cue.durMs) });
    }
  });
  return plan;
}

export interface BuildAnnotationInput {
  sceneNo: number; sceneTitle: string; cues: SrtCue[];
  lineartAbsPath: string; sceneDurationMs: number; env?: NodeJS.ProcessEnv;
}

export interface BuildAnnotationResult { annotation: Annotation; problems: string[] }

export async function buildAnnotation(input: BuildAnnotationInput): Promise<BuildAnnotationResult> {
  const env = input.env ?? process.env;
  const size = readImageSize(input.lineartAbsPath);
  if (!size) throw new WhiteboardError(`线稿不是可解析的 PNG/JPEG：${input.lineartAbsPath}`);
  if (input.cues.length === 0) throw new WhiteboardError(`第 ${input.sceneNo} 幕没有字幕句`);
  const plan = planElements(input.cues, Number(env.WHITEBOARD_MAX_ELEMENTS ?? "8"));
  const res = await runLineartTool<{ canvas: { width: number; height: number }; regions: Region[] }>(
    ["analyze", "--in", input.lineartAbsPath, "-k", String(Math.max(1, plan.length)), "--order", "reading"],
    { env, timeoutMs: 180_000 });
  if (!res.ok) throw new WhiteboardError(`线稿区域分析失败：${res.error}`);

  // 丢掉"被后续区域完全盖住"的区域：那一句口播照常播，只是不为它单独起一笔
  const kept: Region[] = [];
  res.regions.forEach((region, i) => {
    if (visibleArea(region, res.regions.slice(i + 1)) >= 16) kept.push(region);
  });
  const regions = kept.length > 0 ? kept : [res.regions[0]!];
  const annotation = compose({ sceneNo: input.sceneNo, sceneTitle: input.sceneTitle, cues: input.cues,
    plan, regions, canvas: size, sceneDurationMs: input.sceneDurationMs });
  return { annotation, problems: validateAnnotation(annotation, size) };
}

function compose(args: {
  sceneNo: number; sceneTitle: string; cues: SrtCue[]; plan: ElementPlanItem[];
  regions: Region[]; canvas: { width: number; height: number }; sceneDurationMs: number;
}): Annotation {
  const { plan, regions, canvas, sceneDurationMs } = args;
  const n = Math.min(plan.length, regions.length);
  const budgetMs = Math.max(1000, sceneDurationMs - 500);
  const breathMs = 120;
  const usableMs = Math.max(800 * n, budgetMs - breathMs * Math.max(0, n - 1));
  const raw = plan.slice(0, n).map((item) => Math.max(1, item.cueDurationMs / item.subCount));
  const totalRaw = raw.reduce((a, b) => a + b, 0);
  let durations = raw.map((d) => Math.max(800, Math.min(6000, Math.round((d / totalRaw) * usableMs))));
  const sum = durations.reduce((a, b) => a + b, 0);
  if (sum > budgetMs) durations = durations.map((d) => Math.max(800, Math.floor(d * (budgetMs / sum))));
  let overflow = durations.reduce((a, b) => a + b, 0) + breathMs * (n - 1) - budgetMs;
  while (overflow > 0) {
    const idx = durations.indexOf(Math.max(...durations));
    if (durations[idx]! <= 800) break;
    const cut = Math.min(overflow, 50);
    durations[idx] = durations[idx]! - cut;
    overflow -= cut;
  }
  const elements: AnnotationElement[] = [];
  let cursor = 0;
  for (let i = 0; i < n; i += 1) {
    const region = regions[i]!;
    const direction = region.width >= region.height ? "left_to_right" : "top_to_bottom";
    const protectedRegions: Region[] = [];
    for (let j = i + 1; j < n; j += 1) if (overlapArea(region, regions[j]!) > 0) protectedRegions.push(regions[j]!);
    const horizontal = direction === "left_to_right";
    const start: [number, number] = horizontal ? [region.x + 6, region.y + Math.round(region.height / 2)]
      : [region.x + Math.round(region.width / 2), region.y + 6];
    const end: [number, number] = horizontal ? [region.x + region.width - 6, region.y + Math.round(region.height / 2)]
      : [region.x + Math.round(region.width / 2), region.y + region.height - 6];
    const subtitle = plan[i]!.subtitle;
    elements.push({
      id: `s${String(args.sceneNo).padStart(2, "0")}-e${i + 1}`,
      label: `${i + 1}. ${subtitle.replace(/[\s。！？!?；;，,、：:]/g, "").slice(0, 18) || "画面元素"}`,
      sequence: i + 1,
      narrativeRole: NARRATIVE_ROLES[Math.min(i, NARRATIVE_ROLES.length - 1)]!,
      subtitle: subtitle.slice(0, 200),
      type: i === 0 ? "structure" : "object",
      region,
      reveal: { direction, startMs: cursor, durationMs: durations[i]!, maskPaddingPx: 22, protectedRegions },
      handPath: { start, end, easing: "easeInOut" },
    });
    cursor += durations[i]! + (i === n - 1 ? 0 : breathMs);
  }
  return {
    sceneId: `scene-${String(args.sceneNo).padStart(2, "0")}`,
    canvas,
    storyBasis: `${args.sceneTitle}：${args.cues.slice(0, n).map((c) => c.text).join(" ")}`.slice(0, 480),
    sceneDurationMs: Math.max(sceneDurationMs, cursor + 500),
    elements,
  };
}

export function writeAnnotation(jobDir: string, sceneNo: number, annotation: Annotation): string {
  const path = join(jobDir, `scene-${String(sceneNo).padStart(2, "0")}.annotation.json`);
  writeFileSync(path, `${JSON.stringify(annotation, null, 2)}\n`, "utf8");
  return path;
}
