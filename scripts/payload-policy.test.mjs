import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertArchivePayloadBoundary,
  assertRuntimePayloadBoundary,
  findForbiddenArchiveEntries,
  loadPayloadPolicy,
  payloadPolicyFor,
  REQUIRED_RUNTIME_IDENTITY_PATHS,
} from "./payload-policy.mjs";

function product(overrides = {}) {
  return {
    schemaVersion: "workloom.product/v1",
    productId: "workloom-im",
    role: "base",
    displayName: "WorkLoom 织元",
    packageName: "workloom-im",
    repository: "geniusdapeng-collab/workloom-im",
    demoWorkspaceSlug: "ai-pm-demo",
    demoMemberNo: "MEM-001",
    desktop: { portOffset: 0 },
    ...overrides,
  };
}

function fixture(manifest, { git = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "workloom-payload-policy-"));
  if (git) execFileSync("git", ["init", "-q"], { cwd: root });
  if (manifest) writeFileSync(join(root, "product.manifest.json"), `${JSON.stringify(manifest)}\n`);
  return root;
}

function writeRuntimeIdentityPayload(runtime, manifest) {
  for (const relativePath of REQUIRED_RUNTIME_IDENTITY_PATHS) {
    const target = join(runtime, ...relativePath.split("/"));
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(
      target,
      relativePath === "product.manifest.json" ? `${JSON.stringify(manifest)}\n` : "// payload identity fixture\n",
    );
  }
}

function requiredArchiveEntries() {
  return REQUIRED_RUNTIME_IDENTITY_PATHS.map((relativePath) => `./runtime/${relativePath}`);
}

test("只有仙女座精确身份允许携带 platform-ops", () => {
  const andromeda = payloadPolicyFor(product({
    productId: "workroom-andromeda",
    role: "operations-hub",
    repository: "geniusdapeng-collab/workroom-andromeda",
  }));
  assert.equal(andromeda.includePlatformOps, true);
  assert.deepEqual(andromeda.forbiddenRuntimePaths, []);

  for (const forged of [
    product({ role: "operations-hub" }),
    product({ productId: "workroom-andromeda", role: "operations-hub" }),
    product({ productId: "workroom-andromeda", role: "operations-hub", repository: "attacker/workroom-andromeda" }),
    product({ productId: "hotel", role: "industry", repository: "geniusdapeng-collab/workloom-hotel" }),
  ]) {
    const policy = payloadPolicyFor(forged);
    assert.equal(policy.includePlatformOps, false);
    assert.deepEqual(policy.forbiddenRuntimePaths, [
      "platform-ops",
      "node_modules/@workloom/platform-ops",
    ]);
  }
});

test("基座即使物理存在平台源码和内部包也会被装包后检查阻断", () => {
  const root = fixture(product());
  const runtime = join(root, "runtime");
  writeRuntimeIdentityPayload(runtime, product());
  mkdirSync(join(runtime, "platform-ops"), { recursive: true });
  mkdirSync(join(runtime, "node_modules", "@workloom", "platform-ops"), { recursive: true });
  try {
    const policy = loadPayloadPolicy(root);
    assert.throws(
      () => assertRuntimePayloadBoundary(runtime, policy),
      /平台工程边界违规/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("归档清单对大小写、Windows 分隔符和相对段统一失败关闭", () => {
  const policy = payloadPolicyFor(product());
  const entries = [
    "./runtime/apps/server/index.js",
    ".\\runtime\\node_modules\\@workloom\\PLATFORM-OPS\\package.json",
    "payload/../runtime/platform-ops/bin/guard.mjs",
  ];
  assert.deepEqual(findForbiddenArchiveEntries(entries, policy), entries.slice(1));
  assert.throws(() => assertArchivePayloadBoundary(entries, policy), /平台工程边界违规/u);
});

test("缺失或不可校验的产品清单不能生成载荷策略", () => {
  for (const manifest of [
    null,
    product({ schemaVersion: "workloom.product/v0" }),
    product({ role: "platform/operator" }),
  ]) {
    const root = fixture(manifest);
    try {
      assert.throws(() => loadPayloadPolicy(root), /product\.manifest\.json|schemaVersion|产品角色/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("仙女座载荷检查允许平台源码，但不放宽其他产品", () => {
  const andromedaManifest = product({
    productId: "workroom-andromeda",
    role: "operations-hub",
    repository: "geniusdapeng-collab/workroom-andromeda",
  });
  const root = fixture(andromedaManifest);
  const runtime = join(root, "runtime");
  writeRuntimeIdentityPayload(runtime, andromedaManifest);
  mkdirSync(join(runtime, "platform-ops"), { recursive: true });
  mkdirSync(join(runtime, "node_modules", "@workloom", "platform-ops"), { recursive: true });
  try {
    const policy = loadPayloadPolicy(root);
    assert.doesNotThrow(() => assertRuntimePayloadBoundary(runtime, policy));
    assert.doesNotThrow(() => assertArchivePayloadBoundary([
      ...requiredArchiveEntries(),
      "runtime/platform-ops/package.json",
      "runtime/node_modules/@workloom/platform-ops/package.json",
    ], policy));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("非 Git 运行时缺少任一身份闭包文件时，目录与归档检查均失败关闭", () => {
  for (const missingPath of REQUIRED_RUNTIME_IDENTITY_PATHS) {
    const root = fixture(product(), { git: false });
    const runtime = join(root, "runtime");
    writeRuntimeIdentityPayload(runtime, product());
    rmSync(join(runtime, ...missingPath.split("/")), { force: true });
    try {
      const policy = loadPayloadPolicy(root);
      assert.throws(
        () => assertRuntimePayloadBoundary(runtime, policy),
        new RegExp(`产品身份载荷不完整.*${missingPath.replaceAll(".", "\\.")}`, "u"),
      );
      assert.throws(
        () => assertArchivePayloadBoundary(
          requiredArchiveEntries().filter((entry) => entry !== `./runtime/${missingPath}`),
          policy,
        ),
        new RegExp(`产品身份归档不完整.*${missingPath.replaceAll(".", "\\.")}`, "u"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("非 Git 运行时伪造产品身份时与源策略精确比对失败", () => {
  const sourceManifest = product();
  const root = fixture(sourceManifest, { git: false });
  const runtime = join(root, "runtime");
  writeRuntimeIdentityPayload(runtime, product({ displayName: "伪造产品名称" }));
  try {
    const policy = loadPayloadPolicy(root);
    assert.throws(
      () => assertRuntimePayloadBoundary(runtime, policy),
      /载荷产品身份与源策略不一致：displayName/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("产品清单未投影字段被篡改时摘要校验仍失败关闭", () => {
  const sourceManifest = product();
  const root = fixture(sourceManifest, { git: false });
  const runtime = join(root, "runtime");
  writeRuntimeIdentityPayload(runtime, product({ packageName: "forged-package" }));
  try {
    const policy = loadPayloadPolicy(root);
    assert.throws(
      () => assertRuntimePayloadBoundary(runtime, policy),
      /载荷产品清单与源策略不一致：SHA-256 不匹配/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("身份闭包目录与归档完整且产品身份一致时通过", () => {
  const sourceManifest = product();
  const root = fixture(sourceManifest, { git: false });
  const runtime = join(root, "runtime");
  writeRuntimeIdentityPayload(runtime, sourceManifest);
  try {
    const policy = loadPayloadPolicy(root);
    assert.doesNotThrow(() => assertRuntimePayloadBoundary(runtime, policy));
    assert.doesNotThrow(() => assertArchivePayloadBoundary(requiredArchiveEntries(), policy));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("归档中的身份闭包必须是精确文件路径，目录或大小写伪装不能通过", () => {
  const policy = payloadPolicyFor(product());
  const entries = requiredArchiveEntries();
  assert.throws(
    () => assertArchivePayloadBoundary(entries.map((entry) => (
      entry.endsWith("product.manifest.json") ? `${entry}/` : entry
    )), policy),
    /产品身份归档不完整.*product\.manifest\.json/u,
  );
  assert.throws(
    () => assertArchivePayloadBoundary(entries.map((entry) => (
      entry.endsWith("product.manifest.json") ? entry.toUpperCase() : entry
    )), policy),
    /产品身份归档不完整.*product\.manifest\.json/u,
  );
});
