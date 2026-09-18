import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  exclusiveModuleOf,
  findFileOverlaps,
  findModuleConflicts,
  isExemptSubject,
  layerForRepo,
  validateSubject,
} from "./protocol-rules.mjs";

describe("提交信息规则", () => {
  it("接受合法提交并拒绝缺任务号", () => {
    assert.deepEqual(validateSubject("feat(hotel): 徽章自动生成 [T-2026-0918-0042]", { repoSlug: "workloom-hotel" }), []);
    const missing = validateSubject("feat(hotel): 徽章自动生成", { repoSlug: "workloom-hotel" });
    assert.ok(missing.some((error) => error.includes("任务号")));
  });

  it("拒绝未知 type 与错层 layer", () => {
    assert.ok(validateSubject("ciish(hotel): x [T-2026-0918-0042]", { repoSlug: "workloom-hotel" }).length >= 1);
    const wrongLayer = validateSubject("feat(base): x [T-2026-0918-0042]", { repoSlug: "workloom-hotel" });
    assert.ok(wrongLayer.some((error) => error.includes("与本仓不符")));
  });

  it("豁免自动化与审计提交", () => {
    for (const subject of ["sync(base): 基座下发", "chore(ci): 调整流水线", "HP-31 共同根因", "Merge branch 'main'", "Revert \"fix: x\"", "rescue: preserve tree"]) {
      assert.equal(isExemptSubject(subject), true, subject);
      assert.deepEqual(validateSubject(subject, { repoSlug: "workloom-im" }), []);
    }
  });

  it("过渡开关允许缺任务号但保留格式校验", () => {
    assert.deepEqual(validateSubject("docs(base): 说明", { repoSlug: "workloom-im", requireTaskId: false }), []);
    assert.ok(validateSubject("docs: 说明", { repoSlug: "workloom-im", requireTaskId: false }).length >= 1);
  });

  it("layer 映射覆盖九仓", () => {
    assert.equal(layerForRepo("workloom-ai/workloom-im"), "base");
    assert.equal(layerForRepo("workloom-ai/panda-cineforge"), "ecom");
    assert.equal(layerForRepo("unknown/repo"), null);
  });
});

describe("并发冲突规则", () => {
  it("识别模块级互斥路径", () => {
    assert.equal(exclusiveModuleOf("sync/base-sync.mjs"), "sync/");
    assert.equal(exclusiveModuleOf("protocol/roles.yaml"), "protocol/");
    assert.equal(exclusiveModuleOf("packages/db/migrations/0001.sql"), "migrations/");
    assert.equal(exclusiveModuleOf("package.json"), "root:package.json");
    assert.equal(exclusiveModuleOf("apps/web/src/a.ts"), null);
  });

  it("不同文件但同一互斥模块也算冲突", () => {
    assert.deepEqual(findModuleConflicts(["sync/a.mjs"], ["sync/b.mjs"]), ["sync/"]);
    assert.deepEqual(findModuleConflicts(["apps/web/a.ts"], ["apps/web/b.ts"]), []);
  });

  it("同文件重叠判定", () => {
    assert.deepEqual(findFileOverlaps(["a/b.ts", "c/d.ts"], ["c/d.ts"]), ["c/d.ts"]);
    assert.deepEqual(findFileOverlaps(["a/b.ts"], ["x/y.ts"]), []);
  });
});

describe("路径解析与误判防护", () => {
  it("不同目录的同名文件不算冲突", () => {
    assert.deepEqual(findFileOverlaps(["apps/web/package.json"], ["apps/webb/package.json"]), []);
    assert.deepEqual(findModuleConflicts(["apps/web/package.json"], ["apps/webb/package.json"]), []);
  });

  it("根级 package.json 属于互斥模块，子目录 package.json 不属于", () => {
    assert.equal(exclusiveModuleOf("package.json"), "root:package.json");
    assert.equal(exclusiveModuleOf("apps/web/package.json"), null);
  });
});
