import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { auditExperimentLane, insideManagedRoot, matchesAny } from "./experiment-rules.mjs";

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
