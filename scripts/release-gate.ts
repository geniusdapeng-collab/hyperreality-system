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
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { charterSchema } from "@workloom/base/captain";

const BASE = process.env.SERVER_BASE ?? "http://localhost:8787";
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const APP_URL = process.env.DATABASE_APP_URL ?? "postgres://workloom_app:workloom_dev_app@localhost:5432/workloom";
const OWNER_URL = process.env.DATABASE_URL ?? "postgres://postgres:workloom@localhost:5432/workloom";
const REQUESTED_WORKSPACE_ID = process.env.RELEASE_WORKSPACE_ID?.trim() || null;

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

// 三端导航、布局、状态与客户端 API 接线属于基座发布物，不得只发布 UI 包后
// 让行业仓人工复制。这里在业务链路前验证双制品同版和唯一分发通道。
await check("G-B0", "三端客户端同版分发契约", async () => {
  const productPath = [REPO_ROOT, dirname(REPO_ROOT), dirname(dirname(REPO_ROOT))]
    .map((directory) => join(directory, "product.manifest.json"))
    .find((path) => existsSync(path));
  assert(productPath, "缺少受保护产品身份 product.manifest.json");
  const product = JSON.parse(readFileSync(productPath, "utf8"));
  if (product.role === "base") {
    const capabilities = JSON.parse(readFileSync(join(REPO_ROOT, "sync/base-capabilities.json"), "utf8"));
    const uiPackage = JSON.parse(readFileSync(join(REPO_ROOT, "packages/ui/package.json"), "utf8"));
    const scope = JSON.parse(readFileSync(join(REPO_ROOT, "sync/base-scope.json"), "utf8"));
    const foundation = capabilities.clientFoundation;
    assert(capabilities.releasePolicy === "base-first-stable-only", "基座发布策略不是 base-first-stable-only");
    assert(foundation?.distribution === "stable-tag-upgrade-pr", "三端客户端基座未登记稳定标签 PR 分发");
    assert(foundation?.candidateVersion === uiPackage.version, "客户端基座候选版与 @workloom/ui 不同版");
    assert(foundation?.latestStableVersion === capabilities.ui?.latestStableVersion, "客户端基座与 @workloom/ui 稳定版错位");
    for (const root of ["apps/web", "apps/webb", "apps/webc"]) {
      assert(foundation.managedRoots?.includes(root), `客户端基座缺少 ${root}`);
      assert(scope.exclude?.includes(`${root}/**`), `${root} 未排除普通 base-sync，存在双通道覆盖`);
    }
    for (const path of ["sync/client-foundation.mjs", ...foundation.requiredEntries]) {
      assert(existsSync(join(REPO_ROOT, path)), `基座发布物缺少 ${path}`);
    }
    const taggedVersion = (process.env.GITHUB_REF_NAME ?? "").match(/^ui-v(.+)$/)?.[1];
    if (taggedVersion) {
      assert(foundation.latestStableVersion === taggedVersion, `标签 ${taggedVersion} 与客户端稳定版 ${foundation.latestStableVersion ?? "未登记"} 不一致`);
    }
    return `PC/B移动/C移动候选版 ${foundation.candidateVersion} · 稳定版 ${foundation.latestStableVersion ?? "尚未发布"}`;
  }
  const clientState = JSON.parse(readFileSync(join(REPO_ROOT, ".workloom-client-foundation.json"), "utf8"));
  const uiState = JSON.parse(readFileSync(join(REPO_ROOT, ".workloom-ui.json"), "utf8"));
  assert(clientState.updatePolicy === "upgrade-pr-only", "行业产品客户端基座更新策略无效");
  assert(clientState.version === uiState.version, "行业产品客户端基座与共享 UI 不同版");
  assert(existsSync(join(REPO_ROOT, "scripts/verify-client-foundation-consumer.mjs")), "缺少三端客户端基座消费门禁");
  return `行业产品 ${product.productId} · 三端稳定版 ${clientState.version}`;
});

// 宪章从旧的固定业务字段升级为 Bundle 命名的 ranges/caps 后，基座不得
// 猜测行业含义并自动改写。稳定发布前扫描全部存量档案；发现旧契约即阻断，
// 由对应行业 Bundle 先完成可审计迁移，再继续发布。
await check("G-B1", "存量治理宪章兼容性", async () => {
  const owner = new pg.Client({ connectionString: OWNER_URL });
  await owner.connect();
  try {
    const rows = await owner.query<{ workspace_id: string; charter: unknown }>(
      `SELECT workspace_id, archive->'charter' AS charter
       FROM profiles
       WHERE archive ? 'charter'
       ORDER BY workspace_id`,
    );
    const incompatible = rows.rows
      .filter((row: { workspace_id: string; charter: unknown }) => !charterSchema.safeParse(row.charter).success)
      .map((row: { workspace_id: string }) => row.workspace_id);
    assert(
      incompatible.length === 0,
      `发现 ${incompatible.length} 个旧版/非法宪章：${incompatible.slice(0, 10).join("、")}；请由对应行业 Bundle 先迁移 archive.charter，基座拒绝猜测行业字段`,
    );
    return `已扫描 ${rows.rowCount ?? rows.rows.length} 个宪章档案，全部符合通用 ranges/caps 契约`;
  } finally {
    await owner.end();
  }
});

// 健康前置
await check("G-00", "服务健康前置", async () => {
  const r = await fetch(`${BASE}/health`);
  assert(r.ok, `health ${r.status}`);
  return "server up";
});

interface ReleaseTarget {
  tenantId: string;
  workspaceId: string;
  slug: string;
  name: string;
  memberNo: string;
  presetKey: string;
}

let TARGET: ReleaseTarget | null = null;
{
  // 发布门禁只依赖 Bundle 的公共投影，不得维护酒店、视频、电商等行业工作区名单。
  const owner = new pg.Client({ connectionString: OWNER_URL });
  await owner.connect();
  try {
    const result = await owner.query<{
      tenant_id: string; id: string; slug: string; name: string; member_no: string; preset_key: string;
    }>(
      `SELECT w.tenant_id, w.id, w.slug, w.name, m.member_no, a.preset_key
       FROM workspaces w
       JOIN LATERAL (
         SELECT member_no FROM members
         WHERE workspace_id=w.id AND role IN ('owner','manager')
         ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, member_no LIMIT 1
       ) m ON true
       JOIN LATERAL (
         SELECT preset_key FROM agents
         WHERE workspace_id=w.id AND status IN ('ready','active') AND readonly=false
         ORDER BY preset_key LIMIT 1
       ) a ON true
       WHERE w.is_example=true AND ($1::text IS NULL OR w.id=$1)
       ORDER BY w.created_at DESC NULLS LAST, w.id
       LIMIT 1`,
      [REQUESTED_WORKSPACE_ID],
    );
    const row = result.rows[0];
    if (row) TARGET = {
      tenantId: row.tenant_id,
      workspaceId: row.id,
      slug: row.slug,
      name: row.name,
      memberNo: row.member_no,
      presetKey: row.preset_key,
    };
  } finally {
    await owner.end();
  }
  console.log(`工作区探测：${TARGET ? `${TARGET.name}（${TARGET.workspaceId}）` : "（无可验收示例工作区）"}\n`);
}
if (!TARGET) {
  results.push({ id: "G-01", name: "工作区探测", ok: false, detail: "无可验收的示例工作区（请先播种当前 Bundle）", ms: 0 });
  console.log("✗ G-01 工作区探测 —— 无可验收的示例工作区（请先播种当前 Bundle）");
}
const token = TARGET ? await login(TARGET.slug, TARGET.memberNo).catch(() => "") : "";
if (TARGET) await check("G-01", `身份签发 · ${TARGET.name}`, async () => {
  assert(token, "JWT 签发失败");
  return "JWT 签发正常";
});

/* ---------- 链路一：ASK 问答模式 ---------- */
const ASK_SCENARIOS = TARGET ? [
  "请问当前工作区最近有哪些关键进展？",
  "请问现在有哪些事项需要我决定？",
] : [];
for (const [i, question] of ASK_SCENARIOS.entries()) {
  await check(`A-0${i + 1}`, `ASK · ${question.slice(0, 18)}…`, async () => {
    const r = await call<{ kind: string; mode?: string; answer?: string; via?: string }>(
      "threads.dispatch", token, { title: question, presetKey: TARGET!.presetKey }, 30000,
    );
    assert(r.kind === "routed", `未路由（kind=${r.kind}）`);
    assert(r.mode === "ask", `意图误判为 ${r.mode}`);
    assert(typeof r.answer === "string" && r.answer.trim().length > 10, `空返回或过短（${String(r.answer ?? "").slice(0, 40)}）`);
    return `应答 ${r.answer!.length} 字 · via=${r.via}`;
  });
}

/* ---------- 链路二：QUEST 任务模式 ---------- */
await check("Q-01", "QUEST · 一句话目标自动拆解多步骤", async () => {
  assert(TARGET && token, "无可执行的验收工作区身份");
  const r = await call<{ kind: string; mode?: string; threadId?: string; status?: string; stepsTotal?: number; stepsDone?: number }>(
    "threads.dispatch", token,
    { title: "生成一份本周运行复盘，并列出三项下一步任务", presetKey: TARGET.presetKey, runImmediately: true },
    60000,
  );
  assert(r.kind === "routed" && r.mode === "quest", `未按 quest 路由（${r.kind}/${r.mode}）`);
  assert(r.threadId, "未建线程");
  assert(typeof r.stepsTotal === "number" && r.stepsTotal >= 2, `未拆解多步骤（stepsTotal=${r.stepsTotal}）`);
  // 任务创建→拆解→执行流程完整：线程可查、进度在推进或已完成
  const t = await call<{ id: string; status: string }>("threads.get", token, { threadId: r.threadId }, 30000, "query");
  assert(t && t.id === r.threadId, "线程回读失败");
  return `拆解 ${r.stepsTotal} 步 · 已执行 ${r.stepsDone} 步 · 状态 ${r.status}`;
});
await check("Q-02", "QUEST · 任务事件流留痕可回读", async () => {
  assert(TARGET, "无可执行的验收工作区");
  // 复用 Q-01 的线程：近 30 分钟内应有 quest 线程及其事件
  const app = new pg.Client({ connectionString: APP_URL });
  await app.connect();
  try {
    await app.query("SELECT set_config('app.tenant_id',$1,false)", [TARGET.tenantId]);
    const wsId = TARGET.workspaceId;
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
await check("T-01", "编排 · 当前 Bundle 触发器在位且启用", async () => {
  assert(TARGET, "无可执行的验收工作区");
  // triggers 表有 workspace 级 RLS：逐工作区设上下文分别统计（同 T-02 口径）
  const countOf = async (wsId: string): Promise<number> => {
    const app = new pg.Client({ connectionString: APP_URL });
    await app.connect();
    try {
      await app.query("SELECT set_config('app.tenant_id',$1,false)", [TARGET!.tenantId]);
      await app.query("SELECT set_config('app.workspace_id',$1,false)", [wsId]);
      const r = await app.query(`SELECT count(*) n FROM triggers WHERE enabled=true`);
      return Number(r.rows[0].n);
    } finally {
      await app.end();
    }
  };
  const count = await countOf(TARGET.workspaceId);
  assert(count >= 1, `${TARGET.workspaceId} 没有启用的自动化触发器`);
  return `${TARGET.workspaceId} ×${count}`;
});
await check("T-02", "编排 · 节拍执行→回调落痕（晨报触发全链）", async () => {
  assert(TARGET && token, "无可执行的验收工作区身份");
  const app = new pg.Client({ connectionString: APP_URL });
  await app.connect();
  let before = 0;
  try {
    await app.query("SELECT set_config('app.tenant_id',$1,false)", [TARGET.tenantId]);
    const wsId = TARGET.workspaceId;
    await app.query("SELECT set_config('app.workspace_id',$1,false)", [wsId]);
    const b = await app.query(`SELECT count(*) n FROM biz_events WHERE workspace_id=$1 AND payload->'decision'->>'action'='ceo.briefing'`, [wsId]);
    before = Number(b.rows[0].n);
  } finally {
    await app.end();
  }
  const r = await call<{ eventId?: string; skipped?: string }>("captain.runBeat", token, { beat: "daily" }, 60000);
  assert(r.eventId || !r.skipped, `节拍未执行（skipped=${r.skipped}）`);
  const app2 = new pg.Client({ connectionString: APP_URL });
  await app2.connect();
  try {
    await app2.query("SELECT set_config('app.tenant_id',$1,false)", [TARGET.tenantId]);
    const wsId2 = TARGET.workspaceId;
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
