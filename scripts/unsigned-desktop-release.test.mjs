import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflow = fs.readFileSync(path.join(root, ".github/workflows/build-desktop.yml"), "utf8");
const builder = fs.readFileSync(path.join(root, "electron-builder.yml"), "utf8");
const product = JSON.parse(fs.readFileSync(path.join(root, "product.manifest.json"), "utf8"));

test("tag 发布明确选择平台未签名，手动发布默认保留 signed 路径", () => {
  assert.match(workflow, /platform_signing:[\s\S]*type: choice[\s\S]*signed[\s\S]*unsigned[\s\S]*default: signed/u);
  assert.match(workflow, /PLATFORM_SIGNING:.*workflow_dispatch.*inputs\.platform_signing.*unsigned/u);
  assert.match(workflow, /if \[ "\$PLATFORM_SIGNING" = "signed" \]; then/u);
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
  assert.match(workflow, /CSC_IDENTITY_AUTO_DISCOVERY=false/u);
  assert.match(workflow, /CSC_LINK= CSC_KEY_PASSWORD=/u);
  assert.match(workflow, /WIN_CSC_LINK= WIN_CSC_KEY_PASSWORD=/u);
  assert.match(workflow, /-c\.mac\.notarize=false/u);
});

test("Release 同时交付三个固定命名平台制品并披露安装风险", () => {
  assert.match(builder, /artifactName: "\$\{productName\}-\$\{os\}-\$\{arch\}\.\$\{ext\}"/u);
  assert.match(workflow, /--mac dmg --arm64/u);
  assert.match(workflow, /--mac dmg --x64/u);
  assert.match(workflow, /--win nsis --x64/u);
  assert.match(workflow, /未做 Apple\/Windows 平台代码签名/u);
  assert.match(workflow, /xattr -cr/u);
  assert.match(workflow, /SmartScreen/u);
  assert.match(workflow, /body_path: release-notes\.md/u);
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
    '$env:RUNNER_TEMP',
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
