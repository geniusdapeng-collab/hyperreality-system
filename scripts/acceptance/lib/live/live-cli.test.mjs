/** Real CLI failures stay fail/unverified; these tests need no browser or model credentials. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { fixture, llm, model, report, run } from "./cli-fixtures.mjs";

test("live CLI fixture: child resolves installed source Playwright without inherited NODE_PATH and retains explicit module paths", (t) => {
  const previousNodePath = process.env.NODE_PATH; const previousSentinel = process.env.WORKLOOM_TEST_ONLY_PARENT_VALUE;
  try {
    delete process.env.NODE_PATH; process.env.WORKLOOM_TEST_ONLY_PARENT_VALUE = "test-only synthetic parent value";
    const f = fixture(t);
    // This subprocess probes the exact fixture environment with the real loader.
    // Full CLI media playback and receipt checks run in live-cli-browser.test.mjs.
    writeFileSync(join(f.repo, "scripts/acceptance/live.mjs"), `import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { loadChromium } = await import(${JSON.stringify(pathToFileURL(join(f.repo, "scripts/acceptance/lib/playwright.mjs")).href)});
assert.equal(typeof loadChromium(process.cwd()).launch, "function");
assert.equal(process.env.WORKLOOM_TEST_ONLY_PARENT_VALUE, undefined);
const require = createRequire(new URL("../../package.json", import.meta.url));
if (process.env.WORKLOOM_TEST_ONLY_MODULE) assert.equal(require(process.env.WORKLOOM_TEST_ONLY_MODULE), "test-only dependency");
`);
    const dependencyPaths = ["ambient", "explicit"].map((name) => {
      const path = join(f.repo, `${name}-modules`); const module = `workloom-test-only-${name}`;
      mkdirSync(join(path, module), { recursive: true }); writeFileSync(join(path, module, "package.json"), JSON.stringify({ type: "commonjs" })); writeFileSync(join(path, module, "index.js"), 'module.exports = "test-only dependency";\n');
      return { path, module };
    });
    for (const mode of ["absent", "ambient", "explicit"]) {
      delete process.env.NODE_PATH;
      const extraEnv = {};
      if (mode !== "absent") {
        const dependency = dependencyPaths[mode === "ambient" ? 0 : 1]; extraEnv.WORKLOOM_TEST_ONLY_MODULE = dependency.module;
        if (mode === "ambient") process.env.NODE_PATH = dependency.path; else extraEnv.NODE_PATH = dependency.path;
      }
      const result = run(f, [], extraEnv); assert.equal(result.status, 0, `${mode}: ${result.stdout}\n${result.stderr}\n${result.error?.code ?? ""}`);
    }
  } finally {
    if (previousNodePath === undefined) delete process.env.NODE_PATH; else process.env.NODE_PATH = previousNodePath;
    if (previousSentinel === undefined) delete process.env.WORKLOOM_TEST_ONLY_PARENT_VALUE; else process.env.WORKLOOM_TEST_ONLY_PARENT_VALUE = previousSentinel;
  }
});

test("live CLI: missing credentials exits unverified, captures real run evidence and does not consume quota", (t) => {
  const f = fixture(t); const result = run(f); assert.equal(result.status, 2, result.stderr);
  const observed = report(f); assert.equal(observed.tasks[0].status, "blocked"); assert.equal(observed.budget.used.llmTokens, 0); assert.notEqual(observed.verdict, "pass");
  assert.equal(observed.checks.length, 18); assert.equal(observed.checks.filter((check) => check.status === "pass").length, 0);
  const index = JSON.parse(readFileSync(join(f.repo, "outputs/acceptance/evidence-index.json"), "utf8"));
  assert.equal(index.runs.length, 1); const runRecord = JSON.parse(readFileSync(join(f.repo, "outputs/acceptance", index.runs[0].path), "utf8"));
  assert.equal(runRecord.exit_code, result.status); assert.equal(runRecord.working_tree_dirty, false); assert.equal(runRecord.outputs.some((file) => file.path.endsWith("budget-ledger.jsonl")), true);
  assert.equal(existsSync(`${f.out}.run-lock`), false);
});

test("live CLI: disabled live configuration and empty task selection cannot become a zero-task pass", (t) => {
  for (const config of [{ live: { enabled: false, models: [model], tasks: [llm] } }, {}]) {
    const f = fixture(t, config); const result = run(f, config.live ? [] : ["--tasks", "unknown-task"]);
    assert.equal(result.status, 2, result.stderr); assert.equal(report(f).summary.total, config.live ? 0 : 1); assert.notEqual(report(f).verdict, "pass");
  }
});

test("live CLI: production dispatch requires explicit writes, fixture and residual disclosure before login", (t) => {
  for (const flags of [[], ["--allow-prod-writes"]]) {
    const f = fixture(t, { environment: { kind: "deployed", target: { apiUrl: "http://127.0.0.1:1" }, timeouts: { healthMs: 50 } }, live: { enabled: true, models: [], tasks: [{ id: "PROD-01", kind: "product", title: "synthetic", state_asserts: [{ http: { url: "http://127.0.0.1:1/health", status: 200 } }] }] } });
    const result = run(f, flags); assert.equal(result.status, 2, result.stderr); const observed = report(f).tasks[0]; assert.equal(observed.status, "blocked");
    assert.match(observed.reason, flags.length ? /fixtureMarker/ : /allow-prod-writes/); assert.equal(observed.threadId, undefined);
  }
});

test("live CLI: duplicate IDs, traversal and missing values fail before model admission", (t) => {
  for (const tasks of [[llm, llm], [{ ...llm, id: "../escape" }]]) {
    const f = fixture(t, { live: { enabled: true, models: [model], tasks } }); const result = run(f); assert.equal(result.status, 1); assert.equal(existsSync(join(f.out, "budget-ledger.jsonl")), false);
  }
  const f = fixture(t); const result = run(f, ["--keys-file", "--no-auto-keys"]); assert.equal(result.status, 1); assert.equal(existsSync(join(f.out, "budget-ledger.jsonl")), false);
});

test("live CLI: an existing run lock prevents parallel evidence replacement and paid admission", (t) => {
  const f = fixture(t); mkdirSync(`${f.out}.run-lock`, { recursive: true }); const result = run(f);
  assert.equal(result.status, 1); assert.match(result.stderr, /运行锁/); assert.equal(existsSync(join(f.out, "budget-ledger.jsonl")), false); assert.equal(existsSync(`${f.out}.run-lock`), true);
});
