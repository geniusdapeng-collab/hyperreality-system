import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildInventory,
  collectContainerInventory,
  collectNpmInventory,
  collectPythonInventory,
  compareVersions,
  generateDocument,
  highestVersion,
  isOutdated,
  normalizeRepoIdentityForCompare,
  probeVersions,
  renderMarkdown,
} from "./oss-inventory.mjs";

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "oss-inventory-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
  return root;
}

const LOCKFILE = `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      react:
        specifier: 19.2.8
        version: 19.2.8
    devDependencies:
      typescript-governance:
        specifier: npm:typescript@5.9.3
        version: 5.9.3
      typescript:
        specifier: ^7.0.2
        version: 7.0.2

  apps/web:
    dependencies:
      '@workloom/ui':
        specifier: workspace:*
        version: link:../../packages/ui
      vite:
        specifier: 8.2.2
        version: 8.2.2(esbuild@0.28.2)
`;

const WORKSPACE = 'packages:\n  - "apps/*"\n  - "packages/*"\n';

test("npm 清单：优先采用 lockfile 解析版本，并保留 npm 别名行", () => {
  const root = fixture({
    "package.json": {
      name: "fixture",
      dependencies: { react: "19.2.8" },
      devDependencies: { "typescript-governance": "npm:typescript@5.9.3", typescript: "^7.0.2" },
    },
    "pnpm-workspace.yaml": WORKSPACE,
    "pnpm-lock.yaml": LOCKFILE,
    "apps/web/package.json": { name: "@fixture/web", dependencies: { vite: "8.2.2" } },
  });
  try {
    const inventory = collectNpmInventory(root);
    const byName = Object.fromEntries(inventory.packages.map((entry) => [entry.name, entry]));
    assert.equal(byName.react.versions[0], "19.2.8");
    assert.equal(byName.vite.versions[0], "8.2.2");
    assert.equal(byName["typescript-governance"].package, "typescript");
    assert.equal(byName["typescript-governance"].versions[0], "5.9.3");
    assert.equal(byName.typescript.versions[0], "7.0.2");
    assert.ok(inventory.workspaceMembers.includes("apps/web/package.json"));
    assert.equal(inventory.packages.find((entry) => entry.name === "react").resolution, "lockfile");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Python 与容器镜像：解析约束、镜像来源", () => {
  const root = fixture({
    "requirements.txt": "pandas>=2.0\nnumpy==2.3.1\n# 注释\n-r extra.txt\n",
    "packages/tool/requirements.txt": "playwright>=1.40.0\n",
    "docker-compose.yml": 'services:\n  postgres:\n    image: pgvector/pgvector:pg17\n',
    ".cnb.yml": 'main:\n  push:\n    - docker:\n        image: node:24.19.0-bookworm\n',
  });
  try {
    const python = collectPythonInventory(root);
    const byName = Object.fromEntries(python.map((entry) => [entry.package.toLowerCase(), entry]));
    assert.equal(byName.pandas.specifier, ">=2.0");
    assert.equal(byName.numpy.specifier, "==2.3.1");
    assert.equal(byName.numpy.versions[0], "2.3.1");
    assert.ok(byName.playwright.sources.includes("packages/tool/requirements.txt"));
    const images = collectContainerInventory(root).map((entry) => entry.image);
    assert.ok(images.includes("pgvector/pgvector:pg17"));
    assert.ok(images.includes("node:24.19.0-bookworm"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("probe 探测：regex / vendor / lockfile 三类来源", () => {
  const root = fixture({
    "package.json": { name: "fixture" },
    "pnpm-workspace.yaml": WORKSPACE,
    "pnpm-lock.yaml": LOCKFILE,
    "scripts/embedded.mjs": 'export const NATS_VERSION = "v2.11.4";\n',
    "vendor/dsh/package.json": { name: "@deepseek-ai/dsh", version: "0.1.2-rc.1" },
    ".cnb.yml": 'main:\n  push:\n    - docker:\n        image: node:24.19.0-bookworm\n',
  });
  try {
    const probes = probeVersions(root, [
      { name: "nats", probe: { kind: "regex", file: "scripts/embedded.mjs", pattern: "NATS_VERSION\\s*=\\s*\"([^\"]+)\"" } },
      { name: "dsh", probe: { kind: "vendor", file: "vendor/dsh/package.json" } },
      { name: "node", probe: { kind: "regex", file: ".cnb.yml", pattern: "image: node:([0-9.]+)" } },
    ]);
    assert.equal(probes.nats.value, "v2.11.4");
    assert.equal(probes.dsh.value, "0.1.2-rc.1");
    assert.equal(probes.node.value, "24.19.0");
    assert.equal(probes.node.source, ".cnb.yml");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("清单渲染：确定性、含上游最新与漂移标记、--check 可复现", () => {
  const root = fixture({
    "package.json": { name: "fixture", dependencies: { react: "19.2.8" } },
    "pnpm-workspace.yaml": WORKSPACE,
    "pnpm-lock.yaml": LOCKFILE,
    "oss-components.json": {
      meta: { schema: "workloom.oss-components/v2" },
      components: [
        {
          name: "React",
          package: "react",
          repo: "https://github.com/facebook/react",
          license: "MIT",
          channel: "npm",
          usage: "runtime",
          latest: "19.3.0",
          latest_checked_at: "2026-09-18T00:00:00.000Z",
          notes: "同批升级",
        },
      ],
    },
    ".oss-watch-state.json": {
      schema: "workloom.oss-watch-state/v2",
      last_full_scan: "2026-09-18T00:00:00.000Z",
      last_success: "2026-09-18T00:00:00.000Z",
      components: {},
      registry_cache: {
        react: { ecosystem: "npm", latest: "19.3.0", status: 'ok', checked_at: Math.floor(Date.now() / 1000), checked_at_iso: new Date().toISOString() },
        vite: { ecosystem: "npm", latest: "8.3.0", checked_at: 1, checked_at_iso: "2026-09-18T00:00:00.000Z" },
      },
    },
  });
  try {
    const first = generateDocument(root).content;
    const second = generateDocument(root).content;
    assert.equal(first, second, "同一仓库两次生成必须逐字节一致（--check 才可复现）");
    assert.match(first, /19\.2\.8/);
    assert.match(first, /\*\*19\.3\.0\*\* ⬆/, "滞后项应标出上游最新");
    assert.match(first, /最近一次成功扫描：2026-09-18T00:00:00\.000Z/);
    const inventory = buildInventory(root);
    const rendered = renderMarkdown({
      root,
      repo: { name: "fixture", slug: null },
      registry: {
        meta: {},
        components: JSON.parse(readFileSync(join(root, "oss-components.json"), "utf8")).components,
      },
      inventory,
      state: JSON.parse(readFileSync(join(root, ".oss-watch-state.json"), "utf8")),
    });
    assert.equal(rendered, first);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("版本工具：最高版本选择与滞后判定", () => {
  assert.equal(highestVersion(["3.2.7", "5.0.1"]), "5.0.1");
  assert.equal(highestVersion([]), null);
  assert.equal(compareVersions("1.0.0-rc.1", "1.0.0-rc.2"), -1);
  assert.equal(compareVersions("1.0.0-rc.10", "1.0.0-rc.2"), 1);
  assert.equal(compareVersions("1.0.0+build.1", "1.0.0+build.9"), 0);
  assert.equal(compareVersions("1.0.0-1", "1.0.0-alpha"), -1);
  assert.equal(compareVersions("1.0.0-alpha", "1.0.0-alpha.1"), -1);
  assert.equal(isOutdated("8.2.2", "8.3.0"), true);
  assert.equal(isOutdated("8.3.0", "8.3.0"), false);
  assert.equal(isOutdated("（未锁定）", "8.3.0"), false);
});

test("仓库标识行：克隆 URL 大小写不同不算清单漂移", () => {
  const lower = [
    "# 清单",
    "",
    "> 仓库：workloom-ai/workloom-growthmatrix ｜ 最近一次上游扫描：2026-09-28T17:13:25.000Z",
    "> 统计：登记组件 98 个",
    "",
  ].join("\n");
  const upper = lower.replace("workloom-growthmatrix", "workloom-Growthmatrix");
  assert.equal(
    normalizeRepoIdentityForCompare(lower),
    normalizeRepoIdentityForCompare(upper),
    "同一仓的不同大小写写法不得判为漂移（回归：growthmatrix main static-gate 红灯）",
  );
  const moved = lower.replace("workloom-growthmatrix", "workloom-growthtest");
  assert.notEqual(
    normalizeRepoIdentityForCompare(lower),
    normalizeRepoIdentityForCompare(moved),
    "换仓造成的真实漂移必须仍然判出",
  );
  assert.equal(normalizeRepoIdentityForCompare(null), "");
});

function clockDocument(t, state) {
  const root = fixture({
    "package.json": { name: "clock-fixture" },
    "oss-components.json": { components: [{ name: "fixture", current: "1.0.0" }] },
    ".oss-watch-state.json": { components: {}, registry_cache: {}, ...state },
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return generateDocument(root).content;
}

test("成功扫描钟：legacy last_full_scan 只显示历史未核实尝试，不能作为成功兜底", t => {
  const content = clockDocument(t, { last_full_scan: "2026-09-18T00:00:00.000Z" });
  assert.match(content, /最近一次成功扫描：尚未记录已核实成功/u);
  assert.match(content, /历史全量扫描\/尝试（未核实）：2026-09-18T00:00:00\.000Z/u);
  assert.doesNotMatch(content, /最近一次成功扫描：2026-09-18T00:00:00\.000Z/u);
});

test("成功扫描钟：无效、未来或错误类型的 last_success 不能显示为成功", t => {
  for (const last_success of ["not-a-time", "2099-01-01T00:00:00.000Z", 123]) {
    const content = clockDocument(t, { last_success, last_full_scan: "2026-09-18T00:00:00.000Z" });
    assert.match(content, /最近一次成功扫描：尚未记录已核实成功/u);
    assert.doesNotMatch(content, /最近一次成功扫描：(not-a-time|2099-01-01|123)/u);
  }
});

test("成功扫描钟：last_success 与后来失败尝试、legacy 历史字段分别保留", t => {
  const content = clockDocument(t, {
    last_success: "2026-09-19T00:00:00.000Z",
    last_attempt: "2026-09-20T00:00:00.000Z",
    last_full_scan: "2026-09-18T00:00:00.000Z",
    status: "error",
  });
  assert.match(content, /最近一次成功扫描：2026-09-19T00:00:00\.000Z/u);
  assert.match(content, /最近尝试：2026-09-20T00:00:00\.000Z/u);
  assert.match(content, /历史全量扫描\/尝试（未核实）：2026-09-18T00:00:00\.000Z/u);
});
