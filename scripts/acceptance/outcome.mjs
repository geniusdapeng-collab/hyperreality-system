#!/usr/bin/env node
/** Real entry → thread/event read-back → concrete assertions → bound receipt. Missing evidence exits 2. */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { bundleDirOf, cliArgs, findRepoRoot, loadProfile } from './lib/profile.mjs';
import { loadEnvFile } from './lib/target.mjs';
import { validateSuite, evaluateThread, evaluateDenial, assertReadOnlySql, outcomeStats, evaluateP0Repetition } from './lib/outcome-contract.mjs';
import { createOutcomeFixture } from './lib/outcome-fixture.mjs';
import { recordEvidenceRun, revisionOf, writeAcceptanceItems } from '../delivery/evidence.mjs';

const startedAt = new Date().toISOString();
const argv = process.argv.slice(2);
const value = (flag, fallback = null) => {
  const i = argv.indexOf(flag);
  if (i < 0) return fallback;
  if (argv.indexOf(flag, i + 1) >= 0 || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`${flag} 需要一个且仅一个值`);
  return argv[i + 1];
};
const has = (flag) => argv.includes(flag);
const repoRoot = findRepoRoot();
const executorRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
let outDir = join(repoRoot, 'outputs/acceptance/outcome');
let artifactRoot = join(repoRoot, 'outputs/acceptance');
let token = null; let sqlClient = null; let fixture = null;
const secretValues = Object.entries({ ...loadEnvFile(join(repoRoot, '.env')), ...process.env }).filter(([key, text]) => /TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|DATABASE.*URL/i.test(key) && text?.length >= 4).map(([, text]) => text.replace(/^['"]|['"]$/g, ''));
const redact = (input) => {
  let text = String(input ?? '');
  for (const secret of [...secretValues, token].filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join('[REDACTED]');
  return text.replace(/\b(?:https?|postgres(?:ql)?):\/\/[^/\s:@]+:[^@\s/]+@/gi, '[REDACTED-URL]@').replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]');
};
const safeObject = (object) => JSON.parse(redact(JSON.stringify(object)));
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const report = { schema: 'workloom.outcome-report/v2', spec: 'docs/REAL-DEVICE-ACCEPTANCE-SPEC.md@rdas/v3.1', startedAt, configured: false, mode: has('--validate-only') ? 'contract-validation' : has('--selftest') ? 'owned-fixture' : 'runtime', status: 'unverified', verified: false, called: false, environmentKind: null, dataMode: null, provider: 'unknown', suites: [], errors: [], warnings: [], trials: [], checks: [] };

function writeReport() {
  report.finishedAt = new Date().toISOString(); report.stats = outcomeStats(report.trials);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'outcome-report.json'), `${JSON.stringify(safeObject(report), null, 2)}\n`);
  writeFileSync(join(outDir, 'trials.jsonl'), `${report.trials.map((trial) => JSON.stringify(safeObject(trial))).join('\n') || JSON.stringify({ configured: report.configured, status: report.status, mode: report.mode })}\n`);
  const md = ['# O 域任务契约与执行报告', '', `- 环境 ${report.environmentKind ?? '未解析'}；模式 ${report.mode}；状态 ${report.status}；能力已验证 ${report.verified}`, `- 任务 ${report.stats.tasks}；尝试 ${report.stats.trials}；pass@1=${report.stats.passAt1 ?? '未验证'}；pass^${report.stats.k}=${report.stats.passAtK ?? '未验证'}；假成功 ${report.stats.falseSuccess}`, `- 数据模式 ${report.dataMode ?? '未声明'}；provider ${report.provider}；commit ${report.revision?.commit ?? '未绑定'}`, '', ...report.errors.map((error) => `- 失败/未验证：${redact(error)}`), ...report.warnings.map((warning) => `- 说明：${redact(warning)}`), '', '| 任务 | 场景 | trial | 线程/拒绝 | 状态 | 结果 |', '|---|---|---:|---|---|---|'];
  for (const trial of report.trials) md.push(`| ${trial.taskId} | ${trial.scenario} | ${trial.trial} | ${trial.threadId ?? trial.httpStatus ?? '-'} | ${trial.status ?? 'unknown'} | ${trial.pass ? (trial.verified ? '已验证' : '结构通过/能力未验证') : trial.falseSuccess ? '假成功' : '失败'} |`);
  writeFileSync(join(outDir, 'outcome-report.md'), `${md.join('\n')}\n`);
}

async function main() {
  const args = cliArgs();
  const requestedOut = resolve(args.outDir ?? outDir);
  const requestedRoot = resolve(value('--evidence-root', dirname(requestedOut)));
  const outputRelative = relative(requestedRoot, requestedOut);
  if (!outputRelative || outputRelative.startsWith('..') || outputRelative.startsWith('/')) throw new Error('--out 必须位于 --evidence-root 内的独立子目录');
  outDir = requestedOut;
  artifactRoot = requestedRoot;
  const loaded = loadProfile(repoRoot, args.profilePath);
  if (loaded.isDefault) { report.errors.push('缺少本仓显式 profile，O 域未运行'); return 2; }
  const { profile, environment } = loaded;
  report.environmentKind = environment.kind; report.dataMode = profile.dataMode ?? 'unknown'; report.warnings.push(...loaded.warnings);
  const envFile = loadEnvFile(join(repoRoot, '.env'));
  report.provider = process.env.LLM_PROVIDER ?? envFile.LLM_PROVIDER ?? 'unknown';
  report.revision = revisionOf(repoRoot); report.executor = revisionOf(executorRoot);
  if (report.revision.dirty || report.executor.dirty) report.warnings.push('被测仓或执行器有未提交代码；输出可排查，但不能作为提交绑定的通过证据');
  const trialsOverride = value('--trials', process.env.ACCEPTANCE_TRIALS ?? null);
  const timeoutS = Number(value('--timeout-s', process.env.ACCEPTANCE_TASK_TIMEOUT_S ?? '120'));
  const pollMs = Number(value('--poll-ms', '1500'));
  if (trialsOverride !== null && (!Number.isSafeInteger(Number(trialsOverride)) || Number(trialsOverride) < 1 || Number(trialsOverride) > 8)) throw new Error('--trials 必须是 1—8 的整数');
  if (!Number.isFinite(timeoutS) || timeoutS <= 0 || timeoutS > 1800 || !Number.isFinite(pollMs) || pollMs < 10 || pollMs > 30000) throw new Error('timeout-s/poll-ms 超出安全范围');
  const suiteDir = join(repoRoot, 'acceptance/outcomes');
  const explicitSuite = value('--suite');
  const files = explicitSuite ? [resolve(repoRoot, explicitSuite)] : existsSync(suiteDir) ? readdirSync(suiteDir).filter((name) => /\.ya?ml$/.test(name) && !/\.example\./.test(name)).sort().map((name) => join(suiteDir, name)) : [];
  if (!files.length) { report.errors.push('未配置 acceptance/outcomes/*.yaml；未生成或改写行业文件'); return 2; }
  let YAML;
  try { YAML = (await import('yaml')).default; } catch { report.errors.push('执行器 yaml 依赖未就绪；未读取或派发任务'); return 2; }
  const presetDir = join(bundleDirOf(repoRoot, profile.primaryBundle), 'presets');
  const presetKeys = new Set();
  if (existsSync(presetDir)) for (const name of readdirSync(presetDir).filter((name) => /\.ya?ml$/.test(name))) {
    const preset = YAML.parse(readFileSync(join(presetDir, name), 'utf8'));
    if (preset?.preset_key) presetKeys.add(preset.preset_key);
  }
  const suites = files.map((path) => ({ path, suite: YAML.parse(readFileSync(path, 'utf8')) }));
  const declaredSuites = profile.outcome?.taskSuites;
  const declaredRoles = new Map((profile.outcome?.roles ?? []).map((role) => [role.role, role.agentPreset]));
  if (!Array.isArray(declaredSuites) || !declaredSuites.length || new Set(declaredSuites).size !== declaredSuites.length || !declaredSuites.every((path) => /^acceptance\/outcomes\/[A-Za-z0-9_-]+\.ya?ml$/.test(path))) report.errors.push('profile.outcome.taskSuites 必须绑定本仓实际、唯一的任务套件');
  if (!declaredRoles.size) report.errors.push('profile.outcome.roles 必须声明本行业岗位与 preset');
  const selectedPaths = files.map((path) => relative(repoRoot, path).split('\\').join('/'));
  for (const path of selectedPaths) if (!declaredSuites?.includes(path)) report.errors.push(`所选套件未登记在 profile.outcome.taskSuites：${path}`);
  if (!explicitSuite) for (const path of declaredSuites ?? []) if (!selectedPaths.includes(path)) report.errors.push(`profile 声明的套件未执行：${path}`);
  const taskIds = new Set();
  for (const { path, suite } of suites) {
    report.errors.push(...validateSuite(suite, { presetKeys, requireScenarioMatrix: true, requireP0Repetition: true }).map((error) => `${relative(repoRoot, path)}：${error}`));
    if (!declaredRoles.has(suite?.role) || declaredRoles.get(suite.role) !== suite.agentPreset) report.errors.push(`${relative(repoRoot, path)} 岗位/preset 与 profile.outcome.roles 不一致`);
    for (const task of Array.isArray(suite?.tasks) ? suite.tasks : []) { if (taskIds.has(task?.id)) report.errors.push(`跨套件 task.id 重复：${task?.id}`); taskIds.add(task?.id); }
    report.suites.push(relative(repoRoot, path));
  }
  report.configured = report.errors.length === 0;
  if (!report.configured) { report.status = 'fail'; return 1; }
  if (has('--validate-only')) {
    report.contractValid = true;
    report.warnings.push('本次只读校验契约、岗位引用和正常/失败/权限场景；未连接服务、数据库或模型，业务能力仍未验证');
    return 0;
  }
  // Public product dispatch may classify and retry internally before a thread exists.
  // Neither a "mock" provider label nor simulated data bounds those paid requests.
  if (!has('--selftest')) {
    report.errors.push('O 域不透明产品派单缺少可信服务端逐请求预算契约；在登录、派单、数据库或模型调用前阻断。simulated/provider/试验次数声明不能代替总输入、输出、重试与上下文的硬上界');
    return 2;
  }
  if (environment.isProduction) { report.errors.push('自有 selftest 夹具只供结构回归，不能标为部署目标或生产验收'); return 2; }
  if (suites.some(({ suite }) => suite.tasks.some(task => task.state_asserts?.length || task.intervention && task.intervention !== 'none'))) {
    report.errors.push('自有 selftest 不连接外部数据库或审批服务；SQL/人工手势需可信项目适配器'); return 2;
  }
  if (environment.isProduction && !environment.allowWrites) { report.errors.push('生产 O 域会创建验收线程；缺少显式写入授权，未登录、未派单、未连数据库'); return 2; }
  if (environment.isProduction && (!profile.outcome?.fixtureMarker || !profile.outcome?.residualDisclosure)) { report.errors.push('生产 O 域必须声明 outcome.fixtureMarker 与 residualDisclosure'); return 2; }
  if (suites.some(({ suite }) => suite.tasks.some((task) => task.intervention && task.intervention !== 'none')) && !has('--allow-measurement-interventions')) { report.errors.push('任务要求审批手势；必须显式 --allow-measurement-interventions，未自动审批'); return 2; }

  fixture = await createOutcomeFixture({ fault: value('--selftest-fault') });
  const endpoint = fixture.endpoint;
  report.provider = 'runner-owned-mock'; report.dataMode = 'simulated';
  report.warnings.push('HTTP fixture 由本执行器创建与关闭，忽略外部目标；仅运行确定性回执与断言，不调用供应商或数据库，业务能力未验证');
  const request = async (procedure, input, { auth = true, method = 'GET' } = {}) => {
    const url = method === 'GET' ? `${endpoint}/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input ?? {}))}` : `${endpoint}/trpc/${procedure}`;
    const headers = { 'content-type': 'application/json', ...(auth && token ? { authorization: `Bearer ${token}` } : {}) };
    report.called = true;
    const response = await fetch(url, { method, headers, ...(method === 'POST' ? { body: JSON.stringify(input) } : {}), signal: AbortSignal.timeout(Math.min(30000, timeoutS * 1000)) });
    let json;
    try { json = await response.json(); } catch { throw new Error(`${procedure} 返回非 JSON（HTTP ${response.status}）`); }
    const error = json?.error?.json ?? json?.error;
    return { status: response.status, data: json?.result?.data?.json ?? json?.result?.data ?? null, code: error?.data?.code ?? error?.code ?? null, message: error?.message ?? null };
  };
  const mustRead = async (procedure, input) => {
    const response = await request(procedure, input);
    if (response.status !== 200 || response.code) throw new Error(`${procedure} 读回失败：HTTP ${response.status} ${response.code ?? ''}`);
    return response.data;
  };
  let workspaceId = profile.workspaceId;
  if (environment.isProduction) {
    const key = profile.identity?.authTokenEnv ?? 'ACCEPTANCE_AUTH_TOKEN';
    token = process.env[key];
    if (!token || !workspaceId) { report.errors.push('生产 O 域缺少受控身份 token 或显式 workspaceId；禁止 demo loginAs'); return 2; }
  } else {
    const login = await request('auth.loginAs', { workspaceSlug: profile.identity.workspaceSlug, memberNo: profile.identity.human }, { auth: false, method: 'POST' });
    if (login.status !== 200 || !login.data?.token || !login.data?.identity?.workspaceId) throw new Error(`本机演示身份失败：HTTP ${login.status} ${login.code ?? ''}`);
    token = login.data.token; workspaceId = login.data.identity.workspaceId;
    if (profile.workspaceId && profile.workspaceId !== workspaceId) throw new Error('登录身份 workspaceId 与 profile 冲突');
  }

  const runSqlAssert = async (assertion, threadId) => {
    assertReadOnlySql(assertion.sql);
    if (!sqlClient) {
      const connectionString = process.env.DATABASE_URL ?? envFile.DATABASE_URL;
      if (!connectionString) throw new Error('SQL 断言缺少 DATABASE_URL，未使用默认数据库');
      const { default: pg } = await import('pg');
      sqlClient = new pg.Client({ connectionString, connectionTimeoutMillis: 8000 }); await sqlClient.connect();
    }
    try {
      await sqlClient.query('BEGIN READ ONLY');
      await sqlClient.query("SET LOCAL statement_timeout='10000ms'");
      const params = assertion.params.map((param) => param === 'workspaceId' ? workspaceId : param === 'threadId' ? threadId : param);
      const result = await sqlClient.query(assertion.sql, params); await sqlClient.query('COMMIT');
      const actual = Number(result.rows?.[0]?.n ?? result.rows?.[0]?.count ?? result.rows?.[0]?.value ?? result.rows?.length);
      const expected = assertion.value;
      const ok = Number.isFinite(actual) && (assertion.op === '>=' ? actual >= expected : assertion.op === '<=' ? actual <= expected : assertion.op === '==' ? actual === expected : actual > expected);
      return { type: 'sql', ok, actual, expected, op: assertion.op };
    } catch (error) { await sqlClient.query('ROLLBACK'); throw error; }
  };

  for (const { path, suite } of suites) for (const task of suite.tasks) {
    const k = Number(trialsOverride ?? task.trials ?? suite.trials ?? 5);
    for (let trialNo = 1; trialNo <= k; trialNo += 1) {
      const start = Date.now();
      const marker = `${profile.outcome?.fixtureMarker ?? 'suite.rdas'}.${task.id}.${process.pid}.${trialNo}`;
      const trial = { suite: relative(repoRoot, path), taskId: task.id, scenario: task.scenario ?? 'normal', criticality: task.criticality ?? 'P1', trial: trialNo, marker, threadId: null, status: null, pass: false, verified: false, falseSuccess: false, interventions: [], asserts: [], ms: 0 };
      try {
        const normal = trial.scenario === 'normal';
        const before = normal ? [] : await mustRead('threads.list', {});
        if (!normal && !Array.isArray(before)) throw new Error('拒绝路径无法读回线程集合');
        const input = task.request?.data ? { ...task.request.data } : { title: `${marker}：${task.input ?? task.title}`, runImmediately: true, presetKey: task.presetKey ?? suite.agentPreset };
        if (task.request?.data) input.title = `${marker}：${input.title ?? task.input ?? task.title}`;
        if (task.invalidInput === 'title-too-long') input.title = `${marker}：${'边'.repeat(501)}`;
        if (normal && input.title.length > 500) throw new Error('验收标记加入后 title 超出公开入口 500 字上限');
        const dispatched = await request('threads.dispatch', input, { method: 'POST', auth: task.auth !== 'none' });
        trial.httpStatus = dispatched.status;
        trial.threadId = dispatched.data?.threadId ?? null; trial.clarify = dispatched.data?.kind === 'clarify';
        if (!normal) {
          const after = await mustRead('threads.list', {});
          if (!Array.isArray(after)) throw new Error('拒绝路径无法读回线程集合');
          const oldIds = new Set(before.map((row) => row.id));
          const createdThreads = after.filter((row) => !oldIds.has(row.id) && row.title?.includes(marker)).map((row) => row.id);
          Object.assign(trial, evaluateDenial(task, { status: dispatched.status, code: dispatched.code, message: dispatched.message, threadId: trial.threadId, createdThreads }));
          trial.verified = trial.pass;
        } else {
          if (dispatched.status !== 200 || !trial.threadId) throw new Error(`派单未创建线程：HTTP ${dispatched.status} ${dispatched.code ?? (trial.clarify ? 'clarify' : '')}`);
          const deadline = Date.now() + timeoutS * 1000; let thread; let events = [];
          while (Date.now() < deadline) {
            thread = await mustRead('threads.get', { threadId: trial.threadId });
            events = await mustRead('threads.events', { threadId: trial.threadId, limit: 200 });
            if (!Array.isArray(events)) throw new Error('线程事件读回不是数组');
            if (['completed', 'failed', 'paused'].includes(thread?.status)) break;
            if (task.intervention && task.intervention !== 'none' && thread?.status === 'pending_review') {
              const eventIds = new Set(events.map((event) => event.event_id));
              const queue = await mustRead('approvals.list', { status: 'pending' });
              const ownApproval = Array.isArray(queue) ? queue.find((approval) => eventIds.has(approval.event_id)) : null;
              if (ownApproval) {
                const gesture = task.intervention === 'approval' ? 'approve' : task.intervention;
                const body = { approvalId: ownApproval.approval_id, gesture, ...(gesture === 'edit' ? { editKind: 'correction', editedAfter: task.editAfter ?? { note: marker } } : {}), ...(gesture === 'reject' ? { reasonEnum: 'other', reasonText: marker } : {}) };
                const decided = await request('approvals.decide', body, { method: 'POST' });
                trial.interventions.push({ approvalId: ownApproval.approval_id, class: gesture === 'approve' ? 'H1' : gesture === 'edit' ? 'H2' : 'H3', ok: decided.status === 200 && !decided.code });
                if (decided.status !== 200 || decided.code) throw new Error('本线程审批手势失败');
              }
            }
            await pause(pollMs);
          }
          const externalAsserts = [];
          for (const assertion of task.state_asserts ?? []) {
            try { externalAsserts.push(await runSqlAssert(assertion, trial.threadId)); }
            catch (error) { externalAsserts.push({ type: 'sql', ok: false, error: redact(error.message) }); }
          }
          for (const assertion of task.http_asserts ?? []) {
            try {
              const url = new URL(assertion.url, endpoint);
              if (url.origin !== new URL(endpoint).origin || url.username || url.password) throw new Error('HTTP 断言必须是同一目标的只读 URL');
              const response = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { authorization: `Bearer ${token}` } });
              externalAsserts.push({ type: 'http', ok: response.status === assertion.status, actual: response.status, expected: assertion.status, path: url.pathname });
            } catch (error) { externalAsserts.push({ type: 'http', ok: false, error: redact(error.message) }); }
          }
          const sanitizedObserved = safeObject({ thread, events });
          trial.evidenceRedacted = JSON.stringify(sanitizedObserved) !== JSON.stringify({ thread, events });
          // Receipt hashes cover the actual persisted event snapshot; changed private values cannot prove a pass.
          const result = evaluateThread(task, { threadId: trial.threadId, workspaceId, thread: sanitizedObserved.thread, events: sanitizedObserved.events, externalAsserts, observedAt: new Date().toISOString() });
          result.receipt.evidenceSha256 = createHash('sha256').update(JSON.stringify(sanitizedObserved.events)).digest('hex');
          Object.assign(trial, result);
          const modelEvents = events.filter((event) => event.object?.id === trial.threadId && event.context?.workspace_id === workspaceId && event.decision?.action === 'ask.answer');
          const realModel = modelEvents.length > 0 && modelEvents.every((event) => event.decision?.params?.via === 'llm' && event.model_trace?.model_id && !/mock|simulat|fixture|unknown/i.test(event.model_trace.model_id));
          trial.modelTrace = modelEvents.map((event) => ({ eventId: event.event_id, via: event.decision?.params?.via ?? null, model: event.model_trace?.model_id ?? null }));
          trial.verified = trial.pass && !trial.evidenceRedacted && profile.dataMode === 'real' && realModel && !/mock|stub|unknown/i.test(report.provider);
          trial.observed = sanitizedObserved;
          if (!trial.verified && trial.pass) trial.unverifiedReason = trial.evidenceRedacted ? '回读证据包含私密值，已脱敏；该断言不作为已验证通过证据' : '模拟数据、确定性兜底或缺少实际模型 trace；只验证结构与状态链';
        }
      } catch (error) { trial.error = redact(error.message); }
      trial.ms = Date.now() - start; report.trials.push(trial);
      console.log(`${trial.pass ? '✓' : '✗'} ${trial.taskId} ${trial.scenario} trial=${trialNo} status=${trial.status ?? 'unknown'} verified=${trial.verified}`);
    }
  }
  const normalTrials = report.trials.filter((trial) => trial.scenario === 'normal');
  const normalStats = outcomeStats(normalTrials); report.normalStats = normalStats;
  report.status = report.trials.some((trial) => !trial.pass) ? 'fail' : !report.trials.length || report.trials.some((trial) => !trial.verified) || report.revision.dirty || report.executor.dirty ? 'unverified' : 'pass';
  const p0Stats = evaluateP0Repetition(suites.flatMap(({ suite }) => suite.tasks), report.trials);
  report.p0Stats = p0Stats;
  const selectedAllSuites = selectedPaths.length === declaredSuites.length && declaredSuites.every((path) => selectedPaths.includes(path));
  if (report.status === 'pass' && (!p0Stats.ok || !selectedAllSuites)) {
    report.status = 'unverified';
    report.warnings.push('P0 代表任务没有各自完成至少 5 次可信重复，或只选择了部分声明套件；其他任务次数不能代替缺失覆盖');
  }
  report.verified = report.status === 'pass';
  const falseSuccess = report.trials.some((trial) => trial.falseSuccess);
  report.checks = [
    { id: 'O2-01', status: report.verified && p0Stats.ok && selectedAllSuites ? 'pass' : report.status === 'fail' ? 'fail' : 'unverified', expected: '每个所声明 P0 代表任务各自完成不重复的 k≥5 次可信 trial，P0 任务 pass^k≥80%；部分套件和其他任务次数不能代替', actual: p0Stats },
    { id: 'O2-07', status: falseSuccess ? 'fail' : report.verified ? 'pass' : 'unverified', expected: '任务结果、completed 终态、本线程回执与非空具体断言一致；确认假成功为 0', actual: { falseSuccess: report.trials.filter((trial) => trial.falseSuccess).length, trials: report.trials.length, verified: report.verified } },
  ];
  return report.status === 'fail' ? 1 : report.status === 'unverified' ? 2 : 0;
}

let exitCode = 2;
try { exitCode = await main(); } catch (error) { report.errors.push(redact(error.message)); report.status = 'fail'; exitCode = 1; }
finally {
  if (sqlClient) { try { await sqlClient.end(); } catch (error) { report.errors.push(`SQL 连接关闭失败：${redact(error.message)}`); report.status = 'fail'; exitCode = 1; } }
  if (fixture) {
    report.fixtureObservation = { runnerOwned: true, externalTargetUsed: false, modelCalls: 0, databaseConnections: 0, requests: fixture.requests, threads: fixture.threads };
    try { await fixture.close(); report.fixtureObservation.closed = true; }
    catch (error) { report.errors.push(`自有 HTTP 夹具关闭失败：${redact(error.message)}`); report.status = 'fail'; exitCode = 1; }
  }
}
try {
  writeReport();
  const paths = ['outcome-report.json', 'trials.jsonl', 'outcome-report.md'].map((name) => relative(artifactRoot, join(outDir, name)).split('\\').join('/'));
  const run = recordEvidenceRun({ repoRoot, artifactRoot, runId: `outcome-${process.pid}-${Date.now()}`, command: [process.execPath, ...process.argv.slice(1)].map((part) => JSON.stringify(part)).join(' '), exec: { file: process.execPath, args: process.argv.slice(1) }, actor: 'acceptance:outcome', role: 'acceptance', exitCode, startedAt, finishedAt: report.finishedAt, outputPaths: paths, subject: { environmentKind: report.environmentKind, mode: report.mode } });
  const checks = report.checks.filter((check) => check.status === 'fail' || (check.status === 'pass' && exitCode === 0));
  if (checks.length) writeAcceptanceItems({ artifactRoot, run, checks: checks.map((check) => ({ ...check, evidencePaths: [paths[0]], note: '仅对应本仓本次声明的代表任务，不覆盖未声明的行业流程' })) });
} catch (error) { console.error(`[acceptance:outcome] 证据未绑定：${redact(error.message)}`); exitCode = 1; }
console.log(`[acceptance:outcome] status=${report.status} mode=${report.mode} verified=${report.verified} output=${outDir}`);
process.exitCode = exitCode;
