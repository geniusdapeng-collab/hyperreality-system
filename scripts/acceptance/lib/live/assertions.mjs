/** Reproducible product observations, shared by the adapter and final verifier. */
export function freshReceipt(value, dispatchedAt, now = Date.now()) {
  const stamp = typeof value === "string" ? Date.parse(value) : NaN;
  const started = typeof dispatchedAt === "string" ? Date.parse(dispatchedAt) : NaN;
  return Number.isFinite(stamp) && Number.isFinite(started) && stamp >= started - 300_000 && stamp <= now + 300_000;
}

export function realExecution(event, dispatchedAt, threadId) {
  const proof = event?.receipt;
  return typeof threadId === "string" && threadId.length > 0 && event?.object?.id === threadId
    && /^E-\d+$/u.test(event?.event_id ?? "") && event?.decision?.kind === "execute" && typeof event.decision.step_id === "string" && event.decision.step_id.length > 0
    && proof?.synced === true && proof.mode === "real" && !proof.error
    && typeof proof.snapshot_uri === "string" && /^[a-z][a-z0-9+.-]*:\/\//iu.test(proof.snapshot_uri) && !/^(workloom-sim|mock|stub):/iu.test(proof.snapshot_uri)
    && freshReceipt(proof.verified_at, dispatchedAt);
}

export function evaluateEventAssertion({ events, threadId, assertion }) {
  const value = assertion && typeof assertion === "object" && !Array.isArray(assertion) ? assertion : {};
  const field = value.field;
  const safe = typeof value.action === "string" && value.action.length > 0 && typeof field === "string" && /^[A-Za-z_][A-Za-z0-9_.]*$/u.test(field) && !field.split(".").some((part) => ["__proto__", "prototype", "constructor"].includes(part));
  const lengthValid = value.minLength === undefined || (Number.isSafeInteger(value.minLength) && value.minLength > 0);
  const equals = Object.hasOwn(value, "equals") && value.equals !== undefined;
  const concrete = equals || (typeof value.contains === "string" && value.contains.length > 0) || value.minLength !== undefined;
  const containsValid = value.contains === undefined || (typeof value.contains === "string" && value.contains.length > 0);
  const latest = safe && Array.isArray(events) ? events.filter((event) => event?.decision?.action === value.action && event?.object?.id === threadId).at(-1) : null;
  const observed = latest ? field.split(".").reduce((object, part) => object && typeof object === "object" && Object.hasOwn(object, part) ? object[part] : undefined, latest) : undefined;
  const actual = latest ? [observed] : [];
  const ok = Boolean(safe && lengthValid && containsValid && concrete && latest && observed !== undefined
    && (!equals || JSON.stringify(observed) === JSON.stringify(value.equals))
    && (value.contains === undefined || typeof observed === "string" && observed.includes(value.contains))
    && (value.minLength === undefined || typeof observed === "string" && observed.length >= value.minLength));
  return { type: "event", target: `${value.action ?? "?"}#${field ?? "?"}`, ok, actual, detail: ok ? "实际线程事件命中预声明结果" : "事件缺失、断言无效或结果不匹配" };
}
