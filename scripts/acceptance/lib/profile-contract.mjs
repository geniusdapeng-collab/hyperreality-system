/** Raw configuration contract. A valid profile proves declaration consistency, never business delivery. */
import { PROFILE_SCHEMA, THRESHOLD_FLOORS, LIVE_BUDGET_FLOORS } from './profile.mjs';
import { ENVIRONMENT_KINDS } from './target.mjs';
import { validateSuite } from './outcome-contract.mjs';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
const array = (value) => Array.isArray(value) ? value : [];
const unique = (values) => new Set(values).size === values.length;
const safeId = (value) => nonempty(value) && /^[A-Za-z0-9_-]+$/.test(value);
const suitePath = (value) => typeof value === 'string' && /^acceptance\/outcomes\/[A-Za-z0-9_-]+\.ya?ml$/.test(value);
const field = (value) => nonempty(value) && value.split('.').every((part) => /^[A-Za-z0-9_]+$/.test(part) && !['__proto__', 'prototype', 'constructor'].includes(part));
const resultComparison = (value) => object(value) && (Object.hasOwn(value, 'equals') || nonempty(value.contains) || (Number.isSafeInteger(value.minLength) && value.minLength > 0));

export function validateProfileContract(raw, { manifest, bundleExists = false, presetKeys = new Set(), suiteEntries = [], instanceSlug = null } = {}) {
  const errors = []; const warnings = [];
  const fail = (condition, message) => { if (!condition) errors.push(message); };
  if (!object(raw)) return { errors: ['profile 必须是 JSON 对象'], warnings, businessVerified: false, suiteCount: 0, taskCount: 0 };
  fail(raw.schemaVersion === PROFILE_SCHEMA, `schemaVersion 必须显式为 ${PROFILE_SCHEMA}，不能用合并默认值补缺`);
  fail(object(manifest) && nonempty(manifest.repository), 'product.manifest.repository 缺失或无效');
  fail(nonempty(raw.repo) && raw.repo === manifest?.repository, 'profile.repo 必须与 product.manifest.repository 一致');
  fail(nonempty(raw.productName), 'productName 必须声明用户识别的产品名');
  fail(nonempty(raw.primaryBundle) && raw.primaryBundle === manifest?.defaultBundle, 'primaryBundle 必须与 product.manifest.defaultBundle 一致');
  fail(bundleExists, 'primaryBundle 指向的本仓 Bundle 不存在');
  fail(['simulated', 'real'].includes(raw.dataMode), 'dataMode 必须显式为 simulated/real');
  if (raw.repositoryInstance !== undefined) {
    const prefix = String(manifest?.repository ?? '').split('/')[0];
    fail(nonempty(instanceSlug) && raw.repositoryInstance === `${prefix}/${instanceSlug}`, 'repositoryInstance 必须绑定实际隔离仓实例');
    fail(raw.isolation?.isolated === true && raw.isolation?.sourceProductRepository === manifest?.repository, 'isolation 必须披露隔离及冻结的源产品 repository，不得改写产品 manifest');
  }

  const environment = object(raw.environment) ? raw.environment : {};
  fail(ENVIRONMENT_KINDS.includes(environment.kind), 'environment.kind 必须显式声明 local-preview/client-runtime/deployed');
  fail(typeof environment.allowWrites === 'boolean', 'environment.allowWrites 必须显式为布尔值，默认配置应为 false');
  fail(object(environment.target), 'environment.target 必须显式为目标 URL 对象');
  if (environment.kind === 'deployed') fail(nonempty(environment.target?.apiUrl), 'deployed 必须显式声明 environment.target.apiUrl');
  for (const [key, value] of Object.entries(object(environment.target) ? environment.target : {})) {
    fail(['apiUrl', 'pcUrl', 'bMobileUrl', 'cMobileUrl'].includes(key), `environment.target.${key} 不是已定义的端点`);
    if (value === null && key !== 'apiUrl') continue;
    try {
      const url = new URL(value);
      fail(typeof value === 'string' && value === value.trim() && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash, `environment.target.${key} 必须是无凭据、无查询参数的 HTTP(S) URL`);
    } catch { errors.push(`environment.target.${key} URL 无效`); }
  }
  fail(object(raw.identity) && nonempty(raw.identity.human), 'identity.human 必须声明受控成员号');
  fail(nonempty(raw.workspaceId) || nonempty(raw.identity?.workspaceSlug), '必须声明 workspaceId 或 identity.workspaceSlug');
  if (environment.kind === 'local-preview') {
    fail(raw.identity?.workspaceSlug === manifest?.demoWorkspaceSlug, 'local-preview identity.workspaceSlug 必须与 manifest.demoWorkspaceSlug 一致');
    fail(raw.identity?.human === manifest?.demoMemberNo, 'local-preview identity.human 必须与 manifest.demoMemberNo 一致');
  }
  fail(nonempty(raw.startup?.command), 'startup.command 必须声明本仓实际启动命令');
  const ports = raw.startup?.ports;
  fail(object(ports) && ['pc', 'bMobile', 'cMobile', 'server'].every((key) => Number.isSafeInteger(ports[key]) && ports[key] >= 1 && ports[key] <= 65535) && unique(Object.values(ports)), 'startup.ports 必须是互不冲突的四个有效整数端口');
  for (const key of ['pcRoutes', 'bMobileRoutes', 'cRoutes']) fail(Array.isArray(raw.surfaces?.[key]) && raw.surfaces[key].length > 0 && raw.surfaces[key].every((route) => nonempty(route) && (key === 'cRoutes' ? /^[/#]/.test(route) : route.startsWith('/'))), `surfaces.${key} 必须显式声明非空入口路径`);
  if (raw.thresholds !== undefined && !object(raw.thresholds)) errors.push('thresholds 必须是对象');
  for (const [key, value] of Object.entries(object(raw.thresholds) ? raw.thresholds : {})) {
    const floor = THRESHOLD_FLOORS[key];
    if (!floor) { warnings.push(`thresholds.${key} 是行业扩展阈值`); continue; }
    fail(Number.isFinite(value) && (floor.dir === 'max' ? value <= floor.value : value >= floor.value), `thresholds.${key} 无效或比基座下限 ${floor.value} 更宽松`);
  }

  const personas = array(raw.ux?.personas); const personaIds = new Set(personas.map((persona) => persona?.id));
  fail(personas.length > 0 && unique(personas.map((persona) => persona?.id)), 'ux.personas 必须声明非空、唯一用户模型');
  for (const persona of personas) fail(safeId(persona?.id) && ['P0', 'P1', 'P2'].includes(persona?.criticality) && array(persona?.jtbd).some(nonempty), 'ux.personas 必须含安全 id、criticality 与具体 jtbd');
  for (const [label, journeys] of [['journeys', raw.journeys], ['ux.journeys', raw.ux?.journeys]]) {
    fail(Array.isArray(journeys) && journeys.length > 0 && unique(journeys.map((journey) => journey?.id)), `${label} 必须显式声明非空、唯一旅程`);
    for (const journey of array(journeys)) {
      fail(safeId(journey?.id) && nonempty(journey?.title) && personaIds.has(journey?.persona), `${label} id/title/persona 引用无效`);
      fail(label === 'journeys' ? nonempty(journey?.script) : nonempty(journey?.stage), `${label} 缺脚本或阶段`);
    }
  }
  const uxTasks = array(raw.ux?.tasks);
  fail(uxTasks.length > 0 && unique(uxTasks.map((task) => task?.id)), 'ux.tasks 必须声明非空、唯一体验任务');
  for (const task of uxTasks) fail(safeId(task?.id) && personaIds.has(task?.persona) && ['P0', 'P1', 'P2'].includes(task?.criticality) && Number.isFinite(task?.budgetMs) && task.budgetMs > 0 && array(task?.paths).length > 0, 'ux.tasks 缺具体 id/persona/criticality/budgetMs/paths');

  const outcome = object(raw.outcome) ? raw.outcome : {};
  const roles = array(outcome.roles); const rolesByName = new Map(roles.map((role) => [role?.role, role]));
  fail(roles.length > 0 && rolesByName.size === roles.length, 'outcome.roles 必须声明非空、唯一行业交付岗位');
  for (const role of roles) {
    fail(nonempty(role?.role) && presetKeys.has(role?.agentPreset), 'outcome.roles.agentPreset 必须指向本仓主 Bundle 的真实 preset');
    fail(['AL0', 'AL1', 'AL2', 'AL3', 'AL4'].includes(role?.al) && nonempty(role?.deliverableUnit) && nonempty(role?.minSubstance), 'outcome.roles 缺 al/deliverableUnit/minSubstance 交付契约');
  }
  fail(nonempty(outcome.fixtureMarker) && nonempty(outcome.residualDisclosure), 'outcome.fixtureMarker/residualDisclosure 必须显式声明验收写入标记与残留');
  if (environment.allowWrites) fail(nonempty(outcome.fixtureMarker) && nonempty(outcome.residualDisclosure), 'allowWrites=true 缺 fixtureMarker/residualDisclosure');
  fail(array(raw.autonomy?.fixtureFilters).some((filter) => nonempty(filter) && String(outcome.fixtureMarker ?? '').startsWith(filter)), 'autonomy.fixtureFilters 必须排除本次行业验收 marker，避免污染 ADR/HIR');
  const declared = array(outcome.taskSuites);
  fail(declared.length > 0 && unique(declared) && declared.every(suitePath), 'outcome.taskSuites 必须声明唯一、仓内 acceptance/outcomes/*.yaml 任务路径');
  const supplied = new Map(suiteEntries.map((entry) => [entry.path, entry]));
  let taskCount = 0; let p0Count = 0; const ids = new Set();
  for (const path of declared) {
    const entry = supplied.get(path);
    if (!entry) { errors.push(`taskSuites 套件缺失：${path}`); continue; }
    if (entry.error) { errors.push(`taskSuites 套件无法解析：${path}（${entry.error}）`); continue; }
    const suite = entry.suite;
    errors.push(...validateSuite(suite, { presetKeys, requireScenarioMatrix: true }).map((error) => `${path}：${error}`));
    fail(rolesByName.has(suite?.role) && suite?.agentPreset === rolesByName.get(suite?.role)?.agentPreset, `${path} 岗位/preset 与 outcome.roles 不一致`);
    for (const task of array(suite?.tasks)) {
      taskCount += 1;
      fail(!ids.has(task?.id), `跨套件 task.id 重复：${task?.id}`); ids.add(task?.id);
      if ((task?.scenario ?? 'normal') === 'normal' && task?.criticality === 'P0') {
        p0Count += 1;
        fail(Number(task.trials ?? suite.trials ?? 5) >= 5, `${path} P0 代表任务必须声明 k≥5 的重复 trial`);
      }
    }
  }
  fail(p0Count > 0, 'taskSuites 必须包含至少一条 P0 正常行业代表任务');
  for (const entry of suiteEntries) fail(declared.includes(entry.path), `outcomes 中存在未声明套件：${entry.path}`);

  const live = raw.live;
  fail(object(live) && typeof live.enabled === 'boolean', 'live.enabled 必须显式声明');
  if (live?.enabled) {
    fail(Array.isArray(live.models) && Array.isArray(live.tasks) && live.tasks.length > 0 && unique(live.tasks.map((task) => task?.id)), 'live.models/tasks 必须为明确模型清单与非空唯一任务');
    for (const [key, value] of Object.entries(object(live.budgets) ? live.budgets : {})) if (Object.hasOwn(LIVE_BUDGET_FLOORS, key)) {
      const lower = key === 'minVideoSeconds';
      fail(Number.isFinite(value) && value > 0 && (lower ? value >= LIVE_BUDGET_FLOORS[key] : value <= LIVE_BUDGET_FLOORS[key]), `live.budgets.${key} 无效或放宽硬上限`);
    }
    const products = array(live.tasks).filter((task) => task?.kind === 'product');
    fail(products.length > 0, 'live.tasks 必须声明本行业产品入口任务，外部模型调用不能代替产品结果');
    for (const task of products) {
      const substantive = array(task.state_asserts).some((assertion) => nonempty(assertion?.event?.action) && field(assertion.event.field) && resultComparison(assertion.event));
      fail(safeId(task.id) && presetKeys.has(task.presetKey) && substantive && task.requireModel === true && nonempty(task.fixtureMarker) && nonempty(task.residualDisclosure) && String(task.input ?? task.title ?? '').includes(task.fixtureMarker), `live.${task.id ?? '?'} 缺真实 preset、具体事件结果、requireModel=true 或 fixtureMarker/residualDisclosure`);
    }
  } else warnings.push('live.enabled=false：未声明模型生产实测，本次仅能验证配置结构');
  warnings.push('结构校验不连接服务、数据库或模型；行业结果、生产环境和完整 276 项仍须实际执行并绑定证据。');
  return { errors, warnings, businessVerified: false, suiteCount: declared.length, taskCount };
}
