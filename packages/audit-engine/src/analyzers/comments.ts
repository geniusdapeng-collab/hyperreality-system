/**
 * 评论与口碑线（fast-scan SKILL.md 步骤 4）
 * 四个子项：
 *  1) 负面评论 >24h 未处理 P1（>72h 升级 P0——舆情发酵区）
 *  2) 高意向咨询（求购/询价/怎么买类）>12h 未回复 P1（>48h 升级 P0——线索已凉）
 *  3) 敏感词风险评论未处置 P0（合规红线，不分时长）
 *  4) 评论区高频问题未沉淀：近 30 天同一问题出现 ≥3 次 P2（应沉淀进选题库）
 */
import type { AuditSnapshot, Finding } from "../types.js";
import { hoursSince, makeFinding, round2, windowStart, type AnalyzerContext } from "./util.js";

/** 负面评论未处理红线（小时），>72h 升级 P0 */
export const NEGATIVE_HOURS_P1 = 24;
export const NEGATIVE_HOURS_P0 = 72;
/** 高意向咨询未回复红线（小时），>48h 升级 P0 */
export const INQUIRY_HOURS_P1 = 12;
export const INQUIRY_HOURS_P0 = 48;
/** 超时高意向咨询的线索折损（按类目基准：12h 后转化率折半 → 每条计 0.5 条线索流失） */
export const INQUIRY_LEAD_LOSS = 0.5;
/** 高频问题口径：近 30 天同问题 ≥3 次 */
export const FAQ_MIN_COUNT = 3;
export const FAQ_WINDOW_DAYS = 30;

/** 内置敏感词库（与客户自带 sensitiveWords 并集） */
export const BUILTIN_SENSITIVE_WORDS = ["投诉", "维权", "骗子", "举报", "假货"];

export function analyzeComments(snapshot: AuditSnapshot, ctx: AnalyzerContext): Finding[] {
  const findings: Finding[] = [];
  const accName = new Map(snapshot.accounts.map((a) => [a.accountId, a.accountName]));
  const sensitiveSet = new Set([...BUILTIN_SENSITIVE_WORDS, ...snapshot.sensitiveWords]);

  /* ---------- 子项 1+2+3：逐条扫描未处理评论 ---------- */
  for (const c of snapshot.comments) {
    if (c.repliedAt !== undefined) continue;
    const hours = hoursSince(ctx.now, c.createdAt);
    const name = accName.get(c.accountId) ?? c.accountId;

    // 敏感词（记录标记或文本命中内置/客户词库）
    const hitWords = [...sensitiveSet].filter((w) => c.text.includes(w));
    if (c.hasSensitiveWord || hitWords.length > 0) {
      findings.push(
        makeFinding({
          line: "comments",
          severity: "P0",
          accountId: c.accountId,
          title: `${name} 敏感词风险评论未处置（${Math.floor(hours)}h）：「${c.text.slice(0, 24)}…」`,
          description: `评论命中敏感词（${c.hasSensitiveWord ? "平台标记" : ""}${hitWords.length > 0 ? `词库:${hitWords.join("/")}` : ""}），存在舆情与合规风险，audit-only 纪律下只告警不自动外发。`,
          suggestion: "立即人工核查取证；按 G10c/G10d 纪律处置（需介入事件+告警），敏感内容不自动回复。",
          evidence: [{ kind: "comment", id: c.commentId, fields: { hoursUnhandled: Math.floor(hours), words: hitWords.join("/") || "platform-flagged" } }],
          calculation: {
            formula: "hasSensitiveWord ∨ 文本命中敏感词库 且 未处置",
            inputs: { commentId: c.commentId, hoursUnhandled: round2(hours), flagged: c.hasSensitiveWord ? 1 : 0, hitWords: hitWords.join("/") },
            result: "命中敏感词",
          },
        }),
      );
      continue; // 同一条不重复计负面/咨询
    }

    if (c.sentiment === "negative" && hours > NEGATIVE_HOURS_P1) {
      findings.push(
        makeFinding({
          line: "comments",
          severity: hours > NEGATIVE_HOURS_P0 ? "P0" : "P1",
          accountId: c.accountId,
          title: `${name} 负面评论 ${Math.floor(hours)}h 未处理：「${c.text.slice(0, 24)}…」`,
          description: `负面评论发布于 ${c.createdAt}，已超 24h 处置红线${hours > NEGATIVE_HOURS_P0 ? "且超 72h，进入舆情发酵区" : ""}，置顶曝光会持续劝退潜在粉丝。`,
          suggestion: "按 SOP 处置（致歉→核实→措施）；不承诺档案外补偿；必要时置顶澄清。",
          evidence: [{ kind: "comment", id: c.commentId, fields: { hoursUnhandled: Math.floor(hours), sentiment: c.sentiment } }],
          calculation: {
            formula: "sentiment=negative 且 未回复 且 now − createdAt > 24h（>72h 升级 P0）",
            inputs: { commentId: c.commentId, hoursUnhandled: round2(hours) },
            result: `${Math.floor(hours)}h > ${NEGATIVE_HOURS_P1}h`,
          },
        }),
      );
    } else if (c.isInquiry && hours > INQUIRY_HOURS_P1) {
      findings.push(
        makeFinding({
          line: "comments",
          severity: hours > INQUIRY_HOURS_P0 ? "P0" : "P1",
          accountId: c.accountId,
          title: `${name} 高意向咨询 ${Math.floor(hours)}h 未回复：「${c.text.slice(0, 24)}…」`,
          description: `求购/询价类咨询的黄金响应窗口是 2 小时，超 12h 线索基本流失${hours > INQUIRY_HOURS_P0 ? "，已超 48h，判定为流失线索" : ""}。`,
          suggestion: "立即补回复并引导私信/橱窗；把该问题沉淀进选题库与自动回复话术。",
          evidence: [{ kind: "comment", id: c.commentId, fields: { hoursUnhandled: Math.floor(hours), isInquiry: 1 } }],
          calculation: {
            formula: "isInquiry 且 未回复 且 now − createdAt > 12h（>48h 升级 P0）",
            inputs: { commentId: c.commentId, hoursUnhandled: round2(hours) },
            result: `${Math.floor(hours)}h > ${INQUIRY_HOURS_P1}h`,
          },
          estimatedImpact: {
            amount: INQUIRY_LEAD_LOSS,
            currency: "LEADS",
            period: "one-off",
            confidence: "baseline",
            basis: "每条超时高意向咨询按 0.5 条线索流失计（12h 后转化率折半，类目基准）",
          },
        }),
      );
    }
  }

  /* ---------- 子项 4：高频问题未沉淀进选题库 ---------- */
  const faqStart = windowStart(ctx.now, FAQ_WINDOW_DAYS);
  const byAccountQuestion = new Map<string, { accountId: string; question: string; ids: string[] }>();
  for (const c of snapshot.comments) {
    if (Date.parse(c.createdAt) < faqStart) continue;
    const q = c.text.trim();
    if (q.length < 4) continue;
    const key = `${c.accountId}::${q}`;
    const entry = byAccountQuestion.get(key) ?? { accountId: c.accountId, question: q, ids: [] };
    entry.ids.push(c.commentId);
    byAccountQuestion.set(key, entry);
  }
  for (const { accountId, question, ids } of byAccountQuestion.values()) {
    if (ids.length < FAQ_MIN_COUNT) continue;
    const name = accName.get(accountId) ?? accountId;
    findings.push(
      makeFinding({
        line: "comments",
        severity: "P2",
        accountId,
        title: `${name} 高频问题未沉淀：「${question.slice(0, 24)}」近 30 天出现 ${ids.length} 次`,
        description: "同一问题反复出现说明内容没讲透，是最低成本的选题富矿，目前未沉淀进选题库。",
        suggestion: "将该问题列入选题库，拍一条 FAQ 视频/图文并置顶；同步进私信自动回复话术。",
        evidence: ids.slice(0, 5).map((id) => ({ kind: "comment", id, fields: { question: question.slice(0, 40) } })),
        calculation: {
          formula: "近30天相同问题文本出现次数 ≥ 3",
          inputs: { question: question.slice(0, 40), count: ids.length, windowDays: FAQ_WINDOW_DAYS },
          result: `${ids.length} ≥ ${FAQ_MIN_COUNT}`,
        },
      }),
    );
  }

  return findings;
}
