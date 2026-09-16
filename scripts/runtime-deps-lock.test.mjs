import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  verifyInstalledRuntimeTarget,
  verifyRuntimeDepsLock,
  verifyRuntimePackageLock,
} from "./runtime-deps-lock.mjs";
import { loadProductRuntime } from "./product-runtime.mjs";

const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));

function registryEntry(version, extra = {}) {
  return {
    version,
    resolved: `https://registry.npmjs.org/example/-/example-${version}.tgz`,
    integrity: `sha512-${Buffer.alloc(64, Number(version[0]) || 1).toString("base64")}`,
    ...extra,
  };
}

function manifest() {
  return {
    name: "workloom-runtime-payload",
    private: true,
    version: "0.0.0",
    dependencies: { esbuild: "0.28.2" },
  };
}

function packageLock() {
  return {
    name: "workloom-runtime-payload",
    version: "0.0.0",
    lockfileVersion: 3,
    packages: {
      "": { name: "workloom-runtime-payload", version: "0.0.0", dependencies: { esbuild: "0.28.2" } },
      "node_modules/esbuild": registryEntry("0.28.2"),
      "node_modules/@esbuild/darwin-arm64": registryEntry("0.28.2", { os: ["darwin"], cpu: ["arm64"] }),
      "node_modules/@esbuild/darwin-x64": registryEntry("0.28.2", { os: ["darwin"], cpu: ["x64"] }),
      "node_modules/@esbuild/win32-x64": registryEntry("0.28.2", { os: ["win32"], cpu: ["x64"] }),
    },
  };
}

function writePackage(root, path, value) {
  const directory = join(root, "node_modules", ...path.split("/"));
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), `${JSON.stringify(value)}\n`);
}

test("仓库提交的每产品 runtime lock 与当前依赖输入完全一致", () => {
  const expected = loadProductRuntime(REPOSITORY_ROOT);
  const verified = verifyRuntimeDepsLock(REPOSITORY_ROOT);
  assert.deepEqual(
    {
      productId: verified.product.productId,
      role: verified.product.role,
      repository: verified.product.repository,
    },
    {
      productId: expected.productId,
      role: expected.role,
      repository: expected.repository,
    },
  );
});

test("package-lock 必须锁定完整三目标原生包与 registry integrity", () => {
  assert.doesNotThrow(() => verifyRuntimePackageLock(manifest(), packageLock()));

  const missingTarget = packageLock();
  delete missingTarget.packages["node_modules/@esbuild/win32-x64"];
  assert.throws(() => verifyRuntimePackageLock(manifest(), missingTarget), /win32-x64 原生包/u);

  const missingIntegrity = packageLock();
  delete missingIntegrity.packages["node_modules/esbuild"].integrity;
  assert.throws(() => verifyRuntimePackageLock(manifest(), missingIntegrity), /SHA-512/u);

  const mirror = packageLock();
  mirror.packages["node_modules/esbuild"].resolved = "https://mirror.invalid/esbuild.tgz";
  assert.throws(() => verifyRuntimePackageLock(manifest(), mirror), /官方 registry/u);

  const rootDrift = packageLock();
  rootDrift.packages[""].dependencies.esbuild = "0.27.0";
  assert.throws(() => verifyRuntimePackageLock(manifest(), rootDrift), /根依赖/u);
});

test("安装后目标校验拒绝宿主架构原生包并生成稳定 inventory 摘要", () => {
  const stage = mkdtempSync(join(tmpdir(), "workloom-runtime-stage-"));
  const verified = { manifest: manifest(), packageLock: packageLock() };
  try {
    writePackage(stage, "esbuild", { name: "esbuild", version: "0.28.2" });
    writePackage(stage, "@esbuild/darwin-x64", {
      name: "@esbuild/darwin-x64",
      version: "0.28.2",
      os: ["darwin"],
      cpu: ["x64"],
    });
    const first = verifyInstalledRuntimeTarget(stage, "darwin", "x64", verified);
    const second = verifyInstalledRuntimeTarget(stage, "darwin", "x64", verified);
    assert.equal(first.packages, 2);
    assert.equal(first.inventorySha256, second.inventorySha256);

    writePackage(stage, "@esbuild/darwin-arm64", {
      name: "@esbuild/darwin-arm64",
      version: "0.28.2",
      os: ["darwin"],
      cpu: ["arm64"],
    });
    assert.throws(
      () => verifyInstalledRuntimeTarget(stage, "darwin", "x64", verified),
      /混入非目标原生包/u,
    );
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
});

test("正式与应急装配线统一使用每产品 lock、目标 OS/CPU 和身份闭包", () => {
  const electron = readFileSync(join(REPOSITORY_ROOT, "scripts/pack-electron-payload.sh"), "utf8");
  const windows = readFileSync(join(REPOSITORY_ROOT, "scripts/pack-windows.sh"), "utf8");
  const macos = readFileSync(join(REPOSITORY_ROOT, "scripts/pack-macos.sh"), "utf8");
  for (const source of [electron, windows, macos]) {
    assert.match(source, /runtime-deps-lock\.mjs stage/u);
    assert.match(source, /product-runtime\.mjs --manifest-path/u);
    assert.match(source, /PRODUCT_MANIFEST_PATH/u);
    assert.match(source, /product\.manifest\.json/u);
    assert.match(source, /scripts\/product-runtime\.mjs/u);
    assert.match(source, /scripts\/vite-product\.mjs/u);
    assert.match(source, /payload-policy\.mjs assert-runtime/u);
    assert.doesNotMatch(source, /\bnpm install --no-audit --no-fund --legacy-peer-deps/u);
  }
  assert.match(electron, /--os "\$TARGET_OS" --cpu "\$TARGET_CPU"/u);
  assert.match(windows, /--os win32 --cpu x64/u);
  assert.match(macos, /--os darwin --cpu "\$NODE_ARCH"/u);
  assert.match(macos, /x86_64\|x64\) NATS_ARCH="amd64"/u);
  assert.doesNotMatch(windows, /\bcopy_nm\b/u);
  const product = loadProductRuntime(REPOSITORY_ROOT);
  if (product.repository === "geniusdapeng-collab/workloom-im") {
    const workflow = readFileSync(join(REPOSITORY_ROOT, ".github/workflows/desktop-production-release.yml"), "utf8");
    assert.doesNotMatch(workflow, /node-version:\s*24(?:\s|,|$)/u);
    assert.match(workflow, /node-version:\s*24\.19\.0/u);
  }
});
