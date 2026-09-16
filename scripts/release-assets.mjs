#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MANIFEST_URL = new URL("./release-assets.json", import.meta.url);
const SHA256_RE = /^[a-f0-9]{64}$/;

export function loadReleaseAssets() {
  const manifest = JSON.parse(readFileSync(MANIFEST_URL, "utf8"));
  if (manifest.schemaVersion !== 1 || manifest.algorithm !== "sha256") {
    throw new Error("release asset manifest schema/algorithm is unsupported");
  }
  if (!manifest.assets || typeof manifest.assets !== "object") {
    throw new Error("release asset manifest has no assets map");
  }
  for (const [name, entry] of Object.entries(manifest.assets)) {
    if (!name || name.includes("/") || !SHA256_RE.test(entry?.sha256 ?? "")) {
      throw new Error(`invalid release asset manifest entry: ${name}`);
    }
    if (typeof entry.upstream !== "string" || !entry.upstream.startsWith("https://")) {
      throw new Error(`release asset has no HTTPS provenance: ${name}`);
    }
  }
  const pgvector = manifest.sourcePins?.pgvector;
  if (
    pgvector?.version !== "v0.8.6" ||
    pgvector?.repository !== "https://github.com/pgvector/pgvector.git" ||
    !/^[a-f0-9]{40}$/.test(pgvector?.commit ?? "")
  ) {
    throw new Error("pgvector source pin is invalid");
  }
  const windowsPg = manifest.sourcePins?.windowsPostgresqlBuild;
  if (
    windowsPg?.chocolateyPackage !== "postgresql17" ||
    !/^17\.2\.0$/.test(windowsPg?.chocolateyVersion ?? "") ||
    windowsPg?.chocolateySource !== "https://community.chocolatey.org/api/v2" ||
    windowsPg?.pgConfigVersion !== "PostgreSQL 17.2" ||
    windowsPg?.requireChecksums !== true
  ) {
    throw new Error("Windows PostgreSQL build pin is invalid");
  }
  return manifest;
}

export function expectedAssetSha256(assetName) {
  const entry = loadReleaseAssets().assets[assetName];
  if (!entry) throw new Error(`release asset is not pinned: ${assetName}`);
  return entry.sha256;
}

export function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export async function verifyAssetFile(filePath, assetName) {
  const expected = expectedAssetSha256(assetName);
  const actual = await sha256File(filePath);
  if (actual !== expected) {
    throw new Error(`SHA-256 mismatch for ${assetName}: expected ${expected}, got ${actual}`);
  }
  return actual;
}

export function verifyWindowsPgProvenance(filePath) {
  const manifest = loadReleaseAssets();
  const text = readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  const values = Object.fromEntries(
    text.split(/\r?\n/).filter(Boolean).map((line) => {
      const separator = line.indexOf("=");
      if (separator <= 0) throw new Error(`invalid Windows PG provenance line: ${line}`);
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
  );
  const pg = manifest.sourcePins.windowsPostgresqlBuild;
  const vector = manifest.sourcePins.pgvector;
  const expected = {
    postgresql_chocolatey_package: pg.chocolateyPackage,
    postgresql_chocolatey_version: pg.chocolateyVersion,
    postgresql_chocolatey_source: pg.chocolateySource,
    pg_config_version: pg.pgConfigVersion,
    pgvector_version: vector.version,
    pgvector_commit: vector.commit,
  };
  if (Object.keys(values).length !== Object.keys(expected).length) {
    throw new Error("Windows PG provenance field set does not match the release lock");
  }
  for (const [key, value] of Object.entries(expected)) {
    if (values[key] !== value) {
      throw new Error(`Windows PG provenance mismatch for ${key}`);
    }
  }
  return expected;
}

async function main() {
  const [command, filePath, assetName] = process.argv.slice(2);
  if (command === "verify-windows-pg-provenance" && filePath && !assetName) {
    try {
      verifyWindowsPgProvenance(filePath);
      console.log(`✓ Windows PG provenance ${filePath}`);
    } catch (error) {
      console.error(`❌ ${error.message}`);
      process.exitCode = 1;
    }
    return;
  }
  if (command !== "verify" || !filePath || !assetName) {
    console.error("usage: node scripts/release-assets.mjs verify <file> <asset-name> | verify-windows-pg-provenance <file>");
    process.exitCode = 2;
    return;
  }
  try {
    const digest = await verifyAssetFile(filePath, assetName);
    console.log(`✓ SHA-256 ${assetName} ${digest}`);
  } catch (error) {
    console.error(`❌ ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
