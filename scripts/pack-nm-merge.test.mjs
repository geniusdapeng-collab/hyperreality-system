import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildMergedRuntimeManifest, parsePnpmRuntimeLock, runtimeDependencySources } from "./pack-nm-merge.mjs";
import { payloadPolicyFor } from "./payload-policy.mjs";

function writeJson(path, value) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

function fixture({ withPlatformOps = true, conflictingZod = false, withoutLock = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "workloom-pack-nm-"));
  writeJson(join(root, "package.json"), {
    dependencies: { hono: "1.0.0" },
    devDependencies: { tsx: "4.0.0", electron: "99.0.0" },
  });
  writeJson(join(root, "apps/server/package.json"), { dependencies: { pg: "8.0.0" } });
  writeJson(join(root, "apps/web/package.json"), { devDependencies: { vite: "7.0.0" } });
  writeJson(join(root, "packages/base/package.json"), {
    dependencies: { zod: "4.0.0", "@workloom/shared": "workspace:*" },
  });
  if (withPlatformOps) {
    writeJson(join(root, "platform-ops/package.json"), {
      name: "@workloom/platform-ops",
      dependencies: { "platform-only-dep": "1.2.3" },
    });
  }
  if (!withoutLock) {
    writeJson(join(root, "pnpm-lock.yaml"), {
      lockfileVersion: "9.0",
      importers: {
        ".": {
          dependencies: {
            hono: { specifier: "1.0.0", version: "1.0.0" },
          },
          devDependencies: {
            tsx: { specifier: "4.0.0", version: "4.0.0" },
            electron: { specifier: "99.0.0", version: "99.0.0" },
          },
        },
        "apps/server": {
          dependencies: { pg: { specifier: "8.0.0", version: "8.0.0" } },
        },
        "apps/web": {
          devDependencies: { vite: { specifier: "7.0.0", version: "7.0.0" } },
        },
        "packages/base": {
          dependencies: {
            zod: { specifier: "4.0.0", version: conflictingZod ? "4.1.0" : "4.0.0" },
            "@workloom/shared": { specifier: "workspace:*", version: "link:../shared" },
          },
        },
        ...(withPlatformOps ? {
          "platform-ops": {
            dependencies: {
              "platform-only-dep": { specifier: "1.2.3", version: "1.2.3" },
            },
          },
        } : {}),
      },
    });
  }
  return root;
}

const basePolicy = payloadPolicyFor({
  productId: "workloom-im",
  role: "base",
  repository: "workloom-ai/workloom-im",
});
const andromedaPolicy = payloadPolicyFor({
  productId: "workroom-andromeda",
  role: "operations-hub",
  repository: "workloom-ai/workroom-andromeda",
});

test("pnpm 锁文件在 Windows CRLF 检出后保持同一解析语义", () => {
  const lf = [
    "lockfileVersion: '9.0'",
    "importers:",
    "  .:",
    "    dependencies:",
    "      hono:",
    "        specifier: 1.0.0",
    "        version: 1.0.0",
    "",
  ].join("\n");
  assert.deepEqual(parsePnpmRuntimeLock(lf.replaceAll("\n", "\r\n")), parsePnpmRuntimeLock(lf));
  assert.throws(() => parsePnpmRuntimeLock(lf.replace("\n", "\r")), /孤立 CR/u);
});

test("基座物理存在 platform-ops 时依赖合成仍排除平台工程", () => {
  const root = fixture();
  try {
    const sources = runtimeDependencySources(root, basePolicy).map(([file]) => file);
    assert.equal(sources.includes("platform-ops/package.json"), false);
    const merged = buildMergedRuntimeManifest(root, basePolicy);
    assert.equal(Object.hasOwn(merged.dependencies, "platform-only-dep"), false);
    assert.deepEqual(merged.dependencies, {
      hono: "1.0.0",
      pg: "8.0.0",
      tsx: "4.0.0",
      vite: "7.0.0",
      zod: "4.0.0",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("仙女座精确身份收集 platform-ops，缺包则阻断", () => {
  const root = fixture();
  const missingRoot = fixture({ withPlatformOps: false });
  try {
    const sources = runtimeDependencySources(root, andromedaPolicy).map(([file]) => file);
    assert.equal(sources.includes("platform-ops/package.json"), true);
    assert.equal(buildMergedRuntimeManifest(root, andromedaPolicy).dependencies["platform-only-dep"], "1.2.3");
    assert.throws(
      () => runtimeDependencySources(missingRoot, andromedaPolicy),
      /缺少 platform-ops\/package\.json/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(missingRoot, { recursive: true, force: true });
  }
});

test("范围 specifier 只输出 pnpm 锁定的精确版本", () => {
  const root = fixture();
  try {
    const pkgPath = join(root, "packages/base/package.json");
    writeJson(pkgPath, {
      dependencies: { zod: "^4.0.0", "@workloom/shared": "workspace:*" },
    });
    const lockPath = join(root, "pnpm-lock.yaml");
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    lock.importers["packages/base"].dependencies.zod.specifier = "^4.0.0";
    lock.importers["packages/base"].dependencies.zod.version = "4.4.3(peer@1.0.0)";
    writeJson(lockPath, lock);
    assert.equal(buildMergedRuntimeManifest(root, basePolicy).dependencies.zod, "4.4.3");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("缺锁、specifier 漂移与同名解析版本冲突均失败关闭", () => {
  const missing = fixture({ withoutLock: true });
  const drift = fixture();
  const conflict = fixture({ conflictingZod: true });
  try {
    assert.throws(() => buildMergedRuntimeManifest(missing, basePolicy), /pnpm-lock\.yaml/u);

    const driftLock = JSON.parse(readFileSync(join(drift, "pnpm-lock.yaml"), "utf8"));
    driftLock.importers["apps/server"].dependencies.pg.specifier = "^8.0.0";
    writeJson(join(drift, "pnpm-lock.yaml"), driftLock);
    assert.throws(() => buildMergedRuntimeManifest(drift, basePolicy), /specifier 漂移/u);

    writeJson(join(conflict, "package.json"), {
      dependencies: { zod: "4.0.0" },
      devDependencies: { tsx: "4.0.0" },
    });
    const conflictLock = JSON.parse(readFileSync(join(conflict, "pnpm-lock.yaml"), "utf8"));
    conflictLock.importers["."].dependencies.zod = { specifier: "4.0.0", version: "4.0.0" };
    writeJson(join(conflict, "pnpm-lock.yaml"), conflictLock);
    assert.throws(() => buildMergedRuntimeManifest(conflict, basePolicy), /运行依赖版本冲突 zod/u);
  } finally {
    for (const root of [missing, drift, conflict]) rmSync(root, { recursive: true, force: true });
  }
});

test("包目录创建顺序不影响依赖清单输出", () => {
  const first = fixture();
  const second = fixture();
  try {
    writeJson(join(first, "packages/z-last/package.json"), { dependencies: { beta: "2.0.0" } });
    writeJson(join(first, "packages/a-first/package.json"), { dependencies: { alpha: "1.0.0" } });
    writeJson(join(second, "packages/a-first/package.json"), { dependencies: { alpha: "1.0.0" } });
    writeJson(join(second, "packages/z-last/package.json"), { dependencies: { beta: "2.0.0" } });
    for (const root of [first, second]) {
      const lock = JSON.parse(readFileSync(join(root, "pnpm-lock.yaml"), "utf8"));
      lock.importers["packages/a-first"] = { dependencies: { alpha: { specifier: "1.0.0", version: "1.0.0" } } };
      lock.importers["packages/z-last"] = { dependencies: { beta: { specifier: "2.0.0", version: "2.0.0" } } };
      writeJson(join(root, "pnpm-lock.yaml"), lock);
    }
    assert.deepEqual(buildMergedRuntimeManifest(first, basePolicy), buildMergedRuntimeManifest(second, basePolicy));
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});
