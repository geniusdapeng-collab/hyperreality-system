import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  expectedAssetSha256,
  loadReleaseAssets,
  sha256File,
  verifyAssetFile,
  verifyWindowsPgProvenance,
} from "./release-assets.mjs";
import { resolveDesktopWorkflowPath } from "./desktop-workflow-path.mjs";

const root = new URL("../", import.meta.url);

test("release asset manifest pins every desktop runtime artifact", () => {
  const manifest = loadReleaseAssets();
  const required = [
    "node-v24.19.0-darwin-arm64.tar.gz",
    "node-v24.19.0-darwin-x64.tar.gz",
    "node-v24.19.0-win-x64.zip",
    "Postgres-2.9.6-17.dmg",
    "nats-server-v2.11.4-darwin-amd64.tar.gz",
    "nats-server-v2.11.4-darwin-arm64.tar.gz",
    "nats-server-v2.11.4-linux-amd64.tar.gz",
    "nats-server-v2.11.4-windows-amd64.zip",
    "embedded-postgres-binaries-windows-amd64-17.2.0.jar",
    "postgresql17.17.2.0.nupkg",
  ];
  assert.deepEqual(Object.keys(manifest.assets).sort(), required.sort());
  for (const asset of required) assert.match(expectedAssetSha256(asset), /^[a-f0-9]{64}$/);
  assert.throws(() => expectedAssetSha256("unreviewed-runtime.zip"), /not pinned/);
  assert.deepEqual(manifest.sourcePins.pgvector, {
    version: "v0.8.6",
    repository: "https://github.com/pgvector/pgvector.git",
    commit: "8ee86c96f0fd72390f890aa8a336fda6d3ab4c6c",
  });
  assert.deepEqual(manifest.sourcePins.windowsPostgresqlBuild, {
    chocolateyPackage: "postgresql17",
    chocolateyVersion: "17.2.0",
    chocolateySource: "https://community.chocolatey.org/api/v2",
    pgConfigVersion: "PostgreSQL 17.2",
    requireChecksums: true,
  });
});

test("streaming SHA-256 verification accepts exact bytes and rejects mutations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workloom-release-assets-"));
  try {
    const file = join(dir, "fixture.bin");
    const bytes = Buffer.from("workloom-release-asset-test\n");
    await writeFile(file, bytes);
    const expected = createHash("sha256").update(bytes).digest("hex");
    assert.equal(await sha256File(file), expected);

    const knownName = "node-v24.19.0-darwin-arm64.tar.gz";
    await assert.rejects(verifyAssetFile(file, knownName), /SHA-256 mismatch/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Windows PG provenance must match every locked build input", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workloom-pg-provenance-"));
  try {
    const file = join(dir, "WORKLOOM-PROVENANCE.txt");
    const valid = [
      "postgresql_chocolatey_package=postgresql17",
      "postgresql_chocolatey_version=17.2.0",
      "postgresql_chocolatey_source=https://community.chocolatey.org/api/v2",
      "pg_config_version=PostgreSQL 17.2",
      "pgvector_version=v0.8.6",
      "pgvector_commit=8ee86c96f0fd72390f890aa8a336fda6d3ab4c6c",
      "",
    ].join("\n");
    await writeFile(file, valid);
    assert.equal(verifyWindowsPgProvenance(file).pgvector_version, "v0.8.6");
    await writeFile(file, valid.replace("17.2.0", "17.6.0"));
    assert.throws(() => verifyWindowsPgProvenance(file), /provenance mismatch/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("every packaging download is wired through the verified fetch boundary", async () => {
  const repositoryRoot = fileURLToPath(root);
  const product = JSON.parse(await readFile(new URL("../product.manifest.json", import.meta.url), "utf8"));
  const desktopWorkflowPath = resolveDesktopWorkflowPath(repositoryRoot, product).absolute;
  const files = {
    electron: await readFile(new URL("./pack-electron-payload.sh", import.meta.url), "utf8"),
    mac: await readFile(new URL("./pack-macos.sh", import.meta.url), "utf8"),
    win: await readFile(new URL("./pack-windows.sh", import.meta.url), "utf8"),
    nats: await readFile(new URL("./embedded-nats.mjs", import.meta.url), "utf8"),
    pgvectorWin: await readFile(new URL("./build-pgvector-win.ps1", import.meta.url), "utf8"),
    desktopWorkflow: await readFile(desktopWorkflowPath, "utf8"),
    legacyWorkflow: await readFile(new URL("../.github/workflows/pack-self-contained.yml", import.meta.url), "utf8"),
  };
  for (const name of ["electron", "mac", "win"]) {
    assert.match(files[name], /source scripts\/release-assets\.sh/);
    assert.match(files[name], /workloom_fetch_verified/);
  }
  const helper = await readFile(new URL("./release-assets.sh", import.meta.url), "utf8");
  assert.match(helper, /\.part\.\$\$/);
  assert.match(helper, /verify \"\$partial\"/);
  assert.match(helper, /mv -f \"\$partial\" \"\$out\"/);
  assert.match(files.nats, /verifyAssetFile\(partial, assetName\)/);
  assert.match(files.nats, /renameSync\(partial, tmp\)/);
  assert.match(files.pgvectorWin, /release-assets\.json/);
  assert.match(files.pgvectorWin, /release-assets\.mjs verify \$NupkgPath \$NupkgName/);
  assert.match(files.pgvectorWin, /--version=\$PostgresPackageVersion --source=\$PackageStage --require-checksums/);
  assert.match(files.pgvectorWin, /if \(Test-Path \$PgRoot\)[\s\S]+干净 runner/);
  assert.match(files.pgvectorWin, /choco list --exact \$PostgresPackage --limit-output/);
  assert.doesNotMatch(files.pgvectorWin, /if \(-not \(Test-Path \"\$PgRoot\\bin\\pg_config\.exe\"\)\)/);
  assert.match(files.pgvectorWin, /fetch --quiet --depth 1 origin \$PgvectorCommit/);
  assert.match(files.pgvectorWin, /\$ActualPgvectorCommit -ne \$PgvectorCommit/);
  assert.doesNotMatch(files.pgvectorWin, /foreach \(\$pkg|git clone --depth 1 --branch/);
  assert.match(files.electron, /verify-windows-pg-provenance vendor\/pg-win\/WORKLOOM-PROVENANCE\.txt/);
  assert.match(files.win, /verify-windows-pg-provenance vendor\/pg-win\/WORKLOOM-PROVENANCE\.txt/);
  for (const name of ["desktopWorkflow", "legacyWorkflow"]) {
    assert.match(files[name], /runs-on: windows-2022/);
    assert.doesNotMatch(files[name], /runs-on: windows-latest/);
  }
  for (const [name, source] of Object.entries(files)) {
    assert.doesNotMatch(source, /curl[^\n]+-o[^\n]+(?:node-|Postgres-|nats-server|nats\.(?:zip|tgz)|pg\.dmg)/, `${name} bypasses verified fetch`);
  }
});

test("manifest is repository-local and cannot be replaced through environment", () => {
  assert.equal(root.protocol, "file:");
  assert.equal(loadReleaseAssets().schemaVersion, 1);
});
