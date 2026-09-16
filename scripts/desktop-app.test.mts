import assert from "node:assert/strict";
import { createServer } from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  buildElectronEnvironment,
  createSmokeSupportDirectory,
  ElectronExecutableMissingError,
  portBusy,
  resolveElectronExecutable,
  resolveSourceWorkspace,
} from "./desktop-app.mts";

function write(path: string, content = "") {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function electronPackage(pathEntry: string) {
  const root = mkdtempSync(join(tmpdir(), "workloom-electron-path-test-"));
  const packageRoot = join(root, "node_modules/electron");
  const executable = join(packageRoot, "dist", pathEntry);
  write(join(packageRoot, "path.txt"), `${pathEntry}\n`);
  write(executable, "binary");
  chmodSync(executable, 0o755);
  return { root, packageRoot, executable };
}

for (const [platform, pathEntry] of [
  ["macOS", "Electron.app/Contents/MacOS/Electron"],
  ["Windows", "electron.exe"],
  ["Linux", "electron"],
] as const) {
  test(`${platform} 按 Electron 官方 path.txt 解析真实二进制`, () => {
    const fx = electronPackage(pathEntry);
    try {
      assert.equal(resolveElectronExecutable(fx.packageRoot), realpathSync(fx.executable));
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });
}

test("缺少 path.txt 或二进制时只报告未下载", () => {
  const fx = electronPackage("electron");
  try {
    rmSync(join(fx.packageRoot, "path.txt"));
    assert.throws(() => resolveElectronExecutable(fx.packageRoot), ElectronExecutableMissingError);
    write(join(fx.packageRoot, "path.txt"), "electron\n");
    rmSync(fx.executable);
    assert.throws(() => resolveElectronExecutable(fx.packageRoot), ElectronExecutableMissingError);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("path.txt 越界、path.txt symlink 与二进制 symlink 均 fail closed", () => {
  const escaped = electronPackage("electron");
  try {
    write(join(escaped.packageRoot, "path.txt"), "../outside\n");
    assert.throws(() => resolveElectronExecutable(escaped.packageRoot), /内容非法|逃逸出 dist/u);
  } finally {
    rmSync(escaped.root, { recursive: true, force: true });
  }

  const linkedManifest = electronPackage("electron");
  try {
    const external = join(linkedManifest.root, "external-path.txt");
    write(external, "electron\n");
    rmSync(join(linkedManifest.packageRoot, "path.txt"));
    symlinkSync(external, join(linkedManifest.packageRoot, "path.txt"));
    assert.throws(() => resolveElectronExecutable(linkedManifest.packageRoot), /path\.txt 必须是普通文件/u);
  } finally {
    rmSync(linkedManifest.root, { recursive: true, force: true });
  }

  const linkedBinary = electronPackage("electron");
  try {
    const external = join(linkedBinary.root, "external-bin");
    write(external, "outside\n");
    rmSync(linkedBinary.executable);
    symlinkSync(external, linkedBinary.executable);
    assert.throws(() => resolveElectronExecutable(linkedBinary.packageRoot), /不允许 symlink/u);
  } finally {
    rmSync(linkedBinary.root, { recursive: true, force: true });
  }
});

test("Node 端口探测识别已有进程且不关闭或杀死它", async () => {
  const occupied = createServer();
  await new Promise<void>((resolve, reject) => {
    occupied.once("error", reject);
    occupied.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = occupied.address();
    assert.ok(address && typeof address === "object");
    assert.equal(await portBusy(address.port), true);
    assert.equal(occupied.listening, true);
  } finally {
    await new Promise<void>((resolve, reject) => occupied.close((error) => error ? reject(error) : resolve()));
  }
});

test("Node 端口探测在 macOS 无 ss 的环境仍可识别空闲端口", async () => {
  const allocator = createServer();
  await new Promise<void>((resolve, reject) => {
    allocator.once("error", reject);
    allocator.listen(0, "127.0.0.1", resolve);
  });
  const address = allocator.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) => allocator.close((error) => error ? reject(error) : resolve()));
  assert.equal(await portBusy(port), false);
});

test("端口探测器自身异常时按占用 fail closed", async () => {
  assert.equal(await portBusy(8787, () => { throw new Error("probe unavailable"); }), true);
  assert.equal(await portBusy(Number.NaN), true);
});

test("Electron 源码环境精确映射端口、源码上下文与隔离 userData", () => {
  const env = buildElectronEnvironment({
    environment: {
      KEEP: "yes",
      WORKLOOM_RESOURCES: "/tmp/stale-packaged-payload",
      WORKLOOM_WEB_URL: "http://wrong:1",
      WORKLOOM_SERVER_URL: "http://wrong:2",
      WORKLOOM_RENDER_SMOKE: "1",
    },
    webPort: 44173,
    serverPort: 48787,
    sourceRoot: "/tmp/source-root",
    sourceNode: "/tmp/source-node",
    supportDir: "/tmp/isolated-user-data",
    smoke: true,
  });
  assert.equal(env.KEEP, "yes");
  assert.equal(env.WEB_PORT, "44173");
  assert.equal(env.SERVER_PORT, "48787");
  assert.equal(env.WORKLOOM_WEB_PORT, "44173");
  assert.equal(env.WORKLOOM_SERVER_PORT, "48787");
  assert.equal(env.WORKLOOM_SOURCE_MODE, "1");
  assert.equal(env.WORKLOOM_SOURCE_ROOT, "/tmp/source-root");
  assert.equal(env.WORKLOOM_SOURCE_NODE, "/tmp/source-node");
  assert.equal(env.WORKLOOM_RESOURCES, undefined);
  assert.equal(env.WORKLOOM_SUPPORT_DIR, "/tmp/isolated-user-data");
  assert.equal(env.WORKLOOM_APP_SMOKE, "1");
  assert.equal(env.WORKLOOM_RENDER_SMOKE, "0");
  assert.equal(env.WORKLOOM_WEB_URL, undefined);
  assert.equal(env.WORKLOOM_SERVER_URL, undefined);
});

test("冒烟 support/userData 每次唯一且成功或失败收尾都可幂等清理", () => {
  const parent = mkdtempSync(join(tmpdir(), "workloom-smoke-support-test-"));
  try {
    const first = createSmokeSupportDirectory(parent);
    const second = createSmokeSupportDirectory(parent);
    assert.notEqual(first.root, second.root);
    assert.notEqual(first.supportDir, second.supportDir);
    write(join(first.supportDir, "success.txt"), "temporary\n");
    write(join(second.supportDir, "failure.txt"), "temporary\n");
    first.cleanup();
    first.cleanup();
    second.cleanup();
    second.cleanup();
    assert.equal(existsSync(first.root), false);
    assert.equal(existsSync(second.root), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("干净源码工作区无需 dist-payload 即可解析启动入口", () => {
  const root = mkdtempSync(join(tmpdir(), "workloom-clean-source-test-"));
  try {
    write(join(root, "package.json"), "{}\n");
    write(join(root, "apps/server/src/index.ts"), "export {};\n");
    write(join(root, "apps/web/package.json"), "{}\n");
    write(join(root, "apps/desktop/electron/main.cjs"), "'use strict';\n");
    assert.equal(existsSync(join(root, "dist-payload")), false);
    assert.equal(existsSync(join(root, "dist-payload.tar.gz")), false);
    assert.equal(resolveSourceWorkspace(root), realpathSync(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
