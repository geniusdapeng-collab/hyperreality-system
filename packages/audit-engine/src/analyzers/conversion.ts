/**
 * 转化健康线（fast-scan SKILL.md 步骤 5）
 * 四个子项：
 *  1) 主页转化组件缺失：橱窗/预约/联系方式全无 P1（零承接）；缺 1-2 项 P2
 *  2) 私信自动回复未配置或失效 P1
 *  3) 线索跟进断点：询盘后 >48h 未跟进 P1（每条按 1 条线索流失计）
 *  4) 爆款视频未挂转化组件：播放 ≥3×基准 且零挂载 P1，按基准转化率估算线索损失
 */
import type { AuditSnapshot, Finding } from "../types.js";
import { baselinePlays, hoursSince, makeFinding, round2, type AnalyzerContext } from "./util.js";

/** 线索跟进断点红线（小时） */
export const LEAD_FOLLOWUP_HOURS = 48;
/** 爆款口径：播放 ≥ 3× 基准 */
export const HIT_MULTIPLE = 3;
/** 爆款播放→线索基准转化率（私信/表单/点击，类目基准 0.1%） */
export const LEAD_CONV_RATE = 0.001;
/** 主页零承接的月度线索损失经验系数：粉丝 × 0.02% */
export const NO_COMPONENT_LEAD_RATE = 0.0002;
/** 自动回复缺失的线索折损：存量线索 × 20%（经验估计） */
export const AUTOREPLY_LOSS_RATE = 0.2;

export function analyzeConversion(snapshot: AuditSnapshot, ctx: AnalyzerContext): Finding[] {
  const findings: Finding[] = [];

  for (const acc of snapshot.accounts) {
    /* ---------- 子项 1：主页转化组件缺失 ---------- */
    const comps: [string, boolean][] = [
      ["商品橱窗", acc.profile.showcase],
      ["预约组件", acc.profile.booking],
      ["联系方式", acc.profile.contact],
    ];
    const missing = comps.filter(([, ok]) => !ok).map(([n]) => n);
    if (missing.length === comps.length) {
      findings.push(
        makeFinding({
          line: "conversion",
          severity: "P1",
          accountId: acc.accountId,
          title: `${acc.accountName} 主页零转化组件（无橱窗/无预约/无联系方式）`,
          description: "内容与主页零转化承接，流量只能沉淀为粉丝，无法变成线索——流量浪费的最大断点。",
          suggestion: "本周内至少开通一项承接组件（橱窗/预约/联系方式按业务选）；同步配置私信自动回复兜底。",
          evidence: [{ kind: "account", id: acc.accountId, fields: { showcase: 0, booking: 0, contact: 0 } }],
          calculation: {
            formula: "showcase ∨ booking ∨ contact 全无",
            inputs: { accountId: acc.accountId, followers: acc.followers },
            result: "0/3 组件",
          },
          estimatedImpact: {
            amount: Math.max(1, Math.round(acc.followers * NO_COMPONENT_LEAD_RATE)),
            currency: "LEADS",
            period: "monthly",
            confidence: "estimate",
            basis: `粉丝 ${acc.followers} × 主页访问→线索经验系数 0.02%/月（经验估计）`,
          },
        }),
      );
    } else if (missing.length > 0) {
      findings.push(
        makeFinding({
          line: "conversion",
          severity: "P2",
          accountId: acc.accountId,
          title: `${acc.accountName} 转化组件不全：缺 ${missing.join("、")}`,
          description: `已有 ${3 - missing.length}/3 项承接组件，缺 ${missing.join("、")}，转化路径不完整。`,
          suggestion: "补齐缺失组件，形成「内容→主页→私信/表单」完整链路。",
          evidence: [{ kind: "account", id: acc.accountId, fields: { missing: missing.join("/") } }],
          calculation: {
            formula: "showcase/booking/contact 存在性核查",
            inputs: { accountId: acc.accountId, missingCount: missing.length },
            result: `缺 ${missing.length}/3`,
          },
        }),
      );
    }

    /* ---------- 子项 2：私信自动回复未配置或失效 ---------- */
    if (acc.autoReply !== undefined && (!acc.autoReply.configured || !acc.autoReply.active)) {
      const broken = acc.autoReply.configured && !acc.autoReply.active;
      const leadCount = snapshot.leads.filter((l) => l.accountId === acc.accountId).length;
      findings.push(
        makeFinding({
          line: "conversion",
          severity: "P1",
          accountId: acc.accountId,
          title: `${acc.accountName} 私信自动回复${broken ? "已失效" : "未配置"}`,
          description: broken
            ? "自动回复已配置但当前失效（掉授权/开关被关），非工作时段私信零响应，线索在静默中流失。"
            : "未配置私信自动回复，非工作时段私信零响应，线索在静默中流失。",
          suggestion: broken ? "重新授权并回归测试自动回复链路。" : "配置关键词自动回复（价格/地址/怎么买→话术+组件链接）。",
          evidence: [{ kind: "account", id: acc.accountId, fields: { configured: acc.autoReply.configured ? 1 : 0, active: acc.autoReply.active ? 1 : 0 } }],
          calculation: {
            formula: "autoReply.configured = false ∨ active = false",
            inputs: { configured: acc.autoReply.configured ? 1 : 0, active: acc.autoReply.active ? 1 : 0 },
            result: broken ? "失效" : "未配置",
          },
          ...(leadCount > 0
            ? {
                estimatedImpact: {
                  amount: Math.max(1, Math.round(leadCount * AUTOREPLY_LOSS_RATE)),
                  currency: "LEADS" as const,
                  period: "monthly" as const,
                  confidence: "estimate" as const,
                  basis: `存量线索 ${leadCount} 条 × 自动回复缺失折损 20%（经验估计）`,
                },
              }
            : {}),
        }),
      );
    }
  }

  /* ---------- 子项 3：线索跟进断点（询盘后 >48h 未跟进） ---------- */
  for (const lead of snapshot.leads) {
    if (lead.followedUpAt !== undefined) continue;
    const hours = hoursSince(ctx.now, lead.inquiryAt);
    if (hours <= LEAD_FOLLOWUP_HOURS) continue;
    const name = snapshot.accounts.find((a) => a.accountId === lead.accountId)?.accountName ?? lead.accountId;
    findings.push(
      makeFinding({
        line: "conversion",
        severity: "P1",
        accountId: lead.accountId,
        title: `${name} 线索跟进断点：询盘 ${Math.floor(hours)}h 未跟进（${lead.leadId}）`,
        description: `询盘发生于 ${lead.inquiryAt}，超 48h 未跟进，线索转化窗口已基本关闭。`,
        suggestion: "24h 内人工补跟进；建立询盘→跟进 SLA（2h 首响）与看板提醒。",
        evidence: [{ kind: "lead", id: lead.leadId, fields: { hoursUnfollowed: Math.floor(hours), ...(lead.sourceVideoId ? { sourceVideoId: lead.sourceVideoId } : {}) } }],
        calculation: {
          formula: "未跟进 且 now − inquiryAt > 48h",
          inputs: { leadId: lead.leadId, hoursUnfollowed: round2(hours) },
          result: `${Math.floor(hours)}h > ${LEAD_FOLLOWUP_HOURS}h`,
        },
        estimatedImpact: {
          amount: 1,
          currency: "LEADS",
          period: "one-off",
          confidence: "baseline",
          basis: "超 48h 未跟进线索按 1 条流失计（跟进 SLA 基准口径）",
        },
      }),
    );
  }

  /* ---------- 子项 4：爆款视频未挂转化组件（流量浪费） ---------- */
  for (const acc of snapshot.accounts) {
    const videos = snapshot.videos.filter((v) => v.accountId === acc.accountId);
    if (videos.length === 0) continue;
    const base = baselinePlays(videos, ctx.now);
    if (base <= 0) continue;
    for (const v of videos) {
      if (v.hasConversionComponent) continue;
      if (v.plays < base * HIT_MULTIPLE) continue;
      findings.push(
        makeFinding({
          line: "conversion",
          severity: "P1",
          accountId: acc.accountId,
          title: `${acc.accountName} 爆款未挂转化组件：「${v.title.slice(0, 20)}」（${v.plays} 播放）`,
          description: `该内容播放达基准 ${round2(v.plays / base)} 倍但零挂载（无橱窗/团购/预约/链接），高流量零承接，线索白白流走。`,
          suggestion: "立即补挂转化组件或评论区置顶引导；同选题后续内容发布即挂载。",
          evidence: [{ kind: "video", id: v.videoId, fields: { plays: v.plays, multipleOfBaseline: round2(v.plays / base), hasConversionComponent: 0 } }],
          calculation: {
            formula: "plays ≥ 基准 × 3 且 hasConversionComponent = false",
            inputs: { videoId: v.videoId, plays: v.plays, baseline: Math.round(base) },
            result: `${round2(v.plays / base)}× 基准，0 挂载`,
          },
          estimatedImpact: {
            amount: Math.round(v.plays * LEAD_CONV_RATE),
            currency: "LEADS",
            period: "one-off",
            confidence: "baseline",
            basis: `播放 ${v.plays} × 播放→线索基准转化率 0.1%（类目基准估算）`,
          },
        }),
      );
    }
  }

  return findings;
}
