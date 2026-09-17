/**
 * service-kb · Markdown 语义切块 + 内容指纹（纯函数，可单测）
 *
 * 切块纪律：
 *  - 按 Markdown 标题层级切分章节，块内保留「标题路径」（如「前台政策 / 退房时间」）供引用回溯；
 *  - 超长章节按段落语义二次切分（不截断段落，块 ≤ MAX_CHUNK_CHARS 软上限）；
 *  - 过短尾块并入前块（避免噪声碎块）。
 */
import { createHash } from "node:crypto";

/** 单块软上限（字符）；超过则按段落边界二次切分 */
export const MAX_CHUNK_CHARS = 600;
/** 小于该长度的尾块并入前块 */
export const MIN_CHUNK_CHARS = 60;

export interface KbChunkDraft {
  chunkIndex: number;
  /** 标题路径（「 / 」连接，根级为空串） */
  heading: string;
  content: string;
}

/** 内容指纹（sha256 hex）：upsertDocument 幂等键 + kb_sources 变化检测 */
export function hashContent(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

interface Section {
  headingPath: string[];
  paragraphs: string[];
}

/** 把 Markdown 解析为「标题路径 → 段落」章节序列（纯函数） */
export function parseSections(md: string): Section[] {
  const sections: Section[] = [];
  let stack: Array<{ level: number; title: string }> = [];
  let current: Section = { headingPath: [], paragraphs: [] };
  let buf: string[] = [];

  const flushPara = () => {
    const para = buf.join("\n").trim();
    buf = [];
    if (para) current.paragraphs.push(para);
  };
  const flushSection = () => {
    flushPara();
    if (current.paragraphs.length > 0) sections.push(current);
    current = { headingPath: stack.map((s) => s.title), paragraphs: [] };
  };

  for (const line of md.split(/\r?\n/)) {
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (m) {
      flushSection();
      const level = m[1]!.length;
      const title = m[2]!;
      stack = stack.filter((s) => s.level < level);
      stack.push({ level, title });
      current = { headingPath: stack.map((s) => s.title), paragraphs: [] };
    } else if (line.trim() === "") {
      flushPara();
    } else {
      buf.push(line);
    }
  }
  flushSection();
  return sections;
}

/** 章节 → 切块（段落语义边界 + 标题路径保留） */
export function chunkMarkdown(md: string): KbChunkDraft[] {
  const chunks: KbChunkDraft[] = [];
  for (const section of parseSections(md)) {
    const heading = section.headingPath.join(" / ");
    let buf = "";
    const flush = () => {
      const content = buf.trim();
      buf = "";
      if (!content) return;
      // 尾块过短并入前块（同标题路径时）
      const prev = chunks[chunks.length - 1];
      if (content.length < MIN_CHUNK_CHARS && prev && prev.heading === heading) {
        prev.content = `${prev.content}\n\n${content}`;
        return;
      }
      chunks.push({ chunkIndex: chunks.length, heading, content });
    };
    for (const para of section.paragraphs) {
      if (buf && buf.length + para.length + 2 > MAX_CHUNK_CHARS) flush();
      // 单段落自身超限：硬切（保块不丢内容）
      if (para.length > MAX_CHUNK_CHARS && !buf) {
        for (let i = 0; i < para.length; i += MAX_CHUNK_CHARS) {
          chunks.push({
            chunkIndex: chunks.length,
            heading,
            content: para.slice(i, i + MAX_CHUNK_CHARS),
          });
        }
        continue;
      }
      buf = buf ? `${buf}\n\n${para}` : para;
    }
    flush();
  }
  return chunks;
}
