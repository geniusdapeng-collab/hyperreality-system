/**
 * audit-scan · 账号快照快扫 CLI（pnpm audit:scan）
 * 流程：mock 社媒快照（连接器只读拉取的离线替身）→ 组装 AuditSnapshot → runFastScan →
 *       控制台输出《账号快速体检报告》摘要 → 写事件库（五元事件，actor=audit-engine，只读动作）。
 * 纪律：
 *  - 全程只读：audit-only patch 生效，一切平台写操作物理 block；唯一写入是系统事件库（gateway 通道，F1.2）；
 *  - 确定性：mock 快照为固定数据（禁止 Math.random），同环境多次运行结果一致；
 *  - DB 不可用时降级为「仅控制台报告」（事件写失败不阻塞报告交付，打印告警）。
 */
import { appendEvent } from "@workloom/base/workdata";
import { closeAllPools, getGatewayPool } from "@workloom/db";
import { runFastScan, type AuditSnapshot, type Finding } from "@workloom/audit-engine";

/** 报告锚定时间（固定钟：确定性演示口径） */
const NOW = new Date("2026-08-29T10:00:00+08:00");
const hoursAgo = (h: number): string => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const daysAgo = (d: number): string => hoursAgo(d * 24);

/**
 * mock 社媒快照：两账号矩阵（抖音主号 + 小红书小号），含典型存量问题——
 * 限流信号 / 断更 / 高意向咨询遗漏 / 存量负面 / 爆款未挂组件 / 主页零承接 / 敏感词评论 / 矩阵搬运。
 * （真实环境由平台连接器只读 scope 拉取后归一化为同一 AuditSnapshot 模型。）
 */
function mockSnapshot(): AuditSnapshot {
  return {
    snapshotId: `SNAP-${NOW.toISOString().slice(0, 10)}`,
    generatedAt: NOW.toISOString(),
    accounts: [
      {
        accountId: "dy-huanyan-main",
        platformId: "douyin",
        accountName: "焕颜美妆日记",
        category: "美妆",
        followers: 12000,
        expectedPostsPerWeek: 3,
        trafficPeakHours: [12, 19, 20],
        profile: { avatar: true, bio: true, showcase: false, booking: false, contact: false },
        violations: [{ violationId: "vio-20260801", type: "评论区导流警告", occurredAt: daysAgo(25), level: "minor" }],
        sensitiveOps30d: 1,
        autoReply: { configured: true, active: false },
      },
      {
        accountId: "xhs-huanyan-side",
        platformId: "xiaohongshu",
        accountName: "焕颜好物小号",
        category: "美妆",
        followers: 5000,
        profile: { avatar: true, bio: true, showcase: true, booking: false, contact: true },
        violations: [],
        sensitiveOps30d: 0,
        autoReply: { configured: true, active: true },
      },
    ],
    videos: [
      // 主号基准池：5 条老视频 10000 播放
      ...Array.from({ length: 5 }, (_, i) => ({
        accountId: "dy-huanyan-main",
        videoId: `m-old-${i}`,
        title: `底妆教程第${i + 1}期`,
        publishedAt: `2026-08-${String(10 + i).padStart(2, "0")}T19:00:00+08:00`,
        plays: 10000,
        completionRate: 0.35,
        likes: 500,
        comments: 50,
        shares: 30,
        topic: "教程",
        hasConversionComponent: true,
        contentHash: `hash-old-${i}`,
      })),
      // 主号爆款：30000 播放（3×基准）零挂载
      {
        accountId: "dy-huanyan-main",
        videoId: "m-hit",
        title: "早八伪素颜妆教",
        publishedAt: daysAgo(12),
        plays: 30000,
        completionRate: 0.42,
        likes: 3200,
        comments: 410,
        shares: 260,
        topic: "教程",
        hasConversionComponent: false,
        contentHash: "hash-hit",
      },
      // 主号最新连续 3 条播放断崖（限流信号）
      ...Array.from({ length: 3 }, (_, i) => ({
        accountId: "dy-huanyan-main",
        videoId: `m-new-${i}`,
        title: `新选题试水第${i + 1}条`,
        publishedAt: `2026-08-${String(26 + i).padStart(2, "0")}T10:00:00+08:00`,
        plays: 4000,
        completionRate: 0.3,
        likes: 180,
        comments: 20,
        shares: 8,
        topic: "教程",
        hasConversionComponent: true,
        contentHash: `hash-new-${i}`,
      })),
      // 小号：断更 9 天，且搬运了主号爆款同内容（矩阵搬运风险）
      ...Array.from({ length: 4 }, (_, i) => ({
        accountId: "xhs-huanyan-side",
        videoId: `s-v-${i}`,
        title: `开箱测评第${i + 1}期`,
        publishedAt: daysAgo(9 + i),
        plays: 2000,
        completionRate: 0.35,
        likes: 120,
        comments: 15,
        shares: 5,
        topic: "开箱",
        hasConversionComponent: true,
        contentHash: `hash-side-${i}`,
      })),
      {
        accountId: "xhs-huanyan-side",
        videoId: "s-dup-hit",
        title: "早八伪素颜妆教（搬运）",
        publishedAt: daysAgo(11),
        plays: 1500,
        completionRate: 0.28,
        likes: 80,
        comments: 9,
        shares: 2,
        topic: "教程",
        hasConversionComponent: true,
        contentHash: "hash-hit",
      },
    ],
    comments: [
      // 高意向咨询 18h 未回（线索流失）
      { accountId: "dy-huanyan-main", commentId: "c-inq-001", videoId: "m-hit", text: "这款粉底怎么买求链接", createdAt: hoursAgo(18), sentiment: "neutral", isInquiry: true },
      // 负面评论 30h 未处理
      { accountId: "dy-huanyan-main", commentId: "c-neg-001", videoId: "m-old-0", text: "用了两天就过敏了太失望", createdAt: hoursAgo(30), sentiment: "negative" },
      // 敏感词评论未处置
      { accountId: "dy-huanyan-main", commentId: "c-risk-001", videoId: "m-old-1", text: "再不解决我就去投诉平台", createdAt: hoursAgo(6), sentiment: "neutral" },
      // 高频问题 ×3（应沉淀选题库）
      ...Array.from({ length: 3 }, (_, i) => ({
        accountId: "dy-huanyan-main",
        commentId: `c-faq-${i}`,
        videoId: "m-hit",
        text: "油皮适合用这款吗",
        createdAt: hoursAgo(30 + i * 5),
        repliedAt: hoursAgo(28 + i * 5),
        sentiment: "neutral" as const,
      })),
      // 陪跑：已回复正面评论
      { accountId: "dy-huanyan-main", commentId: "c-ok-1", videoId: "m-hit", text: "妆感真的自然", createdAt: hoursAgo(20), repliedAt: hoursAgo(19), sentiment: "positive" },
    ],
    leads: [
      // 询盘 60h 未跟进（线索断点）
      { accountId: "dy-huanyan-main", leadId: "lead-001", inquiryAt: hoursAgo(60), sourceVideoId: "m-hit" },
      // 已正常跟进的线索
      { accountId: "xhs-huanyan-side", leadId: "lead-002", inquiryAt: hoursAgo(30), followedUpAt: hoursAgo(28) },
    ],
    sensitiveWords: [],
  };
}

/** 控制台报告摘要 */
function printReport(snapshot: AuditSnapshot, report: ReturnType<typeof runFastScan>, eventId?: string): void {
  const line = "─".repeat(64);
  console.log(line);
  console.log(`《账号快速体检报告》 ${report.reportId} · 生成于 ${report.generatedAt}`);
  console.log(`快照 ${snapshot.snapshotId} · 账号 ${report.overview.accountCount} 个 · 数据源覆盖：${
    Object.entries(report.coverage).map(([k, v]) => `${k}=${v === "covered" ? "✓" : v === "partial" ? "△" : "✗"}`).join(" ")
  }`);
  if (report.coverageNotes.length > 0) console.log(`降级说明：${report.coverageNotes.join("；")}`);
  console.log(line);
  const { counts, findingCount, totalRecoverableByUnit } = report.overview;
  console.log(`发现 ${findingCount} 条（P0=${counts.P0} / P1=${counts.P1} / P2=${counts.P2}）`);
  const totals = Object.entries(totalRecoverableByUnit)
    .map(([u, a]) => `${a.toLocaleString()} ${u === "FANS" ? "粉丝" : u === "LEADS" ? "条线索" : u}`)
    .join(" + ");
  console.log(`估算挽回空间：${totals || "—"}（分单位口径，详见各发现 confidence/basis 标注）`);
  console.log(line);
  for (const acc of report.accounts) {
    console.log(`◆ ${acc.accountName}（${acc.platformId} · ${acc.followers.toLocaleString()} 粉）— P0=${acc.counts.P0} P1=${acc.counts.P1} P2=${acc.counts.P2}`);
    for (const f of acc.findings) {
      console.log(`   [${f.severity}] ${f.title}`);
    }
  }
  console.log(line);
  console.log("Top 行动清单（按估算挽回降序，最多 10 条）：");
  report.top10.forEach((f: Finding, i: number) => {
    const impact = f.estimatedImpact
      ? `${f.estimatedImpact.amount.toLocaleString()} ${f.estimatedImpact.currency}/${f.estimatedImpact.period} [${f.estimatedImpact.confidence}]`
      : "—";
    const owner = report.accounts.find((a) => a.findings.some((x) => x.id === f.id));
    console.log(` ${String(i + 1).padStart(2)}. [${f.severity}] ${f.title}`);
    console.log(`     账号=${owner?.accountName ?? f.accountId} · 挽回≈${impact}`);
    console.log(`     建议：${f.suggestion}`);
  });
  console.log(line);
  console.log(`耗时 ${report.elapsedMs}ms（软预算 ${report.timeBudgetMinutes} 分钟）· 全程只读`);
  if (eventId) console.log(`报告事件已入库：${eventId}（actor=audit-engine，action=audit.fast-scan.report）`);
}

async function main(): Promise<void> {
  const snapshot = mockSnapshot();
  console.log(`[audit-scan] mock 快照就绪：accounts=${snapshot.accounts.length} videos=${snapshot.videos.length} comments=${snapshot.comments.length} leads=${snapshot.leads.length}`);

  const report = runFastScan(snapshot, { now: NOW, timeBudgetMinutes: 30 });

  // 写事件库（五元事件；DB 不可达时降级为仅控制台报告，不阻塞交付）
  let eventId: string | undefined;
  try {
    const gateway = getGatewayPool();
    const r = await appendEvent(
      gateway,
      { tenantId: "tenant-demo", workspaceId: "ws-hyperreality" },
      {
        event: {
          who: { type: "agent", id: "audit-engine", version: "0.1.0" },
          context: { tenant_id: "tenant-demo", workspace_id: "ws-hyperreality", time: NOW.toISOString(), channel: "cli", stage: "audit" },
          object: { type: "audit-report", id: report.reportId },
          decision: {
            action: "audit.fast-scan.report",
            after: {
              findingCount: report.overview.findingCount,
              counts: report.overview.counts,
              totalRecoverableByUnit: report.overview.totalRecoverableByUnit,
              coverage: report.coverage,
              top10: report.top10.map((f) => ({ id: f.id, line: f.line, severity: f.severity, title: f.title, impact: f.estimatedImpact })),
            },
            basis: ["fast-scan 四线扫描（bundles/ai-video/skills/fast-scan）", "全程只读：未调用任何平台写接口"],
          },
          rule_impact: [{ rule_id: "audit-only-patch", version: "ai-video-patch-audit-only/v1", result: "pass" }],
        },
      },
    );
    eventId = r.eventId;
    await closeAllPools();
  } catch (err) {
    console.warn(`[audit-scan] 事件库写入失败（降级为仅控制台报告）：${err instanceof Error ? err.message : String(err)}`);
  }

  printReport(snapshot, report, eventId);
}

await main();
