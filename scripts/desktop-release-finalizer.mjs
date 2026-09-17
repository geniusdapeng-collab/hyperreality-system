#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CHECKSUM_NAME = "WorkLoom-SHA512SUMS.txt";
export const RELEASE_MANIFEST_NAME = "WorkLoom-release-manifest.json";
export const PLATFORM_MANIFEST_NAMES = Object.freeze({
  macos: "desktop-macos-manifest.json",
  windows: "desktop-windows-manifest.json",
});

const TAG_PATTERN = /^v\d+\.\d+\.\d+$/u;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const SAFE_FILE_PATTERN = /^[^/\\\r\n\0]+$/u;

function fail(message) {
  throw new Error(message);
}

function sha512(path) {
  return createHash("sha512").update(readFileSync(path)).digest("hex");
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${basename(path)} 不是有效 JSON：${error.message}`);
  }
}

function normalizeIdentity({ tag, sha, platformSigning, repository }) {
  if (!TAG_PATTERN.test(tag ?? "")) fail("tag 必须是 vMAJOR.MINOR.PATCH 稳定版本");
  if (!SHA_PATTERN.test(sha ?? "")) fail("sha 必须是 40 位小写提交摘要");
  if (!new Set(["signed", "unsigned"]).has(platformSigning)) {
    fail("platform-signing 只能是 signed 或 unsigned");
  }
  if (!REPOSITORY_PATTERN.test(repository ?? "")) fail("repository 必须是 owner/repository");
  return { tag, sha, platformSigning, repository };
}

function assetRecord(path, name = basename(path)) {
  if (!SAFE_FILE_PATTERN.test(name) || name === "." || name === "..") fail(`不安全的资产名：${name}`);
  const size = statSync(path).size;
  if (size <= 0) fail(`${name} 不能为空`);
  return { name, size, sha512: sha512(path) };
}

function topLevelFiles(directory) {
  if (!existsSync(directory) || !statSync(directory).isDirectory()) fail(`目录不存在：${directory}`);
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
}

function expectedPlatformNames(platform, names) {
  const patterns = platform === "macos"
    ? [/-mac-arm64\.dmg$/u, /-mac-x64\.dmg$/u]
    : [/-win-x64\.exe$/u];
  if (!PLATFORM_MANIFEST_NAMES[platform]) fail("platform 只能是 macos 或 windows");
  const selected = patterns.map((pattern) => {
    const matches = names.filter((name) => pattern.test(name));
    if (matches.length !== 1) fail(`${platform} 必须且只能有一个 ${pattern} 安装包，实际 ${matches.length} 个`);
    return matches[0];
  });
  if (new Set(selected).size !== selected.length) fail(`${platform} 安装包名称不唯一`);
  return selected;
}

function assertManifestIdentity(manifest, identity, label) {
  if (
    manifest?.schemaVersion !== 1
    || manifest.product !== identity.repository
    || manifest.tag !== identity.tag
    || manifest.sha !== identity.sha
    || manifest.platformSigning !== identity.platformSigning
  ) {
    fail(`${label} 的仓库、tag、SHA 或签名模式与本次发布不一致`);
  }
}

function assertAssetRecords(directory, manifest, expectedNames, label) {
  if (!Array.isArray(manifest.assets) || manifest.assets.length !== expectedNames.length) {
    fail(`${label} 的资产记录数量不正确`);
  }
  for (const name of expectedNames) {
    const rows = manifest.assets.filter((asset) => asset?.name === name);
    if (rows.length !== 1) fail(`${label} 中 ${name} 的记录必须唯一`);
    const actual = assetRecord(join(directory, name), name);
    if (rows[0].size !== actual.size || rows[0].sha512 !== actual.sha512) {
      fail(`${label} 中 ${name} 的大小或 sha512 不匹配`);
    }
  }
}

function copyUnique(source, destination) {
  mkdirSync(resolve(destination, ".."), { recursive: true });
  try {
    copyFileSync(source, destination, constants.COPYFILE_EXCL);
  } catch (error) {
    fail(`拒绝覆盖候选资产 ${basename(destination)}：${error.message}`);
  }
}

export function sealPlatform({ platform, releaseDir, outputDir, ...rawIdentity }) {
  const identity = normalizeIdentity(rawIdentity);
  const source = resolve(releaseDir);
  const output = resolve(outputDir);
  mkdirSync(output, { recursive: true });
  if (topLevelFiles(output).length !== 0) fail(`候选目录必须为空：${output}`);

  const names = expectedPlatformNames(platform, topLevelFiles(source));
  for (const name of names) copyUnique(join(source, name), join(output, name));
  const manifest = {
    schemaVersion: 1,
    product: identity.repository,
    platform,
    tag: identity.tag,
    sha: identity.sha,
    platformSigning: identity.platformSigning,
    assets: names.map((name) => assetRecord(join(output, name), name)),
  };
  writeFileSync(join(output, PLATFORM_MANIFEST_NAMES[platform]), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export function assembleRelease({ macDir, windowsDir, outputDir, ...rawIdentity }) {
  const identity = normalizeIdentity(rawIdentity);
  const roots = { macos: resolve(macDir), windows: resolve(windowsDir) };
  const output = resolve(outputDir);
  mkdirSync(output, { recursive: true });
  if (topLevelFiles(output).length !== 0) fail(`最终资产目录必须为空：${output}`);

  const installerNames = [];
  for (const platform of ["macos", "windows"]) {
    const manifestName = PLATFORM_MANIFEST_NAMES[platform];
    const manifest = readJson(join(roots[platform], manifestName));
    assertManifestIdentity(manifest, identity, manifestName);
    if (manifest.platform !== platform) fail(`${manifestName} 平台身份不正确`);
    const names = expectedPlatformNames(platform, topLevelFiles(roots[platform]));
    assertAssetRecords(roots[platform], manifest, names, manifestName);
    for (const name of names) {
      if (installerNames.includes(name)) fail(`跨平台安装包重名：${name}`);
      copyUnique(join(roots[platform], name), join(output, name));
      installerNames.push(name);
    }
  }

  const assets = installerNames.map((name) => assetRecord(join(output, name), name));
  const releaseManifest = {
    schemaVersion: 1,
    product: identity.repository,
    tag: identity.tag,
    sha: identity.sha,
    platformSigning: identity.platformSigning,
    assets,
  };
  writeFileSync(join(output, RELEASE_MANIFEST_NAME), `${JSON.stringify(releaseManifest, null, 2)}\n`);
  writeFileSync(
    join(output, CHECKSUM_NAME),
    `${assets.map((asset) => `${asset.sha512}  ${asset.name}`).join("\n")}\n`,
  );
  verifyRelease({ directory: output, ...identity });
  return releaseManifest;
}

export function verifyRelease({ directory, ...rawIdentity }) {
  const identity = normalizeIdentity(rawIdentity);
  const root = resolve(directory);
  const names = topLevelFiles(root).sort();
  const manifest = readJson(join(root, RELEASE_MANIFEST_NAME));
  assertManifestIdentity(manifest, identity, RELEASE_MANIFEST_NAME);
  const installerNames = [
    ...expectedPlatformNames("macos", names),
    ...expectedPlatformNames("windows", names),
  ];
  const expected = [...installerNames, CHECKSUM_NAME, RELEASE_MANIFEST_NAME].sort();
  if (names.length !== 5 || JSON.stringify(names) !== JSON.stringify(expected)) {
    fail(`正式 Release 必须精确包含三份安装包和两份证据，实际：${names.join(", ")}`);
  }
  assertAssetRecords(root, manifest, installerNames, RELEASE_MANIFEST_NAME);
  const checksumLines = readFileSync(join(root, CHECKSUM_NAME), "utf8").trimEnd().split("\n");
  if (checksumLines.length !== installerNames.length) fail("SHA512SUMS 必须精确记录三份安装包");
  for (const name of installerNames) {
    const digest = sha512(join(root, name));
    if (checksumLines.filter((line) => line === `${digest}  ${name}`).length !== 1) {
      fail(`SHA512SUMS 中 ${name} 的记录缺失或不唯一`);
    }
  }
  return manifest;
}

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      fail(`参数必须使用 --name value：${key ?? "<missing>"}`);
    }
    const name = key.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
    if (Object.hasOwn(options, name)) fail(`参数重复：${key}`);
    options[name] = value;
  }
  return options;
}

export function runCli(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const options = parseOptions(rest);
  if (command === "seal-platform") return sealPlatform(options);
  if (command === "assemble") return assembleRelease(options);
  if (command === "verify") return verifyRelease(options);
  fail("用法：desktop-release-finalizer.mjs seal-platform|assemble|verify [--name value ...]");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = runCli();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`❌ ${error.message}\n`);
    process.exitCode = 1;
  }
}
