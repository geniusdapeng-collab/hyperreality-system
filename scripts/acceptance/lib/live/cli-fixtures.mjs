/** Isolated, committed fixture repositories for real CLI tests; credentials are synthetic. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../../../../", import.meta.url));
const closure = ["scripts/acceptance/live.mjs", "scripts/acceptance/lib/profile.mjs", "scripts/acceptance/lib/target.mjs", "scripts/acceptance/lib/playwright.mjs", "scripts/delivery/evidence.mjs", ...["assertions", "audit.plugin", "budget", "checks", "media", "providers", "stub-provider", "test-fixtures", "usage", "verification"].map((name) => `scripts/acceptance/lib/live/${name}.mjs`)];
export const model = { id: "synthetic-model", kind: "llm", model: "synthetic-model", adapter: "model-gateway", apiKeyEnv: "SYNTHETIC_API_KEY", baseUrlEnv: "SYNTHETIC_BASE_URL" };
export const llm = { id: "LLM-R1", kind: "llm", model: model.id, chain: "model-gateway", title: "synthetic reasoning", prompt: "synthetic", expect: ["STUB"] };
export function fixture(t, overrides = {}) {
  const repo = mkdtempSync(join(tmpdir(), "workloom-live-cli-")); t.after(() => rmSync(repo, { recursive: true, force: true }));
  for (const path of closure) { mkdirSync(dirname(join(repo, path)), { recursive: true }); copyFileSync(join(source, path), join(repo, path)); }
  const profile = { schemaVersion: "workloom.acceptance-profile/v2", productName: "Synthetic", lane: "base", environment: { kind: "local-preview", timeouts: { healthMs: 50, probeMs: 50 } }, startup: { ports: { pc: 1, bMobile: 1, cMobile: 1, server: 1 } }, live: { enabled: true, models: [model], tasks: [llm] }, ...overrides };
  writeFileSync(join(repo, "product.manifest.json"), "{}\n"); writeFileSync(join(repo, "package.json"), JSON.stringify({ type: "module" })); writeFileSync(join(repo, ".gitignore"), "/outputs/\n");
  mkdirSync(join(repo, "acceptance")); writeFileSync(join(repo, "acceptance/profile.json"), `${JSON.stringify(profile)}\n`);
  for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=Synthetic Test", "-c", "user.email=synthetic@example.invalid", "commit", "-qm", "synthetic fixture"]]) {
    const git = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }); assert.equal(git.status, 0, git.stderr);
  }
  return { repo, out: join(repo, "outputs/acceptance/live") };
}
export function run(f, flags = [], extraEnv = {}, { timeoutMs = 60_000 } = {}) {
  // The committed temporary repo contains source only. Resolve browser packages
  // from this test's installed root without copying dependencies or ambient keys.
  const nodePath = [...new Set([join(source, "node_modules"), ...[process.env.NODE_PATH, extraEnv.NODE_PATH].flatMap((value) => typeof value === "string" ? value.split(delimiter).filter(Boolean) : [])])].join(delimiter);
  return spawnSync(process.execPath, [join(f.repo, "scripts/acceptance/live.mjs"), "--out", f.out, "--no-auto-keys", "--no-keys-from-client", ...flags], { cwd: f.repo, encoding: "utf8", timeout: timeoutMs, maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: tmpdir(), ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH } : {}), ...extraEnv, NODE_PATH: nodePath } });
}
export const report = (f) => JSON.parse(readFileSync(join(f.out, "live-report.json"), "utf8"));
