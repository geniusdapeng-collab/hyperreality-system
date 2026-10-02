/** Actual regression commands and the aggregate summary are separate, verifiable executions. */
import { readFileSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { revisionOf, verifyArtifact, verifyRun } from "../../delivery/evidence.mjs";

export const REGRESSION_SCHEMA = "workloom.acceptance-regression/v2";
export const COMMAND_OBSERVATION_SCHEMA = "workloom.command-observation/v1";
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const validName = (name) => typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9:_./-]*$/.test(name);

export function verifyRegressionExecution(name, entry, context) {
  const errors = [];
  if (!validName(name)) errors.push("回归命令名非法");
  const proof = verifyRun(entry?.run, { ...context, requirePass: false, label: `${name}.run` });
  errors.push(...proof.errors);
  const run = proof.data;
  let observation = null;
  if (run) {
    if (run.subject?.commandName !== name || !["regression", "release-gate"].includes(run.subject?.kind) || !Array.isArray(run.exec?.args) || !run.exec.args.includes(name)) errors.push(`${name} 实际 argv/subject 不属于该命令`);
    for (const ref of Array.isArray(run.outputs) ? run.outputs : []) {
      const file = verifyArtifact(ref, { ...context, label: `${name}.observation` });
      if (!file.ok) continue;
      try {
        const value = JSON.parse(file.bytes);
        if (value?.schema !== COMMAND_OBSERVATION_SCHEMA || value.name !== name) continue;
        if (observation) errors.push(`${name} 有多个命令观测文件`);
        observation = value;
      } catch { /* Logs are supporting outputs; the separate machine observation is required below. */ }
    }
    if (!observation || observation.exit_code !== run.exit_code || observation.signal !== run.signal || observation.started_at !== run.started_at || observation.finished_at !== run.finished_at || !same(observation.exec, run.exec)) errors.push(`${name} 缺同一次实际命令的机器观测，或退出码/时间/argv 与 run 不一致`);
  }
  return { ok: errors.length === 0, errors, run, observation };
}

export function buildRegressionSummary({ repoRoot, artifactRoot, input }) {
  const { commit } = revisionOf(repoRoot);
  const errors = [];
  const required = input?.required;
  if (input?.schema !== "workloom.acceptance-regression-input/v1" || input.commit !== commit || !Array.isArray(required) || !required.length || required.some((name) => !validName(name)) || new Set(required).size !== required.length || !input.executions || typeof input.executions !== "object" || Array.isArray(input.executions)) throw new Error("回归汇总输入缺完整提交、唯一非空必需命令清单或实际运行记录");
  const commands = {}; const executions = {};
  let failed = false; let unverified = false;
  for (const name of required) {
    const entry = input.executions[name];
    if (!entry?.run) {
      commands[name] = "未验证：必需命令未执行";
      executions[name] = { status: "unverified", run: null };
      unverified = true; errors.push(`${name} 必需命令没有实际运行记录`); continue;
    }
    const proof = verifyRegressionExecution(name, entry, { repoRoot, artifactRoot, commit });
    errors.push(...proof.errors);
    const run = proof.run;
    const status = !proof.ok ? "unverified" : run.result === "pass" ? "pass" : run.exit_code === 2 ? "unverified" : "fail";
    failed ||= status === "fail"; unverified ||= status === "unverified";
    commands[name] = status === "pass" ? "通过（实际 exit 0）" : status === "fail" ? `失败 exit=${run.exit_code}` : "未验证：运行证据不可回读或命令返回 2";
    executions[name] = { status, run: entry.run, exit_code: run?.exit_code ?? null, signal: run?.signal ?? null, command: run?.command ?? null, exec: run?.exec ?? null, started_at: run?.started_at ?? null, finished_at: run?.finished_at ?? null };
  }
  return { schemaVersion: REGRESSION_SCHEMA, commit, at: new Date().toISOString(), status: failed ? "fail" : unverified ? "unverified" : "pass", required, commands, executions, errors };
}

export function verifyRegressionSummary(summary, context) {
  const errors = [];
  if (summary?.schemaVersion !== REGRESSION_SCHEMA || summary.commit !== context.commit || !Array.isArray(summary.required) || !summary.required.length || new Set(summary.required).size !== summary.required.length || summary.required.some((name) => !validName(name))) return ["回归汇总缺 v2 schema/完整提交/唯一非空必需命令清单"];
  try {
    const aggregate = context.aggregateRun;
    const argv = aggregate?.exec?.args;
    const argument = (flag) => Array.isArray(argv) && argv.filter((value) => value === flag).length === 1 ? argv[argv.indexOf(flag) + 1] : null;
    const repoRoot = realpathSync(context.repoRoot);
    const artifactRoot = realpathSync(context.artifactRoot);
    const matchesPath = (value, expected) => {
      if (typeof value !== "string" || value.trim().length === 0) return false;
      try { return realpathSync(resolve(repoRoot, value)) === realpathSync(expected); }
      catch { return false; }
    };
    if (aggregate?.subject?.step !== "regression-summary" || !Array.isArray(argv) || !matchesPath(argv[0], fileURLToPath(import.meta.url)) || !matchesPath(argument("--repo"), repoRoot) || !matchesPath(argument("--root"), artifactRoot) || !matchesPath(argument("--input"), resolve(artifactRoot, "regression/summary-input.json")) || !matchesPath(argument("--out"), resolve(artifactRoot, "regression/summary.json"))) throw new Error("回归汇总缺实际聚合子进程 argv 与输入/输出身份：执行器、仓库、证据根、输入和输出必须逐路径绑定本次文件");
    const inputRef = aggregate.outputs?.find((ref) => ref?.path === "regression/summary-input.json");
    const inputFile = verifyArtifact(inputRef, { ...context, label: "regression.summary-input" });
    if (!inputFile.ok) throw new Error(`回归聚合输入不可回读：${inputFile.errors.join("；")}`);
    const input = JSON.parse(inputFile.bytes);
    if (!same(input.required, summary.required)) errors.push("回归汇总的必需命令清单与实际聚合输入不同");
    const actual = buildRegressionSummary({ ...context, input });
    errors.push(...actual.errors);
    if (summary.status !== actual.status || !same(summary.commands, actual.commands) || !same(summary.executions, actual.executions) || !same(summary.errors, actual.errors)) errors.push("回归汇总的状态/命令/退出码/错误与各实际运行记录不一致");
    if (actual.status !== "pass") errors.push(`回归必需命令汇总为 ${actual.status}`);
  } catch (error) { errors.push(error.message); }
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const get = (name) => { const index = process.argv.indexOf(name); if (index < 0 || !process.argv[index + 1]) throw new Error(`缺 ${name}`); return resolve(process.argv[index + 1]); };
  try {
    const repoRoot = get("--repo"); const artifactRoot = get("--root"); const inputPath = get("--input"); const outputPath = get("--out");
    const summary = buildRegressionSummary({ repoRoot, artifactRoot, input: JSON.parse(readFileSync(inputPath, "utf8")) });
    mkdirSync(dirname(outputPath), { recursive: true }); writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`[regression-summary] ${summary.status}; actual commands ${summary.required.length}`);
    process.exitCode = summary.status === "pass" ? 0 : summary.status === "fail" ? 1 : 2;
  } catch (error) { console.error(`[regression-summary] ${error.message}`); process.exitCode = 2; }
}
