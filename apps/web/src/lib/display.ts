/**
 * 展示字典层（B 端界面统一口径）——系统枚举 / 动作码 / 技术 ID / cron → 中文展示名。
 *
 * 根因修复（高保真走查：界面裸奔英文字段名与代码）：
 * 页面组件不得直接渲染系统原始值（status/kind/action/cron/技术 ID），
 * 一律经本层映射；未收录的值走兜底人性化处理，保证任何情况下不出现
 * 「processing / render.submit / 0 8 * * *」这类原始串直接上屏。
 *
 * 扩展纪律：新域（新工单类型/新动作码）落地时同步登记本表；行业版在
 * ACTION_TEXT_EXT 追加行业动作码即可，无需改组件。
 */

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
  c_user: "住客",
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
};

// —— 线程模式 ——
export const THREAD_MODE_TEXT: Record<string, string> = {
  quest: "主线任务",
  ask: "问询",
  agent: "委托执行",
};

/** 动作码 → 中文（底座通用域） */
export const ACTION_TEXT: Record<string, string> = {
  // 经营动作
  "price.adjust": "调整房价",
  "price.query": "查询房价",
  "comment.reply": "回复评论",
  "memory.upsert": "更新组织记忆",
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
  // CEO
  "ceo.briefing": "CEO 晨报",
  "captain.decision": "CEO 决策",
  "captain.grant": "签署授权宪章",
  "captain.transit": "宪章状态流转",
};

/** 行业扩展动作码（视频域等；行业版可在此追加，组件零改动） */
export const ACTION_TEXT_EXT: Record<string, string> = {
  "render.submit": "提交渲染",
  "render.approve": "审批渲染",
  "publish.post": "发布内容",
  "publish.quota": "发布配额",
  "script.update": "更新渲染脚本",
  "comment.monitor": "评论监控",
  "deal.quote": "商单报价",
  "dossier.confirm": "确认情报档案",
  "theme.select": "选定主题方向",
  "prd.confirm": "确认产品需求",
  "prompt_package.confirm": "确认镜头提示词",
  "portrait_set.confirm": "确认定妆照",
  "pipeline.started": "启动制作管线",
  "pipeline.gate": "管线质量门",
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
};

/** 动作码人性化：先查表，未收录则按「域·动作」末段翻译兜底，永不裸奔原始码 */
export function actionText(action: string): string {
  const hit = ACTION_TEXT[action] ?? ACTION_TEXT_EXT[action];
  if (hit) return hit;
  const parts = action.split(".");
  const tail = parts[parts.length - 1] ?? action;
  return ACTION_PART_TEXT[tail] ?? tail.replace(/_/g, " ");
}

/** 枚举通用展示：给定字典与值，未收录时把下划线串转为空格分词（小字展示，不用英文全大写） */
export function dictText(dict: Record<string, string>, value: string | null | undefined): string {
  if (!value) return "—";
  return dict[value] ?? value.replace(/_/g, " ");
}

/** 技术 ID 友好化：tck-seed-001 → ···001；apr-e-9064 → ···9064；无可提取尾号则原样 */
export function shortId(id: string | null | undefined): string {
  if (!id) return "—";
  const m = id.match(/(\d+)$/);
  return m ? `···${m[1]}` : id;
}

/** cron → 中文读法（覆盖系统内全部实际用到的表达式；未知表达式兜底原样） */
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
  return expr;
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
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
