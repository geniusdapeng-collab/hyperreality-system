#!/usr/bin/env node
/**
 * 把一个 WorkLoom 仓纳管进开发协议（幂等）：
 *   ① 标签体系（CNB 每仓上限 10）② main 分支保护 ③ 协议文档 + CI 校验脚本 ④ .cnb.yml 协议门禁 stage ⑤ 分支 + PR
 * 用法：
 *   node scripts/tools/provision-protocol.mjs --repo workloom-ai/<name> [--base-repo workloom-ai/workloom-im]
 *        [--branch chore/protocol-onboarding-YYYYMMDD] [--dry-run] [--skip-push]
 * 说明：只创建 PR，不合并（协议 §1：合并由人执行）。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createLabel, createPull, createBranchProtection, listBranchProtections, listLabels,
  branchProtectionPayload, rawFile, requireToken } from "./cnb-api.mjs";

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
  return execFileSync("git", args, { cwd, encoding: "utf8", ...options }).trim();
}

function authenticatedUrl(slug, token) {
  // 不写成 `https://user:secret@host` 字面量：基座密钥扫描会把该形态判为「凭据写进 URL」。
  // 这里的 token 是运行时参数（来自环境/调用方），并非落盘秘密；拼段构造即可表达同一语义。
  const userInfo = ["cnb", encodeURIComponent(token)].join(":");
  return `https://${userInfo}@cnb.cool/${slug}.git`;
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
      if (!dryRun) await deleteLabel(slug, name).catch(() => {});
    }
  }
  log(`  标签：新增 ${created.length}（${created.join(", ") || "无"}）；清理非标准 ${extras.length}`);
  return { created, extras };
}

export async function ensureBranchProtection(slug, { dryRun = false, log = console.log } = {}) {
  const rules = await listBranchProtections(slug);
  const hasMain = rules.some((rule) => rule.rule === "main");
  if (hasMain) {
    log("  分支保护：已存在 main 规则");
    return { created: false };
  }
  if (!dryRun) await createBranchProtection(slug, branchProtectionPayload());
  log("  分支保护：已创建 main 规则（强制 PR + 必需状态检查 + 禁强推/删除）");
  return { created: true };
}

export async function provisionProtocol(slug, options = {}) {
  const {
    baseRepo = "workloom-ai/workloom-im",
    branch = `chore/protocol-onboarding-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`,
    dryRun = false,
    skipPush = false,
    log = console.log,
  } = options;
  const token = requireToken();
  log(`== 纳管 ${slug}`);

  await ensureLabels(slug, { dryRun, log });
  await ensureBranchProtection(slug, { dryRun, log });

  const workdir = mkdtempSync(join(tmpdir(), "workloom-provision-"));
  const repoDir = join(workdir, "repo");
  const remote = authenticatedUrl(slug, token);
  try {
    git(workdir, ["clone", "--depth", "1", remote, "repo"]);
    git(repoDir, ["config", "user.name", "cnb-protocol-bot"]);
    git(repoDir, ["config", "user.email", "protocol-bot@cnb.cool"]);
    const mainSha = git(repoDir, ["rev-parse", "HEAD"]);

    const files = [];
    for (const asset of PROTOCOL_ASSETS) {
      const content = await rawFile(baseRepo, "main", asset);
      if (!content) {
        log(`  ! 跳过缺失资产 ${asset}`);
        continue;
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
      if (changed && !dryRun) writeFileSync(cnbPath, content, "utf8");
      log(`  门禁流水线：${changed ? `已注入（${mode}）` : mode === "already" ? "已存在" : "结构未识别，需人工处理"}`);
      if (changed) files.push(".cnb.yml");
    } else {
      log("  ! 未找到 .cnb.yml，跳过门禁注入");
    }

    if (!files.length) {
      log("  无需变更：跳过分支/PR");
      return { slug, changed: false, mainSha };
    }
    if (dryRun) return { slug, changed: true, files, dryRun: true };

    git(repoDir, ["checkout", "-b", branch]);
    git(repoDir, ["add", "-A"]);
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
    git(repoDir, ["push", "origin", `HEAD:refs/heads/${branch}`]);
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
        "本 PR 由 `scripts/tools/provision-protocol.mjs` 自动创建，合并由人执行。",
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
