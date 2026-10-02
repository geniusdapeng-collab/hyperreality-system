/** Browser-required positive and content-level negative checks. Missing decoder is a test failure, never a skip. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { downloadArtifact, inspectLocalArtifact, verifyArtifactReceipts } from "./media.mjs";
import { runImageTask, runVideoTask } from "./providers.mjs";
import { startStubProvider } from "./stub-provider.mjs";
import { PNG_BYTES, MP4_BYTES } from "./test-fixtures.mjs";
import { verifyExpectations } from "./verification.mjs";

function directory(t) { const dir = mkdtempSync(join(tmpdir(), "workloom-media-decoder-")); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }
const key = "synthetic-test-key";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("media decoder: actual PNG pixels and complete MP4/VP9 playback establish dimensions, duration and digest", async (t) => {
  const dir = directory(t);
  for (const [kind, bytes] of [["image", PNG_BYTES], ["video", MP4_BYTES]]) {
    const path = join(dir, kind); writeFileSync(path, bytes);
    const result = await inspectLocalArtifact({ path, artifactsDir: dir, kind });
    assert.equal(result.decoded, true); assert.equal(result.decoder, "browser"); assert.equal(result.width, 16); assert.equal(result.height, 16); assert.equal(result.sha256, hash(bytes)); assert.equal(result.bytes, bytes.length);
    if (kind === "video") { assert.ok(result.durationSeconds >= 10 && result.durationSeconds <= 15); assert.ok(result.decodedFrames > 0); }
  }
});

test("media decoder: a readable landed image has a matching receipt and tampered manifests fail", async (t) => {
  const dir = directory(t); const stub = await startStubProvider(); t.after(() => stub.close());
  const landed = await downloadArtifact({ url: `${stub.baseUrl}/artifacts/image.png?secret=strip-me`, artifactsDir: dir, kind: "image", taskId: "IMG-01" });
  assert.equal(landed.ok, true); assert.equal(landed.artifact.url.includes("secret"), false);
  const artifact = landed.artifact; const receipt = { artifacts: [{ ...artifact }] };
  assert.equal((await verifyArtifactReceipts({ artifacts: [artifact], receipt, artifactsDir: dir, kind: "image" })).ok, true);
  for (const changed of [{ sha256: "0".repeat(64) }, { bytes: artifact.bytes + 1 }, { format: "jpg" }, { mime: "image/jpeg" }]) {
    assert.equal((await verifyArtifactReceipts({ artifacts: [artifact], receipt: { artifacts: [{ ...artifact, ...changed }] }, artifactsDir: dir, kind: "image" })).ok, false);
  }
  writeFileSync(artifact.path, PNG_BYTES.subarray(0, 40));
  assert.equal((await verifyArtifactReceipts({ artifacts: [artifact], receipt, artifactsDir: dir, kind: "image" })).ok, false);
});

test("media decoder: duplicate paths cannot count as two delivered images", async (t) => {
  const dir = directory(t); const path = join(dir, "image.png"); writeFileSync(path, PNG_BYTES); const artifact = await inspectLocalArtifact({ path, artifactsDir: dir, kind: "image" });
  const result = await verifyArtifactReceipts({ artifacts: [artifact, artifact], receipt: { artifacts: [artifact, artifact] }, artifactsDir: dir, kind: "image" });
  assert.equal(result.ok, false); assert.match(result.problems.join(" "), /重复/);
});

test("media decoder: valid MP4 container with corrupted frame data fails actual playback", async (t) => {
  const dir = directory(t); const corrupted = Buffer.from(MP4_BYTES); const marker = corrupted.indexOf(Buffer.from("mdat")); assert.ok(marker > 0);
  const payload = marker + 4; const size = corrupted.readUInt32BE(marker - 4); corrupted.fill(255, payload, marker - 4 + size);
  const path = join(dir, "bad.mp4"); writeFileSync(path, corrupted);
  await assert.rejects(inspectLocalArtifact({ path, artifactsDir: dir, kind: "video", timeoutMs: 3000 }), /无法解码|没有可解码|超时/);
});

test("media decoder: image adapter delivers exactly the occupied count and the shared completion verifier rereads it", async (t) => {
  const dir = directory(t); const stub = await startStubProvider(); t.after(() => stub.close());
  const task = { id: "IMG-01", kind: "image", images: 2, prompt: "synthetic", minArtifacts: 2 };
  const result = await runImageTask({ resolved: { ready: true, credentialEnv: "SEEDREAM_API_KEY", model: "synthetic", baseUrl: stub.arkBaseUrl }, task, env: { SEEDREAM_API_KEY: key }, artifactsDir: dir });
  assert.equal(result.status, "ok"); assert.equal(result.produced, 2); assert.equal(result.artifacts.length, 2); assert.equal(result.receipt.delivered, 2);
  assert.equal(result.model, "synthetic"); assert.equal(result.receipt.model, "synthetic"); assert.equal(result.receipt.requestedModel, "synthetic");
  assert.equal(result.measurementComplete, true); assert.equal(result.receipt.measurementComplete, true); assert.equal(result.receipt.measurementSource, "usage.generated_images");
  assert.equal((await verifyExpectations(task, result, { artifactsDir: dir })).ok, true);
  assert.equal(new Set(result.artifacts.map((artifact) => artifact.path)).size, 2);
  for (const artifact of result.artifacts) assert.equal(hash(readFileSync(artifact.path)), artifact.sha256);
});

test("media decoder: video adapter bills observed file duration and proves frames plus receipt metadata", async (t) => {
  const dir = directory(t); const stub = await startStubProvider(); t.after(() => stub.close());
  const task = { id: "VID-01", kind: "video", durationSeconds: 12, prompt: "synthetic", durationRange: [10, 15] };
  const result = await runVideoTask({ resolved: { ready: true, credentialEnv: "SEEDANCE_API_KEY", model: "synthetic", baseUrl: stub.arkBaseUrl }, task, env: { SEEDANCE_API_KEY: key }, artifactsDir: dir, pollMs: 0, timeoutMs: 10_000 });
  assert.equal(result.status, "ok"); assert.equal(result.receipt.synced, true); assert.equal(result.durationSeconds, result.artifacts[0].durationSeconds);
  assert.equal(result.model, "synthetic"); assert.equal(result.receipt.model, "synthetic"); assert.equal(result.receipt.requestedModel, "synthetic");
  assert.equal(result.measurementComplete, true); assert.equal(result.receipt.measurementComplete, true); assert.equal(result.receipt.measurementSource, "decoded-local-file");
  assert.equal(result.receipt.reportedDurationSeconds, 12); assert.notEqual(result.durationSeconds, 12);
  assert.equal((await verifyExpectations(task, result, { artifactsDir: dir })).ok, true);
  const original = result.receipt.artifacts[0].durationSeconds; result.receipt.artifacts[0].durationSeconds = 14;
  assert.equal((await verifyExpectations(task, result, { artifactsDir: dir })).ok, false); result.receipt.artifacts[0].durationSeconds = original;
});
