import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalBundleArtifactPayload, parseBundleManifest } from "@workloom/industry-contract";
import { loadBundleUiProjection } from "./assembly.js";

function writeProjectionBundle(root: string, input: {
  bundleId: string;
  version?: string;
  dependencies?: Array<{ bundleId: string; version: string }>;
  terminology?: Record<string, string>;
  route?: string;
  permission?: string;
  widgetSlot?: string;
  object?: string;
  workflow?: string;
}) {
  const version = input.version ?? "1.0.0";
  const permission = input.permission ?? `${input.bundleId}.console.read`;
  const raw = {
    schemaVersion: "workloom.bundle/v1",
    name: `@workloom/${input.bundleId}`,
    version,
    workloom: {
      industry: input.bundleId,
      displayName: `${input.bundleId}组合包`,
      description: "用于验证多行业包权威投影",
      status: "candidate",
      owner: "WorkLoom",
      compatibility: { base: ">=0.1.0 <1.0.0", ui: ">=0.1.0 <1.0.0", contract: "2.0.0" },
      ...(input.dependencies ? { dependencies: input.dependencies } : {}),
      provides: { presets: [], fences: [], skills: [], schemas: [], ui: [], serviceFront: [], seeds: [] },
      ui: {
        schemaVersion: "workloom.bundle.ui/v1",
        terminology: input.terminology ?? {},
        navigation: { slots: input.route ? [{
          capabilityId: `${input.bundleId}.console`, title: `${input.bundleId}经营台`, route: input.route,
          group: "operations", icon: "report", clients: ["pc"], permissions: [permission],
        }] : [] },
        home: { widgets: input.widgetSlot ? [{
          slot: input.widgetSlot, component: `${input.bundleId}.Widget`, clients: ["pc"], props: {},
        }] : [] },
        objects: input.object ? [input.object] : [],
        workflows: input.workflow ? [input.workflow] : [],
        serviceFront: { enabled: false, identityPolicy: "disabled", tabs: [], services: [] },
        theme: { brand: {} }, permissions: input.route ? [permission] : [], experiments: [],
      },
    },
  };
  const normalized = parseBundleManifest(raw);
  const digest = createHash("sha256").update(canonicalBundleArtifactPayload(normalized, {})).digest("hex");
  const path = join(root, input.bundleId);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "bundle.json"), `${JSON.stringify({
    ...raw,
    integrity: { algorithm: "sha256", digest, assets: {} },
  }, null, 2)}\n`);
}

describe("多 Bundle 权威投影", () => {
  it("递归验真三个 Bundle，并按明确规则合并且保留来源", () => {
    const root = mkdtempSync(join(tmpdir(), "wl-bundle-composition-"));
    writeProjectionBundle(root, {
      bundleId: "hotel-core", route: "/hotel-operations", widgetSlot: "home.hotel",
      terminology: { customer: "住客" }, object: "住客诉求", workflow: "住客服务",
    });
    writeProjectionBundle(root, {
      bundleId: "ai-video", route: "/video-production", widgetSlot: "home.video",
      terminology: { content: "营销视频" }, object: "视频内容", workflow: "视频生产",
    });
    writeProjectionBundle(root, {
      bundleId: "geo-growth", route: "/growth-overview", widgetSlot: "home.video",
      dependencies: [
        { bundleId: "hotel-core", version: "1.0.0" },
        { bundleId: "ai-video", version: "1.0.0" },
      ],
      terminology: { lead: "获客线索" }, object: "获客线索", workflow: "归因复盘",
    });

    const projection = loadBundleUiProjection("geo-growth", root);
    expect(projection.primaryBundleId).toBe("geo-growth");
    expect(projection.sources?.map((source) => [source.bundleId, source.role])).toEqual([
      ["hotel-core", "dependency"], ["ai-video", "dependency"], ["geo-growth", "primary"],
    ]);
    expect(projection.ui.navigation.slots.map((slot) => [slot.capabilityId, slot.sourceBundleId])).toEqual([
      ["hotel-core.console", "hotel-core"],
      ["ai-video.console", "ai-video"],
      ["geo-growth.console", "geo-growth"],
    ]);
    expect(projection.navigationPermissionUniverse).toEqual([
      "ai-video.console.read", "geo-growth.console.read", "hotel-core.console.read",
    ]);
    expect(projection.ui.home.widgets.map((widget) => widget.sourceBundleId)).toEqual([
      "hotel-core", "geo-growth",
    ]);
    expect(projection.ui.objects).toEqual(["住客诉求", "视频内容", "获客线索"]);
    expect(projection.ui.objectEntries?.[0]).toEqual({ label: "住客诉求", sourceBundleIds: ["hotel-core"] });
    expect(projection.ui.terminologySources?.customer).toEqual(["hotel-core"]);
  });

  it.each([
    { label: "缺少依赖", dependency: { bundleId: "missing-core", version: "1.0.0" }, expected: /不存在或不可读取/ },
    { label: "版本不符", dependency: { bundleId: "hotel-core", version: "2.0.0" }, expected: /要求 hotel-core@2\.0\.0/ },
  ])("在$label时失败关闭", ({ dependency, expected }) => {
    const root = mkdtempSync(join(tmpdir(), "wl-bundle-composition-invalid-"));
    writeProjectionBundle(root, { bundleId: "hotel-core" });
    writeProjectionBundle(root, { bundleId: "geo-growth", dependencies: [dependency] });
    expect(() => loadBundleUiProjection("geo-growth", root)).toThrow(expected);
  });

  it("拒绝循环、重复引用、导航冲突与术语冲突", () => {
    const cycleRoot = mkdtempSync(join(tmpdir(), "wl-bundle-composition-cycle-"));
    writeProjectionBundle(cycleRoot, {
      bundleId: "bundle-aa", dependencies: [{ bundleId: "bundle-bb", version: "1.0.0" }],
    });
    writeProjectionBundle(cycleRoot, {
      bundleId: "bundle-bb", dependencies: [{ bundleId: "bundle-aa", version: "1.0.0" }],
    });
    expect(() => loadBundleUiProjection("bundle-aa", cycleRoot)).toThrow(/形成循环/);

    const duplicateRoot = mkdtempSync(join(tmpdir(), "wl-bundle-composition-duplicate-"));
    writeProjectionBundle(duplicateRoot, { bundleId: "shared-core" });
    writeProjectionBundle(duplicateRoot, {
      bundleId: "hotel-core", dependencies: [{ bundleId: "shared-core", version: "1.0.0" }],
    });
    writeProjectionBundle(duplicateRoot, {
      bundleId: "geo-growth", dependencies: [
        { bundleId: "shared-core", version: "1.0.0" },
        { bundleId: "hotel-core", version: "1.0.0" },
      ],
    });
    expect(() => loadBundleUiProjection("geo-growth", duplicateRoot)).toThrow(/重复引用/);

    const conflictRoot = mkdtempSync(join(tmpdir(), "wl-bundle-composition-conflict-"));
    writeProjectionBundle(conflictRoot, {
      bundleId: "hotel-core", route: "/industry-dashboard", terminology: { customer: "住客" },
    });
    writeProjectionBundle(conflictRoot, {
      bundleId: "ai-video", route: "/industry-dashboard", terminology: { customer: "观众" },
    });
    writeProjectionBundle(conflictRoot, {
      bundleId: "geo-growth", dependencies: [
        { bundleId: "hotel-core", version: "1.0.0" },
        { bundleId: "ai-video", version: "1.0.0" },
      ],
    });
    expect(() => loadBundleUiProjection("geo-growth", conflictRoot)).toThrow(/术语.*冲突|导航路由.*重复/);
  });

  it("任一依赖内容被篡改时独立完整性校验失败关闭", () => {
    const root = mkdtempSync(join(tmpdir(), "wl-bundle-composition-tamper-"));
    writeProjectionBundle(root, { bundleId: "hotel-core", route: "/hotel-operations" });
    writeProjectionBundle(root, {
      bundleId: "geo-growth", dependencies: [{ bundleId: "hotel-core", version: "1.0.0" }],
    });
    const path = join(root, "hotel-core/bundle.json");
    const tampered = JSON.parse(readFileSync(path, "utf8"));
    tampered.workloom.displayName = "被篡改的依赖包";
    writeFileSync(path, `${JSON.stringify(tampered, null, 2)}\n`);
    expect(() => loadBundleUiProjection("geo-growth", root)).toThrow(/完整性摘要不一致/);
  });

  it("不能占用公共路由或借用其他包权限", () => {
    const routeRoot = mkdtempSync(join(tmpdir(), "wl-bundle-composition-base-route-"));
    expect(() => writeProjectionBundle(routeRoot, { bundleId: "geo-growth", route: "/approvals" }))
      .toThrow(/不得覆盖基座路由/);

    const permissionRoot = mkdtempSync(join(tmpdir(), "wl-bundle-composition-permission-"));
    expect(() => writeProjectionBundle(permissionRoot, {
      bundleId: "geo-growth", route: "/growth", permission: "hotel-core.console.read",
    })).toThrow(/自身命名空间/);
  });
});
