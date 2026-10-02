/** O-domain contracts. Pure validation and read-back evaluation; no DB, network or mutations. */
const safeId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value);
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value) => typeof value === 'string' && Boolean(value.trim());
const own = (value, key) => Object.hasOwn(value, key);
const comparison = (assertion) => own(assertion, 'equals') || nonempty(assertion.contains) || (Number.isSafeInteger(assertion.minLength) && assertion.minLength > 0);
const fieldValid = (value) => nonempty(value) && value.split('.').every((part) => /^[A-Za-z0-9_]+$/.test(part) && !['__proto__', 'prototype', 'constructor'].includes(part));

export function valueAt(value, field) {
  if (!fieldValid(field)) return undefined;
  return field.split('.').reduce((current, part) => object(current) && own(current, part) ? current[part] : undefined, value);
}

/** Defense in depth: executed SQL also uses BEGIN READ ONLY and a statement timeout. */
export function assertReadOnlySql(sql) {
  if (!nonempty(sql) || !/^\s*SELECT\s/i.test(sql) || /;|--|\/\*|\*\//.test(sql)
      || /\b(?:INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|COPY|CALL|DO|SET|RESET|LOCK|FOR\s+(?:UPDATE|SHARE)|INTO|pg_sleep|pg_(?:advisory|terminate|cancel)|dblink|lo_import|lo_export|set_config|nextval|setval)\b/i.test(sql)) {
    throw new Error('state_asserts.sql 只允许单条只读 SELECT；不得含写入、锁、延迟或副作用函数');
  }
  return sql;
}

export function validateSuite(suite, { presetKeys = null, requireScenarioMatrix = false, requireP0Repetition = false } = {}) {
  const errors = [];
  if (!object(suite)) return ['任务套件必须是 YAML 对象'];
  if (!nonempty(suite.role)) errors.push('role 必须声明本行业承接岗位');
  if (!Array.isArray(suite.tasks) || !suite.tasks.length) return [...errors, 'tasks 不能为空（零任务是未验证）'];
  const ids = new Set(); const scenarios = new Set();
  for (const [i, task] of suite.tasks.entries()) {
    const label = `tasks[${i}]`;
    if (!object(task)) { errors.push(`${label} 必须是对象`); continue; }
    if (!safeId(task.id)) errors.push(`${label}.id 缺失或不是安全标识`);
    if (ids.has(task.id)) errors.push(`${label}.id 重复：${task.id}`); ids.add(task.id);
    if (!nonempty(task.title) || !nonempty(task.input ?? task.title)) errors.push(`${label} 缺少 title/input`);
    const scenario = task.scenario ?? 'normal'; scenarios.add(scenario);
    if (!['normal', 'failure', 'permission'].includes(scenario)) errors.push(`${label}.scenario 只能是 normal/failure/permission`);
    const k = Number(task.trials ?? suite.trials ?? 5);
    if (!Number.isSafeInteger(k) || k < 1 || k > 8) errors.push(`${label}.trials 必须是 1—8 的整数`);
    if (!['P0', 'P1', 'P2'].includes(task.criticality ?? 'P1')) errors.push(`${label}.criticality 非法`);
    if (!['none', 'approval', 'edit', 'reject'].includes(task.intervention ?? 'none')) errors.push(`${label}.intervention 非法`);
    if (scenario === 'normal') {
      if (requireP0Repetition && task.criticality === 'P0' && k < 5) errors.push(`${label} P0 代表任务必须声明至少 5 次重复 trial，其他任务次数不能代替`);
      const preset = task.presetKey ?? suite.agentPreset;
      if (!nonempty(preset)) errors.push(`${label} 缺少 agentPreset/presetKey`);
      else if (presetKeys && !presetKeys.has(preset)) errors.push(`${label}.preset 不在本行业 Bundle 中：${preset}`);
      const results = [...(Array.isArray(task.thread_asserts) ? task.thread_asserts : []), ...(Array.isArray(task.event_asserts) ? task.event_asserts : []), ...(Array.isArray(task.state_asserts) ? task.state_asserts : [])];
      if (!results.length) errors.push(`${label} 缺少具体结果断言；/health 与空 every() 不能证明交付`);
      if (task.receipt?.require !== true || !['thread-events', 'tool-events'].includes(task.receipt?.source)) errors.push(`${label}.receipt 必须 require=true，并声明 thread-events/tool-events 读回来源`);
      for (const [kind, assertions] of [['thread_asserts', task.thread_asserts], ['event_asserts', task.event_asserts]]) {
        if (assertions !== undefined && !Array.isArray(assertions)) { errors.push(`${label}.${kind} 必须是数组`); continue; }
        for (const [j, assertion] of (assertions ?? []).entries()) {
          if (!object(assertion) || !fieldValid(assertion.field) || !comparison(assertion) || (kind === 'event_asserts' && !nonempty(assertion.action))) errors.push(`${label}.${kind}[${j}] 必须含具体 field 与 equals/contains/minLength 比较${kind === 'event_asserts' ? '，以及 action' : ''}`);
          if (assertion?.minLength !== undefined && (!Number.isSafeInteger(assertion.minLength) || assertion.minLength <= 0)) errors.push(`${label}.${kind}[${j}].minLength 必须是正整数`);
        }
      }
      if (task.state_asserts !== undefined && !Array.isArray(task.state_asserts)) errors.push(`${label}.state_asserts 必须是数组`);
      for (const [j, assertion] of (Array.isArray(task.state_asserts) ? task.state_asserts : []).entries()) {
        try { assertReadOnlySql(assertion.sql); } catch (error) { errors.push(`${label}.state_asserts[${j}]：${error.message}`); }
        if (!Array.isArray(assertion?.params) || !['>=', '<=', '==', '>'].includes(assertion?.op) || !Number.isFinite(assertion?.value)) errors.push(`${label}.state_asserts[${j}] 必须声明 params/op/有限 value`);
      }
      if (task.http_asserts !== undefined && !Array.isArray(task.http_asserts)) errors.push(`${label}.http_asserts 必须是数组`);
      for (const assertion of (Array.isArray(task.http_asserts) ? task.http_asserts : [])) {
        if (!nonempty(assertion?.url) || !Number.isInteger(assertion?.status) || (assertion?.method !== undefined && assertion.method !== 'GET')) errors.push(`${label}.http_asserts 只接受有预期 status 的 GET`);
      }
    } else {
      const expected = task.expect;
      if (!object(expected) || ![400, 401, 403, 404, 412, 429].includes(expected.status) || !nonempty(expected.code) || expected.noThreadCreated !== true) errors.push(`${label}.expect 必须声明拒绝 HTTP status/code/noThreadCreated=true`);
      if (scenario === 'permission' && task.auth !== 'none') errors.push(`${label} 权限场景必须显式 auth=none，不能误用负责人 token`);
      if (task.request !== undefined && (!object(task.request) || task.request.procedure !== 'threads.dispatch' || task.request.method !== 'POST' || !object(task.request.data))) errors.push(`${label}.request 仅允许公开派单入口 threads.dispatch POST`);
    }
  }
  if (requireScenarioMatrix) for (const scenario of ['normal', 'failure', 'permission']) if (!scenarios.has(scenario)) errors.push(`缺少 ${scenario} 场景`);
  return errors;
}

/** Each declared P0 task must have its own distinct, observed repetition sequence. */
export function evaluateP0Repetition(tasks, trials) {
  const p0 = tasks.filter((task) => (task.scenario ?? 'normal') === 'normal' && task.criticality === 'P0');
  const rows = p0.map((task) => {
    const observed = trials.filter((trial) => trial.taskId === task.id && trial.scenario === 'normal' && trial.criticality === 'P0');
    const numbers = observed.map((trial) => trial.trial).sort((a, b) => a - b);
    const distinctSequence = numbers.every((number, index) => Number.isSafeInteger(number) && number === index + 1);
    const complete = observed.length >= 5 && observed.length <= 8 && distinctSequence && observed.every((trial) => trial.verified === true);
    return { taskId: task.id, trials: observed.length, distinctSequence, verifiedTrials: observed.filter((trial) => trial.verified === true).length, passed: observed.filter((trial) => trial.pass === true).length, complete, repeatedPass: complete && observed.every((trial) => trial.pass === true) };
  });
  const passAtK = rows.length ? rows.filter((row) => row.repeatedPass).length / rows.length : null;
  return { tasks: rows.length, minTrials: rows.length ? Math.min(...rows.map((row) => row.trials)) : 0, maxTrials: rows.length ? Math.max(...rows.map((row) => row.trials)) : 0, passAtK, perTask: rows, ok: rows.length > 0 && rows.every((row) => row.complete) && passAtK >= 0.8 };
}

function matches(actual, assertion, bindings) {
  if (own(assertion, 'equals')) {
    const expected = typeof assertion.equals === 'string' && own(bindings, assertion.equals) ? bindings[assertion.equals] : assertion.equals;
    if (JSON.stringify(actual) !== JSON.stringify(expected)) return false;
  }
  if (assertion.contains !== undefined && (typeof actual !== 'string' || !actual.includes(assertion.contains))) return false;
  if (assertion.minLength !== undefined && (typeof actual !== 'string' || actual.trim().length < assertion.minLength)) return false;
  return true;
}

export function evaluateThread(task, observation) {
  const { threadId, workspaceId, thread, events = [], externalAsserts = [], observedAt = new Date().toISOString() } = observation;
  const problems = []; const asserts = []; const bindings = { threadId, workspaceId };
  if (!nonempty(threadId) || thread?.id !== threadId) problems.push('线程读回身份不一致');
  if (thread?.status !== 'completed') problems.push(`线程没有 completed 终态（${thread?.status ?? 'unknown'}）`);
  const ownEvents = events.filter((event) => event?.object?.id === threadId && event?.context?.workspace_id === workspaceId && /^E-\d+$/.test(event?.event_id ?? ''));
  for (const assertion of task.thread_asserts ?? []) {
    const value = valueAt(thread, assertion.field);
    asserts.push({ type: 'thread', field: assertion.field, ok: matches(value, assertion, bindings), value: value ?? null, expected: assertion });
  }
  for (const assertion of task.event_asserts ?? []) {
    const values = ownEvents.filter((event) => event.decision?.action === assertion.action).map((event) => ({ eventId: event.event_id, value: valueAt(event, assertion.field) ?? null }));
    asserts.push({ type: 'event', action: assertion.action, field: assertion.field, ok: values.some(({ value }) => matches(value, assertion, bindings)), values, expected: assertion });
  }
  asserts.push(...externalAsserts);
  const expectedCount = (task.thread_asserts?.length ?? 0) + (task.event_asserts?.length ?? 0) + (task.state_asserts?.length ?? 0) + (task.http_asserts?.length ?? 0);
  if (expectedCount === 0 || asserts.length !== expectedCount || asserts.some((assertion) => assertion.ok !== true)) problems.push('具体结果断言未全部执行并通过');
  let receipt;
  if (task.receipt?.source === 'thread-events') {
    const matching = ownEvents.filter((event) => event.decision?.action !== 'thread.dispatch');
    receipt = { source: 'api-readback', threadId, workspaceId, finalStatus: thread?.status ?? null, observedAt, eventIds: matching.map((event) => event.event_id), verified: thread?.id === threadId && thread.status === 'completed' && matching.length > 0 };
  } else if (task.receipt?.source === 'tool-events') {
    const matching = ownEvents.filter((event) => event.receipt?.synced === true && Number.isFinite(Date.parse(event.receipt?.verified_at ?? '')) && (!task.receipt.requireReal || event.receipt.mode === 'real'));
    receipt = { source: 'tool-events', threadId, workspaceId, finalStatus: thread?.status ?? null, observedAt, eventIds: matching.map((event) => event.event_id), verified: matching.length > 0 };
  } else receipt = { source: 'missing', threadId, verified: false };
  if (task.receipt?.require !== true || receipt.verified !== true) problems.push('缺少本线程、本工作区的已核验读回回执');
  if (!Number.isFinite(Date.parse(observedAt))) problems.push('读回回执核验时间无效');
  const pass = problems.length === 0;
  return { pass, falseSuccess: thread?.status === 'completed' && !pass, asserts, receipt, problems, status: thread?.status ?? null };
}

export function evaluateDenial(task, observation) {
  const expected = task.expect ?? {}; const problems = [];
  if (observation.status !== expected.status) problems.push(`拒绝 HTTP ${observation.status} 与预期 ${expected.status} 不同`);
  if (observation.code !== expected.code) problems.push(`拒绝 code ${observation.code ?? 'unknown'} 与预期 ${expected.code} 不同`);
  if (observation.threadId || (observation.createdThreads ?? []).length) problems.push('拒绝路径仍创建了线程');
  if (expected.messageIncludes && !String(observation.message ?? '').includes(expected.messageIncludes)) problems.push('拒绝原因与预期不一致');
  return { pass: problems.length === 0, falseSuccess: false, problems, asserts: [{ type: 'denial', ok: problems.length === 0, expected, actual: observation }], receipt: { source: 'api-readback', verified: problems.length === 0, threadId: null }, status: 'denied' };
}

export function outcomeStats(trials) {
  const byTask = new Map();
  for (const trial of trials) { const rows = byTask.get(trial.taskId) ?? []; rows.push(trial); byTask.set(trial.taskId, rows); }
  return {
    tasks: byTask.size, trials: trials.length,
    passAt1: trials.length ? Number((trials.filter((trial) => trial.pass).length / trials.length).toFixed(4)) : null,
    passAtK: byTask.size ? Number(([...byTask.values()].filter((rows) => rows.every((trial) => trial.pass)).length / byTask.size).toFixed(4)) : null,
    k: Math.max(0, ...[...byTask.values()].map((rows) => rows.length)),
    passed: trials.filter((trial) => trial.pass).length, falseSuccess: trials.filter((trial) => trial.falseSuccess).length,
    clarify: trials.filter((trial) => trial.clarify).length,
    interventions: trials.reduce((sum, trial) => sum + (trial.interventions?.length ?? 0), 0),
  };
}
