/**
 * segment loader 测试：契约解析 / 严格校验 / 缺失列出（不静默 L9.2）
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listSegments, loadSegmentDefaults, resolveSegment } from "./segment.js";

function makeBundle(): string {
  const dir = mkdtempSync(join(tmpdir(), "seg-bundle-"));
  mkdirSync(join(dir, "presets"), { recursive: true });
  mkdirSync(join(dir, "skills", "fast-scan"), { recursive: true });
  mkdirSync(join(dir, "skills", "inspection-suite"), { recursive: true });
  mkdirSync(join(dir, "fences", "patches"), { recursive: true });
  writeFileSync(join(dir, "presets", "inspection-agent.yml"), "preset_key: inspection-agent\n");
  writeFileSync(join(dir, "fences", "patches", "audit-only-patch.yml"), "version: audit-only/v1\n");
  writeFileSync(join(dir, "segment-defaults.yml"), `
version: test/v1
segments:
  audit_only:
    label: 质检模式（只读体检期）
    pitch: 先体检，再托管
    fence_patch: fences/patches/audit-only-patch.yml
    presets: [inspection-agent]
    skills_ordered: [fast-scan, inspection-suite]
  managed:
    label: 正式托管
    pitch: 全量接管
    presets: [ghost-preset]
    skills_ordered: [fast-scan]
`);
  return dir;
}

describe("segment loader", () => {
  it("解析客群声明（label/pitch/patch/presets/skills 五字段）", () => {
    const dir = makeBundle();
    const { version, segments } = loadSegmentDefaults(dir);
    expect(version).toBe("test/v1");
    expect(segments).toHaveLength(2);
    const ao = segments.find((s) => s.key === "audit_only")!;
    expect(ao.label).toContain("质检模式");
    expect(ao.fencePatch).toBe("fences/patches/audit-only-patch.yml");
    expect(ao.presets).toEqual(["inspection-agent"]);
    expect(ao.skillsOrdered).toEqual(["fast-scan", "inspection-suite"]);
    const managed = segments.find((s) => s.key === "managed")!;
    expect(managed.fencePatch).toBeNull();
  });

  it("resolveSegment 校验通过并返回绝对路径装配清单", () => {
    const dir = makeBundle();
    const asm = resolveSegment(dir, "audit_only");
    expect(asm.presetFiles[0]).toContain("inspection-agent.yml");
    expect(asm.skillDirs).toHaveLength(2);
    expect(asm.fencePatchFile).toContain("audit-only-patch.yml");
  });

  it("未知客群 → 抛错并列出可选项", () => {
    const dir = makeBundle();
    expect(() => resolveSegment(dir, "nope")).toThrow(/未知客群.*audit_only \/ managed/);
  });

  it("引用断链 → 抛错并列出全部缺失项（不装半个班子）", () => {
    const dir = makeBundle();
    expect(() => resolveSegment(dir, "managed")).toThrow(/断链.*presets\/ghost-preset\.yml/);
  });

  it("segment-defaults.yml 缺失 → 抛错", () => {
    const dir = mkdtempSync(join(tmpdir(), "seg-empty-"));
    expect(() => listSegments(dir)).toThrow(/segment-defaults\.yml 不存在/);
  });
});
