/**
 * 内容健康线（fast-scan SKILL.md 步骤 3）
 * 四个子项：
 *  1) 断更：距上次发布 >7 天 P1（>14 天升级 P0）；低于自设节律 30% P2
 *  2) 低效选题聚集：近 20 条中完播率 <15% 占比 >50% P1
 *  3) 高潜素材未复用：历史爆款（≥3×基准）选题近 30 天 0 复用 P2
 *  4) 发布时段错配：近 20 条落在粉丝活跃高峰的比例 <30% P2
 */
import type { AuditSnapshot, Finding, VideoRecord } from "../types.js";
import { baselinePlays, daysSince, makeFinding, round2, round4, windowStart, type AnalyzerContext } from "./util.js";

/** 断更红线（天），>14 天升级 P0 */
export const STALE_DAYS_P1 = 7;
export const STALE_DAYS_P0 = 14;
/** 断更粉丝流失经验系数：每周 0.5% */
export const STALE_UNFOLLOW_WEEKLY = 0.005;
/** 节律达成率下限（实际/自设 < 70% 命中） */
export const CADENCE_MIN_RATIO = 0.7;
/** 低效选题口径：完播率 <15% 且占比 >50%（近 20 条，样本 ≥10） */
export const LOW_COMPLETION = 0.15;
export const LOW_COMPLETION_SHARE = 0.5;
export const RECENT_WINDOW = 20;
export const MIN_SAMPLE = 10;
/** 爆款口径：播放 ≥ 3× 基准；复用窗口 30 天 */
export const HIT_MULTIPLE = 3;
export const REUSE_WINDOW_DAYS = 30;
/** 时段错配口径：高峰时段发布占比 <30% */
export const PEAK_SHARE_MIN = 0.3;

/** 取账号最近 N 条（按发布时间倒序） */
function recentVideos(videos: VideoRecord[], n: number): VideoRecord[] {
  return [...videos].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)).slice(0, n);
}

export function analyzeContent(snapshot: AuditSnapshot, ctx: AnalyzerContext): Finding[] {
  const findings: Finding[] = [];

  for (const acc of snapshot.accounts) {
    const videos = snapshot.videos.filter((v) => v.accountId === acc.accountId);
    if (videos.length === 0) continue;

    /* ---------- 子项 1：断更 / 节律不足 ---------- */
    const latest = videos.reduce((a, b) => (Date.parse(a.publishedAt) > Date.parse(b.publishedAt) ? a : b));
    const silentDays = daysSince(ctx.now, latest.publishedAt);
    if (silentDays > STALE_DAYS_P1) {
      const weeks = silentDays / 7;
      findings.push(
        makeFinding({
          line: "content",
          severity: silentDays > STALE_DAYS_P0 ? "P0" : "P1",
          accountId: acc.accountId,
          title: `${acc.accountName} 断更 ${Math.floor(silentDays)} 天（上次发布 ${latest.publishedAt.slice(0, 10)}）`,
          description: `停更期间推荐权重持续衰减，粉丝触达断档${silentDays > STALE_DAYS_P0 ? "，已超过两周，账号进入冷启动回退区" : ""}。`,
          suggestion: "48 小时内恢复更新，先用历史高完播选题复刻一条重启推荐；此后固定节律。",
          evidence: [{ kind: "video", id: latest.videoId, fields: { publishedAt: latest.publishedAt, silentDays: Math.floor(silentDays) } }],
          calculation: {
            formula: "now − max(publishedAt) > 7d（>14d 升级 P0）",
            inputs: { accountId: acc.accountId, silentDays: round2(silentDays), lastVideoId: latest.videoId },
            result: `${Math.floor(silentDays)}d > ${STALE_DAYS_P1}d`,
          },
          estimatedImpact: {
            amount: Math.round(acc.followers * STALE_UNFOLLOW_WEEKLY * weeks),
            currency: "FANS",
            period: "one-off",
            confidence: "estimate",
            basis: `粉丝 ${acc.followers} × 断更流失经验系数 0.5%/周 × ${round2(weeks)} 周`,
          },
        }),
      );
    }
    if (acc.expectedPostsPerWeek !== undefined && acc.expectedPostsPerWeek > 0) {
      const expected30d = (acc.expectedPostsPerWeek * 30) / 7;
      const actual30d = videos.filter((v) => Date.parse(v.publishedAt) >= windowStart(ctx.now, 30)).length;
      if (actual30d < expected30d * CADENCE_MIN_RATIO && silentDays <= STALE_DAYS_P1) {
        findings.push(
          makeFinding({
            line: "content",
            severity: "P2",
            accountId: acc.accountId,
            title: `${acc.accountName} 发布节律不足：近 30 天 ${actual30d} 条 / 自设 ${round2(expected30d)} 条`,
            description: `节律达成率 ${Math.round((actual30d / expected30d) * 100)}% 低于 70%，更新不稳定影响粉丝预期与权重累积。`,
            suggestion: "按自设节律排期囤稿；至少保底每周稳定产出。",
            evidence: [{ kind: "account", id: acc.accountId, fields: { actual30d, expected30d: round2(expected30d) } }],
            calculation: {
              formula: "近30天发布数 < 自设条/周 × 30/7 × 70%",
              inputs: { actual30d, expected30d: round2(expected30d), ratio: round4(actual30d / expected30d) },
              result: `${Math.round((actual30d / expected30d) * 100)}% < 70%`,
            },
          }),
        );
      }
    }

    /* ---------- 子项 2：低效选题聚集（近20条完播<15%占比>50%） ---------- */
    const recent = recentVideos(videos, RECENT_WINDOW).filter((v) => v.completionRate !== undefined);
    if (recent.length >= MIN_SAMPLE) {
      const low = recent.filter((v) => v.completionRate! < LOW_COMPLETION);
      const share = low.length / recent.length;
      if (share > LOW_COMPLETION_SHARE) {
        findings.push(
          makeFinding({
            line: "content",
            severity: "P1",
            accountId: acc.accountId,
            title: `${acc.accountName} 低效选题聚集：近 ${recent.length} 条中 ${low.length} 条完播率 <15%（${Math.round(share * 100)}%）`,
            description: "超半数内容完播率低于 15%，选题方向与受众错配，持续拉低账号整体推荐权重。",
            suggestion: "暂停低效选题方向；从近 90 天高完播内容中提炼 3 个选题柱，集中翻拍。",
            evidence: low.slice(0, 5).map((v) => ({ kind: "video", id: v.videoId, fields: { completionRate: v.completionRate!, plays: v.plays } })),
            calculation: {
              formula: "近20条中 completionRate < 0.15 的占比 > 50%（样本 ≥10）",
              inputs: { sampleSize: recent.length, lowCount: low.length, share: round4(share) },
              result: `${Math.round(share * 100)}% > 50%`,
            },
            estimatedImpact: {
              amount: Math.round(low.reduce((s, v) => s + v.plays, 0) * 0.002),
              currency: "FANS",
              period: "monthly",
              confidence: "estimate",
              basis: `低效内容总播放 × 0.2% 修正后涨粉空间（经验估计）`,
            },
          }),
        );
      }
    }

    /* ---------- 子项 3：高潜素材未复用（历史爆款选题近 30 天 0 复用） ---------- */
    const base = baselinePlays(videos, ctx.now);
    if (base > 0) {
      const reuseStart = windowStart(ctx.now, REUSE_WINDOW_DAYS);
      const recentTopics = new Set(
        videos.filter((v) => Date.parse(v.publishedAt) >= reuseStart && v.topic).map((v) => v.topic!),
      );
      const hitByTopic = new Map<string, VideoRecord>();
      for (const v of videos) {
        if (!v.topic || Date.parse(v.publishedAt) >= reuseStart) continue;
        if (v.plays < base * HIT_MULTIPLE) continue;
        const cur = hitByTopic.get(v.topic);
        if (!cur || v.plays > cur.plays) hitByTopic.set(v.topic, v);
      }
      for (const [topic, hit] of hitByTopic) {
        if (recentTopics.has(topic)) continue;
        findings.push(
          makeFinding({
            line: "content",
            severity: "P2",
            accountId: acc.accountId,
            title: `${acc.accountName} 高潜素材未复用：爆款「${hit.title}」（${hit.plays} 播放）选题近 30 天 0 复用`,
            description: `该选题历史播放达基准 ${round2(hit.plays / base)} 倍，已被验证但近 30 天无二剪/复刻/跨平台分发，流量资产闲置。`,
            suggestion: "本周内复刻该选题（换案例/换场景/二剪），并同步分发矩阵其他平台。",
            evidence: [{ kind: "video", id: hit.videoId, fields: { plays: hit.plays, topic, multipleOfBaseline: round2(hit.plays / base) } }],
            calculation: {
              formula: "plays ≥ 基准 × 3 且 同 topic 近 30 天发布数 = 0",
              inputs: { videoId: hit.videoId, plays: hit.plays, baseline: Math.round(base), topic },
              result: `${round2(hit.plays / base)}× 基准，0 复用`,
            },
            estimatedImpact: {
              amount: Math.round(hit.plays * 0.3 * 0.003),
              currency: "FANS",
              period: "one-off",
              confidence: "estimate",
              basis: `复刻预计恢复 30% 播放（${Math.round(hit.plays * 0.3)}）× 涨粉转化 0.3%`,
            },
          }),
        );
      }
    }

    /* ---------- 子项 4：发布时段与流量曲线错配 ---------- */
    if (acc.trafficPeakHours && acc.trafficPeakHours.length > 0) {
      const peak = new Set(acc.trafficPeakHours);
      const lastN = recentVideos(videos, RECENT_WINDOW);
      if (lastN.length >= MIN_SAMPLE) {
        const inPeak = lastN.filter((v) => peak.has(new Date(v.publishedAt).getUTCHours())).length;
        const share = inPeak / lastN.length;
        if (share < PEAK_SHARE_MIN) {
          findings.push(
            makeFinding({
              line: "content",
              severity: "P2",
              accountId: acc.accountId,
              title: `${acc.accountName} 发布时段错配：近 ${lastN.length} 条仅 ${Math.round(share * 100)}% 落在粉丝活跃高峰`,
              description: `粉丝活跃高峰为 ${acc.trafficPeakHours.join("/")} 时（UTC），但大部分内容错峰发布，冷启动曝光被稀释。`,
              suggestion: "把主更时间固定到高峰前 1 小时；持续两周观察首小时播放变化。",
              evidence: [{ kind: "account", id: acc.accountId, fields: { peakHours: acc.trafficPeakHours.join("/"), inPeakShare: round4(share) } }],
              calculation: {
                formula: "近20条 publishedAt 小时 ∈ 高峰集合 的占比 < 30%",
                inputs: { sampleSize: lastN.length, inPeak, share: round4(share) },
                result: `${Math.round(share * 100)}% < 30%`,
              },
            }),
          );
        }
      }
    }
  }

  return findings;
}
