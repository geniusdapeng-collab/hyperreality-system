/** Acceptance-only DSH audit bridge and per-request budget waterfall. */
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, constants, existsSync, fsyncSync, lstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createBudget } from "./budget.mjs";
import { normalizeDshUsage } from "./usage.mjs";

export const name = "workloom-live-audit";
export const inject = ["llm"];
const SCHEMA = "workloom.live-dsh-audit/v1";
const canonical = (value) => value === null || typeof value !== "object" ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
const digest = (value) => createHash("sha256").update(value).digest("hex");
const number = (value) => Number.isSafeInteger(value) && value >= 0;
function ordinaryFile(file) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o444) === 0 || (stat.mode & 0o222) === 0) throw new Error("DSH 审计必须是独立、可读写普通文件");
  if (stat.size > 32 * 1024 * 1024) throw new Error("DSH 审计超过读取上限，不能假定没有截断");
}
function records(file) {
  ordinaryFile(file);
  const text = readFileSync(file, "utf8");
  if (text && !text.endsWith("\n")) throw new Error("DSH 审计尾部不完整");
  let previous = "GENESIS"; const seen = new Set();
  return text.split("\n").filter(Boolean).map((line) => {
    const row = JSON.parse(line);
    const event = row.ev;
    if (row.schema !== SCHEMA || !event || typeof event.sessionId !== "string" || !event.sessionId || !number(event.seq) || row.id !== `${event.sessionId}:${event.seq}` || seen.has(row.id) || row.prev !== previous || row.hash !== digest(previous + canonical(event))) throw new Error("DSH 审计链/事件身份/哈希不完整");
    seen.add(row.id); previous = row.hash; return row;
  });
}
export function readDshAudit(file) {
  try {
    const rows = records(file);
    if (!rows.length) throw new Error("DSH 审计没有实际事件");
    return { ok: true, lines: rows.length, events: rows.map((row) => row.ev), redacted: rows.some((row) => row.ev.auditRedacted === true), head: rows.at(-1).hash };
  } catch (error) {
    return { ok: false, lines: 0, events: [], redacted: false, reason: error instanceof Error ? error.message : "DSH 审计读取异常" };
  }
}

export function apply(ctx, config = {}) {
  if (typeof config.file !== "string" || typeof config.budgetConfigFile !== "string") throw new Error("验收 DSH audit 缺少 file/budgetConfigFile");
  const options = JSON.parse(readFileSync(config.budgetConfigFile, "utf8"));
  const file = resolve(config.file); const rel = relative(resolve(options.outDir), file);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`) || typeof options.taskId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(options.taskId) || !number(options.expectedTokens) || options.expectedTokens === 0) throw new Error("验收 DSH audit 配置/任务身份/占额 token 无效");
  const budget = createBudget(options);
  const restored = existsSync(file) ? records(file) : [];
  const seen = new Map(restored.map((row) => [row.id, canonical(row.ev)]));
  let previous = restored.at(-1)?.hash ?? "GENESIS";
  let fatal = restored.some((row) => row.ev.auditRedacted === true) ? "DSH 事件需要脱敏，不能作为成功证据" : null;
  let sequence = 0;
  const redact = (value) => {
    const secrets = Object.entries(process.env).filter(([key, secret]) => /API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY/iu.test(key) && typeof secret === "string" && secret.length >= 4).map(([, secret]) => secret);
    let changed = false;
    const walk = (item) => {
      if (typeof item === "string") { const clean = secrets.reduce((text, secret) => text.split(secret).join("[REDACTED]"), item); changed ||= clean !== item; return clean; }
      if (Array.isArray(item)) return item.map(walk);
      if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, child]) => [walk(key), walk(child)]));
      return item;
    };
    return { value: walk(value), changed };
  };
  // v0.2.0-rc.2 passes (Session, SessionEvent); hashing Session itself would lose usage.
  ctx.on("session/event", (session, event) => {
    try {
      if (typeof session?.id !== "string" || !session.id || typeof event?.type !== "string" || !number(event.seq)) throw new Error("DSH session/event 缺少 Session/Event 双参数身份");
      const clean = redact(JSON.parse(JSON.stringify({ ...event, sessionId: session.id })));
      const ev = { ...clean.value, ...(clean.changed ? { auditRedacted: true } : {}) };
      const id = `${ev.sessionId}:${ev.seq}`; const payload = canonical(ev);
      if (seen.has(id)) { if (seen.get(id) !== payload) throw new Error("DSH 事件身份复用但内容不同"); return; }
      if (existsSync(file)) ordinaryFile(file);
      const hash = digest(previous + payload);
      const fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
      try { appendFileSync(fd, `${JSON.stringify({ schema: SCHEMA, id, prev: previous, hash, ev })}\n`); fsyncSync(fd); } finally { closeSync(fd); }
      seen.set(id, payload); previous = hash;
      if (clean.changed) fatal = "DSH 事件含凭据，已在落盘前脱敏，不能作为成功证据";
    } catch (error) {
      fatal = error instanceof Error ? error.message : "DSH audit observer 异常";
      throw error;
    }
  });
  ctx.on("llm/stream", async function* (request, next) {
    if (fatal) throw new Error(fatal);
    if (options.expectedModel && request?.model !== options.expectedModel && !(options.allowedModels ?? []).includes(request?.model)) throw new Error("DSH 模型路由不在预声明允许名单，尚未调用 provider");
    const reservationId = `${options.taskId}:dsh:${++sequence}`;
    const gate = budget.reserve({ taskId: options.taskId, reservationId, kind: "llm", tokens: options.expectedTokens, detail: "dsh-harness 每次真实请求（含重试）" });
    if (!gate.allowed || gate.duplicate) throw new Error(gate.reason ?? "DSH 请求占额已使用，禁止重复付费调用");
    let sample = null; let unsafe = false; let ended = false; let finish = false; let failure = null;
    try {
      for await (const chunk of next()) {
        if (chunk?.type === "usage") { sample = normalizeDshUsage(chunk.usage); if (!sample) unsafe = true; }
        if (chunk?.type === "finish") finish = true;
        yield chunk;
      }
      ended = true;
    } catch (error) { failure = error; }
    finally {
      const measured = ended && finish && sample !== null && !unsafe;
      const settled = budget.commit({ taskId: options.taskId, reservationId, kind: "llm", tokens: measured ? sample.totalTokens : 0, measured, status: measured && !failure ? "ok" : "blocked", detail: measured ? "DSH provider 真实 usage" : "DSH stream 结束/usage 未验证，按预占保守持有并冻结后续调用" });
      if (!settled.committed || settled.exceeded.length) failure = new Error(settled.reason ?? `DSH 实际用量超出预算：${settled.exceeded.join("、")}`);
      if (!measured) failure ??= new Error("DSH 实际 usage 不可得，后续付费调用已冻结");
      if (fatal) { budget.freeze({ taskId: options.taskId, reason: fatal }); failure ??= new Error(fatal); }
    }
    if (failure) throw failure;
  });
}
