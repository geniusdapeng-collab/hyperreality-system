/** Shared read-back evidence contract. Node built-ins only; never executes commands while validating. */
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const RUN_SCHEMA = "workloom.evidence-run/v1";
export const ITEM_SCHEMA = "workloom.acceptance-item/v1";
export const INDEX_SCHEMA = "workloom.evidence-index/v1";
export const hashBytes = (bytes) => createHash("sha256").update(bytes).digest("hex");
const SHA = /^[0-9a-f]{40}$/i;
const HASH = /^[0-9a-f]{64}$/i;
const date = (value) => typeof value === "string" ? Date.parse(value) : NaN;
const jsonEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const validValidation = (value) => value && typeof value === "object" && !Array.isArray(value) && typeof value.ok === "boolean" && Array.isArray(value.errors) && value.errors.every((error) => typeof error === "string" && error.trim()) && value.ok === (value.errors.length === 0);
const NODE_REPORTER = fileURLToPath(new URL("./node-test-reporter.mjs", import.meta.url));
const isNodeTest = (spec) => spec && /^(node|nodejs)(\.exe)?$/i.test(basename(spec.file)) && spec.args?.includes("--test");

function observedNodeExec(requested, reporter, destination) {
  const count = (flag) => requested.args.filter((arg) => arg === flag || arg.startsWith(`${flag}=`)).length;
  const reporters = count("--test-reporter"); const destinations = count("--test-reporter-destination");
  if (destinations !== 0 && destinations !== reporters) throw new Error("Node reporter/destination 数量不一致，无法安全添加测试观测器");
  const injected = [`--test-reporter=${reporter}`, `--test-reporter-destination=${destination}`];
  if (reporters === 0) injected.push("--test-reporter=tap", "--test-reporter-destination=stdout");
  else if (destinations === 0) for (let i = 0; i < reporters; i++) injected.push("--test-reporter-destination=stdout");
  return { file: requested.file, args: [...injected, ...requested.args] };
}

function readNodeSummary(bytes) {
  const rows = bytes.toString("utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  if (rows.length !== 1 || rows[0].schema !== "workloom.node-test-summary/v1" || rows[0].aggregate !== true) throw new Error("缺唯一 Node TestsStream 机器摘要");
  const summary = rows[0];
  if (!["tests", "passed", "failed", "cancelled", "skipped", "todo", "files"].every((key) => Number.isSafeInteger(summary[key]) && summary[key] >= 0) || typeof summary.success !== "boolean") throw new Error("Node 机器摘要计数非法");
  return summary;
}
const nodeCounts = (summary) => ({ total: summary.tests, passed: summary.passed, failed: summary.failed, cancelled: summary.cancelled, skipped: summary.skipped, todo: summary.todo });

export function validateExecSpec(spec) {
  if (!spec || typeof spec.file !== "string" || !spec.file.trim() || !Array.isArray(spec.args) || !spec.args.every((arg) => typeof arg === "string" && !arg.includes("\0")) || spec.file.includes("\0") || Object.keys(spec).some((key) => !["file", "args"].includes(key))) throw new Error("assertion.exec 必须仅含非空 file 和字符串 args 数组（直接 argv，不经 shell）");
  return spec;
}

export function gitRead(repoRoot, args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();
}

export function resolveCommit(repoRoot, value) {
  if (!/^[0-9a-f]{7,40}$/i.test(String(value ?? ""))) throw new Error("缺少可解析的 Git commit");
  const commit = gitRead(repoRoot, ["rev-parse", "--verify", `${value}^{commit}`]);
  if (!SHA.test(commit)) throw new Error("Git commit 不是完整 SHA");
  return commit;
}

export function revisionOf(repoRoot) {
  const commit = resolveCommit(repoRoot, gitRead(repoRoot, ["rev-parse", "HEAD"]));
  const dirty = gitRead(repoRoot, ["status", "--porcelain", "--untracked-files=normal"]).length > 0;
  return { commit, dirty };
}

export function isAncestor(repoRoot, ancestor, descendant) {
  // Git distinguishes a false relationship (1) from an operational error (>1).
  const a = resolveCommit(repoRoot, ancestor); const b = resolveCommit(repoRoot, descendant);
  const result = spawnSync("git", ["merge-base", "--is-ancestor", a, b], { cwd: repoRoot, encoding: "utf8" });
  if (result.error || ![0, 1].includes(result.status)) throw new Error("无法核验 Git 后代关系");
  return result.status === 0;
}

function safeFile(root, path) {
  if (typeof path !== "string" || !path || path.includes("\0")) throw new Error("证据 path 缺失或非法");
  const base = resolve(root);
  const abs = isAbsolute(path) ? resolve(path) : resolve(base, path);
  const rel = relative(base, abs);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("证据路径越出产物根目录");
  let part = base;
  for (const segment of rel.split(sep)) {
    part = join(part, segment);
    if (lstatSync(part).isSymbolicLink()) throw new Error("证据路径不得是 symlink");
  }
  const stat = lstatSync(abs);
  if (!stat.isFile() || stat.size === 0) throw new Error("证据必须是非空真实文件，目录不能替代文件");
  const realBase = realpathSync(base); const real = realpathSync(abs);
  if (!real.startsWith(`${realBase}${sep}`)) throw new Error("证据 realpath 越界");
  return { abs, path: rel.split(sep).join("/") };
}

export function bindArtifact(artifactRoot, path, commit) {
  if (!SHA.test(String(commit ?? ""))) throw new Error("证据绑定必须使用完整 commit SHA");
  const file = safeFile(artifactRoot, path);
  return { path: file.path, sha256: hashBytes(readFileSync(file.abs)), commit };
}

export function verifyArtifact(ref, { artifactRoot, commit, label = "证据" } = {}) {
  const errors = [];
  let bytes = null;
  if (!ref || typeof ref !== "object" || Array.isArray(ref)) return { ok: false, errors: [`${label} 必须含 path/sha256/commit，裸路径不是执行证据`], bytes };
  if (!SHA.test(String(ref.commit ?? "")) || ref.commit !== commit) errors.push(`${label} commit 与验收基线不一致或不是完整 SHA`);
  if (!HASH.test(String(ref.sha256 ?? ""))) errors.push(`${label} 缺有效 sha256`);
  try {
    const { abs } = safeFile(artifactRoot, ref.path); bytes = readFileSync(abs);
    if (hashBytes(bytes) !== ref.sha256) errors.push(`${label} sha256 与真实文件不一致`);
  } catch (error) { errors.push(`${label} 文件不可回读：${error.code ?? error.message}`); }
  return { ok: errors.length === 0, errors, bytes };
}

export function verifyRun(ref, { artifactRoot, repoRoot, commit, command, actor, role, subject, requirePass = true, cache = null, label = "运行记录" } = {}) {
  const key = JSON.stringify([ref, commit]);
  let base = cache?.get(key);
  if (!base) {
    const result = verifyArtifact(ref, { artifactRoot, commit, label });
    const errors = [...result.errors]; let data = null;
    if (result.ok) {
      try {
        data = JSON.parse(result.bytes);
        if (!data || typeof data !== "object" || Array.isArray(data)) { errors.push(`${label} JSON 顶层必须为运行记录对象`); data = null; }
      } catch { errors.push(`${label} 不是 JSON`); }
    }
    if (data) {
      if (data.schema !== RUN_SCHEMA) errors.push(`${label} schema 必须为 ${RUN_SCHEMA}`);
      if (typeof data.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(data.id)) errors.push(`${label} 缺安全的运行 id`);
      if (data.commit !== commit) errors.push(`${label} 运行 commit 与基线不一致`);
      if (data.working_tree_dirty !== false) errors.push(`${label} 被测代码未记录干净提交`);
      if (typeof data.command !== "string" || !data.command.trim()) errors.push(`${label} 缺 command`);
      if (typeof data.actor !== "string" || !data.actor.trim()) errors.push(`${label} 缺执行 actor`);
      if (!["discovery", "repair", "acceptance", "automation", "manual"].includes(data.role)) errors.push(`${label} 缺有效执行角色`);
      const start = date(data.started_at); const end = date(data.finished_at);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end > Date.now() + 300_000) errors.push(`${label} 执行时间缺失、逆序或未来时间`);
      const validation = data.validation ?? { ok: true, errors: [] };
      if (!validValidation(validation)) errors.push(`${label} assertion validation 必须有一致的 ok/errors`);
      if (!Number.isInteger(data.exit_code) || data.exit_code < 0 || !["pass", "fail"].includes(data.result) || (data.result === "pass") !== (data.exit_code === 0 && !data.signal && validValidation(validation) && validation.ok)) errors.push(`${label} result 与实际退出码/信号/断言观测矛盾`);
      try {
        const full = resolveCommit(repoRoot, data.commit);
        if (full !== data.commit) errors.push(`${label} 运行 commit 不可解析`);
        const commitAt = Number(gitRead(repoRoot, ["show", "-s", "--format=%ct", data.commit])) * 1000;
        if (Number.isFinite(start) && start < commitAt) errors.push(`${label} 运行时间早于绑定提交（过期证据）`);
      } catch { errors.push(`${label} Git commit 不存在`); }
      if (!Array.isArray(data.outputs) || data.outputs.length === 0) errors.push(`${label} 缺真实输出文件清单`);
      else for (const [i, output] of data.outputs.entries()) errors.push(...verifyArtifact(output, { artifactRoot, commit, label: `${label}.outputs[${i}]` }).errors);
      if (isNodeTest(data.requested_exec ?? data.exec)) {
        const observer = data.node_observer;
        if (!observer) { if (data.result === "pass") errors.push(`${label} Node 测试缺实际 TestsStream 逐文件摘要，不能用外层文件加载成功作为断言`); }
        else {
          try {
            validateExecSpec(data.requested_exec); validateExecSpec(data.exec);
            if (observer.schema !== "workloom.node-test-observer/v1" || observer.reporter_sha256 !== hashBytes(readFileSync(NODE_REPORTER)) || !isAbsolute(observer.reporter_path) || !isAbsolute(observer.destination) || !jsonEqual(data.exec, observedNodeExec(data.requested_exec, observer.reporter_path, observer.destination))) throw new Error("Node observer/实际 argv 与受控执行器不同");
            if (observer.summary) {
              if (!(data.outputs ?? []).some((ref) => jsonEqual(ref, observer.summary))) throw new Error("Node 机器摘要不属于本次执行输出");
              const proof = verifyArtifact(observer.summary, { artifactRoot, commit, label: `${label}.node-summary` });
              if (!proof.ok) throw new Error("Node 机器摘要不可回读");
              const summary = readNodeSummary(proof.bytes);
              if (!jsonEqual(validation.testSummary, nodeCounts(summary)) || (validation.ok && (summary.files <= 0 || summary.passed <= 0 || summary.failed !== 0 || summary.cancelled !== 0 || summary.success !== true))) throw new Error("Node 机器摘要与断言校验不同或没有实际通过测试");
            } else if (data.result === "pass") throw new Error("Node pass 缺真实机器摘要");
          } catch (error) { errors.push(`${label} ${error.message}`); }
        }
      } else if (data.requested_exec || data.node_observer) errors.push(`${label} 非 Node 测试不能声明 Node observer`);
    }
    base = { errors, data }; cache?.set(key, base);
  }
  const errors = [...base.errors]; const data = base.data;
  if (data) {
    if (requirePass && (data.result !== "pass" || data.exit_code !== 0 || data.signal)) errors.push(`${label} 实际断言未通过`);
    if (command !== undefined && data.command !== command) errors.push(`${label} command 与声明不一致`);
    if (actor !== undefined && data.actor !== actor) errors.push(`${label} actor 与验证者不一致`);
    if (role !== undefined && data.role !== role) errors.push(`${label} role 不是独立 ${role} 角色`);
    if (subject !== undefined && !jsonEqual(data.subject, subject)) errors.push(`${label} 不属于该卡/断言`);
  }
  return { ok: errors.length === 0, errors, data };
}

function writeJson(path, value) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); }
const safeId = (id) => { if (!/^[A-Za-z0-9_-]+$/.test(String(id))) throw new Error("runId 必须是安全文件名"); return id; };

/** Called by a real executor after observing its process exit; never infers pass from file presence. */
export function recordEvidenceRun({ repoRoot, artifactRoot, runId, command, actor, role = "automation", exitCode, signal = null, startedAt, finishedAt = new Date().toISOString(), outputPaths, exec = null, subject = null, validation = { ok: true, errors: [] }, requestedExec = null, nodeObserver = null }) {
  if (!Number.isInteger(exitCode) || exitCode < 0) throw new Error("运行记录必须提供实际非负整数 exitCode（未运行不能记 pass）");
  if (!validValidation(validation)) throw new Error("运行记录 assertion validation 必须有一致的 ok/errors");
  if (typeof command !== "string" || !command.trim() || typeof actor !== "string" || !actor.trim()) throw new Error("运行记录缺 command/actor");
  if (!["discovery", "repair", "acceptance", "automation", "manual"].includes(role)) throw new Error("运行记录缺有效执行角色");
  if (!Number.isFinite(date(startedAt)) || !Number.isFinite(date(finishedAt)) || date(finishedAt) < date(startedAt) || date(finishedAt) > Date.now() + 300_000) throw new Error("运行记录必须提供有效且顺序一致的实际起止时间");
  if (!Array.isArray(outputPaths) || !outputPaths.length) throw new Error("运行记录至少含一个实际输出文件");
  const { commit, dirty } = revisionOf(repoRoot);
  const artifacts = outputPaths.map((p) => bindArtifact(artifactRoot, p, commit));
  if (!artifacts.length) throw new Error("运行记录至少含一个实际输出文件");
  const observer = nodeObserver ? { ...nodeObserver, summary: artifacts.find((ref) => ref.path === nodeObserver.summaryPath) ?? null } : null;
  if (observer) delete observer.summaryPath;
  const body = { schema: RUN_SCHEMA, id: safeId(runId), command, exec, ...(requestedExec ? { requested_exec: requestedExec, node_observer: observer } : {}), actor, role, subject, commit, working_tree_dirty: dirty, started_at: startedAt, finished_at: finishedAt, exit_code: exitCode, signal, validation, result: exitCode === 0 && !signal && validation.ok ? "pass" : "fail", outputs: artifacts };
  const path = `runs/${body.id}.json`;
  if (existsSync(join(artifactRoot, path))) throw new Error(`运行记录不可覆盖：${path}`);
  writeJson(join(artifactRoot, path), body); const runRef = bindArtifact(artifactRoot, path, commit);
  const indexPath = join(artifactRoot, "evidence-index.json");
  let index = { schema: INDEX_SCHEMA, commit, runs: [], artifacts: [] };
  if (existsSync(indexPath)) {
    index = JSON.parse(readFileSync(indexPath, "utf8"));
    if (index.schema !== INDEX_SCHEMA || index.commit !== commit) throw new Error("不能混写不同提交的 evidence-index");
  }
  index.runs.push(runRef);
  const byPath = new Map(index.artifacts.map((ref) => [ref.path, ref]));
  for (const ref of artifacts) byPath.set(ref.path, ref);
  index.artifacts = [...byPath.values()]; writeJson(indexPath, index);
  return { ...body, runRef, artifacts, commit };
}

/** Explicitly invoked command capture for MCD. exec is an argv vector, not a shell string. */
export function captureEvidenceRun(options) {
  const spec = validateExecSpec(options.exec);
  const startedAt = new Date().toISOString();
  const revision = revisionOf(options.repoRoot);
  if (revision.dirty) throw new Error("断言执行前必须提交被测源码，不能把工作树结果绑定到旧 commit");
  const outputPath = `evidence/${safeId(options.runId)}.txt`;
  mkdirSync(dirname(join(options.artifactRoot, outputPath)), { recursive: true });
  const nodeTest = isNodeTest(spec); const summaryPath = `evidence/${safeId(options.runId)}-node-tests.jsonl`;
  const destination = resolve(options.artifactRoot, summaryPath);
  const observedExec = nodeTest ? observedNodeExec(spec, NODE_REPORTER, destination) : spec;
  const observer = nodeTest ? { schema: "workloom.node-test-observer/v1", reporter_path: NODE_REPORTER, reporter_sha256: hashBytes(readFileSync(NODE_REPORTER)), destination, summaryPath } : null;
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  // node:test's internal child marker must not turn a nested CLI assertion into a zero-test exit 0.
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(observedExec.file, observedExec.args, { cwd: options.repoRoot, encoding: "utf8", shell: false, timeout: options.timeoutMs ?? 60_000, maxBuffer: 8 * 1024 * 1024, env });
  if (revisionOf(options.repoRoot).commit !== revision.commit || revisionOf(options.repoRoot).dirty) throw new Error("断言执行中被测源码发生变化，结果不可绑定");
  const validation = { ok: true, errors: [] };
  const outputPaths = [outputPath];
  if (nodeTest) {
    try {
      const summary = readNodeSummary(readFileSync(destination)); validation.testSummary = nodeCounts(summary); outputPaths.push(summaryPath);
      if (summary.files <= 0 || summary.tests <= 0 || summary.passed <= 0 || summary.failed !== 0 || summary.cancelled !== 0 || summary.success !== true || summary.passed + summary.failed > summary.tests) throw new Error("Node TestsStream 没有非零实际 passed/逐文件摘要或存在失败/取消；文件加载成功不能替代逐文件真实断言");
    } catch (error) { validation.ok = false; validation.errors.push(error.code ? `Node TestsStream 机器摘要不可读：${error.code}` : error.message); }
  }
  // Secret values inherited from the executor are redacted before persistence.
  let output = `${result.stdout ?? ""}\n${result.stderr ?? ""}\nexit_code=${result.status ?? "null"} signal=${result.signal ?? "none"} error=${result.error?.code ?? "none"}\nassertion_validation=${JSON.stringify(validation)}\n`;
  for (const [key, value] of Object.entries(process.env)) if (/TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY/i.test(key) && value && value.length >= 4) output = output.split(value).join("[REDACTED]");
  output = output.replace(/\b((?:Proxy-)?Authorization)\s*:\s*(?:Basic|Bearer)\s+[^\s"'<>]+/gi, "$1: [REDACTED]");
  mkdirSync(dirname(join(options.artifactRoot, outputPath)), { recursive: true }); writeFileSync(join(options.artifactRoot, outputPath), output);
  return recordEvidenceRun({ ...options, exec: observedExec, requestedExec: nodeTest ? spec : null, nodeObserver: observer, validation, startedAt, finishedAt: new Date().toISOString(), outputPaths, exitCode: result.status ?? 1, signal: result.signal ?? (result.error ? result.error.code : null) });
}

export function writeAcceptanceItems({ artifactRoot, run, checks }) {
  const paths = new Map(run.artifacts.map((ref) => [ref.path, ref]));
  const written = [];
  for (const check of checks) {
    safeId(check.id);
    const evidence = (check.evidencePaths ?? []).map((p) => {
      const ref = paths.get(p); if (!ref) throw new Error(`${check.id} 证据未被本次 run 捕获：${p}`); return ref;
    });
    if (!evidence.length) throw new Error(`${check.id} 缺条目级实际证据`);
    const body = { schema: ITEM_SCHEMA, id: check.id, commit: run.commit, status: check.status, note: check.note ?? "", command: run.command, actor: run.actor, observed_at: run.finished_at, expected: check.expected, actual: check.actual, evidence, run: run.runRef, ...(check.approval ? { approval: check.approval } : {}) };
    const path = `items/${check.id}.json`; writeJson(join(artifactRoot, path), body); written.push(path);
  }
  return written;
}

export function verifyApproval(approval, { artifactRoot, commit, subject, scope, excludedActors = [], label = "豁免批准" }) {
  const errors = [];
  if (!approval?.reason || !approval?.approved_by || !approval?.approved_at || !approval?.source) return [`${label} 缺 reason/approved_by/approved_at/source（reason 本身不构成批准）`];
  if (excludedActors.includes(approval.approved_by)) errors.push(`${label} 批准者必须独立于修复/验证者`);
  const stamp = date(approval.approved_at);
  if (!Number.isFinite(stamp) || stamp > Date.now() + 300_000) errors.push(`${label} 批准时间非法`);
  const source = verifyArtifact(approval.source, { artifactRoot, commit, label: `${label}.source` }); errors.push(...source.errors);
  if (source.ok) {
    try {
      const data = JSON.parse(source.bytes);
      if (data.schema !== "workloom.evidence-approval/v1" || data.decision !== "approved" || data.reason !== approval.reason || data.commit !== commit || data.approved_by !== approval.approved_by || data.approved_at !== approval.approved_at || data.scope !== scope || !Array.isArray(data.subjects) || !data.subjects.includes(subject)) errors.push(`${label} 批准来源与原因/主体/范围/角色/commit 不一致`);
    } catch { errors.push(`${label} 批准来源不是机器可核验 JSON`); }
  }
  return errors;
}

export function verifyAcceptanceItem(item, { artifactRoot, repoRoot, commit, cache, label = item?.id ?? "条目" }) {
  const errors = [];
  if (item?.schema !== ITEM_SCHEMA) errors.push(`${label} schema 必须为 ${ITEM_SCHEMA}`);
  if (!["pass", "fail", "not-applicable"].includes(item?.status)) errors.push(`${label} 未有通过/失败断言（evidence-present 不能算 pass）`);
  if (item?.commit !== commit) errors.push(`${label} commit 与当前被测提交不一致`);
  if (typeof item?.command !== "string" || !item.command.trim() || typeof item?.actor !== "string" || !item.actor.trim()) errors.push(`${label} 缺条目执行 command/actor`);
  if (typeof item?.expected !== "string" || !item.expected.trim() || item.actual === undefined || item.actual === null) errors.push(`${label} 缺 expected/actual 条目级观测`);
  if (!Number.isFinite(date(item?.observed_at)) || date(item.observed_at) > Date.now() + 300_000) errors.push(`${label} 缺有效 observed_at 或观测时间在未来`);
  const run = verifyRun(item?.run, { artifactRoot, repoRoot, commit, command: item?.command, actor: item?.actor, requirePass: item?.status !== "fail", cache, label: `${label}.run` }); errors.push(...run.errors);
  if (!Array.isArray(item?.evidence) || !item.evidence.length) errors.push(`${label} 缺真实 evidence 文件`);
  else {
    const observations = [];
    for (const [i, ref] of item.evidence.entries()) {
      const evidence = verifyArtifact(ref, { artifactRoot, commit, label: `${label}.evidence[${i}]` }); errors.push(...evidence.errors);
      if (run.data && !(run.data.outputs ?? []).some((output) => jsonEqual(output, ref))) errors.push(`${label} 文件未绑定到该次实际执行输出`);
      if (evidence.ok) {
        try {
          const source = JSON.parse(evidence.bytes);
          const list = [...(Array.isArray(source.checks) ? source.checks : []), ...(Array.isArray(source.items) ? source.items : []), ...(source.id === item.id ? [source] : [])];
          observations.push(...list.filter((check) => check.id === item.id));
        } catch { /* Raw transcripts/screenshots support evidence, but cannot alone assert an item pass. */ }
      }
    }
    if (item.status !== "not-applicable") {
      if (!observations.length) errors.push(`${label} 绑定文件没有同 ID 的实际检查，聚合摘要不能替代逐项断言`);
      else if (item.status === "pass" && !observations.every((check) => check.pass === true || (check.pass !== false && check.status === "pass"))) errors.push(`${label} 证据中的该项断言没有全部通过`);
      else if (item.status === "fail" && !observations.some((check) => check.pass === false || check.status === "fail")) errors.push(`${label} fail 声明没有实际失败观测`);
      if (observations.length) {
        const values = [...new Map(observations.map((check) => {
          const observed = { expected: check.expected ?? check.name ?? "", actual: check.actual };
          return [JSON.stringify(observed), observed];
        })).values()];
        const expected = values.map((check) => check.expected).join("；");
        const actual = values.length === 1 ? values[0].actual : values.map((check) => check.actual);
        if (item.expected !== expected || !jsonEqual(item.actual, actual)) errors.push(`${label} expected/actual 与绑定的同 ID 原始观测不一致`);
      }
    }
  }
  if (run.data && date(item.observed_at) < date(run.data.finished_at)) errors.push(`${label} 观测时间早于实际运行完成`);
  if (item?.status === "not-applicable") errors.push(...verifyApproval(item.approval, { artifactRoot, commit, subject: item.id, scope: "not-applicable", excludedActors: [item.actor], label: `${label}.approval` }));
  return { ok: errors.length === 0, errors, run: run.data };
}
