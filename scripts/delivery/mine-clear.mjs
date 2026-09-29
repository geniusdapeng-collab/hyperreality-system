#!/usr/bin/env node
/**
 * 排雷式交付执行器（MCD v1.0）——问题系统性排查 → 修复 → 验收交接。
 *
 * 规范正文：docs/MINE-CLEAR-DELIVERY-SPEC.md
 * 台账 schema：docs/mine-clear/ledger.schema.json
 * 报告模板：docs/mine-clear/report-template.md
 *
 * 定位：本脚本是**编排与门禁**，不是"自动修 bug"的魔法。它把三基线、四层问题模型、
 * 断言前置、修复者不自验、未闭环必须给回归路径这些纪律，变成机器可判定的硬闸。
 *
 * 触发关键词（与规范 §0 一致）：排雷 / 排雷式交付 / 系统性排查 / 交付前排查 / 交付体检 /
 * 挖问题 / 问题台账 / 修复排期 / 假修复 / 联动地雷 / MCD / mine-clear。
 *
 * 用法：
 *   node scripts/delivery/mine-clear.mjs init --repo . --task T-YYYY-MMDD-XXXX
 *   node scripts/delivery/mine-clear.mjs card-template --kind problem > card.json
 *   node scripts/delivery/mine-clear.mjs add --ledger <台账> --card card.json
 *   node scripts/delivery/mine-clear.mjs gate --ledger <台账>
 *   node scripts/delivery/mine-clear.mjs status --ledger <台账>
 *   node scripts/delivery/mine-clear.mjs plan --ledger <台账>
 *   node scripts/delivery/mine-clear.mjs verify-baseline --ledger <台账> --repo .
 *   node scripts/delivery/mine-clear.mjs handoff --ledger <台账> --env client-runtime
 *
 * 退出码：0 通过；1 门禁未过 / 存在 stale 卡 / 交接被拒；2 参数或环境错误。
 * 本文件只依赖 Node 内置模块，随 base-sync 整文件分发（见 sync/base-scope.json#requiredRootAssets）。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const SCHEMA_ID = "workloom.mine-clear/ledger@1";
const CARD_ID_RE = /^MC-\d{3,}$/;
const TASK_ID_RE = /^T-\d{4}-\d{4}-\d{4}$/;
const SHA_RE = /^[0-9a-f]{7,40}$/i;
const UNVERIFIABLE_WORDS = /(优化|提升|加强|完善|尽量|适当|更好)/;
const SEVERITY_ORDER = { P0: 0, P1: 1, P2: 2 };
const BATCH_NAMES = ["第 0 批 · 止血", "第 1 批 · 地基", "第 2 批 · 正确性", "第 3 批 · 体验"];

const HELP = `排雷式交付执行器（MCD v1.0）

用法：node scripts/delivery/mine-clear.mjs <命令> [选项]

命令：
  init              记录审计基线并生成 ledger.json 骨架
                    --repo <路径> --task <T-...> [--title <标题>] [--out <目录>] [--env <档位>] [--no-fetch] [--force]
  invariants        写入/刷新系统不变量清单（默认从 AGENTS.md §4 提取）
                    --ledger <台账> [--file <invariants.json>] [--from-agents <AGENTS.md 路径>]
  card-template     打印问题卡或修复卡模板（可直接填好后 add）
                    --kind <problem|fix>
  add               校验并追加一张卡（同 ID 需 --replace）
                    --ledger <台账> --card <文件|-> [--replace]
  gate              台账完整性门禁：断言可运行 / 修复卡有回归 / 验证人与修复人分离 / P0 未闭环即红
                    --ledger <台账> [--json]
  status            按状态、级别、批次统计并列出未闭环清单
                    --ledger <台账> [--json]
  plan              生成四批修复计划与冲突面（同文件卡）分组
                    --ledger <台账> [--json]
  verify-baseline   每卡基线 vs 当前云端：current / needs-relocate / diverged / unknown
                    --ledger <台账> --repo <路径> [--no-fetch] [--json]
  handoff           生成 RDAS v3.1 验收交接单（handoff.json）
                    --ledger <台账> [--out <目录>] [--env <local-preview|client-runtime|deployed>] [--json]
  help              显示本帮助

环境档位（写报告前必读）：local-preview 只能写"本机预览结构验收"；
只有 client-runtime / deployed 才能写"生产实测"（RDAS v3.1 §0）。
`;

// ---------------------------------------------------------------- 基础工具

function arg(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const has = (name) => process.argv.includes(name);

function die(message, code = 1) {
  console.error(`✗ ${message}`);
  process.exit(code);
}

function ok(message) {
  console.log(`✓ ${message}`);
}

function note(message) {
  console.log(`· ${message}`);
}

function warn(message) {
  console.log(`! ${message}`);
}

function nowIso() {
  return new Date().toISOString();
}

function git(cwd, args, { allowFailure = false } = {}) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }).trim();
  } catch (error) {
    if (allowFailure) return null;
    const detail = (error?.stderr?.toString?.() || error?.message || "").trim().slice(0, 300);
    throw new Error(`git ${args.join(" ")} 失败：${detail}`);
  }
}

function readJsonFile(path, label) {
  if (!existsSync(path)) die(`${label} 不存在：${path}`, 2);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    die(`${label} 不是合法 JSON（${path}）：${error.message}`, 2);
  }
}

function writeJsonFile(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readStdin() {
  return readFileSync(0, "utf8");
}

function requireLedgerPath() {
  const path = arg("--ledger");
  if (!path) die("缺少 --ledger <台账路径>（先跑 init 生成）", 2);
  return resolve(path);
}

function repoRoot(repoPath) {
  const root = git(resolve(repoPath || "."), ["rev-parse", "--show-toplevel"], { allowFailure: true });
  if (!root) die(`--repo 不是 Git 仓库：${resolve(repoPath || ".")}`, 2);
  return root;
}

function branchTaskId(branch) {
  const match = /^task\/(T-\d{4}-\d{4}-\d{4})$/.exec(String(branch ?? ""));
  return match ? match[1] : null;
}

function isSha(value) {
  return SHA_RE.test(String(value ?? ""));
}

/** 证据引用里的提交号：`file:line@commit` 或裸 sha */
function evidenceCommit(ref) {
  const match = /@([0-9a-f]{7,40})\b/i.exec(String(ref ?? ""));
  return match ? match[1] : null;
}

// ---------------------------------------------------------------- 校验

function validateLedger(ledger, errors) {
  if (ledger?.schema !== SCHEMA_ID) errors.push(`ledger.schema 必须是 ${SCHEMA_ID}（当前：${ledger?.schema ?? "缺"}）`);
  if (!TASK_ID_RE.test(String(ledger?.task_id ?? ""))) errors.push(`ledger.task_id 必须形如 T-YYYY-MMDD-XXXX（当前：${ledger?.task_id ?? "缺"}）`);
  if (!ledger?.repo) errors.push("ledger.repo 缺失");
  if (!Array.isArray(ledger?.cards)) errors.push("ledger.cards 必须是数组");
  if (!Array.isArray(ledger?.invariants) || ledger.invariants.length === 0) {
    errors.push("ledger.invariants 为空：先跑 `invariants`（不变量是断言设计的骨架，不能省）");
  }
  if (!ledger?.baseline?.audit?.commit) errors.push("ledger.baseline.audit.commit 缺失：审计基线未记录");
}

function validateCard(card, { ledger = null, index = 0 } = {}) {
  const errors = [];
  const where = `卡片[${index}]${card?.id ? ` ${card.id}` : ""}`;
  if (!CARD_ID_RE.test(String(card?.id ?? ""))) errors.push(`${where}：id 必须形如 MC-001`);
  if (!["problem", "fix"].includes(card?.kind)) errors.push(`${where}：kind 必须是 problem 或 fix`);
  if (!card?.title || String(card.title).length < 4) errors.push(`${where}：title 太短`);
  if (!["open", "fixed", "verified", "unfixed", "covered", "wontfix"].includes(card?.state)) {
    errors.push(`${where}：state 必须是 open|fixed|verified|unfixed|covered|wontfix`);
  }
  if (!Array.isArray(card?.evidence) || card.evidence.length === 0) {
    errors.push(`${where}：evidence 不能为空（无证据不上账）`);
  } else {
    for (const [i, item] of card.evidence.entries()) {
      if (!item?.type) errors.push(`${where}：evidence[${i}] 缺 type`);
      if (!item?.ref) errors.push(`${where}：evidence[${i}] 缺 ref`);
      if (item?.type === "code" && item?.ref && !isSha(evidenceCommit(item.ref))) {
        errors.push(`${where}：evidence[${i}] 是代码类证据，ref 必须带 @<commit>（如 apps/server/src/x.ts:42@abc1234）`);
      }
    }
  }
  if (!Array.isArray(card?.assertions) || card.assertions.length === 0) {
    errors.push(`${where}：assertions 不能为空（验证信号必须前置）`);
  } else {
    for (const [i, assertion] of card.assertions.entries()) {
      const tag = `${where}：assertions[${i}]`;
      if (!["sample", "property"].includes(assertion?.kind)) errors.push(`${tag} kind 必须是 sample 或 property`);
      if (!assertion?.given) errors.push(`${tag} 缺 given（输入/前置条件）`);
      if (!assertion?.expect) errors.push(`${tag} 缺 expect（可判定的预期）`);
      else if (UNVERIFIABLE_WORDS.test(String(assertion.expect))) {
        errors.push(`${tag} expect 含不可验收措辞（优化/提升/加强/完善/尽量/适当/更好），请改写成可判定的结果`);
      }
      if (!assertion?.command || String(assertion.command).length < 3) {
        errors.push(`${tag} 缺可运行的 command（没有通过/失败信号就不是断言）`);
      }
      if (assertion?.last_result === "pass" && !assertion?.evidence) {
        errors.push(`${tag} last_result=pass 必须给 evidence（断言输出原文路径），证据优先于声明`);
      }
      if (assertion?.last_result && !["pass", "fail", "not-run"].includes(assertion.last_result)) {
        errors.push(`${tag} last_result 必须是 pass|fail|not-run`);
      }
    }
  }
  if (card?.kind === "problem") {
    if (!["L1", "L2", "L3", "L4"].includes(card?.level)) errors.push(`${where}：问题卡必须有 level（L1|L2|L3|L4）`);
    if (!["P0", "P1", "P2"].includes(card?.severity)) errors.push(`${where}：问题卡必须有 severity（P0|P1|P2）`);
    if (!card?.root_cause?.file) errors.push(`${where}：问题卡必须有 root_cause.file`);
    if (!isSha(card?.root_cause?.commit)) errors.push(`${where}：问题卡根因必须带 commit（文件:行号@commit 是上账的最低要求）`);
    if (!card?.trigger_path) errors.push(`${where}：问题卡必须有 trigger_path（什么输入/时序能走到这个坑）`);
  }
  if (card?.kind === "fix") {
    if (!Array.isArray(card?.covers) || card.covers.length === 0) errors.push(`${where}：修复卡必须写 covers（覆盖哪些问题 ID）`);
    if (!card?.fix_plan) errors.push(`${where}：修复卡必须写 fix_plan（代码级修法）`);
    if (!card?.rollback) errors.push(`${where}：修复卡必须写 rollback（回滚方式）`);
    if (![0, 1, 2, 3].includes(card?.batch)) errors.push(`${where}：修复卡必须有 batch（0 止血|1 地基|2 正确性|3 体验）`);
    if (!Array.isArray(card?.conflict_paths)) errors.push(`${where}：修复卡必须有 conflict_paths（冲突面，可为空数组）`);
    if (!card?.blast_radius) errors.push(`${where}：修复卡必须写 blast_radius（联动地雷推演）`);
  }
  if (card?.state === "fixed" && !card?.regression?.command) {
    errors.push(`${where}：state=fixed 必须给 regression.command（修完凭什么说修好了）`);
  }
  if (card?.state === "verified") {
    if (!card?.verified_by) errors.push(`${where}：state=verified 必须给 verified_by`);
    if (!card?.verified_at) errors.push(`${where}：state=verified 必须给 verified_at`);
    if (!card?.verification_evidence) errors.push(`${where}：state=verified 必须给 verification_evidence（独立验证的断言输出路径）`);
    if (card?.verified_by && card?.fixed_by && card.verified_by === card.fixed_by && !card?.waiver?.reason) {
      errors.push(`${where}：验证人与修复人相同（修复者不自验）——换独立会话，或写 waiver.reason 说明豁免理由`);
    }
  }
  if (card?.state === "covered" && !isSha(evidenceCommit(card?.covered_by)) && !isSha(card?.covered_by)) {
    errors.push(`${where}：state=covered 必须给 covered_by（覆盖该问题的提交 sha）`);
  }
  if (card?.state === "wontfix" && !card?.notes) {
    errors.push(`${where}：state=wontfix 必须在 notes 写明为什么不做、谁批的`);
  }
  if (ledger && Array.isArray(ledger.cards)) {
    const ids = new Set(ledger.cards.map((item) => item?.id));
    if (card?.kind === "fix") {
      for (const covered of card.covers ?? []) {
        if (!ids.has(covered)) errors.push(`${where}：covers 引用了不存在的卡 ${covered}`);
      }
    }
  }
  return errors;
}

function collectErrors(ledger) {
  const errors = [];
  validateLedger(ledger, errors);
  if (!Array.isArray(ledger?.cards)) return errors;
  const seen = new Set();
  ledger.cards.forEach((card, index) => {
    errors.push(...validateCard(card, { ledger, index }));
    if (card?.id) {
      if (seen.has(card.id)) errors.push(`卡片 ID 重复：${card.id}`);
      seen.add(card.id);
    }
  });
  for (const card of ledger.cards) {
    if (card?.kind === "problem" && card?.severity === "P0" && ["open", "unfixed"].includes(card?.state)) {
      errors.push(`${card.id}：P0 未闭环（突破核心不变量 / 安全）——阻断交付，必须先修再验收`);
    }
  }
  return errors;
}

// ---------------------------------------------------------------- 命令

function commandInit() {
  const root = repoRoot(arg("--repo", "."));
  const remote = arg("--remote", "origin");
  const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]) || "(detached)";
  const head = git(root, ["rev-parse", "HEAD"]);
  const taskId = arg("--task") || branchTaskId(branch);
  if (!taskId || !TASK_ID_RE.test(taskId)) {
    die("缺少 --task T-YYYY-MMDD-XXXX（或把分支命名为 task/T-YYYY-MMDD-XXXX）", 2);
  }
  const fetchedAt = has("--no-fetch") ? null : nowIso();
  if (!has("--no-fetch")) git(root, ["fetch", "--quiet", remote], { allowFailure: true });
  const remoteMain = git(root, ["rev-parse", `${remote}/main`], { allowFailure: true });
  const dirty = (git(root, ["status", "--porcelain"]) || "").split("\n").filter(Boolean);

  const outDir = resolve(arg("--out", join(root, "outputs", "mine-clear", taskId)));
  const ledgerPath = join(outDir, "ledger.json");
  if (existsSync(ledgerPath) && !has("--force")) {
    die(`台账已存在：${ledgerPath}（要重建加 --force）`, 2);
  }

  const notes = [];
  if (!remoteMain) notes.push(`未能解析 ${remote}/main（离线或未配置 remote）`);
  else if (remoteMain !== head) notes.push(`本地 HEAD 不是 ${remote}/main 最新（云端 ${remoteMain.slice(0, 8)} / 本地 ${head.slice(0, 8)}）——按 §1.2 先对齐基线`);
  if (dirty.length) notes.push(`工作树不干净（${dirty.length} 项未提交改动）：排雷结论只对已提交内容成立`);

  const baseline = {
    schema: "workloom.mine-clear/baseline@1",
    task_id: taskId,
    repo: basename(root),
    repo_path: root,
    remote,
    audit: {
      commit: head,
      branch,
      remote,
      remote_main: remoteMain,
      fetched_at: fetchedAt,
      dirty_count: dirty.length,
      notes,
    },
    smoke: { status: "not-run", notes: "M0 冒烟：健康检查 + 一条核心业务链路，跑完回填这里" },
    created_at: nowIso(),
  };
  writeJsonFile(join(outDir, "baseline.json"), baseline);

  const ledger = {
    schema: SCHEMA_ID,
    task_id: taskId,
    repo: basename(root),
    title: arg("--title", ""),
    created_at: nowIso(),
    updated_at: nowIso(),
    baseline: {
      audit: { commit: head, branch, remote, fetched_at: fetchedAt, notes: notes.join("；") },
      repair: { commit: null, reverified_problem_ids: [] },
      acceptance: { commit: null, is_descendant_of_repair: null },
    },
    environment: { kind: arg("--env", "unknown"), notes: "" },
    invariants: [],
    cards: [],
    gates: [],
  };
  writeJsonFile(ledgerPath, ledger);
  ok(`台账已建：${ledgerPath}`);
  note(`审计基线 ${head.slice(0, 8)} · 分支 ${branch} · 任务 ${taskId}`);
  for (const item of notes) warn(item);
  note("下一步：invariants（不变量）→ card-template + add（上账）→ gate（门禁）");
}

function parseAgentsInvariants(agentsPath) {
  if (!existsSync(agentsPath)) return null;
  const text = readFileSync(agentsPath, "utf8");
  const section = /##\s*4\.\s*系统不变量[\s\S]*?(?=\n##\s|\n<!--|$)/.exec(text);
  if (!section) return null;
  const items = [];
  for (const line of section[0].split("\n")) {
    const match = /^(\d+)\.\s+(.*\S)\s*$/.exec(line.trim());
    if (match) items.push({ n: Number(match[1]), text: match[2] });
  }
  if (!items.length) return null;
  return items.map((item) => ({
    id: `INV-${item.n}`,
    text: item.text,
    source: `AGENTS.md#4.${item.n}`,
  }));
}

function commandInvariants() {
  const ledgerPath = requireLedgerPath();
  const ledger = readJsonFile(ledgerPath, "台账");
  let invariants = null;
  const file = arg("--file");
  if (file) {
    const parsed = readJsonFile(resolve(file), "--file");
    invariants = Array.isArray(parsed) ? parsed : parsed?.invariants;
    if (!Array.isArray(invariants)) die("--file 必须是数组或 { invariants: [...] }", 2);
  } else {
    const agentsPath = resolve(arg("--from-agents", join(dirname(ledgerPath), "..", "..", "..", "AGENTS.md")));
    invariants = parseAgentsInvariants(agentsPath);
    if (!invariants) die(`未能从 ${agentsPath} 解析 §4 系统不变量；请用 --file 传入清单`, 2);
  }
  const errors = [];
  invariants.forEach((item, index) => {
    if (!item?.id) errors.push(`invariants[${index}] 缺 id`);
    if (!item?.text) errors.push(`invariants[${index}] 缺 text`);
  });
  if (errors.length) die(errors.join("\n"), 2);
  ledger.invariants = invariants;
  ledger.updated_at = nowIso();
  writeJsonFile(ledgerPath, ledger);
  ok(`已写入 ${invariants.length} 条系统不变量`);
  for (const item of invariants) note(`${item.id} ${item.text.slice(0, 60)}${item.text.length > 60 ? "…" : ""}`);
}

function cardTemplate(kind) {
  if (kind === "fix") {
    return {
      id: "MC-101",
      kind: "fix",
      batch: 0,
      state: "open",
      title: "<一句话说清修什么>",
      covers: ["MC-001"],
      evidence: [{ type: "code", ref: "<path>:<line>@<commit>", note: "<实证>" }],
      fix_plan: "<代码级：改哪个文件哪一段>",
      blast_radius: "<此改动改变谁的行为 / 谁依赖被改的文案·字段·顺序>",
      conflict_paths: ["<path>"],
      assertions: [
        { kind: "sample", given: "<输入>", expect: "<可判定的预期>", command: "<可运行命令>", last_result: "not-run" },
        { kind: "property", given: "<任意输入>", expect: "<不变量成立>", command: "<可运行命令>", last_result: "not-run" },
      ],
      regression: { command: "<回归命令>", evidence: "" },
      rollback: "revert <commit>",
      fixed_by: null,
      verified_by: null,
      notes: "",
    };
  }
  return {
    id: "MC-001",
    kind: "problem",
    level: "L1",
    severity: "P1",
    batch: 2,
    state: "open",
    title: "<一句话说清问题>",
    evidence: [{ type: "code", ref: "<path>:<line>@<commit>", note: "<实证：代码原文 / 日志 / 响应>" }],
    root_cause: { file: "<path>", line: 1, commit: "<commit>", symbol: "<函数/类>" },
    trigger_path: "<什么输入或时序能走到这个坑>",
    assertions: [
      { kind: "sample", given: "<输入>", expect: "<可判定的预期>", command: "<可运行命令>", last_result: "not-run" },
      { kind: "property", given: "<任意输入>", expect: "<不变量成立>", command: "<可运行命令>", last_result: "not-run" },
    ],
    notes: "",
  };
}

function commandCardTemplate() {
  const kind = arg("--kind", "problem");
  if (!["problem", "fix"].includes(kind)) die("--kind 必须是 problem 或 fix", 2);
  process.stdout.write(`${JSON.stringify(cardTemplate(kind), null, 2)}\n`);
}

function commandAdd() {
  const ledgerPath = requireLedgerPath();
  const ledger = readJsonFile(ledgerPath, "台账");
  const cardArg = arg("--card");
  if (!cardArg) die("缺少 --card <文件|->", 2);
  let card;
  try {
    card = JSON.parse(cardArg === "-" ? readStdin() : readFileSync(resolve(cardArg), "utf8"));
  } catch (error) {
    die(`卡片不是合法 JSON：${error.message}`, 2);
  }
  const errors = validateCard(card, { ledger, index: ledger.cards?.length ?? 0 });
  if (errors.length) {
    console.error("✗ 卡片校验未通过：");
    for (const item of errors) console.error(`  - ${item}`);
    process.exit(1);
  }
  const existing = (ledger.cards ?? []).findIndex((item) => item?.id === card.id);
  if (existing >= 0) {
    if (!has("--replace")) die(`${card.id} 已存在（要覆盖加 --replace）`, 1);
    ledger.cards[existing] = card;
    ok(`已替换 ${card.id}`);
  } else {
    ledger.cards = [...(ledger.cards ?? []), card];
    ok(`已上账 ${card.id}（${card.kind === "problem" ? `问题卡 ${card.severity}/${card.level}` : `修复卡 批次 ${card.batch}`}）`);
  }
  ledger.updated_at = nowIso();
  writeJsonFile(ledgerPath, ledger);
}

function commandGate() {
  const ledgerPath = requireLedgerPath();
  const ledger = readJsonFile(ledgerPath, "台账");
  const errors = collectErrors(ledger);
  const asJson = has("--json");
  if (asJson) {
    console.log(JSON.stringify({ ledger: ledgerPath, ok: errors.length === 0, errors }, null, 2));
    process.exit(errors.length ? 1 : 0);
  }
  if (errors.length) {
    console.error(`✗ 台账门禁未过（${errors.length} 项）：`);
    for (const item of errors) console.error(`  - ${item}`);
    process.exit(1);
  }
  ok(`台账门禁通过：${ledger.cards.length} 张卡 / ${ledger.invariants.length} 条不变量`);
}

function summarize(ledger) {
  const cards = ledger.cards ?? [];
  const byState = {};
  const bySeverity = {};
  const byBatch = {};
  for (const card of cards) {
    byState[card.state ?? "?"] = (byState[card.state ?? "?"] ?? 0) + 1;
    if (card.kind === "problem") bySeverity[card.severity ?? "?"] = (bySeverity[card.severity ?? "?"] ?? 0) + 1;
    const batch = card.batch;
    if (batch !== undefined && batch !== null) byBatch[batch] = (byBatch[batch] ?? 0) + 1;
  }
  const open = cards.filter((card) => ["open", "unfixed", "fixed"].includes(card.state));
  return {
    task_id: ledger.task_id,
    total: cards.length,
    problem: cards.filter((card) => card.kind === "problem").length,
    fix: cards.filter((card) => card.kind === "fix").length,
    by_state: byState,
    by_severity: bySeverity,
    by_batch: byBatch,
    unclosed: open.map((card) => ({ id: card.id, state: card.state, severity: card.severity ?? null, title: card.title })),
  };
}

function commandStatus() {
  const ledgerPath = requireLedgerPath();
  const ledger = readJsonFile(ledgerPath, "台账");
  const summary = summarize(ledger);
  if (has("--json")) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  console.log(`台账 ${ledger.task_id} · ${summary.total} 张卡（问题 ${summary.problem} / 修复 ${summary.fix}）`);
  console.log(`状态：${Object.entries(summary.by_state).map(([k, v]) => `${k}=${v}`).join(" ") || "（空）"}`);
  console.log(`级别：${Object.entries(summary.by_severity).map(([k, v]) => `${k}=${v}`).join(" ") || "（空）"}`);
  const batches = Object.entries(summary.by_batch).map(([k, v]) => `${BATCH_NAMES[Number(k)] ?? k}=${v}`);
  console.log(`批次：${batches.join(" ") || "（空）"}`);
  if (summary.unclosed.length) {
    console.log("未闭环：");
    for (const item of summary.unclosed) console.log(`  - ${item.id} [${item.state}] ${item.title ?? ""}`);
  } else {
    console.log("未闭环：无");
  }
  const p0 = ledger.cards.filter((card) => card.kind === "problem" && card.severity === "P0" && ["open", "unfixed"].includes(card.state));
  if (p0.length) console.log(`阻断交付的 P0：${p0.map((card) => card.id).join(", ")}`);
}

function cardPaths(card) {
  const paths = new Set();
  if (card?.root_cause?.file) paths.add(card.root_cause.file);
  for (const path of card?.conflict_paths ?? []) if (path) paths.add(path);
  for (const item of card?.evidence ?? []) {
    if (item?.type === "code" && item.ref) paths.add(String(item.ref).split(":")[0]);
  }
  return [...paths];
}

function commandPlan() {
  const ledgerPath = requireLedgerPath();
  const ledger = readJsonFile(ledgerPath, "台账");
  const work = (ledger.cards ?? []).filter(
    (card) => card.kind === "fix" || (card.kind === "problem" && ["open", "unfixed"].includes(card.state)),
  );
  const batches = [0, 1, 2, 3].map((batch) => ({
    batch,
    name: BATCH_NAMES[batch],
    cards: work
      .filter((card) => (card.batch ?? 2) === batch)
      .sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9) || a.id.localeCompare(b.id)),
  }));
  const pathMap = new Map();
  for (const card of ledger.cards ?? []) {
    for (const path of cardPaths(card)) {
      if (!pathMap.has(path)) pathMap.set(path, new Set());
      pathMap.get(path).add(card.id);
    }
  }
  const conflicts = [...pathMap.entries()]
    .filter(([, ids]) => ids.size > 1)
    .map(([path, ids]) => ({ path, cards: [...ids].sort() }));
  const payload = { task_id: ledger.task_id, batches, conflicts };
  if (has("--json")) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(`修复计划 ${ledger.task_id} · 待处理 ${work.length} 张卡`);
  for (const group of batches) {
    console.log(`\n${group.name}（${group.cards.length}）`);
    for (const card of group.cards) {
      const covered = card.covers?.length ? ` ← ${card.covers.join(",")}` : "";
      console.log(`  - ${card.id} [${card.severity ?? card.kind}] ${card.title ?? ""}${covered}`);
    }
  }
  console.log("\n冲突面（同文件的卡必须串行或合并）：");
  if (!conflicts.length) console.log("  （无）");
  for (const item of conflicts) console.log(`  - ${item.path} ← ${item.cards.join(", ")}`);
}

function commandVerifyBaseline() {
  const ledgerPath = requireLedgerPath();
  const ledger = readJsonFile(ledgerPath, "台账");
  const root = repoRoot(arg("--repo", "."));
  const remote = arg("--remote", "origin");
  if (!has("--no-fetch")) git(root, ["fetch", "--quiet", remote], { allowFailure: true });
  const head = git(root, ["rev-parse", "HEAD"]);
  const rows = [];
  let stale = 0;
  for (const card of ledger.cards ?? []) {
    const commit = card?.root_cause?.commit ?? card?.covered_by ?? null;
    if (!isSha(commit)) continue;
    const exists = git(root, ["cat-file", "-e", `${commit}^{commit}`], { allowFailure: true }) !== null;
    let status = "unknown";
    let changed = null;
    if (exists) {
      const isAncestor = git(root, ["merge-base", "--is-ancestor", commit, head], { allowFailure: true }) !== null;
      status = isAncestor ? "current" : "diverged";
      if (isAncestor && card?.root_cause?.file) {
        const diff = git(root, ["diff", "--name-only", `${commit}..HEAD`, "--", card.root_cause.file], { allowFailure: true });
        if (diff && diff.length) {
          changed = diff.split("\n").length;
          // 文件在该基线之后被改过：行号引用可能失效，动手前必须重新定位
          status = card.state === "verified" ? "current" : "needs-relocate";
        }
      }
    }
    if (status === "unknown" || status === "diverged" || status === "needs-relocate") stale += 1;
    rows.push({ id: card.id, state: card.state, base_commit: commit.slice(0, 8), status, file: card.root_cause?.file ?? null, changed_files: changed });
  }
  if (has("--json")) {
    console.log(JSON.stringify({ head: head.slice(0, 8), rows, stale }, null, 2));
  } else {
    console.log(`基线核对（当前 HEAD ${head.slice(0, 8)}）`);
    if (!rows.length) console.log("  （台账里没有带 commit 的卡）");
    for (const row of rows) {
      const hint = {
        current: "基线仍在线",
        "needs-relocate": "该文件基线之后被改过：动手前重新定位行号并确认问题仍存在",
        diverged: "该提交不在当前历史线上：先 rebase / 确认是否已在别的分支修掉",
        unknown: "本地没有该提交：无法核对，先 fetch / 换到正确工作树",
      }[row.status];
      console.log(`  - ${row.id} [${row.state}] @${row.base_commit} → ${row.status}（${hint}）`);
    }
    console.log(stale ? `! ${stale} 张卡需要先对齐基线，再动键盘` : "✓ 全部卡基线在线");
  }
  process.exit(stale ? 1 : 0);
}

function commandHandoff() {
  const ledgerPath = requireLedgerPath();
  const ledger = readJsonFile(ledgerPath, "台账");
  const errors = collectErrors(ledger);
  if (errors.length) {
    console.error(`✗ 交接被拒：台账门禁未过（${errors.length} 项）`);
    for (const item of errors.slice(0, 12)) console.error(`  - ${item}`);
    process.exit(1);
  }
  const cards = ledger.cards ?? [];
  const closed = cards.filter((card) => card.state === "verified");
  const open = cards.filter((card) => !["verified", "wontfix"].includes(card.state));
  const blockers = [];
  for (const card of open) {
    // 规范 §7：未闭环项必须写明"修复后跑哪个脚本哪条断言回归"，因此这里要的是显式 regression，
    // 不接受"反正有断言"——断言证明问题存在，回归路径才说明修完怎么验。
    if (!card.regression?.command) blockers.push(`${card.id}：未闭环但没有回归路径（补 regression.command）`);
  }
  if (blockers.length) {
    console.error("✗ 交接被拒：未闭环项必须逐项给出回归路径");
    for (const item of blockers) console.error(`  - ${item}`);
    process.exit(1);
  }
  const env = arg("--env", ledger.environment?.kind ?? "unknown");
  const repo = ledger.repo ?? basename(repoRoot(arg("--repo", ".")));
  const handoff = {
    schema: "workloom.mine-clear/handoff@1",
    task_id: ledger.task_id,
    repo,
    generated_at: nowIso(),
    audit_baseline: ledger.baseline?.audit?.commit ?? null,
    repair_baseline: ledger.baseline?.repair?.commit ?? null,
    acceptance_baseline: ledger.baseline?.acceptance?.commit ?? null,
    environment_claim: env,
    invariants: ledger.invariants ?? [],
    closed_problems: closed.map((card) => ({
      id: card.id,
      title: card.title,
      verified_by: card.verified_by,
      verified_at: card.verified_at,
      verification_evidence: card.verification_evidence,
      assertions: (card.assertions ?? []).map((item) => ({ kind: item.kind, given: item.given, expect: item.expect, command: item.command, last_result: item.last_result ?? "not-run" })),
    })),
    open_problems: open.map((card) => ({
      id: card.id,
      kind: card.kind,
      state: card.state,
      severity: card.severity ?? null,
      title: card.title,
      evidence: card.evidence?.[0]?.ref ?? null,
      root_cause: card.root_cause ? `${card.root_cause.file}:${card.root_cause.line ?? "?"}@${card.root_cause.commit}` : null,
      fix_plan: card.fix_plan ?? null,
      regression: card.regression?.command ?? null,
    })),
    acceptance_commands: [
      "pnpm acceptance:profile:check",
      `node scripts/acceptance/fleet-run.mjs --repo ${repo} --env ${env}`,
      `node scripts/acceptance/fleet-run.mjs --repo ${repo} --env ${env} --live-only   # 生产最小侵入档`,
    ],
    notes: env === "local-preview"
      ? "环境档位为 local-preview：报告只能写『本机预览结构验收』，不得写『生产实测通过』（RDAS v3.1 §0）"
      : "交接前确认验收基线是修复基线的后代：git merge-base --is-ancestor <修复commit> <验收commit>",
  };
  const outDir = resolve(arg("--out", dirname(ledgerPath)));
  const handoffPath = join(outDir, "handoff.json");
  writeJsonFile(handoffPath, handoff);

  ledger.handoff = {
    generated_at: handoff.generated_at,
    acceptance_command: handoff.acceptance_commands[1],
    open_problem_ids: handoff.open_problems.map((item) => item.id),
  };
  ledger.environment = { ...(ledger.environment ?? {}), kind: env };
  ledger.updated_at = nowIso();
  writeJsonFile(ledgerPath, ledger);

  if (has("--json")) {
    console.log(JSON.stringify({ handoff: handoffPath, closed: handoff.closed_problems.length, open: handoff.open_problems.length }, null, 2));
    return;
  }
  ok(`交接单已生成：${handoffPath}`);
  note(`已闭环 ${handoff.closed_problems.length} 项 / 未闭环 ${handoff.open_problems.length} 项 / 环境档位 ${env}`);
  note(`验收命令：${handoff.acceptance_commands[1]}`);
  if (handoff.open_problems.length) {
    warn("未闭环清单（验收报告需逐项给回归路径）：");
    for (const item of handoff.open_problems) console.log(`  - ${item.id} [${item.state}] ${item.title}`);
  }
}

// ---------------------------------------------------------------- 入口

const command = process.argv[2] ?? "help";
const run = {
  init: commandInit,
  invariants: commandInvariants,
  "card-template": commandCardTemplate,
  add: commandAdd,
  gate: commandGate,
  status: commandStatus,
  plan: commandPlan,
  "verify-baseline": commandVerifyBaseline,
  handoff: commandHandoff,
}[command];

if (command === "help" || command === "--help" || command === "-h") {
  process.stdout.write(HELP);
  process.exit(0);
}
if (!run) {
  console.error(`未知命令：${command}\n`);
  process.stdout.write(HELP);
  process.exit(2);
}
try {
  run();
} catch (error) {
  die(error?.message ?? String(error), 2);
}
