/**
 * verify-chain 结构化摘要解析（scripts/chain-summary.ts）
 *
 * R2-F4 / M6-F2：`release-gate` 的 T-03 需要从 `pnpm db:verify-chain` 的 stdout 里
 * 提取「结构化验证报告（JSON）」。旧口径取标记之后的全部文本再 `JSON.parse`，
 * 一旦 pnpm 在子进程失败时追加尾巴（` ELIFECYCLE  Command failed with exit code 1.`），
 * 解析必然失败 → 摘要恒为 null → T-03 只能报「未产出可解析摘要」，
 * 把账本里真实的异常规模（实测 499700 处）整段丢掉。
 *
 * 本模块按「花括号配平」截取 JSON 对象（尊重字符串与转义），JSON 之后的任何尾随
 * 文本不再影响解析；摘要口径（单行 JSON）与完整口径（多行 JSON）共用同一实现。
 * 从 release-gate.ts 抽出的目的：解析器可被断言脚本直接导入，覆盖真实 stdout。
 */

export interface ChainSummary {
  ok: boolean;
  workspaces: number;
  total_events: number;
  total_issues: number;
  issue_kinds?: Array<{ kind: string; count: number }>;
}

/** 从 start（必须是 `{`）起按花括号配平截取一个完整 JSON 对象；未闭合返回 null */
export function sliceBalancedJson(out: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < out.length; i += 1) {
    const ch = out[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return out.slice(start, i + 1);
    }
  }
  return null;
}

/** 解析 verify-chain 的结构化报告（摘要口径为单行 JSON；完整口径为多行 JSON，两者兼容） */
export function parseChainSummary(out: string): ChainSummary | null {
  const marker = out.indexOf("===== 结构化验证报告（JSON） =====");
  if (marker < 0) return null;
  const start = out.indexOf("{", marker);
  if (start < 0) return null;
  const json = sliceBalancedJson(out, start);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as ChainSummary;
    return typeof parsed.total_issues === "number" ? parsed : null;
  } catch {
    return null;
  }
}
