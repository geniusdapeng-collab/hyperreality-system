/**
 * wizard · 行业落地向导状态机（D18/D19）
 *
 * 定位：把「技能一（竞品调研）→技能二（一线调研）→技能三（落地方案）→技能四（交付配置）」
 *       编排为首次装机的产品化引导流程。行业内容零预置——行业差异全部在运行期由技能产出
 *       与六槽装配生成，底座只提供状态机与编排骨架。
 *
 * 设计纪律：
 *  - 状态机迁移合法性唯一事实源是 TRANSITIONS（同 night-shift 的 assertTransition 范式）
 *  - 全程事件化：每次迁移/确认/授权由调用方经安全网关落库（本包不直接写库，保持纯函数可测）
 *  - 排期禁令：向导只编排任务与依赖，不含任何工期/时间点
 *  - 能力裁剪激活（D18）：版本只影响激活时的能力生效范围，向导全流程不因版本中断
 *  - 反哺上报四红线（D19）：opt-in + 预览 + 脱敏 + 留痕，缺一禁止发送
 */

/* ---------- 状态机 ---------- */

export type WizardStatus =
  | "welcome"          // 装机完成，引导卡片待确认
  | "example_notice"   // 示例明示（V4：is_example 装配时的首态——"这是示例版"）
  | "clear_example"    // 一键清空（V4：快照→台账卸载→留痕）
  | "industry_select"  // 选择已有行业 / 输入新行业
  | "staffing"         // L3 编制生成（V4：草案先行，人审才装配）
  | "research"         // 完整通道：技能一/二并行执行
  | "design"           // 完整通道：技能三落地方案设计（含反哺清单）
  | "delivery"         // 技能四：交付配置（六步，交互式）
  | "exam"             // 上岗考（V4：考试院门禁，达标才激活）
  | "need_info"        // 交付配置缺授权/缺信息，待客户补齐
  | "activated"        // 装配检查单全绿 + 上岗考达标 + 审批通过
  | "handover"         // 交付页输出，首份决策包已预约
  | "paused";          // 用户暂停/离线，可断点续跑

const TRANSITIONS: Record<WizardStatus, WizardStatus[]> = {
  welcome: ["industry_select", "example_notice", "paused"],
  example_notice: ["industry_select", "handover", "paused"],  // 定制→行业选择；继续体验示例→交付页
  clear_example: ["industry_select", "paused"],                // 清空完成即入行业选择（清空不是终点是起点）
  industry_select: ["staffing", "research", "delivery", "clear_example", "paused"], // staffing=新行业L3编制；delivery=快速通道（已有Bundle）；已有装配先清空
  staffing: ["research", "delivery", "paused"],
  research: ["design", "paused"],
  design: ["delivery", "paused"],
  delivery: ["exam", "need_info", "paused"],                   // V4：delivery→exam（原直 activated 改为先考试）
  exam: ["activated", "delivery", "paused"],                   // 达标激活；未达标回炉修订
  need_info: ["delivery", "paused"],
  activated: ["handover"],
  handover: [],
  paused: ["welcome", "example_notice", "industry_select", "staffing", "research", "design", "delivery", "exam", "need_info"], // 断点续跑：回到任一挂起点
};

export class WizardTransitionError extends Error {
  constructor(from: WizardStatus, to: WizardStatus) {
    super(`落地向导非法迁移：${from} → ${to}（D18）`);
    this.name = "WizardTransitionError";
  }
}

export function assertTransition(from: WizardStatus, to: WizardStatus): void {
  if (!TRANSITIONS[from]?.includes(to)) throw new WizardTransitionError(from, to);
}

export function canTransition(from: WizardStatus, to: WizardStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/* ---------- 通道与模式 ---------- */

/** 快速通道：已有行业Bundle，跳过调研直接进入交付配置 */
export type WizardPath = "fast" | "full";
/** 完整通道调研模式（Q2）：quick=内置骨架模板先上线；deep=技能一/二/三深度调研 */
export type ResearchMode = "quick" | "deep";

export interface WizardContext {
  path: WizardPath;
  mode?: ResearchMode;          // path=full 时必选
  industry?: string;            // 用户输入/选择的行业
  offline?: boolean;            // 离线降级：骨架版先行，联网后补跑
}

/** 各通道的步骤序列（排期禁令：只有顺序与依赖，无工期；V4：全部以 exam 上岗考收口） */
export function wizardSteps(ctx: WizardContext): WizardStatus[] {
  if (ctx.path === "fast") return ["welcome", "industry_select", "delivery", "exam", "activated", "handover"];
  if (ctx.mode === "quick") return ["welcome", "industry_select", "delivery", "exam", "activated", "handover"]; // 快速上线模式：骨架模板直配
  return ["welcome", "industry_select", "staffing", "research", "design", "delivery", "exam", "activated", "handover"];
}

/** 示例版通道（V4：is_example 工作区的定制序列——明示→清空→编制→装配→上岗考） */
export function exampleCustomizeSteps(): WizardStatus[] {
  return ["example_notice", "clear_example", "industry_select", "staffing", "delivery", "exam", "activated", "handover"];
}

/* ---------- 交付配置六步（delivery-config 技能编排契约） ---------- */

export type DeliveryStep =
  | "assets"      // ①资产生成（createBundleDraft）
  | "archive"     // ②一店一档初始化（必填基础信息）
  | "authz"       // ③系统授权（凭据走L4 Patch注入，不进事件明文）
  | "fences"      // ④围栏确认（只紧不松+dry-run回放）
  | "precheck"    // ⑤装配检查单（任一红灯禁止激活）
  | "activate";   // ⑥审批激活（review级审批卡片）

export const DELIVERY_STEPS: DeliveryStep[] = ["assets", "archive", "authz", "fences", "precheck", "activate"];

/** 每步是否需要客户输入/授权 */
export const DELIVERY_STEP_INTERACTIVE: Record<DeliveryStep, boolean> = {
  assets: false,
  archive: true,
  authz: true,
  fences: true,
  precheck: false,
  activate: true,
};

/* ---------- 激活门禁 ---------- */

export interface ActivationChecklist {
  archiveReady: boolean;   // 档案三要素（档案+阶段+目标）校验通过
  enumsReady: boolean;     // 对象/阶段枚举就绪
  toolsReady: boolean;     // 工具集声明完整（读/写标注）
  fencesReady: boolean;    // 围栏包加载且全部 dry-run 通过
  uiReady: boolean;        // 工作台用例就绪
  approved: boolean;       // 激活审批卡片已拍板
}

/** 起飞前检查单：任一红灯禁止激活（与 assembly.ts 检查单同口径） */
export function canActivate(c: ActivationChecklist): boolean {
  return c.archiveReady && c.enumsReady && c.toolsReady && c.fencesReady && c.uiReady && c.approved;
}

export function failedChecks(c: ActivationChecklist): (keyof ActivationChecklist)[] {
  return (Object.keys(c) as (keyof ActivationChecklist)[]).filter((k) => !c[k]);
}

/* ---------- 能力裁剪激活（D16：版本只裁剪激活范围，不中断向导） ---------- */

export type PlanTier = "community" | "pro" | "teams" | "vpc";

export interface ActivationProfile {
  enabled: string[];       // 激活即生效的能力
  lockedPendingUpgrade: string[]; // 已配置·待升级解锁
}

/** 按版本裁剪激活能力：community 无 Quest自治/夜班/巡检（与 tenancy PLAN_CAPABILITIES 同口径） */
export function activationProfile(plan: PlanTier): ActivationProfile {
  const base = ["ask", "agents-basic", "approvals", "memory", "events"];
  const pro = ["quest", "night-shift", "inspection", "skills-official"];
  if (plan === "community") return { enabled: base, lockedPendingUpgrade: pro };
  if (plan === "pro") return { enabled: [...base, ...pro], lockedPendingUpgrade: ["shared-memory", "audit-report"] };
  if (plan === "teams") return { enabled: [...base, ...pro, "shared-memory", "audit-report"], lockedPendingUpgrade: ["vpc-seam", "local-model"] };
  return { enabled: [...base, ...pro, "shared-memory", "audit-report", "vpc-seam", "local-model"], lockedPendingUpgrade: [] };
}

/* ---------- 反哺上报四红线（D19） ---------- */

export interface FeedbackReport {
  optIn: boolean;          // 用户显式同意
  previewed: boolean;      // 发送前已完整预览（可编辑）
  desensitized: boolean;   // 已过PII脱敏管道
  logged: boolean;         // 发送行为已写事件库
  body: string;            // 仅含能力缺口描述，不含经营数据
}

/** 四红线缺一禁止发送 */
export function canSendFeedback(r: FeedbackReport): boolean {
  return r.optIn && r.previewed && r.desensitized && r.logged && r.body.length > 0;
}
