/** Browser-required real CLI consumer test. No browser => failure; all model calls use loopback stub. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fixture, llm, model, report, run } from "./cli-fixtures.mjs";

test("live CLI browser: selftest archives decoded media, matching receipts and 18 unverified production items", (t) => {
  const models = [model, { id: "synthetic-image", kind: "image", model: "synthetic-image", adapter: "gen-http" }, { id: "synthetic-video", kind: "video", model: "synthetic-video", adapter: "gen-http" }];
  const tasks = [llm, { id: "IMG-01", kind: "image", model: "synthetic-image", title: "synthetic image", prompt: "synthetic", images: 1 }, { id: "VID-01", kind: "video", model: "synthetic-video", title: "synthetic video", prompt: "synthetic", durationSeconds: 12 }];
  // This consumer launches and closes four isolated browsers (adapter + fresh
  // verifier for each media kind); their bounded cold starts can exceed 60s.
  const f = fixture(t, { live: { enabled: true, models, tasks } }); const result = run(f, ["--selftest"], {}, { timeoutMs: 300_000 }); assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error?.code ?? ""}`);
  const observed = report(f); assert.equal(observed.summary.byStatus.ok, 3); assert.equal(observed.selftest, true); assert.equal(observed.checks.length, 18); assert.equal(observed.checks.every((check) => check.status === "unverified"), true);
  assert.equal(observed.secretScan.passed, true); assert.equal(observed.budget.reservations.filter((reservation) => reservation.status === "ok").length, 3);
  const index = JSON.parse(readFileSync(join(f.repo, "outputs/acceptance/evidence-index.json"), "utf8"));
  for (const entry of observed.tasks) { assert.equal(index.artifacts.some((file) => file.path === entry.receiptPath), true); assert.equal(index.artifacts.some((file) => file.path === entry.transcriptPath), true); }
  for (const entry of observed.tasks.filter((entry) => entry.kind !== "llm")) assert.equal(entry.artifacts[0].decoded, true);
  const strict = fixture(t, { live: { enabled: true, models: [model], tasks: [llm] } }); const strictResult = run(strict, ["--selftest", "--require-live"]); assert.equal(strictResult.status, 2); assert.equal(report(strict).selftest, true);
});
