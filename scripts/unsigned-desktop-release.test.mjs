import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflow = fs.readFileSync(path.join(root, ".github/workflows/build-desktop.yml"), "utf8");
const builder = fs.readFileSync(path.join(root, "electron-builder.yml"), "utf8");
const product = JSON.parse(fs.readFileSync(path.join(root, "product.manifest.json"), "utf8"));
const runtimeMetadata = JSON.parse(fs.readFileSync(path.join(root, ".workloom-runtime-deps/metadata.json"), "utf8"));

test("正式发布只允许手动派发并默认显式选择 unsigned", () => {
  assert.doesNotMatch(workflow, /push:\s*[\s\S]{0,80}tags:/u);
  assert.match(workflow, /workflow_dispatch:[\s\S]*release_sha:[\s\S]*platform_signing:/u);
  assert.match(workflow, /platform_signing:[\s\S]*type: choice[\s\S]*unsigned[\s\S]*signed[\s\S]*default: unsigned/u);
  assert.match(workflow, /VERSION: \$\{\{ needs\.preflight\.outputs\.release-tag \}\}/u);
  assert.match(workflow, /PLATFORM_SIGNING: \$\{\{ needs\.preflight\.outputs\.platform-signing \}\}/u);
  assert.match(workflow, /if \[ "\$PLATFORM_SIGNING" = "signed" \]; then/u);
});

test("预检把稳定 tag、release_sha、dispatch SHA 与当前 main 精确绑定", () => {
  for (const marker of [
    'test "$DISPATCH_REF" = "refs/heads/main"',
    'test "$DISPATCH_SHA" = "$RELEASE_SHA"',
    '/commits/main',
    '/git/ref/tags/$RELEASE_TAG',
    'test "$MAIN_SHA" = "$RELEASE_SHA"',
    'test "$OBJECT_SHA" = "$RELEASE_SHA"',
    'ref: ${{ needs.preflight.outputs.release-sha }}',
  ]) {
    assert.ok(workflow.includes(marker), `缺少发布身份绑定：${marker}`);
  }
});

test("正式发布并发、工具链与 Action 供应链全部锁定", () => {
  for (const marker of [
    "group: desktop-production-release",
    "cancel-in-progress: false",
    "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
    "pnpm/action-setup@fc06bc1257f339d1d5d8b3a19a8cae5388b55320",
    "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
    "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
  ]) {
    assert.ok(workflow.includes(marker), `缺少正式发布锁定项：${marker}`);
  }
  assert.equal(workflow.match(/node-version: 24\.19\.0/gu)?.length, 2);
  assert.equal(workflow.match(/test "\$\(npm --version\)" = "11\.17\.0"/gu)?.length, 2);
  assert.equal(runtimeMetadata.npmVersion, "11.17.0");
  const floatingActions = workflow.match(/uses:\s+[^\s]+@(v\d+|main|master)\b/gu) ?? [];
  assert.deepEqual(floatingActions, ["uses: actions/download-artifact@v4", "uses: actions/download-artifact@v4"], "仅 canonical publisher 的双候选下载保留基座模板引用");
});

test("平台未签名模式不削弱 Bundle Ed25519 信任链", () => {
  assert.match(workflow, /BUNDLE_SIGNING_PRIVATE_KEY/u);
  assert.match(workflow, /test -n "\$BUNDLE_SIGNING_PRIVATE_KEY"/u);
  assert.match(workflow, /pnpm bundle:release/u);
  assert.match(workflow, /build\/bundle-trust\.json/u);
  assert.match(builder, /from: build\/bundle-trust\.json[\s\S]*to: bundle-trust\.json/u);
});

test("signed 与 unsigned 平台校验边界清晰", () => {
  assert.match(workflow, /MAC_CSC_LINK/u);
  assert.match(workflow, /APPLE_APP_SPECIFIC_PASSWORD/u);
  assert.match(workflow, /WIN_CSC_LINK/u);
  assert.match(workflow, /codesign --verify --deep --strict/u);
  assert.match(workflow, /xcrun stapler validate/u);
  assert.match(workflow, /Get-AuthenticodeSignature/u);
  assert.equal(workflow.match(/CSC_IDENTITY_AUTO_DISCOVERY: "false"/gu)?.length, 3);
  assert.equal(workflow.match(/if: needs\.preflight\.outputs\.platform-signing == 'signed'/gu)?.length, 3);
  assert.equal(workflow.match(/if: needs\.preflight\.outputs\.platform-signing == 'unsigned'/gu)?.length, 3);
  assert.doesNotMatch(workflow, /(?:CSC_LINK|CSC_KEY_PASSWORD|APPLE_ID|APPLE_APP_SPECIFIC_PASSWORD|APPLE_TEAM_ID|WIN_CSC_LINK|WIN_CSC_KEY_PASSWORD)=\s/u);
  assert.match(workflow, /-c\.mac\.notarize=false/u);
});

test("平台任务只封存同 run/attempt 候选，唯一 publisher 原子发布五资产", () => {
  assert.match(builder, /artifactName: "HyperReality\.System-\$\{os\}-\$\{arch\}\.\$\{ext\}"/u);
  assert.match(workflow, /--mac dmg --arm64/u);
  assert.match(workflow, /--mac dmg --x64/u);
  assert.match(workflow, /--win nsis --x64/u);
  assert.equal(workflow.match(/node scripts\/desktop-release-finalizer\.mjs seal-platform/gu)?.length, 2);
  for (const marker of [
    'desktop-macos-candidate-${{ github.run_id }}-${{ github.run_attempt }}',
    'desktop-windows-candidate-${{ github.run_id }}-${{ github.run_attempt }}',
    'WorkLoom-SHA512SUMS.txt',
    'WorkLoom-release-manifest.json',
    '--draft --latest=false',
    'gh release upload "$RELEASE_TAG"',
    'node "$FINALIZER" verify',
    '--draft=false --latest=true',
    'isLatest,isImmutable',
    'cmp -s "$asset" "$REMOTE_DIR/$name"',
    'for attempt in $(seq 1 12)',
    'resolve_remote_tag()',
    '未做 Apple/Windows 平台代码签名',
    'SmartScreen',
  ]) {
    assert.ok(workflow.includes(marker), `缺少原子发布契约：${marker}`);
  }
  assert.equal(workflow.match(/contents: write/gu)?.length, 1, "只能有一个 contents:write publisher");
  assert.equal(workflow.match(/compression-level: 0/gu)?.length, 2, "双平台候选都必须禁用重复压缩");
  assert.doesNotMatch(workflow, /issues: write|gh issue create/u);
  assert.doesNotMatch(workflow, /softprops\/action-gh-release/u);
  const publisher = workflow.slice(workflow.indexOf("\n  publish-desktop-release:"));
  assert.doesNotMatch(publisher, /actions\/checkout/u);
  assert.doesNotMatch(publisher, /node scripts\//u);
});

test("Release 标题与当前仓库、稳定 tag 绑定", () => {
  assert.ok(workflow.includes('--title "${GITHUB_REPOSITORY#*/} $RELEASE_TAG"'));
});

test("唯一 publisher 与基座 PR30 canonical 模板逐字节同源", () => {
  const marker = "  # WorkLoom 下游桌面正式发行的唯一写入 job 模板。";
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1);
  const publisher = `${workflow.slice(start).split("\n").map((line) => line.startsWith("  ") ? line.slice(2) : line).join("\n")}`;
  assert.equal(createHash("sha256").update(publisher).digest("hex"), "e9065a08afc698696430e8a8c3c2607e6019c23812fa673559ac7981e7e41bc0");
});

test("桌面产品身份、端口和签名配置与产品清单一致", () => {
  assert.equal(product.release.artifactPrefix, product.displayName);
  assert.ok(builder.includes(`appId: ${product.release.appId}`));
  assert.ok(builder.includes(`productName: ${product.displayName}`));
  assert.ok(builder.includes(`workloomPortOffset: ${product.desktop.portOffset}`));
  for (const marker of [
    "hardenedRuntime: true",
    "notarize: true",
    "entitlements: build/entitlements.mac.plist",
  ]) {
    assert.ok(builder.includes(marker), `缺少 ${marker}`);
  }
});

test("全新 runner 在 Web 构建前先生成行业契约产物", () => {
  const buildPairs = workflow.match(/pnpm -C packages\/industry-contract build\s+pnpm -C apps\/web build/gu) ?? [];
  assert.equal(buildPairs.length, 2, "macOS 与 Windows 发行任务都必须先构建行业契约");
  assert.equal(workflow.match(/pnpm projections:generate/gu)?.length, 2);
  assert.equal(workflow.match(/pnpm projections:check/gu)?.length, 2);
});

test("Windows 候选冒烟隔离端口、支持目录并完整留存三段诊断", () => {
  for (const marker of [
    'WORKLOOM_PG_PORT: "55432"',
    'WORKLOOM_SERVER_PORT: "58787"',
    'WORKLOOM_WEB_PORT: "55173"',
    'WORKLOOM_NATS_PORT: "54222"',
    'SMOKE_ROOT="$RUNNER_TEMP/wl-smoke"',
    'APP_SMOKE_ROOT="$RUNNER_TEMP/wl-app-smoke"',
    'RENDER_SMOKE_ROOT="$RUNNER_TEMP/wl-render-default"',
    '${{ runner.temp }}/wl-smoke/logs/*',
    '${{ runner.temp }}/wl-smoke/install-state.json',
    '${{ runner.temp }}/wl-app-smoke/logs/*',
    '${{ runner.temp }}/wl-app-smoke/install-state.json',
    '${{ runner.temp }}/wl-render-default/logs/*',
    '${{ runner.temp }}/wl-render-default/install-state.json',
    '锁定源安装 17.11.0',
  ]) {
    assert.ok(workflow.includes(marker), `缺少 Windows 发行契约：${marker}`);
  }
  assert.equal(workflow.includes('${TEMP}/wl-'), false);
  assert.equal(workflow.includes('$env:TEMP\\wl-smoke'), false);
});
