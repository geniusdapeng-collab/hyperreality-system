/**
 * scripts/release-gate.ts · 发布前核心功能链路校验门禁（强制红线）
 *
 * 依据《凡是使用到 WorkLoom 底座的产品，发布前核心功能链路校验清单》：
 *   链路一 ASK 问答模式：一句话问答响应正常，覆盖常见场景，无超时/报错/空返回
 *   链路二 QUEST 任务模式：一句话自动拆解多步骤任务，创建→拆解→执行流程完整
 *   链路三 自动化任务编排：编排引擎正常，触发条件、执行逻辑、回调机制无误
 * 环境适配：沙箱=内置 AI 模型驱动（mock）；线上=独立部署模型服务（真实端点）
 * 红线：三条主链路未全部通过 → 禁止发布（本脚本 exit 1）
 *
 * 用法：pnpm release:gate（需要 server 运行于 SERVER_BASE，默认 http://localhost:8787）
 */
import pg from "pg";

const BASE = process.env.SERVER_BASE ?? "http://localhost:8787";
const APP_URL = process.env.DATABASE_APP_URL ?? "postgres://workloom_app:workloom_dev_app@localhost:5432/workloom";

/* ================= 判定框架 ================= */
interface CheckResult { id: string; name: string; ok: boolean; detail: string; ms: number }
const results: CheckResult[] = [];
async function check(id: string, name: string, fn: () => Promise<string>): Promise<void> {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ id, name, ok: true, detail, ms: Date.now() - t0 });
    console.log(`✓ ${id} ${name} —— ${detail}（${Date.now() - t0}ms）`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ id, name, ok: false, detail: msg, ms: Date.now() - t0 });
    console.log(`✗ ${id} ${name} —— ${msg}（${Date.now() - t0}ms）`);
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

/* ================= tRPC 客户端 ================= */
async function login(workspaceSlug: string, memberNo: string): Promise<string> {
  const r = await fetch(`${BASE}/trpc/auth.loginAs`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceSlug, memberNo }),
  });
  const j = (await r.json()) as { result?: { data?: { token?: string } } };
  assert(j.result?.data?.token, `登录失败 ${workspaceSlug}/${memberNo}`);
  return j.result.data.token;
}
async function call<T = Record<string, unknown>>(path: string, token: string, body?: unknown, timeoutMs = 30000, method: "mutation" | "query" = "mutation"): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const url = method === "query" && body
      ? `${BASE}/trpc/${path}?input=${encodeURIComponent(JSON.stringify(body))}`
      : `${BASE}/trpc/${path}`;
    const r = await fetch(url, {
      method: method === "query" ? "GET" : "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: method === "mutation" && body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const j = (await r.json()) as { result?: { data?: T }; error?: { message?: string } };
    if (j.error) throw new Error(`tRPC ${path}: ${j.error.message}`);
    return j.result?.data as T;
  } finally {
    clearTimeout(timer);
  }
}

/* ================= 主流程 ================= */
const LLM_PROVIDER = process.env.LLM_PROVIDER ?? "mock";
const envLabel = LLM_PROVIDER === "mock" ? "沙箱环境（内置 AI 模型驱动）" : `线上环境（独立模型服务：${LLM_PROVIDER}）`;
console.log(`\n════════ WorkLoom 发布前核心链路校验门禁 ════════`);
console.log(`环境适配：${envLabel} ｜ 目标：${BASE}\n`);

// 健康前置
await check("G-00", "服务健康前置", async () => {
  const r = await fetch(`${BASE}/health`);
  assert(r.ok, `health ${r.status}`);
  return "server up";
});

const tokens: Record<string, string> = {};
// 工作区自动探测（跨产品复用口径：hyperreality 无 ws-geo，WorkLoom GEO 有；存在才校验）
const WS_CANDIDATES = [
  { key: "video", slug: "video-studio", member: "MEM-V01", name: "AI 视频经营（ws-video）", wsId: "ws-video", preset: "director" },
  { key: "geo", slug: "geo-growth", member: "MEM-G01", name: "社媒×GEO 双域（ws-geo）", wsId: "ws-geo", preset: "director" },
  { key: "hotel", slug: "yunqi-hotel", member: "MEM-001", name: "云栖酒店（ws-yunqi）", wsId: "ws-yunqi", preset: "pricing-agent" },
];
const WS_LIST: typeof WS_CANDIDATES = [];
{
  // RLS 收紧口径（0013⑧：workspaces 仅按 app.workspace_id 直查，不开租户口径）——逐候选设上下文探测，新旧策略均兼容
  for (const w of WS_CANDIDATES) {
    const app = new pg.Client({ connectionString: APP_URL });
    await app.connect();
    try {
      await app.query("SELECT set_config('app.workspace_id',$1,false)", [w.wsId]);
      const r = await app.query(`SELECT slug FROM workspaces WHERE id=$1`, [w.wsId]);
      if (r.rows[0]?.slug === w.slug) WS_LIST.push(w);
    } catch { /* 该区不存在或不可见，跳过 */ } finally {
      await app.end();
    }
  }
  console.log(`工作区探测：${WS_LIST.map((w) => w.wsId).join(" / ") || "（无演示工作区）"}
`);
}
if (WS_LIST.length === 0) {
  results.push({ id: "G-01", name: "工作区探测", ok: false, detail: "无任何演示工作区（请先播种 db:seed*）", ms: 0 });
  console.log("✗ G-01 工作区探测 —— 无任何演示工作区（请先播种 db:seed*）");
}
for (const ws of WS_LIST) {
  await check("G-01", `身份签发 · ${ws.name}`, async () => {
    tokens[ws.key] = await login(ws.slug, ws.member);
    return "JWT 签发正常";
  });
}

/* ---------- 链路一：ASK 问答模式 ---------- */
const ASK_ALL: Array<{ ws: string; q: string }> = [
  { ws: "video", q: "昨天账号的数据怎么样？" },
  { ws: "video", q: "最近哪类选题完播率最高？" },
  { ws: "geo", q: "我们本周在 AI 搜索里的能见度如何？" },
  { ws: "geo", q: "竞品在品类词上的表现比我们好吗？" },
  { ws: "hotel", q: "这周入住率怎么样？" },
  { ws: "hotel", q: "现在差评主要集中在哪些方面？" },
];
const ASK_SCENARIOS = ASK_ALL.filter((sc) => WS_LIST.some((w) => w.key === sc.ws));
for (const [i, sc] of ASK_SCENARIOS.entries()) {
  await check(`A-0${i + 1}`, `ASK · ${sc.q.slice(0, 18)}…`, async () => {
    const r = await call<{ kind: string; mode?: string; answer?: string; via?: string }>(
      "threads.dispatch", tokens[sc.ws]!, { title: sc.q, presetKey: WS_LIST.find((w) => w.key === sc.ws)!.preset }, 30000,
    );
    assert(r.kind === "routed", `未路由（kind=${r.kind}）`);
    assert(r.mode === "ask", `意图误判为 ${r.mode}`);
    assert(typeof r.answer === "string" && r.answer.trim().length > 10, `空返回或过短（${String(r.answer ?? "").slice(0, 40)}）`);
    return `应答 ${r.answer!.length} 字 · via=${r.via}`;
  });
}

/* ---------- 链路二：QUEST 任务模式 ---------- */
await check("Q-01", "QUEST · 一句话目标自动拆解多步骤", async () => {
  const r = await call<{ kind: string; mode?: string; threadId?: string; status?: string; stepsTotal?: number; stepsDone?: number }>(
    "threads.dispatch", tokens[WS_LIST[0]!.key]!,
    { title: WS_LIST[0]!.key === "hotel" ? "把大床房周末房价上调 5%，并回复最新那条差评" : "给 RK-1500W 新品出 3 条小红书测评片，本周五前要", presetKey: WS_LIST[0]!.preset ?? "director", runImmediately: true },
    60000,
  );
  assert(r.kind === "routed" && r.mode === "quest", `未按 quest 路由（${r.kind}/${r.mode}）`);
  assert(r.threadId, "未建线程");
  assert(typeof r.stepsTotal === "number" && r.stepsTotal >= 2, `未拆解多步骤（stepsTotal=${r.stepsTotal}）`);
  // 任务创建→拆解→执行流程完整：线程可查、进度在推进或已完成
  const t = await call<{ id: string; status: string }>("threads.get", tokens[WS_LIST[0]!.key]!, { threadId: r.threadId }, 30000, "query");
  assert(t && t.id === r.threadId, "线程回读失败");
  return `拆解 ${r.stepsTotal} 步 · 已执行 ${r.stepsDone} 步 · 状态 ${r.status}`;
});
await check("Q-02", "QUEST · 任务事件流留痕可回读", async () => {
  // 复用 Q-01 的线程：近 30 分钟内应有 quest 线程及其事件
  const app = new pg.Client({ connectionString: APP_URL });
  await app.connect();
  try {
    await app.query("SELECT set_config('app.tenant_id','tenant-demo',false)");
    const wsId = WS_LIST[0]!.wsId;
    await app.query("SELECT set_config('app.workspace_id',$1,false)", [wsId]);
    const r = await app.query(
      `SELECT count(DISTINCT session_id) tc, count(*) ec FROM biz_events
       WHERE workspace_id=$1 AND session_id IS NOT NULL AND created_at > now() - interval '30 minutes'`,
      [wsId],
    );
    assert(Number(r.rows[0].tc) >= 1 && Number(r.rows[0].ec) >= 1, "无线程事件留痕");
    return `线程事件 ${r.rows[0].ec} 条`;
  } finally {
    await app.end();
  }
});

/* ---------- 链路三：自动化任务编排 ---------- */
await check("T-01", "编排 · 触发器在位且启用（双工作区）", async () => {
  // triggers 表有 workspace 级 RLS：逐工作区设上下文分别统计（同 T-02 口径）
  const countOf = async (wsId: string): Promise<number> => {
    const app = new pg.Client({ connectionString: APP_URL });
    await app.connect();
    try {
      await app.query("SELECT set_config('app.tenant_id','tenant-demo',false)");
      await app.query("SELECT set_config('app.workspace_id',$1,false)", [wsId]);
      const r = await app.query(`SELECT count(*) n FROM triggers WHERE enabled=true`);
      return Number(r.rows[0].n);
    } finally {
      await app.end();
    }
  };
  const parts: string[] = [];
  for (const w of WS_LIST) {
    const n = await countOf(w.wsId);
    assert(n >= 3, `${w.wsId} 触发器不足（${n}）`);
    parts.push(`${w.wsId} ×${n}`);
  }
  return parts.join(" / ");
});
await check("T-02", "编排 · 节拍执行→回调落痕（晨报触发全链）", async () => {
  const app = new pg.Client({ connectionString: APP_URL });
  await app.connect();
  let before = 0;
  try {
    await app.query("SELECT set_config('app.tenant_id','tenant-demo',false)");
    const wsId = WS_LIST[0]!.wsId;
    await app.query("SELECT set_config('app.workspace_id',$1,false)", [wsId]);
    const b = await app.query(`SELECT count(*) n FROM biz_events WHERE workspace_id=$1 AND payload->'decision'->>'action'='ceo.briefing'`, [wsId]);
    before = Number(b.rows[0].n);
  } finally {
    await app.end();
  }
  const r = await call<{ eventId?: string; skipped?: string }>("captain.runBeat", tokens[WS_LIST[0]!.key]!, { beat: "daily" }, 60000);
  assert(r.eventId || !r.skipped, `节拍未执行（skipped=${r.skipped}）`);
  const app2 = new pg.Client({ connectionString: APP_URL });
  await app2.connect();
  try {
    await app2.query("SELECT set_config('app.tenant_id','tenant-demo',false)");
    const wsId2 = WS_LIST[0]!.wsId;
    await app2.query("SELECT set_config('app.workspace_id',$1,false)", [wsId2]);
    const a = await app2.query(`SELECT count(*) n FROM biz_events WHERE workspace_id=$1 AND payload->'decision'->>'action'='ceo.briefing'`, [wsId2]);
    assert(Number(a.rows[0].n) === before + 1, `回调事件未落账（${before}→${a.rows[0].n}）`);
    return `触发→执行→回调落痕 +1（eventId=${r.eventId}）`;
  } finally {
    await app2.end();
  }
});
await check("T-03", "编排 · 事件哈希链完整（验链脚本）", async () => {
  const { execSync } = await import("node:child_process");
  const out = execSync("pnpm db:verify-chain", {
    cwd: new URL("..", import.meta.url).pathname, stdio: "pipe", env: { ...process.env },
  }).toString();
  // 验链口径兼容：旧版「逐条重算全部一致」/ 新版六项检查「全库验证通过」（D31 远端硬化版）
  assert(/逐条重算全部一致|全库验证通过/.test(out), "验链失败");
  const m = out.match(/(\d+) 条事件/);
  return `全库 ${m?.[1] ?? "?"} 条事件验链一致`;
});

/* ================= 裁决 ================= */
const failed = results.filter((r) => !r.ok);
console.log(`\n════════ 校验结果：${results.length - failed.length}/${results.length} 通过 ════════`);
if (failed.length > 0) {
  console.log("\n⛔ 发布红线触发：以下主链路校验未通过，禁止发布——");
  for (const f of failed) console.log(`  ✗ ${f.id} ${f.name} —— ${f.detail}`);
  console.log("\n历史教训：曾有版本发布后出现 ASK 模式故障——主链路未全绿，一律不许发。");
  process.exit(1);
}
console.log(`\n✅ 三条主链路全部通过（ASK ×${ASK_SCENARIOS.length} / QUEST ×2 / 编排 ×3），准许发布。环境：${envLabel}`);
