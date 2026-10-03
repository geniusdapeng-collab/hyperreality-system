/** G01/G05 permanent adversarial regression tests; isolated Git/files only, no network or model calls. */
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { after, test } from "node:test";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, copyFileSync, existsSync, symlinkSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createBudget, normalizeBudgets } from "../acceptance/lib/live/budget.mjs";
import { fixture as liveFixture, run as liveRun } from "../acceptance/lib/live/cli-fixtures.mjs";
import { captureEvidenceRun, recordEvidenceRun, verifyRun } from "./evidence.mjs";
import { COMMAND_OBSERVATION_SCHEMA } from "../acceptance/lib/regression-evidence.mjs";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const mcd = join(repo, "scripts/delivery/mine-clear.mjs");
const coverage = join(repo, "scripts/acceptance/coverage.mjs");
const report = join(repo, "scripts/acceptance/report-v3.mjs");
const checklistPath = join(repo, "docs/acceptance/checklist.v3.json");
const checklist = JSON.parse(readFileSync(checklistPath, "utf8"));
const dirs = [];
after(() => dirs.forEach((p) => rmSync(p, { recursive: true, force: true })));
const sha = (data) => createHash("sha256").update(data).digest("hex");
const json = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 2) + "\n"); };
const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const cli = (script, cwd, args) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8", env: { ...process.env, LLM_PROVIDER: "real-fixture" } });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "evidence-controls-")); dirs.push(dir);
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.name", "Evidence Fixture"]); git(dir, ["config", "user.email", "fixture@workloom.local"]);
  writeFileSync(join(dir, "README.md"), "# fixture\n");
  writeFileSync(join(dir, ".gitignore"), "outputs/\n");
  json(join(dir, "product.manifest.json"), { schemaVersion: "workloom.product/v1", productId: "fixture" });
  json(join(dir, "acceptance/profile.json"), { schemaVersion: "workloom.acceptance-profile/v2", repo: "fixture", productName: "Fixture", dataMode: "real", environment: { kind: "deployed", target: { apiUrl: "https://fixture.invalid", pcUrl: "https://fixture.invalid" } } });
  mkdirSync(join(dir, "docs/acceptance"), { recursive: true }); copyFileSync(checklistPath, join(dir, "docs/acceptance/checklist.v3.json"));
  git(dir, ["add", "."]); git(dir, ["commit", "-qm", "fixture initial"]);
  const commit = git(dir, ["rev-parse", "HEAD"]);
  const root = join(dir, "outputs/acceptance"); mkdirSync(root, { recursive: true });
  return { dir, root, commit };
}

function artifact(f, path, value) {
  json(join(f.root, path), value);
  return { path, sha256: sha(readFileSync(join(f.root, path))), commit: f.commit };
}

// A process really runs in the isolated fixture. Its captured exit/output are then bound to receipts.
function runProof(f, { role = "acceptance", actor = "verify-session", subject = null, paths = ["proof.json"] } = {}) {
  const started_at = new Date().toISOString();
  const exec = { file: process.execPath, args: ["-e", "console.log(JSON.stringify({observed:true,pass:true}))"] };
  const command = "node -e <fixture observation>";
  const actual = spawnSync(exec.file, exec.args, { cwd: f.dir, encoding: "utf8" });
  assert.equal(actual.status, 0);
  const outputs = paths.map((p) => artifact(f, p, { ...JSON.parse(actual.stdout), checks: checklist.items.map((i) => ({ id: i.id, pass: true, expected: "fixture observation", actual: "observed" })) }));
  const body = { schema: "workloom.evidence-run/v1", id: "fixture-run", command, exec, actor, role, commit: f.commit, working_tree_dirty: false, subject, started_at, finished_at: new Date().toISOString(), exit_code: actual.status, signal: null, result: "pass", outputs };
  const runRef = artifact(f, "runs/fixture-run.json", body);
  return { ...body, runRef, artifacts: outputs };
}

function mcdFixture() {
  const f = fixture();
  const run = runProof(f, { subject: { card_id: "MC-001", assertion_index: 0 } });
  const card = {
    id: "MC-001", kind: "problem", title: "Evidence must match actual assertion", state: "verified", severity: "P0", level: "L1",
    evidence: [{ type: "code", ref: `README.md:1@${f.commit}`, sha256: sha(readFileSync(join(f.dir, "README.md"))) }],
    root_cause: { file: "README.md", line: 1, commit: f.commit }, trigger_path: "fixture observation",
    assertions: [{ kind: "sample", given: "fixture", expect: "observed true", command: run.command, exec: run.exec, last_result: "pass", evidence: run.artifacts[0], run: run.runRef }],
    regression: { command: run.command }, fixed_by: "repair-session", verified_by: run.actor, verified_at: new Date().toISOString(), verification_evidence: run.runRef,
  };
  const ledger = { schema: "workloom.mine-clear/ledger@1", task_id: "T-2026-1002-9001", repo: "fixture", repo_path: f.dir, invariants: [{ id: "INV-1", text: "Actual evidence required" }], baseline: { audit: { commit: f.commit }, repair: { commit: f.commit }, acceptance: { commit: f.commit } }, environment: { kind: "local-preview" }, cards: [card] };
  return { ...f, card, ledger, ledgerPath: join(f.root, "ledger.json"), run };
}
function gate(f, command = "gate") { json(f.ledgerPath, f.ledger); return cli(mcd, f.dir, [command, "--ledger", f.ledgerPath, "--repo", f.dir, "--json"]); }
function amendRun(f, mutate) {
  const path = join(f.root, f.run.runRef.path); const body = JSON.parse(readFileSync(path, "utf8")); mutate(body); json(path, body);
  f.run.runRef.sha256 = sha(readFileSync(path)); f.card.assertions[0].run = { ...f.run.runRef }; f.card.verification_evidence = { ...f.run.runRef };
}

function approval(f, subject, scope, actor = "product-owner") {
  const body = { schema: "workloom.evidence-approval/v1", decision: "approved", commit: f.commit, reason: "Fixture owner reviewed the evidence", approved_by: actor, approved_at: new Date().toISOString(), scope, subjects: [subject] };
  return { reason: body.reason, approved_by: body.approved_by, approved_at: body.approved_at, source: artifact(f, "approvals/owner.json", body) };
}

test("G01 valid observed pass and independent actor permit gate and handoff", () => {
  const f = mcdFixture(); assert.equal(gate(f).status, 0); assert.equal(gate(f, "handoff").status, 0);
});
for (const [name, mutate] of [
  ["N1 verified not-run", (f) => { f.card.assertions[0].last_result = "not-run"; }],
  ["N2 verified fail", (f) => { f.card.assertions[0].last_result = "fail"; }],
  ["N3 P0 fixed without verification", (f) => { f.card.state = "fixed"; }],
  ["P1 covered without verification", (f) => { f.card.severity = "P1"; f.card.state = "covered"; f.card.covered_by = f.commit; }],
  ["N4 null repair baseline", (f) => { f.ledger.baseline.repair.commit = null; }],
  ["null acceptance baseline", (f) => { f.ledger.baseline.acceptance.commit = null; }],
  ["missing artifact", (f) => { rmSync(join(f.root, "proof.json")); }],
  ["wrong artifact hash", (f) => { f.card.assertions[0].evidence.sha256 = "a".repeat(64); }],
  ["code blob hash mismatch", (f) => { f.card.evidence[0].sha256 = "b".repeat(64); }],
  ["same actor", (f) => { f.card.fixed_by = f.card.verified_by; }],
  ["reason-only waiver", (f) => { f.card.fixed_by = f.card.verified_by; f.card.waiver = { reason: "one actor available", approved_by: "owner" }; }],
  ["missing fixed actor", (f) => { delete f.card.fixed_by; }],
  ["wrong assertion command", (f) => { f.card.assertions[0].command = "changed command"; }],
  ["run command failed despite pass claim", (f) => amendRun(f, (r) => { r.exit_code = 1; r.result = "pass"; })],
  ["wrong independent role", (f) => amendRun(f, (r) => { r.role = "repair"; })],
  ["wrong card binding", (f) => amendRun(f, (r) => { r.subject.card_id = "MC-002"; })],
  ["unknown evidence commit", (f) => amendRun(f, (r) => { r.commit = "a".repeat(40); })],
  ["stale acceptance baseline", (f) => { writeFileSync(join(f.dir, "README.md"), "# new\n"); git(f.dir, ["add", "README.md"]); git(f.dir, ["commit", "-qm", "new revision"]); }],
  ["non-descendant repair baseline", (f) => { f.ledger.baseline.repair.commit = git(f.dir, ["commit-tree", `${f.commit}^{tree}`, "-m", "unrelated"]); }],
  ["dirty tested tree", (f) => { writeFileSync(join(f.dir, "README.md"), "changed uncommitted\n"); }],
  ["untracked tested code", (f) => { writeFileSync(join(f.dir, "uncommitted.mjs"), "export const changed = true;\n"); }],
  ["future verification time", (f) => { f.card.verified_at = "2099-01-01T00:00:00Z"; }],
  ["run predates its bound commit", (f) => amendRun(f, (r) => { r.started_at = "2000-01-01T00:00:00Z"; })],
  ["unknown code root cause", (f) => { f.card.root_cause.file = "missing.mjs"; }],
  ["missing actual argv", (f) => amendRun(f, (r) => { delete r.exec; })],
  ["symlink or outside evidence", (f) => { f.card.assertions[0].evidence.path = "../../README.md"; }],
  ["symlink evidence file", (f) => { rmSync(join(f.root, "proof.json")); symlinkSync(join(f.dir, "README.md"), join(f.root, "proof.json")); }],
]) test(`G01 rejects ${name}`, () => { const f = mcdFixture(); mutate(f); assert.notEqual(gate(f).status, 0, name); assert.notEqual(gate(f, "handoff").status, 0, `${name} handoff`); });

test("G01 owner-approved role waiver with source/hash/subject permits closure", () => {
  const f = mcdFixture(); f.card.fixed_by = f.card.verified_by; f.card.waiver = approval(f, f.card.id, "role-separation");
  assert.equal(gate(f).status, 0); assert.equal(gate(f, "handoff").status, 0);
});
for (const [name, mutate] of [
  ["approval by the executor", (f) => { f.card.waiver = approval(f, f.card.id, "role-separation", f.card.verified_by); }],
  ["approval for a different card", (f) => { f.card.waiver = approval(f, "MC-999", "role-separation"); }],
  ["approval for a different scope", (f) => { f.card.waiver = approval(f, f.card.id, "not-applicable"); }],
  ["approval source tampered", (f) => { writeFileSync(join(f.root, f.card.waiver.source.path), "{\"decision\":\"approved\"}\n"); }],
  ["approval reason not the source reason", (f) => { f.card.waiver.reason = "different reason"; }],
]) test(`G01 rejects ${name}`, () => {
  const f = mcdFixture(); f.card.fixed_by = f.card.verified_by; f.card.waiver = approval(f, f.card.id, "role-separation"); mutate(f);
  assert.notEqual(gate(f).status, 0);
});

test("G01 explicit runner captures repair and independent acceptance from actual process output", () => {
  const f = mcdFixture(); f.card.state = "open"; f.card.assertions[0].last_result = "not-run"; json(f.ledgerPath, f.ledger);
  const args = ["run-assertions", "--ledger", f.ledgerPath, "--card", f.card.id, "--repo", f.dir];
  const repaired = cli(mcd, f.dir, [...args, "--actor", "repair-session", "--role", "repair"]); assert.equal(repaired.status, 0, repaired.stderr);
  let ledger = JSON.parse(readFileSync(f.ledgerPath)); assert.equal(ledger.cards[0].state, "fixed"); assert.equal(ledger.baseline.acceptance.commit, null);
  const repairedRun = JSON.parse(readFileSync(join(f.root, ledger.cards[0].assertions[0].run.path))); assert.equal(repairedRun.exit_code, 0); assert.equal(repairedRun.role, "repair");
  const verified = cli(mcd, f.dir, [...args, "--actor", "independent-session", "--role", "acceptance"]); assert.equal(verified.status, 0, verified.stderr);
  ledger = JSON.parse(readFileSync(f.ledgerPath)); assert.equal(ledger.cards[0].state, "verified");
  assert.equal(cli(mcd, f.dir, ["gate", "--ledger", f.ledgerPath, "--repo", f.dir]).status, 0);
  const acceptedRun = JSON.parse(readFileSync(join(f.root, ledger.cards[0].assertions[0].run.path))); assert.equal(acceptedRun.actor, "independent-session"); assert.equal(acceptedRun.role, "acceptance");
});
for (const role of ["repair", "acceptance"]) test(`G01 ${role} rerun invalidates old green before evidence publication fails`, () => {
  const f = mcdFixture(); json(f.ledgerPath, f.ledger);
  // The process really completes, then the evidence-index read throws. The prior green
  // must already have been invalidated before this infrastructure failure occurs.
  writeFileSync(join(f.root, "evidence-index.json"), "{broken-index\n");
  const result = cli(mcd, f.dir, ["run-assertions", "--ledger", f.ledgerPath, "--card", f.card.id,
    "--actor", role === "repair" ? "repair-session" : "verify-session", "--role", role]);
  assert.equal(result.status, 2, result.stderr);
  const ledger = JSON.parse(readFileSync(f.ledgerPath));
  assert.equal(ledger.cards[0].state, "unfixed");
  assert.equal(ledger.cards[0].verified_by, null);
  assert.equal(ledger.cards[0].verified_at, null);
  assert.equal(ledger.cards[0].verification_evidence, null);
  assert.equal(ledger.cards[0].assertions[0].last_result, "not-run");
  assert.equal(ledger.baseline.acceptance.commit, null);
  for (const command of ["gate", "handoff"]) assert.notEqual(cli(mcd, f.dir, [command, "--ledger", f.ledgerPath, "--repo", f.dir]).status, 0);
});
for (const [name, exec, timeout, expected] of [
  ["failed assertion", { file: process.execPath, args: ["-e", "console.error('fixture failure');process.exit(7)"] }, "1000", 7],
  ["missing executable", { file: "/nonexistent/workloom-assertion", args: [] }, "1000", 1],
  ["timeout", { file: process.execPath, args: ["-e", "setTimeout(()=>console.log('too late'),5000)"] }, "30", 1],
]) test(`G01 explicit runner records ${name} and clears verified claim`, () => {
  const f = mcdFixture(); f.card.assertions[0].exec = exec; f.card.assertions[0].command = `fixture ${name}`; json(f.ledgerPath, f.ledger);
  const result = cli(mcd, f.dir, ["run-assertions", "--ledger", f.ledgerPath, "--card", f.card.id, "--actor", "verify-session", "--role", "acceptance", "--timeout-ms", timeout]);
  assert.equal(result.status, 1, result.stderr);
  const card = JSON.parse(readFileSync(f.ledgerPath)).cards[0]; assert.equal(card.state, "unfixed"); assert.equal(card.verified_by, null); assert.equal(card.verification_evidence, null); assert.equal(card.assertions[0].last_result, "fail");
  const proof = JSON.parse(readFileSync(join(f.root, card.assertions[0].run.path))); assert.equal(proof.exit_code, expected); assert.equal(proof.result, "fail"); assert.equal(proof.actor, "verify-session");
  assert.match(readFileSync(join(f.root, card.assertions[0].evidence.path), "utf8"), /exit_code=/);
});

test("G01 explicit runner rejects argv errors before executing a partial assertion list", () => {
  const f = mcdFixture(); f.card.state = "open"; f.card.assertions.push({ kind: "sample", given: "input", expect: "result", command: "invalid", exec: { file: "node", args: "not-an-array" } }); json(f.ledgerPath, f.ledger);
  const before = readFileSync(f.ledgerPath, "utf8");
  const result = cli(mcd, f.dir, ["run-assertions", "--ledger", f.ledgerPath, "--card", f.card.id, "--actor", "repair-session", "--role", "repair"]);
  assert.equal(result.status, 2); assert.equal(readFileSync(f.ledgerPath, "utf8"), before);
});

test("G01 capture keeps argv literal and redacts inherited secret values before persistence", () => {
  const f = fixture(); const secret = "test-only-redaction-value"; const key = "G01_FIXTURE_SECRET";
  const previous = process.env[key]; const previousHeader = process.env.GIT_CONFIG_VALUE_2; const encoded = Buffer.from(`fixture:${secret}`).toString("base64"); process.env[key] = secret; process.env.GIT_CONFIG_VALUE_2 = `Authorization: Basic ${encoded}`;
  try {
    const literal = "$(touch should-not-exist); `touch should-not-exist`";
    const run = captureEvidenceRun({ repoRoot: f.dir, artifactRoot: f.root, runId: "literal-argv", command: "synthetic argv capture", actor: "verify-session", role: "acceptance", exec: { file: process.execPath, args: ["-e", "console.log(process.argv[1]);console.log(process.env.G01_FIXTURE_SECRET);console.log(process.env.GIT_CONFIG_VALUE_2)", literal] } });
    assert.equal(run.exit_code, 0); assert.equal(existsSync(join(f.dir, "should-not-exist")), false);
    const output = readFileSync(join(f.root, run.artifacts[0].path), "utf8");
    assert.match(output, /\[REDACTED\]/); assert.equal(output.includes(secret), false); assert.equal(output.includes(encoded), false); assert.equal(output.includes(literal), true);
    for (const path of [run.runRef.path, "evidence-index.json"]) assert.equal(readFileSync(join(f.root, path), "utf8").includes(secret), false);
  } finally { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; if (previousHeader === undefined) delete process.env.GIT_CONFIG_VALUE_2; else process.env.GIT_CONFIG_VALUE_2 = previousHeader; }
});
for (const [name, flags, skipped, expectedPass] of [
  ["actually passes a Node test in the nested runner", [], false, true],
  ["rejects zero matching Node tests", ["--test-name-pattern=does-not-exist"], false, false],
  ["rejects a wholly skipped Node test suite", [], true, false],
  ["rejects an empty Node test file", [], null, false],
]) test(`G01 capture ${name}`, () => {
  const f = fixture(); const path = join(f.dir, "assertion.test.mjs");
  writeFileSync(path, skipped === null ? "export const noAssertions = true;\n" : `import { test } from 'node:test';import assert from 'node:assert/strict';test('meaningful assertion', {skip:${skipped}}, () => assert.equal(2+2,4));\n`);
  git(f.dir, ["add", "assertion.test.mjs"]); git(f.dir, ["commit", "-qm", "meaningful Node assertion fixture"]);
  const run = captureEvidenceRun({ repoRoot: f.dir, artifactRoot: f.root, runId: "actual-node-test", command: "node --test fixture", actor: "verify-session", role: "acceptance", exec: { file: process.execPath, args: ["--test", "--test-reporter=tap", ...flags, path] } });
  assert.equal(run.exit_code, 0); assert.equal(run.result, expectedPass ? "pass" : "fail");
  assert.equal(run.validation?.ok, expectedPass);
  assert.equal(run.validation?.testSummary?.passed, expectedPass ? 1 : 0);
  const proof = verifyRun(run.runRef, { artifactRoot: f.root, repoRoot: f.dir, commit: run.commit, requirePass: false }); assert.equal(proof.ok, true, proof.errors.join("；"));
  assert.equal(verifyRun(run.runRef, { artifactRoot: f.root, repoRoot: f.dir, commit: run.commit }).ok, expectedPass);
  const output = readFileSync(join(f.root, run.artifacts[0].path), "utf8"); assert.match(output, /# pass [01]/);
});
test("G01 actual Node tests pass repair, independent acceptance and gate with both requested and observed argv bound", () => {
  const f = mcdFixture(); const path = join(f.dir, "mcd-assertions.test.mjs");
  writeFileSync(path, "import {test} from 'node:test';import assert from 'node:assert/strict';test('real assertion',()=>assert.equal(2+2,4));\n"); git(f.dir, ["add", "."]); git(f.dir, ["commit", "-qm", "real assertion fixture"]);
  f.card.state = "open"; f.card.assertions[0].exec = { file: process.execPath, args: ["--test", "--test-reporter=tap", path] }; f.card.assertions[0].command = "node --test actual mcd assertions"; f.card.assertions[0].last_result = "not-run"; json(f.ledgerPath, f.ledger);
  const args = ["run-assertions", "--ledger", f.ledgerPath, "--card", f.card.id, "--repo", f.dir];
  for (const [role, actor] of [["repair", "repair-session"], ["acceptance", "independent-session"]]) { const result = cli(mcd, f.dir, [...args, "--role", role, "--actor", actor]); assert.equal(result.status, 0, result.stderr); }
  const ledger = JSON.parse(readFileSync(f.ledgerPath)); const record = JSON.parse(readFileSync(join(f.root, ledger.cards[0].assertions[0].run.path)));
  assert.deepEqual(record.requested_exec, ledger.cards[0].assertions[0].exec); assert.notDeepEqual(record.exec, record.requested_exec); assert.equal(record.validation.testSummary.passed, 1); assert.equal(record.node_observer.summary.sha256.length, 64);
  for (const command of ["gate", "handoff"]) { const result = cli(mcd, f.dir, [command, "--ledger", f.ledgerPath, "--repo", f.dir]); assert.equal(result.status, 0, result.stderr); }
});

for (const mode of ["different-bytes", "identical-copy", "missing", "symlink", "wrong-summary-destination", "same-file-alias"]) test(`G01 Node observer binds real reporter and summary file identity: ${mode}`, () => {
  const f = fixture(); const path = join(f.dir, "observer-assertion.test.mjs");
  writeFileSync(path, "import {test} from 'node:test';import assert from 'node:assert/strict';test('actual observer assertion',()=>assert.equal(2+2,4));\n");
  const trustedReporter = fileURLToPath(new URL("./node-test-reporter.mjs", import.meta.url));
  const substitute = join(f.dir, "substitute-reporter.mjs");
  if (mode === "identical-copy") copyFileSync(trustedReporter, substitute);
  else if (mode === "symlink") symlinkSync(trustedReporter, substitute);
  else writeFileSync(substitute, "export default async function* report(source){for await(const event of source){void event;}}\n");
  git(f.dir, ["add", "."]); git(f.dir, ["commit", "-qm", "actual observer identity fixture"]);
  const run = captureEvidenceRun({ repoRoot: f.dir, artifactRoot: f.root, runId: "actual-observer-identity", command: "node --test actual observer identity", actor: "verify-session", role: "acceptance", exec: { file: process.execPath, args: ["--test", path] } });
  const options = { artifactRoot: f.root, repoRoot: f.dir, commit: run.commit };
  assert.equal(run.exit_code, 0); assert.equal(run.validation.testSummary.passed, 1);
  assert.equal(verifyRun(run.runRef, options).ok, true, "the actual canonical reporter is the legal control");
  const recordPath = join(f.root, run.runRef.path); const body = JSON.parse(readFileSync(recordPath));
  if (mode === "wrong-summary-destination") {
    const old = body.node_observer.destination; const replacement = join(f.root, "other-summary.jsonl");
    copyFileSync(old, replacement); body.node_observer.destination = replacement;
    body.exec.args = body.exec.args.map((arg) => arg === `--test-reporter-destination=${old}` ? `--test-reporter-destination=${replacement}` : arg);
  } else {
    const old = body.node_observer.reporter_path;
    const replacement = mode === "missing" ? join(f.dir, "missing-reporter.mjs") : mode === "same-file-alias" ? `${dirname(old)}/../delivery/node-test-reporter.mjs` : substitute;
    body.node_observer.reporter_path = replacement;
    body.exec.args = body.exec.args.map((arg) => arg === `--test-reporter=${old}` ? `--test-reporter=${replacement}` : arg);
  }
  json(recordPath, body); const rebound = { ...run.runRef, sha256: sha(readFileSync(recordPath)) };
  const observed = verifyRun(rebound, options);
  assert.equal(observed.ok, mode === "same-file-alias", JSON.stringify({ mode, errors: observed.errors }));
});

function executableFixture() {
  const f = fixture(); const testPath = join(f.dir, "native-identity.test.mjs");
  writeFileSync(testPath, "import {test} from 'node:test';import assert from 'node:assert/strict';test('native executable assertion',()=>assert.equal(2+2,4));\n");
  const fake = join(f.dir, "node");
  // This real ordinary process forges observer output but executes no Node tests.
  writeFileSync(fake, `#!/bin/sh\ndestination=''\nmarker=''\nfor arg in "$@"; do\n case "$arg" in --test-reporter-destination=*) if [ -z "$destination" ]; then destination="\${arg#*=}"; fi;; --fixture-marker=*) marker="\${arg#*=}";; esac\ndone\nif [ -n "$marker" ]; then printf '%s\\n' 'ordinary script started' > "$marker"; fi\nprintf '%s\\n' '{"schema":"workloom.node-test-summary/v1","aggregate":true,"tests":1,"passed":1,"failed":0,"cancelled":0,"skipped":0,"todo":0,"files":1,"success":true}' > "$destination"\nprintf '%s\\n' 'forged summary; zero real Node tests'\n`, { mode: 0o755 });
  const alias = join(f.dir, "native-node-alias"); symlinkSync(process.execPath, alias);
  git(f.dir, ["add", "."]); git(f.dir, ["commit", "-qm", "actual executable identity controls"]);
  return { ...f, testPath, fake, alias };
}
for (const mode of ["fake-basename", "PATH-shadow"]) test(`G01 Node executable rejects an ordinary script before capture: ${mode}`, () => {
  const f = executableFixture(); const marker = join(f.root, "fake-started.txt"); const previousPath = process.env.PATH;
  if (mode === "PATH-shadow") process.env.PATH = `${f.dir}:${previousPath ?? ""}`;
  try {
    assert.throws(() => captureEvidenceRun({ repoRoot: f.dir, artifactRoot: f.root, runId: "reject-fake-native", command: "ordinary script cannot supply real Node test evidence", actor: "verify-session", role: "acceptance", exec: { file: mode === "fake-basename" ? f.fake : "node", args: ["--test", `--fixture-marker=${marker}`] } }), /Node.*(?:执行器|可执行|executable)/u);
    assert.equal(existsSync(marker), false, "untrusted executable must not start");
    assert.equal(existsSync(join(f.root, "runs/reject-fake-native.json")), false);
  } finally { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; }
});
for (const mode of ["canonical-path-alias", "symlink-alias"]) test(`G01 Node executable preserves real native identity and TestsStream counts: ${mode}`, () => {
  const f = executableFixture();
  const canonicalAlias = `${dirname(process.execPath)}/../${basename(dirname(process.execPath))}/${basename(process.execPath)}`;
  const run = captureEvidenceRun({ repoRoot: f.dir, artifactRoot: f.root, runId: "native-executable-alias", command: "actual native Node test alias", actor: "verify-session", role: "acceptance", exec: { file: mode === "symlink-alias" ? f.alias : canonicalAlias, args: ["--test", f.testPath] } });
  assert.equal(run.exit_code, 0); assert.equal(run.validation.testSummary.passed, 1);
  assert.match(run.node_executable?.sha256 ?? "", /^[0-9a-f]{64}$/u);
  assert.equal(verifyRun(run.runRef, { artifactRoot: f.root, repoRoot: f.dir, commit: run.commit }).ok, true);
});
for (const mode of ["rebound-fake-executable", "rebound-fake-requested-executable", "forged-native-hash", "missing-native-binding"]) test(`G01 Node executable readback rejects source-bound forgery: ${mode}`, () => {
  const f = executableFixture();
  const run = captureEvidenceRun({ repoRoot: f.dir, artifactRoot: f.root, runId: "native-readback-control", command: "actual native Node test readback", actor: "verify-session", role: "acceptance", exec: { file: process.execPath, args: ["--test", f.testPath] } });
  assert.equal(run.exit_code, 0); assert.equal(run.validation.testSummary.passed, 1);
  assert.equal(verifyRun(run.runRef, { artifactRoot: f.root, repoRoot: f.dir, commit: run.commit }).ok, true);
  const path = join(f.root, run.runRef.path); const body = JSON.parse(readFileSync(path));
  if (mode === "rebound-fake-executable") {
    body.requested_exec.file = f.fake; body.exec.file = f.fake;
    // Even a claimed real native hash cannot hide the different actual executable path.
    body.node_executable = { path: f.fake, sha256: sha(readFileSync(process.execPath)) };
  } else if (mode === "rebound-fake-requested-executable") body.requested_exec.file = f.fake;
  else if (mode === "forged-native-hash") body.node_executable = { path: process.execPath, sha256: "a".repeat(64) };
  else delete body.node_executable;
  json(path, body); const rebound = { ...run.runRef, sha256: sha(readFileSync(path)) };
  const observed = verifyRun(rebound, { artifactRoot: f.root, repoRoot: f.dir, commit: run.commit });
  assert.equal(observed.ok, false, JSON.stringify({ mode, errors: observed.errors }));
});

function fullAcceptance() {
  const f = fixture(); const run = runProof(f);
  const ref = run.artifacts[0];
  const items = checklist.items.map((i) => ({ schema: "workloom.acceptance-item/v1", ...i, status: "pass", note: "isolated synthetic observation", commit: f.commit, actor: run.actor, command: run.command, observed_at: run.finished_at, expected: "fixture observation", actual: "observed", evidence: [ref], run: run.runRef }));
  for (const i of items) json(join(f.root, "items", `${i.id}.json`), { schema: "workloom.acceptance-item/v1", ...i });
  json(join(f.root, "coverage.json"), { schemaVersion: "workloom.acceptance-coverage/v2", specVersion: checklist.specVersion, checklistSha256: sha(readFileSync(checklistPath)), commit: f.commit, items, totals: { items: items.length, byStatus: { pass: items.length }, byTier: {} }, notRunT1: [] });
  // These summary artifacts also contain actual sample counts; their bytes are captured by run outputs.
  const liveTask = { id: "fixture-task", kind: "llm", model: "fixture-model", status: "ok", selftest: false, answer: "Observed fixture answer", receipt: { kind: "model-gateway", id: "fixture-call", model: "fixture", endpoint: "https://fixture.invalid/v1/chat/completions", synced: true, verified_at: new Date().toISOString() } };
  const budget = createBudget({ budgets: normalizeBudgets().budgets, outDir: join(f.root, "live"), environmentKind: "deployed", runId: "fixture-budget" });
  assert.equal(budget.reserve({ taskId: liveTask.id, kind: "llm", tokens: 10 }).allowed, true);
  assert.equal(budget.commit({ taskId: liveTask.id, kind: "llm", tokens: 5, status: "ok", measured: true }).committed, true);
  const regressionStarted = new Date().toISOString();
  const regressionExec = { file: process.execPath, args: ["-e", "console.log(process.argv[1]);", "release:gate"] };
  const actualRegression = spawnSync(regressionExec.file, regressionExec.args, { cwd: f.dir, encoding: "utf8" }); assert.equal(actualRegression.status, 0);
  const regressionFinished = new Date().toISOString();
  artifact(f, "regression/actual-command.json", { schema: COMMAND_OBSERVATION_SCHEMA, name: "release:gate", exec: regressionExec, exit_code: actualRegression.status, signal: actualRegression.signal, started_at: regressionStarted, finished_at: regressionFinished });
  writeFileSync(join(f.root, "regression/actual-command.log"), actualRegression.stdout + actualRegression.stderr);
  const regressionRun = recordEvidenceRun({ repoRoot: f.dir, artifactRoot: f.root, runId: "actual-regression-command", command: "synthetic regression argv", exec: regressionExec, actor: "fixture-regression-session", role: "automation", startedAt: regressionStarted, finishedAt: regressionFinished, exitCode: actualRegression.status, signal: actualRegression.signal, outputPaths: ["regression/actual-command.json", "regression/actual-command.log"], subject: { commandName: "release:gate", kind: "release-gate" } });
  const regressionInputPath = join(f.root, "regression/summary-input.json"); const regressionSummaryPath = join(f.root, "regression/summary.json");
  json(regressionInputPath, { schema: "workloom.acceptance-regression-input/v1", commit: f.commit, required: ["release:gate"], executions: { "release:gate": { run: regressionRun.runRef } } });
  const aggregateStarted = new Date().toISOString();
  const aggregateExec = { file: process.execPath, args: [join(repo, "scripts/acceptance/lib/regression-evidence.mjs"), "--repo", f.dir, "--root", f.root, "--input", regressionInputPath, "--out", regressionSummaryPath] };
  const actualAggregate = spawnSync(aggregateExec.file, aggregateExec.args, { cwd: f.dir, encoding: "utf8" }); assert.equal(actualAggregate.status, 0, actualAggregate.stderr);
  const aggregateFinished = new Date().toISOString();
  writeFileSync(join(f.root, "regression/summary-process.log"), actualAggregate.stdout + actualAggregate.stderr);
  const aggregateRun = recordEvidenceRun({ repoRoot: f.dir, artifactRoot: f.root, runId: "actual-regression-summary", command: "actual synthetic regression summary", exec: aggregateExec, actor: "fixture-regression-session", role: "automation", startedAt: aggregateStarted, finishedAt: aggregateFinished, exitCode: actualAggregate.status, signal: actualAggregate.signal, outputPaths: ["regression/summary.json", "regression/summary-input.json", "regression/summary-process.log"], subject: { step: "regression-summary" } });
  const regressionSummary = JSON.parse(readFileSync(regressionSummaryPath));
  const budgetSummary = budget.persist();
  const summaries = {
    "matrix/matrix-summary.json": { counts: { agents: 1, agentsPass: 1, skills: 1, skillsPass: 1 } },
    "ui/ui-probe.json": { totals: { routesChecked: 1, routesOk: 1 }, issues: [] },
    "experience/experience-report.json": { checks: [{ id: "EXP-01", pass: true }], totals: { checks: 1, passed: 1, failed: 0 } },
    "ux/ux-report.json": { checks: [{ id: "U5-01", pass: true }, { id: "U5-02", pass: true }, { id: "U5-04", pass: true }, { id: "U5-05", pass: true }] },
    "outcome/outcome-report.json": { configured: true, falseSuccess: 0, stats: { passAtK: 1, k: 5 }, tasks: [{ id: "fixture-task", pass: true }] },
    "autonomy/autonomy-report.json": { overall: { delivered: { n: 1 } }, anomalies: { externalWithoutReceipt: 0 } },
    "redteam/redteam-report.json": { cases: [{ id: "fixture", pass: true }], findings: [] },
    "soak/soak-report.json": { samples: [{ observed: true }] },
    "regression/summary.json": regressionSummary,
    "live/receipts/fixture-task.json": { task: liveTask.id, status: liveTask.status, receipt: liveTask.receipt, artifacts: [] },
    "live/transcripts/fixture-task.json": liveTask,
    "live/budget-summary.json": budgetSummary,
    "live/live-report.json": { selftest: false, environment: { kind: "deployed", isProduction: true, allowWrites: false }, fingerprint: { repo: { commit: f.commit }, environmentKind: "deployed", targetProbe: { ok: true, checks: [{ name: "server.health", ok: true }] } }, models: [{ id: "fixture-model", kind: "llm", adapter: "model-gateway", model: "fixture", ready: true }], tasks: [liveTask], summary: { total: 1, byStatus: { ok: 1 } }, verdict: "pass", budget: budgetSummary },
  };
  const outputs = Object.entries(summaries).map(([path, value]) => artifact(f, path, path === "live/budget-summary.json" ? value : { ...value, commit: f.commit }));
  outputs.push({ path: "live/budget-ledger.jsonl", sha256: sha(readFileSync(join(f.root, "live/budget-ledger.jsonl"))), commit: f.commit });
  const runBody = { ...run, outputs: [...run.outputs, ...outputs], finished_at: new Date().toISOString() }; delete runBody.runRef; delete runBody.artifacts;
  const runRef = artifact(f, run.runRef.path, runBody);
  for (const item of items) { item.run = runRef; item.observed_at = runBody.finished_at; json(join(f.root, "items", `${item.id}.json`), item); }
  const cov = JSON.parse(readFileSync(join(f.root, "coverage.json"), "utf8")); cov.items = items; json(join(f.root, "coverage.json"), cov);
  json(join(f.root, "evidence-index.json"), { schema: "workloom.evidence-index/v1", commit: f.commit, runs: [runRef, regressionRun.runRef, aggregateRun.runRef], artifacts: [...run.outputs, ...outputs, ...regressionRun.artifacts, ...aggregateRun.artifacts] });
  return f;
}

// Keep semantic negative fixtures honestly hash-bound; rejection must not rely on a stale hash alone.
function rebindAcceptance(f, coverageInput = null, extraPaths = []) {
  const indexPath = join(f.root, "evidence-index.json"); const index = JSON.parse(readFileSync(indexPath));
  const body = JSON.parse(readFileSync(join(f.root, index.runs[0].path)));
  if (extraPaths.length) {
    body.outputs.push(...extraPaths.map((path) => ({ path, sha256: sha(readFileSync(join(f.root, path))), commit: f.commit })));
    body.finished_at = new Date().toISOString();
  }
  const oldRefs = new Map(index.artifacts.map((ref) => [ref.path, ref]));
  body.outputs = body.outputs.map((ref) => existsSync(join(f.root, ref.path)) ? { ...ref, sha256: sha(readFileSync(join(f.root, ref.path))) } : ref);
  const newRefs = new Map(body.outputs.map((ref) => [ref.path, ref]));
  const runRef = artifact(f, index.runs[0].path, body);
  const c = coverageInput ?? JSON.parse(readFileSync(join(f.root, "coverage.json")));
  for (const item of c.items) {
    item.run = runRef;
    if (extraPaths.length) item.observed_at = body.finished_at;
    item.evidence = (item.evidence ?? []).map((ref) => JSON.stringify(ref) === JSON.stringify(oldRefs.get(ref.path)) ? newRefs.get(ref.path) : ref);
  }
  json(join(f.root, "coverage.json"), c);
  for (const item of c.items) json(join(f.root, "items", `${item.id}.json`), item);
  json(indexPath, { ...index, runs: [runRef, ...index.runs.slice(1)], artifacts: body.outputs });
}

test("G05 N8a empty evidence is unverified and nonzero, with report still generated", () => {
  const f = fixture(); const result = cli(report, f.dir, ["--root", f.root]); assert.notEqual(result.status, 0);
  const summary = JSON.parse(readFileSync(join(f.root, "report-summary.json"), "utf8")); assert.equal(summary.status, "unverified"); assert.match(summary.verdict, /未验证/);
});
test("G05 N8b four sparse evidence-present claims cannot pass", () => {
  const f = fullAcceptance(); const cov = JSON.parse(readFileSync(join(f.root, "coverage.json"), "utf8")); cov.items = ["L0", "U0", "O0", "ADR"].map((layer) => ({ id: layer, layer, status: "evidence-present", evidence: ["missing.json"] })); json(join(f.root, "coverage.json"), cov);
  const livePath = join(f.root, "live/live-report.json"); const live = JSON.parse(readFileSync(livePath)); live.tasks = []; live.summary.total = 0; json(livePath, live);
  assert.notEqual(cli(report, f.dir, ["--root", f.root]).status, 0);
});
test("G05 complete legal synthetic fixture passes coverage and report (control test, no production claim)", () => {
  const f = fullAcceptance(); const c = cli(coverage, f.dir, ["--root", f.root]); assert.equal(c.status, 0, c.stderr);
  const cov = JSON.parse(readFileSync(join(f.root, "coverage.json"))); assert.equal(cov.items.length, 276); assert.equal(cov.totals.byStatus.pass, 276);
  const r = cli(report, f.dir, ["--root", f.root]);
  const index = JSON.parse(readFileSync(join(f.root, "evidence-index.json")));
  const aggregate = index.runs.map((ref) => JSON.parse(readFileSync(join(f.root, ref.path)))).find((run) => run.subject?.step === "regression-summary");
  const bindingDiagnostic = { actualArgv: aggregate?.exec?.args, expectedRepo: f.dir, expectedRoot: f.root, expectedScript: join(repo, "scripts/acceptance/lib/regression-evidence.mjs") };
  assert.equal(r.status, 0, `${r.stderr}\n${readFileSync(join(f.root, "report-summary.json"))}\n${JSON.stringify(bindingDiagnostic)}`); assert.equal(JSON.parse(readFileSync(join(f.root, "report-summary.json"))).status, "pass");
});
for (const flag of ["--repo", "--root", "--input", "--out"]) test(`G05 rejects regression aggregate ${flag} pointing to a different directory despite rebound hashes`, () => {
  const f = fullAcceptance(); const indexPath = join(f.root, "evidence-index.json"); const index = JSON.parse(readFileSync(indexPath));
  const position = index.runs.findIndex((ref) => JSON.parse(readFileSync(join(f.root, ref.path))).subject?.step === "regression-summary");
  assert.notEqual(position, -1, "The legal control must have a real captured aggregate execution");
  const runRef = index.runs[position]; const run = JSON.parse(readFileSync(join(f.root, runRef.path)));
  const argumentIndex = run.exec.args.indexOf(flag); assert.notEqual(argumentIndex, -1, `The captured aggregate must contain ${flag}`);
  const otherRoot = join(f.dir, "another-artifact-root");
  const wrongPaths = { "--repo": join(f.dir, "another-repository"), "--root": otherRoot, "--input": join(otherRoot, "regression/summary-input.json"), "--out": join(otherRoot, "regression/summary.json") };
  run.exec.args[argumentIndex + 1] = wrongPaths[flag];
  // Rebind the run and index so rejection depends on exact argv file identity,
  // rather than stale hashes or an invalid input/output suffix.
  index.runs[position] = artifact(f, runRef.path, run); json(indexPath, index);
  const result = cli(report, f.dir, ["--root", f.root]); assert.notEqual(result.status, 0, `${flag} belongs to another source/evidence directory`);
  assert.equal(JSON.parse(readFileSync(join(f.root, "report-summary.json"))).acceptancePassed, false);
});
for (const [name, mutate] of [
  ["missing required item", (f, c) => { c.items.pop(); }],
  ["duplicate checklist item", (f, c) => { c.items[1] = c.items[0]; }],
  ["forged source hash", (f, c) => { c.items[0].evidence[0].sha256 = "a".repeat(64); }],
  ["different commit", (f, c) => { c.items[0].evidence[0].commit = "a".repeat(40); }],
  ["unknown coverage commit", (f, c) => { c.commit = "unknown"; }],
  ["item schema omitted", (f, c) => { delete c.items[0].schema; }],
  ["item command omitted", (f, c) => { delete c.items[0].command; }],
  ["item expected differs from its raw observation", (f, c) => { c.items[0].expected = "forged expected"; }],
  ["item actual differs from its raw observation", (f, c) => { c.items[0].actual = "forged actual"; }],
  ["future item observation", (f, c) => { c.items[0].observed_at = "2099-01-01T00:00:00Z"; }],
  ["actual matching ID failed", (f) => { const p = join(f.root, "proof.json"); const proof = JSON.parse(readFileSync(p)); proof.checks[0].pass = false; json(p, proof); }],
  ["evidence-present without assertion pass", (f, c) => { c.items[0].status = "evidence-present"; }],
  ["unapproved not-applicable", (f, c) => { c.items[0].status = "not-applicable"; }],
  ["summary totals cannot hide missing items", (f, c) => { c.items = c.items.slice(0, 4); c.totals.items = 276; c.totals.byStatus = { pass: 276 }; }],
  ["zero production tasks", (f) => { const p = join(f.root, "live/live-report.json"); const l = JSON.parse(readFileSync(p)); l.tasks = []; l.summary.total = 0; json(p, l); }],
  ["empty ready models", (f) => { const p = join(f.root, "live/live-report.json"); const l = JSON.parse(readFileSync(p)); l.models = []; json(p, l); }],
  ["empty U checks", (f) => { json(join(f.root, "ux/ux-report.json"), { checks: [] }); }],
  ["receipt says another task", (f) => { const p = join(f.root, "live/receipts/fixture-task.json"); const l = JSON.parse(readFileSync(p)); l.task = "other-task"; json(p, l); }],
  ["receipt has future verification time", (f) => { for (const path of ["live/live-report.json", "live/receipts/fixture-task.json", "live/transcripts/fixture-task.json"]) { const p = join(f.root, path); const value = JSON.parse(readFileSync(p)); (value.tasks?.[0]?.receipt ?? value.receipt).verified_at = "2099-01-01T00:00:00Z"; json(p, value); } }],
  ["transcript lacks a real model answer", (f) => { const p = join(f.root, "live/transcripts/fixture-task.json"); const l = JSON.parse(readFileSync(p)); l.answer = ""; json(p, l); }],
  ["missing UX domain", (f) => { rmSync(join(f.root, "ux"), { force: true, recursive: true }); }],
  ["selftest production substitute", (f) => { const p = join(f.root, "live/live-report.json"); const l = JSON.parse(readFileSync(p)); l.selftest = true; json(p, l); }],
  ["artifact file removed", (f) => { rmSync(join(f.root, "proof.json")); }],
]) test(`G05 report rejects ${name}`, () => {
  const f = fullAcceptance(); const p = join(f.root, "coverage.json"); const c = JSON.parse(readFileSync(p)); mutate(f, c); rebindAcceptance(f, c);
  assert.notEqual(cli(report, f.dir, ["--root", f.root]).status, 0, name);
});

test("G05 owner-approved not-applicable item is counted explicitly, with the full 276-item denominator", () => {
  const f = fullAcceptance(); const path = join(f.root, "coverage.json"); const c = JSON.parse(readFileSync(path)); const item = c.items[0]; item.status = "not-applicable"; item.approval = approval(f, item.id, "not-applicable"); rebindAcceptance(f, c);
  const r = cli(report, f.dir, ["--root", f.root]); assert.equal(r.status, 0, r.stderr);
  const summary = JSON.parse(readFileSync(join(f.root, "report-summary.json"))); assert.equal(summary.coverage.items, 276); assert.equal(summary.coverage.byStatus["not-applicable"], 1);
});
test("G05 coverage rejects nonexistent manual evidence and cannot make 0/0 counts pass", () => {
  const f = fixture(); json(join(f.root, "manual/L0-01.json"), { id: "L0-01", pass: true, evidence: ["missing.json"] }); json(join(f.root, "matrix/matrix-summary.json"), { counts: { agents: 0, agentsPass: 0, skills: 0, skillsPass: 0 } });
  assert.notEqual(cli(coverage, f.dir, ["--root", f.root]).status, 0);
  const c = JSON.parse(readFileSync(join(f.root, "coverage.json"))); assert.equal(c.items.length, 276); assert.notEqual(c.items.find((i) => i.id === "L0-01").status, "pass");
});

function modifyBudget(f, transform) {
  const summaryPath = join(f.root, "live/budget-summary.json"); const ledgerPath = join(f.root, "live/budget-ledger.jsonl");
  const summary = JSON.parse(readFileSync(summaryPath)); const entries = readFileSync(ledgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  transform(summary, entries);
  json(summaryPath, summary); writeFileSync(ledgerPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  const livePath = join(f.root, "live/live-report.json"); const live = JSON.parse(readFileSync(livePath)); live.budget = summary; json(livePath, live);
}
for (const [name, mutate] of [
  ["budget totals forged to zero", (f) => modifyBudget(f, (b) => { for (const value of [b.used, b.actual]) for (const key of ["llmCalls", "llmTokens", "costCny"]) value[key] = 0; })],
  ["budget commit has no reservation", (f) => modifyBudget(f, (_b, entries) => { entries.splice(entries.findIndex((entry) => entry.event === "reserve"), 1); })],
  ["budget initialization missing", (f) => modifyBudget(f, (_b, entries) => { entries.shift(); })],
  ["budget future ledger event", (f) => modifyBudget(f, (_b, entries) => { entries[1].at = "2099-01-01T00:00:00Z"; })],
  ["budget estimate disagrees with frozen price", (f) => modifyBudget(f, (b, entries) => { entries[1].estimateCny = 1; b.used.costCny = 1; })],
  ["budget task settlement failed", (f) => modifyBudget(f, (b, entries) => { entries[2].status = "failed"; b.reservations[0].status = "failed"; b.reservations[0].settlement.status = "failed"; })],
  ["budget supplier measurement incomplete", (f) => modifyBudget(f, (b, entries) => { entries[2].measured = false; b.reservations[0].settlement.measured = false; b.measurementComplete = false; })],
  ["budget measurement falsely claimed complete", (f) => modifyBudget(f, (b, entries) => { entries[2].measured = false; b.reservations[0].settlement.measured = false; b.measurementComplete = true; })],
  ["budget usage-unverified freeze hidden", (f) => modifyBudget(f, (b, entries) => { entries.push({ ...entries[2], event: "usage-unverified", reason: "actual supplier usage unavailable" }); b.frozenBy = []; b.measurementComplete = true; })],
  ["budget hard cap relaxed", (f) => modifyBudget(f, (b, entries) => { b.budgets.maxLlmTokens = 999999; entries[0].budgets.maxLlmTokens = 999999; })],
  ["budget summary file missing", (f) => { rmSync(join(f.root, "live/budget-summary.json")); }],
]) test(`G05 rejects ${name} after rebinding all hashes`, () => {
  const f = fullAcceptance(); mutate(f); rebindAcceptance(f);
  const result = cli(report, f.dir, ["--root", f.root]); assert.notEqual(result.status, 0, name);
  assert.equal(JSON.parse(readFileSync(join(f.root, "report-summary.json"))).acceptancePassed, false);
});

test("G05 measured zero-output video reservation reconciles zero actual clips (synthetic arithmetic control)", () => {
  const f = fullAcceptance();
  const budgetPath = join(f.root, "live/budget-summary.json"); const original = JSON.parse(readFileSync(budgetPath));
  const budget = createBudget({ budgets: original.budgets, outDir: join(f.root, "live"), environmentKind: "deployed", runId: original.runId });
  assert.equal(budget.reserve({ taskId: "unused-video", kind: "video", units: 10 }).allowed, true);
  assert.equal(budget.commit({ taskId: "unused-video", kind: "video", units: 0, calls: 0, costCny: 0, measured: true, status: "blocked", detail: "Synthetic known unused provider attempt" }).committed, true);
  const summary = budget.persist(); assert.equal(summary.actual.videoClips, 0); assert.equal(summary.used.videoClips, 1);
  const livePath = join(f.root, "live/live-report.json"); const live = JSON.parse(readFileSync(livePath)); live.budget = summary; json(livePath, live);
  rebindAcceptance(f, null, ["live/budget-summary.json", "live/budget-ledger.jsonl"]);
  const result = cli(report, f.dir, ["--root", f.root]);
  assert.equal(result.status, 0, readFileSync(join(f.root, "report-summary.json"), "utf8"));
});

test("G05 a null raw observation becomes unverified and still produces a report", () => {
  const f = fullAcceptance(); const path = join(f.root, "proof.json"); const proof = JSON.parse(readFileSync(path)); proof.checks[0] = null; json(path, proof); rebindAcceptance(f);
  const result = cli(report, f.dir, ["--root", f.root]); assert.equal(result.status, 2, result.stderr);
  const summary = JSON.parse(readFileSync(join(f.root, "report-summary.json"))); assert.equal(summary.reportGenerated, true); assert.equal(summary.acceptancePassed, false);
});
for (const [name, path, mutate] of [
  ["outcome trials contain no objects", "outcome/outcome-report.json", (value) => { value.tasks = [null]; }],
  ["redteam cases contain no objects", "redteam/redteam-report.json", (value) => { value.cases = [null]; }],
  ["soak samples contain no objects", "soak/soak-report.json", (value) => { value.samples = [null]; }],
  ["experience checks contain null", "experience/experience-report.json", (value) => { value.checks = [null]; }],
  ["UX checks are an object", "ux/ux-report.json", (value) => { value.checks = {}; }],
  ["regression commands are an array", "regression/summary.json", (value) => { value.commands = ["通过"]; }],
]) test(`G05 malformed ${name} stays unverified and report generation survives`, () => {
  const f = fullAcceptance(); const actualPath = join(f.root, path); const value = JSON.parse(readFileSync(actualPath)); mutate(value); json(actualPath, value); rebindAcceptance(f);
  const result = cli(report, f.dir, ["--root", f.root]); assert.equal(result.status, 2, result.stderr);
  assert.equal(JSON.parse(readFileSync(join(f.root, "report-summary.json"))).reportGenerated, true);
});

test("G05 actual failed stage execution remains fail even if summary counts claim pass", () => {
  const f = fullAcceptance(); const index = JSON.parse(readFileSync(join(f.root, "evidence-index.json"))); const path = join(f.root, index.runs[0].path); const body = JSON.parse(readFileSync(path)); body.exit_code = 1; body.result = "fail"; json(path, body); rebindAcceptance(f);
  const result = cli(report, f.dir, ["--root", f.root]); assert.equal(result.status, 1, result.stderr);
  const summary = JSON.parse(readFileSync(join(f.root, "report-summary.json"))); assert.equal(summary.status, "fail"); assert.equal(summary.reportGenerated, true);
});

function withProductTask(f, kind = "tool") {
  const threadId = "synthetic-thread"; const stamp = new Date().toISOString(); const answer = "Observed business report for fixture";
  const event = kind === "tool"
    ? { event_id: "E-1", object: { id: threadId }, decision: { kind: "execute", step_id: "fixture.step" }, receipt: { synced: true, mode: "real", snapshot_uri: "https://fixture.invalid/proof", verified_at: stamp } }
    : { event_id: "E-1", object: { id: threadId }, decision: { action: "ask.answer", params: { via: "product-api" }, after: { text: answer } }, model_trace: { model_id: "fixture" } };
  const proof = kind === "tool"
    ? { type: "tool-execution", eventId: event.event_id, stepId: "fixture.step", synced: true, mode: "real", snapshot_uri: event.receipt.snapshot_uri, verified_at: stamp }
    : { type: "api-readback", eventId: event.event_id, stepId: "ask.answer", threadId, source: "https://fixture.invalid/trpc/threads.events", snapshot_uri: "https://fixture.invalid/trpc/threads.events", via: "product-api", model: "fixture", synced: true, mode: "real", verified_at: stamp };
  const eventEvidence = { source: "https://fixture.invalid/trpc/threads.events", threadId, events: [event], observedAt: stamp };
  const task = { id: "product-task", kind: "product", status: "ok", selftest: false, threadId, finalStatus: "completed", answer: kind === "tool" ? "" : answer, asserts: [{ type: kind === "tool" ? "http" : "event", target: kind === "tool" ? "https://fixture.invalid/state" : "ask.answer#decision.after.text", actual: kind === "tool" ? 200 : [answer], ok: true }], eventEvidence,
    receipt: { kind: "product-dispatch", threadId, finalStatus: "completed", synced: true, source: eventEvidence.source, verified_at: stamp, evidenceSha256: sha(JSON.stringify(eventEvidence.events)), realReceipts: [proof] }, artifacts: [] };
  const path = join(f.root, "live/live-report.json"); const live = JSON.parse(readFileSync(path)); live.tasks.push(task); live.summary.total += 1; live.summary.byStatus.ok += 1; json(path, live);
  const extra = [`live/receipts/${task.id}.json`, `live/transcripts/${task.id}.json`];
  json(join(f.root, extra[0]), { task: task.id, status: task.status, receipt: task.receipt, artifacts: task.artifacts }); json(join(f.root, extra[1]), task); rebindAcceptance(f, null, extra);
  return task;
}
function modifyProduct(f, mutate) {
  const path = join(f.root, "live/live-report.json"); const live = JSON.parse(readFileSync(path)); const task = live.tasks.find((item) => item.id === "product-task"); mutate(task); json(path, live);
  json(join(f.root, "live/receipts/product-task.json"), { task: task.id, status: task.status, receipt: task.receipt, artifacts: task.artifacts }); json(join(f.root, "live/transcripts/product-task.json"), task); rebindAcceptance(f);
}
for (const kind of ["tool", "ask"]) test(`G05 a source-bound ${kind} product event can support report evidence`, () => {
  const f = fullAcceptance(); withProductTask(f, kind); const result = cli(report, f.dir, ["--root", f.root]); assert.equal(result.status, 0, result.stderr);
});
for (const [name, kind, mutate] of [
  ["product running terminal state", "tool", (task) => { task.finalStatus = "running"; task.receipt.finalStatus = "running"; }],
  ["product event hash mismatch", "tool", (task) => { task.receipt.evidenceSha256 = "a".repeat(64); }],
  ["product receipt names absent event", "tool", (task) => { task.receipt.realReceipts[0].eventId = "E-2"; }],
  ["product execute event is mock", "tool", (task) => { task.eventEvidence.events[0].receipt.mode = "mock"; task.receipt.evidenceSha256 = sha(JSON.stringify(task.eventEvidence.events)); }],
  ["product tool event has another thread", "tool", (task) => { task.eventEvidence.events[0].object.id = "other-thread"; task.receipt.evidenceSha256 = sha(JSON.stringify(task.eventEvidence.events)); }],
  ["ASK answer differs from event", "ask", (task) => { task.answer = "different answer"; }],
  ["ASK event has another thread", "ask", (task) => { task.eventEvidence.events[0].object.id = "other-thread"; task.receipt.evidenceSha256 = sha(JSON.stringify(task.eventEvidence.events)); }],
  ["ASK has no event assertion", "ask", (task) => { task.asserts = [{ type: "http", ok: true }]; }],
  ["ASK event assertion fabricates its actual value", "ask", (task) => { task.asserts[0].actual = ["forged actual"]; }],
  ["ASK event assertion refers to an absent action", "ask", (task) => { task.asserts[0].target = "other.answer#decision.after.text"; }],
]) test(`G05 rejects ${name} after source and index hashes are rebound`, () => {
  const f = fullAcceptance(); withProductTask(f, kind); modifyProduct(f, mutate); assert.notEqual(cli(report, f.dir, ["--root", f.root]).status, 0, name);
});

for (const body of [null, false]) test(`G05 ${body} run JSON remains unverified and does not crash report generation`, () => {
  const f = fullAcceptance(); const indexPath = join(f.root, "evidence-index.json"); const index = JSON.parse(readFileSync(indexPath));
  const ref = artifact(f, index.runs[0].path, body); index.runs = [ref]; json(indexPath, index);
  const coveragePath = join(f.root, "coverage.json"); const c = JSON.parse(readFileSync(coveragePath)); for (const item of c.items) item.run = ref; json(coveragePath, c);
  const result = cli(report, f.dir, ["--root", f.root]); assert.equal(result.status, 2, result.stderr);
  assert.equal(JSON.parse(readFileSync(join(f.root, "report-summary.json"))).reportGenerated, true);
});

test("G05 indexed observations with a null check preserve the fixed denominator without crashing coverage", () => {
  const f = fullAcceptance(); rmSync(join(f.root, "items"), { recursive: true });
  const path = join(f.root, "matrix/matrix-summary.json"); const value = JSON.parse(readFileSync(path)); value.checks = [null, ...checklist.items.map((item) => ({ id: item.id, pass: true, expected: "observed", actual: "observed" }))]; json(path, value); rebindAcceptance(f); rmSync(join(f.root, "items"), { recursive: true });
  const result = cli(coverage, f.dir, ["--root", f.root]); assert.equal(result.status, 2, result.stderr);
  const c = JSON.parse(readFileSync(join(f.root, "coverage.json"))); assert.equal(c.items.length, 276); assert.equal(c.totals.byStatus.pass ?? 0, 0);
});

test("G05 real live CLI producer feeds 276-item coverage/report without turning blocked runs into production pass", (t) => {
  const f = liveFixture(t, { repo: "fixture", dataMode: "real" });
  const root = dirname(f.out); const canonical = join(f.repo, "docs/acceptance/checklist.v3.json"); mkdirSync(dirname(canonical), { recursive: true }); copyFileSync(checklistPath, canonical);
  git(f.repo, ["add", "."]); git(f.repo, ["commit", "-qm", "include canonical checklist"]);
  const live = liveRun(f); assert.equal(live.status, 2, live.stderr);
  const covered = cli(coverage, f.repo, ["--root", root]); assert.equal(covered.status, 2, covered.stderr);
  const c = JSON.parse(readFileSync(join(root, "coverage.json"))); assert.equal(c.items.length, 276); assert.equal(c.items.filter((item) => item.layer.startsWith("P")).length, 18); assert.equal(c.totals.byStatus.pass ?? 0, 0);
  const reported = cli(report, f.repo, ["--root", root]); assert.equal(reported.status, 2, reported.stderr);
  const summary = JSON.parse(readFileSync(join(root, "report-summary.json"))); assert.equal(summary.reportGenerated, true); assert.equal(summary.acceptancePassed, false); assert.equal(summary.layers.P, "未验证");
});
