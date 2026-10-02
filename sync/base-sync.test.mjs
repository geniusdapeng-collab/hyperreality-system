import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  anchorNeedsSync,
  dependencyClosureViolations,
  extractManagedSection,
  gitAuthEnv,
  loadScope,
  mergeKeepChildExtra,
  mergeManagedSection,
  redact,
  registryCapabilityReadiness,
  repoUrl,
  withExtraExclude,
} from "./base-sync.mjs";
import { CODE_MERGE_SKIP_PATHS, matchesGlob } from "./fanout-rules.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = join(HERE, "base-sync.mjs");
const ADOPT = join(HERE, "adopt.sh");
const REAL_BASE = resolve(HERE, "..");
const SCANNER = join(REAL_BASE, "scripts/secret-scan.mjs");
const ADOPTION_CONTRACT = join(HERE, "adoption-contract.mjs");
const ADOPTION_TRANSACTION = join(HERE, "adoption-transaction.mjs");
const CLIENT_FOUNDATION = join(HERE, "client-foundation.mjs");
const INSTALL_ADOPTION_ASSETS = join(HERE, "install-adoption-assets.mjs");
const INSTALL_UI_GOVERNANCE = join(HERE, "install-ui-governance.mjs");
const SET_UI_VERSION = join(HERE, "set-ui-version.mjs");
const UI_LOCKFILE_INTEGRITY = join(HERE, "ui-lockfile-integrity.mjs");
const UI_CONSUMER_TEMPLATE = join(HERE, "ui-consumer-template.yml");
const NODE = process.execPath;
const BEGIN = "<!-- WORKLOOM-CONTEXT:BEGIN -->";
const END = "<!-- WORKLOOM-CONTEXT:END -->";
const MANAGED = { beginMarker: BEGIN, endMarker: END };

function run(command, args, cwd, options = {}) {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
}

function git(cwd, ...args) {
  return run("git", args, cwd);
}

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function initRepo(path) {
  mkdirSync(path, { recursive: true });
  git(path, "init", "-b", "main");
  git(path, "config", "user.name", "Test");
  git(path, "config", "user.email", "test@example.invalid");
}

function commitAll(path, message) {
  git(path, "add", "--all");
  git(path, "commit", "-m", message);
  return git(path, "rev-parse", "HEAD");
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workloom-sync-test-"));
  const base = join(root, "base");
  const child = join(root, "tiger");
  initRepo(base);
  write(join(base, "AGENTS.md"), `# Base only\n\n${BEGIN}\nshared-v2\n${END}\n\nbase-tail\n`);
  write(join(base, "WORKLOOM_PRODUCT_CONTEXT.md"), "context-v2\n");
  write(join(base, "AGENTS.repo.md"), "# workloom-im only\n\nbase-specific commands\n");
  write(join(base, ".github/workflows/base-sync-push.yml"), "name: parent-base-sync-push\n");
  write(join(base, "sync/heartbeat-template.yml"), "name: base-sync-heartbeat\n");
  copyFileSync(ENGINE, join(base, "sync/base-sync.mjs"));
  copyFileSync(ADOPT, join(base, "sync/adopt.sh"));
  copyFileSync(INSTALL_UI_GOVERNANCE, join(base, "sync/install-ui-governance.mjs"));
  // 引擎现在常驻导入 UI 完整性绑定模块（full 同步重算 lock 后重新注入稳定制品 SRI）。
  copyFileSync(UI_LOCKFILE_INTEGRITY, join(base, "sync/ui-lockfile-integrity.mjs"));
  mkdirSync(join(base, "scripts"), { recursive: true });
  copyFileSync(SCANNER, join(base, "scripts/secret-scan.mjs"));
  write(join(base, "scripts/verify-ui-consumer.mjs"), "// fixture UI consumer verifier\n");
  write(join(base, "scripts/ui-governance-rules.mjs"), "// fixture UI governance rules\n");
  write(join(base, "shared/core.txt"), "core-v2\n");
  write(join(base, "sync/base-scope.json"), JSON.stringify({
    version: 3,
    requiredRootAssets: {
      files: ["WORKLOOM_PRODUCT_CONTEXT.md"],
      copiedFiles: {
        ".github/workflows/base-sync-heartbeat.yml": { source: "sync/heartbeat-template.yml" },
      },
      managedSections: { "AGENTS.md": MANAGED },
    },
    preCommitSecretScanner: "scripts/secret-scan.mjs",
    uiGovernanceCapability: {
      installer: "sync/install-ui-governance.mjs",
      stateFile: ".workloom-ui-governance.json",
      dependency: "npm:typescript@5.9.3",
      yamlDependency: "npm:yaml@2.9.0",
      managedFiles: [
        "scripts/verify-ui-consumer.mjs",
        "scripts/ui-governance-rules.mjs",
      ],
      distribution: "stable-upgrade-pr-only",
    },
    adoptMigrations: {
      "AGENTS.repo.md": {
        strategy: "replace-if-identical-to-base",
        scaffold: "# 本仓专属开发规则\n\n> 请结合本仓实际内容填写。\n",
      },
      ".github/workflows/base-sync-push.yml": {
        strategy: "remove-if-identical-to-base",
      },
    },
    dependencyClosure: {
      relativeImports: "fail-closed",
      allowedExcludedTargets: [],
    },
    include: ["shared/**"],
    exclude: [
      "scripts/verify-ui-consumer.mjs",
      "scripts/ui-governance-rules.mjs",
    ],
    anchorMerge: {},
    appendOnlyDirs: [],
    pollutionGuard: { pathBlacklist: [], maxFilesPerSync: 20, maxFilesPerAdopt: 40 },
  }, null, 2));
  const baseSha = commitAll(base, "base");

  initRepo(child);
  mkdirSync(join(child, "governance"), { recursive: true });
  write(join(child, "AGENTS.md"), `# Tiger own rules\n\n${BEGIN}\nshared-v1\n${END}\n\nKEEP-TIGER\n`);
  write(join(child, "WORKLOOM_PRODUCT_CONTEXT.md"), "context-v1\n");
  write(join(child, "governance/shared/core.txt"), "core-v1\n");
  write(join(child, "governance/.workloom-base-sync.json"), JSON.stringify({
    baseRepo: "example/base",
    lastSyncedBaseSha: baseSha,
  }, null, 2));
  write(join(child, "notes.txt"), "clean\n");
  commitAll(child, "child");
  return { root, base, child, baseSha };
}

function clientSource(client) {
  const commonStyles = ["tokens.css", "content-safety.css", "components.css"]
    .map((style) => `import "@workloom/ui/${style}";`).join("\n");
  if (client === "web") return `${commonStyles}
import { OverlayManager, SideNavigation, TopContextBar, Overlay, Button, Input } from "@workloom/ui";
export function App() { return <div data-workloom-client="b-pc"><OverlayManager /><SideNavigation /><TopContextBar /><Overlay /><Button /><Input /></div>; }
`;
  const marker = client === "webb" ? "b-mobile" : "c-mobile";
  return `${commonStyles}
import { OverlayManager, AppShell, BottomTabs, TopContextBar, Drawer, Button, Input } from "@workloom/ui";
export function App() { return <div data-workloom-client="${marker}"><OverlayManager /><AppShell /><BottomTabs /><TopContextBar /><Drawer /><Button /><Input /></div>; }
`;
}

function newIndustryFixture() {
  const fx = fixture();
  const stable = "1.2.3";
  for (const [source, target] of [
    [ADOPTION_CONTRACT, "sync/adoption-contract.mjs"],
    [ADOPTION_TRANSACTION, "sync/adoption-transaction.mjs"],
    [CLIENT_FOUNDATION, "sync/client-foundation.mjs"],
    [INSTALL_ADOPTION_ASSETS, "sync/install-adoption-assets.mjs"],
    [INSTALL_UI_GOVERNANCE, "sync/install-ui-governance.mjs"],
    [SET_UI_VERSION, "sync/set-ui-version.mjs"],
    [UI_LOCKFILE_INTEGRITY, "sync/ui-lockfile-integrity.mjs"],
    [UI_CONSUMER_TEMPLATE, "sync/ui-consumer-template.yml"],
    [join(REAL_BASE, "scripts/verify-ui-consumer.mjs"), "scripts/verify-ui-consumer.mjs"],
    [join(REAL_BASE, "scripts/ui-governance-rules.mjs"), "scripts/ui-governance-rules.mjs"],
    [join(REAL_BASE, "scripts/verify-client-foundation-consumer.mjs"), "scripts/verify-client-foundation-consumer.mjs"],
    [join(REAL_BASE, "scripts/verify-production-client-boundary.mjs"), "scripts/verify-production-client-boundary.mjs"],
  ]) copyFileSync(source, join(fx.base, target));
  write(join(fx.base, "scripts/verify-product-content.mjs"), "console.log('product ok');\n");
  write(join(fx.base, "scripts/bundle-governance.mts"), "console.log('bundle ok');\n");
  write(join(fx.base, "scripts/runtime-deps-lock.mjs"), `#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
const command = process.argv[2];
const rootIndex = process.argv.indexOf("--root");
const root = resolve(rootIndex >= 0 ? process.argv[rootIndex + 1] : ".");
const directory = join(root, ".workloom-runtime-deps");
const files = ["package.json", "package-lock.json", "metadata.json"];
if (command === "refresh") {
  mkdirSync(directory, { recursive: true });
  for (const file of files) writeFileSync(join(directory, file), JSON.stringify({ product: basename(root), file }) + "\\n");
} else if (command === "verify") {
  for (const file of files) {
    if (!existsSync(join(directory, file))) throw new Error("missing " + file);
    const value = JSON.parse(readFileSync(join(directory, file), "utf8"));
    if (value.product !== basename(root)) throw new Error("foreign product lock");
  }
} else throw new Error("bad command");
`);
  write(join(fx.base, "packages/ui/package.json"), `${JSON.stringify({ name: "@workloom/ui", version: stable }, null, 2)}\n`);
  const baseCapabilities = {
    schemaVersion: 1,
    baseRepository: "workloom-ai/workloom-im",
    releasePolicy: "base-first-stable-only",
    ui: {
      package: "@workloom/ui",
      contractVersion: "2.0.0",
      candidateVersion: stable,
      latestStableVersion: stable,
      requiredClientPackages: ["apps/web/package.json", "apps/webb/package.json", "apps/webc/package.json"],
      allowedIndustryOverrides: ["--wl-brand-primary", "--wl-brand-on-primary", "--wl-brand-accent"],
      distribution: {
        type: "github-release-tarball",
        urlTemplate: "https://cnb.cool/workloom-ai/workloom-im/-/releases/download/ui-v{version}/workloom-ui-{version}.tgz",
        assetNameTemplate: "workloom-ui-{version}.tgz",
        integrityByVersion: {
          [stable]: `sha512-${Buffer.alloc(64, 3).toString("base64")}`,
        },
      },
    },
    clientFoundation: {
      schemaVersion: "workloom.client-foundation/v1",
      stateFile: ".workloom-client-foundation.json",
      candidateVersion: stable,
      latestStableVersion: stable,
      stableSourceRefPattern: "refs/tags/ui-v{version}",
      distribution: "stable-tag-upgrade-pr",
      maxManagedFiles: 100,
      managedRoots: ["apps/web", "apps/webb", "apps/webc"],
      requiredEntries: [
        "apps/web/src/main.tsx",
        "apps/webb/src/main.tsx",
        "apps/webc/src/main.tsx",
        "apps/webc/public/service-front.config.json",
      ],
      allowedIndustryExtensionPaths: [
        "apps/*/src/extensions/**",
        "apps/*/src/projections/**",
        "apps/*/src/config/industry/**",
        "apps/*/src/theme/industry/**",
        "apps/*/public/industry/**",
      ],
      ignoredRuntimePaths: ["apps/*/dist/**", "apps/*/node_modules/**", "apps/*/.vite/**", "apps/*/.DS_Store"],
      protectedRootFiles: ["product.manifest.json", "electron-builder.yml"],
    },
  };
  write(join(fx.base, "sync/base-capabilities.json"), `${JSON.stringify(baseCapabilities, null, 2)}\n`);
  for (const client of ["web", "webb", "webc"]) {
    const scripts = { typecheck: "tsc --noEmit", build: "vite build", test: "vitest run" };
    if (client === "web") scripts["test:consumer"] = "playwright test --config playwright.consumer.config.ts";
    write(join(fx.base, `apps/${client}/package.json`), `${JSON.stringify({
      name: `@example/${client}`,
      private: true,
      type: "module",
      scripts,
      dependencies: { "@workloom/ui": "workspace:*" },
    }, null, 2)}\n`);
    write(join(fx.base, `apps/${client}/src/main.tsx`), clientSource(client));
  }
  write(join(fx.base, "apps/webc/public/service-front.config.json"), "{}\n");
  const scope = readScope(fx.base);
  scope.include.push("scripts/**");
  scope.pollutionGuard.maxFilesPerSync = 2;
  scope.pollutionGuard.maxFilesPerAdopt = 40;
  writeScope(fx.base, scope);
  const stableSha = commitAll(fx.base, "stable adoption fixture");
  git(fx.base, "tag", `ui-v${stable}`);

  write(join(fx.child, "product.manifest.json"), `${JSON.stringify({
    productId: "example-industry",
    role: "industry",
    displayName: "示例行业经营系统",
    repository: "example/example-industry",
    defaultBundle: "example",
    demoWorkspaceSlug: "example-demo",
    demoMemberNo: "MEM-X01",
    release: { appId: "com.example.industry" },
    desktop: { portOffset: 101 },
    clients: {
      bPc: { enabled: true, entry: "apps/web" },
      bMobile: { enabled: true, entry: "apps/webb" },
      cMobile: { enabled: true, entry: "apps/webc" },
    },
  }, null, 2)}\n`);
  write(join(fx.child, "package.json"), `${JSON.stringify({
    name: "example-industry",
    private: true,
    packageManager: "pnpm@10.14.0",
    scripts: {
      test: "node --test",
      "product:verify": "node scripts/verify-product-content.mjs",
      "bundle:governance": "tsx scripts/bundle-governance.mts",
    },
    devDependencies: { tsx: "4.23.12" },
  }, null, 2)}\n`);
  write(join(fx.child, "pnpm-workspace.yaml"), 'packages:\n  - "apps/*"\n  - "packages/*"\nonlyBuiltDependencies:\n  - node-pty\n');
  write(join(fx.child, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  write(join(fx.child, "bundles/example/bundle.json"), "{}\n");
  commitAll(fx.child, "minimal industry contract");
  const bin = join(fx.root, "bin");
  const fakePnpm = join(bin, "pnpm");
  const parserTarget = realpathSync(join(REAL_BASE, "node_modules/typescript-governance"));
  const yamlTarget = realpathSync(join(REAL_BASE, "node_modules/yaml"));
  write(fakePnpm, `#!/usr/bin/env node
const { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
const selector = "@workloom/ui@${stable}";
const releaseUrl = packageJson.pnpm && packageJson.pnpm.overrides && packageJson.pnpm.overrides[selector];
if (!releaseUrl) throw new Error("missing canonical UI Release override");
if (process.argv.includes("--lockfile-only")) {
  const packageKey = "@workloom/ui@" + releaseUrl;
  writeFileSync(join(process.cwd(), "pnpm-lock.yaml"), [
    "lockfileVersion: '9.0'",
    "overrides:",
    "  '" + selector + "': " + releaseUrl,
    "importers:",
    "  apps/web:",
    "    dependencies:",
    "      '@workloom/ui':",
    "        specifier: " + releaseUrl,
    "        version: " + releaseUrl,
    "  apps/webb:",
    "    dependencies:",
    "      '@workloom/ui':",
    "        specifier: " + releaseUrl,
    "        version: " + releaseUrl,
    "  apps/webc:",
    "    dependencies:",
    "      '@workloom/ui':",
    "        specifier: " + releaseUrl,
    "        version: " + releaseUrl,
    "packages:",
    "  '" + packageKey + "':",
    "    resolution: {tarball: " + releaseUrl + "}",
    "    version: '${stable}'",
    "snapshots:",
    "  '" + packageKey + "': {}",
    "# typescript-governance",
    "# yaml-governance",
    "",
  ].join("\\n"));
}
if (process.argv.includes("--frozen-lockfile")) {
  mkdirSync(join(process.cwd(), "node_modules"), { recursive: true });
  const dependencies = [
    ["typescript-governance", ${JSON.stringify(parserTarget)}],
    ["yaml-governance", ${JSON.stringify(yamlTarget)}],
  ];
  for (const [name, source] of dependencies) {
    const target = join(process.cwd(), "node_modules", name);
    if (!existsSync(target)) symlinkSync(source, target, "dir");
  }
}
`);
  chmodSync(fakePnpm, 0o755);
  return { ...fx, stable, stableSha, bin };
}

function cli(args, cwd, env = process.env) {
  // 每次 CLI 调用使用独立临时根。Node 的 test runner 会并发执行多个测试文件；
  // 若直接枚举系统 tmpdir，同期测试创建/清理的同名前缀目录会让泄漏断言竞态。
  const tempRoot = mkdtempSync(join(tmpdir(), "workloom-sync-cli-test-"));
  try {
    const result = spawnSync(NODE, [ENGINE, ...args], {
      cwd,
      encoding: "utf8",
      env: { ...env, TMPDIR: tempRoot, TMP: tempRoot, TEMP: tempRoot },
    });
    result.syncTempEntries = readdirSync(tempRoot);
    return result;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function tempEntries(result, prefix) {
  return new Set(result.syncTempEntries.filter((name) => name.startsWith(prefix)));
}

function readScope(base) {
  return JSON.parse(readFileSync(join(base, "sync/base-scope.json"), "utf8"));
}

function writeScope(base, scope) {
  write(join(base, "sync/base-scope.json"), JSON.stringify(scope, null, 2) + "\n");
}

test("AGENTS 只替换唯一受控区块并保留子仓内容", () => {
  const base = `base-prefix\n${BEGIN}\nnew\n${END}\nbase-tail\n`;
  const child = `child-prefix\n${BEGIN}\nold\n${END}\nchild-tail\n`;
  const merged = mergeManagedSection(base, child, MANAGED);
  assert.equal(merged, `child-prefix\n${BEGIN}\nnew\n${END}\nchild-tail\n`);
  assert.equal(extractManagedSection(merged, MANAGED), `${BEGIN}\nnew\n${END}`);
  assert.throws(() => mergeManagedSection(base, `${BEGIN}\nbroken`, MANAGED), /必须且只能各出现一次/);
});

test("未知且无标记的子仓 AGENTS 原文保留并追加受控区块", () => {
  const base = `${BEGIN}\nrequired\n${END}\n`;
  assert.equal(mergeManagedSection(base, "child-only\n", MANAGED), `child-only\n\n${BEGIN}\nrequired\n${END}\n`);
});

test("已知 legacy AGENTS 精确命中 SHA-256 才整文件迁移；一字节变化则保留追加", () => {
  const base = `base-only\n${BEGIN}\nrequired\n${END}\nbase-tail\n`;
  const legacy = "legacy WorkLoom IM generic guide\n";
  const config = {
    ...MANAGED,
    missingFilePrefix: "# WorkLoom 仓库开发指引",
    missingFileSuffix: "## 本仓专属规则\n\nsee AGENTS.repo.md",
    replaceWholeFileSha256: [createHash("sha256").update(legacy).digest("hex")],
  };
  const replaced = mergeManagedSection(base, legacy, config);
  assert.doesNotMatch(replaced, /legacy WorkLoom IM|base-only|base-tail/);
  assert.match(replaced, /^# WorkLoom 仓库开发指引/);
  assert.match(replaced, /see AGENTS\.repo\.md/);

  const oneByteDifferent = `${legacy}x`;
  const preserved = mergeManagedSection(base, oneByteDifferent, config);
  assert.match(preserved, /legacy WorkLoom IM generic guide\nx/);
  assert.match(preserved, /WORKLOOM-CONTEXT:BEGIN/);
});

test("pull report 暴露 legacy 精确替换与未知无 marker 人工迁移标志", () => {
  const known = fixture();
  const unknown = fixture();
  try {
    const legacy = "legacy generic agent guide\n";
    const knownScope = readScope(known.base);
    knownScope.requiredRootAssets.managedSections["AGENTS.md"].replaceWholeFileSha256 = [
      createHash("sha256").update(legacy).digest("hex"),
    ];
    writeScope(known.base, knownScope);
    commitAll(known.base, "allow legacy fingerprint");
    write(join(known.child, "AGENTS.md"), legacy);
    commitAll(known.child, "legacy agents");
    const knownPull = cli([
      "pull", "--repo", "governance", "--base-dir", known.base,
      "--required-only", "--no-commit", "--json",
    ], known.child);
    assert.equal(knownPull.status, 0, knownPull.stderr || knownPull.stdout);
    const knownReport = JSON.parse(knownPull.stdout);
    assert.equal(knownReport.legacyAgentsReplaced, true);
    assert.equal(knownReport.manualMigrationRequired, false);
    assert.doesNotMatch(readFileSync(join(known.child, "AGENTS.md"), "utf8"), /legacy generic/);

    write(join(unknown.child, "AGENTS.md"), "child-specific guide\n");
    commitAll(unknown.child, "custom agents without markers");
    const unknownPull = cli([
      "pull", "--repo", "governance", "--base-dir", unknown.base,
      "--required-only", "--no-commit", "--json",
    ], unknown.child);
    assert.equal(unknownPull.status, 0, unknownPull.stderr || unknownPull.stdout);
    const unknownReport = JSON.parse(unknownPull.stdout);
    assert.equal(unknownReport.legacyAgentsReplaced, false);
    assert.equal(unknownReport.manualMigrationRequired, true);
    assert.match(unknownReport.warnings.join("\n"), /fingerprint 未知/);
    assert.match(readFileSync(join(unknown.child, "AGENTS.md"), "utf8"), /child-specific guide/);
  } finally {
    rmSync(known.root, { recursive: true, force: true });
    rmSync(unknown.root, { recursive: true, force: true });
  }
});

test("完全缺失的 AGENTS 使用通用根级 scaffold，不带基座专属尾部", () => {
  const base = `# Base only\n${BEGIN}\nrequired\n${END}\nbase-only-tail\n`;
  const config = {
    ...MANAGED,
    missingFilePrefix: "# WorkLoom 仓库开发指引\n\nshared intro",
    missingFileSuffix: "## 本仓专属规则\n\nwrite local rules here",
  };
  const merged = mergeManagedSection(base, "", config);
  assert.equal(merged, `# WorkLoom 仓库开发指引\n\nshared intro\n\n${BEGIN}\nrequired\n${END}\n\n## 本仓专属规则\n\nwrite local rules here\n`);
  assert.doesNotMatch(merged, /Base only|base-only-tail/);
});

test("认证不进入 URL，错误输出会脱敏", () => {
  const credentialSample = ["ghp", "A".repeat(36)].join("_");
  const url = repoUrl("https://github.com/", "owner/repo");
  assert.equal(url, "https://github.com/owner/repo.git");
  assert.ok(!url.includes(credentialSample));
  const env = gitAuthEnv(credentialSample);
  assert.ok(Object.values(env).some((value) => String(value).startsWith("AUTHORIZATION: basic ")));
  const unsafeUrl = ["https://user:", credentialSample, "@example.test"].join("");
  assert.ok(!redact(`failed ${credentialSample} ${unsafeUrl}`, credentialSample).includes(credentialSample));
  const embeddedCredential = ["https://user:", "plain-secret", "@github.com"].join("");
  assert.throws(() => repoUrl(embeddedCredential, "owner/repo"), /\[REDACTED\]@github\.com/);
});

test("@workloom/ui 由稳定制品升级维护，锚点合并保留子仓精确版本", () => {
  const basePackage = {
    dependencies: { "@workloom/ui": "workspace:*", react: "19.2.0" },
  };
  const childPackage = {
    dependencies: { "@workloom/ui": "1.2.3", react: "19.2.0", "industry-only": "1.0.0" },
  };
  const merged = mergeKeepChildExtra(basePackage, childPackage, ["dependencies"], ["@workloom/ui"]);
  assert.equal(merged.dependencies["@workloom/ui"], "1.2.3");
  assert.equal(merged.dependencies["industry-only"], "1.0.0");
  assert.equal(anchorNeedsSync(basePackage, childPackage, ["dependencies"], ["@workloom/ui"]), false);
  assert.equal(anchorNeedsSync(
    basePackage,
    { dependencies: { ...childPackage.dependencies, react: "18.0.0" } },
    ["dependencies"],
    ["@workloom/ui"],
  ), true);
});

test("缺少 B 端移动客户端时只报告第一阶段迁移，绝不伪装三端合规", () => {
  const root = mkdtempSync(join(tmpdir(), "workloom-registry-readiness-"));
  try {
    const capability = {
      package: "@workloom/ui",
      distribution: "stable-github-release-upgrade-pr",
      consumerGate: "scripts/verify-ui-consumer.mjs",
      consumers: ["apps/web", "apps/webb", "apps/webc"],
    };
    for (const client of ["apps/web", "apps/webc"]) {
      write(join(root, client, "package.json"), JSON.stringify({ dependencies: { "@workloom/ui": "1.2.3" } }));
    }
    const [missing] = registryCapabilityReadiness(root, { registryCapabilities: [capability] });
    assert.deepEqual(missing.missingConsumers, ["apps/webb"]);
    assert.equal(missing.phase, "phase-1-client-structure-required");
    assert.equal(missing.compliance, "unverified");

    write(join(root, "apps/webb/package.json"), JSON.stringify({ dependencies: { "@workloom/ui": "1.2.3" } }));
    const [complete] = registryCapabilityReadiness(root, { registryCapabilities: [capability] });
    assert.deepEqual(complete.missingConsumers, []);
    assert.equal(complete.phase, "consumer-gate-required");
    assert.equal(complete.compliance, "unverified");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("v18 scope 明确保护产品身份、仓级发布器、桌面发布封口器、同步认证、产品派生锁、依赖闭包与 Bundle 装配契约", () => {
  const scope = JSON.parse(readFileSync(join(REAL_BASE, "sync/base-scope.json"), "utf8"));
  const ci = readFileSync(join(REAL_BASE, ".github/workflows/ci.yml"), "utf8");
  assert.equal(scope.version, 18);
  // HP-01 收尾边界：单 active 迁移必须随公共分发下发，审计复现脚本只留基座仓
  assert.ok(scope.publicAppendOnlyFiles.includes("packages/db/migrations/0035_tenant_overlay_single_active.sql"));
  assert.ok(scope.newIndustryBootstrapFiles.includes("packages/db/migrations/0035_tenant_overlay_single_active.sql"));
  assert.ok(scope.exclude.includes("scripts/hp01-repro.mts"));
  assert.ok(scope.exclude.includes("scripts/hp02-repro.mts"));
  assert.ok(scope.exclude.includes("scripts/hp02-action-inventory.mts"));
  assert.equal(scope.desktopReleaseCapability.finalizer, "scripts/desktop-release-finalizer.mjs");
  assert.equal(scope.desktopReleaseCapability.consumerWorkflow, ".github/workflows/build-desktop.yml");
  assert.equal(scope.desktopReleaseCapability.publisherTemplate, "sync/downstream-desktop-publisher-job.yml");
  const releaseAssets = JSON.parse(readFileSync(join(REAL_BASE, "scripts/release-assets.json"), "utf8"));
  const runtimeMetadata = JSON.parse(readFileSync(join(REAL_BASE, ".workloom-runtime-deps/metadata.json"), "utf8"));
  const desktopProductionWorkflow = readFileSync(
    join(REAL_BASE, ".github/workflows/desktop-production-release.yml"),
    "utf8",
  );
  const releaseNodeVersions = [...new Set(Object.keys(releaseAssets.assets)
    .map((name) => /^node-v([0-9]+\.[0-9]+\.[0-9]+)-(?:darwin|win)/u.exec(name)?.[1])
    .filter(Boolean))];
  assert.deepEqual(releaseNodeVersions, [scope.desktopReleaseCapability.buildRuntime.nodeVersion]);
  assert.equal(runtimeMetadata.npmVersion, scope.desktopReleaseCapability.buildRuntime.npmVersion);
  assert.equal(scope.desktopReleaseCapability.buildRuntime.setupNodePolicy, "exact-version-only");
  const setupNodeVersions = [...desktopProductionWorkflow.matchAll(/node-version:\s*([^, }\n]+)/gu)]
    .map((match) => match[1]);
  assert.ok(setupNodeVersions.length >= 2);
  assert.deepEqual(
    [...new Set(setupNodeVersions)],
    [scope.desktopReleaseCapability.buildRuntime.nodeVersion],
  );
  assert.equal(
    scope.desktopReleaseCapability.distribution,
    "base-sync-script-plus-reviewed-workflow-upgrade-pr",
  );
  assert.deepEqual(scope.desktopReleaseCapability.evidenceAssets, [
    "WorkLoom-SHA512SUMS.txt",
    "WorkLoom-release-manifest.json",
  ]);
  assert.ok(scope.include.includes("scripts/**"));
  assert.ok(!scope.exclude.includes("scripts/desktop-release-finalizer.mjs"));
  assert.ok(existsSync(join(REAL_BASE, scope.desktopReleaseCapability.finalizer)));
  assert.ok(existsSync(join(REAL_BASE, scope.desktopReleaseCapability.publisherTemplate)));
  assert.ok(scope.protectedChildAssets.files.includes("electron-builder.yml"));
  assert.ok(scope.protectedChildAssets.files.includes("product.manifest.json"));
  assert.ok(scope.exclude.includes("electron-builder.yml"));
  assert.ok(!scope.include.includes("electron-builder.yml"));
  assert.ok(scope.include.includes("packages/industry-contract/**"));
  assert.ok(scope.include.includes("packages/base/**"));
  assert.ok(!scope.exclude.includes("packages/base/tenancy/auth.ts"));
  assert.ok(!scope.exclude.includes("packages/base/bundles/assembly.ts"));
  assert.ok(!scope.exclude.includes("packages/base/bundles/segment.ts"));
  assert.ok(!scope.exclude.includes("packages/base/bundles/projection-composition.test.ts"));
  assert.ok(scope.exclude.includes("packages/base/bundles/bundles.test.ts"));
  for (const industryCoupled of [
    "packages/base/bundles/eval-questions.test.ts",
    "packages/base/fence-engine/fence-engine.test.ts",
    "packages/base/overlay/overlay.test.ts",
    "apps/server/src/service/dialog.test.ts",
    "apps/server/src/service/inspection-adapter.ts",
    "apps/server/src/service/inspection-adapter.test.ts",
    "scripts/bundle-governance.test.ts",
    "scripts/hotel-seed-preflight.ts",
    "scripts/hotel-seed-preflight.test.ts",
    "scripts/suite.ts",
    "scripts/action-pins.json",
    "scripts/action-trust-policy.test.mjs",
    "scripts/desktop-release-policy.test.mjs",
    "scripts/desktop-release-state.mjs",
    "scripts/desktop-release-state.test.mjs",
    "scripts/desktop-workflow-path.test.mjs",
    "scripts/release-publisher-policy.test.mjs",
  ]) assert.ok(scope.exclude.includes(industryCoupled), `${industryCoupled} 必须保留在基座仓`);
  assert.ok(!scope.exclude.includes("scripts/desktop-workflow-path.mjs"), "仓级 workflow 兼容解析器必须随 base-sync 下发");
  for (const packer of ["scripts/pack-electron-payload.sh", "scripts/pack-windows.sh", "scripts/pack-macos.sh"]) {
    assert.ok(!scope.exclude.includes(packer), `${packer} 必须作为同一公共装配能力下发`);
  }
  assert.ok(!scope.exclude.includes("scripts/release-assets.test.mjs"), "共享发行来源门禁必须随 base-sync 下发");
  assert.ok(!scope.exclude.includes("scripts/verify-product-content.mjs"), "共享产品门禁必须随 base-sync 下发");
  assert.ok(!scope.exclude.includes("scripts/generate-client-projections.mts"), "客户端投影生成器必须随 base-sync 下发");
  const projectionGenerator = readFileSync(join(REAL_BASE, "scripts/generate-client-projections.mts"), "utf8");
  assert.ok(projectionGenerator.includes(".workloom-ui.json"));
  assert.ok(projectionGenerator.includes("node_modules/@workloom/ui"));
  assert.ok(!projectionGenerator.includes("../packages/ui/src/"));
  const evalSourcePgTest = readFileSync(join(REAL_BASE, "apps/server/src/service/eval-source.pg.test.ts"), "utf8");
  assert.ok(evalSourcePgTest.includes("ExplicitEvalQuestionFixture"));
  assert.ok(!evalSourcePgTest.includes('loadVerifiedBundleEvalQuestions("ai-pm")'));
  assert.ok(!evalSourcePgTest.includes("'ai-pm','ai-pm'"));
  assert.deepEqual(scope.publicAppendOnlyFiles, [
    "packages/db/migrations/0026_tenant_overlay.sql",
    "packages/db/migrations/0028_onboarding_truth_gate.sql",
    "packages/db/migrations/0029_onboarding_continuity.sql",
    "packages/db/migrations/0030_single_active_bundle_install.sql",
    "packages/db/migrations/0031_accounts_overlay_least_privilege.sql",
    "packages/db/migrations/0032_remove_cross_industry_hotel_bootstrap.sql",
    "packages/db/migrations/0033_neutral_workspace_industry_default.sql",
    "packages/db/migrations/0034_api_key_rotation.sql",
    "packages/db/migrations/0035_tenant_overlay_single_active.sql",
  ]);
  for (const publicCaptain of [
    "packages/base/captain/charter.ts",
    "packages/base/captain/decision.ts",
    "packages/base/captain/loop.ts",
    "packages/base/captain/board.ts",
    "packages/base/captain/captain.test.ts",
  ]) assert.ok(!scope.exclude.includes(publicCaptain), `${publicCaptain} 不得形成断链`);
  assert.equal(scope.dependencyClosure.relativeImports, "fail-closed");
  assert.ok(scope.dependencyClosure.allowedExcludedTargets.length > 0);
  assert.ok(Object.values(scope.acceptedBaseSecretScanFindings).every((entry) => (
    /^[0-9a-f]{64}$/.test(entry.sha256) && entry.findings.length > 0 && entry.reason.length > 0
  )));
  assert.deepEqual(scope.acceptedBaseSecretScanFindings["scripts/release-gate.ts"].findings, [
    // 2026-09-29：release-gate 顶部新增 QUEST 超时旋钮（GATE_QUEST_TIMEOUT_MS）注释块，
    // 连接串随之下移 7 行——登记随之更新（摘要同步在 sync/base-scope.json）。
    { rule: "credential-in-url", line: 28 },
    { rule: "credential-in-url", line: 29 },
  ]);
  assert.ok(scope.exclude.includes("apps/server/src/industry/**"));
  assert.ok(scope.exclude.includes("apps/server/src/service/adapters/**"));
  assert.equal(scope.registryCapabilities[0].distribution, "stable-github-release-upgrade-pr");
  assert.equal(scope.clientFoundationCapability.distribution, "stable-tag-upgrade-pr");
  assert.equal(scope.clientFoundationCapability.conflictPolicy, "previous-source-sha256-fail-close");
  assert.equal(scope.uiGovernanceCapability.distribution, "stable-upgrade-pr-only");
  assert.equal(scope.uiGovernanceCapability.installer, "sync/install-ui-governance.mjs");
  assert.equal(scope.uiGovernanceCapability.stateFile, ".workloom-ui-governance.json");
  assert.equal(scope.uiGovernanceCapability.dependency, "npm:typescript@5.9.3");
  assert.equal(scope.uiGovernanceCapability.yamlDependency, "npm:yaml@2.9.0");
  assert.deepEqual(scope.perProductDerivedAssets, [{
    directory: ".workloom-runtime-deps",
    files: ["package.json", "package-lock.json", "metadata.json"],
    generator: "scripts/runtime-deps-lock.mjs",
    refreshArgs: ["refresh"],
    verifyArgs: ["verify"],
    strategy: "preserve-and-regenerate-after-product-lockfile",
    comment: scope.perProductDerivedAssets[0].comment,
  }]);
  assert.ok(scope.include.includes("scripts/**"), "产品派生锁生成器必须随公共基座下发");
  assert.ok(!scope.include.includes(".workloom-runtime-deps/**"), "基座派生锁不得复制到产品仓");
  assert.deepEqual(scope.uiGovernanceCapability.managedFiles, [
    "scripts/verify-ui-consumer.mjs",
    "scripts/ui-governance-rules.mjs",
  ]);
  for (const governanceFile of scope.uiGovernanceCapability.managedFiles) {
    assert.ok(scope.exclude.includes(governanceFile), `${governanceFile} 必须排除普通 base-sync`);
  }
  for (const baseOnlyGovernanceFile of [
    "scripts/verify-ui-consumer.test.mjs",
    "scripts/ui-governance-rules.test.mjs",
    "scripts/verify-ui-governance.mjs",
  ]) assert.ok(scope.exclude.includes(baseOnlyGovernanceFile), `${baseOnlyGovernanceFile} 必须保留在基座仓`);
  assert.ok(scope.exclude.includes("apps/web/**"));
  assert.ok(scope.exclude.includes("apps/webb/**"));
  assert.ok(scope.exclude.includes("apps/webc/**"));
  assert.ok(!scope.include.includes("apps/web/src/lib/**"));
  assert.match(ci, /fetch-depth:\s*0/);
  assert.match(ci, /git merge-base "\$EVENT_BASE_SHA" "\$HEAD_SHA"/);
  assert.match(ci, /secret-scan\.mjs --range "\$BASE_SHA" "\$HEAD_SHA" --acceptance-manifest sync\/base-scope\.json/);
});

test("v18 scope 登记排雷、真实证据和预算受控资产，并保持显式审查边界", () => {
  const scope = JSON.parse(readFileSync(join(REAL_BASE, "sync/base-scope.json"), "utf8"));
  assert.equal(scope.version, 18);
  const required = scope.requiredRootAssets.files;
  for (const path of [
    "docs/MINE-CLEAR-DELIVERY-SPEC.md",
    "docs/mine-clear/ledger.schema.json",
    "docs/mine-clear/evidence.schema.json",
    "docs/mine-clear/report-template.md",
    "docs/mine-clear/prompt-pack.md",
    "scripts/delivery/README.md",
    "scripts/delivery/mine-clear.mjs",
    "scripts/delivery/mine-clear.test.mjs",
    "scripts/delivery/evidence.mjs",
    "scripts/delivery/node-test-reporter.mjs",
    "scripts/delivery/evidence-controls.test.mjs",
    "scripts/acceptance/lib/evidence.mjs",
    "scripts/acceptance/lib/live/budget.mjs",
    "scripts/acceptance/lib/live/usage.mjs",
    "scripts/acceptance/lib/live/audit.plugin.mjs",
    "scripts/acceptance/lib/live/media.mjs",
    "scripts/acceptance/lib/live/verification.mjs",
    "scripts/acceptance/lib/live/checks.mjs",
    "scripts/ui-release-registration.mjs",
  ]) {
    assert.ok(required.includes(path), `${path} 必须作为根级受控资产随 base-sync 下发十仓`);
    assert.ok(existsSync(join(REAL_BASE, path)), `${path} 必须在基座仓真实存在`);
    assert.ok(
      CODE_MERGE_SKIP_PATHS.some((pattern) => matchesGlob(pattern, path)),
      `${path} 必须留在显式审查车道（不得由无人值守车道合并）`,
    );
  }
});

test("权威子仓清单的附加排除不会切断公共基座依赖闭包", () => {
  const baseScope = loadScope(REAL_BASE);
  const inventory = JSON.parse(readFileSync(join(REAL_BASE, "sync/child-repos.json"), "utf8"));
  assert.ok(inventory.children.length > 0);
  for (const child of inventory.children) {
    const scope = withExtraExclude(baseScope, child.extraExclude ?? []);
    assert.deepEqual(
      dependencyClosureViolations(REAL_BASE, scope),
      [],
      `${child.repo} 的 extraExclude 会切断公共基座相对依赖`,
    );
  }
});

test("UI 治理受管文件一旦重新进入普通 base-sync，scope 契约立即 fail closed", () => {
  const fx = fixture();
  try {
    const scope = readScope(fx.base);
    scope.exclude = scope.exclude.filter((path) => path !== "scripts/verify-ui-consumer.mjs");
    writeScope(fx.base, scope);
    commitAll(fx.base, "break UI governance distribution boundary");

    const result = cli(["detect", "--repo", "governance", "--base-dir", fx.base], fx.child);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /UI governance managed file 必须排除普通 base-sync/);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("公共追加资产只补齐缺失文件，同路径异内容冲突失败关闭", () => {
  const missing = fixture();
  try {
    const scope = readScope(missing.base);
    scope.publicAppendOnlyFiles = ["shared/public-migration.sql"];
    scope.exclude.push("shared/public-migration.sql");
    writeScope(missing.base, scope);
    write(join(missing.base, "shared/public-migration.sql"), "-- public migration\n");
    commitAll(missing.base, "add public append-only migration");

    const installed = cli([
      "pull", "--repo", "governance", "--base-dir", missing.base, "--no-commit",
    ], missing.child);
    assert.equal(installed.status, 0, installed.stderr);
    assert.equal(
      readFileSync(join(missing.child, "governance/shared/public-migration.sql"), "utf8"),
      "-- public migration\n",
    );
  } finally {
    rmSync(missing.root, { recursive: true, force: true });
  }

  const conflict = fixture();
  try {
    const scope = readScope(conflict.base);
    scope.publicAppendOnlyFiles = ["shared/public-migration.sql"];
    scope.exclude.push("shared/public-migration.sql");
    writeScope(conflict.base, scope);
    write(join(conflict.base, "shared/public-migration.sql"), "-- base public migration\n");
    commitAll(conflict.base, "add public append-only migration");
    write(join(conflict.child, "governance/shared/public-migration.sql"), "-- child collision\n");
    commitAll(conflict.child, "add conflicting child migration");

    const rejected = cli([
      "pull", "--repo", "governance", "--base-dir", conflict.base, "--no-commit",
    ], conflict.child);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /公共追加资产与子仓同路径内容冲突/);
    assert.equal(
      readFileSync(join(conflict.child, "governance/shared/public-migration.sql"), "utf8"),
      "-- child collision\n",
    );
  } finally {
    rmSync(conflict.root, { recursive: true, force: true });
  }
});

test("完整同步对相对依赖断链和缺失的子仓保留实现均 fail closed", () => {
  const fx = fixture();
  try {
    const scope = readScope(fx.base);
    scope.include.push("public/**");
    scope.exclude.push("public/industry-adapter.ts");
    writeScope(fx.base, scope);
    write(join(fx.base, "public/runtime.ts"), 'export { industryValue } from "./industry-adapter.js";\n');
    write(join(fx.base, "public/industry-adapter.ts"), "export const industryValue = 'child-owned';\n");
    commitAll(fx.base, "add undeclared dependency seam");

    const undeclared = cli(["detect", "--repo", "governance", "--base-dir", fx.base], fx.child);
    assert.equal(undeclared.status, 1);
    assert.match(undeclared.stderr, /基座同步依赖闭包失败.*public\/runtime\.ts.*public\/industry-adapter\.ts/s);

    const declared = readScope(fx.base);
    declared.dependencyClosure.allowedExcludedTargets.push({
      importer: "public/runtime.ts",
      target: "public/industry-adapter.ts",
      reason: "测试子仓显式保留行业适配器",
    });
    writeScope(fx.base, declared);
    commitAll(fx.base, "declare dependency seam");
    const missingChildSeam = cli(["detect", "--repo", "governance", "--base-dir", fx.base], fx.child);
    assert.equal(missingChildSeam.status, 1);
    assert.match(missingChildSeam.stderr, /子仓缺少 1 个明确保留的依赖实现.*public\/industry-adapter\.ts/s);

    write(join(fx.child, "governance/public/industry-adapter.ts"), "export const industryValue = 'tiger';\n");
    commitAll(fx.child, "provide child dependency seam");
    const ready = cli(["detect", "--repo", "governance", "--base-dir", fx.base], fx.child);
    assert.equal(ready.status, 2, ready.stderr || ready.stdout);
    assert.doesNotMatch(ready.stderr, /依赖闭包失败|明确保留的依赖实现/);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("相同 base SHA 仍逐项验真；Tiger required assets 写根目录且 state 同提交迁移", () => {
  const fx = fixture();
  try {
    const detect = cli(["detect", "--repo", "governance", "--base-dir", fx.base, "--json"], fx.child);
    assert.equal(detect.status, 2, detect.stderr || detect.stdout);
    const report = JSON.parse(detect.stdout);
    assert.equal(report.localSha, fx.baseSha);
    assert.equal(report.contentDrift, true);
    assert.equal(report.stateDrift, true);
    assert.deepEqual(report.files.sort(), ["shared/core.txt", "root:AGENTS.md#managed-section", "root:WORKLOOM_PRODUCT_CONTEXT.md", "root:.github/workflows/base-sync-heartbeat.yml", "root:.workloom-base-sync.json"].sort());

    const pull = cli(["pull", "--repo", "governance", "--base-dir", fx.base, "--json"], fx.child);
    assert.equal(pull.status, 0, pull.stderr || pull.stdout);
    assert.equal(readFileSync(join(fx.child, "WORKLOOM_PRODUCT_CONTEXT.md"), "utf8"), "context-v2\n");
    const agents = readFileSync(join(fx.child, "AGENTS.md"), "utf8");
    assert.match(agents, /# Tiger own rules/);
    assert.match(agents, /shared-v2/);
    assert.match(agents, /KEEP-TIGER/);
    assert.doesNotMatch(agents, /Base only|base-tail/);
    assert.equal(readFileSync(join(fx.child, "governance/shared/core.txt"), "utf8"), "core-v2\n");
    const state = JSON.parse(readFileSync(join(fx.child, ".workloom-base-sync.json"), "utf8"));
    assert.equal(state.lastSyncedBaseSha, fx.baseSha);
    assert.equal(state.lastRequiredAssetsBaseSha, fx.baseSha);
    assert.equal(Object.keys(state.requiredRootAssetsSha256).length, 3);
    assert.equal(state.pathPrefix, "governance");
    const committed = git(fx.child, "show", "--pretty=format:", "--name-status", "HEAD");
    assert.match(committed, /\.workloom-base-sync\.json/);
    assert.match(committed, /WORKLOOM_PRODUCT_CONTEXT\.md/);
    assert.match(committed, /AGENTS\.md/);
    assert.match(committed, /\.github\/workflows\/base-sync-heartbeat\.yml/);
    assert.match(committed, /governance\/shared\/core\.txt/);
    assert.match(committed, /governance\/\.workloom-base-sync\.json/);
    assert.equal(git(fx.child, "status", "--porcelain"), "");

    const after = cli(["detect", "--repo", "governance", "--base-dir", fx.base, "--json"], fx.child);
    assert.equal(after.status, 0, after.stderr || after.stdout);
    assert.equal(JSON.parse(after.stdout).behind, false);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("内容一致但 state 缺失时 detect 退出 2，pull 创建 state-only 提交", () => {
  const fx = fixture();
  try {
    write(join(fx.child, "AGENTS.md"), `# Tiger own rules\n\n${BEGIN}\nshared-v2\n${END}\n\nKEEP-TIGER\n`);
    write(join(fx.child, "WORKLOOM_PRODUCT_CONTEXT.md"), "context-v2\n");
    write(join(fx.child, ".github/workflows/base-sync-heartbeat.yml"), "name: base-sync-heartbeat\n");
    rmSync(join(fx.child, "governance/.workloom-base-sync.json"));
    commitAll(fx.child, "content aligned without state");

    const detect = cli(["detect", "--repo", "governance", "--base-dir", fx.base, "--required-only", "--json"], fx.child);
    assert.equal(detect.status, 2, detect.stderr || detect.stdout);
    const report = JSON.parse(detect.stdout);
    assert.equal(report.contentDrift, false);
    assert.equal(report.stateDrift, true);
    assert.deepEqual(report.files, ["root:.workloom-base-sync.json"]);

    const before = git(fx.child, "rev-parse", "HEAD");
    const pull = cli(["pull", "--repo", "governance", "--base-dir", fx.base, "--required-only", "--json"], fx.child);
    assert.equal(pull.status, 0, pull.stderr || pull.stdout);
    assert.notEqual(git(fx.child, "rev-parse", "HEAD"), before);
    assert.equal(git(fx.child, "show", "--pretty=format:", "--name-only", "HEAD"), ".workloom-base-sync.json");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("--required-only --no-commit 允许脏树但只写根资产/state且不暂存", () => {
  const fx = fixture();
  try {
    write(join(fx.child, "notes.txt"), "user-change\n");
    const beforeHead = git(fx.child, "rev-parse", "HEAD");
    const result = cli(["pull", "--repo", "governance", "--base-dir", fx.base, "--required-only", "--no-commit", "--json"], fx.child);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(git(fx.child, "rev-parse", "HEAD"), beforeHead);
    assert.equal(git(fx.child, "diff", "--cached", "--name-only"), "");
    assert.equal(readFileSync(join(fx.child, "WORKLOOM_PRODUCT_CONTEXT.md"), "utf8"), "context-v2\n");
    assert.equal(readFileSync(join(fx.child, ".github/workflows/base-sync-heartbeat.yml"), "utf8"), "name: base-sync-heartbeat\n");
    assert.equal(readFileSync(join(fx.child, "governance/shared/core.txt"), "utf8"), "core-v1\n");
    assert.equal(JSON.parse(readFileSync(join(fx.child, ".workloom-base-sync.json"), "utf8")).lastSyncMode, "required-only");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("默认自动提交拒绝既有脏工作树", () => {
  const fx = fixture();
  try {
    write(join(fx.child, "notes.txt"), "user-change\n");
    const result = cli(["pull", "--repo", "governance", "--base-dir", fx.base, "--required-only"], fx.child);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /拒绝自动提交.*未提交改动/);
    assert.equal(readFileSync(join(fx.child, "WORKLOOM_PRODUCT_CONTEXT.md"), "utf8"), "context-v1\n");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("本地 --base-dir 只允许受控来源与 HEAD 一致，无关脏文件不阻塞", () => {
  const fx = fixture();
  try {
    write(join(fx.base, "WORKLOOM_PRODUCT_CONTEXT.md"), "uncommitted-context\n");
    const blocked = cli(["detect", "--repo", "governance", "--base-dir", fx.base, "--required-only"], fx.child);
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /基座受控源文件与 HEAD 不一致/);
    assert.equal(readFileSync(join(fx.child, "WORKLOOM_PRODUCT_CONTEXT.md"), "utf8"), "context-v1\n");

    git(fx.base, "restore", "--", "WORKLOOM_PRODUCT_CONTEXT.md");
    write(join(fx.base, "unrelated-local-note.txt"), "not read by sync\n");
    const allowed = cli(["detect", "--repo", "governance", "--base-dir", fx.base, "--required-only"], fx.child);
    assert.equal(allowed.status, 2, allowed.stderr || allowed.stdout);
    assert.doesNotMatch(allowed.stderr, /受控源文件与 HEAD 不一致/);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("源 required asset 为 dangling symlink 时 fail closed", () => {
  const fx = fixture();
  try {
    rmSync(join(fx.base, "WORKLOOM_PRODUCT_CONTEXT.md"));
    symlinkSync(join(fx.root, "never-created-source"), join(fx.base, "WORKLOOM_PRODUCT_CONTEXT.md"));
    commitAll(fx.base, "malicious source symlink");
    const result = cli(["pull", "--repo", "governance", "--base-dir", fx.base, "--required-only"], fx.child);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /不允许 symlink/);
    assert.equal(readFileSync(join(fx.child, "WORKLOOM_PRODUCT_CONTEXT.md"), "utf8"), "context-v1\n");
    assert.equal(git(fx.child, "status", "--porcelain"), "");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("目标 dangling symlink 与 pathPrefix symlink escape 均被拒绝", () => {
  const fx = fixture();
  try {
    const outsideTarget = join(fx.root, "never-created-target");
    rmSync(join(fx.child, "WORKLOOM_PRODUCT_CONTEXT.md"));
    symlinkSync(outsideTarget, join(fx.child, "WORKLOOM_PRODUCT_CONTEXT.md"));
    commitAll(fx.child, "malicious target symlink");
    const targetResult = cli(["pull", "--repo", "governance", "--base-dir", fx.base, "--required-only"], fx.child);
    assert.equal(targetResult.status, 1);
    assert.match(targetResult.stderr, /不允许 symlink/);
    assert.equal(existsSync(outsideTarget), false);

    git(fx.child, "rm", "WORKLOOM_PRODUCT_CONTEXT.md");
    write(join(fx.child, "WORKLOOM_PRODUCT_CONTEXT.md"), "context-v1\n");
    rmSync(join(fx.child, "governance"), { recursive: true, force: true });
    const outsideRepo = join(fx.root, "outside-repo");
    initRepo(outsideRepo);
    write(join(outsideRepo, "outside.txt"), "untouched\n");
    commitAll(outsideRepo, "outside");
    symlinkSync(outsideRepo, join(fx.child, "governance"));
    commitAll(fx.child, "path prefix symlink escape");
    const outsideHead = git(outsideRepo, "rev-parse", "HEAD");
    const prefixResult = cli(["pull", "--repo", "governance", "--base-dir", fx.base, "--required-only"], fx.child);
    assert.equal(prefixResult.status, 1);
    assert.match(prefixResult.stderr, /--repo 目标路径\s*不允许 symlink/);
    assert.equal(git(outsideRepo, "rev-parse", "HEAD"), outsideHead);
    assert.equal(git(outsideRepo, "status", "--porcelain"), "");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("lockfile 刷新故障 fail closed：显式 ignore-scripts，且不写 state/不提交", () => {
  const fx = fixture();
  try {
    const scope = readScope(fx.base);
    scope.include.push("package.json");
    scope.anchorMerge["package.json"] = { strategy: "json-merge-keep-child-extra", mergeKeys: ["dependencies"] };
    writeScope(fx.base, scope);
    write(join(fx.base, "package.json"), JSON.stringify({ name: "base", dependencies: { base: "1.0.0" } }, null, 2) + "\n");
    commitAll(fx.base, "add anchor package");
    write(join(fx.child, "governance/package.json"), JSON.stringify({ name: "child", dependencies: { child: "1.0.0" } }, null, 2) + "\n");
    commitAll(fx.child, "add child package");
    const before = git(fx.child, "rev-parse", "HEAD");
    const result = cli(["pull", "--repo", "governance", "--base-dir", fx.base], fx.child, { ...process.env, PATH: "/usr/bin:/bin" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /lockfile 刷新失败.*未写 state、未提交/);
    assert.equal(git(fx.child, "rev-parse", "HEAD"), before);
    assert.equal(existsSync(join(fx.child, ".workloom-base-sync.json")), false);
    assert.equal(existsSync(join(fx.child, "governance/.workloom-base-sync.json")), true);
    assert.equal(git(fx.child, "diff", "--cached", "--name-only"), "");
    assert.equal(readFileSync(join(fx.child, "WORKLOOM_PRODUCT_CONTEXT.md"), "utf8"), "context-v1\n");
    assert.equal(git(fx.child, "status", "--porcelain"), "");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("普通 copy 的 package.json 变更也先刷新子仓 lockfile，再允许提交", () => {
  const fx = fixture();
  try {
    const packagePath = "packages/runtime/package.json";
    const scope = readScope(fx.base);
    scope.include.push(packagePath);
    writeScope(fx.base, scope);
    write(join(fx.base, packagePath), `${JSON.stringify({
      name: "@workloom/runtime",
      dependencies: { zod: "^4.4.3" },
    }, null, 2)}\n`);
    commitAll(fx.base, "update copied dependency source");

    write(join(fx.child, `governance/${packagePath}`), `${JSON.stringify({
      name: "@workloom/runtime",
      dependencies: { zod: "^4.0.0" },
    }, null, 2)}\n`);
    write(join(fx.child, "governance/pnpm-lock.yaml"), "old-lock\n");
    commitAll(fx.child, "old dependency source and lock");

    const bin = join(fx.root, "copy-package-bin");
    const fakePnpm = join(bin, "pnpm");
    write(fakePnpm, `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
if (!process.argv.includes("--lockfile-only") || !process.argv.includes("--ignore-scripts")) process.exit(41);
writeFileSync(join(process.cwd(), "pnpm-lock.yaml"), "refreshed-for-zod-4.4.3\\n");
`);
    chmodSync(fakePnpm, 0o755);

    const result = cli(["pull", "--repo", "governance", "--base-dir", fx.base, "--json"], fx.child, {
      ...process.env,
      PATH: `${bin}:${dirname(NODE)}:${process.env.PATH}`,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.lockfileRefreshed, true);
    assert.match(readFileSync(join(fx.child, `governance/${packagePath}`), "utf8"), /\^4\.4\.3/u);
    assert.equal(readFileSync(join(fx.child, "governance/pnpm-lock.yaml"), "utf8"), "refreshed-for-zod-4.4.3\n");
    const committed = git(fx.child, "show", "--pretty=format:", "--name-only", "HEAD");
    assert.match(committed, /governance\/packages\/runtime\/package\.json/u);
    assert.match(committed, /governance\/pnpm-lock\.yaml/u);
    assert.equal(git(fx.child, "status", "--porcelain"), "");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("产品派生 runtime lock 不从基座复制，而是在子仓事务内刷新、验真并提交", () => {
  const fx = fixture();
  try {
    const generator = `#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
const command = process.argv[2];
const rootIndex = process.argv.indexOf("--root");
const root = resolve(rootIndex >= 0 ? process.argv[rootIndex + 1] : ".");
const directory = join(root, ".workloom-runtime-deps");
const files = ["package.json", "package-lock.json", "metadata.json"];
if (command === "refresh") {
  mkdirSync(directory, { recursive: true });
  for (const file of files) writeFileSync(join(directory, file), JSON.stringify({ product: basename(root), file }) + "\\n");
} else if (command === "verify") {
  for (const file of files) {
    if (!existsSync(join(directory, file))) throw new Error("missing " + file);
    const value = JSON.parse(readFileSync(join(directory, file), "utf8"));
    if (value.product !== basename(root)) throw new Error("foreign product lock");
  }
} else throw new Error("bad command");
`;
    write(join(fx.base, "scripts/runtime-deps-lock.mjs"), generator);
    write(join(fx.base, ".workloom-runtime-deps/package.json"), '{"product":"base-poison"}\n');
    const scope = readScope(fx.base);
    scope.include.push("scripts/runtime-deps-lock.mjs");
    scope.perProductDerivedAssets = [{
      directory: ".workloom-runtime-deps",
      files: ["package.json", "package-lock.json", "metadata.json"],
      generator: "scripts/runtime-deps-lock.mjs",
      refreshArgs: ["refresh"],
      verifyArgs: ["verify"],
      strategy: "preserve-and-regenerate-after-product-lockfile",
    }];
    writeScope(fx.base, scope);
    commitAll(fx.base, "add per-product derived runtime lock");

    const pull = cli(["pull", "--repo", "governance", "--base-dir", fx.base, "--json"], fx.child);
    assert.equal(pull.status, 0, pull.stderr || pull.stdout);
    const report = JSON.parse(pull.stdout);
    assert.deepEqual(report.perProductDerivedAssets, [{
      directory: ".workloom-runtime-deps",
      refreshed: true,
      verified: true,
    }]);
    for (const file of ["package.json", "package-lock.json", "metadata.json"]) {
      const value = JSON.parse(readFileSync(join(fx.child, "governance/.workloom-runtime-deps", file), "utf8"));
      assert.equal(value.product, "governance");
      assert.notEqual(value.product, "base-poison");
    }
    const committed = git(fx.child, "show", "--pretty=format:", "--name-only", "HEAD");
    assert.match(committed, /governance\/\.workloom-runtime-deps\/package-lock\.json/u);
    assert.equal(git(fx.child, "status", "--porcelain"), "");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("pre-commit staged secret scan 失败时不写假 state、不提交且不留 staged", () => {
  const fx = fixture();
  try {
    const secretLike = ["ghp", "Z".repeat(36)].join("_");
    write(join(fx.base, "WORKLOOM_PRODUCT_CONTEXT.md"), `credential sample: ${secretLike}\n`);
    commitAll(fx.base, "inject scanner fixture");
    const before = git(fx.child, "rev-parse", "HEAD");
    const result = cli(["pull", "--repo", "governance", "--base-dir", fx.base, "--required-only"], fx.child);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /提交前密钥扫描失败.*未写 state、未提交/);
    assert.equal(git(fx.child, "rev-parse", "HEAD"), before);
    assert.equal(existsSync(join(fx.child, ".workloom-base-sync.json")), false);
    assert.equal(existsSync(join(fx.child, "governance/.workloom-base-sync.json")), true);
    assert.equal(git(fx.child, "diff", "--cached", "--name-only"), "");
    assert.equal(readFileSync(join(fx.child, "WORKLOOM_PRODUCT_CONTEXT.md"), "utf8"), "context-v1\n");
    assert.equal(git(fx.child, "status", "--porcelain"), "");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("--no-commit 密钥扫描失败时回滚本次 required assets，保留同步前工作树", () => {
  const fx = fixture();
  try {
    const secretLike = ["ghp", "Y".repeat(36)].join("_");
    write(join(fx.base, "WORKLOOM_PRODUCT_CONTEXT.md"), `credential sample: ${secretLike}\n`);
    commitAll(fx.base, "inject no-commit scanner fixture");
    const beforeStatus = git(fx.child, "status", "--porcelain");
    const result = cli([
      "pull", "--repo", "governance", "--base-dir", fx.base,
      "--required-only", "--no-commit",
    ], fx.child);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no-commit 写入后密钥扫描失败.*未写 state、未提交/);
    assert.equal(readFileSync(join(fx.child, "WORKLOOM_PRODUCT_CONTEXT.md"), "utf8"), "context-v1\n");
    assert.equal(existsSync(join(fx.child, ".workloom-base-sync.json")), false);
    assert.equal(existsSync(join(fx.child, ".github/workflows/base-sync-heartbeat.yml")), false);
    assert.equal(git(fx.child, "status", "--porcelain"), beforeStatus);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("--no-commit 只扫描相对事务快照的新增行，不误报目标文件既有敏感样例", () => {
  const fx = fixture();
  try {
    const historical = `password=${["historical", "fixture", "value"].join("-")}`;
    write(join(fx.base, "shared/core.txt"), `${historical}\ncore-v2\n`);
    commitAll(fx.base, "base keeps historical fixture");
    write(join(fx.child, "governance/shared/core.txt"), `${historical}\ncore-v1\n`);
    commitAll(fx.child, "child already has historical fixture");

    const result = cli(["pull", "--repo", "governance", "--base-dir", fx.base, "--no-commit", "--json"], fx.child);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(readFileSync(join(fx.child, "governance/shared/core.txt"), "utf8"), `${historical}\ncore-v2\n`);
    assert.equal(git(fx.child, "diff", "--cached", "--name-only"), "");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("自动提交路径按新增行扫描并保留二次 staged 防线", () => {
  const fx = fixture();
  try {
    const historical = `secret=${["historical", "fixture", "value"].join("-")}`;
    write(join(fx.base, "shared/core.txt"), `${historical}\ncore-v2\n`);
    commitAll(fx.base, "base keeps historical fixture");
    write(join(fx.child, "governance/shared/core.txt"), `${historical}\ncore-v1\n`);
    commitAll(fx.child, "child already has historical fixture");
    const before = git(fx.child, "rev-parse", "HEAD");

    const result = cli(["pull", "--repo", "governance", "--base-dir", fx.base, "--json"], fx.child);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.notEqual(git(fx.child, "rev-parse", "HEAD"), before);
    assert.equal(readFileSync(join(fx.child, "governance/shared/core.txt"), "utf8"), `${historical}\ncore-v2\n`);
    assert.equal(git(fx.child, "status", "--porcelain"), "");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("新增文件中的密钥仍 fail closed 并完整回滚", () => {
  const fx = fixture();
  try {
    const secretLike = ["ghp", "N".repeat(36)].join("_");
    write(join(fx.base, "shared/new.txt"), `credential=${secretLike}\n`);
    commitAll(fx.base, "new unsafe managed file");
    const beforeStatus = git(fx.child, "status", "--porcelain");

    const result = cli(["pull", "--repo", "governance", "--base-dir", fx.base, "--no-commit"], fx.child);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no-commit 写入后密钥扫描失败.*未写 state、未提交/);
    assert.equal(existsSync(join(fx.child, "governance/shared/new.txt")), false);
    assert.equal(git(fx.child, "status", "--porcelain"), beforeStatus);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("基座已评审 finding 仅在源文件摘要、规则和行号完全匹配时接受", () => {
  const fx = fixture();
  try {
    const acceptedValue = ["ghp", "A".repeat(36)].join("_");
    const source = join(fx.base, "shared/reviewed-fixture.txt");
    write(source, `credential=${acceptedValue}\n`);
    const scope = readScope(fx.base);
    scope.acceptedBaseSecretScanFindings = {
      "shared/reviewed-fixture.txt": {
        sha256: createHash("sha256").update(readFileSync(source)).digest("hex"),
        findings: [{ rule: "github-token", line: 1 }],
        reason: "精确内容寻址的测试夹具",
      },
    };
    writeScope(fx.base, scope);
    commitAll(fx.base, "add reviewed scanner fixture");

    const accepted = cli(["pull", "--repo", "governance", "--base-dir", fx.base, "--no-commit", "--json"], fx.child);
    assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
    assert.equal(readFileSync(join(fx.child, "governance/shared/reviewed-fixture.txt"), "utf8"), `credential=${acceptedValue}\n`);
    commitAll(fx.child, "accept reviewed base fixture");

    const secondValue = ["ghp", "S".repeat(36)].join("_");
    const secondSource = join(fx.base, "shared/reviewed-second.txt");
    write(secondSource, `credential=${secondValue}\n`);
    const secondScope = readScope(fx.base);
    secondScope.acceptedBaseSecretScanFindings["shared/reviewed-second.txt"] = {
      sha256: createHash("sha256").update(readFileSync(secondSource)).digest("hex"),
      findings: [{ rule: "github-token", line: 1 }],
      reason: "自动提交精确接受测试夹具",
    };
    writeScope(fx.base, secondScope);
    commitAll(fx.base, "add second reviewed scanner fixture");
    const committed = cli(["pull", "--repo", "governance", "--base-dir", fx.base, "--json"], fx.child);
    assert.equal(committed.status, 0, committed.stderr || committed.stdout);
    assert.equal(readFileSync(join(fx.child, "governance/shared/reviewed-second.txt"), "utf8"), `credential=${secondValue}\n`);
    assert.equal(git(fx.child, "status", "--porcelain"), "");

    write(source, `credential=${acceptedValue}\nchanged\n`);
    commitAll(fx.base, "change accepted fixture without re-review");
    const rejected = cli(["pull", "--repo", "governance", "--base-dir", fx.base, "--no-commit"], fx.child);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /accepted base secret finding 内容摘要失配/);

    const realSecret = ["ghp", "R".repeat(36)].join("_");
    write(source, `credential=${acceptedValue}\ncredential=${realSecret}\n`);
    const reviewedScope = readScope(fx.base);
    reviewedScope.acceptedBaseSecretScanFindings["shared/reviewed-fixture.txt"].sha256 = createHash("sha256")
      .update(readFileSync(source)).digest("hex");
    writeScope(fx.base, reviewedScope);
    commitAll(fx.base, "re-review known finding without accepting new token");
    const blocked = cli(["pull", "--repo", "governance", "--base-dir", fx.base, "--no-commit"], fx.child);
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /no-commit 写入后密钥扫描失败/);
    assert.equal(readFileSync(join(fx.child, "governance/shared/reviewed-fixture.txt"), "utf8"), `credential=${acceptedValue}\n`);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("纯删除与普通含 NUL 图片遵循差异扫描边界", () => {
  const fx = fixture();
  try {
    const historical = `password=${["historical", "fixture", "value"].join("-")}`;
    write(join(fx.base, ".github/workflows/base-sync-push.yml"), `${historical}\n`);
    write(join(fx.child, ".github/workflows/base-sync-push.yml"), `${historical}\n`);
    const png = Buffer.alloc(2 * 1024 * 1024, 0);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
    writeFileSync(join(fx.base, "shared/asset.png"), png);
    commitAll(fx.base, "delete and binary fixtures");
    commitAll(fx.child, "legacy deletable fixture");

    const result = cli([
      "pull", "--repo", "governance", "--base-dir", fx.base,
      "--no-commit", "--adopt", "--json",
    ], fx.child);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(existsSync(join(fx.child, ".github/workflows/base-sync-push.yml")), false);
    assert.equal(readFileSync(join(fx.child, "governance/shared/asset.png")).includes(0), true);
    assert.equal(git(fx.child, "diff", "--cached", "--name-only"), "");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("base-sync 对含 NUL 二进制中的高置信 token 失败关闭并回滚", () => {
  const fx = fixture();
  try {
    const secretFile = join(fx.base, "shared/secret-asset.bin");
    writeFileSync(secretFile, Buffer.from(`\u0000token=${["ghp", "B".repeat(36)].join("_")}`));
    commitAll(fx.base, "binary secret fixture");

    const result = cli([
      "pull", "--repo", "governance", "--base-dir", fx.base,
      "--no-commit", "--adopt", "--json",
    ], fx.child);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no-commit 写入后密钥扫描失败/);
    assert.equal(existsSync(join(fx.child, "governance/shared/secret-asset.bin")), false);
    assert.equal(git(fx.child, "status", "--porcelain"), "");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("临时 base/child clone 在失败与 dry-run 路径都清理", () => {
  const fx = fixture();
  try {
    const failed = cli(["detect", "--repo", "governance", "--base-url", `file://${join(fx.root, "missing-remotes")}`], fx.child);
    assert.equal(failed.status, 1);
    assert.deepEqual(tempEntries(failed, "workloom-base-"), new Set());

    const remotes = join(fx.root, "remotes");
    mkdirSync(join(remotes, "owner"), { recursive: true });
    run("git", ["clone", "--bare", fx.child, join(remotes, "owner/child.git")], fx.root);
    write(join(fx.base, "sync/child-repos.json"), JSON.stringify({
      children: [{ repo: "owner/child", pathPrefix: "governance/", extraExclude: [] }],
    }, null, 2));
    commitAll(fx.base, "add child list");
    const dry = cli(["push", "--base", fx.base, "--base-url", `file://${remotes}`, "--dry-run", "--required-only", "--json"], fx.base);
    assert.equal(dry.status, 0, dry.stderr || dry.stdout);
    const pushReport = JSON.parse(dry.stdout);
    assert.equal(pushReport.results[0].pathPrefix, "governance");
    assert.equal(pushReport.results[0].stateUpdated, true);
    assert.deepEqual(pushReport.results[0].copied.sort(), [
      "root:.github/workflows/base-sync-heartbeat.yml",
      "root:WORKLOOM_PRODUCT_CONTEXT.md",
    ].sort());
    assert.deepEqual(pushReport.results[0].managed, ["root:AGENTS.md#managed-section"]);
    assert.doesNotMatch(JSON.stringify(pushReport.results[0]), /shared\/core\.txt/);
    assert.deepEqual(tempEntries(dry, "workloom-child-"), new Set());
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("push 对 manifest pathPrefix symlink（含 dangling）fail closed", () => {
  const fx = fixture();
  try {
    const remotes = join(fx.root, "remotes");
    const malicious = join(fx.root, "malicious-child");
    mkdirSync(join(remotes, "owner"), { recursive: true });
    initRepo(malicious);
    symlinkSync("never-created", join(malicious, "governance"));
    write(join(malicious, "safe.txt"), "safe\n");
    commitAll(malicious, "dangling path prefix");
    run("git", ["clone", "--bare", malicious, join(remotes, "owner/malicious.git")], fx.root);
    write(join(fx.base, "sync/child-repos.json"), JSON.stringify({
      children: [{ repo: "owner/malicious", pathPrefix: "governance/", extraExclude: [] }],
    }, null, 2));
    commitAll(fx.base, "add malicious child list");
    const result = cli([
      "push", "--base", fx.base, "--base-url", `file://${remotes}`,
      "--dry-run", "--required-only", "--json",
    ], fx.base);
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.results[0].ok, false);
    assert.match(report.results[0].error, /pathPrefix 不允许 symlink/);
    assert.deepEqual(tempEntries(result, "workloom-child-"), new Set());
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("adopt 支持 .git 为文件的 linked worktree，并且不提交", () => {
  const fx = fixture();
  const source = join(fx.root, "source");
  const child = join(fx.root, "linked-child");
  const fixtureAdopt = join(fx.base, "sync/adopt.sh");
  try {
    initRepo(source);
    write(join(source, "seed.txt"), "seed\n");
    commitAll(source, "seed");
    git(source, "worktree", "add", "-b", "linked-child", child);
    write(join(child, "governance/child.txt"), "industry\n");
    write(join(child, "AGENTS.repo.md"), readFileSync(join(fx.base, "AGENTS.repo.md"), "utf8"));
    write(join(child, ".github/workflows/base-sync-push.yml"), readFileSync(join(fx.base, ".github/workflows/base-sync-push.yml"), "utf8"));
    write(join(child, ".github/workflows/industry.yml"), "name: industry-owned\n");
    commitAll(child, "template-derived child");
    const beforeHead = git(child, "rev-parse", "HEAD");
    const pathDir = dirname(NODE);
    const rejected = spawnSync("bash", [fixtureAdopt, child, "--path-prefix", "../"], {
      cwd: fx.base,
      encoding: "utf8",
      env: { ...process.env, PATH: `${pathDir}:${process.env.PATH}` },
    });
    assert.equal(rejected.status, 64);
    assert.match(rejected.stdout, /安全相对目录/);
    const result = spawnSync("bash", [fixtureAdopt, child, "--path-prefix", "governance/"], {
      cwd: fx.base,
      encoding: "utf8",
      env: { ...process.env, PATH: `${pathDir}:${process.env.PATH}` },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(git(child, "rev-parse", "HEAD"), beforeHead);
    assert.match(readFileSync(join(child, "AGENTS.md"), "utf8"), /WORKLOOM-CONTEXT:BEGIN/);
    assert.equal(readFileSync(join(child, "WORKLOOM_PRODUCT_CONTEXT.md"), "utf8"), "context-v2\n");
    const state = JSON.parse(readFileSync(join(child, ".workloom-base-sync.json"), "utf8"));
    assert.equal(state.lastSyncMode, "required-only");
    assert.equal(state.pathPrefix, "governance");
    assert.ok(readFileSync(join(child, ".github/workflows/base-sync-heartbeat.yml"), "utf8").includes("base-sync-heartbeat"));
    assert.equal(readFileSync(join(child, "AGENTS.repo.md"), "utf8"), "# 本仓专属开发规则\n\n> 请结合本仓实际内容填写。\n");
    assert.equal(existsSync(join(child, ".github/workflows/base-sync-push.yml")), false);
    assert.equal(readFileSync(join(child, ".github/workflows/industry.yml"), "utf8"), "name: industry-owned\n");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("adopt 对已定制的 AGENTS.repo 与同名 workflow 均保留不覆盖", () => {
  const fx = fixture();
  try {
    write(join(fx.child, "AGENTS.repo.md"), "# child-custom\n");
    write(join(fx.child, ".github/workflows/base-sync-push.yml"), "name: child-custom-workflow\n");
    commitAll(fx.child, "customized inherited files");
    const result = cli([
      "pull", "--repo", join(fx.child, "governance"), "--base-dir", fx.base,
      "--required-only", "--no-commit", "--adopt", "--json",
    ], fx.base);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.pathPrefix, "governance");
    assert.deepEqual(report.adopted, []);
    assert.equal(report.warnings.filter((line) => /fingerprint 不同/.test(line)).length, 2);
    assert.equal(readFileSync(join(fx.child, "AGENTS.repo.md"), "utf8"), "# child-custom\n");
    assert.equal(readFileSync(join(fx.child, ".github/workflows/base-sync-push.yml"), "utf8"), "name: child-custom-workflow\n");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("新行业缺少消费 CI 工程契约时零写入 fail closed", () => {
  const fx = newIndustryFixture();
  try {
    rmSync(join(fx.child, "pnpm-workspace.yaml"));
    commitAll(fx.child, "remove workspace contract");
    const result = spawnSync("bash", [join(fx.base, "sync/adopt.sh"), fx.child, "--new-industry"], {
      cwd: fx.base,
      encoding: "utf8",
      env: { ...process.env, PATH: `${fx.bin}:${dirname(NODE)}:${process.env.PATH}` },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /新行业接入前置契约失败.*pnpm-workspace\.yaml/s);
    assert.equal(existsSync(join(fx.child, ".workloom-base-sync.json")), false);
    assert.equal(existsSync(join(fx.child, ".workloom-ui.json")), false);
    assert.equal(existsSync(join(fx.child, "apps/web/package.json")), false);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("最小新行业仓一次完成 full 基座、三端稳定壳与消费门禁资产", () => {
  const fx = newIndustryFixture();
  try {
    assert.equal(existsSync(join(fx.child, "node_modules")), false, "fixture 必须从无依赖树的新仓开始");
    const beforeHead = git(fx.child, "rev-parse", "HEAD");
    const result = spawnSync("bash", [join(fx.base, "sync/adopt.sh"), fx.child, "--new-industry"], {
      cwd: fx.base,
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, PATH: `${fx.bin}:${dirname(NODE)}:${process.env.PATH}` },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /完整公共基座.*共享 UI 已一次接入/s);
    assert.equal(git(fx.child, "rev-parse", "HEAD"), beforeHead);
    assert.equal(git(fx.child, "diff", "--cached", "--name-only"), "");
    assert.equal(readFileSync(join(fx.child, "shared/core.txt"), "utf8"), "core-v2\n");
    const baseState = JSON.parse(readFileSync(join(fx.child, ".workloom-base-sync.json"), "utf8"));
    assert.equal(baseState.lastSyncMode, "full");
    assert.equal(baseState.lastSyncedBaseSha, fx.stableSha);
    const uiState = JSON.parse(readFileSync(join(fx.child, ".workloom-ui.json"), "utf8"));
    assert.equal(uiState.version, fx.stable);
    assert.deepEqual(uiState.connectedClientPackages, [
      "apps/web/package.json",
      "apps/webb/package.json",
      "apps/webc/package.json",
    ]);
    const foundation = JSON.parse(readFileSync(join(fx.child, ".workloom-client-foundation.json"), "utf8"));
    assert.equal(foundation.version, fx.stable);
    assert.equal(foundation.sourceRef, `refs/tags/ui-v${fx.stable}`);
    for (const path of [
      "apps/web/src/main.tsx",
      "apps/webb/src/main.tsx",
      "apps/webc/src/main.tsx",
      ".workloom-ui-governance.json",
      "scripts/verify-ui-consumer.mjs",
      "scripts/ui-governance-rules.mjs",
      "scripts/verify-client-foundation-consumer.mjs",
      "scripts/verify-production-client-boundary.mjs",
      ".github/workflows/workloom-ui-contract.yml",
      ".workloom-runtime-deps/package.json",
      ".workloom-runtime-deps/package-lock.json",
      ".workloom-runtime-deps/metadata.json",
    ]) assert.equal(existsSync(join(fx.child, path)), true, `${path} 应已安装`);
    const packageJson = JSON.parse(readFileSync(join(fx.child, "package.json"), "utf8"));
    assert.equal(packageJson.devDependencies["typescript-governance"], "npm:typescript@5.9.3");
    assert.equal(packageJson.devDependencies["yaml-governance"], "npm:yaml@2.9.0");
    const releaseUrl = `https://cnb.cool/workloom-ai/workloom-im/-/releases/download/ui-v${fx.stable}/workloom-ui-${fx.stable}.tgz`;
    assert.equal(packageJson.pnpm.overrides[`@workloom/ui@${fx.stable}`], releaseUrl);
    const lockfile = readFileSync(join(fx.child, "pnpm-lock.yaml"), "utf8");
    assert.match(lockfile, /typescript-governance/u);
    assert.match(lockfile, /yaml-governance/u);
    assert.ok(lockfile.includes(releaseUrl));
    assert.equal(existsSync(join(fx.child, "node_modules/typescript-governance")), true, "消费门禁前必须真实安装解析器");
    assert.equal(existsSync(join(fx.child, "node_modules/yaml-governance")), true, "消费门禁前必须真实安装 YAML 解析器");
    const governanceState = JSON.parse(readFileSync(join(fx.child, ".workloom-ui-governance.json"), "utf8"));
    assert.equal(governanceState.schemaVersion, "workloom.ui-governance-state/v1");
    assert.equal(governanceState.yamlDependency, "npm:yaml@2.9.0");
    assert.ok(governanceState.files["scripts/verify-ui-consumer.mjs"].sha256);
    assert.ok(governanceState.files["scripts/ui-governance-rules.mjs"].sha256);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("full 同步在依赖变更后重算子仓开源组件清单并纳入提交", () => {
  const fx = newIndustryFixture();
  try {
    // 子仓已有派生清单（内容过期），生成器随本次同步从基座下发。
    write(join(fx.child, "docs/OPEN_SOURCE_COMPONENTS.md"), "stale-inventory\n");
    commitAll(fx.child, "stale derived inventory before sync");

    // 生成器读取 runtime 依赖锁（fixture 的 runtime-deps 桩会在刷新阶段写它），
    // 从而锁定「清单生成必须晚于派生锁刷新」这一顺序要求。
    write(join(fx.base, "scripts/oss-inventory.mjs"), `#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const target = join(process.cwd(), "docs/OPEN_SOURCE_COMPONENTS.md");
const runtimeLock = JSON.parse(readFileSync(join(process.cwd(), ".workloom-runtime-deps/package.json"), "utf8"));
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, "regenerated-inventory:" + runtimeLock.product + "\\n");
`);
    write(join(fx.base, "shared/package.json"), `${JSON.stringify({
      name: "@example/shared",
      dependencies: { zod: "^4.6.5" },
    }, null, 2)}\n`);
    // 本用例关注清单刷新，放宽 fixture 的 2 文件同步上限（首轮对齐本身就有多项变更）。
    const scope = readScope(fx.base);
    scope.pollutionGuard.maxFilesPerSync = 40;
    // 真实仓库把 runtime 依赖锁登记为产品派生资产；清单把它当作事实源之一。
    scope.perProductDerivedAssets = [{
      directory: ".workloom-runtime-deps",
      files: ["package.json", "package-lock.json", "metadata.json"],
      generator: "scripts/runtime-deps-lock.mjs",
      refreshArgs: ["refresh"],
      verifyArgs: ["verify"],
      strategy: "preserve-and-regenerate-after-product-lockfile",
    }];
    writeScope(fx.base, scope);
    commitAll(fx.base, "inventory generator and dependency source");

    // 该用例只关心清单刷新：用最小 pnpm 桩替换 fixture 的 UI 桩（后者要求已接入的 UI override）。
    const bin = join(fx.root, "inventory-bin");
    const fakePnpm = join(bin, "pnpm");
    write(fakePnpm, `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
if (process.argv.includes("--lockfile-only")) {
  writeFileSync(join(process.cwd(), "pnpm-lock.yaml"), "lockfileVersion: '9.0'\\n");
}
`);
    chmodSync(fakePnpm, 0o755);

    const result = cli(["pull", "--repo", ".", "--base-dir", fx.base, "--json"], fx.child, {
      ...process.env,
      PATH: `${bin}:${dirname(NODE)}:${process.env.PATH}`,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.lockfileRefreshed, true);
    assert.equal(report.ossInventoryRefreshed, true);
    // fixture 的 runtime-deps 桩把 product 写成子仓目录名（tiger），说明清单是在派生锁刷新之后生成的。
    assert.equal(
      readFileSync(join(fx.child, "docs/OPEN_SOURCE_COMPONENTS.md"), "utf8"),
      "regenerated-inventory:tiger\n",
    );
    const committed = git(fx.child, "show", "--pretty=format:", "--name-only", "HEAD");
    assert.match(committed, /docs\/OPEN_SOURCE_COMPONENTS\.md/u);
    assert.equal(git(fx.child, "status", "--porcelain"), "");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("UI 消费仓 full 同步重算 lockfile 后重新绑定稳定制品 SHA-512", () => {
  const fx = newIndustryFixture();
  try {
    const adopt = spawnSync("bash", [join(fx.base, "sync/adopt.sh"), fx.child, "--new-industry"], {
      cwd: fx.base,
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, PATH: `${fx.bin}:${dirname(NODE)}:${process.env.PATH}` },
    });
    assert.equal(adopt.status, 0, `${adopt.stdout}\n${adopt.stderr}`);
    commitAll(fx.child, "adopted stable client foundation");

    const state = JSON.parse(readFileSync(join(fx.child, ".workloom-ui.json"), "utf8"));
    const expectedIntegrity = state.artifact.sha512;
    assert.ok(
      readFileSync(join(fx.child, "pnpm-lock.yaml"), "utf8").includes(`integrity: ${expectedIntegrity}`),
      "接入完成时 lockfile 必须已绑定稳定制品 SHA-512",
    );

    // 基座新增会被普通同步覆盖的 package.json 源 → full 同步必须先在子仓重算 lock；fixture 的 pnpm 桩
    // 复现 pnpm 10.14 行为：URL tarball 只写 resolution.tarball、不写 SRI。
    write(join(fx.base, "shared/package.json"), `${JSON.stringify({
      name: "@example/shared",
      version: "1.0.0",
      dependencies: { zod: "^4.6.5" },
    }, null, 2)}\n`);
    commitAll(fx.base, "add shared package source");

    const result = cli(["pull", "--repo", ".", "--base-dir", fx.base, "--json"], fx.child, {
      ...process.env,
      PATH: `${fx.bin}:${dirname(NODE)}:${process.env.PATH}`,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.lockfileRefreshed, true);
    const lockfile = readFileSync(join(fx.child, "pnpm-lock.yaml"), "utf8");
    assert.ok(
      lockfile.includes(`resolution: {integrity: ${expectedIntegrity}, tarball: `),
      "重算 lock 后必须重新注入稳定制品 SHA-512，否则 UI 消费门禁判红",
    );
    assert.equal(report.uiLockfileIntegrity?.changed, true);
    assert.equal(report.uiLockfileIntegrity?.integrity, expectedIntegrity);
    assert.equal(git(fx.child, "status", "--porcelain"), "");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("新行业后置 verifier 失败时恢复原有 staged、unstaged、untracked 与全部接入资产", () => {
  const fx = newIndustryFixture();
  try {
    write(join(fx.child, "notes.txt"), "user staged\n");
    git(fx.child, "add", "notes.txt");
    write(join(fx.child, "notes.txt"), "user staged plus unstaged\n");
    write(join(fx.child, "user-draft.txt"), "keep draft\n");
    const beforeStatus = git(fx.child, "status", "--porcelain=v1", "--untracked-files=all");
    const beforeNotes = readFileSync(join(fx.child, "notes.txt"));
    const beforePackage = readFileSync(join(fx.child, "package.json"));
    const beforeLock = readFileSync(join(fx.child, "pnpm-lock.yaml"));

    write(join(fx.base, "scripts/verify-client-foundation-consumer.mjs"), "console.error('injected final verifier failure'); process.exit(17);\n");
    commitAll(fx.base, "inject late verifier failure");
    const result = spawnSync("bash", [join(fx.base, "sync/adopt.sh"), fx.child, "--new-industry"], {
      cwd: fx.base,
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, PATH: `${fx.bin}:${dirname(NODE)}:${process.env.PATH}` },
    });
    assert.equal(result.status, 17, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /injected final verifier failure/u);
    assert.match(`${result.stdout}\n${result.stderr}`, /已恢复到接入前状态/u);
    assert.equal(git(fx.child, "status", "--porcelain=v1", "--untracked-files=all"), beforeStatus);
    assert.deepEqual(readFileSync(join(fx.child, "notes.txt")), beforeNotes);
    assert.deepEqual(readFileSync(join(fx.child, "package.json")), beforePackage);
    assert.deepEqual(readFileSync(join(fx.child, "pnpm-lock.yaml")), beforeLock);
    assert.equal(readFileSync(join(fx.child, "user-draft.txt"), "utf8"), "keep draft\n");
    for (const path of [
      ".workloom-base-sync.json",
      ".workloom-ui.json",
      ".workloom-client-foundation.json",
      ".workloom-ui-governance.json",
      "apps/web/package.json",
      "scripts/verify-ui-consumer.mjs",
      ".github/workflows/workloom-ui-contract.yml",
      "node_modules",
    ]) assert.equal(existsSync(join(fx.child, path)), false, `${path} 不得残留半接入状态`);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("新行业后置失败不得覆盖被 ignore 的既有 UI state", () => {
  const fx = newIndustryFixture();
  try {
    write(join(fx.child, ".gitignore"), ".workloom-ui.json\n.workloom-client-foundation.json\n.workloom-ui-governance.json\n");
    commitAll(fx.child, "ignore generated adoption state");
    const previousUiState = "{\"version\":\"industry-preserved\"}\n";
    write(join(fx.child, ".workloom-ui.json"), previousUiState);
    const beforeStatus = git(fx.child, "status", "--porcelain=v1", "--untracked-files=all");

    write(join(fx.base, "scripts/verify-client-foundation-consumer.mjs"), "console.error('injected ignored-state rollback failure'); process.exit(19);\n");
    commitAll(fx.base, "inject ignored-state rollback failure");
    const result = spawnSync("bash", [join(fx.base, "sync/adopt.sh"), fx.child, "--new-industry"], {
      cwd: fx.base,
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, PATH: `${fx.bin}:${dirname(NODE)}:${process.env.PATH}` },
    });
    assert.equal(result.status, 19, `${result.stdout}\n${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /已恢复到接入前状态/u);
    assert.equal(git(fx.child, "status", "--porcelain=v1", "--untracked-files=all"), beforeStatus);
    assert.equal(readFileSync(join(fx.child, ".workloom-ui.json"), "utf8"), previousUiState);
    assert.equal(existsSync(join(fx.child, ".workloom-client-foundation.json")), false);
    assert.equal(existsSync(join(fx.child, ".workloom-ui-governance.json")), false);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("新行业 lockfile 安装失败时回滚 pnpm 写入与所有先前阶段", () => {
  const fx = newIndustryFixture();
  try {
    const fakePnpm = join(fx.bin, "pnpm");
    write(fakePnpm, `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
writeFileSync(join(process.cwd(), "pnpm-lock.yaml"), "half generated lock\\n");
mkdirSync(join(process.cwd(), "apps/web/node_modules"), { recursive: true });
writeFileSync(join(process.cwd(), "apps/web/node_modules/half.txt"), "half dependency\\n");
process.exit(42);
`);
    chmodSync(fakePnpm, 0o755);
    const beforeStatus = git(fx.child, "status", "--porcelain=v1", "--untracked-files=all");
    const beforeLock = readFileSync(join(fx.child, "pnpm-lock.yaml"));
    const result = spawnSync("bash", [join(fx.base, "sync/adopt.sh"), fx.child, "--new-industry"], {
      cwd: fx.base,
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, PATH: `${fx.bin}:${dirname(NODE)}:${process.env.PATH}` },
    });
    assert.equal(result.status, 42, `${result.stdout}\n${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /已恢复到接入前状态/u);
    assert.equal(git(fx.child, "status", "--porcelain=v1", "--untracked-files=all"), beforeStatus);
    assert.deepEqual(readFileSync(join(fx.child, "pnpm-lock.yaml")), beforeLock);
    assert.equal(existsSync(join(fx.child, "apps/web/node_modules")), false);
    assert.equal(existsSync(join(fx.child, ".workloom-base-sync.json")), false);
    assert.equal(existsSync(join(fx.child, ".github/workflows/workloom-ui-contract.yml")), false);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("新行业已有任意 workspace node_modules 时在写入前 fail closed", () => {
  const fx = newIndustryFixture();
  try {
    write(join(fx.child, "tools/local/node_modules/keep.txt"), "user dependency\n");
    const beforeStatus = git(fx.child, "status", "--porcelain=v1", "--untracked-files=all");
    const result = spawnSync("bash", [join(fx.base, "sync/adopt.sh"), fx.child, "--new-industry"], {
      cwd: fx.base,
      encoding: "utf8",
      env: { ...process.env, PATH: `${fx.bin}:${dirname(NODE)}:${process.env.PATH}` },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /要求无既有依赖树.*tools\/local\/node_modules/su);
    assert.equal(readFileSync(join(fx.child, "tools/local/node_modules/keep.txt"), "utf8"), "user dependency\n");
    assert.equal(git(fx.child, "status", "--porcelain=v1", "--untracked-files=all"), beforeStatus);
    assert.equal(existsSync(join(fx.child, ".workloom-base-sync.json")), false);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("新行业已有冲突解析器版本时在基座写入前 fail closed", () => {
  const fx = newIndustryFixture();
  try {
    const packagePath = join(fx.child, "package.json");
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
    packageJson.devDependencies["typescript-governance"] = "^5.8.0";
    write(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
    commitAll(fx.child, "custom governance parser");
    const result = spawnSync("bash", [join(fx.base, "sync/adopt.sh"), fx.child, "--new-industry"], {
      cwd: fx.base,
      encoding: "utf8",
      env: { ...process.env, PATH: `${fx.bin}:${dirname(NODE)}:${process.env.PATH}` },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /不得静默覆盖|拒绝静默覆盖/u);
    assert.equal(existsSync(join(fx.child, ".workloom-base-sync.json")), false);
    assert.equal(existsSync(join(fx.child, ".workloom-ui-governance.json")), false);
    assert.equal(existsSync(join(fx.child, "apps/web/package.json")), false);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("新行业已有自定义 verifier 时在基座写入前 fail closed", () => {
  const fx = newIndustryFixture();
  try {
    write(join(fx.child, "scripts/verify-ui-consumer.mjs"), "console.log('industry custom');\n");
    commitAll(fx.child, "custom ui verifier");
    const result = spawnSync("bash", [join(fx.base, "sync/adopt.sh"), fx.child, "--new-industry"], {
      cwd: fx.base,
      encoding: "utf8",
      env: { ...process.env, PATH: `${fx.bin}:${dirname(NODE)}:${process.env.PATH}` },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /已被行业仓定制；拒绝静默覆盖/u);
    assert.equal(readFileSync(join(fx.child, "scripts/verify-ui-consumer.mjs"), "utf8"), "console.log('industry custom');\n");
    assert.equal(existsSync(join(fx.child, ".workloom-base-sync.json")), false);
    assert.equal(existsSync(join(fx.child, ".workloom-ui-governance.json")), false);
    assert.equal(existsSync(join(fx.child, "apps/web/package.json")), false);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

/**
 * 清单口径触发（2026-09-29 实测事故）：
 * `.oss-watch-state.json` / `oss-components.json` 本就在同步排除面里，真正会随波次变、
 * 又不在 lockfile 事实里的清单口径来源是 **生成器自身**（`scripts/oss-inventory.mjs`）
 * 与 **产品派生锁**（`.workloom-runtime-deps/**`）。只按 lockfile 触发会漏算，
 * 子仓 `pnpm oss:check` 随即判红（workroom-fox 定向 full 波次实测）。
 */
test("只换生成器（不动 package.json / lockfile）也必须重算开源组件清单", () => {
  const fx = newIndustryFixture();
  try {
    write(join(fx.child, "docs/OPEN_SOURCE_COMPONENTS.md"), "stale-inventory\n");
    commitAll(fx.child, "stale derived inventory before generator swap");

    write(join(fx.base, "scripts/oss-inventory.mjs"), `#!/usr/bin/env node
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
const stamp = readFileSync(join(process.cwd(), "scripts/oss-inventory.mjs"), "utf8").length;
const target = join(process.cwd(), "docs/OPEN_SOURCE_COMPONENTS.md");
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, "regenerated-after-generator-swap:" + stamp + "\\n");
`);
    const scope = readScope(fx.base);
    scope.pollutionGuard.maxFilesPerSync = 40;
    writeScope(fx.base, scope);
    commitAll(fx.base, "publish new inventory generator only");

    const result = cli(["pull", "--repo", ".", "--base-dir", fx.base, "--json"], fx.child);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ossInventoryRefreshed, true, "生成器变化必须触发清单重算");
    assert.match(
      readFileSync(join(fx.child, "docs/OPEN_SOURCE_COMPONENTS.md"), "utf8"),
      /^regenerated-after-generator-swap:\d+\n$/u,
    );
    const committed = git(fx.child, "show", "--pretty=format:", "--name-only", "HEAD");
    assert.match(committed, /docs\/OPEN_SOURCE_COMPONENTS\.md/u);
    assert.equal(git(fx.child, "status", "--porcelain"), "");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});
