#!/usr/bin/env node
/**
 * WorkLoom strict secret scanner (zero dependencies).
 *
 * Usage:
 *   node scripts/secret-scan.mjs --files AGENTS.md WORKLOOM_PRODUCT_CONTEXT.md
 *   node scripts/secret-scan.mjs --staged
 *   node scripts/secret-scan.mjs --range <base> <head>
 *   node scripts/secret-scan.mjs --self-test
 *
 * Findings intentionally contain only the rule id, file and line number. Never
 * print the matched value: scanner output is routinely copied into CI logs.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

const RULES = [
  { id: "private-key", pattern: /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/g },
  { id: "github-token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { id: "openai-key", pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}\b/g },
  { id: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { id: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: "slack-token", pattern: /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/g },
  { id: "stripe-live-key", pattern: /\b[rs]k_live_[0-9A-Za-z]{16,}\b/g },
  { id: "npm-token", pattern: /\bnpm_[A-Za-z0-9]{30,}\b/g },
  { id: "pypi-token", pattern: /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{20,}\b/g },
  { id: "gitlab-token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { id: "huggingface-token", pattern: /\bhf_[A-Za-z0-9]{30,}\b/g },
  { id: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { id: "bearer-token", pattern: /\bBearer[ \t]+[A-Za-z0-9._~+/=-]{20,}(?=$|[\s"',;])/gi },
  {
    id: "credential-in-url",
    pattern: /\b(?:https?|postgres(?:ql)?|mysql|redis|mongodb(?:\+srv)?):\/\/[^/\s:@]+:[^@\s/]{8,}@/gi,
  },
];

const SENSITIVE_NAME = "api[_-]?key|access[_-]?token|auth[_-]?token|bearer[_-]?token|refresh[_-]?token|client[_-]?secret|webhook[_-]?secret|aws[_-]?secret[_-]?access[_-]?key|secret[_-]?access[_-]?key|private[_-]?key|signing[_-]?key|database[_-]?url|connection[_-]?string|secret|token|password|passwd";
const QUOTED_ASSIGNMENT_PATTERN = new RegExp(
  `\\b(${SENSITIVE_NAME})\\b["']?\\s*(?::|=)\\s*(?:"([^"\\r\\n]+)"|'([^'\\r\\n]+)'|\`([^\`\\r\\n]+)\`)`,
  "gi",
);
// .env、shell 与 YAML 常用不带引号的字面值。只扫描“整行就是一个赋值”的
// 形式，避免把 `const token = response.token`、对象属性 `token: tokenOwner,`
// 等运行时表达式误认成秘密，同时不让 PASSWORD=真实值成为盲区。
const UNQUOTED_ASSIGNMENT_PATTERN = new RegExp(
  `^[ \\t]*(?:export[ \\t]+)?["']?(${SENSITIVE_NAME})["']?[ \\t]*(?::|=)[ \\t]*([^\\s#;,{}\\[\\]]+)[ \\t]*(?:#.*)?$`,
  "gim",
);

const SCAN_CHUNK_BYTES = 64 * 1024;
const MAX_TEXT_BYTES = 16 * 1024 * 1024;
// Provider token、JWT、Bearer、私钥头和带凭据 URL 都远小于该上限。滚动保留
// 128 KiB 可覆盖跨文件读取块的真实秘密，同时让任意大图片/归档保持恒定内存。
const HIGH_CONFIDENCE_OVERLAP_CHARS = 128 * 1024;

function lineNumberAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

function isSafePlaceholder(raw) {
  const value = raw.trim();
  const lower = value.toLowerCase();
  const bareIdentifier = value.replace(/[)\]};,:]+$/g, "");
  if (!value) return true;
  if (value.startsWith("$") || value.startsWith("<") || value.startsWith("{{")) return true;
  if (/^(?:\*+|x+|none|null|false|true)$/i.test(value)) return true;
  if (/^(?:process\.)?env[.[_]/i.test(value)) return true;
  // TypeScript 形参类型和显式环境常量不是字面凭据；provider token、JWT、URL
  // 等高置信模式仍由 RULES 独立拦截，不受此占位判断影响。
  if (/^(?:string|number|boolean|unknown|object|never)$/i.test(bareIdentifier)) return true;
  if (/^[A-Z][A-Z0-9_]*$/.test(bareIdentifier)) return true;
  return [
    "example", "sample", "placeholder", "replace-me", "replace_me", "changeme",
    "redacted", "dummy", "fake", "forged", "mock", "test-only", "not-a-token",
  ].some((marker) => lower.includes(marker));
}

function scanText(file, text) {
  const findings = [];

  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    for (const match of text.matchAll(rule.pattern)) {
      findings.push({ rule: rule.id, file, line: lineNumberAt(text, match.index ?? 0) });
    }
  }

  QUOTED_ASSIGNMENT_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(QUOTED_ASSIGNMENT_PATTERN)) {
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (value.length >= 8 && !isSafePlaceholder(value)) {
      findings.push({ rule: "literal-sensitive-assignment", file, line: lineNumberAt(text, match.index ?? 0) });
    }
  }

  UNQUOTED_ASSIGNMENT_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(UNQUOTED_ASSIGNMENT_PATTERN)) {
    const value = match[2] ?? "";
    if (value.length >= 8 && !isSafePlaceholder(value)) {
      findings.push({ rule: "literal-sensitive-assignment", file, line: lineNumberAt(text, match.index ?? 0) });
    }
  }

  const seen = new Set();
  return findings.filter((finding) => {
    const key = `${finding.rule}\u0000${finding.file}\u0000${finding.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function scanHighConfidenceText(file, text) {
  const findings = [];
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    for (const _match of text.matchAll(rule.pattern)) {
      // 二进制没有可靠的“行”语义；固定到 1，既不泄露字节内容，也能被
      // 内容摘要绑定的 acceptance manifest 精确审计。
      findings.push({ rule: rule.id, file, line: 1 });
    }
  }
  const seen = new Set();
  return findings.filter((finding) => {
    const key = `${finding.rule}\u0000${finding.file}\u0000${finding.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function printableUtf8(text) {
  // 控制字节和非法 UTF-8 必须切断片段，不能删除后把原本不相邻的字节拼成 token。
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "\n")
    .replace(/\ufffd/g, "\n");
}

/**
 * 单次顺序读取完成二进制识别与高置信扫描。小型、无 NUL 且合法 UTF-8 的
 * 文件才返回全文供 assignment 规则使用；其他文件只返回流式高置信结果。
 */
function inspectFileForScan(file, path) {
  const size = statSync(path).size;
  const digest = createHash("sha256");
  const collectText = size <= MAX_TEXT_BYTES;
  const chunks = [];
  const findings = [];
  const seenFindings = new Set();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const buffer = Buffer.allocUnsafe(SCAN_CHUNK_BYTES);
  let carry = "";
  let containsNul = false;
  const fd = openSync(path, "r");
  try {
    while (true) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      const chunk = Buffer.from(buffer.subarray(0, count));
      digest.update(chunk);
      if (chunk.includes(0)) containsNul = true;
      if (collectText) chunks.push(chunk);

      const window = carry + printableUtf8(decoder.decode(chunk, { stream: true }));
      for (const finding of scanHighConfidenceText(file, window)) {
        const key = `${finding.rule}\u0000${finding.file}\u0000${finding.line}`;
        if (!seenFindings.has(key)) {
          seenFindings.add(key);
          findings.push(finding);
        }
      }
      carry = window.slice(-HIGH_CONFIDENCE_OVERLAP_CHARS);
    }
    const tail = printableUtf8(decoder.decode());
    if (tail) {
      for (const finding of scanHighConfidenceText(file, carry + tail)) {
        const key = `${finding.rule}\u0000${finding.file}\u0000${finding.line}`;
        if (!seenFindings.has(key)) {
          seenFindings.add(key);
          findings.push(finding);
        }
      }
    }
  } finally {
    closeSync(fd);
  }
  const sha256 = digest.digest("hex");

  if (collectText && !containsNul) {
    const body = Buffer.concat(chunks);
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
      return { kind: "text", body, text, findings: [], sha256 };
    } catch { /* 非法 UTF-8 按二进制处理 */ }
  }
  return { kind: "binary", body: null, text: null, findings, sha256 };
}

function hashFile(path) {
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(SCAN_CHUNK_BYTES);
  const fd = openSync(path, "r");
  try {
    while (true) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      digest.update(buffer.subarray(0, count));
    }
  } finally {
    closeSync(fd);
  }
  return digest.digest("hex");
}

function withGitBlobFile(cwd, spec, action) {
  const temporary = mkdtempSync(join(tmpdir(), "workloom-secret-blob-"));
  const path = join(temporary, "blob");
  let output = null;
  try {
    output = openSync(path, "w", 0o600);
    let result;
    try {
      result = spawnSync("git", ["show", spec], {
        cwd,
        stdio: ["ignore", output, "pipe"],
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      });
    } finally {
      const activeOutput = output;
      output = null;
      closeSync(activeOutput);
    }
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error("unable to read required git blob");
    return action(path);
  } finally {
    if (output !== null) closeSync(output);
    rmSync(temporary, { recursive: true, force: true });
  }
}

function scanInput(file, inspected, acceptedFindings = new Set()) {
  return inspected.kind === "text"
    ? { file, text: inspected.text, acceptedFindings }
    : {
      file,
      findings: inspected.findings.map((finding) => ({ ...finding, file })),
      acceptedFindings,
    };
}

function scanInputs(inputs) {
  return inputs.flatMap(({ file, text, findings, acceptedFindings = new Set() }) => (
    (findings ?? scanText(file, text)).filter(
      (finding) => !acceptedFindings.has(`${finding.rule}\u0000${finding.line}`),
    )
  ));
}

function displayPath(path) {
  const rel = relative(process.cwd(), path);
  return rel && !rel.startsWith("..") ? rel : path;
}

function readExplicitFiles(paths) {
  if (paths.length === 0) throw new Error("--files requires at least one path");
  return paths.map((input) => {
    const path = resolve(input);
    if (!existsSync(path)) throw new Error(`required scan target is missing: ${displayPath(path)}`);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`required scan target is not a regular file: ${displayPath(path)}`);
    const file = displayPath(path);
    return scanInput(file, inspectFileForScan(file, path));
  });
}

function addedLines(file, before, after, beforePath, afterPath) {
  if (after === null) return [];
  if (before === null) return [scanInput(file, after)];
  if (before.kind !== "text" || after.kind !== "text") {
    if (before.sha256 === after.sha256) return [];
    return [scanInput(file, after)];
  }
  if (before.body.equals(after.body)) return [];

  const diff = spawnSync(
    "git",
    ["diff", "--no-index", "--no-ext-diff", "--no-color", "--unified=0", "--", beforePath, afterPath],
    { encoding: "utf8", maxBuffer: 100 * 1024 * 1024 },
  );
  if (diff.error) throw diff.error;
  // git diff --no-index uses 1 for a normal difference and >1 for an error.
  if (diff.status !== 0 && diff.status !== 1) {
    throw new Error(`unable to diff scan target ${file}`);
  }
  const ranges = [...diff.stdout.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)]
    .map((match) => ({ start: Number(match[1]), count: match[2] === undefined ? 1 : Number(match[2]) }))
    .filter(({ count }) => count > 0);
  if (ranges.length === 0) return [];
  const lines = after.text.split("\n");
  const additions = new Array(lines.length).fill("");
  for (const { start, count } of ranges) {
    for (let index = start - 1; index < Math.min(start - 1 + count, lines.length); index += 1) {
      additions[index] = lines[index];
    }
  }
  return [{ file, text: additions.join("\n") }];
}

function readDiffFile(path, label) {
  if (path === null) return null;
  if (typeof path !== "string" || !isAbsolute(path) || !existsSync(path)) {
    throw new Error(`${label} must be an existing absolute path or null`);
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular non-symlink file`);
  return inspectFileForScan(label, path);
}

function readDiffManifest(input) {
  const manifestPath = resolve(input || "");
  if (!input || !existsSync(manifestPath)) throw new Error("--diff-manifest requires an existing manifest");
  const manifestStat = lstatSync(manifestPath);
  if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
    throw new Error("--diff-manifest requires a regular non-symlink manifest");
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest?.version !== 1 || !Array.isArray(manifest.files) || manifest.files.length > 10_000) {
    throw new Error("invalid diff manifest");
  }
  return manifest.files.flatMap((entry, index) => {
    const file = entry?.file;
    if (typeof file !== "string" || !file || file.length > 1_000 || /[\0\r\n]/.test(file)) {
      throw new Error(`invalid diff manifest file label at index ${index}`);
    }
    const before = readDiffFile(entry.before ?? null, `diff manifest before path at index ${index}`);
    const after = readDiffFile(entry.after ?? null, `diff manifest after path at index ${index}`);
    if (before === null && after === null) throw new Error(`diff manifest entry ${index} has no before or after file`);
    const acceptedFindings = entry.acceptedFindings ?? [];
    if (!Array.isArray(acceptedFindings)) throw new Error(`invalid accepted findings at index ${index}`);
    if (acceptedFindings.length > 0) {
      if (after === null || !/^[0-9a-f]{64}$/.test(entry.afterSha256 ?? "")) {
        throw new Error(`accepted findings at index ${index} require an after-file SHA-256`);
      }
      const actual = after.sha256;
      if (actual !== entry.afterSha256) throw new Error(`accepted finding digest mismatch for ${file}`);
    }
    const accepted = new Set();
    for (const finding of acceptedFindings) {
      if (
        typeof finding?.rule !== "string" || !finding.rule ||
        !Number.isInteger(finding?.line) || finding.line < 1
      ) {
        throw new Error(`invalid accepted finding at index ${index}`);
      }
      const key = `${finding.rule}\u0000${finding.line}`;
      if (accepted.has(key)) throw new Error(`duplicate accepted finding at index ${index}`);
      accepted.add(key);
    }
    return addedLines(file, before, after, entry.before, entry.after)
      .map((item) => ({ ...item, acceptedFindings: accepted }));
  });
}

function readAcceptanceManifest(input) {
  const manifestPath = resolve(input || "");
  if (!input || !existsSync(manifestPath)) throw new Error("acceptance manifest must exist");
  const stat = lstatSync(manifestPath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("acceptance manifest must be a regular non-symlink file");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const scopeEntries = manifest?.acceptedBaseSecretScanFindings;
  const files = scopeEntries && typeof scopeEntries === "object" && !Array.isArray(scopeEntries)
    ? Object.entries(scopeEntries).map(([file, entry]) => ({
      file,
      afterSha256: entry?.sha256,
      acceptedFindings: entry?.findings,
      reason: entry?.reason,
    }))
    : manifest?.files;
  const requireAll = Array.isArray(manifest?.files);
  if (!Array.isArray(files) || files.length > 10_000) throw new Error("invalid acceptance manifest");
  const result = new Map();
  for (const [index, entry] of files.entries()) {
    if (
      typeof entry?.file !== "string" || !entry.file || entry.file.length > 1_000 ||
      entry.file.startsWith("/") || entry.file.split("/").some((part) => !part || part === "." || part === "..") ||
      /[\0\r\n\\]/.test(entry.file) || result.has(entry.file)
    ) {
      throw new Error(`invalid acceptance manifest file at index ${index}`);
    }
    if (!/^[0-9a-f]{64}$/.test(entry.afterSha256 ?? "") || !Array.isArray(entry.acceptedFindings) || !entry.acceptedFindings.length) {
      throw new Error(`invalid acceptance manifest entry at index ${index}`);
    }
    if (scopeEntries && (typeof entry.reason !== "string" || !entry.reason.trim())) {
      throw new Error(`scope acceptance is missing an audit reason at index ${index}`);
    }
    const acceptedFindings = new Set();
    for (const finding of entry.acceptedFindings) {
      if (typeof finding?.rule !== "string" || !finding.rule || !Number.isInteger(finding?.line) || finding.line < 1) {
        throw new Error(`invalid acceptance manifest finding at index ${index}`);
      }
      const key = `${finding.rule}\u0000${finding.line}`;
      if (acceptedFindings.has(key)) throw new Error(`duplicate acceptance manifest finding at index ${index}`);
      acceptedFindings.add(key);
    }
    result.set(entry.file, { afterSha256: entry.afterSha256, acceptedFindings });
  }
  return { entries: result, requireAll };
}

function readStagedFiles(cwd = process.cwd(), acceptance = new Map(), requireAllAcceptance = true) {
  const names = execFileSync(
    "git",
    ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"],
    { cwd, encoding: "utf8", maxBuffer: 100 * 1024 * 1024 },
  ).split("\u0000").filter(Boolean);

  const usedAcceptance = new Set();
  const inputs = names.flatMap((file) => {
    // git blob 先落入 0600 临时文件，再以固定 64 KiB 块读取；大型 PNG/归档
    // 不进入 Node 子进程缓冲区，也不会因含 NUL 而跳过高置信秘密检查。
    return withGitBlobFile(cwd, `:${file}`, (blobPath) => {
      const inspected = inspectFileForScan(file, blobPath);
      const accepted = acceptance.get(file);
      if (accepted) {
        const actual = inspected.sha256;
        if (actual !== accepted.afterSha256) throw new Error(`accepted finding digest mismatch for staged ${file}`);
        usedAcceptance.add(file);
      }
      if (inspected.kind === "binary") {
        return [scanInput(file, inspected, accepted?.acceptedFindings ?? new Set())];
      }

      // 文本只审查本次新增行；空白占位保留原始行号。二进制没有可靠行差异，
      // 因此上面的分支扫描完整新 blob，但仅启用高置信规则。
      const patch = execFileSync(
        "git",
        ["diff", "--cached", "--no-ext-diff", "--no-color", "--unified=0", "--", file],
        { cwd, encoding: "utf8", maxBuffer: 100 * 1024 * 1024 },
      );
      const ranges = [...patch.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)]
        .map((match) => ({ start: Number(match[1]), count: match[2] === undefined ? 1 : Number(match[2]) }))
        .filter(({ count }) => count > 0);
      if (ranges.length === 0) return [];
      const lines = inspected.text.split("\n");
      const additions = new Array(lines.length).fill("");
      for (const { start, count } of ranges) {
        for (let index = start - 1; index < Math.min(start - 1 + count, lines.length); index += 1) {
          additions[index] = lines[index];
        }
      }
      return [{ file, text: additions.join("\n"), acceptedFindings: accepted?.acceptedFindings ?? new Set() }];
    });
  });
  if (requireAllAcceptance) {
    for (const file of acceptance.keys()) {
      if (!usedAcceptance.has(file)) throw new Error(`accepted finding target is not staged: ${file}`);
    }
  }
  return inputs;
}

function resolveCommit(ref, cwd) {
  const sha = execFileSync(
    "git",
    ["rev-parse", "--verify", `${ref}^{commit}`],
    { cwd, encoding: "utf8" },
  ).trim();
  if (!/^[0-9a-f]{40,64}$/i.test(sha)) throw new Error(`invalid commit resolved from ${ref}`);
  return sha;
}

function readRangeFiles(base, head, cwd = process.cwd(), acceptance = new Map()) {
  const baseSha = resolveCommit(base, cwd);
  const headSha = resolveCommit(head, cwd);
  for (const [file, accepted] of acceptance) {
    withGitBlobFile(cwd, `${headSha}:${file}`, (blobPath) => {
      const actual = hashFile(blobPath);
      if (actual !== accepted.afterSha256) throw new Error(`accepted finding digest mismatch for HEAD blob ${file}`);
    });
  }
  const names = execFileSync(
    "git",
    ["diff", "--name-only", "--diff-filter=ACMR", "-z", baseSha, headSha, "--"],
    { cwd, encoding: "utf8", maxBuffer: 100 * 1024 * 1024 },
  ).split("\u0000").filter(Boolean);

  return names.flatMap((file) => {
    return withGitBlobFile(cwd, `${headSha}:${file}`, (blobPath) => {
      const inspected = inspectFileForScan(file, blobPath);
      if (inspected.kind === "binary") {
        return [scanInput(file, inspected, acceptance.get(file)?.acceptedFindings ?? new Set())];
      }
      const patch = execFileSync(
        "git",
        ["diff", "--no-ext-diff", "--no-color", "--unified=0", baseSha, headSha, "--", file],
        { cwd, encoding: "utf8", maxBuffer: 100 * 1024 * 1024 },
      );
      const ranges = [...patch.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)]
        .map((match) => ({ start: Number(match[1]), count: match[2] === undefined ? 1 : Number(match[2]) }))
        .filter(({ count }) => count > 0);
      if (ranges.length === 0) return [];
      const lines = inspected.text.split("\n");
      const additions = new Array(lines.length).fill("");
      for (const { start, count } of ranges) {
        for (let index = start - 1; index < Math.min(start - 1 + count, lines.length); index += 1) {
          additions[index] = lines[index];
        }
      }
      return [{
        file,
        text: additions.join("\n"),
        acceptedFindings: acceptance.get(file)?.acceptedFindings ?? new Set(),
      }];
    });
  });
}

function runSelfTest() {
  const dangerous = [
    "token=" + "ghp_" + "A".repeat(36),
    "api_key=" + "sk-" + "B".repeat(40),
    "password=\"" + ["correct", "horse", "battery", "staple"].join("-") + "\"",
    "PASSWORD=" + ["unquoted", "production", "credential", "value"].join("-"),
    "\"client_secret\": \"sensitive-client-secret-value-12345\"",
    "Authorization: Bearer " + "D".repeat(40),
    "-----BEGIN " + "PRIVATE KEY-----",
  ].join("\n");
  const safe = [
    "token=${{ secrets.GITHUB_TOKEN }}",
    "COMPUTER_USE_TOKEN=<strong-token>",
    "api_key=sk-example-placeholder",
    "password=mock-test-only",
    "const token = data.result?.data?.token;",
    "setSession({ accessToken: result.accessToken, refreshToken: result.refreshToken });",
    "await api('/test', { token: tokenOwner });",
    "function sign(privateKey: ReturnType<typeof createPrivateKey>): string {}",
    "  token: tokenOwner,",
  ].join("\n");

  const dangerousFindings = scanText("dangerous.md", dangerous);
  const safeFindings = scanText("safe.md", safe);
  const dangerousRules = new Set(dangerousFindings.map(({ rule }) => rule));
  if (
    !dangerousRules.has("github-token") ||
    !dangerousRules.has("openai-key") ||
    !dangerousRules.has("literal-sensitive-assignment") ||
    dangerousFindings.filter(({ rule }) => rule === "literal-sensitive-assignment").length < 2 ||
    !dangerousRules.has("bearer-token") ||
    !dangerousRules.has("private-key") ||
    safeFindings.length !== 0
  ) {
    throw new Error(`self-test failed (dangerous=${dangerousFindings.length}, safe=${safeFindings.length})`);
  }

  const repo = mkdtempSync(join(tmpdir(), "workloom-secret-scan-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: repo });
    writeFileSync(join(repo, "context.md"), "token=" + "ghp_" + "C".repeat(36) + "\n", { mode: 0o600 });
    // 普通大 PNG 只走有界高置信扫描，不应误报；秘密故意跨 64 KiB 读取边界，
    // 证明 NUL/分块都不能再绕过 provider token 检测。
    const png = Buffer.alloc(2 * 1024 * 1024, 0);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
    writeFileSync(join(repo, "ordinary.png"), png);
    const stagedToken = "ghp_" + "S".repeat(36);
    writeFileSync(join(repo, "staged-secret.bin"), Buffer.concat([
      Buffer.alloc(SCAN_CHUNK_BYTES - 2, 0),
      Buffer.from(stagedToken),
    ]));
    execFileSync("git", ["add", "--", "context.md", "ordinary.png", "staged-secret.bin"], { cwd: repo });
    const staged = readStagedFiles(repo);
    const stagedFindings = scanInputs(staged);
    if (
      staged.length !== 3 ||
      !stagedFindings.some(({ file, rule }) => file === "context.md" && rule === "github-token") ||
      !stagedFindings.some(({ file, rule }) => file === "staged-secret.bin" && rule === "github-token") ||
      stagedFindings.some(({ file }) => file === "ordinary.png")
    ) {
      throw new Error(`staged self-test failed (files=${staged.length}, findings=${stagedFindings.length})`);
    }

    const binaryRulesPath = join(repo, "binary-high-confidence.dat");
    writeFileSync(binaryRulesPath, Buffer.from([
      "\u0000", "ghp_", "P".repeat(36), "\u0000",
      "sk-", "O".repeat(40), "\u0000",
      "-----BEGIN ", "PRIVATE KEY-----", "\u0000",
      "Authorization: Bearer ", "B".repeat(40), "\u0000",
      "eyJ", "A".repeat(12), ".", "B".repeat(16), ".", "C".repeat(16), "\u0000",
      "https://release-user:", "credential-value-12345", "@example.invalid/path", "\u0000",
    ].join("")));
    const binaryRules = scanInputs([scanInput(
      "binary-high-confidence.dat",
      inspectFileForScan("binary-high-confidence.dat", binaryRulesPath),
    )]);
    const binaryRuleIds = new Set(binaryRules.map(({ rule }) => rule));
    for (const required of ["github-token", "openai-key", "private-key", "bearer-token", "jwt", "credential-in-url"]) {
      if (!binaryRuleIds.has(required)) throw new Error(`binary high-confidence self-test missed ${required}`);
    }
    if (binaryRuleIds.has("literal-sensitive-assignment")) {
      throw new Error("binary high-confidence self-test enabled low-confidence assignment scanning");
    }

    execFileSync("git", ["-c", "user.name=Secret Scan", "-c", "user.email=scan@example.invalid", "commit", "--quiet", "-m", "base"], { cwd: repo });
    const baseSha = resolveCommit("HEAD", repo);
    writeFileSync(join(repo, "context.md"), "api_key=" + "sk-" + "D".repeat(40) + "\n", { mode: 0o600 });
    writeFileSync(join(repo, "asset.bin"), Buffer.from("\u0000token=" + "ghp_" + "E".repeat(36)));
    execFileSync("git", ["add", "--", "context.md", "asset.bin"], { cwd: repo });
    execFileSync("git", ["-c", "user.name=Secret Scan", "-c", "user.email=scan@example.invalid", "commit", "--quiet", "-m", "range"], { cwd: repo });
    const headSha = resolveCommit("HEAD", repo);
    const range = readRangeFiles(baseSha, headSha, repo);
    const rangeFindings = scanInputs(range);
    if (
      range.length !== 2 ||
      !rangeFindings.some(({ file, rule }) => file === "context.md" && rule === "openai-key") ||
      !rangeFindings.some(({ file, rule }) => file === "asset.bin" && rule === "github-token")
    ) {
      throw new Error(`range self-test failed (files=${range.length}, findings=${rangeFindings.length})`);
    }
    const acceptedRangeManifest = join(repo, "range-acceptance.json");
    const rangeBody = readFileSync(join(repo, "context.md"));
    writeFileSync(acceptedRangeManifest, JSON.stringify({
      version: 1,
      files: [{
        file: "context.md",
        afterSha256: createHash("sha256").update(rangeBody).digest("hex"),
        acceptedFindings: [
          { rule: "openai-key", line: 1 },
          { rule: "literal-sensitive-assignment", line: 1 },
        ],
      }],
    }), { mode: 0o600 });
    const rangeAcceptance = readAcceptanceManifest(acceptedRangeManifest).entries;
    const acceptedRange = readRangeFiles(baseSha, headSha, repo, rangeAcceptance);
    const acceptedRangeFindings = scanInputs(acceptedRange);
    if (
      acceptedRangeFindings.length !== 1 ||
      !acceptedRangeFindings.some(({ file, rule }) => file === "asset.bin" && rule === "github-token")
    ) throw new Error("accepted range self-test suppressed an unreviewed binary token");

    writeFileSync(join(repo, "context.md"), readFileSync(join(repo, "context.md"), "utf8") + "token=" + "ghp_" + "H".repeat(36) + "\n");
    execFileSync("git", ["add", "--", "context.md"], { cwd: repo });
    execFileSync("git", ["-c", "user.name=Secret Scan", "-c", "user.email=scan@example.invalid", "commit", "--quiet", "-m", "real range finding"], { cwd: repo });
    const realRangeHead = resolveCommit("HEAD", repo);
    const realRangeBody = readFileSync(join(repo, "context.md"));
    const realRangeManifest = join(repo, "real-range-acceptance.json");
    writeFileSync(realRangeManifest, JSON.stringify({
      version: 1,
      files: [{
        file: "context.md",
        afterSha256: createHash("sha256").update(realRangeBody).digest("hex"),
        acceptedFindings: [
          { rule: "openai-key", line: 1 },
          { rule: "literal-sensitive-assignment", line: 1 },
        ],
      }],
    }), { mode: 0o600 });
    const realRange = readRangeFiles(headSha, realRangeHead, repo, readAcceptanceManifest(realRangeManifest).entries);
    const realRangeFindings = scanInputs(realRange);
    if (!realRangeFindings.some(({ rule, line }) => rule === "github-token" && line === 2)) {
      throw new Error("range accepted an unreviewed real token");
    }

    writeFileSync(join(repo, "context.md"), readFileSync(join(repo, "context.md"), "utf8") + "status=changed\n");
    execFileSync("git", ["add", "--", "context.md"], { cwd: repo });
    execFileSync("git", ["-c", "user.name=Secret Scan", "-c", "user.email=scan@example.invalid", "commit", "--quiet", "-m", "historical"], { cwd: repo });
    const historicalHead = resolveCommit("HEAD", repo);
    const historicalRange = readRangeFiles(realRangeHead, historicalHead, repo);
    const historicalFindings = scanInputs(historicalRange);
    if (historicalFindings.length !== 0) throw new Error("range rescanned unchanged historical finding");
    if (readRangeFiles(headSha, headSha, repo).length !== 0) {
      throw new Error("empty range self-test failed");
    }

    const beforePath = join(repo, "before.txt");
    const afterPath = join(repo, "after.txt");
    const newPath = join(repo, "new.txt");
    const binaryPath = join(repo, "binary.dat");
    const imagePath = join(repo, "clean-image.png");
    const historical = "password=" + ["historical", "fixture", "value"].join("-");
    writeFileSync(beforePath, `${historical}\nstatus=old\n`, { mode: 0o600 });
    writeFileSync(afterPath, `${historical}\nstatus=new\n`, { mode: 0o600 });
    writeFileSync(newPath, "token=" + "ghp_" + "F".repeat(36) + "\n", { mode: 0o600 });
    writeFileSync(binaryPath, Buffer.from("\u0000token=" + "ghp_" + "G".repeat(36)), { mode: 0o600 });
    writeFileSync(imagePath, png, { mode: 0o600 });
    const diffManifest = join(repo, "diff-manifest.json");
    writeFileSync(diffManifest, JSON.stringify({
      version: 1,
      files: [
        { file: "changed.txt", before: beforePath, after: afterPath },
        { file: "new.txt", before: null, after: newPath },
        { file: "deleted.txt", before: beforePath, after: null },
        { file: "binary.dat", before: null, after: binaryPath },
        { file: "clean-image.png", before: null, after: imagePath },
      ],
    }), { mode: 0o600 });
    const diffInputs = readDiffManifest(diffManifest);
    const diffFindings = scanInputs(diffInputs);
    if (
      diffFindings.length === 0 ||
      diffFindings.some(({ file }) => file === "changed.txt" || file === "deleted.txt" || file === "clean-image.png") ||
      !diffFindings.some(({ file, rule }) => file === "new.txt" && rule === "github-token") ||
      !diffFindings.some(({ file, rule }) => file === "binary.dat" && rule === "github-token")
    ) {
      throw new Error(`diff manifest self-test failed (inputs=${diffInputs.length}, findings=${diffFindings.length})`);
    }
    const acceptedManifest = join(repo, "accepted-diff-manifest.json");
    const newDigest = createHash("sha256").update(readFileSync(newPath)).digest("hex");
    writeFileSync(acceptedManifest, JSON.stringify({
      version: 1,
      files: [{
        file: "new.txt",
        before: null,
        after: newPath,
        afterSha256: newDigest,
        acceptedFindings: [
          { rule: "github-token", line: 1 },
          { rule: "literal-sensitive-assignment", line: 1 },
        ],
      }],
    }), { mode: 0o600 });
    const acceptedInputs = readDiffManifest(acceptedManifest);
    const acceptedResults = scanInputs(acceptedInputs);
    if (acceptedResults.length !== 0) throw new Error("accepted diff manifest self-test failed");
    writeFileSync(newPath, readFileSync(newPath, "utf8") + "changed\n", { mode: 0o600 });
    let digestMismatch = false;
    try {
      readDiffManifest(acceptedManifest);
    } catch (error) {
      digestMismatch = /digest mismatch/.test(String(error?.message));
    }
    if (!digestMismatch) throw new Error("accepted diff digest mismatch self-test failed");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
  console.log("secret-scan self-test: PASS");
}

function usage() {
  console.error("usage: secret-scan.mjs --files <path...> | --diff-manifest <path> | --staged [--acceptance-manifest <path>] | --range <base> <head> [--acceptance-manifest <path>] | --self-test");
  process.exitCode = 64;
}

const args = process.argv.slice(2);
try {
  if (args.length === 1 && args[0] === "--self-test") {
    runSelfTest();
  } else {
    let inputs;
    if (args[0] === "--files") inputs = readExplicitFiles(args.slice(1));
    else if (args.length === 2 && args[0] === "--diff-manifest") inputs = readDiffManifest(args[1]);
    else if (args.length === 1 && args[0] === "--staged") inputs = readStagedFiles();
    else if (args.length === 3 && args[0] === "--staged" && args[1] === "--acceptance-manifest") {
      const acceptance = readAcceptanceManifest(args[2]);
      inputs = readStagedFiles(process.cwd(), acceptance.entries, acceptance.requireAll);
    }
    else if (args.length === 3 && args[0] === "--range") inputs = readRangeFiles(args[1], args[2]);
    else if (args.length === 5 && args[0] === "--range" && args[3] === "--acceptance-manifest") {
      inputs = readRangeFiles(args[1], args[2], process.cwd(), readAcceptanceManifest(args[4]).entries);
    }
    else {
      usage();
      process.exit();
    }

    const findings = scanInputs(inputs);
    if (findings.length > 0) {
      console.error(`secret-scan: BLOCKED (${findings.length} finding(s); values suppressed)`);
      for (const finding of findings) console.error(`[${finding.rule}] ${finding.file}:${finding.line}`);
      process.exitCode = 1;
    } else {
      console.log(`secret-scan: PASS (${inputs.length} scan target(s))`);
    }
  }
} catch (error) {
  console.error(`secret-scan: ERROR (${error instanceof Error ? error.message : "unknown error"})`);
  process.exitCode = 2;
}
