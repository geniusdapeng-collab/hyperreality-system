/**
 * 账号健康线（fast-scan SKILL.md 步骤 2）
 * 四个子项：
 *  1) 限流风险信号：最新内容连续 ≥3 条播放量 < 历史基准 50%（≥5 条升级 P0——疑似持续限流）
 *  2) 违规记录与敏感操作：90 天内 major 违规 P0 / minor P1 / warning P2；敏感操作 ≥3 次 P1（G16 域只读核查）
 *  3) 资料完整度：头像/简介缺失 P2（转化组件缺失归转化线，互不双算）
 *  4) 矩阵搬运风险：同一 contentHash 多账号重复发布，首发之外的账号各记 P1
 */
import type { AuditSnapshot, Finding } from "../types.js";
import { baselinePlays, daysSince, makeFinding, round2, windowStart, type AnalyzerContext } from "./util.js";

/** 限流判定：环比下滑阈值（相对基准播放量） */
export const LIMIT_DROP_RATIO = 0.5;
/** 连续低播放条数红线（≥3 命中，≥5 升级 P0） */
export const LIMIT_STREAK_MIN = 3;
export const LIMIT_STREAK_P0 = 5;
/** 涨粉转化率基准（播放→粉丝，类目经验值 0.3%） */
export const FOLLOW_RATE = 0.003;
/** 敏感操作次数红线（近 30 天） */
export const SENSITIVE_OPS_MAX = 3;
/** 违规追溯窗口（天） */
export const VIOLATION_WINDOW_DAYS = 90;

export function analyzeAccount(snapshot: AuditSnapshot, ctx: AnalyzerContext): Finding[] {
  const findings: Finding[] = [];

  /* ---------- 子项 1：限流风险信号（连续 ≥3 条播放 < 基准 50%） ---------- */
  for (const acc of snapshot.accounts) {
    const videos = snapshot.videos
      .filter((v) => v.accountId === acc.accountId)
      .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
    if (videos.length < LIMIT_STREAK_MIN) continue;
    const base = baselinePlays(videos, ctx.now);
    if (base <= 0) continue;
    let streak = 0;
    const streakVideos: string[] = [];
    for (const v of videos) {
      if (v.plays < base * LIMIT_DROP_RATIO) {
        streak += 1;
        streakVideos.push(v.videoId);
      } else {
        break;
      }
    }
    if (streak >= LIMIT_STREAK_MIN) {
      const lostPlays = streakVideos.reduce((s, id) => {
        const v = videos.find((x) => x.videoId === id)!;
        return s + (base - v.plays);
      }, 0);
      findings.push(
        makeFinding({
          line: "account",
          severity: streak >= LIMIT_STREAK_P0 ? "P0" : "P1",
          accountId: acc.accountId,
          title: `${acc.accountName} 疑似限流：连续 ${streak} 条播放量不足基准 50%`,
          description: `最新 ${streak} 条内容播放量均低于历史基准（中位 ${Math.round(base)}）的 50%，断崖式下滑是限流/降权的典型信号。`,
          suggestion: "核查近 30 天违规通知与敏感操作；暂停搬运/硬广内容，连发 3-5 条高完播原创观察推荐恢复；必要时申诉。",
          evidence: streakVideos.map((id) => {
            const v = videos.find((x) => x.videoId === id)!;
            return { kind: "video", id, fields: { plays: v.plays, baseline: Math.round(base) } };
          }),
          calculation: {
            formula: "连续 N 条 plays < 基准播放量(近7天前中位数) × 0.5，N ≥ 3",
            inputs: { accountId: acc.accountId, baseline: Math.round(base), streak, dropRatio: LIMIT_DROP_RATIO },
            result: `${streak} ≥ ${LIMIT_STREAK_MIN}`,
          },
          estimatedImpact: {
            amount: Math.round(lostPlays * FOLLOW_RATE),
            currency: "FANS",
            period: "monthly",
            confidence: "baseline",
            basis: `播放缺口 ${Math.round(lostPlays)} × 涨粉转化率基准 0.3%（类目基准估算）`,
          },
        }),
      );
    }
  }

  /* ---------- 子项 2：违规记录与敏感操作 ---------- */
  for (const acc of snapshot.accounts) {
    for (const vio of acc.violations) {
      const days = daysSince(ctx.now, vio.occurredAt);
      if (days > VIOLATION_WINDOW_DAYS) continue;
      findings.push(
        makeFinding({
          line: "account",
          severity: vio.level === "major" ? "P0" : vio.level === "minor" ? "P1" : "P2",
          accountId: acc.accountId,
          title: `${acc.accountName} ${Math.floor(days)} 天前有 ${vio.level} 违规记录：${vio.type}`,
          description: `违规发生于 ${vio.occurredAt}（${vio.level}），权重处罚期内推荐量会被压制。`,
          suggestion: vio.level === "major" ? "立即停止同类操作并按平台流程申诉；处罚期内只做原创合规内容养号。" : "归档取证，复盘触发点，纳入发布前预检清单。",
          evidence: [{ kind: "violation", id: vio.violationId, fields: { type: vio.type, level: vio.level, daysAgo: Math.floor(days) } }],
          calculation: {
            formula: "违规 level 映射严重度 且 now − occurredAt ≤ 90d",
            inputs: { violationId: vio.violationId, level: vio.level, daysAgo: round2(days) },
            result: `${vio.level} / ${Math.floor(days)}d`,
          },
        }),
      );
    }
    if ((acc.sensitiveOps30d ?? 0) >= SENSITIVE_OPS_MAX) {
      findings.push(
        makeFinding({
          line: "account",
          severity: "P1",
          accountId: acc.accountId,
          title: `${acc.accountName} 近 30 天敏感操作 ${acc.sensitiveOps30d} 次（防关联/风控风险）`,
          description: "频繁改绑/换设备/改实名等敏感操作会触发平台风控，矩阵账号还可能被判关联。",
          suggestion: "冻结非必要账号变更；矩阵账号隔离登录环境与操作节奏（G16 纪律）。",
          evidence: [{ kind: "account", id: acc.accountId, fields: { sensitiveOps30d: acc.sensitiveOps30d ?? 0 } }],
          calculation: {
            formula: "sensitiveOps30d ≥ 3",
            inputs: { accountId: acc.accountId, sensitiveOps30d: acc.sensitiveOps30d ?? 0 },
            result: `${acc.sensitiveOps30d} ≥ ${SENSITIVE_OPS_MAX}`,
          },
        }),
      );
    }
  }

  /* ---------- 子项 3：资料完整度（头像/简介） ---------- */
  for (const acc of snapshot.accounts) {
    const missing: string[] = [];
    if (!acc.profile.avatar) missing.push("头像");
    if (!acc.profile.bio) missing.push("简介");
    if (missing.length > 0) {
      findings.push(
        makeFinding({
          line: "account",
          severity: "P2",
          accountId: acc.accountId,
          title: `${acc.accountName} 资料不完整：缺 ${missing.join("、")}`,
          description: "头像/简介是关注转化的第一触点，缺失会拉低主页关注率与信任度。",
          suggestion: "补齐头像与简介（一句话定位+更新频率+关注利益点）。",
          evidence: [{ kind: "account", id: acc.accountId, fields: { missing: missing.join("/") } }],
          calculation: {
            formula: "avatar/bio 存在性核查",
            inputs: { accountId: acc.accountId, avatar: acc.profile.avatar ? 1 : 0, bio: acc.profile.bio ? 1 : 0 },
            result: `缺 ${missing.length} 项`,
          },
        }),
      );
    }
  }

  /* ---------- 子项 4：矩阵搬运风险（同 contentHash 多号发布） ---------- */
  const byHash = new Map<string, { accountId: string; videoId: string; publishedAt: string; plays: number }[]>();
  for (const v of snapshot.videos) {
    if (!v.contentHash) continue;
    const arr = byHash.get(v.contentHash) ?? [];
    arr.push({ accountId: v.accountId, videoId: v.videoId, publishedAt: v.publishedAt, plays: v.plays });
    byHash.set(v.contentHash, arr);
  }
  for (const [hash, pubs] of byHash) {
    const accounts = new Set(pubs.map((p) => p.accountId));
    if (accounts.size < 2) continue;
    pubs.sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt));
    const origin = pubs[0]!;
    for (const dup of pubs.slice(1)) {
      if (dup.accountId === origin.accountId) continue;
      const name = snapshot.accounts.find((a) => a.accountId === dup.accountId)?.accountName ?? dup.accountId;
      findings.push(
        makeFinding({
          line: "account",
          severity: "P1",
          accountId: dup.accountId,
          title: `${name} 与 ${origin.accountId} 重复发布同内容（搬运判定风险）`,
          description: `内容指纹 ${hash.slice(0, 12)} 在 ${origin.accountId} 首发后又在本账号发布，平台去重机制会压推荐甚至判搬运处罚。`,
          suggestion: "矩阵分发必须二剪差异化（改封面/前3秒/字幕/BGM）；同内容同平台只发一个号。",
          evidence: [
            { kind: "video", id: dup.videoId, fields: { contentHash: hash, origin: origin.videoId } },
            { kind: "video", id: origin.videoId, fields: { accountId: origin.accountId, publishedAt: origin.publishedAt } },
          ],
          calculation: {
            formula: "同 contentHash 出现于 ≥2 个账号，首发之外的发布计搬运风险",
            inputs: { contentHash: hash, accountCount: accounts.size, originAccount: origin.accountId },
            result: `${accounts.size} 号重复`,
          },
        }),
      );
    }
  }

  return findings;
}
