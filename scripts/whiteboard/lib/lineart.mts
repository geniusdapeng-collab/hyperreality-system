/**
 * 逐幕线稿（可移植版）
 *
 * 三条来源：
 *   A. `seedream`：方舟文生图（HTTP 直连，**不依赖任何仓内图像接缝**）；出图后过风格机检三道，
 *      不过则把失败读数写回提示词重出（不是换 seed 重采样碰运气）。
 *   B. `sketch`：实拍图 → cv2 素描化（零模型成本；老素材直接变白板片）。
 *   C. `upload`：直接采用现成线稿（人工画的/设计师给的）。
 *
 * 视觉规范（上游 SKILL.md「统一出图视觉规范」逐条固化）：纸底 #F5EBD7、深灰素描线条、
 * 禁止画面文字/写实/3D、主体不重叠、充足留白。风格漂移会直接毁掉系列一致性，故写死在代码里。
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { WhiteboardError, kitEnv, readImageSize, runLineartTool } from "./engine.mts";

export const STYLE_PROMPT = [
  "极简手绘线稿插画，纯素描草图风格，类似 Notion 的克制涂鸦美学。",
  "暖米黄色旧纸张背景（#F5EBD7），深灰色素描线条（#3A3E46），干净背景、大量留白。",
  "对象以简洁轮廓与少量线条表达，强调关系、变化与核心概念，不追求写实比例与细节。",
  "红、橙、蓝仅允许极少量概念性点缀。",
  "禁止：画面中的任何文字、词语、字母、数字、标签；写实感、摄影细节、3D 效果、绘画质感；",
  "复杂场景、密集背景、繁复装饰、高饱和度配色。",
  "画面主体之间必须互不重叠、彼此留出清晰空隙，便于后续分区绘制。",
].join("");

export interface LineartCheck {
  ok: boolean;
  checks: Array<{ id: string; pass: boolean; detail: string }>;
  metrics: Record<string, unknown>;
}

export interface LineartResult {
  absPath: string; source: "seedream" | "sketch" | "upload";
  prompt: string | null; check: LineartCheck; attempts: number;
}

export function buildPrompt(coreIdea: string, elements: string[]): string {
  const items = elements.map((e) => e.trim()).filter(Boolean);
  return [STYLE_PROMPT, `画面内容：${coreIdea.trim()}。`,
    items.length > 0 ? `必须出现的元素：${items.join("、")}。` : "",
    "16:9 横向构图，主体居中偏上，四边保留充足留白。"].filter(Boolean).join("\n");
}

export async function checkLineart(absPath: string, env: NodeJS.ProcessEnv = process.env): Promise<LineartCheck> {
  const res = await runLineartTool<{ checks: LineartCheck["checks"]; metrics: Record<string, unknown> }>(
    ["check", "--in", absPath], { env, allowNonZero: true, timeoutMs: 120_000 });
  if (!res.ok) return { ok: false, checks: [{ id: "tool", pass: false, detail: res.error }], metrics: {} };
  return { ok: true, checks: res.checks, metrics: res.metrics };
}

/** 方舟文生图（同步返回图像 URL；错误分类与全仓供应商口径一致） */
async function arkText2Image(prompt: string, env: NodeJS.ProcessEnv): Promise<Buffer> {
  const cfg = kitEnv(env);
  if (!cfg.vencArkKey) {
    throw new WhiteboardError("Seedream 出图需要 VOLCENGINE_ARK_API_KEY（或 ARK_API_KEY）",
      "要么配置方舟密钥，要么把线稿来源改成 sketch（实拍图素描化，零模型成本）或 upload（现成线稿）");
  }
  const base = (env.SEEDREAM_ENDPOINT?.trim() || "https://ark.cn-beijing.volces.com/api/v3").replace(/\/$/, "");
  const res = await fetch(`${base}/images/generations`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.vencArkKey}` },
    body: JSON.stringify({ model: cfg.lineartModel, prompt, response_format: "url", size: cfg.lineartSize }),
    signal: AbortSignal.timeout(Number(env.WHITEBOARD_LINEART_TIMEOUT_MS ?? 300_000)),
  });
  const text = await res.text();
  if (!res.ok) throw new WhiteboardError(`方舟出图失败：HTTP ${res.status} ${text.slice(0, 300)}`);
  const data = JSON.parse(text) as { data?: Array<{ url?: string }> };
  const url = data?.data?.[0]?.url;
  if (!url) throw new WhiteboardError(`方舟未返回图像 URL：${text.slice(0, 200)}`);
  const img = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!img.ok) throw new WhiteboardError(`线稿下载失败：HTTP ${img.status}`);
  return Buffer.from(await img.arrayBuffer());
}

export interface LineartOptions {
  sceneNo: number; jobDir: string; coreIdea: string; elements: string[];
  mode: "seedream" | "sketch" | "upload"; sourcePath?: string; env?: NodeJS.ProcessEnv;
}

/** 逐幕线稿（对外唯一入口） */
export async function buildLineart(input: LineartOptions): Promise<LineartResult> {
  const env = input.env ?? process.env;
  const name = `scene-${String(input.sceneNo).padStart(2, "0")}.lineart.png`;
  const outPath = join(input.jobDir, name);

  if (input.mode === "seedream") {
    const maxAttempts = Math.max(1, Number(env.WHITEBOARD_LINEART_RETRY ?? "3"));
    let prompt = buildPrompt(input.coreIdea, input.elements);
    let check: LineartCheck = { ok: false, checks: [], metrics: {} };
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const bytes = await arkText2Image(prompt, env);
      writeFileSync(outPath, bytes);
      check = await checkLineart(outPath, env);
      if (check.ok) return { absPath: outPath, source: "seedream", prompt, check, attempts: attempt };
      const failed = check.checks.filter((c) => !c.pass).map((c) => c.detail).join("；");
      prompt = [buildPrompt(input.coreIdea, input.elements),
        `【上一版被机检打回，本轮必须修复】${failed}`,
        "特别注意：背景必须是干净的暖米黄旧纸色，不要出现大面积深色块；画面不要杂乱，主体控制在 2–8 个。"].join("\n");
    }
    return { absPath: outPath, source: "seedream", prompt, check, attempts: maxAttempts };
  }

  if (!input.sourcePath) {
    throw new WhiteboardError(`线稿来源 ${input.mode} 需要一张输入图（--source <图片路径>）`);
  }
  if (input.mode === "upload") {
    const { readFileSync } = await import("node:fs");
    writeFileSync(outPath, readFileSync(input.sourcePath));
  } else {
    const res = await runLineartTool<{ output: string }>(
      ["sketch", "--in", input.sourcePath, "--out", outPath], { env, timeoutMs: 300_000 });
    if (!res.ok) throw new WhiteboardError(`素描化失败：${res.error}`);
  }
  if (!readImageSize(outPath)) throw new WhiteboardError(`线稿不是可解析的 PNG/JPEG：${outPath}`);
  const check = await checkLineart(outPath, env);
  return { absPath: outPath, source: input.mode, prompt: null, check, attempts: 1 };
}
