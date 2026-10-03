/** Real child processes implementing the pinned callback contract; the runtime and provider are synthetic. */
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createBudget, normalizeBudgets } from "./budget.mjs";
import { runDshTask } from "./providers.mjs";
import { verifyExpectations } from "./verification.mjs";

// Written to a separate executable: runDshTask uses its real spawn, init, patch,
// audit observer and per-stream budget implementation, with no network or keys.
async function fakeDshMain() {
  const fs = require("node:fs"); const path = require("node:path"); const url = require("node:url");
  const home = process.env.DSH_HOME; const profile = path.join(home, "profiles/headless");
  if (process.argv.includes("--dump-config")) { fs.mkdirSync(profile, { recursive: true }); fs.writeFileSync(path.join(profile, "package.json"), '{"type":"module"}'); return; }
  const patch = fs.readFileSync(path.join(profile, "cordis.patch.yml"), "utf8");
  const value = (key) => { const matched = patch.match(new RegExp(`^\\s*${key}: '((?:[^']|'')*)'`, "m")); if (!matched) throw new Error(`missing ${key}`); return matched[1].replace(/''/g, "'"); };
  const auditFile = value("file"); const budgetConfigFile = value("budgetConfigFile");
  const options = JSON.parse(fs.readFileSync(budgetConfigFile, "utf8"));
  const pluginPath = patch.match(/name: '([^']+\/audit\.plugin\.mjs)'/)[1];
  const { apply } = await import(url.pathToFileURL(pluginPath));
  const listeners = new Map(); apply({ on: (name, listener) => listeners.set(name, listener) }, { file: auditFile, budgetConfigFile });
  const mode = process.env.DSH_SYNTHETIC_MODE; const model = mode === "approved-model-swap" ? "actual-returned-model" : value("model");
  const session = { id: "synthetic-dsh-process-session" }; let seq = 0; let requests = 0;
  const emit = (type, data) => listeners.get("session/event")(session, { type, data, seq: seq++, time: Date.now() });
  fs.writeFileSync(path.join(options.outDir, "synthetic-child-environment.json"), JSON.stringify({ keys: Object.keys(process.env).sort(), home, endpoint: value("baseURL"), credentialWritten: patch.includes(process.env.DEEPSEEK_API_KEY) }));
  emit("turn/start", { turn: 0 }); emit("step/start", { turn: 0, step: 0 });
  emit("request/header", { header: { config: { provider: "deepseek-official", model } } });
  const usage = { inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 10 };
  const chunks = [{ type: "usage", usage }, { type: "finish", reason: { kind: "stop" } }];
  const next = async function* () {
    fs.writeFileSync(path.join(options.outDir, "synthetic-provider-calls.json"), JSON.stringify({ count: ++requests }));
    if (mode === "abrupt") process.exit(23);
    if (mode === "timeout") await new Promise((resolve) => setTimeout(resolve, 10000));
    if (mode === "missing-usage") { yield chunks[1]; return; }
    for (const chunk of chunks) yield chunk;
  };
  const request = { provider: "deepseek-official", model: mode === "model-swap" ? "unapproved-model" : model };
  const attempt = async () => { const stream = []; for await (const chunk of listeners.get("llm/stream")(request, next)) stream.push({ type: "chunk", time: Date.now(), chunk }); return stream; };
  if (mode === "retry" || mode === "call-cap") {
    emit("assistant/attempt", { turn: 0, step: 0, stream: await attempt() });
    emit("llm/retry", { turn: 0, step: 0, retry: 1 }); emit("llm/retry-started", { turn: 0, step: 0, retry: 1 });
  }
  const stream = await attempt();
  emit("assistant/message", { turn: 0, step: 0, usage, stream, message: { source: { kind: "model", provider: "deepseek-official", model }, content: [{ type: "text", text: "TASK_COMPLETE synthetic process" }] } });
  emit("step/end", { turn: 0, step: 0 });
  if (mode === "unknown-event") emit("future/required", { reason: "unsupported accounting boundary" });
  emit("turn/end", { turn: 0, reason: { kind: mode === "terminal-error" ? "error" : "completed" } });
  if (mode === "audit-tamper") fs.appendFileSync(auditFile, "{truncated\n");
  console.log("TASK_COMPLETE synthetic stdout cannot replace the durable evidence");
}

function fixture(t, mode = "complete", caps = {}) {
  const repoRoot = mkdtempSync(join(tmpdir(), "workloom-live-dsh-process-")); t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  const gate = join(repoRoot, "packages/runtime/dsh-gate"); const bin = join(gate, "node_modules/.bin/dsh");
  mkdirSync(dirname(bin), { recursive: true }); mkdirSync(join(gate, "node_modules/@deepseek-ai/dsh"), { recursive: true });
  writeFileSync(bin, `#!/usr/bin/env node\n(${fakeDshMain.toString()})().catch((error) => { console.error(error.message); process.exitCode = 1; });\n`, { mode: 0o700 });
  writeFileSync(join(gate, "node_modules/@deepseek-ai/dsh/package.json"), JSON.stringify({ version: "0.2.0-rc.2", fixture: true }));
  writeFileSync(join(gate, "profile.cordis.patch.yml"), "# synthetic gate template\n");
  for (const file of ["audit.plugin.mjs", "budget.mjs", "usage.mjs"]) {
    const target = join(repoRoot, "scripts/acceptance/lib/live", file); mkdirSync(dirname(target), { recursive: true }); copyFileSync(fileURLToPath(new URL(file, import.meta.url)), target);
  }
  const workDir = join(repoRoot, "outputs/live"); mkdirSync(workDir, { recursive: true });
  const budgetOptions = { outDir: workDir, runId: "synthetic-run", environmentKind: "synthetic", budgets: normalizeBudgets(caps).budgets };
  const budget = createBudget(budgetOptions);
  const options = { repoRoot, workDir, model: "deepseek-flash", prompt: "synthetic", rulesFile: join(workDir, "synthetic-rules.json"), taskId: "LLM-R1", budgetOptions, expectedTokens: 100, timeoutMs: 5000, baseUrl: "http://127.0.0.1:1/explicit-anthropic", env: { DEEPSEEK_API_KEY: "synthetic-not-a-real-key", DSH_SYNTHETIC_MODE: mode } };
  writeFileSync(options.rulesFile, "[]\n");
  return { ...options, options, budget, requests: () => existsSync(join(workDir, "synthetic-provider-calls.json")) ? JSON.parse(readFileSync(join(workDir, "synthetic-provider-calls.json"))).count : 0 };
}

test("DSH subprocess: init, explicit endpoint, audited terminal result and exact shared usage jointly complete", async (t) => {
  const f = fixture(t); process.env.SYNTHETIC_PARENT_PASSWORD = "never-pass-to-child"; t.after(() => { delete process.env.SYNTHETIC_PARENT_PASSWORD; });
  const result = await runDshTask(f.options);
  assert.equal(result.status, "ok", JSON.stringify(result)); assert.equal(result.tokens, 10); assert.equal(result.calls, 1); assert.equal(result.receipt.synced, true); assert.equal(f.requests(), 1);
  assert.equal(result.audit.chain.ok, true); assert.equal(f.budget.summary().actual.llmTokens, 10); assert.equal(f.budget.summary().used.llmTokens, 100);
  const actual = JSON.parse(readFileSync(join(f.workDir, "synthetic-child-environment.json")));
  assert.equal(actual.endpoint, f.baseUrl); assert.equal(actual.credentialWritten, false); assert.equal(actual.keys.includes("SYNTHETIC_PARENT_PASSWORD"), false); assert.equal(actual.home, join(f.workDir, "dsh-home"));
  assert.equal(readFileSync(result.evidence.patchPath, "utf8").includes("@deepseek-ai/dsh-llm-deepseek-api-key"), true);
});

test("DSH subprocess: each retried physical request is separately reserved and actual tokens sum", async (t) => {
  const f = fixture(t, "retry"); const result = await runDshTask(f.options);
  assert.equal(result.status, "ok", result.reason); assert.equal(result.calls, 2); assert.equal(result.tokens, 20); assert.equal(f.requests(), 2);
  assert.equal(f.budget.summary().reservations.length, 2); assert.equal(f.budget.summary().used.llmTokens, 200);
});

test("DSH subprocess: an allowed returned model is observed independently from the requested route", async (t) => {
  const f = fixture(t, "approved-model-swap");
  const result = await runDshTask({ ...f.options, allowedModels: ["actual-returned-model"] });
  assert.equal(result.status, "ok", result.reason); assert.equal(f.requests(), 1);
  assert.equal(result.model, "actual-returned-model"); assert.equal(result.receipt.model, "actual-returned-model");
  assert.equal(result.receipt.requestedModel, f.model);
  assert.equal((await verifyExpectations({ kind: "llm", expectedModel: f.model, allowedModels: ["actual-returned-model"] }, result)).ok, true);
  assert.equal((await verifyExpectations({ kind: "llm", expectedModel: f.model }, result)).ok, false);
});

test("DSH subprocess: call cap rejects retry before its provider executes", async (t) => {
  const f = fixture(t, "call-cap", { maxLlmCalls: 1 }); const result = await runDshTask(f.options);
  assert.equal(result.status, "blocked"); assert.equal(result.receipt.synced, false); assert.equal(f.requests(), 1); assert.equal(f.budget.summary().actual.llmCalls, 1);
  assert.equal(f.budget.summary().blocked.length, 1);
});

for (const mode of ["missing-usage", "abrupt", "audit-tamper", "unknown-event"]) {
  test(`DSH subprocess: ${mode} cannot fabricate usage or allow a later modality`, async (t) => {
    const f = fixture(t, mode); const result = await runDshTask(f.options);
    assert.equal(result.status, "blocked", result.reason); assert.equal(result.tokens, null); assert.equal(result.receipt.synced, false); assert.equal(f.requests(), 1);
    assert.equal(f.budget.summary().measurementComplete, false);
    assert.equal(f.budget.reserve({ taskId: "IMG-01", kind: "image", units: 1 }).allowed, false);
    if (["missing-usage", "abrupt"].includes(mode)) assert.equal(f.budget.summary().unmeasured.llmTokens, 100);
  });
}

test("DSH subprocess: timeout kills the process group and conservatively settles an admitted request", async (t) => {
  const f = fixture(t, "timeout"); const profile = join(f.workDir, "dsh-home/profiles/headless"); mkdirSync(profile, { recursive: true }); writeFileSync(join(profile, "package.json"), "{}");
  // Allow cold module loading under the concurrent suite before the deliberately
  // blocked provider; this timeout still ends far before its ten-second stream.
  const result = await runDshTask({ ...f.options, timeoutMs: 2000 });
  assert.equal(result.status, "blocked"); assert.equal(result.exitCode, -9); assert.equal(f.requests(), 1); assert.equal(f.budget.summary().unmeasured.llmCalls, 1); assert.equal(f.budget.summary().pending.llmCalls, 0);
});

test("DSH subprocess: unapproved model is rejected before its provider and cannot use printed completion", async (t) => {
  const f = fixture(t, "model-swap"); const result = await runDshTask(f.options);
  assert.equal(result.status, "blocked"); assert.equal(result.called, false); assert.equal(f.requests(), 0); assert.equal(f.budget.summary().reservations.length, 0);
});

test("DSH subprocess: complete usage with an error terminal remains failed", async (t) => {
  const f = fixture(t, "terminal-error"); const result = await runDshTask(f.options);
  assert.equal(result.status, "failed"); assert.equal(result.tokens, 10); assert.equal(result.usage.complete, true); assert.equal(result.usage.completed, false); assert.equal(result.receipt.synced, false);
});

test("DSH subprocess: unknown installed runtime, forbidden rules credential and out-of-run HOME block before child I/O", async (t) => {
  for (const extra of [{ rulesToken: "synthetic-secret" }, { home: tmpdir() }]) {
    const f = fixture(t); const result = await runDshTask({ ...f.options, ...extra }); assert.equal(result.status, "blocked"); assert.equal(f.requests(), 0);
  }
  const f = fixture(t); writeFileSync(join(f.repoRoot, "packages/runtime/dsh-gate/node_modules/@deepseek-ai/dsh/package.json"), '{"version":"unverified"}');
  assert.equal((await runDshTask(f.options)).status, "blocked"); assert.equal(f.requests(), 0);
});
