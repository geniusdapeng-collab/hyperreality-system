/**
 * Drizzle schema —— 类型源（D5 式纪律：DDL 事实源是 migrations/0001_init.sql 手写 SQL，
 * 本文件仅镜像其结构供类型化查询；两者必须同步演进）。
 * 表注释回引 PRD V2.5 编号。共 18 表（总纲 §3）。
 */
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  vector,
} from "drizzle-orm/pg-core";

/* ---------- 组织模型（M7） ---------- */

export const tenants = pgTable("tenants", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** 版本能力矩阵 F7.2：community / pro / teams / vpc */
  plan: text("plan").notNull().default("pro"),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const workspaces = pgTable("workspaces", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  /** 行业 bundle 名：hotel / marketing / ...（§2.2 装配槽） */
  industry: text("industry").notNull().default("hotel"),
  /** 经营阶段（枚举行业化，bundles/hotel/schemas/stages.json） */
  stage: text("stage"),
  /** 夜班配置 F4.8：{ enabled, startTime, packageTime, candidateTime, timezone } */
  nightConfig: jsonb("night_config").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** 人类成员（F5.6 三端权限一致） */
export const members = pgTable(
  "members",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    /** 业务可读编号 MEM-041 */
    memberNo: text("member_no").notNull(),
    name: text("name").notNull(),
    /** owner / manager / readonly / group / channel */
    role: text("role").notNull().default("readonly"),
    /** IM 通道 openid 映射（E5.2：转发卡片被非授权人点击无效） */
    imOpenids: jsonb("im_openids").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("members_ws_no_uniq").on(t.workspaceId, t.memberNo)],
);

/** Agent preset 实例（IM.5 一等公民；F2.10 未声明围栏禁写） */
export const agents = pgTable("agents", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  /** preset 标识：pricing-agent 等（bundles/hotel/presets） */
  presetKey: text("preset_key").notNull(),
  name: text("name").notNull(),
  /** who.version 归因必需 */
  version: text("version").notNull(),
  kind: text("kind").notNull(),
  /** 只读 preset（L9.1：巡检/竞对无写工具） */
  readonly: boolean("readonly").notNull().default(false),
  /** 围栏绑定声明（F2.10 加载时强制校验） */
  fenceBindings: jsonb("fence_bindings").notNull().default([]),
  skills: jsonb("skills").notNull().default([]),
  /** ready / disabled / invalid（校验失败标红，P8 错误态） */
  status: text("status").notNull().default("ready"),
  invalidReason: text("invalid_reason"),
  meta: jsonb("meta").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ---------- 消息总线层（M1） ---------- */

/** 一 X 一档（槽①；forbidden 硬约束优先级最高 L1.6；pii_vault F1.10） */
export const profiles = pgTable("profiles", {
  workspaceId: text("workspace_id").primaryKey().references(() => workspaces.id),
  tenantId: text("tenant_id").notNull().references(() => tenants.id),
  industry: text("industry").notNull(),
  archive: jsonb("archive").notNull(),
  forbidden: jsonb("forbidden").notNull().default([]),
  /** AES-256-GCM 密文位；密钥本地保管、半年轮换（阶段二实现） */
  piiVault: jsonb("pii_vault"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * 五元事件库（M1 本体：消息总线）
 * append-only：DB 层触发器禁 UPDATE/DELETE（L1.1）；仅 workloom_gateway 角色可 INSERT（F1.2）；
 * UNIQUE(tenant_id,event_id) 幂等丢弃（L1.4）；prev_hash/hash sha256 链防篡改（技术新增量 A1）。
 */
export const bizEvents = pgTable(
  "biz_events",
  {
    seq: bigserial("seq", { mode: "bigint" }).primaryKey(),
    eventId: text("event_id").notNull(),
    tenantId: text("tenant_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    /** 与线程关联键（会话=线程，IM.3） */
    sessionId: text("session_id"),
    /** 完整五元消息（packages/shared/event-schema.ts 校验） */
    payload: jsonb("payload").notNull(),
    prevHash: text("prev_hash").notNull(),
    hash: text("hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("biz_events_tenant_event_uniq").on(t.tenantId, t.eventId),
    index("idx_events_ws_time").on(t.workspaceId, t.createdAt),
  ],
);

/** 组织统一记忆（F1.4 三级作用域 + 归因；脱敏后回流 F1.8） */
export const orgMemory = pgTable("org_memory", {
  memoryId: text("memory_id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  workspaceId: text("workspace_id").notNull(),
  /** workspace / agent / run */
  scope: text("scope").notNull(),
  /** preference / pattern / sop / forbidden */
  kind: text("kind").notNull(),
  /** 脱敏后的模式化结论 */
  content: text("content").notNull(),
  embedding: vector("embedding", { dimensions: 1536 }),
  /** 来源事件 ID 列表（归因） */
  sourceEvents: text("source_events").array().notNull().default([]),
  confidence: real("confidence").notNull().default(0.5),
  /** active / superseded / recalled */
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** 记忆使用归因：哪次决策用了哪条记忆（F1.4） */
export const memoryUsage = pgTable(
  "memory_usage",
  {
    memoryId: text("memory_id").notNull().references(() => orgMemory.memoryId),
    eventId: text("event_id").notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }).notNull().defaultNow(),
    /** M3/M4：RLS 入列（见 0013 迁移；历史行可为 NULL，新写入必带） */
    workspaceId: text("workspace_id"),
  },
  (t) => [primaryKey({ columns: [t.memoryId, t.eventId] })],
);

/* ---------- 行动权限层（M2） ---------- */

/** 围栏规则（版本化 F2.4；is_baseline 单调守卫 F2.3；workspace_id='*' 为全局基线） */
export const fenceRules = pgTable(
  "fence_rules",
  {
    id: text("id").primaryKey(),
    ruleId: text("rule_id").notNull(),
    version: text("version").notNull(),
    workspaceId: text("workspace_id").notNull().default("*"),
    name: text("name").notNull(),
    /** auto / review / block */
    level: text("level").notNull(),
    /** 匹配条件：{ object_types, actions, when }（YAML DSL 求值，L2.5 沙箱表达式） */
    matchSpec: jsonb("match_spec").notNull(),
    /** 动作与通知策略：{ result, notify? } */
    action: jsonb("action").notNull(),
    isBaseline: boolean("is_baseline").notNull().default(false),
    /** draft / pending_approval / active / rolled_back */
    status: text("status").notNull().default("draft"),
    createdBy: text("created_by").notNull(),
    /** 变更审批事件 ID（F2.4 留痕） */
    approvedEventId: text("approved_event_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("fence_rules_uniq").on(t.ruleId, t.version, t.workspaceId)],
);

/** dry-run 回放报告（F2.5；未确认不得激活 L2.4） */
export const fenceDryRuns = pgTable("fence_dry_runs", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  ruleId: text("rule_id").notNull(),
  ruleVersion: text("rule_version").notNull(),
  /** 回放结果：{ replayed, would_block[], would_review[], impact } */
  report: jsonb("report").notNull(),
  /** pending / confirmed / rejected */
  status: text("status").notNull().default("pending"),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ---------- 会话与审批（M3 / M5） ---------- */

/** 任务线程（F3.4 状态机；单工作区 ≤10 并发 G11） */
export const threads = pgTable(
  "threads",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    title: text("title").notNull(),
    /** ask / agent / quest（F3.3 三态） */
    mode: text("mode").notNull().default("quest"),
    /** queued / running / pending_review / completed / failed / paused */
    status: text("status").notNull().default("queued"),
    progressDone: integer("progress_done").notNull().default(0),
    progressTotal: integer("progress_total").notNull().default(0),
    currentAction: text("current_action"),
    createdBy: text("created_by").notNull(),
    agentId: text("agent_id"),
    error: text("error"),
    /** #13: 暂停来源（'night-shift' / 'manual' / null）；resumeNight 只恢复 night-shift 暂停的线程 */
    pausedBy: text("paused_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (t) => [
    index("idx_threads_ws_status").on(t.workspaceId, t.status),
    index("idx_threads_ws_paused_by").on(t.workspaceId, t.status, t.pausedBy),
  ],
);

/** 审批队列（M5 原生消息类型；UNIQUE(event_id,channel) 幂等 L5.3） */
export const approvals = pgTable(
  "approvals",
  {
    approvalId: text("approval_id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    /** 被审批的动作事件 */
    eventId: text("event_id").notNull(),
    /** inapp / dingtalk / wecom / feishu / slack */
    channel: text("channel").notNull().default("inapp"),
    /** pending / approved / edited / rejected / expired */
    status: text("status").notNull().default("pending"),
    /** { type: approve|edit|reject, weight: 1|2|3, reason_enum, reason_text, edited_after } */
    gesture: jsonb("gesture"),
    /** { before, after, expires_at }（E5.3 快照过期检测） */
    snapshot: jsonb("snapshot").notNull().default({}),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("approvals_event_channel_uniq").on(t.eventId, t.channel),
    index("idx_approvals_ws_status").on(t.workspaceId, t.status),
  ],
);

/* ---------- 夜班与自动化（M4 / M9） ---------- */

/** 夜班班次（F4.8 状态机持久化；F2.6 围栏快照版本） */
export const nightRuns = pgTable(
  "night_runs",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    /** 班次日期（如 2026-08-16 夜） */
    runDate: text("run_date").notNull(),
    /** ready / running / paused / package_generated */
    status: text("status").notNull().default("ready"),
    fenceSnapshotVersion: text("fence_snapshot_version"),
    candidateCount: integer("candidate_count").notNull().default(0),
    /** { done, pending, need_human, credits_used, credits_est } 决策包三栏统计 */
    stats: jsonb("stats").notNull().default({}),
    startedAt: timestamp("started_at", { withTimezone: true }),
    /** 决策包投递事件 ID */
    packageEventId: text("package_event_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_night_runs_ws_date").on(t.workspaceId, t.runDate)],
);

/** 自动化触发器（F4.7 一等公民；本身是围栏管辖对象 L4.4） */
export const triggers = pgTable("triggers", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  name: text("name").notNull(),
  /** cron / event */
  kind: text("kind").notNull(),
  /** cron 表达式或事件订阅条件 */
  schedule: text("schedule").notNull(),
  /** 触发动作描述（派遣模板） */
  action: jsonb("action").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ---------- 资产与商业化（M8 / M7） ---------- */

/** 技能（F8.1 三级体系；SKILL.md 标准目录） */
export const skills = pgTable("skills", {
  id: text("id").primaryKey(),
  /** official / team / industry */
  level: text("level").notNull(),
  /** 来源 bundle（官方套件随 bundle 分发） */
  bundle: text("bundle"),
  name: text("name").notNull(),
  version: text("version").notNull().default("1.0.0"),
  description: text("description").notNull().default(""),
  /** 绑定围栏声明（F8.2 安装生效、卸载撤销 L8.3） */
  fenceBindings: jsonb("fence_bindings").notNull().default([]),
  /** SKILL.md 正文 */
  body: text("body").notNull().default(""),
  /** 行业共享上架前必须脱敏（L8.1/E8.4） */
  desensitized: boolean("desensitized").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** 技能安装记录（卸载即撤销围栏绑定） */
export const skillInstalls = pgTable(
  "skill_installs",
  {
    skillId: text("skill_id").notNull().references(() => skills.id),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    installedBy: text("installed_by").notNull(),
    installedAt: timestamp("installed_at", { withTimezone: true }).notNull().defaultNow(),
    /** #17: 安装时快照 fence_bindings；运行时读快照而非实时值，防止技能作者更新绑定绕过冲突检测 */
    fenceBindingsSnapshot: jsonb("fence_bindings_snapshot").notNull().default([]),
  },
  (t) => [primaryKey({ columns: [t.skillId, t.workspaceId] })],
);

/** 行业知识资产（F8.6；共享前必须 desensitized=true，L8.1） */
export const industryAssets = pgTable("industry_assets", {
  assetId: text("asset_id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  workspaceId: text("workspace_id").notNull(),
  /** script_structure / style / sop / ... */
  kind: text("kind").notNull(),
  payload: jsonb("payload").notNull(),
  /** 回流表现字段 */
  perf: jsonb("perf").notNull().default({}),
  /** workspace / org / industry（SQL 侧 CHECK 约束） */
  shareScope: text("share_scope").notNull().default("workspace"),
  desensitized: boolean("desensitized").notNull().default(false),
  embedding: vector("embedding", { dimensions: 1536 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** 凭据引用（F7.7/L7.3：永不出现在提示词与事件明文，只记引用 ID） */
export const credentials = pgTable("credentials", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  /** ota-meituan / ota-ctrip / im-dingtalk / ... */
  provider: text("provider").notNull(),
  refKey: text("ref_key").notNull(),
  /** AES-256-GCM 密文（本地 master key，阶段二实现加解密） */
  secretEnc: text("secret_enc").notNull(),
  scopes: jsonb("scopes").notNull().default([]),
  /** 健康探针状态：healthy / failing / unknown */
  health: text("health").notNull().default("unknown"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  rotatedAt: timestamp("rotated_at", { withTimezone: true }),
});
