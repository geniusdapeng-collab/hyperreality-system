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
  "ceo.board_pack": "董事会简报",
  "im.outbound": "外发消息",
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
  const hit = ACTION_TEXT[action] ?? ACTION_TEXT_EXT[action] ?? ACTION_OPS_TEXT[action];
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

// —— 行动者/员工代号 → 中文名（F-CN1：界面不出现 reconcile-agent/guest-success 这类原始 ID）——
/** preset_key / actor id → 中文名。成员编号（MEM-xxx）与事件编号（E-xxx）属代号，原样保留 */
export const ACTOR_TEXT: Record<string, string> = {
  // 酒店域
  "reconcile-agent": "财务司库官",
  "competitor-agent": "市场侦察官",
  "channel-watcher": "渠道哨兵官",
  "ai-receptionist": "智能接待官",
  "pm-staff-officer": "产品参谋官",
  "requirement-analyst": "需求分析官",
  "competitor-scout": "竞品侦察官",
  "data-insight": "数据洞察官",
  "user-listener": "用户倾听官",
  "doc-writer": "文档主笔官",
  "industry-radar": "行业瞭望官",
  "release-guardian": "发布护航官",
  "content-agent": "内容主笔官",
  "voice-front-agent": "语音前台官",
  "guest-success": "住客满意官",
  "owner-cockpit": "业主驾驶舱",
  "groupbuy-agent": "团购运营官",
  "pricing-agent": "收益定价官",
  "desktop-agent": "数字执行官",
  "review-agent": "口碑公关官",
  "coupon-operator": "优惠券运营官",
  "lead-concierge": "线索管家官",
  "company-ceo": "公司CEO",
  captain: "编排官",
  "im-channels": "IM 渠道",
  system: "系统",
  "night-shift": "夜班中心",
  "morning-briefing": "夜班晨报",
  "inspection-agent": "品质巡检官",
  // 视频域常见
  director: "总导演",
  producer: "制片人",
  editor: "剪辑师",
  renderer: "渲染师",
  publisher: "发布专员",
  "data-analyst": "数据看板官",
  "script-writer": "剧本师",
};

/**
 * 行动者人性化：先查表；未收录的 xxx-agent 去后缀查词根；MEM-/E-/T- 等编号原样；
 * 其余下划线/连字符串转空格分词（永不裸奔原始 ID）
 */
export function actorText(id: string): string {
  if (!id) return "—";
  const hit = ACTOR_TEXT[id];
  if (hit) return hit;
  if (/^(MEM|E|T|VID|R|G)-/.test(id)) return id; // 编号类保留
  if (id.endsWith("-agent")) {
    const root = id.slice(0, -6);
    // 未收录岗位：词根转空格+"数字员工"（界面不出现英文 Agent 后缀）
    return ACTOR_TEXT[root] ? `${ACTOR_TEXT[root]}` : `${root.replace(/[-_]/g, " ")} · 数字员工`;
  }
  return id.replace(/[-_]/g, " ");
}

/** 夜班/运营高频动作码补录（F-CN1） */
export const ACTION_OPS_TEXT: Record<string, string> = {
  // 夜班/运营高频动作码（点式全量，F-CN1；与种子/套件动作码对齐）
  "approval.gesture": "审批手势",
  "ask.answer": "问询应答",
  "audience.segment": "客群分群",
  "booking.confirm": "订单确认",
  "campaign.publish": "活动发布",
  "campaign.schedule": "活动排期",
  "competitor.fetch": "竞对抓取",
  "content.publish": "内容发布",
  "conversion.attribute": "成交归因",
  "coupon.create": "创建券",
  "coupon.promote": "券推广",
  "funnel.weekly": "漏斗周报",
  "geo.publish": "GEO 发布",
  "guest.care.send": "住客关怀",
  "inspection.scan": "巡检扫描",
  "intent.radar.report": "意图雷达播报",
  "lead.assign": "线索分派",
  "lead.capture": "线索捕获",
  "lead.nurture": "线索培育",
  "live.campaign": "直播活动",
  "market.scan": "市场扫描",
  "member.referral": "会员转介绍",
  "memory.consolidate": "记忆整理",
  "night.package.deliver": "夜班日报投递",
  "night.run.start": "夜班开始",
  "order.reconcile": "对账核销",
  "order.refund": "订单退款",
  "render.review": "渲染审片",
  "review.asset.boost": "好评加热",
  "review.reply": "回复评价",
  "script.draft": "脚本起草",
  "strategy.memo": "策略备忘",
  "thread.dispatch": "任务派发",
  "visibility.snapshot": "曝光快照",
  // 裸词别名（历史数据兼容）
  reconcile: "对账核销",
  fetch: "竞对抓取",
  send: "发送",
  answer: "即时应答",
  dispatch: "任务派发",
  boost: "加热推广",
  weekly: "周报汇总",
  attribute: "成交归因",
  referral: "转介绍跟进",
  "morning-briefing": "晨报",
  consolidate: "记忆整理",
  deliver: "夜班投递",
  start: "开始",
  scan: "巡检扫描",
};

/** 行动载荷人性化：常见 JSON 键 → 中文键值对；非对象原样返回（F-CN1） */
const PAYLOAD_KEY_TEXT: Record<string, string> = {
  diff: "差异", rounds: "轮次", card: "竞对", price: "价格", sku: "单品", count: "数量",
  note: "备注", occ: "入住率", revpar: "RevPAR", adr: "均价", score: "评分", status: "状态",
};
export function payloadText(after: unknown, maxLen = 160): string {
  if (after == null) return "";
  if (typeof after !== "object") return String(after).slice(0, maxLen);
  const parts = Object.entries(after as Record<string, unknown>).map(([k, v]) => {
    const key = PAYLOAD_KEY_TEXT[k] ?? k;
    const val = typeof v === "object" ? JSON.stringify(v) : String(v);
    return `${key} ${val}`;
  });
  return parts.join(" · ").slice(0, maxLen);
}
