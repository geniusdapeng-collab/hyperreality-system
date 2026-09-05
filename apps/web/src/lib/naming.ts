/**
 * 数字员工命名规范（F-NAME2）——三层标识模型：ID · 岗位名 · 别名。
 *
 *   preset_key（ID，永不变，数据锚点）   requirement-analyst
 *   role_title（岗位名，bundle 声明）     需求分析官       ← 默认全界面显示
 *   alias（别名，members.alias 列）       小析（客户自定义）← 设了全覆盖显示
 *
 * 显示规则：displayNameOf() = alias ?? role_title ?? 旧人名兜底。
 * 兼容期：personaOf/staffTitle 保留——旧调用方（官衔·人名）行为不变，
 * 新调用方一律走 displayNameOf（岗位名/别名优先）。
 *
 * 概念关系（对外统一口径）：
 *   数字员工 = 组织里的「人」——有名字、有官衔、有形象、有编制；
 *   Agent    = 这名员工的执行本体（技术说法，界面不出现该词）；
 *   技能     = 员工学会的本事，可装配可卸载。
 * 界面上任何场景只出现「官衔」或「官衔·人名」，永不出现
 * 「xxx-Agent / 桌面Agent / 数字员工-01」这类抽象代号。
 *
 * 命名规则：
 *  1. 官衔：职能 + 官/员/师/长/总监（动宾结构，行业 bundle presets 的 name 字段承载）；
 *  2. 人名：2-3 字中文虚构名，无生僻字、无名人同名、无英文与数字；
 *  3. 确定性：同一 preset_key 永远同一人名（本表登记或哈希稳定生成）；
 *  4. 用户新增 / 系统自动生成员工时，由 personaOf() 依 preset_key 稳定分配，
 *     不会随机跳变；行业版可在 PERSONA_MAP 追加登记。
 */

/** preset_key → 人名（策划登记册；跨行业基座通用键在此登记） */
export const PERSONA_MAP: Record<string, string> = {
  // —— 基座通用七员 ——
  "competitor-agent": "沈听澜",
  "content-agent": "苏映雪",
  "desktop-agent": "程亦舟",
  "inspection-agent": "方既明",
  "pricing-agent": "陆则明",
  "reconcile-agent": "秦清晏",
  "review-agent": "林晚照",
  // —— 酒店域扩展 ——
  "frontdesk-agent": "温言之",
  "housekeeper-agent": "孟疏影",
  "phone-agent": "季云开",
  "owner-cockpit": "裴景深",
  "channel-watcher": "韩青梧",
  "guest-success": "唐见微",
  "groupbuy-agent": "宋知遥",
  "coupon-operator": "高致远",
  "ai-receptionist": "许知夏",
  "lead-concierge": "任则明",
  // —— 组织角色 ——
  "company-ceo": "顾云峥",
  captain: "周叙白",
};

/** 自动分配用名库（虚构常见姓 × 雅致双字名；登记册未收录时哈希稳定选取） */
const SURNAMES = [
  "沈", "顾", "陆", "程", "苏", "林", "周", "方", "孟", "韩",
  "温", "季", "裴", "唐", "宋", "秦", "许", "高", "任", "叶",
  "江", "贺", "纪", "白", "祁", "骆", "樊", "柳", "阮", "柯",
];
const GIVEN_NAMES = [
  "听澜", "清晏", "则明", "亦舟", "映雪", "晚照", "叙白", "既明",
  "疏影", "青梧", "言之", "云开", "景深", "见微", "知遥", "明舒",
  "望舒", "予安", "砚秋", "惊鸿", "栖迟", "南絮", "既白", "望之",
  "明玦", "疏桐", "霁川", "栖云", "照君", "闻笛", "疏雨", "静姝",
  "云飞", "采薇", "明轩", "清越", "观澜", "含章", "慕白", "芷宁",
];

/** djb2 稳定哈希 → 正整数 */
function stableHash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * 人名分配：登记册命中用登记名；未登记按 preset_key 哈希稳定生成
 * （同一 key 跨会话/跨设备同人名；无 key 时给中性兜底名）。
 */
export function personaOf(presetKey: string | null | undefined): string {
  if (!presetKey) return "云生";
  const hit = PERSONA_MAP[presetKey];
  if (hit) return hit;
  const h = stableHash(presetKey);
  const surname = SURNAMES[h % SURNAMES.length]!;
  const given = GIVEN_NAMES[Math.floor(h / SURNAMES.length) % GIVEN_NAMES.length]!;
  return `${surname}${given}`;
}

/**
 * 界面展示全衔：「官衔·人名」。
 * roleName 为官衔（agents.name / ACTOR_TEXT 输出），presetKey 用于取人名。
 * 已含「·」的名字（如情报官·核验）直接拼人名；空官衔只回人名。
 */
export function staffTitle(roleName: string | null | undefined, presetKey?: string | null): string {
  const persona = personaOf(presetKey);
  const role = (roleName ?? "").trim();
  if (!role) return persona;
  return `${role}·${persona}`;
}

/** 汇报视图短称：人名为主（团队列队/名牌场景，官衔以副标题呈现时用） */
export function shortName(presetKey?: string | null, fallback?: string): string {
  return presetKey ? personaOf(presetKey) : (fallback ?? "云生");
}

/* ================= F-NAME2 三层 API ================= */

/** 别名注册表（运行期由服务端 members.alias 注入；setAlias 写库后同步本表） */
const ALIAS_MAP = new Map<string, string>();

/** 服务端 members 列表注入（页面初始化时调用一次） */
export function hydrateAliases(rows: Array<{ presetKey?: string | null; alias?: string | null }>): void {
  ALIAS_MAP.clear();
  for (const r of rows) if (r.presetKey && r.alias) ALIAS_MAP.set(r.presetKey, r.alias);
}

/** 别名读取：未设置返回 null */
export function aliasOf(presetKey: string | null | undefined): string | null {
  return presetKey ? (ALIAS_MAP.get(presetKey) ?? null) : null;
}

/** 别名写入（本地注册表；落库由调用方经 members.updateAlias 端点完成） */
export function setAliasLocal(presetKey: string, alias: string | null): void {
  if (alias && alias.trim()) ALIAS_MAP.set(presetKey, alias.trim());
  else ALIAS_MAP.delete(presetKey);
}

/**
 * 岗位名解析（F-NAME2 默认显示名）。
 * 优先 ACTOR_TEXT/数据库 name（岗位名）；未知名称按 key 词表推断；最终兜底旧人名。
 */
export function roleTitleOf(roleName: string | null | undefined, presetKey?: string | null): string {
  const role = (roleName ?? "").trim();
  if (role) return role;
  if (presetKey) {
    const KEY_TITLE: Record<string, string> = {
      "competitor-agent": "市场侦察官", "content-agent": "内容主笔官", "desktop-agent": "数字执行官",
      "inspection-agent": "品质巡检官", "pricing-agent": "收益定价官", "reconcile-agent": "财务司库官",
      "review-agent": "口碑公关官", "frontdesk-agent": "前台接待官", "housekeeper-agent": "客房管家官",
      "phone-agent": "语音前台官", "company-ceo": "数字总经理", "captain": "船长",
    };
    const hit = KEY_TITLE[presetKey];
    if (hit) return hit;
  }
  return personaOf(presetKey);
}

/**
 * 全界面统一显示名（F-NAME2 唯一入口）：
 *   别名（客户自定义）> 岗位名（bundle 声明/词表）> 旧人名（兜底）
 */
export function displayNameOf(opts: {
  presetKey?: string | null;
  roleName?: string | null;
}): string {
  const alias = aliasOf(opts.presetKey);
  if (alias) return alias;
  return roleTitleOf(opts.roleName, opts.presetKey);
}

/* ================= F-REPORT1 晨报汇报规则 ================= */

/**
 * 汇报全衔（晨报语音/字幕口径）：
 *  - 用户设了别名 → 「岗位名·别名」完整报出（如「需求分析官·小析」）；
 *  - 未设别名 → 只报岗位名/角色名（如「需求分析官」）；
 *  - 绝不报系统默认人名（personaOf 生成名仅作界面旧兼容，不进汇报）。
 */
export function reportTitleOf(roleName: string | null | undefined, presetKey?: string | null): string {
  const role = roleTitleOf(roleName, presetKey);
  const alias = aliasOf(presetKey);
  return alias ? `${role}·${alias}` : role;
}

/** 关键岗位（部门经理级——每日必同步信息）：按岗位名词表判定 */
const KEY_POSITION_RE = /经理|总监|总管|参谋|指挥|守护|护航|船长|总经理|掌柜|管家官?$/;

/**
 * 晨报汇报人遴选：CEO 先汇报（调用方保证），随后不必全员——
 *  ① 有事要汇报的（最新评级异常 grade!=='正常'）；
 *  ② 关键岗位（部门经理级，每日必同步）；
 * 合并去重、异常优先，上限 max 名保持晨节拍（七八十名员工不全上）。
 */
export function selectReporters<T extends { name?: string | null; grade?: string }>(agents: T[], max = 8): T[] {
  const abnormal = agents.filter((a) => (a.grade ?? "正常") !== "正常");
  const keyPositions = agents.filter((a) => (a.grade ?? "正常") === "正常" && KEY_POSITION_RE.test((a.name ?? "").trim()));
  return [...abnormal, ...keyPositions].slice(0, max);
}
