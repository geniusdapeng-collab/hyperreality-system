import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadProductRuntime } from "./product-runtime.mjs";

function fixture(manifest) {
  const root = mkdtempSync(join(tmpdir(), "workloom-product-runtime-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(join(root, "product.manifest.json"), `${JSON.stringify(manifest)}\n`);
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
      productId: "example-industry",
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
