import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBudget, normalizeBudgets } from "./budget.mjs";
import { runProductDispatchTask, runImageTask } from "./providers.mjs";
import { buildLiveChecks } from "./checks.mjs";

function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), "workloom-live-truth-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function mockFetch(t, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fn;
  t.after(() => { globalThis.fetch = original; });
}

test("G02 / N5: LLM reservations account for cumulative committed and pending tokens", (t) => {
  const { budgets } = normalizeBudgets({ maxLlmTokens: 10_000 });
  const budget = createBudget({ budgets, outDir: temp(t), environmentKind: "synthetic" });
  assert.equal(budget.reserve({ taskId: "first", kind: "llm", tokens: 8000 }).allowed, true);
  budget.commit({ taskId: "first", kind: "llm", tokens: 8000, measured: true });
  assert.equal(budget.reserve({ taskId: "second", kind: "llm", tokens: 8000 }).allowed, false);
  assert.equal(budget.summary().used.llmTokens, 8000);
});

test("G03 / N6: a failed product thread stays failed when its HTTP assertion passes", async (t) => {
  mockFetch(t, async (url) => {
    const target = String(url);
    if (target.includes("/threads.dispatch")) return new Response(JSON.stringify({ result: { data: { threadId: "synthetic-thread", kind: "routed" } } }));
    if (target.includes("/threads.get")) return new Response(JSON.stringify({ result: { data: { status: "failed", calls: [] } } }));
    if (target === "https://synthetic.invalid/state") return new Response("healthy");
    throw new Error("Unexpected synthetic URL");
  });
  const result = await runProductDispatchTask({
    apiUrl: "https://synthetic.invalid", token: "test-only-synthetic-test-token", timeoutMs: 1000, pollMs: 0,
    task: { title: "synthetic failure", state_asserts: [{ http: { url: "https://synthetic.invalid/state", status: 200 } }] },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.finalStatus, "failed");
  assert.equal(result.receipt.synced, false);
});

test("G04 / N7: image generation does not succeed when the artifact download receives 403", async (t) => {
  mockFetch(t, async (url) => {
    const target = String(url);
    if (target.endsWith("/images/generations")) return new Response(JSON.stringify({ usage: { generated_images: 1 }, data: [{ url: "https://synthetic.invalid/picture.png" }] }));
    if (target === "https://synthetic.invalid/picture.png") return new Response("forbidden", { status: 403 });
    throw new Error("Unexpected synthetic URL");
  });
  const result = await runImageTask({
    resolved: { ready: true, credentialEnv: "SYNTHETIC_KEY", model: "synthetic", baseUrl: "https://synthetic.invalid" },
    task: { id: "synthetic-image", images: 1, prompt: "synthetic" },
    env: { SYNTHETIC_KEY: "test-only-synthetic-test-token" }, artifactsDir: temp(t),
  });
  assert.equal(result.status, "failed");
  assert.equal(result.receipt.synced, false);
  assert.equal(result.artifacts.filter((a) => a.path).length, 0);
});

test("P18 checks: one measured reasoning task cannot fan aggregate success out to unobserved domains", (t) => {
  const budget = createBudget({ outDir: temp(t), budgets: normalizeBudgets({}).budgets }).summary();
  const observed = { selftest: false, environment: { kind: "deployed", targetDeclaredExplicitly: true, declaredTarget: true }, fingerprint: { repo: { commit: "a".repeat(40), dirty: false }, targetProbe: { ok: true } }, models: [], budget, summary: { failedIds: [], blockedIds: [] }, verdict: "pass", tasks: [{ id: "LLM-R1", kind: "llm", selftest: false, status: "ok", answer: "TASK_COMPLETE", verification: { ok: true }, usage: { complete: true }, receipt: { synced: true, usageComplete: true }, receiptPath: "live/receipts/LLM-R1.json", transcriptPath: "live/transcripts/LLM-R1.json" }] };
  const checks = buildLiveChecks(observed, { reportPath: "live/live-report.json", requestedTaskIds: ["LLM-R1"], secretScan: { passed: true } });
  assert.equal(checks.length, 18); assert.equal(checks.find((check) => check.id === "P2-01").status, "pass");
  for (const id of ["P2-02", "P2-03", "P2-04", "P2-05", "P2-06"]) assert.equal(checks.find((check) => check.id === id).status, "unverified");
  for (const kind of ["local-preview", "deployed"]) {
    const local = structuredClone(observed); local.environment.kind = kind; local.selftest = true;
    assert.equal(buildLiveChecks(local, { reportPath: "live/live-report.json", secretScan: { passed: true } }).filter((check) => check.status === "pass").length, 0);
  }
});

test("P18 checks: blocked media without receipts still produce every unverified observation", (t) => {
  const budget = createBudget({ outDir: temp(t), budgets: normalizeBudgets({}).budgets }).summary();
  const report = { selftest: false, environment: { kind: "deployed", targetDeclaredExplicitly: true, declaredTarget: true }, fingerprint: { repo: { commit: "a".repeat(40), dirty: false }, targetProbe: { ok: true } }, models: [], budget,
    summary: { failedIds: [], blockedIds: ["IMG-01", "VID-01"] }, verdict: "blocked", tasks: [{ id: "IMG-01", kind: "image", status: "blocked", selftest: false }, { id: "VID-01", kind: "video", status: "blocked", selftest: false }] };
  const checks = buildLiveChecks(report, { reportPath: "live/live-report.json", requestedTaskIds: ["IMG-01", "VID-01"], secretScan: { passed: true } });
  assert.equal(checks.length, 18);
  for (const id of ["P2-04", "P2-05"]) assert.equal(checks.find((check) => check.id === id).status, "unverified");
});
