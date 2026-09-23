import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { auditExperimentLane, auditIsolatedRepos, insideManagedRoot, matchesAny } from "./experiment-rules.mjs";

const baseScope = (overrides = {}) => ({
  include: ["packages/base/**", "packages/runtime/**"],
  clientFoundationCapability: { industryExtensionPaths: ["apps/*/src/extensions/**"] },
  ...overrides,
});

describe("实验车道护栏", () => {
  it("合规实验仓无告警", () => {
    const findings = auditExperimentLane({
      children: [{
        repo: "org/fox", lane: "experiment", experimentNote: "试验田",
        experimentPaths: ["apps/web/src/campaign/**"],
        industryExtensionPaths: ["apps/*/src/campaign/**"],
      }],
      baseScope: baseScope(),
    });
    assert.deepEqual(findings, []);
  });

  it("实验路径被 base-sync include 命中 → SYNC_WOULD_OVERWRITE", () => {
    const findings = auditExperimentLane({
      children: [{ repo: "org/fox", lane: "experiment", experimentNote: "x", experimentPaths: ["apps/web/src/campaign/**"], industryExtensionPaths: ["apps/*/src/campaign/**"] }],
      baseScope: baseScope({ include: ["apps/web/**"] }),
    });
    assert.ok(findings.some((item) => item.code === "SYNC_WOULD_OVERWRITE"));
  });

  it("受管根内且不在白名单 → UI_UPGRADE_WOULD_FAIL", () => {
    const findings = auditExperimentLane({
      children: [{ repo: "org/growth", lane: "experiment", experimentNote: "x", experimentPaths: ["apps/web/src/components/hud/**"], industryExtensionPaths: [] }],
      baseScope: baseScope(),
    });
    assert.ok(findings.some((item) => item.code === "UI_UPGRADE_WOULD_FAIL"));
  });

  it("缺 experimentNote / experimentPaths 也报错", () => {
    const findings = auditExperimentLane({ children: [{ repo: "org/x", lane: "experiment" }], baseScope: baseScope() });
    assert.ok(findings.some((item) => item.code === "MISSING_NOTE"));
    assert.ok(findings.some((item) => item.code === "MISSING_PATHS"));
  });

  it("受管根与白名单匹配", () => {
    assert.equal(insideManagedRoot("apps/web/src/a.ts"), true);
    assert.equal(insideManagedRoot("apps/server/src/a.ts"), false);
    assert.equal(matchesAny("apps/web/src/extensions/a.tsx", ["apps/*/src/extensions/**"]), true);
  });
});

describe("隔离副本护栏", () => {
  const valid = { repo: "org/copy", note: "激进改造实验副本", isolatedSince: "2026-09-21", syncPolicy: "none-in-none-out" };

  it("登记完整且未混入 children → 无告警", () => {
    const findings = auditIsolatedRepos({ children: [{ repo: "org/hotel" }], isolatedRepos: [valid] });
    assert.deepEqual(findings, []);
  });

  it("隔离仓混入 children → ISOLATED_IN_CHILDREN（会被 fanout 下发）", () => {
    const findings = auditIsolatedRepos({ children: [{ repo: "org/copy" }], isolatedRepos: [valid] });
    assert.deepEqual(findings.map((item) => item.code), ["ISOLATED_IN_CHILDREN"]);
  });

  it("缺 note / isolatedSince / syncPolicy → 逐项报错", () => {
    const findings = auditIsolatedRepos({ children: [], isolatedRepos: [{ repo: "org/copy" }] });
    assert.deepEqual(
      findings.map((item) => item.code).sort(),
      ["MISSING_ISOLATION_NOTE", "MISSING_ISOLATION_SINCE", "MISSING_SYNC_POLICY"],
    );
  });
});
