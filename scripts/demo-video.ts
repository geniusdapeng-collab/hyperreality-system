/**
 * E1V · 视频经理（HyperReality / ai-video Bundle）E2E 演示剧本
 *
 * 与 scripts/demo.ts（酒店底座回归集）同构的六条流程实跑，全视频创作语境：
 *  - 演示工作区 video-studio（种子 scripts/seed-video.ts）；
 *  - 演示身份 MEM-V01 陈主理（owner）；
 *  - 目标口径「本周发布 5 条种草片」；渲染走 G8 审批；评论按 G10a–d 三级分流；
 *  - 夜班围栏快照恒为 ai-video-baseline/v1。
 *
 * 用法：
 *   pnpm exec tsx --env-file=.env scripts/demo-video.ts              —— 一键重置（整库重建+迁移+酒店底座种子+视频种子）→ 实跑 → 断言汇总
 *   pnpm exec tsx --env-file=.env scripts/demo-video.ts --no-reset   —— 跳过重置直接复跑（幂等降级同 demo.ts 口径）
 *
 * 前置：server 运行中（pnpm dev，或沙箱 bash scripts/devbox.sh serve）。
 * 纪律：全程只走公开 tRPC HTTP 接口 + 演示身份 JWT，不旁路直写 DB；断言失败即汇总非零退出。
 */
import { execFileSync } from "node:child_process";

/* ================= 配置与极简 tRPC HTTP 客户端（v11 非批量，无 transformer） ================= */

const PORT = Number(process.env.SERVER_PORT ?? 8787);
const BASE = `http://localhost:${PORT}`;
const WS_SLUG = "video-studio";
const FENCE_SNAPSHOT = "ai-video-baseline/v1";
const NO_RESET = process.argv.includes("--no-reset");

class TrpcError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TrpcError";
  }
}

async function trpc<T = unknown>(
  path: string,
  opts: { input?: unknown; token?: string; method?: "query" | "mutation" } = {},
): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let res: Response;
  if (opts.method === "mutation") {
    res = await fetch(`${BASE}/trpc/${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(opts.input ?? {}),
    });
  } else {
    const qs = opts.input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify(opts.input))}`;
    res = await fetch(`${BASE}/trpc/${path}${qs}`, { headers });
  }
  const body = (await res.json()) as {
    result?: { data?: unknown };
    error?: { message?: string; data?: { code?: string } };
  };
  if (body.error) {
    throw new TrpcError(body.error.data?.code ?? "ERROR", body.error.message ?? "未知 tRPC 错误");
  }
  return body.result?.data as T;
}

/* ================= 剧本输出与断言 ================= */

let passed = 0;
let failed = 0;

function scene(title: string, meta: string): void {
  console.log(`\n══ ${title} ══`);
  console.log(`   ${meta}`);
}
function step(text: string): void {
  console.log(`  → ${text}`);
}
function ok(name: string, detail?: string): void {
  passed += 1;
  console.log(`  ✅ ${name}${detail ? ` —— ${detail}` : ""}`);
}
function bad(name: string, detail?: string): void {
  failed += 1;
  console.error(`  ❌ ${name}${detail ? ` —— ${detail}` : ""}`);
}
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) ok(name, detail);
  else bad(name, detail);
}

/* ================= 返回结构（与 server router 对齐的最小类型） ================= */

interface ApprovalItem {
  approval_id: string;
  event_id: string;
  status: string;
  gesture?: { type?: string; weight?: number } | null;
  snapshot?: { high_risk?: boolean };
}
interface Suggestion {
  key: string; objectType: string; actionCategory: string;
  count: number; windowDays: number; threshold: number; sampleEventIds: string[];
}
interface BizEvent {
  who?: unknown; context?: unknown; object?: unknown; decision?: { action?: string; after?: unknown }; rule_impact?: unknown;
}
interface FenceRuleRow { rule_id: string; name: string; level: string; status: string; version: string; match_spec: { actions?: string[] } }

/* ================= 主流程 ================= */

async function main(): Promise<void> {
  console.log("== 视频经理 HyperReality · E2E 演示剧本（E1V · ai-video Bundle 六条流程实跑）==");
  console.log(`   server: ${BASE} · 工作区: ${WS_SLUG} · 演示身份: MEM-V01 陈主理（owner）`);

  // 0) 前置：server 探活
  try {
    const h = (await fetch(`${BASE}/health`).then((r) => r.json())) as { ok?: boolean };
    if (!h.ok) throw new Error("health not ok");
  } catch {
    console.error("\n❌ server 未运行：请先 `pnpm dev`（或沙箱 `bash scripts/devbox.sh serve`）再执行本剧本");
    process.exit(1);
  }
  ok("server 探活", BASE);

  // 1) 一键重置：整库重建 → 迁移 → 底座种子 → 视频演示种子（append-only 库只能整库重建 L1.1）
  if (NO_RESET) {
    step("跳过重置（--no-reset）：在现有数据上复跑，已派单/已固化项按幂等口径降级");
  } else {
    step("一键重置演示数据（reset.sh --yes：drop schema → migrate → seed）");
    execFileSync("bash", ["scripts/reset.sh", "--yes"], { stdio: "inherit" });
    step("装载视频演示种子（seed-video.ts：25 数码员工 / 基线围栏 / 8 官方技能 / 一企一档 / 演示项目）");
    execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "--env-file=.env", "scripts/seed-video.ts"], { stdio: "inherit" });
    ok("视频工作室数据已生成（video-studio · 星芒好物 · ai-video-baseline/v1）");
  }

  // 2) 演示身份登录（B5 演示 JWT；登录引导例外点解析 workspace）
  const login = await trpc<{ token: string; identity: { name: string; role: string; plan: string } }>(
    "auth.loginAs",
    { method: "mutation", input: { workspaceSlug: WS_SLUG, memberNo: "MEM-V01" } },
  );
  const token = login.token;
  ok("演示身份登录", `${login.identity.name} · ${login.identity.role} · ${login.identity.plan}`);

  /* ---------- PF.2 一句话派遣流（碎片时间 · 人机分工主路径；P1→P2） ---------- */
  scene("PF.2 一句话派遣流", "主理人/运营 · 碎片时间 · 派遣框 → 意图路由 → 线程 → 围栏内自主交付");
  const threadsBefore = await trpc<Array<{ id: string }>>("threads.list", { token });
  const clarify = await trpc<{ kind: string; question?: string; via?: string }>(
    "threads.dispatch",
    { token, method: "mutation", input: { title: "搞一下" } },
  );
  check("含糊指令 → 反问澄清（F3.2）", clarify.kind === "clarify" && typeof clarify.question === "string", clarify.question);
  const threadsAfter = await trpc<Array<{ id: string }>>("threads.list", { token });
  check("反问不建任务（零副作用）", threadsAfter.length === threadsBefore.length);
  const goal = "本周发布 5 条种草片，完播率 ≥35%：先做同类目爆款选题拆解";
  const t0 = Date.now();
  const disp = await trpc<{ kind: string; mode?: string; via?: string; threadId?: string }>(
    "threads.dispatch",
    { token, method: "mutation", input: { title: goal } },
  );
  const dispatchMs = Date.now() - t0;
  check(
    "≤3s 生成任务线程（F3.1 关键口径）",
    disp.kind === "routed" && typeof disp.threadId === "string" && dispatchMs <= 3000,
    `${disp.threadId} · mode=${disp.mode} · 建档 ${dispatchMs}ms`,
  );
  const run = await trpc<{ status: string; stepsDone: number; stepsTotal: number }>(
    "threads.run",
    { token, method: "mutation", input: { threadId: disp.threadId, goal, presetKey: "trend-researcher" } },
  );
  check(
    "Quest 自主执行：每步过围栏瀑布（auto 放行/review 挂起/block 熔断）",
    run.status === "completed" && run.stepsDone === run.stepsTotal,
    `${run.stepsDone}/${run.stepsTotal} 步 completed`,
  );
  const questEvents = await trpc<BizEvent[]>("threads.events", { token, input: { threadId: disp.threadId } });
  const fiveTupleOk = questEvents.every((e) => e.who && e.context && e.object && e.decision && Array.isArray(e.rule_impact));
  check("全程留痕 100%（G8 五元齐备 · 无回执不宣称完成 E3.7）", questEvents.length >= 3 && fiveTupleOk, `${questEvents.length} 条事件`);

  /* ---------- PF.4 夜班自治全日闭环流（王牌场景；P1→P9→P3） ---------- */
  scene("PF.4 夜班自治全日闭环流", "主理人 · 18:00 → 次日 08:00 · 候选清单 → 人类确认 → 自治运行 → 一键暂停 → 交接班");
  const cands = await trpc<Array<{ id: string; name: string; estCredits: number; fenceSummary: string }>>(
    "nightShift.candidates",
    { token },
  );
  check(
    "18:00 候选清单（F4.1：预估积分谷时价 + 命中围栏摘要）",
    cands.length >= 1,
    cands.map((c) => `${c.name} ≈${c.estCredits} 币（${c.fenceSummary}）`).join("；"),
  );
  // 开启夜班：默认今日班次；复跑降级——今日班次已收官则顺移至次日，已在运行则沿用（状态机 F4.8：非法迁移拒绝，不硬闯）
  let nightRunId = "";
  let nightStartedAt: string | null = null;
  for (let offset = 0; offset <= 7 && !nightRunId; offset += 1) {
    const runDate = new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    try {
      const st = await trpc<{ runId: string; status: string }>(
        "nightShift.start",
        { token, method: "mutation", input: { runDate, candidateIds: cands.map((c) => c.id) } },
      );
      nightRunId = st.runId;
      ok("人确认「开启夜班」（人类命令 · 不经模型轮次 F4.1）", `班次 ${st.runId} → running`);
    } catch (err) {
      const curNow = await trpc<{ configured: boolean; run?: { id: string; status: string; startedAt: string | null } }>(
        "nightShift.current",
        { token },
      );
      if (err instanceof TrpcError && /非法迁移/.test(err.message)) {
        if (curNow.configured && curNow.run?.id === `nr-${runDate}` && curNow.run.status === "running") {
          nightRunId = curNow.run.id;
          nightStartedAt = curNow.run.startedAt;
          ok("复跑降级：该日夜班已在运行，沿用现有班次", nightRunId);
          break;
        }
        if (offset < 7) continue; // 该日班次已收官，顺移至次日
      }
      throw err;
    }
  }
  const curNight = await trpc<{ configured: boolean; run?: { id: string; status: string; fenceSnapshot: string | null; startedAt: string | null } }>(
    "nightShift.current",
    { token },
  );
  check(
    "22:00 围栏快照写入 = ai-video-baseline/v1（F2.6：夜班动作 100% 过围栏 L4.1）",
    curNight.configured && curNight.run?.fenceSnapshot === FENCE_SNAPSHOT,
    `快照 ${curNight.run?.fenceSnapshot}`,
  );
  nightStartedAt = nightStartedAt ?? curNight.run?.startedAt ?? null;
  const note = await trpc<{ eventId: string }>(
    "nightShift.note",
    { token, method: "mutation", input: { text: "夜班注意：抖音评论区 2 分以下差评优先起草回复，明早我审" } },
  );
  check("班组留言 = 五元事件留痕（P9E6/G8）", typeof note.eventId === "string", note.eventId);
  const pause = await trpc<{ elapsedMs: number; withinSla: boolean; pausedThreads: number }>(
    "nightShift.pause",
    { token, method: "mutation", input: { runId: nightRunId } },
  );
  check("〔任意时刻〕一键暂停 ≤60s 全端生效（G5 计时留痕）", pause.withinSla, `实测 ${pause.elapsedMs}ms · 挂起线程 ${pause.pausedThreads}`);
  const pausedNow = await trpc<{ configured: boolean; run?: { status: string } }>("nightShift.current", { token });
  check("状态机 → paused（F4.8 合法迁移）", pausedNow.configured && pausedNow.run?.status === "paused");
  await trpc("nightShift.resume", { token, method: "mutation", input: { runId: nightRunId } });
  const resumedNow = await trpc<{ configured: boolean; run?: { status: string } }>("nightShift.current", { token });
  check("恢复 = 断点续跑（E4.2）", resumedNow.configured && resumedNow.run?.status === "running");
  const pkg = await trpc<{ stats: { done: number; pending: number; need_human: number }; truncated: boolean }>(
    "nightShift.deliver",
    {
      token, method: "mutation",
      input: {
        runId: nightRunId,
        window: { from: nightStartedAt ?? new Date(Date.now() - 15 * 60_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString() },
      },
    },
  );
  check(
    "08:00 早八点战报投递（F4.4 三段投影 · 无回执标未核实 E3.7）",
    pkg.stats !== null && typeof pkg.stats.done === "number",
    `✓${pkg.stats.done} ◆${pkg.stats.pending} ▲${pkg.stats.need_human}`,
  );
  const pkgNow = await trpc<{ configured: boolean; run?: { status: string } }>("nightShift.current", { token });
  check("状态机 → package_generated → 清晨审批接 PF.1", pkgNow.configured && pkgNow.run?.status === "package_generated");

  /* ---------- PF.1 经营者晨间审批流（移动端正午前 5 分钟；P3→P4→P1） ---------- */
  scene("PF.1 晨间审批流", "主理人 · 08:00–10:00 · 交接班消息 → 批量采纳 → 逐条三手势 → 需介入决策链路");
  const cur = await trpc<
    | { configured: false }
    | { configured: true; run: { id: string; status: string; fenceSnapshot: string | null; startedAt: string | null; stats: { done: number; pending: number; need_human: number } | null } }
  >("nightShift.current", { token });
  check(
    "08:00 交接班消息卡：昨夜班次决策包已投递（F4.4）",
    cur.configured && cur.run.status === "package_generated" && cur.run.stats !== null,
    cur.configured ? `班次 ${cur.run.id} · ${cur.run.status}` : "未配置",
  );
  if (cur.configured && cur.run.stats) {
    const s = cur.run.stats;
    ok("三栏投影（已完成/待审批/需介入）", `✓${s.done} ◆${s.pending} ▲${s.need_human} · 围栏快照 ${cur.run.fenceSnapshot}`);
  }
  const pend = await trpc<ApprovalItem[]>("approvals.list", { token, input: { status: "pending" } });
  if (pend.length === 0) {
    ok("今日待审已清空（无 pending，复跑幂等态）");
  } else {
    step(`统一队列待审 ${pend.length} 条（F5.1 分级：高危双人/越围栏必审/低风险逐步审）`);
    const lowRisk = pend.filter((p) => p.snapshot?.high_risk !== true);
    if (lowRisk.length > 0) {
      const batch = await trpc<{ approved: string[]; skipped: Array<{ id: string; reason: string }> }>(
        "approvals.batchApprove",
        { token, method: "mutation", input: { approvalIds: lowRisk.map((p) => p.approval_id) } },
      );
      check(
        "批量采纳低风险（仅 auto 级 · 二次确认 · 逐条留痕 G6）",
        batch.approved.length === lowRisk.length,
        `采纳 ${batch.approved.length} 条${batch.skipped.length ? ` · 跳过 ${batch.skipped.length}（${batch.skipped[0]?.reason}）` : ""}`,
      );
    }
    const highRisk = pend.filter((p) => p.snapshot?.high_risk === true);
    for (const h of highRisk) {
      step(`高危项 ${h.approval_id} 不可批量（F5.4）→ 留待逐条三手势（PF.5 演示）`);
    }
  }
  const decided = await trpc<ApprovalItem[]>("approvals.list", { token, input: { status: "approved" } });
  if (decided.length > 0) {
    check(
      "手势写回事件库 · 权重 1/2/3 校准组织记忆（F5.5/F1.7）",
      decided.some((d) => typeof d.gesture?.weight === "number"),
      `${decided.filter((d) => d.gesture).length} 条已决含手势权重`,
    );
  } else {
    ok("复跑降级：尚无已决审批，手势权重断言以 PF.5 提案审批为准");
  }

  /* ---------- PF.3 异常巡检派单流（Agent 主动找人 → 一键闭环；P1→P2） ---------- */
  scene("PF.3 异常巡检派单流", "主理人/运营 · 平台巡检 → 分级推送 → 一键派单 → 处理回链");
  const scan = await trpc<{
    ok: boolean; totalChecks: number; okCount: number;
    anomalies: Array<{ checkId: string; severity: string; summary: string; eventId?: string; deduped?: boolean }>;
    notifyEventIds: string[];
  }>("inspection.run", { token, method: "mutation" });
  check("定时只读巡检（L9.1 工具集裁剪前置断言）", scan.ok, `${scan.totalChecks} 检项 · 正常 ${scan.okCount} · 异常 ${scan.anomalies.length}`);
  const fresh = scan.anomalies.filter((a) => !a.deduped && typeof a.eventId === "string");
  if (fresh.length === 0) {
    ok("本工作室平台巡检无新异常（视频语境等价：发布/评论/额度检项全绿），派单断言降级跳过");
  } else {
    check(
      "发现异常即写事件·高/中/低分级（F9.2；失败不静默 L9.2）",
      fresh.length >= 1,
      fresh.map((a) => `[${a.severity}] ${a.summary}`).join("；"),
    );
    const target = fresh.find((a) => a.severity === "high") ?? fresh[0]!;
    const dsp = await trpc<{ threadId: string; eventId: string; deduped: boolean }>(
      "inspection.dispatch",
      { token, method: "mutation", input: { anomalyEventId: target.eventId, presetKey: "comment-operator" } },
    );
    check("一键派单：以异常事件 spawn 评论分流 Agent 建 P2 线程（F9.3）", !dsp.deduped && dsp.threadId.length > 0, `线程 ${dsp.threadId}`);
    const dup = await trpc<{ threadId: string; deduped: boolean }>(
      "inspection.dispatch",
      { token, method: "mutation", input: { anomalyEventId: target.eventId, presetKey: "comment-operator" } },
    );
    check("同事件重复派单幂等去重（L9.3）", dup.deduped && dup.threadId === dsp.threadId);
    const rsv = await trpc<{ eventId: string; deduped: boolean }>(
      "inspection.resolve",
      { token, method: "mutation", input: { anomalyEventId: target.eventId, threadId: dsp.threadId, ok: true, note: "夜班班组已起草评论回复，待清晨审批" } },
    );
    check("处理结果回链异常事件（F9.3；失败升级一级转需介入 E9.3）", typeof rsv.eventId === "string" && !rsv.deduped, rsv.eventId);
  }

  /* ---------- PF.5 围栏规则演进流（渲染审批 + 评论三级分流；P5） ---------- */
  scene("PF.5 围栏规则演进流", "主理人/MCN 管理员 · 策略变化时 · 自然语言 → DSL 草稿 → dry-run → 审批 → 激活");
  const rule = {
    ruleId: "G11", name: "渲染提交单批次 ≤3 镜", level: "review" as const,
    objectTypes: ["render_quota"], actions: ["render.submit"], when: "after.shots > 3",
  };
  step("自然语言输入：「单批次渲染提交超过 3 镜必须审批」（F2.8）→ 转写 DSL 草稿 + 结构化预览");
  const dr = await trpc<{ dryRunId: string; report: { replayed: number; impact: string; wouldBlock: string[] } }>(
    "fence.dryRun",
    { token, method: "mutation", input: rule },
  );
  check(
    "dry-run 回放最近 10 条历史动作（F2.5：若当时生效将如何）",
    dr.report.replayed >= 1 && dr.report.replayed <= 10,
    `${dr.report.impact}${dr.report.wouldBlock.length ? ` · 拦截 ${dr.report.wouldBlock.join("、")}` : ""}`,
  );
  const rulesBefore = await trpc<FenceRuleRow[]>("fence.rules", { token });
  if (rulesBefore.some((r) => r.rule_id === "G11" && r.status === "active")) {
    ok("复跑降级：G11 已在上轮审批激活，L2.4「未确认不得激活」以首轮（重置后）运行为准");
  } else {
    check("dry-run 未确认不得激活（L2.4）", !rulesBefore.some((r) => r.rule_id === "G11" && r.status === "active"));
  }
  const propose = await trpc<{ proposed: boolean; eventId: string }>(
    "fence.confirmDryRun",
    { token, method: "mutation", input: { dryRunId: dr.dryRunId, rule } },
  );
  check("影响面确认 → 变更审批（F2.4 生命周期 draft→pending_approval）", propose.proposed, `提案事件 ${propose.eventId}`);
  const pend5 = await trpc<ApprovalItem[]>("approvals.list", { token, input: { status: "pending" } });
  const fenceCard = pend5.find((p) => p.event_id === propose.eventId);
  check("提案进 P4 决断队列（E1 接线 · 高危不可批量 F5.4）", !!fenceCard && fenceCard.snapshot?.high_risk === true, fenceCard?.approval_id);
  if (fenceCard) {
    const dec = await trpc<{ status: string; deduped: boolean; gestureEventId?: string }>(
      "approvals.decide",
      { token, method: "mutation", input: { approvalId: fenceCard.approval_id, gesture: "approve" } },
    );
    check("三手势 · 采纳（F5.3 写回事件库）", dec.status === "approved" && !dec.deduped, `手势事件 ${dec.gestureEventId}`);
  }
  const rulesAfter = await trpc<FenceRuleRow[]>("fence.rules", { token });
  const g11 = rulesAfter.find((r) => r.rule_id === "G11" && r.status === "active");
  check("审批通过 → 新版本激活（E1 接线 activateRuleVersion；基线只可加严 F2.3/L2.1）", !!g11, g11 ? `G11 ${g11.version} active` : "未激活");
  const versions = await trpc<Array<{ version: string; status: string }>>("fence.versions", { token });
  check("版本历史留痕（active/rolled_back/出厂基线 🔒，旧版本可回滚 F2.4）", versions.some((v) => v.version === "v-next" && v.status === "active"));

  // 渲染审批 / 评论三级分流：基线围栏口径断言（视频语境等价于酒店「调价必审/差评必审」）
  const active = rulesAfter.filter((r) => r.status === "active");
  const g8 = active.find((r) => r.rule_id === "G8");
  check(
    "渲染审批：G8 render.submit 必审（review 级）",
    !!g8 && g8.level === "review" && (g8.match_spec.actions ?? []).includes("render.submit"),
    g8 ? `G8 ${g8.name} · ${g8.level}` : "G8 缺失",
  );
  const g10 = active.filter((r) => /^G10[a-d]$/.test(r.rule_id) && (r.match_spec.actions ?? []).includes("comment.reply"));
  check(
    "评论三级分流：G10a–d 覆盖 comment.reply（auto/review/block 全档）",
    g10.length === 4 && g10.some((r) => r.level === "auto") && g10.some((r) => r.level === "review") && g10.some((r) => r.level === "block"),
    g10.map((r) => `${r.rule_id}:${r.level}`).join(" / "),
  );

  /* ---------- PF.6 技能沉淀复利流（资产飞轮；P6→P2） ---------- */
  scene("PF.6 技能沉淀复利流", "运营/剪辑/主理人 · 工作时段 · 事件流 → 高频检测 → 建议固化 → 人确认 → 安装生效");
  const sugg = await trpc<Suggestion[]>("skills.awareness.suggestions", { token });
  if (sugg.length === 0) {
    ok("复跑降级：事件样本量未达高频阈值（≥3 次/周 F8.4），建议固化断言跳过——官方 8 技能已随种子安装");
  } else {
    check(
      "意识系统高频相似任务检测（聚类 + 频次 ≥3 次/周 F8.4）",
      sugg.length >= 1,
      sugg.map((s) => `${s.actionCategory}×${s.count}（阈值 ${s.threshold}）`).join("；"),
    );
    const pick1 = sugg[0]!;
    step(`P6「建议固化」卡片：${pick1.key}（确认前不产生任何自动化 L4.4）`);
    const c1 = await trpc<{ artifactId: string; eventId: string }>(
      "skills.awareness.confirm",
      { token, method: "mutation", input: { suggestion: pick1, target: "trigger" } },
    );
    check("人一键确认 → 生成定时触发器（F4.7 · 受围栏管辖）", c1.artifactId.startsWith("trg-auto-"), `${c1.artifactId} · 留痕 ${c1.eventId}`);
    const suggAfter = await trpc<Suggestion[]>("skills.awareness.suggestions", { token });
    check("确认后同类不再重复建议", !suggAfter.some((s) => s.key === pick1.key));
    const pick2 = suggAfter[0];
    if (pick2) {
      const c2 = await trpc<{ artifactId: string; eventId: string }>(
        "skills.awareness.confirm",
        { token, method: "mutation", input: { suggestion: pick2, target: "skill" } },
      );
      check("另一条建议 → 技能草稿（F8.3 三要素向导生成物）", typeof c2.artifactId === "string", c2.artifactId);
      const drySkill = await trpc<{ report?: unknown }>(
        "skills.dryRun",
        { token, method: "mutation", input: { skillId: c2.artifactId } },
      );
      check("技能生效前 dry-run 预览（F8.3/F2.5 同口径回放）", drySkill !== null && typeof drySkill === "object");
      const inst = await trpc<{ installed: boolean; bindings: string[] }>(
        "skills.install",
        { token, method: "mutation", input: { skillId: c2.artifactId } },
      );
      check("安装到工作区 · 安装即绑定（F8.2；调用照常过围栏瀑布 L8.3）", inst.installed, `围栏绑定 ${inst.bindings.length} 条`);
    } else {
      ok("复跑降级：全部建议均已固化，技能草稿断言跳过");
    }
  }
  const usage = await trpc<Record<string, { calls30: number; adoptionRate: number | null }>>("skills.usage", { token });
  check(
    "使用看板：采纳率/驳回模式回流（F8.5 → 迭代新版本）",
    Object.keys(usage).length >= 1,
    `${Object.keys(usage).length} 个技能投影`,
  );

  /* ---------- 汇总 ---------- */
  console.log(`\n══ 演示剧本收官：断言 ${passed} 通过 / ${failed} 失败 ══`);
  if (failed > 0) {
    console.error("❌ E1V 演示剧本未全绿（详见上方 ❌ 项）");
    process.exit(1);
  }
  console.log("✅ 六条流程全部实跑通过（数据可经本脚本一键重置复现）");
}

main().catch((err) => {
  console.error(`\n❌ 演示剧本异常中断：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
