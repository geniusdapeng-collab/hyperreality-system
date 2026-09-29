#!/usr/bin/env node
/**
 * autonomy.mjs · O4 自主交付率（ADR）/ 人工介入率（HIR）计算（RDAS v3.1）
 *
 * 数据源四合一：threads（交付件）+ approvals（人审/修正/驳回）+ biz_events（人类动作/回执线索）+ c_tickets（返工线索）。
 * 产出：autonomy-report.{json,md}，含 ADR-0/1/2、HIR、HIR-NI、H3+H4、HMPO 估算、Wilson CI、夹具过滤、
 *       橡皮图章/未回执/未关联等数据质量发现。
 *
 * 口径纪律：
 *  - 交付件 = terminal threads（completed/failed/paused）；ADR 分母默认只用 completed；
 *  - H1（制度性人审）不计缺陷但计入人工当量；H2 修改 / H3 接管 / H4 返工 计入非制度性介入；
 *  - 夹具（suite.* / apr-suite-* / apr-e-* / 近零时长）默认过滤并披露过滤前后数量；
 *  - 回执覆盖率不足时，ADR 标注 receiptCoverage，不得当作“结果已对账”。
 *
 * 用法：node scripts/acceptance/autonomy.mjs [--out <dir>] [--profile <path>] [--workspace <id>] [--since <ISO>] [--all]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import pg from "pg";
import { cliArgs, findRepoRoot, loadProfile } from "./lib/profile.mjs";

const args = cliArgs();
const REPO_ROOT = findRepoRoot();
const { profile, warnings: profileWarnings } = loadProfile(REPO_ROOT, args.profilePath);
const OUT_DIR = resolve(args.outDir ?? join(REPO_ROOT, "outputs", "acceptance", "autonomy"));
mkdirSync(OUT_DIR, { recursive: true });

function readEnvValue(key) {
  const path = join(REPO_ROOT, ".env");
  if (!existsSync(path)) return undefined;
  const line = readFileSync(path, "utf-8").split("\n").find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() : undefined;
}
const DB_URL = process.env.DATABASE_URL ?? readEnvValue("DATABASE_URL");
if (!DB_URL) throw new Error("缺少 DATABASE_URL（.env 或环境变量）");

const FILTERS = profile.autonomy?.fixtureFilters ?? ["suite.", "suite-", "apr-suite-", "apr-e-", "T-suite"];
const SINCE = (() => {
  const i = process.argv.indexOf("--since");
  if (i >= 0) return process.argv[i + 1];
  if (process.argv.includes("--all")) return null;
  const wi = process.argv.indexOf("--window");
  const w = wi >= 0 ? process.argv[wi + 1] : profile.autonomy?.windows?.[0] ?? "4w";
  const m = /^(\d+)w$/.exec(w);
  if (!m) return null;
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - Number(m[1]) * 7);
  return d.toISOString();
})();
const isFixture = (text) => FILTERS.some((f) => String(text).includes(f)) || /suite/i.test(String(text));
const pct = (n, d) => (d > 0 ? n / d : null);
function wilson(k, n, z = 1.96) {
  if (!n) return { p: null, lo: null, hi: null, n: 0 };
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { p: Number(p.toFixed(4)), lo: Number(Math.max(0, center - half).toFixed(4)), hi: Number(Math.min(1, center + half).toFixed(4)), n };
}

const client = new pg.Client({ connectionString: DB_URL });
await client.connect();
try {
  const wsRow = profile.workspaceId
    ? (await client.query("SELECT id, slug, bundle_id FROM workspaces WHERE id=$1", [profile.workspaceId])).rows[0]
    : (await client.query("SELECT id, slug, bundle_id FROM workspaces WHERE slug=$1 LIMIT 1", [profile.identity?.workspaceSlug ?? ""])).rows[0];
  if (!wsRow) throw new Error(`找不到工作区：${profile.workspaceId ?? profile.identity?.workspaceSlug}`);

  const sinceSql = SINCE ? "AND t.created_at >= $2" : "";
  const threadsQ = await client.query(
    `SELECT t.id, t.mode, t.status, t.title, t.created_by, t.agent_id, a.preset_key, a.name AS agent_name,
            t.created_at, t.closed_at, t.paused_by, t.error, t.progress_done, t.progress_total
       FROM threads t LEFT JOIN agents a ON a.id = t.agent_id
      WHERE t.workspace_id = $1 ${sinceSql}
      ORDER BY t.created_at DESC`,
    SINCE ? [wsRow.id, SINCE] : [wsRow.id],
  );
  const approvalsQ = await client.query(
    `SELECT a.approval_id, a.status, a.decided_by, a.created_at, a.decided_at,
            (EXTRACT(EPOCH FROM (COALESCE(a.decided_at, a.created_at) - a.created_at)) * 1000)::bigint AS latency_ms,
            e.session_id, e.payload->'decision'->>'action' AS event_action,
            COALESCE(
              CASE WHEN e.payload->'object'->>'type' = 'thread' THEN e.payload->'object'->>'id' END,
              CASE WHEN e.session_id ~ '^T-[0-9]+$' THEN e.session_id END
            ) AS thread_id
       FROM approvals a
       LEFT JOIN biz_events e ON e.tenant_id = a.tenant_id AND e.event_id = a.event_id
      WHERE a.workspace_id = $1 ${SINCE ? "AND a.created_at >= $2" : ""}
      ORDER BY a.created_at DESC`,
    SINCE ? [wsRow.id, SINCE] : [wsRow.id],
  );
  const humanEventsQ = await client.query(
    `SELECT session_id, payload->'decision'->>'action' AS action, count(*)::int AS n
       FROM biz_events
      WHERE workspace_id = $1 AND payload->'who'->>'type' = 'human' ${SINCE ? "AND created_at >= $2" : ""}
      GROUP BY 1, 2 ORDER BY 3 DESC`,
    SINCE ? [wsRow.id, SINCE] : [wsRow.id],
  );
  const receiptQ = await client.query(
    /**
     * 回执线索口径（2026-09-24 修复）：五元事件格式里 receipt 是**顶层可选字段**
     * （payload.receipt.synced，见 runtime/loop.ts 的执行事件与 E3.7「无回执=未核实」）。
     * 旧实现只查 rule_impact.receipt 与 decision.after.synced —— 两条路径在本仓事件里不存在，
     * 实测把 132 条真实回执全漏掉，产出"回执覆盖率 0% / 完成但无回执 21"的**假发现**。
     * 现以顶层 receipt 为准，旧路径保留作兼容兜底。
     */
    `SELECT session_id,
            count(*) FILTER (WHERE payload->'receipt'->>'synced' IN ('true','false')
               OR payload->'rule_impact'->>'receipt' IS NOT NULL
               OR payload->'decision'->'after'->>'synced' IN ('true','false'))::int AS receipt_events
       FROM biz_events
      WHERE workspace_id = $1 ${SINCE ? "AND created_at >= $2" : ""}
      GROUP BY 1`,
    SINCE ? [wsRow.id, SINCE] : [wsRow.id],
  );
  const ticketsQ = await client.query(
    `SELECT id, kind, status, payload FROM c_tickets WHERE workspace_id = $1 ${SINCE ? "AND created_at >= $2" : ""} LIMIT 500`,
    SINCE ? [wsRow.id, SINCE] : [wsRow.id],
  );
  const externalQ = await client.query(
    `SELECT session_id,
            count(*) FILTER (WHERE payload->'decision'->>'action' ~ 'publish|send|notify|pay|refund|export|post|deliver|submit')::int AS external_actions
       FROM biz_events
      WHERE workspace_id = $1 ${SINCE ? "AND created_at >= $2" : ""}
      GROUP BY 1`,
    SINCE ? [wsRow.id, SINCE] : [wsRow.id],
  );

  const allThreads = threadsQ.rows;
  const allApprovals = approvalsQ.rows;
  const fixtureThreads = allThreads.filter((t) => isFixture(`${t.id} ${t.title}`));
  const fixtureApprovals = allApprovals.filter((a) => isFixture(a.approval_id) || (a.latency_ms != null && Number(a.latency_ms) < 1000 && a.decided_by));
  const threads = allThreads.filter((t) => !isFixture(`${t.id} ${t.title}`));
  const approvals = allApprovals.filter((a) => !fixtureApprovals.includes(a));
  const threadIds = new Set(threads.map((t) => t.id));

  // 人类在 thread 内的动作（session_id = threadId，且不是派发动作本身）
  const humanInThread = new Map();
  for (const row of humanEventsQ.rows) {
    if (row.session_id && threadIds.has(row.session_id) && row.action !== "thread.dispatch") {
      humanInThread.set(row.session_id, (humanInThread.get(row.session_id) ?? 0) + Number(row.n));
    }
  }
  const receipts = new Map(receiptQ.rows.map((r) => [r.session_id, Number(r.receipt_events ?? 0)]));
  const externalActions = new Map(externalQ.rows.map((r) => [r.session_id, Number(r.external_actions ?? 0)]));
  const reworkTickets = new Map();
  for (const t of ticketsQ.rows) {
    const payloadText = JSON.stringify(t.payload ?? {});
    for (const id of threadIds) {
      if (payloadText.includes(id)) reworkTickets.set(id, (reworkTickets.get(id) ?? 0) + 1);
    }
  }

  const byThread = new Map();
  for (const t of threads) byThread.set(t.id, { ...t, approvals: [] });
  const unlinkedApprovals = [];
  for (const a of approvals) {
    const target = a.thread_id && byThread.has(a.thread_id) ? byThread.get(a.thread_id) : null;
    if (target) target.approvals.push(a);
    else unlinkedApprovals.push(a);
  }

  const TERMINAL = new Set(["completed", "failed", "paused"]);
  const enriched = [...byThread.values()];
  const terminal = enriched.filter((t) => TERMINAL.has(t.status));
  const delivered = enriched.filter((t) => t.status === "completed");
  const classify = (t) => {
    const statuses = new Set(t.approvals.map((a) => a.status));
    const hasReject = statuses.has("rejected");
    const hasEdit = statuses.has("edited");
    const hasApprove = statuses.has("approved");
    const humanTouches = humanInThread.get(t.id) ?? 0;
    const rework = reworkTickets.get(t.id) ?? 0;
    const classes = [];
    if (rework > 0) classes.push("H4");
    if (hasReject || t.paused_by || (t.status === "failed" && humanTouches > 0)) classes.push("H3");
    if (hasEdit || (humanTouches > 0 && !classes.includes("H3") && !classes.includes("H4"))) classes.push("H2");
    if (hasApprove && classes.length === 0) classes.push("H1");
    if (classes.length === 0) classes.push("H0");
    const hasH2 = classes.includes("H2"), hasH3 = classes.includes("H3"), hasH4 = classes.includes("H4");
    return {
      id: t.id, mode: t.mode, status: t.status, role: t.preset_key ?? "(未指派)", title: t.title,
      classes, adr0: !hasH2 && !hasH3 && !hasH4 && !hasApprove, adr1: !hasH2 && !hasH3 && !hasH4, adr2: !hasH3 && !hasH4,
      h1: classes.includes("H1") ? 1 : 0, h2: hasH2 ? 1 : 0, h3: hasH3 ? 1 : 0, h4: hasH4 ? 1 : 0,
      humanTouches, reworkTickets: rework, receiptEvents: receipts.get(t.id) ?? 0,
      externalActions: externalActions.get(t.id) ?? 0,
      approvalLatencyMs: t.approvals.reduce((a, x) => a + Math.max(0, Number(x.latency_ms ?? 0)), 0),
    };
  };
  const rows = delivered.map(classify);
  const terminalRows = terminal.map(classify);

  const agg = (list) => {
    const n = list.length;
    const count = (fn) => list.filter(fn).length;
    return {
      n,
      adr0: wilson(count((r) => r.adr0), n),
      adr1: wilson(count((r) => r.adr1), n),
      adr2: wilson(count((r) => r.adr2), n),
      hir: wilson(count((r) => r.h1 || r.h2 || r.h3 || r.h4), n),
      hirNi: wilson(count((r) => r.h2 || r.h3 || r.h4), n),
      h34: wilson(count((r) => r.h3 || r.h4), n),
      h1Count: count((r) => r.h1), h2Count: count((r) => r.h2), h3Count: count((r) => r.h3), h4Count: count((r) => r.h4),
      receiptCoverage: pct(count((r) => r.receiptEvents > 0), n),
      hmpoEstimateMs: n ? Math.round(list.reduce((a, r) => a + r.approvalLatencyMs, 0) / n) : null,
      humanTouchThreads: count((r) => r.humanTouches > 0),
    };
  };
  const overall = { delivered: agg(rows), terminal: agg(terminalRows) };
  const roles = {};
  for (const r of rows) {
    roles[r.role] = roles[r.role] ?? [];
    roles[r.role].push(r);
  }
  const byRole = Object.fromEntries(Object.entries(roles).map(([k, v]) => [k, agg(v)]));

  const nearZero = approvals.filter((a) => a.latency_ms != null && Number(a.latency_ms) < 1000 && a.decided_by);
  const approveRate = (() => {
    const decided = approvals.filter((a) => ["approved", "edited", "rejected"].includes(a.status));
    return { decided: decided.length, approve: wilson(decided.filter((a) => a.status === "approved").length, decided.length), editRate: pct(decided.filter((a) => a.status === "edited").length, decided.length) };
  })();
  const anomalies = {
    deliveredWithoutReceipt: rows.filter((r) => r.receiptEvents === 0).length,
    pendingApprovalsOnDelivered: enriched.filter((t) => t.status === "completed" && t.approvals.some((a) => a.status === "pending")).length,
    nearZeroApprovals: nearZero.length,
    unlinkedApprovals: unlinkedApprovals.length,
    failedThreads: terminalRows.filter((r) => r.status === "failed").length,
    pausedThreads: terminalRows.filter((r) => r.status === "paused").length,
    externalActionThreads: terminalRows.filter((r) => r.externalActions > 0).length,
    externalWithoutReceipt: terminalRows.filter((r) => r.externalActions > 0 && r.receiptEvents === 0).length,
  };

  const report = {
    at: new Date().toISOString(),
    spec: "docs/REAL-DEVICE-ACCEPTANCE-SPEC.md@rdas/v3.1",
    workspace: { id: wsRow.id, slug: wsRow.slug, bundle: wsRow.bundle_id },
    window: { since: SINCE, until: new Date().toISOString() },
    filters: { patterns: FILTERS, rawThreads: allThreads.length, fixtureThreads: fixtureThreads.length, rawApprovals: allApprovals.length, fixtureApprovals: fixtureApprovals.length },
    counts: { terminal: terminal.length, delivered: delivered.length, approvals: approvals.length, unlinkedApprovals: unlinkedApprovals.length },
    overall, byRole, approveRate, anomalies, profileWarnings,
    method: {
      deliverable: "terminal thread（completed/failed/paused）；ADR 分母默认 completed",
      h1: "approval.status=approved 且无修改/驳回/接管",
      h2: "approval.status=edited 或 thread 内人类动作",
      h3: "approval.status=rejected 或 thread.paused_by 或 failed+人类动作",
      h4: "c_tickets payload 关联到 thread（返工线索）",
      hmpo: "approval latency proxy（decided_at-created_at）；缺少人工工时登记，覆盖不足时只作下限估计",
    },
    dataQuality: [
      `夹具过滤：threads ${fixtureThreads.length}/${allThreads.length}；approvals ${fixtureApprovals.length}/${allApprovals.length}（近零时长 ${nearZero.length}）`,
      `回执证据覆盖：${(overall.delivered.receiptCoverage ?? 0) * 100}% 的 completed thread 有回执线索；覆盖不足时 ADR 不能等同于“结果已对账”`,
      `未关联审批：${unlinkedApprovals.length}（无法归因到交付件）`,
      `完成但无回执：${anomalies.deliveredWithoutReceipt}`,
      `外部动作线索：${anomalies.externalActionThreads} 个交付链有外部动作事件；其中 ${anomalies.externalWithoutReceipt} 个无回执证据（有则按“无回执宣告完成”红线候选复核）`,
      `橡皮图章信号：近零时长审批 ${nearZero.length} 件`,
    ],
    rows: rows.slice(0, 200),
  };
  writeFileSync(join(OUT_DIR, "autonomy-report.json"), JSON.stringify(report, null, 1));

  const fmtRate = (r) => (r?.p == null ? "n/a" : `${(r.p * 100).toFixed(1)}% (${(r.lo * 100).toFixed(1)}–${(r.hi * 100).toFixed(1)}%, n=${r.n})`);
  const md = [
    "# ADR / HIR 自主交付报告（RDAS v3.1）", "",
    `- 工作区：${wsRow.slug}（${wsRow.id}）｜窗口：${SINCE ?? "全部"} → ${report.window.until}｜生成：${report.at}`,
    `- 原始 threads ${allThreads.length}（夹具 ${fixtureThreads.length}）；原始 approvals ${allApprovals.length}（夹具 ${fixtureApprovals.length}）`,
    `- profile 告警：${profileWarnings.join("；") || "无"}`, "",
    "## 总览（completed 交付件）", "",
    "| 指标 | 值 |", "|---|---|",
    `| 交付件 N | ${overall.delivered.n} |`,
    `| ADR-0 零介入 | ${fmtRate(overall.delivered.adr0)} |`,
    `| **ADR-1 制度性自主交付率** | ${fmtRate(overall.delivered.adr1)} |`,
    `| ADR-2 无接管 | ${fmtRate(overall.delivered.adr2)} |`,
    `| HIR 总介入率 | ${fmtRate(overall.delivered.hir)} |`,
    `| **HIR-NI 非制度性介入率** | ${fmtRate(overall.delivered.hirNi)} |`,
    `| H3+H4 严重介入率 | ${fmtRate(overall.delivered.h34)} |`,
    `| H1/H2/H3/H4 件数 | ${overall.delivered.h1Count}/${overall.delivered.h2Count}/${overall.delivered.h3Count}/${overall.delivered.h4Count} |`,
    `| HMPO 估算（审批延迟代理） | ${overall.delivered.hmpoEstimateMs ?? "n/a"} ms/件 |`,
    `| 回执覆盖率 | ${((overall.delivered.receiptCoverage ?? 0) * 100).toFixed(1)}% |`,
    "", "## 按岗位", "", "| 岗位 | N | ADR-1 | HIR-NI | H3+H4 |", "|---|---:|---|---|---|",
  ];
  for (const [role, m] of Object.entries(byRole).sort((a, b) => b[1].n - a[1].n)) md.push(`| ${role} | ${m.n} | ${fmtRate(m.adr1)} | ${fmtRate(m.hirNi)} | ${fmtRate(m.h34)} |`);
  md.push("", "## 数据质量与反作弊信号", "");
  for (const line of report.dataQuality) md.push(`- ${line}`);
  md.push("", "## 口径与方法", "");
  for (const [k, v] of Object.entries(report.method)) md.push(`- ${k}：${v}`);
  md.push("", "> 注意：本报告是 M1 线上遥测口径（B 级证据）；受控任务集（M2）与离线干预审计（M4）必须另行执行，才能按 A 级结论使用。");
  writeFileSync(join(OUT_DIR, "autonomy-report.md"), `${md.join("\n")}\n`);
  console.log(`[acceptance:autonomy] 交付件 ${overall.delivered.n}；ADR-1=${fmtRate(overall.delivered.adr1)}；HIR-NI=${fmtRate(overall.delivered.hirNi)}；输出 ${OUT_DIR}`);
} finally {
  await client.end().catch(() => undefined);
}
