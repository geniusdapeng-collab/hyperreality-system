import assert from "node:assert/strict";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertSafeTaskId, downloadArtifact, inspectLocalArtifact, publicArtifactUrl, verifyArtifactReceipts } from "./media.mjs";
import { PNG_BYTES, MP4_BYTES } from "./test-fixtures.mjs";

function directory(t) { const dir = mkdtempSync(join(tmpdir(), "workloom-media-negative-")); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }
function mock(t, response) { const original = globalThis.fetch; globalThis.fetch = typeof response === "function" ? response : async () => response; t.after(() => { globalThis.fetch = original; }); }
const download = (artifactsDir, extra = {}) => downloadArtifact({ url: "https://synthetic.invalid/private-image?secret=signed-url", artifactsDir, taskId: "IMG-01", kind: "image", timeoutMs: 1000, ...extra });

test("media: safe file identities reject traversal, separators, empty IDs and prototype-like path escapes", () => {
  for (const id of ["", "../escape", "test/escape", "test\\escape", "/absolute", "double..dot", "a".repeat(121)]) assert.throws(() => assertSafeTaskId(id));
  assert.equal(assertSafeTaskId("IMG-01"), "IMG-01");
  assert.equal(publicArtifactUrl("https://test.invalid/a.png?api_key=private#x"), "https://test.invalid/a.png");
  assert.equal(publicArtifactUrl("db://entity/id?token=private"), "db://entity/id");
});

test("media: URLs, directories, empty files and ungranted read permissions cannot substitute for files", async (t) => {
  const dir = directory(t); const path = join(dir, "empty.png"); writeFileSync(path, "");
  await assert.rejects(inspectLocalArtifact({ path: "https://synthetic.invalid/image.png", artifactsDir: dir, kind: "image" }), /本地交付物/);
  await assert.rejects(inspectLocalArtifact({ path: dir, artifactsDir: dir, kind: "image" }));
  await assert.rejects(inspectLocalArtifact({ path, artifactsDir: dir, kind: "image" }), /为空/);
  writeFileSync(path, PNG_BYTES); chmodSync(path, 0); await assert.rejects(inspectLocalArtifact({ path, artifactsDir: dir, kind: "image" }), /权限/); chmodSync(path, 0o600);
});

test("media: symlink, hard link and realpath escape fail before the decoder", async (t) => {
  const dir = directory(t); const outside = join(directory(t), "outside.png"); writeFileSync(outside, PNG_BYTES);
  const soft = join(dir, "soft.png"); symlinkSync(outside, soft);
  await assert.rejects(inspectLocalArtifact({ path: soft, artifactsDir: dir, kind: "image" }), /链接/);
  const hard = join(dir, "hard.png"); linkSync(outside, hard);
  await assert.rejects(inspectLocalArtifact({ path: hard, artifactsDir: dir, kind: "image" }), /链接/);
  await assert.rejects(inspectLocalArtifact({ path: outside, artifactsDir: dir, kind: "image" }), /超出/);
  const symlinkRoot = join(directory(t), "root"); symlinkSync(dir, symlinkRoot);
  await assert.rejects(inspectLocalArtifact({ path: soft, artifactsDir: symlinkRoot, kind: "image" }), /符号链接/);
});

for (const response of [new Response("forbidden", { status: 403 }), new Response(""), new Response("<html>access denied</html>", { headers: { "content-type": "image/png" } }), new Response(PNG_BYTES.subarray(0, 40))]) {
  test("media: forbidden, empty, HTML and truncated deliveries never produce a landed artifact", async (t) => {
    const dir = directory(t); mock(t, response); const result = await download(dir);
    assert.equal(result.ok, false); assert.equal(result.status, "failed"); assert.deepEqual(readdirSync(dir), []);
  });
}

test("media: content length, CRC and container bounds are checked before decoding", async (t) => {
  const dir = directory(t);
  for (const response of [
    new Response(PNG_BYTES, { headers: { "content-length": String(65 * 1024 * 1024) } }),
    new Response(PNG_BYTES, { headers: { "content-length": String(PNG_BYTES.length + 1) } }),
    new Response(Buffer.from(PNG_BYTES).fill(255, 20, 21)),
  ]) {
    const original = globalThis.fetch; globalThis.fetch = async () => response;
    try { assert.equal((await download(dir)).ok, false); } finally { globalThis.fetch = original; }
  }
  const video = join(dir, "fake.mp4"); writeFileSync(video, Buffer.from("0000ftyp0000mdat"));
  await assert.rejects(inspectLocalArtifact({ path: video, artifactsDir: dir, kind: "video" }), /MP4/);
  writeFileSync(video, MP4_BYTES.subarray(0, MP4_BYTES.length - 10));
  await assert.rejects(inspectLocalArtifact({ path: video, artifactsDir: dir, kind: "video" }), /MP4/);
});

test("media: credential URLs, unsafe task IDs and transport errors do not write artifacts", async (t) => {
  const dir = directory(t); let requests = 0; mock(t, async () => { requests += 1; throw new Error("transport failed"); });
  const credentialUrl = new URL("https://synthetic.invalid/image");
  credentialUrl.username = "user"; credentialUrl.password = "test-only-password";
  assert.equal((await download(dir, { url: credentialUrl.href })).ok, false);
  assert.equal((await download(dir, { taskId: "../escape" })).ok, false);
  assert.equal(requests, 0); assert.equal((await download(dir)).ok, false); assert.equal(requests, 1); assert.deepEqual(readdirSync(dir), []);
});

test("media: wrong MIME and URL-only or missing manifests are not accepted as receipts", async (t) => {
  const dir = directory(t); mock(t, new Response(PNG_BYTES, { headers: { "content-type": "image/jpeg" } }));
  assert.equal((await download(dir)).ok, false);
  assert.equal((await verifyArtifactReceipts({ artifacts: [], receipt: { synced: true }, artifactsDir: dir, kind: "image" })).ok, false);
  assert.equal((await verifyArtifactReceipts({ artifacts: [{ url: "https://synthetic.invalid/image" }], receipt: { artifacts: [{ url: "https://synthetic.invalid/image" }] }, artifactsDir: dir, kind: "image" })).ok, false);
});
