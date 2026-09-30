/**
 * scripts/verify-chain.ts · 事件库哈希链完整性验证（M4 增强版，审计 #32 配套工具）
 *
 * 按 workspace 分段逐段验证，六项检查：
 *  ① 哈希链接龙：prev_hash 严格接龙（首条 = GENESIS），hash 与 canonicalJson 重算一致
 *     —— canonicalJson 为本文件独立实现用于交叉验证（不复用写入方
 *     @workloom/base/workdata 模块：写入方算法漂移时，本验证器按冻结口径独立复算仍能暴露）
 *  ② seq 连续性：按 workspace 分段检查空洞——ON CONFLICT 消耗的 nextval 小空洞容忍计数，
 *     连续空洞 >500 视为异常（疑似恶意删段/删尾）；≤500 计入容忍（ON CONFLICT 与测试烧号）
 *  ③ event_id 派生一致性（P0-3 命名空间）：E-<n> 必须落在全局序列 biz_events_eid_seq
 *     已分配区间 [start_value, last_value] 内，且同 workspace 内 n 随行 seq 单调递增
 *     （写入方持 workspace 链锁后才 nextval，分配序与链序一致）；
 *     种子/回放通道 event_id 必须在 E-SEED-/E-RPL- 前缀白名单内，其余形态一律异常。
 *     口径说明：契约规定 event_id 由全局序列分配（E-<eid_seq>），与 biz_events.seq
 *     表自增列不同源——故「n = 行 seq」不成立，本检查校验的是分配序列一致性。
 *  ④ payload 逐条复跑 zod（safeParseBusinessEvent；回放前缀 ID 经 safeParseReplayAwareEvent
 *     的占位缝过同一 schema，校验强度不打折）
 *  ⑤ created_at 单调性：同一 workspace 分段内按 seq 序必须非递减
 *  ⑥ 结构化报告：每 workspace 段输出 条数/链完整/异常明细，末尾汇总 JSON；
 *     退出码 0 = 全库通过，非零 = 任一段存在异常
 *
 * 用法：pnpm tsx --env-file=.env scripts/verify-chain.ts
 */
import pg from "pg";
import { createHash } from "node:crypto";
import { safeParseBusinessEvent } from "@workloom/shared";
import { isReplayEventId, safeParseReplayAwareEvent } from "@workloom/base/workdata";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://postgres:workloom@localhost:5432/workloom";

/** seq 连续空洞容忍阈值：超过即视为异常（ON CONFLICT 消耗的 nextval 空洞通常零星出现） */
const SEQ_GAP_ANOMALY_THRESHOLD = 500; // ON CONFLICT nextval 消耗与测试烧号可达数百，>500 连续空洞才疑似恶意删段

/**
 * MC-210：摘要口径（`--summary` / `CHAIN_REPORT=summary`）——stdout 体积与账本规模解耦。
 * 账本成批异常时（实测 10 万级事件 / 近 50 万处异常）逐条异常明细会把结构化报告撑到 160MB，
 * 调用方（release-gate 的 execSync）会以 ENOBUFS 失败，把「链断了」伪装成工具故障。
 * 摘要口径下：每段一行汇总，JSON 报告只带异常类型直方图与前 N 条样本；全量明细仍可
 * 用 `pnpm db:verify-chain`（不带 --summary）在部署机复现。
 */
const SUMMARY_MODE = process.argv.includes("--summary") || process.env.CHAIN_REPORT === "summary";
const ISSUE_SAMPLE_LIMIT = Math.max(0, Number(process.env.CHAIN_REPORT_SAMPLE ?? 20));

const sha256 = (s: string) => createHash("sha256").update(s, "utf-8").digest("hex");

/**
 * canonicalJson 独立实现用于交叉验证（M4-⑤）：
 * 故意不复用写入方 packages/base/workdata/events.ts 的 canonicalJson——
 * 若写入方序列化口径漂移（键序/undefined 处理/转义变化），本实现仍按冻结规格
 * （键名升序、丢弃 undefined、JSON 转义）独立复算，漂移会以「hash 重算不符」暴露。
 */
function canonicalJsonIndependent(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJsonIndependent).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>)
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .sort(); // 规格：键名按字典序升序
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${canonicalJsonIndependent((value as Record<string, unknown>)[k])}`,
  );
  return `{${parts.join(",")}}`;
}

interface Issue {
  kind:
    | "CHAIN_BREAK" | "HASH_MISMATCH" | "SEQ_GAP_ANOMALY"
    | "EVENT_ID_SEQ_MISMATCH" | "EVENT_ID_NAMESPACE" | "PAYLOAD_SCHEMA" | "CREATED_AT_REGRESSION";
  event_id?: string;
  detail: string;
}
interface WsReport {
  workspace_id: string;
  tenant_id: string;
  events: number;
  chain_ok: boolean;
  /** 本段异常总数（issues 可能是摘要样本，MC-210） */
  issues_total: number;
  /** 本段异常类型精确计数（摘要口径下 issues 只有样本，直方图仍全量） */
  issue_kinds?: Array<{ kind: string; count: number }>;
  /** ON CONFLICT 消耗的 nextval 小空洞（容忍，仅计数） */
  tolerated_seq_gaps: number;
  legacy_event_ids: number;
  tolerated_backfills: number;
  issues: Issue[];
}

interface EventRow {
  event_id: string;
  seq: string;
  payload: unknown;
  prev_hash: string;
  hash: string;
  created_at: string;
}

async function main(): Promise<void> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  const report: WsReport[] = [];
  try {
    // 分段粒度 (tenant_id, workspace_id)：与 append_event_insert 的链校验粒度一致
    // （同一 workspace 下不同 tenant 各成其链——如测试用随机 tenant 共享 ws-t26）
    const ws = await client.query<{ tenant_id: string; workspace_id: string }>(
      `SELECT DISTINCT tenant_id, workspace_id FROM biz_events ORDER BY 1, 2`,
    );
    // ③ 的判定基准：全局事件号序列的已分配区间（P0-3）
    const seqStartRow = await client.query<{ start_value: string }>(
      `SELECT start_value::text FROM pg_sequences WHERE sequencename = 'biz_events_eid_seq'`,
    );
    const seqCurRow = await client.query<{ last_value: string; is_called: boolean }>(
      `SELECT last_value::text, is_called FROM biz_events_eid_seq`,
    );
    const eidStart = BigInt(seqStartRow.rows[0]?.start_value ?? "1");
    // is_called=false 时 last_value 是「下一个待分配值」，已分配上界要减一
    const eidLast = seqCurRow.rows[0]
      ? BigInt(seqCurRow.rows[0].last_value) - (seqCurRow.rows[0].is_called ? 0n : 1n)
      : 0n;
    for (const { tenant_id, workspace_id } of ws.rows) {
      const r = await client.query<EventRow>(
        // 注意：不得写 seq::text——输出列名仍为 seq 时 ORDER BY seq 会按文本序排（1,10,100,11…）。
        // node-pg 的 int8 默认即以字符串返回，直接选原列即可保数值序
        `SELECT event_id, seq, payload, prev_hash, hash, created_at
         FROM biz_events WHERE tenant_id=$1 AND workspace_id=$2 ORDER BY seq`,
        [tenant_id, workspace_id],
      );
      const issues: Issue[] = [];
      let issueTotal = 0;
      const issueKinds = new Map<string, number>();
      /** 摘要口径下 issues 只留样本，计数与直方图始终全量（MC-210） */
      const pushIssue = (issue: Issue): void => {
        issueTotal += 1;
        issueKinds.set(issue.kind, (issueKinds.get(issue.kind) ?? 0) + 1);
        if (!SUMMARY_MODE || issues.length < ISSUE_SAMPLE_LIMIT) issues.push(issue);
      };
      let prevHash = "GENESIS";
      let prevSeq: bigint | null = null;
      let prevEidN: bigint | null = null;
        let legacyCount = 0;
        let toleratedBackfills = 0;
      let prevCreatedAt: Date | null = null;
      let toleratedGaps = 0;

      for (const row of r.rows) {
        const seq = BigInt(row.seq);

        // ① 哈希链接龙 + 独立实现重算（M4-⑤ 交叉验证）
        if (row.prev_hash !== prevHash) {
          pushIssue({ kind: "CHAIN_BREAK", event_id: row.event_id,
            detail: `prev_hash 断链：期望 ${prevHash.slice(0, 12)}… 实存 ${row.prev_hash.slice(0, 12)}…` });
        }
        const expect = sha256(prevHash + canonicalJsonIndependent(row.payload));
        if (row.hash !== expect) {
          pushIssue({ kind: "HASH_MISMATCH", event_id: row.event_id,
            detail: "hash 重算不符（payload 篡改或 canonicalJson 口径漂移）" });
        }
        prevHash = row.hash;

        // ② seq 连续性：空洞容忍（ON CONFLICT 消耗 nextval / 测试烧号），>500 连续空洞异常
        if (prevSeq !== null) {
          const gap = seq - prevSeq - 1n;
          if (gap > 0n) {
            if (gap > BigInt(SEQ_GAP_ANOMALY_THRESHOLD)) {
              // 跨工作区共享序列消耗甄别（D31：填充率 ≥50% 即他区正常消耗+ON CONFLICT 烧号，不足半数才疑似删段）
              const elsewhere = await client.query<{ n: string }>(
                `SELECT count(*) AS n FROM biz_events WHERE seq > $1 AND seq < $2`,
                [prevSeq.toString(), seq.toString()],
              );
              if (Number(elsewhere.rows[0]?.n ?? 0) >= Number(gap) * 0.5) {
                toleratedGaps += Number(gap);
              } else {
                pushIssue({ kind: "SEQ_GAP_ANOMALY", event_id: row.event_id,
                  detail: `seq ${prevSeq} → ${seq} 连续空洞 ${gap} 条（>${SEQ_GAP_ANOMALY_THRESHOLD}，疑似恶意删段）` });
              }
            } else {
              toleratedGaps += Number(gap);
            }
          }
        }
        prevSeq = seq;

        // ③ event_id 派生一致性 / 命名空间白名单（P0-3）：
        // E-<n> 由全局序列 biz_events_eid_seq 分配（与行 seq 表自增列不同源）——
        // n 必须落在已分配区间 [eidStart, eidLast]，且同 workspace 内随行 seq 单调递增
        // （写入方持链锁后 nextval，分配序与链序一致；倒序 = 手造 ID 嫌疑）
        const m = /^E-(\d+)$/.exec(row.event_id);
        if (m) {
          const n = BigInt(m[1]!);
          // 存量赦免（append-only 历史不可改写）：n < eidStart 的是全局序列上线前的
          // 旧分配方案（MAX(seq)+1 派生），仅计数为 legacy 不报异常；
          // n >= eidStart 的必须落在已分配区间且单调递增（新方案严格口径）
          if (n < eidStart) {
            legacyCount += 1;
          } else {
            if (n > eidLast) {
              pushIssue({ kind: "EVENT_ID_SEQ_MISMATCH", event_id: row.event_id,
                detail: `event_id 数字段 ${n} 超出全局序列已分配上界 ${eidLast}（P0-3：疑似绕过序列分配）` });
            }
            if (prevEidN !== null && prevEidN >= eidStart && n <= prevEidN) {
              pushIssue({ kind: "EVENT_ID_SEQ_MISMATCH", event_id: row.event_id,
                detail: `event_id 数字段 ${n} 未随 seq 单调递增（前序 ${prevEidN}，分配序与链序不一致）` });
            }
          }
          prevEidN = n;
        } else if (!isReplayEventId(row.event_id)) {
          pushIssue({ kind: "EVENT_ID_NAMESPACE", event_id: row.event_id,
            detail: "event_id 既非 E-<digits> 序列形态，也不在 E-SEED-/E-RPL- 回放白名单内" });
        }

        // ④ payload 逐条复跑 zod（回放前缀 ID 经占位缝过同一附录 E schema）
        const checked = isReplayEventId(row.event_id)
          ? safeParseReplayAwareEvent(row.payload as never)
          : safeParseBusinessEvent(row.payload);
        if (!checked.success) {
          pushIssue({ kind: "PAYLOAD_SCHEMA", event_id: row.event_id,
            detail: `附录 E 校验失败：${checked.error.issues[0]?.message ?? "unknown"}` });
        }

        // ⑤ created_at 单调性（同 workspace 分段内按 seq 非递减）：
        // 种子/回放通道是有意的历史补录（payload.context.time 与 created_at 一致）——
        // 回退行若属「诚实补录」则仅计数，created_at 与 context.time 不符的乱序才报异常
        const createdAt = new Date(row.created_at);
        if (prevCreatedAt !== null && createdAt.getTime() < prevCreatedAt.getTime()) {
          const ctxTime = (row.payload as { context?: { time?: string } } | null)?.context?.time;
          const honestBackfill = isReplayEventId(row.event_id)
            || (ctxTime != null && Math.abs(new Date(ctxTime).getTime() - createdAt.getTime()) < 5 * 60_000);
          if (honestBackfill) {
            toleratedBackfills += 1;
          } else {
            pushIssue({ kind: "CREATED_AT_REGRESSION", event_id: row.event_id,
              detail: `created_at 回退且非诚实补录：${prevCreatedAt.toISOString()} → ${createdAt.toISOString()}` });
          }
        }
        prevCreatedAt = createdAt;
      }

      report.push({
        workspace_id,
        tenant_id,
        events: r.rows.length,
        chain_ok: issueTotal === 0,
        issues_total: issueTotal,
        issue_kinds: [...issueKinds.entries()].sort((a, b) => b[1] - a[1]).map(([kind, count]) => ({ kind, count })),
        tolerated_seq_gaps: toleratedGaps,
        legacy_event_ids: legacyCount, // 全局序列上线前的旧分配方案存量（赦免，仅计数）
        tolerated_backfills: toleratedBackfills, // 种子/回放诚实历史补录（仅计数）
        issues,
      });
      const mark = issueTotal === 0 ? "✓" : "✗";
      const gapNote = toleratedGaps > 0 ? ` · 容忍 seq 小空洞 ${toleratedGaps}（ON CONFLICT 消耗）` : "";
      console.log(`${mark} [${tenant_id}/${workspace_id}] ${r.rows.length} 条${issueTotal === 0 ? "，六项检查全过" : `（${issueTotal} 处异常）`}${gapNote}`);
      for (const iss of issues) {
        console.error(`  ✗ ${iss.kind}${iss.event_id ? ` ${iss.event_id}` : ""}: ${iss.detail}`);
      }
      if (SUMMARY_MODE && issueTotal > issues.length) {
        console.error(`  … 另有 ${issueTotal - issues.length} 处同类/他类异常未逐条展开（摘要口径；完整明细：pnpm db:verify-chain）`);
      }
    }
  } finally {
    await client.end();
  }

  // ⑥ 结构化报告（每 workspace 段：条数/链完整/异常明细）+ 汇总
  //   摘要口径（MC-210）只输出直方图与样本，报告体积与异常条数解耦
  const totalEvents = report.reduce((n, w) => n + w.events, 0);
  const totalIssues = report.reduce((n, w) => n + w.issues_total, 0);
  const kindTotals = new Map<string, number>();
  for (const segment of report) {
    // 直方图用分段精确计数（摘要口径下 issues 只是样本，不能拿样本当分布）
    const perSegment = segment.issue_kinds?.length
      ? segment.issue_kinds
      : segment.issues.reduce<Array<{ kind: string; count: number }>>((acc, item) => {
        const found = acc.find((entry) => entry.kind === item.kind);
        if (found) found.count += 1;
        else acc.push({ kind: item.kind, count: 1 });
        return acc;
      }, []);
    for (const { kind, count } of perSegment) kindTotals.set(kind, (kindTotals.get(kind) ?? 0) + count);
  }
  const issueKinds = [...kindTotals.entries()].sort((a, b) => b[1] - a[1]).map(([kind, count]) => ({ kind, count }));
  const summary = SUMMARY_MODE
    ? {
      ok: totalIssues === 0,
      mode: "summary",
      workspaces: report.length,
      total_events: totalEvents,
      total_issues: totalIssues,
      issue_kinds: issueKinds,
      segments: report.map((segment) => ({
        workspace_id: segment.workspace_id,
        tenant_id: segment.tenant_id,
        events: segment.events,
        chain_ok: segment.chain_ok,
        issues_total: segment.issues_total,
        issue_kinds: segment.issue_kinds,
        issues_sample: segment.issues.slice(0, ISSUE_SAMPLE_LIMIT),
      })),
    }
    : {
      ok: totalIssues === 0,
      workspaces: report.length,
      total_events: totalEvents,
      total_issues: totalIssues,
      issue_kinds: issueKinds,
      segments: report,
    };
  console.log("\n===== 结构化验证报告（JSON） =====");
  // 摘要口径输出单行 JSON（便于调用方解析，且避免 pretty 放大体积）
  console.log(SUMMARY_MODE ? JSON.stringify(summary) : JSON.stringify(summary, null, 2));

  if (totalIssues > 0) {
    console.error(`\n❌ 验证失败：共 ${totalIssues} 处异常（${report.length} 段 / ${totalEvents} 条事件）`);
    process.exit(1);
  }
  console.log(`\n✅ 全库验证通过：${report.length} 个 workspace 段 / ${totalEvents} 条事件，六项检查全绿`);
}

await main();
