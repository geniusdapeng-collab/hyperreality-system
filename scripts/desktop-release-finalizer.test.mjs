import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CHECKSUM_NAME,
  RELEASE_MANIFEST_NAME,
  assembleRelease,
  sealPlatform,
  verifyRelease,
} from "./desktop-release-finalizer.mjs";

const identity = {
  tag: "v1.2.3",
  sha: "a".repeat(40),
  platformSigning: "unsigned",
  repository: "workloom-ai/example-industry",
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workloom-release-finalizer-"));
  const macRelease = join(root, "mac release");
  const winRelease = join(root, "windows release");
  const macCandidate = join(root, "mac candidate");
  const winCandidate = join(root, "windows candidate");
  const output = join(root, "final");
  for (const directory of [macRelease, winRelease]) mkdirSync(directory, { recursive: true });
  writeFileSync(join(macRelease, "行业 产品-mac-arm64.dmg"), "mac-arm64\n");
  writeFileSync(join(macRelease, "行业 产品-mac-x64.dmg"), "mac-x64\n");
  writeFileSync(join(macRelease, "builder-debug.yml"), "ignored\n");
  writeFileSync(join(winRelease, "行业 产品-win-x64.exe"), "windows\n");
  writeFileSync(join(winRelease, "builder-effective-config.yaml"), "ignored\n");
  return { root, macRelease, winRelease, macCandidate, winCandidate, output };
}

test("discovers existing product artifact names and assembles exactly five public assets", () => {
  const paths = fixture();
  sealPlatform({ platform: "macos", releaseDir: paths.macRelease, outputDir: paths.macCandidate, ...identity });
  sealPlatform({ platform: "windows", releaseDir: paths.winRelease, outputDir: paths.winCandidate, ...identity });
  const manifest = assembleRelease({
    macDir: paths.macCandidate,
    windowsDir: paths.winCandidate,
    outputDir: paths.output,
    ...identity,
  });

  assert.equal(manifest.product, identity.repository);
  assert.deepEqual(manifest.assets.map((asset) => asset.name), [
    "行业 产品-mac-arm64.dmg",
    "行业 产品-mac-x64.dmg",
    "行业 产品-win-x64.exe",
  ]);
  assert.deepEqual(
    readdirSync(paths.output).sort(),
    [
      "行业 产品-mac-arm64.dmg",
      "行业 产品-mac-x64.dmg",
      "行业 产品-win-x64.exe",
      CHECKSUM_NAME,
      RELEASE_MANIFEST_NAME,
    ].sort(),
  );
  assert.equal(verifyRelease({ directory: paths.output, ...identity }).sha, identity.sha);
  assert.equal(readFileSync(join(paths.output, CHECKSUM_NAME), "utf8").trimEnd().split("\n").length, 3);
});

test("fails closed on duplicate architecture candidates", () => {
  const paths = fixture();
  writeFileSync(join(paths.macRelease, "second-mac-arm64.dmg"), "duplicate\n");
  assert.throws(
    () => sealPlatform({ platform: "macos", releaseDir: paths.macRelease, outputDir: paths.macCandidate, ...identity }),
    /必须且只能有一个/u,
  );
});

test("fails closed when a candidate is tampered with after sealing", () => {
  const paths = fixture();
  sealPlatform({ platform: "macos", releaseDir: paths.macRelease, outputDir: paths.macCandidate, ...identity });
  sealPlatform({ platform: "windows", releaseDir: paths.winRelease, outputDir: paths.winCandidate, ...identity });
  writeFileSync(join(paths.winCandidate, "行业 产品-win-x64.exe"), "tampered\n");
  assert.throws(
    () => assembleRelease({
      macDir: paths.macCandidate,
      windowsDir: paths.winCandidate,
      outputDir: paths.output,
      ...identity,
    }),
    /大小或 sha512 不匹配/u,
  );
});

test("fails closed when platform candidates belong to another tag", () => {
  const paths = fixture();
  sealPlatform({ platform: "macos", releaseDir: paths.macRelease, outputDir: paths.macCandidate, ...identity });
  sealPlatform({
    platform: "windows",
    releaseDir: paths.winRelease,
    outputDir: paths.winCandidate,
    ...identity,
    tag: "v1.2.4",
  });
  assert.throws(
    () => assembleRelease({
      macDir: paths.macCandidate,
      windowsDir: paths.winCandidate,
      outputDir: paths.output,
      ...identity,
    }),
    /与本次发布不一致/u,
  );
});

test("public verification rejects extra or missing assets", () => {
  const paths = fixture();
  sealPlatform({ platform: "macos", releaseDir: paths.macRelease, outputDir: paths.macCandidate, ...identity });
  sealPlatform({ platform: "windows", releaseDir: paths.winRelease, outputDir: paths.winCandidate, ...identity });
  assembleRelease({ macDir: paths.macCandidate, windowsDir: paths.winCandidate, outputDir: paths.output, ...identity });
  writeFileSync(join(paths.output, "unexpected.txt"), "no\n");
  assert.throws(() => verifyRelease({ directory: paths.output, ...identity }), /精确包含/u);
});
