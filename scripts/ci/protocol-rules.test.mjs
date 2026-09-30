import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  validateCommit,
  exclusiveModuleOf,
  findFileOverlaps,
  findModuleConflicts,
  isExemptSubject,
  layerForRepo,
  resolveLockOverlapMode,
  validateSubject,
} from "./protocol-rules.mjs";
import { isPrEvent, isSelfPull, openPrFiles, validatePrSnapshot, verifyPrFreshness } from "./verify-lock-conflict.mjs";

describe("提交信息规则", () => {
  it("接受合法提交并拒绝缺任务号", () => {
    const ok = validateSubject("feat(hotel): 徽章自动生成 [T-2026-0918-0042]", { repoSlug: "workloom-hotel" });
    assert.deepEqual(ok.errors, []);
    assert.deepEqual(ok.warnings, []);
    const missing = validateSubject("feat(hotel): 徽章自动生成", { repoSlug: "workloom-hotel" });
    assert.ok(missing.errors.some((error) => error.includes("任务号")));
  });

  it("未知 type 失败；layer 不符仅告警", () => {
    assert.ok(validateSubject("ciish(hotel): x [T-2026-0918-0042]", { repoSlug: "workloom-hotel" }).errors.length >= 1);
    const wrongLayer = validateSubject("feat(base): x [T-2026-0918-0042]", { repoSlug: "workloom-hotel" });
    assert.deepEqual(wrongLayer.errors, []);
    assert.ok(wrongLayer.warnings.some((warning) => warning.includes("与本仓不符")));
  });

  it("过渡期祖父规则：早于阈值的提交只校 type", () => {
    const legacy = validateCommit({ subject: "chore(ui): 升级共享 UI 0.1.2", date: "2026-09-18T12:00:00+08:00" }, { repoSlug: "workloom-hotel" });
    assert.deepEqual(legacy.errors, []);
    assert.ok(legacy.warnings.length >= 1);
    const strict = validateCommit({ subject: "chore(ui): 升级共享 UI 0.1.2", date: "2026-09-19T12:00:00+08:00" }, { repoSlug: "workloom-hotel" });
    assert.ok(strict.errors.some((error) => error.includes("任务号")));
  });

  it("豁免自动化与审计提交", () => {
    for (const subject of ["sync(base): 基座下发", "chore(ci): 调整流水线", "HP-31 共同根因", "Merge branch 'main'", "Revert \"fix: x\"", "rescue: preserve tree"]) {
      assert.equal(isExemptSubject(subject), true, subject);
      const result = validateSubject(subject, { repoSlug: "workloom-im" });
      assert.deepEqual(result.errors, []);
      assert.deepEqual(result.warnings, []);
    }
  });

  it("过渡开关允许缺任务号但保留格式校验", () => {
    const ok = validateSubject("docs(base): 说明", { repoSlug: "workloom-im", requireTaskId: false });
    assert.deepEqual(ok.errors, []);
    const bad = validateSubject("docs: 说明", { repoSlug: "workloom-im", requireTaskId: false });
    assert.ok(bad.errors.length >= 1);
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

  it("push 事件降级为提醒：合并已发生，跨 PR 重叠不再判红（回归 2026-09-27 main 误报）", () => {
    assert.equal(resolveLockOverlapMode({ event: "push" }), "warn");
    // PR 事件保持先到先得拦截
    assert.equal(resolveLockOverlapMode({ event: "pull_request" }), "fail");
    assert.equal(resolveLockOverlapMode({ event: null }), "fail");
    // 显式覆盖与人工严格模式优先
    assert.equal(resolveLockOverlapMode({ event: "push", envMode: "fail" }), "fail");
    assert.equal(resolveLockOverlapMode({ event: "pull_request", envMode: "warn" }), "warn");
    assert.equal(resolveLockOverlapMode({ event: "pull_request", envMode: "warn", strict: true }), "fail");
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

describe("PR 锁冲突门禁的新鲜度与失败闭合", () => {
  const source = "a".repeat(40);
  const main = "b".repeat(40);
  const oldMain = "c".repeat(40);
  const number = "178";
  const branch = "task/T-2026-0927-0009";
  const fixture = () => ({
    number,
    branch,
    eventSourceSha: source,
    eventTargetSha: main,
    pull: { number, state: "open", head: { sha: source, ref: `refs/heads/${branch}` }, base: { sha: main, ref: "refs/heads/main" } },
    main: { commit: { sha: main } },
    compare: { base_commit: { sha: main }, head_commit: { sha: source }, merge_base_commit: { sha: main }, files: [{ path: "scripts/ci/verify-lock-conflict.mjs" }] },
    finalPull: { number, state: "open", head: { sha: source, ref: `refs/heads/${branch}` }, base: { sha: main, ref: "refs/heads/main" } },
    finalMain: { commit: { sha: main } },
  });

  it("识别 PR 事件，合并后的 push 不再误判为 PR", () => {
    assert.equal(isPrEvent({ CNB_EVENT: "pull_request", CNB_PULL_REQUEST: "true" }), true);
    assert.equal(isPrEvent({ CNB_EVENT: "pull_request.update" }), true);
    assert.equal(isPrEvent({ CNB_EVENT: "push", CNB_PULL_REQUEST: "false" }), false);
    assert.equal(isPrEvent({ CNB_EVENT: "pull_request.merged", CNB_PULL_REQUEST: "false" }), false);
  });

  it("实时 source/target/main/merge base 一致时通过并取完整路径", () => {
    const result = validatePrSnapshot(fixture());
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.files, ["scripts/ci/verify-lock-conflict.mjs"]);
  });

  it("事件 target 旧、分支未包含最新 main、事件 source 旧均拒绝", () => {
    const staleEvent = fixture();
    staleEvent.eventTargetSha = oldMain;
    assert.match(validatePrSnapshot(staleEvent).errors.join(";"), /事件 target 已过时/);
    const staleBranch = fixture();
    staleBranch.compare.merge_base_commit.sha = oldMain;
    assert.match(validatePrSnapshot(staleBranch).errors.join(";"), /未包含最新 main/);
    const staleSource = fixture();
    staleSource.eventSourceSha = oldMain;
    assert.match(validatePrSnapshot(staleSource).errors.join(";"), /事件 source 已过时/);
  });

  it("PR/main 查询期间变动或 compare 缺失字段时拒绝", () => {
    const raced = fixture();
    raced.finalMain.commit.sha = oldMain;
    assert.match(validatePrSnapshot(raced).errors.join(";"), /main 已变化/);
    const malformed = fixture();
    malformed.compare.files = undefined;
    malformed.compare.merge_base_commit = undefined;
    assert.match(validatePrSnapshot(malformed).errors.join(";"), /merge base SHA 缺失或无效/);
    assert.match(validatePrSnapshot(malformed).errors.join(";"), /缺少文件列表/);
  });

  it("API 快照交叉验证成功；API 失败不会吞异常", async () => {
    const data = fixture();
    let pullReads = 0;
    const request = async (url) => {
      if (url.endsWith(`/pulls/${number}`)) return ++pullReads === 1 ? data.pull : data.finalPull;
      if (url.endsWith("/git/branches/main")) return data.main;
      if (url.includes("/git/compare/")) {
        assert.ok(url.endsWith(`${main}...${source}`));
        return data.compare;
      }
      throw new Error(`意外 API ${url}`);
    };
    const result = await verifyPrFreshness({ repoSlug: "workloom-ai/workloom-im", number, branch, eventSourceSha: source, eventTargetSha: main, request });
    assert.equal(result.headSha, source);
    assert.equal(pullReads, 2);
    await assert.rejects(verifyPrFreshness({ repoSlug: "workloom-ai/workloom-im", number, eventSourceSha: source, eventTargetSha: main, request: async () => { throw new Error("API unavailable"); } }), /API unavailable/);
    await assert.rejects(verifyPrFreshness({ repoSlug: "workloom-ai/workloom-im", number, eventSourceSha: source, eventTargetSha: "", request }), /缺少仓库、编号或 source\/target SHA/);
  });

  it("已知 PR 编号不同，不能凭祖先关系把并发 PR 排除", () => {
    assert.equal(isSelfPull({ number: "177", selfNumber: "178", headSha: oldMain, selfHeadSha: source, ancestorOfHead: true }), false);
  });

  it("open PR 全部分页扫描，并从 compare 读取完整路径", async () => {
    const pulls = Array.from({ length: 101 }, (_, index) => ({
      number: String(index + 1), title: `PR ${index + 1}`,
      head: { sha: source, ref: `task/${index + 1}` }, base: { sha: main },
    }));
    let pages = 0;
    const request = async (url) => {
      if (url.includes("/pulls?")) {
        pages += 1;
        return url.endsWith("page=1") ? pulls.slice(0, 100) : pulls.slice(100);
      }
      if (url.includes("/git/compare/")) return {
        base_commit: { sha: main }, head_commit: { sha: source }, files: [{ path: "apps/web/package.json" }],
      };
      throw new Error(`意外 API ${url}`);
    };
    const result = await openPrFiles("workloom-ai/workloom-im", "999", null, null, request);
    assert.equal(pages, 4);
    assert.equal(result.prs.length, 101);
    assert.deepEqual(result.prs[0].paths, ["apps/web/package.json"]);
  });

  it("并发 PR 列表重复或 compare 丢字段时拒绝得出无冲突结论", async () => {
    const pull = { number: "177", title: "test", head: { sha: source, ref: "task/x" }, base: { sha: main } };
    await assert.rejects(openPrFiles("workloom-ai/workloom-im", "999", null, null, async (url) => {
      if (url.includes("/pulls?")) return [pull, pull];
      throw new Error("不应查询 compare");
    }), /编号缺失或重复/);
    await assert.rejects(openPrFiles("workloom-ai/workloom-im", "999", null, null, async (url) => {
      if (url.includes("/pulls?")) return [pull];
      return { files: [] };
    }), /compare 不完整/);
    let listReads = 0;
    await assert.rejects(openPrFiles("workloom-ai/workloom-im", "999", null, null, async (url) => {
      if (url.includes("/pulls?")) return ++listReads === 1 ? [pull] : [{ ...pull, head: { ...pull.head, sha: oldMain } }];
      return { base_commit: { sha: main }, head_commit: { sha: source }, files: [{ path: "a.ts" }] };
    }), /扫描期间 open PR 列表或分支 SHA 变化/);
  });

  it("PR 事件没有 CNB_TOKEN 时脚本退出非零，包括本地 diff 为空的情况", () => {
    const env = { ...process.env, CNB_EVENT: "pull_request", CNB_PULL_REQUEST: "true", CNB_REPO_SLUG: "workloom-ai/workloom-im", CNB_PULL_REQUEST_IID: number, CNB_PULL_REQUEST_SHA: source, CNB_PULL_REQUEST_TARGET_SHA: main };
    delete env.CNB_TOKEN;
    const script = fileURLToPath(new URL("./verify-lock-conflict.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [script], { env, encoding: "utf8" });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /缺少 CNB_REPO_SLUG 或 CNB_TOKEN/);
  });
});
