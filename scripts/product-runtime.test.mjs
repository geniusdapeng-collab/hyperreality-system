import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadProductRuntime } from "./product-runtime.mjs";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));

function manifest(overrides = {}) {
  return {
    schemaVersion: "workloom.product/v1",
    productId: "example-industry",
    role: "industry",
    displayName: "示例行业经营系统",
    repository: "example/example-industry",
    demoWorkspaceSlug: "example-demo",
    demoMemberNo: "MEM-X01",
    desktop: { portOffset: 321 },
    ...overrides,
  };
}

function fixture(manifest) {
  const root = mkdtempSync(join(tmpdir(), "workloom-product-runtime-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(join(root, "product.manifest.json"), `${JSON.stringify({
    schemaVersion: "workloom.product/v1",
    role: "industry",
    ...manifest,
  })}\n`);
  return realpathSync(root);
}

test("产品清单派生仓库、品牌与隔离端口", () => {
  const root = fixture({
    productId: "example-industry",
    displayName: "示例行业经营系统",
    repository: "example/example-industry",
    demoWorkspaceSlug: "example-demo",
    demoMemberNo: "MEM-X01",
    desktop: { portOffset: 321 },
  });
  try {
    assert.deepEqual(loadProductRuntime(root), {
      repositoryRoot: root,
      manifestPath: join(root, "product.manifest.json"),
      schemaVersion: "workloom.product/v1",
      productId: "example-industry",
      role: "industry",
      displayName: "示例行业经营系统",
      repository: "example/example-industry",
      demoWorkspaceSlug: "example-demo",
      demoMemberNo: "MEM-X01",
      portOffset: 321,
      serverPort: 9108,
      webPort: 5494,
      pgPort: 5753,
      natsPort: 4543,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("非法仓库、产品名与端口偏移失败关闭", () => {
  for (const manifest of [
    { productId: "bad", displayName: "正常名称", repository: "https://evil.invalid/repo", demoWorkspaceSlug: "demo", demoMemberNo: "MEM-1", desktop: { portOffset: 1 } },
    { productId: "bad", displayName: "名称\n注入", repository: "example/repo", demoWorkspaceSlug: "demo", demoMemberNo: "MEM-1", desktop: { portOffset: 1 } },
    { productId: "bad", displayName: "正常名称", repository: "example/repo", demoWorkspaceSlug: "BAD VALUE", demoMemberNo: "MEM-1", desktop: { portOffset: 1 } },
    { productId: "bad", displayName: "正常名称", repository: "example/repo", demoWorkspaceSlug: "demo", demoMemberNo: "bad member", desktop: { portOffset: 1 } },
    { productId: "bad", displayName: "正常名称", repository: "example/repo", demoWorkspaceSlug: "demo", demoMemberNo: "MEM-1", desktop: { portOffset: 901 } },
  ]) {
    const root = fixture(manifest);
    try {
      assert.throws(() => loadProductRuntime(root), /产品名称|GitHub 仓库|演示工作区|演示成员|端口偏移/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("缺失或伪造 schema/role 时失败关闭", () => {
  for (const patch of [
    { schemaVersion: "workloom.product/v0" },
    { schemaVersion: null },
    { role: "" },
    { role: "platform/operator" },
  ]) {
    const root = fixture({
      productId: "example-industry",
      displayName: "示例行业经营系统",
      repository: "example/example-industry",
      demoWorkspaceSlug: "example-demo",
      demoMemberNo: "MEM-X01",
      desktop: { portOffset: 321 },
      ...patch,
    });
    try {
      assert.throws(() => loadProductRuntime(root), /schemaVersion|产品角色/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("非 Git 解包运行时可从客户端目录向上解析自身身份", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workloom-unpacked-runtime-")));
  mkdirSync(join(root, "apps", "web"), { recursive: true });
  writeFileSync(join(root, "product.manifest.json"), `${JSON.stringify(manifest())}\n`);
  try {
    const product = loadProductRuntime(join(root, "apps", "web"));
    assert.equal(product.repositoryRoot, root);
    assert.equal(product.productId, "example-industry");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Vite 身份桥在非 Git 解包目录中固定使用脚本所在产品根", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workloom-unpacked-vite-")));
  const scripts = join(root, "scripts");
  const client = join(root, "apps", "web");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(client, { recursive: true });
  writeFileSync(join(root, "product.manifest.json"), `${JSON.stringify(manifest())}\n`);
  copyFileSync(join(SCRIPTS_DIR, "product-runtime.mjs"), join(scripts, "product-runtime.mjs"));
  copyFileSync(join(SCRIPTS_DIR, "vite-product.mjs"), join(scripts, "vite-product.mjs"));
  try {
    const moduleUrl = pathToFileURL(join(scripts, "vite-product.mjs")).href;
    const result = execFileSync(process.execPath, [
      "--input-type=module",
      "--eval",
      `const { workloomProductVite } = await import(${JSON.stringify(moduleUrl)}); const value = workloomProductVite("测试端"); process.stdout.write(value.define.__WORKLOOM_PRODUCT_ID__);`,
    ], { cwd: client, encoding: "utf8" });
    assert.equal(result, JSON.stringify("example-industry"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("受控 pathPrefix 产品从仓根身份构建，但必须由完整同步 state 精确绑定", () => {
  const repository = realpathSync(mkdtempSync(join(tmpdir(), "workloom-path-prefix-product-")));
  execFileSync("git", ["init", "-q"], { cwd: repository });
  const productRoot = join(repository, "governance");
  const scripts = join(productRoot, "scripts");
  mkdirSync(scripts, { recursive: true });
  writeFileSync(join(repository, "product.manifest.json"), `${JSON.stringify(manifest({ productId: "nested-product" }))}\n`);
  writeFileSync(join(repository, ".workloom-base-sync.json"), `${JSON.stringify({
    baseRepo: "geniusdapeng-collab/workloom-im",
    lastSyncedBaseSha: "a".repeat(40),
    lastSyncMode: "full",
    pathPrefix: "governance",
  })}\n`);
  copyFileSync(join(SCRIPTS_DIR, "product-runtime.mjs"), join(scripts, "product-runtime.mjs"));
  copyFileSync(join(SCRIPTS_DIR, "vite-product.mjs"), join(scripts, "vite-product.mjs"));
  try {
    const productId = execFileSync(process.execPath, [join(scripts, "product-runtime.mjs"), "--field", "productId"], {
      cwd: productRoot,
      encoding: "utf8",
    }).trim();
    const manifestPath = execFileSync(process.execPath, [join(scripts, "product-runtime.mjs"), "--manifest-path"], {
      cwd: productRoot,
      encoding: "utf8",
    }).trim();
    assert.equal(productId, "nested-product");
    assert.equal(manifestPath, join(repository, "product.manifest.json"));

    const moduleUrl = pathToFileURL(join(scripts, "vite-product.mjs")).href;
    const viteProductId = execFileSync(process.execPath, [
      "--input-type=module",
      "--eval",
      `const { workloomProductVite } = await import(${JSON.stringify(moduleUrl)}); process.stdout.write(workloomProductVite("测试端").define.__WORKLOOM_PRODUCT_ID__);`,
    ], { cwd: productRoot, encoding: "utf8" });
    assert.equal(viteProductId, JSON.stringify("nested-product"));
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("pathPrefix state 的来源、模式、SHA 或目录任一不可信时不得借用仓根身份", () => {
  for (const patch of [
    { baseRepo: "attacker/workloom-im" },
    { lastSyncMode: "required-only" },
    { lastSyncedBaseSha: "not-a-sha" },
    { pathPrefix: "other" },
  ]) {
    const repository = realpathSync(mkdtempSync(join(tmpdir(), "workloom-path-prefix-reject-")));
    execFileSync("git", ["init", "-q"], { cwd: repository });
    const scripts = join(repository, "governance", "scripts");
    mkdirSync(scripts, { recursive: true });
    writeFileSync(join(repository, "product.manifest.json"), `${JSON.stringify(manifest({ productId: "outer-product" }))}\n`);
    writeFileSync(join(repository, ".workloom-base-sync.json"), `${JSON.stringify({
      baseRepo: "geniusdapeng-collab/workloom-im",
      lastSyncedBaseSha: "a".repeat(40),
      lastSyncMode: "full",
      pathPrefix: "governance",
      ...patch,
    })}\n`);
    copyFileSync(join(SCRIPTS_DIR, "product-runtime.mjs"), join(scripts, "product-runtime.mjs"));
    try {
      const result = spawnSync(process.execPath, [join(scripts, "product-runtime.mjs"), "--field", "productId"], {
        cwd: join(repository, "governance"),
        encoding: "utf8",
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /缺少受保护的 product\.manifest\.json/u);
      assert.doesNotMatch(result.stdout, /outer-product/u);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  }
});

test("解包运行时缺少自身清单时不得借用外部 Git 根身份", () => {
  const outer = realpathSync(mkdtempSync(join(tmpdir(), "workloom-outer-repository-")));
  execFileSync("git", ["init", "-q"], { cwd: outer });
  writeFileSync(join(outer, "product.manifest.json"), `${JSON.stringify(manifest({ productId: "outer-product" }))}\n`);
  const runtime = join(outer, "downloads", "runtime");
  const scripts = join(runtime, "scripts");
  const client = join(runtime, "apps", "web");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(client, { recursive: true });
  copyFileSync(join(SCRIPTS_DIR, "product-runtime.mjs"), join(scripts, "product-runtime.mjs"));
  try {
    const result = spawnSync(process.execPath, [join(scripts, "product-runtime.mjs"), "--field", "productId"], {
      cwd: client,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /缺少受保护的 product\.manifest\.json/u);
    assert.doesNotMatch(result.stdout, /outer-product/u);
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});
