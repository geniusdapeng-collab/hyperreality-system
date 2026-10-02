#!/usr/bin/env node
/**
 * 把一个 WorkLoom 仓纳管进开发协议（幂等）：
 *   ① 标签体系（CNB 每仓上限 10）② main 分支保护 ③ 协议文档 + CI 校验脚本 ④ .cnb.yml 协议门禁 stage ⑤ 分支 + PR
 * 用法：
 *   node scripts/tools/provision-protocol.mjs --repo workloom-ai/<name> [--base-repo workloom-ai/workloom-im]
 *        [--branch chore/protocol-onboarding-YYYYMMDD] [--dry-run] [--skip-push] [--allow-isolated]
 * 说明：只创建 PR；合并由 AI 在门禁全绿后按协议 §1 串行执行（人保留叫停权）。
 *       隔离副本（sync/child-repos.json#isolatedRepos）默认拒绝纳管——它们不接收基座下发；
 *       确需恢复时必须由产品所有者明确指令，并显式传 --allow-isolated。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createLabel, createPull, createBranchProtection, listBranchProtections, listLabels,
  branchProtectionPayload, validateBranchProtection, rawFile, requireToken,
  gitAuthenticationEnvironment, redactCredentials } from "./cnb-api.mjs";
export { gitAuthenticationEnvironment } from './cnb-api.mjs';
import { isIsolated } from "./fleet-rules.mjs";

export const FLEET_LABELS = {
  "t/draft": "6c757d",
  "t/doing": "0d6efd",
  "t/review": "fd7e14",
  "t/done": "198754",
  "t/blocked": "dc3545",
  "risk/review": "fd7e14",
  "risk/block": "dc3545",
  "src/human": "6f42c1",
  "src/auto": "0dcaf0",
  protocol: "495057",
};

export const PROTOCOL_ASSETS = [
  "docs/DEVELOPMENT-PROTOCOL.md",
  "scripts/ci/protocol-rules.mjs",
  "scripts/ci/verify-commit-msg.mjs",
  "scripts/ci/verify-lock-conflict.mjs",
  "scripts/ci/protocol-rules.test.mjs",
];

const GATE_STAGE = `    - name: 协议门禁（提交规范 + 并发冲突）
      script: |
        set -eu
        node --test scripts/ci/protocol-rules.test.mjs
        node scripts/ci/verify-commit-msg.mjs --self-test
        node scripts/ci/verify-lock-conflict.mjs --self-test
        node scripts/ci/verify-commit-msg.mjs
        node scripts/ci/verify-lock-conflict.mjs

`;

const STANDALONE_GATE = `.protocol-gate: &protocol_gate
  name: protocol-gate
  docker:
    image: node:24.19.0-bookworm
  stages:
${GATE_STAGE}`;

/** 把协议门禁插入已有流水线：优先插到 static-gate 的既有 stage 前；Python 栈则新增独立流水线并挂到 push/PR */
export function injectGate(cnbYaml) {
  if (cnbYaml.includes("协议门禁")) return { content: cnbYaml, changed: false, mode: "already" };
  const marker = "    - name: 产品身份与行业包治理\n";
  if (cnbYaml.includes(marker)) {
    return { content: cnbYaml.replace(marker, GATE_STAGE + marker), changed: true, mode: "static-gate" };
  }
  if (cnbYaml.includes("main:\n  push:\n")) {
    let next = cnbYaml.replace("main:\n  push:\n", STANDALONE_GATE + "main:\n  push:\n");
    next = next.replace(/^(\s*)- \*(py_gate|static_gate|db_gate|test_gate)\n/gm, "$1- *$2\n$1- *protocol_gate\n");
    if (!/pull_request:[\s\S]*protocol_gate/.test(next)) {
      next = next.replace(/^(\s*)pull_request:\n/gm, "$1pull_request:\n$1  - *protocol_gate\n");
    }
    return { content: next, changed: true, mode: "standalone" };
  }
  return { content: cnbYaml, changed: false, mode: "unsupported" };
}

function git(cwd, args, options = {}) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim(); }
  catch (error) { throw new Error(redactCredentials(`Git ${args[0]} 失败：${error.stderr?.toString() ?? error.code ?? 'unknown'}`)); }
}

export async function ensureLabels(slug, { dryRun = false, log = console.log } = {}) {
  const existing = new Set((await listLabels(slug)).map((label) => String(label.name)));
  const created = [];
  for (const [name, color] of Object.entries(FLEET_LABELS)) {
    if (existing.has(name)) continue;
    if (!dryRun) await createLabel(slug, { name, color, description: "WorkLoom 开发协议" });
    created.push(name);
  }
  // CNB 上限 10：若已有非标准标签，删除多余项（保留标准集）
  const extras = [...existing].filter((name) => !(name in FLEET_LABELS));
  if (extras.length) {
    const { deleteLabel } = await import("./cnb-api.mjs");
    for (const name of extras) {
      if (!dryRun) await deleteLabel(slug, name);
    }
  }
  log(`  标签：新增 ${created.length}（${created.join(", ") || "无"}）；清理非标准 ${extras.length}`);
  return { created, extras };
}

export async function ensureBranchProtection(slug, { dryRun = false, log = console.log } = {}) {
  const rules = await listBranchProtections(slug);
  const main = rules.find((rule) => rule.rule === "main");
  if (main) {
    const errors = validateBranchProtection(main);
    if (errors.length) throw new Error(`main 分支保护不足，必须先经授权收紧平台策略：${errors.join("；")}`);
    log("  分支保护：main 的 PR、状态检查、评审与管理员限制已回读有效");
    return { created: false };
  }
  if (!dryRun) await createBranchProtection(slug, branchProtectionPayload());
  if (!dryRun) {
    const actual = (await listBranchProtections(slug)).find(rule => rule.rule === "main");
    const errors = validateBranchProtection(actual);
    if (errors.length) throw new Error(`分支保护创建后回读不满足契约：${errors.join("；")}`);
  }
  log(`  分支保护：${dryRun ? "计划创建" : "已创建并回读"} main（PR + 状态检查 + 评审；禁管理员直推/强推/删除）`);
  return { created: true };
}

export async function provisionProtocol(slug, options = {}) {
  const {
    baseRepo = "workloom-ai/workloom-im",
    branch = `chore/protocol-onboarding-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`,
    dryRun = false,
    skipPush = false,
    allowIsolated = false,
    log = console.log,
  } = options;
  for (const target of [slug, baseRepo]) if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(target)) throw new Error('无效 CNB 仓库 slug');
  try { execFileSync('git', ['check-ref-format', '--branch', branch], { stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { throw new Error('无效纳管分支'); }
  const token = requireToken();
  log(`== 纳管 ${slug}`);

  const fleetText = await rawFile(baseRepo, "main", "sync/child-repos.json");
  if (!fleetText) throw new Error("无法读取隔离仓登记表，拒绝纳管");
  if (isIsolated(slug, fleetText) && !allowIsolated) {
    throw new Error(
      `${slug} 已登记为隔离副本（sync/child-repos.json#isolatedRepos）：不接收基座下发、也不向基座回流。` +
        `如产品所有者已明确要求恢复同步，请另开纳管任务卡并显式传 --allow-isolated。`,
    );
  }

  await ensureLabels(slug, { dryRun, log });
  await ensureBranchProtection(slug, { dryRun, log });

  const workdir = mkdtempSync(join(tmpdir(), "workloom-provision-"));
  const repoDir = join(workdir, "repo");
  const remote = `https://cnb.cool/${slug}.git`;
  const authEnv = gitAuthenticationEnvironment(token);
  try {
    git(workdir, ["clone", "--depth", "1", remote, "repo"], { env: authEnv });
    git(repoDir, ["config", "user.name", "cnb-protocol-bot"]);
    git(repoDir, ["config", "user.email", "protocol-bot@cnb.cool"]);
    const mainSha = git(repoDir, ["rev-parse", "HEAD"]);

    const files = [];
    for (const asset of PROTOCOL_ASSETS) {
      const content = await rawFile(baseRepo, "main", asset);
      if (!content) {
        throw new Error(`必需协议资产缺失：${asset}，拒绝创建不完整纳管 PR`);
      }
      const target = join(repoDir, asset);
      mkdirSync(dirname(target), { recursive: true });
      const before = existsSync(target) ? readFileSync(target, "utf8") : null;
      if (before === content) continue;
      if (!dryRun) writeFileSync(target, content, "utf8");
      files.push(asset);
    }
    log(`  协议资产：写入 ${files.length} 个（${files.join(", ") || "无需变更"}）`);

    const cnbPath = join(repoDir, ".cnb.yml");
    if (existsSync(cnbPath)) {
      const original = readFileSync(cnbPath, "utf8");
      const { content, changed, mode } = injectGate(original);
      if (mode === "unsupported") throw new Error("无法识别 .cnb.yml 结构，拒绝缺少协议门禁的纳管");
      if (changed && !dryRun) writeFileSync(cnbPath, content, "utf8");
      log(`  门禁流水线：${changed ? `已注入（${mode}）` : mode === "already" ? "已存在" : "结构未识别，需人工处理"}`);
      if (changed) files.push(".cnb.yml");
    } else {
      throw new Error("必需 .cnb.yml 缺失，拒绝无门禁纳管");
    }

    if (!files.length) {
      log("  无需变更：跳过分支/PR");
      return { slug, changed: false, mainSha };
    }
    if (dryRun) return { slug, changed: true, files, dryRun: true };

    git(repoDir, ["checkout", "-b", branch]);
    git(repoDir, ["add", "--", ...files]);
    const layer = options.layer ?? "base";
    git(repoDir, [
      "commit",
      "-m",
      `sync(${layer}): 纳管开发协作协议（文档 + CI 校验 + 门禁 stage） [${options.taskId ?? "T-2026-0918-0004"}]`,
    ]);
    if (skipPush) {
      log("  --skip-push：已本地提交，未推送");
      return { slug, changed: true, files, branch, pushed: false };
    }
    git(repoDir, ["push", "origin", `HEAD:refs/heads/${branch}`], { env: authEnv });
    const pull = await createPull(slug, {
      title: `sync: 纳管开发协作协议（文档 + CI 校验 + 门禁 stage） [${options.taskId ?? "T-2026-0918-0004"}]`,
      head: branch,
      base: "main",
      body: [
        "## 背景",
        "",
        "舰队扫描发现本仓是 WorkLoom 仓但尚未持有开发协议资产，自动纳管：",
        "",
        "- `docs/DEVELOPMENT-PROTOCOL.md`（受控副本，唯一源头在 workloom-im）",
        "- `scripts/ci/{protocol-rules,verify-commit-msg,verify-lock-conflict}.mjs` + 单测",
        "- `.cnb.yml` 新增「协议门禁（提交规范 + 并发冲突）」stage",
        "- 仓库标签体系（10 个，CNB 上限）与 main 分支保护（强制 PR + 必需状态检查）",
        "",
        "本 PR 由 `scripts/tools/provision-protocol.mjs` 自动创建；门禁全绿后由 AI 按协议 §1 串行合并（人保留叫停权）。",
      ].join("\n"),
    });
    log(`  已创建 PR #${pull?.number}`);
    return { slug, changed: true, files, branch, pull: pull?.number };
  } finally {
    if (!options.keepWorkdir) rmSync(workdir, { recursive: true, force: true });
  }
}

function main() {
  const index = process.argv.indexOf("--repo");
  const repo = index >= 0 ? process.argv[index + 1] : null;
  if (!repo) {
    console.error("用法：node scripts/tools/provision-protocol.mjs --repo <org/name> [--dry-run] [--skip-push] [--layer base] [--task-id T-...]");
    process.exit(2);
  }
  const options = {
    dryRun: process.argv.includes("--dry-run"),
    skipPush: process.argv.includes("--skip-push"),
    allowIsolated: process.argv.includes("--allow-isolated"),
    layer: process.argv.includes("--layer") ? process.argv[process.argv.indexOf("--layer") + 1] : undefined,
    taskId: process.argv.includes("--task-id") ? process.argv[process.argv.indexOf("--task-id") + 1] : undefined,
  };
  provisionProtocol(repo, options)
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(`纳管失败：${error?.message ?? error}`);
      process.exit(1);
    });
}

if (process.argv[1] && process.argv[1].endsWith("provision-protocol.mjs")) main();
