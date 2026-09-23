#!/usr/bin/env node
/**
 * 舰队扫描：找出组织下所有 WorkLoom 仓，并比对已纳管清单（sync/child-repos.json + 基座）。
 * 用法：
 *   node scripts/tools/fleet-scan.mjs                      # 人类可读报告
 *   node scripts/tools/fleet-scan.mjs --json                # 机器可读
 *   node scripts/tools/fleet-scan.mjs --check               # 有新仓则退出码 1（适合流水线门禁/定时任务）
 *   node scripts/tools/fleet-scan.mjs --provision            # 自动纳管新仓（创建 PR，不合并）
 *   node scripts/tools/fleet-scan.mjs --issue                # 有新仓时在基座开一张 src/auto 任务卡
 *   node scripts/tools/fleet-scan.mjs --self-test            # 规则自检
 *
 * 隔离副本（sync/child-repos.json#isolatedRepos）只登记、不纳管：扫描报告单列，--issue/--provision 一律跳过。
 */
import { classifyRepo, diffFleet, isolatedFleet, knownFleet } from "./fleet-rules.mjs";
import { createIssue, listRepos, rawFile, requireToken } from "./cnb-api.mjs";
import { provisionProtocol } from "./provision-protocol.mjs";

const DEFAULT_ORG = "workloom-ai";
const DEFAULT_BASE_REPO = "workloom-ai/workloom-im";

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function selfTest() {
  const cases = [
    [{ manifestText: JSON.stringify({ schemaVersion: "workloom.product/v1", productId: "x", role: "industry" }) }, true],
    [{ baseSyncText: JSON.stringify({ baseRepo: "workloom-ai/workloom-im" }) }, true],
    [{ bundleText: JSON.stringify({ schemaVersion: "workloom.bundle/v1" }) }, true],
    [{ manifestText: JSON.stringify({ schemaVersion: "other/v1" }) }, false],
    [{}, false],
  ];
  let failed = 0;
  for (const [input, expected] of cases) {
    const verdict = classifyRepo(input);
    if (verdict.isWorkloom !== expected) {
      failed += 1;
      console.error(`✗ self-test: ${JSON.stringify(input)} 期望 ${expected}，实际 ${verdict.isWorkloom}`);
    }
  }
  const registry = {
    children: [{ repo: "workloom-ai/hotel" }],
    isolatedRepos: [{ repo: "workloom-ai/workloom-growthtest", note: "隔离副本" }],
  };
  const known = knownFleet("workloom-ai/workloom-im", registry);
  const isolated = isolatedFleet(registry);
  const diff = diffFleet({
    repos: ["workloom-ai/workloom-im", "workloom-ai/hotel", "workloom-ai/new-one", "other/repo", "workloom-ai/workloom-growthtest"],
    classifications: {
      "workloom-ai/workloom-im": { isWorkloom: true },
      "workloom-ai/hotel": { isWorkloom: true },
      "workloom-ai/new-one": { isWorkloom: true },
      "other/repo": { isWorkloom: false },
      "workloom-ai/workloom-growthtest": { isWorkloom: true },
    },
    known,
    isolated,
  });
  if (diff.newWorkloom.length !== 1 || diff.newWorkloom[0].repo !== "workloom-ai/new-one") {
    failed += 1;
    console.error("✗ self-test: 新仓识别不正确", JSON.stringify(diff));
  }
  if (diff.isolated.length !== 1 || diff.isolated[0] !== "workloom-ai/workloom-growthtest") {
    failed += 1;
    console.error("✗ self-test: 隔离副本未从新仓通道剔除", JSON.stringify(diff));
  }
  if (failed) process.exit(1);
  console.log("✓ fleet-scan self-test 通过（分类 5 例 + 差分 2 例：新仓 / 隔离副本）");
}

async function scan({ org, baseRepo, log = () => {} }) {
  const repos = (await listRepos(org)).map((repo) => repo.path ?? `${org}/${repo.name}`);
  const classifications = {};
  for (const slug of repos) {
    const manifestText = await rawFile(slug, "main", "product.manifest.json");
    let baseSyncText = null;
    let bundleText = null;
    if (!manifestText) baseSyncText = await rawFile(slug, "main", ".workloom-base-sync.json");
    if (!manifestText && !baseSyncText) {
      const root = await rawFile(slug, "main", "package.json");
      if (root) {
        const name = JSON.parse(root).name ?? "";
        if (name.startsWith("workloom")) classifications[slug] = { isWorkloom: true, role: "unknown", reason: "package.json name" };
      }
    }
    classifications[slug] = classifications[slug] ?? classifyRepo({ manifestText, baseSyncText, bundleText });
    log(`  · ${slug} → ${classifications[slug].isWorkloom ? "WorkLoom" : "非 WorkLoom"}（${classifications[slug].reason}）`);
  }
  const childReposJson = await rawFile(baseRepo, "main", "sync/child-repos.json");
  const known = knownFleet(baseRepo, childReposJson);
  const isolated = isolatedFleet(childReposJson);
  const diff = diffFleet({ repos, classifications, known, isolated });
  return { repos, classifications, known: [...known], isolated: [...isolated], diff };
}

async function main() {
  if (process.argv.includes("--self-test")) return selfTest();
  requireToken();
  const org = arg("--org", DEFAULT_ORG);
  const baseRepo = arg("--base-repo", DEFAULT_BASE_REPO);
  const json = process.argv.includes("--json");
  const check = process.argv.includes("--check");
  const provision = process.argv.includes("--provision");
  const issue = process.argv.includes("--issue");

  const result = await scan({ org, baseRepo, log: json ? () => {} : console.log });
  const summary = {
    org,
    baseRepo,
    total: result.repos.length,
    known: result.diff.known,
    isolated: result.diff.isolated,
    newWorkloom: result.diff.newWorkloom,
    unrelated: result.diff.unrelated,
  };
  if (json) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(`\n组织 ${org}：共 ${summary.total} 个仓库`);
    console.log(`  已纳管 WorkLoom 仓：${summary.known.length}`);
    console.log(`  隔离副本仓（登记但不纳管、不下发）：${summary.isolated.length}${summary.isolated.length ? " → " + summary.isolated.join(", ") : ""}`);
    console.log(`  新发现 WorkLoom 仓：${summary.newWorkloom.length}${summary.newWorkloom.length ? " → " + summary.newWorkloom.map((item) => item.repo).join(", ") : ""}`);
    console.log(`  非 WorkLoom 仓：${summary.unrelated.length}`);
  }

  if (summary.isolated.length && (issue || provision)) {
    console.log(`  ⏸ 隔离副本按 sync/child-repos.json#isolatedRepos 跳过纳管：${summary.isolated.join(", ")}`);
  }

  if (issue && summary.newWorkloom.length) {
    const rows = summary.newWorkloom.map((item) => `- \`${item.repo}\`（识别依据：${item.reason}${item.productId ? `，productId=${item.productId}` : ""}）`).join("\n");
    const created = await createIssue(baseRepo, {
      title: `[T-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-9001] 舰队扫描发现 ${summary.newWorkloom.length} 个未纳管 WorkLoom 仓`,
      labels: ["src/auto", "t/doing", "protocol"],
      body: [
        "## 自动扫描结果",
        "",
        rows,
        "",
        "## 建议动作",
        "",
        "1. 确认这些仓是否应纳入舰队（是行业仓、试验仓还是历史副本）；",
        "2. 纳入：`node scripts/tools/provision-protocol.mjs --repo <org/name>` 会创建纳管 PR（标签 + 分支保护 + 协议资产 + 门禁 stage）；",
        "3. 不纳入：把仓归档或补 `product.manifest.json` 的非 WorkLoom 标识，避免下次扫描重复告警。",
      ].join("\n"),
    });
    console.log(`  已开扫描任务卡：#${created?.number}`);
  }

  if (provision && summary.newWorkloom.length) {
    for (const item of summary.newWorkloom) {
      await provisionProtocol(item.repo, { baseRepo, log: console.log });
    }
  }

  if (check && summary.newWorkloom.length) process.exit(1);
}

main().catch((error) => {
  console.error(`舰队扫描失败：${error?.message ?? error}`);
  process.exit(1);
});
