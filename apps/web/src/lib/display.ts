/**
 * 展示字典层（B 端界面统一口径）——系统枚举 / 动作码 / 技术 ID / cron → 中文展示名。
 *
 * 根因修复（高保真走查：界面裸奔英文字段名与代码）：
 * 页面组件不得直接渲染系统原始值（status/kind/action/cron/技术 ID），
 * 一律经本层映射；未收录的值走兜底人性化处理，保证任何情况下不出现
 * 「processing / render.submit / 0 8 * * *」这类原始串直接上屏。
 *
 * 扩展纪律：基座只保留公共术语；行业岗位、动作与字段显示名必须通过
 * 当前已验签 Bundle 的 terminology 投影注入，禁止在客户端追加行业词表。
 */
import { clientChineseText, clientFieldLabel, clientStatusLabel, clientValueText, registerClientSafeTerms } from "@workloom/ui";

let DISPLAY_TERMINOLOGY: Readonly<Record<string, string>> = {};

/** 身份或工作区切换时由导航上下文原子替换，不能累加，以免跨租户串用术语。 */
export function hydrateDisplayTerminology(terminology: Record<string, string>): void {
  DISPLAY_TERMINOLOGY = Object.freeze(Object.fromEntries(
    Object.entries(terminology).filter(([, value]) => clientChineseText(value, "") === value.trim()),
  ));
}

/**
 * 行业术语白名单随装配投影注入（`ui.safeTerms`）：行业通用缩写与品牌词在
 * 中文显示边界内放行，其它规则不变。切换身份/工作区时必须传空数组清空。
 */
export function hydrateClientSafeTerms(terms: readonly string[] | undefined): void {
  registerClientSafeTerms(terms ?? []);
}

/**
 * 剔除术语串里的拉丁技术记号（SOP / RPA / PRD / eval / gh API / v1 …）。
 * clientChineseText 遇到夹带技术记号的串会**整串回落**，技能名就会裸奔成
 * 「dev-dispatch」「prd-forge」这类内部 id（真机验收实测：基座技能中心 20 项里 13 项）。
 */
function stripTechnicalTokens(value: string): string {
  return value
    .replace(/[A-Za-z][A-Za-z0-9._+/'-]*/g, " ")
    .replace(/[\s·—–-]+/g, " ")
    .trim();
}

/** 必须给中文名的场景：先按原串过词典（保留 GEO 这类词典认可的行业词），被拒再剔除记号重试 */
export function chineseDisplayName(value: string | null | undefined, fallback: string): string {
  const raw = (value ?? "").trim();
  if (!raw) return fallback;
  const kept = clientChineseText(raw, "");
  if (kept) return kept;
  const cleaned = stripTechnicalTokens(raw);
  if (cleaned) {
    const accepted = clientChineseText(cleaned, "");
    if (accepted) return accepted;
  }
  return fallback;
}

/**
 * 技能展示名（Bundles 技能口径）：优先从技能说明首段解析中文名。
 * 首段分隔符覆盖行业写作习惯：。「」（）以及破折号「——」（ai-pm 技能大量用破折号）；
 * 首段夹带技术记号时先剔除再取，避免整串回落成裸 id。
 * 行业词表仍由各 Bundle 的技能正文提供，客户端不新增行业词汇（本文件顶部扩展纪律）。
 */
export function skillDisplayName(name: string, description?: string | null): string {
  const text = (description ?? "").trim();
  if (text) {
    const m = /^([^（(。：:—]{2,40})[（(。：:—]/.exec(text);
    const candidate = m?.[1]?.trim();
    if (candidate) {
      const resolved = chineseDisplayName(candidate, "");
      if (resolved) return resolved;
    }
    /**
     * 长说明兜底（RDAS v3.0 实测：badcase-harvest / model-scout 首段 >40 字导致整串回落成裸 id）：
     * 按句号/分号/破折号切第一段，再取第一个逗号前的短句；剔除技术记号与符号后必须是中文。
     */
    const first = text.split(/[。；;！!？?\n]|——/)[0]?.trim() ?? "";
    const clause = (first.split(/[，,]/)[0] ?? first)
      .replace(/[+/*#_|]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 32);
    const resolved = clause ? chineseDisplayName(clause, "") : "";
    if (resolved) return resolved;
  }
  return chineseDisplayName(name, name);
}

function projectedText(key: string): string | undefined {
  return DISPLAY_TERMINOLOGY[key];
}

// —— 工单域 ——
export const TICKET_STATUS_TEXT: Record<string, string> = {
  created: "已受理",
  assigned: "已分派",
  processing: "处理中",
  done: "已完成",
  closed: "已关闭",
};

export const TICKET_KIND_TEXT: Record<string, string> = {
  delivery: "送物服务",
  repair: "维修报修",
  complaint: "投诉建议",
  other: "其他需求",
  service_request: "服务请求",
};

export const TICKET_PRIORITY_TEXT: Record<string, string> = {
  normal: "普通",
  high: "加急",
  urgent: "紧急",
};

export const TICKET_ACTOR_TEXT: Record<string, string> = {
  c_user: "客户",
  staff: "员工",
  agent: "AI 员工",
  system: "系统",
};

// —— 知识库域 ——
export const DOC_STATUS_TEXT: Record<string, string> = {
  active: "生效中",
  disabled: "已停用",
  pending_review: "待审核",
};

export const SOURCE_KIND_TEXT: Record<string, string> = {
  upload: "文档上传",
  official_site: "官网抓取",
  manual: "手工录入",
};

// —— 审批域 ——
export const APPROVAL_STATUS_TEXT: Record<string, string> = {
  pending: "待审批",
  approved: "已批准",
  rejected: "已驳回",
  edited: "已改派",
  escalated: "已升级",
};

export const APPROVAL_GESTURE_TEXT: Readonly<Record<string, string>> = {
  approve: "已批准",
  edit: "已修改后批准",
  reject: "已驳回",
};

export function approvalGestureText(value: string | null | undefined): string {
  return value ? (APPROVAL_GESTURE_TEXT[value] ?? "审批已处理") : "审批已处理";
}

// —— 对话意图 ——
export const INTENT_TEXT: Record<string, string> = {
  chat: "闲聊",
  kb_qa: "知识问答",
  biz_query: "业务查询",
  service_request: "服务请求",
  complaint: "投诉",
};

// —— 围栏级别 ——
export const FENCE_LEVEL_TEXT: Record<string, string> = {
  auto: "自动放行",
  review: "人工复核",
  block: "硬阻断",
};

// —— 通用状态 ——
export const COMMON_STATUS_TEXT: Record<string, string> = {
  active: "运行中",
  paused: "已暂停",
  open: "进行中",
  running: "进行中",
  completed: "已完成",
  failed: "已失败",
  cancelled: "已驳回终止",
  draft: "草稿",
  submitted: "已提交",
  scheduled: "已排期",
  published: "已发布",
  archived: "已归档",
  delivered: "已送达",
  sent: "已发送",
  replied: "已回复",
  blocked: "已隔离",
  pending: "待处理",
  pending_review: "待审查",
  pending_approval: "待审批",
  expired: "已过期",
  rolled_back: "已回滚",
  ready: "就绪",
  queued: "排队中",
  unverified: "待核实",
  synced: "已同步",
};

export const RULE_RESULT_TEXT: Record<string, string> = {
  pass: "已放行",
  allow: "已放行",
  review: "待人工复核",
  block: "已阻断",
  blocked: "已阻断",
  deny: "已阻断",
};

export const MODEL_TIER_TEXT: Record<string, string> = {
  economy: "经济档",
  standard: "标准档",
  premium: "高能力档",
  human: "人工处理",
};

export const MODEL_WINDOW_TEXT: Record<string, string> = {
  "off-peak": "低峰时段",
  peak: "高峰时段",
  realtime: "实时",
};

export const MEMBER_ROLE_TEXT: Record<string, string> = {
  owner: "负责人",
  manager: "管理员",
  approver: "审批人",
  member: "成员",
  readonly: "只读成员",
  partner: "合作伙伴",
};

export const OBJECT_TYPE_TEXT: Record<string, string> = {
  thread: "任务",
  approval: "审批事项",
  rule: "规则",
  member: "成员",
  agent: "数字员工",
  memory: "组织经验",
  ticket: "服务工单",
  workspace: "工作区",
};

export const CAPABILITY_TEXT: Record<string, string> = {
  "ticket.handle": "工单处理",
  "ops.execute": "日常执行",
  "report.view": "经营报表",
  "deliverable.view": "交付物查看",
  "workorder.self": "仅本人工单",
  "read:*": "只读访问",
  "write:*": "业务写入",
};

export function capabilityText(value: string): string {
  return CAPABILITY_TEXT[value] ?? "受限能力";
}

// —— 线程模式 ——
export const THREAD_MODE_TEXT: Record<string, string> = {
  quest: "主线任务",
  ask: "问询",
  agent: "委托执行",
};

/** 动作码 → 中文（底座通用域） */
export const ACTION_TEXT: Record<string, string> = {
  "memory.upsert": "更新组织经验",
  // 夜班
  "night.note": "夜班记录",
  "night.package": "生成夜班日报",
  "night.handoff": "夜班交接",
  "trigger.fired": "触发定时任务",
  // 服务前台
  "service.ticket.create": "创建工单",
  "service.ticket.assign": "分派工单",
  "service.ticket.advance": "推进工单",
  "service.ticket.complete": "办结工单",
  "service.ticket.escalate": "工单超时升级",
  "service.ticket.rate": "工单满意度评价",
  "service.chat": "服务前台对话",
  "kb.publish": "发布知识文档",
  "kb.collection": "新建知识集合",
  "kb.document": "知识文档入库",
  "kb.search": "检索知识库",
  "kb.crawl": "抓取官网建库",
  // 公司负责人
  "ceo.briefing": "公司负责人晨报",
  "ceo.decision": "公司负责人决策",
  "ceo.board_pack": "董事会简报",
  "im.outbound": "外发消息",
  "captain.decision": "公司负责人决策",
  "captain.grant": "签署授权宪章",
  "captain.transit": "宪章状态流转",
};

const ACTION_PART_TEXT: Record<string, string> = {
  create: "创建",
  assign: "分派",
  advance: "推进",
  complete: "办结",
  escalate: "升级",
  submit: "提交",
  approve: "审批",
  publish: "发布",
  update: "更新",
  confirm: "确认",
  query: "查询",
  adjust: "调整",
  reply: "回复",
  fetch: "抓取",
  reconcile: "核销",
  consolidate: "整理",
  dispatch: "派发",
  send: "发送",
  boost: "加热",
  attribute: "归因",
  scan: "扫描",
  capture: "捕获",
  nurture: "培育",
  promote: "推广",
  report: "播报",
  snapshot: "快照",
  gesture: "手势",
  segment: "分群",
  draft: "起草",
  memo: "备忘",
  refund: "退款",
  deliver: "投递",
};

/** 动作码人性化：先查表，未收录则按「域·动作」末段翻译兜底，永不裸奔原始码 */
export function actionText(action: string): string {
  const hit = projectedText(`action.${action}`) ?? ACTION_TEXT[action] ?? ACTION_OPS_TEXT[action];
  if (hit) return hit;
  const parts = action.split(".");
  const tail = parts[parts.length - 1] ?? action;
  return ACTION_PART_TEXT[tail] ?? "系统操作";
}

/** 枚举通用展示：给定字典与值，未收录时把下划线串转为空格分词（小字展示，不用英文全大写） */
export function dictText(dict: Record<string, string>, value: string | null | undefined): string {
  if (!value) return "—";
  if (dict[value]) return dict[value]!;
  if (/[^\u0000-\u007f]/.test(value)) return clientChineseText(value, "待确认");
  if (/^(MEM|E|T|VID|R|G)-/.test(value)) return "待确认";
  return clientStatusLabel(value) === value ? "待确认" : clientStatusLabel(value);
}

/** 技术 ID 友好化：tck-seed-001 → ···001；apr-e-9064 → ···9064；无可提取尾号则原样 */
export function shortId(id: string | null | undefined): string {
  if (!id) return "—";
  const m = id.match(/(\d+)$/);
  return m ? `···${m[1]}` : "编号已记录";
}

/** 版本标识只呈现人类可读序号；包名、哈希和内部路径不得直接释放到客户端。 */
export function versionText(value: string | null | undefined): string {
  if (!value) return "版本待确认";
  const match = value.match(/(?:^|[\/_-])v?(\d+(?:\.\d+)*)$/i) ?? value.match(/^v?(\d+(?:\.\d+)*)$/i);
  if (match?.[1]) return `第 ${match[1]} 版`;
  return clientChineseText(value, "版本已记录");
}

/** 定时表达式 → 中文读法；未知表达式不向普通客户端泄露底层语法。 */
export function cronText(expr: string): string {
  const known: Record<string, string> = {
    "*/30 * * * *": "每 30 分钟",
    "0 * * * *": "每小时整点",
    "0 */2 * * *": "每 2 小时",
    "0 */4 * * *": "每 4 小时",
    "0 3 * * *": "每天 03:00",
    "0 4 * * *": "每天 04:00",
    "0 8 * * *": "每天 08:00",
    "30 8 * * *": "每天 08:30",
    "0 18 * * *": "每天 18:00",
    "0 4 * * 0": "每周日 04:00",
  };
  if (known[expr]) return known[expr];
  // 通用解析：0 H * * * → 每天 HH:00；M H * * * → 每天 HH:MM
  const daily = expr.match(/^(\d{1,2}) (\d{1,2}) \* \* \*$/);
  if (daily) return `每天 ${daily[2]!.padStart(2, "0")}:${daily[1]!.padStart(2, "0")}`;
  const hourly = expr.match(/^\*\/(\d+) \* \* \* \*$/);
  if (hourly) return `每 ${hourly[1]} 分钟`;
  return "自定义执行计划";
}

/** 置信度 → 中文档位 */
export function confidenceText(score: number | null | undefined): string {
  if (score == null) return "—";
  if (score >= 0.72) return "高置信";
  if (score >= 0.45) return "中置信";
  return "低置信";
}

/** 延迟毫秒 → 友好读法 */
export function latencyText(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)} 毫秒`;
  return `${(ms / 1000).toFixed(1)} 秒`;
}

// —— 行动者/员工代号 → 中文名（F-CN1：界面不出现 reconcile-agent/guest-success 这类原始 ID）——
/** preset_key / actor id → 中文名。成员编号（MEM-xxx）与事件编号（E-xxx）属代号，原样保留 */
export const ACTOR_TEXT: Record<string, string> = {
  "company-ceo": "公司负责人",
  captain: "编排官",
  "im-channels": "IM 渠道",
  system: "系统",
  "night-shift": "夜班中心",
  "morning-briefing": "夜班晨报",
};

/**
 * 行动者人性化：先查表；未收录的 xxx-agent 去后缀查词根；
 * 其余标识仅在通过中文边界后展示（永不裸奔原始 ID）。
 */
export function actorText(id: string): string {
  if (!id) return "—";
  const hit = projectedText(`actor.${id}`) ?? ACTOR_TEXT[id];
  if (hit) return hit;
  if (/^(MEM|E|T|VID|R|G)-/.test(id)) return "系统成员";
  if (id.endsWith("-agent")) {
    const root = id.slice(0, -6);
    return projectedText(`actor.${root}`) ?? ACTOR_TEXT[root] ?? "数字员工";
  }
  return clientChineseText(id, "系统成员");
}

/** 夜班/运营高频动作码补录（F-CN1） */
export const ACTION_OPS_TEXT: Record<string, string> = {
  // 基座公共动作码；行业动作从 Bundle 术语投影读取。
  "approval.gesture": "审批手势",
  "ask.answer": "问询应答",
  "memory.consolidate": "记忆整理",
  "night.package.deliver": "夜班日报投递",
  "night.run.start": "夜班开始",
  "strategy.memo": "策略备忘",
  "thread.dispatch": "任务派发",
  // 裸词别名（历史数据兼容）
  send: "发送",
  answer: "即时应答",
  dispatch: "任务派发",
  weekly: "周报汇总",
  "morning-briefing": "晨报",
  consolidate: "记忆整理",
  deliver: "夜班投递",
  start: "开始",
  scan: "扫描检查",
};

/** 行动载荷人性化：常见 JSON 键 → 中文键值对；非对象原样返回（F-CN1） */
const PAYLOAD_KEY_TEXT: Record<string, string> = {
  diff: "差异", rounds: "轮次", card: "竞对", price: "价格", sku: "单品", count: "数量",
  note: "备注", score: "评分", status: "状态",
  title: "标题", text: "内容", summary: "摘要", gesture: "审批动作", reason: "原因",
  mode: "任务方式", result: "结果", verdict: "结论", provider: "模型服务", model: "模型",
  credits: "积分", tier: "能力档位", window: "调用时段", link: "关联入口", url: "地址",
};

function payloadValueText(value: unknown, depth = 0): string {
  if (value == null || value === "") return "暂无";
  if (typeof value !== "object") return clientValueText(value);
  if (depth >= 2) return clientValueText(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "暂无";
    const shown = value.slice(0, 4).map((item) => payloadValueText(item, depth + 1));
    return `${shown.join("、")}${value.length > shown.length ? `等 ${value.length} 项` : ""}`;
  }
  const entries = Object.entries(value as Record<string, unknown>).slice(0, 6);
  if (entries.length === 0) return "暂无";
  return entries.map(([key, nested]) => {
    const label = projectedText(`field.${key}`) ?? PAYLOAD_KEY_TEXT[key] ?? clientFieldLabel(key, { fallbackLabel: "补充信息" });
    return `${label}：${payloadValueText(nested, depth + 1)}`;
  }).join("；");
}

export function payloadText(after: unknown, maxLen = 160): string {
  if (after == null) return "";
  return payloadValueText(after).slice(0, maxLen);
}

/**
 * 数字职场「头顶气泡」文案（D25）：服务端的 statusLine 形如
 * 「最近：competitor.fetch」「请示待裁：price.adjust」，前缀是中文状态、
 * 后半段是内部动作码。动作码必须先经动作字典，否则中文显示边界会把整句
 * 回落成「当前状态待确认」（RDAS 实测：职场气泡 5/11 位员工不可读）。
 */
const FLOOR_STATUS_PREFIX = /^(请示待裁|遇阻|刚完成|最近)：(.+)$/;

export function floorStatusText(line: string | null | undefined, fallback: string): string {
  const raw = (line ?? "").trim();
  if (!raw) return fallback;
  const matched = FLOOR_STATUS_PREFIX.exec(raw);
  if (matched?.[1] && matched[2]) {
    return `${matched[1]}：${actionText(matched[2].trim())}`;
  }
  return clientChineseText(raw, fallback);
}
