/** Actual CLI + loopback HTTP; all provider keys/data are synthetic and no external calls occur. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fixture, llm, model, report, run } from "./cli-fixtures.mjs";

async function server(t, reply) {
  const calls = []; const instance = http.createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk; calls.push({ method: req.method, url: req.url, body });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url === "/chat/completions" ? reply(JSON.parse(body)) : { ok: true }));
  });
  await new Promise((resolve) => instance.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { instance.close(resolve); instance.closeAllConnections(); }));
  return { url: `http://127.0.0.1:${instance.address().port}`, calls };
}

function child(f, flags = [], extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [join(f.repo, "scripts/acceptance/live.mjs"), "--out", f.out, "--no-auto-keys", "--no-keys-from-client", ...flags], { cwd: f.repo, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: tmpdir(), NODE_PATH: process.env.NODE_PATH ?? "", ...extraEnv } });
    let stdout = ""; let stderr = ""; const timer = setTimeout(() => { proc.kill("SIGKILL"); reject(new Error("synthetic CLI child timeout")); }, 30_000);
    proc.stdout.on("data", (data) => { stdout += data; }); proc.stderr.on("data", (data) => { stderr += data; });
    proc.on("error", (error) => { clearTimeout(timer); reject(error); }); proc.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

test("live CLI wire: opaque product tasks stop before login/dispatch even when requireModel is false", async (t) => {
  const s = await server(t, () => { throw new Error("no provider is authorized"); });
  for (const requireModel of [true, false]) {
    const f = fixture(t, { environment: { kind: "deployed", target: { apiUrl: s.url }, timeouts: { healthMs: 500 } }, live: { enabled: true, models: [], tasks: [{ id: "PROD-01", kind: "product", title: "synthetic FIXTURE", requireModel, fixtureMarker: "FIXTURE", residualDisclosure: "synthetic only", state_asserts: [{ event: { action: "ask.answer", field: "decision.after.text", minLength: 2 } }] }] } });
    const result = await child(f, ["--allow-prod-writes"]); assert.equal(result.status, 2, result.stderr);
    const actual = report(f); assert.equal(actual.tasks[0].status, "blocked"); assert.equal(actual.tasks[0].called, false); assert.match(actual.tasks[0].reason, /逐请求/);
    assert.equal(actual.budget.used.llmCalls, 0); assert.equal(actual.tasks[0].threadId, undefined);
  }
  assert.equal(s.calls.some((call) => /auth\.loginAs|threads\.dispatch|chat\/completions/u.test(call.url)), false);
  assert.ok(s.calls.some((call) => call.url === "/health"));
});

test("live CLI wire: missing media usage freezes later paid tasks, retains reservations and redacts custom credential names", async (t) => {
  const secret = "test-only-synthetic-echo-key-not-real";
  const s = await mediaServer(t, "image-echo-key");
  const customModel = { ...imageModel, apiKeyEnv: "CUSTOM_MODEL_ACCESS" };
  const f = fixture(t, { ...mediaProfile(s.url, []), live: { enabled: true, models: [customModel], tasks: [{ ...imageTask, id: "IMG-01" }, { ...imageTask, id: "IMG-02" }] } });
  const result = await child(f, [], { CUSTOM_MODEL_ACCESS: secret, SYNTHETIC_BASE_URL: s.url }); assert.equal(result.status, 2, result.stderr);
  const actual = report(f); assert.equal(actual.tasks[0].status, "blocked"); assert.equal(actual.tasks[1].status, "blocked"); assert.equal(actual.budget.measurementComplete, false);
  assert.equal(actual.budget.actual.images, 0); assert.equal(actual.budget.unmeasured.images, 1); assert.equal(actual.budget.used.images, 1); assert.equal(s.calls.filter((call) => call.url === "/images/generations").length, 1);
  assert.equal(actual.secretScan.passed, true); assert.equal(actual.tasks[0].reason.includes("[REDACTED]"), true);
  for (const value of [JSON.stringify(actual), result.stdout, result.stderr, readFileSync(join(f.out, "transcripts/IMG-01.json"), "utf8"), readFileSync(join(f.out, "receipts/IMG-01.json"), "utf8"), readFileSync(join(f.out, "budget-ledger.jsonl"), "utf8")]) assert.equal(value.includes(secret), false);
});

test("live CLI wire: an internally started selftest gateway settles actual fixture usage and keeps production items unverified", (t) => {
  const f = fixture(t, { live: { enabled: true, models: [model], tasks: [{ ...llm, expectedTokens: 100 }] } });
  const result = run(f, ["--selftest"]); assert.equal(result.status, 0, result.stderr);
  const actual = report(f); assert.equal(actual.tasks[0].status, "ok"); assert.equal(actual.budget.actual.llmTokens, 20); assert.equal(actual.budget.used.llmTokens, 100); assert.equal(actual.budget.measurementComplete, true);
  assert.equal(actual.checks.filter((check) => check.status === "pass").length, 0); assert.notEqual(actual.verdict, "pass");
});

test("live CLI LLM admission: untrusted expectedTokens cannot authorize external gateway, DSH or fallback routes", async (t) => {
  const s = await server(t, (input) => ({ id: "synthetic-would-charge", model: input.model, choices: [{ message: { content: "STUB answer" } }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }));
  for (const chain of ["model-gateway", "dsh-harness", "undeclared-route"]) for (const expectedTokens of [1, 300_000]) {
    const liveModel = { ...model, adapter: chain === "dsh-harness" ? chain : "model-gateway" };
    const f = fixture(t, { environment: { kind: "deployed", target: { apiUrl: s.url }, timeouts: { healthMs: 500 } }, live: { enabled: true, models: [liveModel], tasks: [{ ...llm, chain, expectedTokens }] } });
    const result = await child(f, [], { SYNTHETIC_API_KEY: "synthetic-only-key", SYNTHETIC_BASE_URL: s.url }); assert.equal(result.status, 2, result.stderr);
    const actual = report(f); assert.equal(actual.tasks[0].status, "blocked"); assert.equal(actual.tasks[0].called, false); assert.match(actual.tasks[0].reason, /可信.*总.*token|总.*token.*上界/);
    assert.equal(actual.budget.used.llmCalls, 0); assert.equal(actual.budget.used.llmTokens, 0); assert.deepEqual(actual.budget.reservations, []);
    for (const id of ["P1-01", "P1-02", "P1-03"]) assert.equal(actual.checks.find((check) => check.id === id).status, "unverified");
    assert.equal(actual.tasks[0].audit, undefined); assert.equal(s.calls.some((call) => /chat\/completions|auth\.loginAs|fence\.activeRules/u.test(call.url)), false);
  }
});

test("live CLI: invalid timeout and duplicate valued flags reject before output or admission", (t) => {
  for (const value of ["NaN", "Infinity", "-1", "2147484", "1e309"]) {
    const f = fixture(t); const result = run(f, ["--timeout-s", value]); assert.equal(result.status, 1); assert.equal(existsSync(join(f.out, "budget-ledger.jsonl")), false);
  }
  const f = fixture(t); const result = run(f, ["--timeout-s", "1", "--timeout-s", "2"]); assert.equal(result.status, 1); assert.equal(existsSync(join(f.out, "budget-ledger.jsonl")), false);
});

async function mediaServer(t, mode) {
  const calls = [];
  const instance = http.createServer(async (req, res) => {
    let text = ""; for await (const bytes of req) text += bytes;
    const input = text ? JSON.parse(text) : null; calls.push({ method: req.method, url: req.url, input });
    const json = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    const url = `http://127.0.0.1:${instance.address().port}`;
    if (req.url === "/images/generations") {
      if (mode === "image-echo-key") return json(403, { error: `synthetic echoed credential ${String(req.headers.authorization ?? "").replace(/^Bearer /u, "")}` });
      if (mode === "image-network") return req.socket.destroy();
      if (mode === "image-http" || mode === "image-partial" && calls.filter((call) => call.url === req.url).length > 1) return json(403, { error: "synthetic image denied" });
      return json(200, { model: input.model, usage: mode === "image-missing-usage" ? undefined : { generated_images: 1 }, data: [{ url: `${url}/unreadable.png` }] });
    }
    if (req.url === "/contents/generations/tasks") return mode === "video-submit-http" ? json(403, { error: "synthetic submit denied" }) : json(200, { id: "synthetic-video-1" });
    if (req.url === "/contents/generations/tasks/synthetic-video-1") return mode === "video-poll-http" ? json(403, { error: "synthetic poll denied" })
      : json(200, { id: "synthetic-video-1", status: "succeeded", duration: 12, content: mode === "video-no-url" ? {} : { video_url: `${url}/unreadable.mp4` } });
    if (req.url.startsWith("/unreadable.")) return json(403, { error: "synthetic delivery denied" });
    if (req.url === "/chat/completions") return json(200, { id: "synthetic-chat-media", model: input.model, choices: [{ message: { content: "STUB exact usage" } }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } });
    return json(200, { ok: true });
  });
  await new Promise((resolve) => instance.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { instance.close(resolve); instance.closeAllConnections(); }));
  return { url: `http://127.0.0.1:${instance.address().port}`, calls };
}
const imageModel = { ...model, id: "synthetic-image", kind: "image", adapter: "gen-http" };
const videoModel = { ...model, id: "synthetic-video", kind: "video", adapter: "gen-http" };
const imageTask = { id: "IMG-01", kind: "image", model: imageModel.id, title: "synthetic image", prompt: "synthetic", images: 1 };
const videoTask = { id: "VID-01", kind: "video", model: videoModel.id, title: "synthetic video", prompt: "synthetic", durationSeconds: 12 };
const mediaProfile = (url, tasks) => ({ environment: { kind: "local-preview", target: { apiUrl: url, pcUrl: url, bMobileUrl: url, cMobileUrl: url }, timeouts: { healthMs: 500 } },
  live: { enabled: true, models: [model, imageModel, videoModel], tasks } });

for (const mode of ["image-http", "image-network", "image-partial", "image-missing-usage", "video-submit-http", "video-poll-http", "video-no-url", "video-download-http"]) {
  test(`live CLI media budget: ${mode} retains unmeasured reservations and stops every later modality before HTTP`, async (t) => {
    const s = await mediaServer(t, mode);
    const isImage = mode.startsWith("image-"); const first = isImage ? { ...imageTask, images: mode === "image-partial" ? 2 : 1 } : videoTask;
    const f = fixture(t, mediaProfile(s.url, [first, { ...imageTask, id: "IMG-NEXT" }, { ...videoTask, id: "VID-NEXT" }, { ...llm, id: "LLM-NEXT", expectedTokens: 100 }]));
    const result = await child(f, [], { SYNTHETIC_API_KEY: "synthetic-only-media-key", SYNTHETIC_BASE_URL: s.url }); assert.equal(result.status, 2, result.stderr);
    const actual = report(f); assert.equal(actual.tasks[0].measurementComplete, false); assert.equal(actual.tasks[0].receipt.measurementComplete, false);
    assert.equal(actual.budget.measurementComplete, false); assert.equal(actual.budget.reservations.length, 1); assert.equal(actual.budget.reservations[0].settlement.measured, false);
    const quantity = isImage ? "images" : "videoSeconds"; const reserved = isImage ? first.images : 12;
    assert.equal(actual.budget.used[quantity], reserved); assert.equal(actual.budget.unmeasured[quantity], reserved); assert.equal(actual.budget.actual[quantity], 0);
    assert.equal(actual.budget.frozenBy.length, 1); assert.equal(actual.tasks.slice(1).every((task) => task.status === "blocked"), true);
    assert.equal(s.calls.filter((call) => call.url === "/chat/completions").length, 0);
    assert.equal(s.calls.filter((call) => call.url === "/images/generations").length, isImage ? mode === "image-partial" ? 2 : 1 : 0);
    assert.equal(s.calls.filter((call) => call.method === "POST" && call.url === "/contents/generations/tasks").length, isImage ? 0 : 1);
  });
}

test("live CLI media budget: known supplier image usage is retained even if delivery fails, and does not invent a global usage freeze", async (t) => {
  const s = await mediaServer(t, "image-known-usage"); const f = fixture(t, mediaProfile(s.url, [imageTask, { ...imageTask, id: "IMG-NEXT" }]));
  const result = await child(f, [], { SYNTHETIC_API_KEY: "synthetic-only-media-key", SYNTHETIC_BASE_URL: s.url }); assert.equal(result.status, 1, result.stderr);
  const actual = report(f); assert.equal(actual.tasks[0].status, "failed"); assert.equal(actual.tasks[0].measurementComplete, true); assert.equal(actual.tasks[0].receipt.synced, false);
  assert.equal(actual.budget.actual.images, 2); assert.equal(actual.budget.unmeasured.images, 0); assert.equal(actual.budget.measurementComplete, true); assert.deepEqual(actual.budget.frozenBy, []);
  assert.equal(actual.tasks[1].status, "failed"); assert.equal(actual.tasks[1].measurementComplete, true); assert.equal(s.calls.filter((call) => call.url === "/images/generations").length, 2);
});
