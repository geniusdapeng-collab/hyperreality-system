import { describe, expect, it, vi } from "vitest";
import type { BundleUiProjection } from "@workloom/base/bundles";
import { bindVerifiedActiveBundle, validateProjectionStructure } from "./active-bundle.js";

function projection(overrides: Partial<BundleUiProjection> = {}): BundleUiProjection {
  return {
    primaryBundleId: "geo-growth",
    bundleId: "geo-growth",
    bundleName: "获客经营组合",
    bundleVersion: "1.0.0",
    bundleStatus: "candidate",
    contractVersion: "2.0.0",
    integrityDigest: "a".repeat(64),
    signatureKeyId: null,
    sources: [{
      bundleId: "hotel", bundleName: "酒店经营", bundleVersion: "1.0.0",
      bundleStatus: "candidate", integrityDigest: "b".repeat(64), signatureKeyId: null,
      role: "dependency", parentBundleId: "geo-growth",
    }, {
      bundleId: "geo-growth", bundleName: "获客经营组合", bundleVersion: "1.0.0",
      bundleStatus: "candidate", integrityDigest: "a".repeat(64), signatureKeyId: null,
      role: "primary", parentBundleId: null,
    }],
    navigationPermissionUniverse: [],
    ui: {
      schemaVersion: "workloom.bundle.ui/v1", terminology: {}, navigation: { slots: [] },
      home: { widgets: [] }, objects: [], workflows: [],
      serviceFront: { enabled: false, identityPolicy: "disabled", tabs: [], services: [] },
      theme: { brand: {} }, permissions: [], experiments: [],
    },
    ...overrides,
  };
}

describe("活动主 Bundle 与组合投影绑定", () => {
  it("唯一 active 主包可绑定经过独立完整性校验的组合来源", () => {
    const result = bindVerifiedActiveBundle({
      workspaceBundleId: "geo-growth",
      activeInstalls: [{ id: "install-primary", bundleId: "geo-growth" }],
    }, () => projection());
    expect(result).toMatchObject({ state: "ready", bundleId: "geo-growth", installId: "install-primary" });
  });

  it.each([
    {
      label: "没有活动装配",
      facts: { workspaceBundleId: "geo-growth", activeInstalls: [] },
      state: "not-installed",
    },
    {
      label: "存在多条活动装配",
      facts: { workspaceBundleId: "geo-growth", activeInstalls: [
        { id: "one", bundleId: "geo-growth" }, { id: "two", bundleId: "hotel" },
      ] },
      state: "not-installed",
    },
    {
      label: "工作区指针指向其他包",
      facts: { workspaceBundleId: "other-tenant-bundle", activeInstalls: [{ id: "one", bundleId: "geo-growth" }] },
      state: "bundle-mismatch",
    },
  ])("$label时在加载磁盘投影前失败关闭", ({ facts, state }) => {
    const loader = vi.fn(() => projection());
    expect(bindVerifiedActiveBundle(facts, loader).state).toBe(state);
    expect(loader).not.toHaveBeenCalled();
  });

  it("投影伪造主包身份、重复来源或缺少依赖摘要时失败关闭", () => {
    const facts = {
      workspaceBundleId: "geo-growth",
      activeInstalls: [{ id: "install-primary", bundleId: "geo-growth" }],
    };
    expect(bindVerifiedActiveBundle(facts, () => projection({ primaryBundleId: "hotel" })).state)
      .toBe("projection-invalid");
    expect(bindVerifiedActiveBundle(facts, () => projection({
      sources: [projection().sources![0]!, projection().sources![0]!, projection().sources![1]!],
    })).state).toBe("projection-invalid");
    expect(bindVerifiedActiveBundle(facts, () => projection({
      sources: projection().sources!.map((source) => source.bundleId === "hotel"
        ? { ...source, integrityDigest: null }
        : source),
    })).state).toBe("projection-invalid");
    expect(bindVerifiedActiveBundle(facts, () => projection({ primaryBundleId: undefined })).state)
      .toBe("projection-invalid");
  });

  it.each([
    ["缺少来源集合", () => projection({ sources: undefined })],
    ["缺少导航权限全集", () => projection({ navigationPermissionUniverse: undefined })],
    ["主来源伪造版本", () => projection({
      sources: projection().sources!.map((source) => source.role === "primary"
        ? { ...source, bundleVersion: "9.9.9" }
        : source),
    })],
    ["主来源伪造摘要", () => projection({
      sources: projection().sources!.map((source) => source.role === "primary"
        ? { ...source, integrityDigest: "c".repeat(64) }
        : source),
    })],
    ["主来源伪造状态", () => projection({
      sources: projection().sources!.map((source) => source.role === "primary"
        ? { ...source, bundleStatus: "stable", signatureKeyId: "release-key" }
        : source),
    })],
    ["主来源错误挂到依赖下", () => projection({
      sources: projection().sources!.map((source) => source.role === "primary"
        ? { ...source, parentBundleId: "hotel" }
        : source),
    })],
    ["依赖父级不存在", () => projection({
      sources: projection().sources!.map((source) => source.role === "dependency"
        ? { ...source, parentBundleId: "missing" }
        : source),
    })],
    ["依赖自指", () => projection({
      sources: projection().sources!.map((source) => source.role === "dependency"
        ? { ...source, parentBundleId: source.bundleId }
        : source),
    })],
    ["稳定主包混入候选依赖", () => projection({
      bundleStatus: "stable",
      signatureKeyId: "release-key",
      sources: projection().sources!.map((source) => source.role === "primary"
        ? { ...source, bundleStatus: "stable", signatureKeyId: "release-key" }
        : source),
    })],
    ["权限全集额外注入未投影权限", () => projection({
      navigationPermissionUniverse: ["geo-growth.internal.read"],
    })],
  ] satisfies Array<[string, () => BundleUiProjection]>)('%s时纯结构校验失败关闭', (_label, forged) => {
    expect(validateProjectionStructure(forged(), "geo-growth")).not.toBeNull();
  });

  it("依赖父链形成循环、不能收敛到唯一活动主包时失败关闭", () => {
    const base = projection();
    const cyclic = projection({
      sources: [
        { ...base.sources![0]!, parentBundleId: "ai-video" },
        {
          bundleId: "ai-video", bundleName: "视频生产", bundleVersion: "1.0.0",
          bundleStatus: "candidate", integrityDigest: "c".repeat(64), signatureKeyId: null,
          role: "dependency", parentBundleId: "hotel",
        },
        base.sources![1]!,
      ],
    });
    expect(validateProjectionStructure(cyclic, "geo-growth")).toMatch(/循环/);
  });

  it("多级依赖只要父链完整收敛到主包即可通过", () => {
    const base = projection();
    const nested = projection({
      sources: [
        { ...base.sources![0]!, parentBundleId: "ai-video" },
        {
          bundleId: "ai-video", bundleName: "视频生产", bundleVersion: "1.0.0",
          bundleStatus: "candidate", integrityDigest: "c".repeat(64), signatureKeyId: null,
          role: "dependency", parentBundleId: "geo-growth",
        },
        base.sources![1]!,
      ],
    });
    expect(validateProjectionStructure(nested, "geo-growth")).toBeNull();
  });
});
