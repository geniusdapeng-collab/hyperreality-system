import assert from "node:assert/strict";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { createBudget, LIVE_BUDGET_CAPS, normalizeBudgets } from "./budget.mjs";

function directory(t) {
  const out = mkdtempSync(join(tmpdir(), "workloom-budget-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  return out;
}
function budget(t, caps = {}) {
  return createBudget({ budgets: normalizeBudgets(caps).budgets, outDir: directory(t), environmentKind: "synthetic" });
}
const llm = (taskId, tokens) => ({ taskId, kind: "llm", tokens, measured: true });

test("budget: pending reservations and committed usage share the exact token boundary", (t) => {
  const b = budget(t, { maxLlmTokens: 10_000 });
  assert.equal(b.reserve(llm("first", 4000)).allowed, true);
  assert.equal(b.reserve(llm("second", 6000)).allowed, true);
  assert.equal(b.reserve(llm("excess", 1)).allowed, false);
  assert.equal(b.summary().pending.llmTokens, 10_000);
  b.commit(llm("first", 4000)); b.commit(llm("second", 6000));
  assert.equal(b.summary().used.llmTokens, 10_000);
  assert.equal(b.summary().actual.llmTokens, 10_000);
  assert.equal(b.summary().pending.llmTokens, 0);
});

test("budget: sums every independent actual usage and its cost", (t) => {
  const b = budget(t);
  b.reserve(llm("first", 1000)); b.reserve(llm("second", 1000));
  b.commit(llm("first", 2000)); b.commit(llm("second", 3000));
  const s = b.summary();
  assert.equal(s.used.llmTokens, 5000);
  assert.equal(s.actual.llmTokens, 5000);
  assert.equal(s.used.costCny, 0.01);
});

test("budget: identical reserve and commit retries are idempotent, conflicting retries are refused", (t) => {
  const b = budget(t);
  b.reserve(llm("first", 1000));
  assert.equal(b.reserve(llm("first", 1000)).duplicate, true);
  assert.equal(b.reserve(llm("first", 2000)).allowed, false);
  assert.equal(b.commit(llm("first", 2000)).committed, true);
  assert.equal(b.commit(llm("first", 2000)).duplicate, true);
  assert.equal(b.commit(llm("first", 3000)).committed, false);
  assert.equal(b.summary().used.llmCalls, 1);
  assert.equal(b.summary().used.llmTokens, 2000);
  const rows = readFileSync(b.ledgerPath, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(rows.filter((x) => x.event === "reserve").length, 1);
  assert.equal(rows.filter((x) => x.event === "commit").length, 1);
});

test("budget: a new physical attempt requires a new reservationId", (t) => {
  const b = budget(t);
  const first = { ...llm("task", 1000), reservationId: "task:attempt-1" };
  const second = { ...llm("task", 1000), reservationId: "task:attempt-2" };
  b.reserve(first); b.commit(first); b.reserve(second); b.commit(second);
  assert.equal(b.summary().used.llmCalls, 2);
  assert.equal(b.summary().used.llmTokens, 2000);
});

test("budget: smaller actual usage and failed unknown usage do not release the reservation", (t) => {
  const b = budget(t, { maxLlmTokens: 10_000 });
  b.reserve(llm("small", 4000)); b.commit(llm("small", 20));
  b.reserve(llm("failed", 6000)); b.commit({ ...llm("failed", 0), measured: false, status: "failed" });
  assert.equal(b.summary().used.llmTokens, 10_000);
  assert.equal(b.summary().actual.llmTokens, 20);
  assert.equal(b.reserve(llm("next", 1)).allowed, false);
});

test("budget: actual overruns are recorded in full and block later calls", (t) => {
  const b = budget(t, { maxLlmTokens: 10_000 });
  b.reserve(llm("first", 6000));
  assert.deepEqual(b.commit(llm("first", 13_000)).exceeded, ["llmTokens"]);
  assert.equal(b.summary().used.llmTokens, 13_000);
  assert.equal(b.reserve(llm("next", 1)).allowed, false);
});

test("budget: supplied actual cost above the cap cannot be hidden by a smaller estimate", (t) => {
  const b = budget(t, { maxCostCny: 1 });
  b.reserve(llm("first", 1000));
  assert.deepEqual(b.commit({ ...llm("first", 1000), costCny: 2 }).exceeded, ["costCny"]);
  assert.equal(b.summary().used.costCny, 2);
  assert.equal(b.reserve(llm("next", 1)).allowed, false);
});

test("budget: image count, video clip count, duration and actual duration all stay accounted", (t) => {
  const b = budget(t, { maxImages: 1, maxVideoClips: 1 });
  assert.equal(b.reserve({ taskId: "image", kind: "image", units: 1 }).allowed, true);
  b.commit({ taskId: "image", kind: "image", units: 2, measured: true });
  assert.equal(b.summary().used.images, 2);
  assert.equal(b.reserve({ taskId: "video", kind: "video", units: 12 }).allowed, false);
  const v = budget(t, { maxVideoClips: 1 });
  assert.equal(v.reserve({ taskId: "short", kind: "video", units: 9 }).allowed, false);
  assert.equal(v.reserve({ taskId: "long", kind: "video", units: 16 }).allowed, false);
  assert.equal(v.reserve({ taskId: "video", kind: "video", units: 12 }).allowed, true);
  assert.ok(v.commit({ taskId: "video", kind: "video", units: 16, measured: true }).exceeded.includes("videoDuration"));
  assert.equal(v.summary().used.videoSeconds, 16);
  assert.equal(v.reserve({ taskId: "extra", kind: "video", units: 12 }).allowed, false);
});

test("budget: rejects negative, fractional, nonfinite, zero-token, missing and unknown inputs", (t) => {
  const b = budget(t);
  for (const [i, args] of [
    { kind: "llm", tokens: -1 }, { kind: "llm", tokens: Infinity }, { kind: "llm", tokens: NaN },
    { kind: "llm", tokens: 0 }, { kind: "llm", tokens: 1.5 }, { kind: "image", units: 0 },
    { kind: "image", units: -1 }, { kind: "image", units: 1.2 }, { kind: "video", units: Infinity },
    { kind: "unknown", units: 1 }, { kind: "llm", tokens: "1000" },
  ].entries()) assert.equal(b.reserve({ taskId: `invalid-${i}`, ...args }).allowed, false);
  assert.equal(b.reserve({ kind: "llm", tokens: 1000 }).allowed, false);
  assert.equal(b.summary().used.llmCalls, 0);
});

test("budget: no matching reservation or malformed settlement cannot create usage or clear pending use", (t) => {
  const b = budget(t);
  assert.equal(b.commit(llm("missing", 1000)).committed, false);
  b.reserve(llm("first", 1000));
  assert.equal(b.commit(llm("first", -1)).committed, false);
  assert.equal(b.commit({ ...llm("first", 1), costCny: Infinity }).committed, false);
  assert.equal(b.summary().pending.llmTokens, 1000);
  assert.equal(b.summary().actual.llmTokens, 0);
});

test("budget: restart and two handles replay the same journal without truncating it", (t) => {
  const outDir = directory(t);
  const options = { outDir, budgets: normalizeBudgets({ maxLlmTokens: 10_000 }).budgets, environmentKind: "synthetic" };
  const first = createBudget(options); first.reserve(llm("first", 8000));
  const original = readFileSync(first.ledgerPath, "utf8");
  const resumed = createBudget(options);
  assert.equal(readFileSync(first.ledgerPath, "utf8"), original);
  assert.equal(resumed.reserve(llm("second", 8000)).allowed, false);
  resumed.commit(llm("first", 9000));
  assert.equal(first.summary().used.llmTokens, 9000);
  assert.throws(() => createBudget({ ...options, environmentKind: "deployed" }), /不一致/);
});

test("budget: separate explicit run IDs preserve both journals and have independent caps", (t) => {
  const outDir = directory(t);
  const options = { outDir, budgets: normalizeBudgets({ maxLlmTokens: 1000 }).budgets };
  const first = createBudget({ ...options, runId: "run-first" }); first.reserve(llm("task", 1000));
  const second = createBudget({ ...options, runId: "run-second" }); second.reserve(llm("task", 1000));
  assert.equal(first.summary().used.llmTokens, 1000);
  assert.equal(second.summary().used.llmTokens, 1000);
  assert.equal(readFileSync(first.ledgerPath, "utf8").trim().split("\n").length, 4);
});

test("budget: parallel asynchronous admission cannot over-reserve", async (t) => {
  const b = budget(t, { maxLlmTokens: 10_000 });
  const results = await Promise.all(Array.from({ length: 32 }, (_, i) => Promise.resolve().then(() => b.reserve(llm(`task-${i}`, 1000)))));
  assert.equal(results.filter((x) => x.allowed).length, 10);
  assert.equal(b.summary().used.llmTokens, 10_000);
});

test("budget: concurrent processes share one atomic token reservation and do not lose settlements", async (t) => {
  const outDir = directory(t);
  const moduleUrl = new URL("./budget.mjs", import.meta.url).href;
  const code = `import {createBudget,normalizeBudgets} from ${JSON.stringify(moduleUrl)};
const [id,outDir]=process.argv.slice(1);const b=createBudget({outDir,budgets:normalizeBudgets({maxLlmTokens:10000}).budgets,environmentKind:'synthetic'});
const args={taskId:id,kind:'llm',tokens:4000};const gate=b.reserve(args);if(gate.allowed)b.commit({...args,tokens:5000,measured:true});console.log(JSON.stringify({allowed:gate.allowed}));`;
  const run = (i) => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ["--input-type=module", "-e", code, `worker-${i}`, outDir], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    p.stdout.on("data", (bytes) => { stdout += bytes; }); p.stderr.on("data", (bytes) => { stderr += bytes; });
    p.on("error", reject); p.on("close", (status) => status === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)));
  });
  const results = await Promise.all(Array.from({ length: 16 }, (_, i) => run(i)));
  assert.equal(results.filter((x) => x.allowed).length, 2);
  const shared = createBudget({ outDir, budgets: normalizeBudgets({ maxLlmTokens: 10_000 }).budgets, environmentKind: "synthetic" });
  assert.equal(shared.summary().used.llmTokens, 10_000);
  assert.equal(shared.summary().actual.llmTokens, 10_000);
  assert.equal(shared.summary().pending.llmTokens, 0);
});

test("budget: unreadable and corrupted journals fail before paid-call permission", (t) => {
  const outDir = directory(t); mkdirSync(join(outDir, "budget-ledger.jsonl"));
  assert.throws(() => createBudget({ outDir, budgets: normalizeBudgets({}).budgets }));
  const b = budget(t); appendFileSync(b.ledgerPath, "{truncated\n");
  assert.throws(() => b.reserve(llm("first", 1000)));
});

test("budget: wall-clock zero disables admission and invalid caps cannot widen limits", (t) => {
  assert.equal(budget(t, { maxWallClockMin: 0 }).reserve(llm("first", 1)).allowed, false);
  const normalized = normalizeBudgets({ maxLlmTokens: Infinity, maxImages: -1, maxLlmCalls: 1.5, maxCostCny: NaN, pricing: { imageCny: -1 } });
  assert.equal(normalized.budgets.maxLlmTokens, LIVE_BUDGET_CAPS.maxLlmTokens);
  assert.equal(normalized.budgets.maxImages, LIVE_BUDGET_CAPS.maxImages);
  assert.equal(normalized.budgets.maxLlmCalls, LIVE_BUDGET_CAPS.maxLlmCalls);
  assert.ok(normalized.warnings.length >= 5);
});

test("budget: a single actual video-duration overrun is reported and blocks other modalities", (t) => {
  const b = budget(t);
  b.reserve({ taskId: "video", kind: "video", units: 12 });
  b.commit({ taskId: "video", kind: "video", units: 16, measured: true });
  assert.ok(b.summary().exceeded.includes("videoDuration"));
  assert.equal(b.reserve(llm("later", 1)).allowed, false);
});

test("budget: permission failure and symlink substitution block admission before usage", (t) => {
  const b = budget(t);
  chmodSync(b.ledgerPath, 0o400);
  assert.throws(() => b.reserve(llm("first", 1000)), /权限/);
  chmodSync(b.ledgerPath, 0o600);
  const target = join(directory(t), "outside.jsonl"); writeFileSync(target, readFileSync(b.ledgerPath));
  rmSync(b.ledgerPath); symlinkSync(target, b.ledgerPath);
  assert.throws(() => b.reserve(llm("first", 1000)), /普通文件/);
  assert.equal(readFileSync(target, "utf8").trim().split("\n").length, 1);
});

test("budget: journal quantities and settlement identity cannot be tampered into lower usage", (t) => {
  for (const corrupt of [
    (rows) => { rows[1].tokens = -100; },
    (rows) => { rows[1].estimateCny = 0; },
    (rows) => { rows[2].taskId = "other"; },
    (rows) => { rows[0].startedAt = Date.now() + 60_000; },
  ]) {
    const b = budget(t); b.reserve(llm("first", 1000)); b.commit(llm("first", 1000));
    const rows = readFileSync(b.ledgerPath, "utf8").trim().split("\n").map(JSON.parse); corrupt(rows);
    writeFileSync(b.ledgerPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    assert.throws(() => b.reserve(llm("later", 1000)));
  }
});

test("budget: unmeasured settlements preserve estimates, disclose uncertainty and freeze all later paid admission", (t) => {
  const b = budget(t); b.reserve(llm("unknown", 8000));
  const settled = b.commit({ ...llm("unknown", 0), measured: false, status: "blocked", detail: "synthetic provider omitted usage" });
  assert.equal(settled.committed, true); assert.equal(b.summary().used.llmTokens, 8000); assert.equal(b.summary().actual.llmTokens, 0);
  assert.equal(b.summary().unmeasured.llmTokens, 8000); assert.equal(b.summary().measurementComplete, false);
  assert.equal(b.reserve(llm("later", 1)).allowed, false); assert.equal(b.reserve({ taskId: "image", kind: "image", units: 1 }).allowed, false);
  assert.match(b.summary().frozenBy[0].reason, /omitted usage/);
});

test("budget: unknown measurement cannot be relabelled as a measured zero on retry", (t) => {
  const b = budget(t); b.reserve(llm("unknown", 8000));
  b.commit({ ...llm("unknown", 0), measured: false, status: "blocked" });
  assert.equal(b.commit({ ...llm("unknown", 0), measured: true, status: "blocked" }).committed, false);
  assert.equal(b.summary().measurementComplete, false);
});

test("budget: omitted measurement is conservative for every modality and cannot admit the next paid call", (t) => {
  for (const reservation of [{ taskId: "unknown", kind: "llm", tokens: 100 }, { taskId: "unknown", kind: "image", units: 2 }, { taskId: "unknown", kind: "video", units: 12 }]) {
    const b = budget(t); assert.equal(b.reserve(reservation).allowed, true);
    assert.equal(b.commit({ taskId: reservation.taskId, kind: reservation.kind, status: "failed" }).committed, true);
    assert.equal(b.summary().reservations[0].settlement.measured, false);
    assert.equal(b.summary().measurementComplete, false); assert.equal(b.summary().frozenBy.length, 1);
    const quantity = reservation.kind === "llm" ? "llmTokens" : reservation.kind === "image" ? "images" : "videoSeconds";
    assert.equal(b.summary().actual[quantity], 0); assert.equal(b.summary().unmeasured[quantity], reservation.tokens ?? reservation.units);
    for (const later of [llm("later-llm", 1), { taskId: "later-image", kind: "image", units: 1 }, { taskId: "later-video", kind: "video", units: 12 }]) assert.equal(b.reserve(later).allowed, false);
  }
});
