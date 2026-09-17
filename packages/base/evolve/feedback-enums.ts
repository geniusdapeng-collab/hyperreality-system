/**
 * evolve · 反馈原因枚举注册表（自我进化飞轮 M1，D24 修订 3）
 *
 * 口径：
 *  - 行业 Bundle 第⑧装配槽：feedback-enums.yml——驳回/修改手势的原因枚举值表是行业知识，
 *    底座零预置（D17/D18 红线：底座不内置行业词汇）；
 *  - 注册后强制校验：该工作区审批 reject 的 reasonEnum 必须命中枚举（空表/未装配 = 不校验，
 *    向后兼容既有工作区与测试）；
 *  - edit 手势强制分流 editKind：correction（纠错→缺陷池）/ preference（口味→偏好池），
 *    解决「改文案是纠错还是口味」的归因歧义（D24 修订 3）；
 *  - 进程级注册表（与 registerAskFactProvider 同构）：行业包装配/落地向导激活时调用。
 */
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

/* ================= 类型 ================= */

export type EditKind = "correction" | "preference";
export const EDIT_KINDS: readonly EditKind[] = ["correction", "preference"];

export interface FeedbackEnumDef {
  /** 枚举码（事件与记忆中流转的稳定键，如 price.too_high / style.clickbait） */
  code: string;
  /** 人类可读名（审批卡下拉展示） */
  label: string;
  /** 适用手势（缺省两者皆可） */
  appliesTo?: Array<"reject" | "edit">;
}

export class FeedbackEnumError extends Error {
  constructor(
    public readonly code: "UNKNOWN_REASON_ENUM" | "INVALID_ENUM_DEF",
    message: string,
  ) {
    super(message);
    this.name = "FeedbackEnumError";
  }
}

/* ================= 校验（纯函数） ================= */

/** 枚举表定义校验（装配门禁用；非法定义拒绝装配，fail-fast） */
export function validateEnumDefs(defs: FeedbackEnumDef[]): FeedbackEnumDef[] {
  if (!Array.isArray(defs)) throw new FeedbackEnumError("INVALID_ENUM_DEF", "反馈枚举表必须是数组");
  const seen = new Set<string>();
  for (const d of defs) {
    if (!d || typeof d.code !== "string" || !/^[a-z][a-z0-9._-]{1,60}$/.test(d.code)) {
      throw new FeedbackEnumError("INVALID_ENUM_DEF", `非法枚举码「${String(d?.code)}」（小写字母开头的 dot 命名）`);
    }
    if (typeof d.label !== "string" || d.label.trim() === "") {
      throw new FeedbackEnumError("INVALID_ENUM_DEF", `枚举「${d.code}」缺少可读名 label`);
    }
    if (seen.has(d.code)) throw new FeedbackEnumError("INVALID_ENUM_DEF", `枚举码重复：${d.code}`);
    seen.add(d.code);
  }
  return defs;
}

/* ================= 进程级注册表 ================= */

const registry = new Map<string, FeedbackEnumDef[]>();

/** 注册工作区的反馈枚举表（行业 Bundle 装配/激活时调用；重复注册以新表为准并留痕由调用方负责） */
export function registerFeedbackEnums(workspaceId: string, defs: FeedbackEnumDef[]): void {
  registry.set(workspaceId, validateEnumDefs(defs));
}

/** 注销（Bundle 卸载时调用） */
export function unregisterFeedbackEnums(workspaceId: string): void {
  registry.delete(workspaceId);
}

/** 查询（审批卡 UI 下拉 + decide 校验共用） */
export function getFeedbackEnums(workspaceId: string): FeedbackEnumDef[] | undefined {
  return registry.get(workspaceId);
}

/**
 * decide 校验钩子：工作区已装配枚举表时，reasonEnum 必须命中（F1.7 校准信号的
 * 可信度前提是「原因来自受控词表」，自由文本无法聚类）；未装配 = 放行（向后兼容）。
 */
export function assertReasonEnumAllowed(workspaceId: string, reasonEnum: string): void {
  const defs = registry.get(workspaceId);
  if (!defs || defs.length === 0) return;
  const hitDef = defs.find((d) => d.code === reasonEnum);
  if (!hitDef) {
    throw new FeedbackEnumError(
      "UNKNOWN_REASON_ENUM",
      `原因枚举「${reasonEnum}」不在本工作区装配的反馈枚举表内（第⑧槽，D24 修订 3）`,
    );
  }
  if (hitDef.appliesTo && !hitDef.appliesTo.includes("reject")) {
    throw new FeedbackEnumError(
      "UNKNOWN_REASON_ENUM",
      `原因枚举「${reasonEnum}」不适用于驳回手势（appliesTo=${hitDef.appliesTo.join("/")}）`,
    );
  }
}

/** edit 手势的归因分流校验（M1.3：纠错 vs 口味，强制二分） */
export function assertEditKindValid(editKind: unknown): asserts editKind is EditKind | undefined {
  if (editKind === undefined) return;
  if (!EDIT_KINDS.includes(editKind as EditKind)) {
    throw new FeedbackEnumError(
      "INVALID_ENUM_DEF",
      `editKind 必须是 ${EDIT_KINDS.join(" / ")}（纠错→缺陷池，口味→偏好池，D24 修订 3）`,
    );
  }
}

/* ================= YAML 装载（Bundle 第⑧槽实物） ================= */

/**
 * 从行业 Bundle 目录装载 feedback-enums.yml（文件不存在 = 该 Bundle 未提供第⑧槽，返回 null）。
 * 文件形状：{ version: string, enums: [{code,label,appliesTo?}] }
 */
export function loadFeedbackEnumsFromBundle(bundleDir: string): FeedbackEnumDef[] | null {
  const path = `${bundleDir}/feedback-enums.yml`;
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return null; // 未提供第⑧槽（合法，向后兼容）
  }
  const doc = parseYaml(raw) as { enums?: FeedbackEnumDef[] };
  if (!doc || !Array.isArray(doc.enums)) {
    throw new FeedbackEnumError("INVALID_ENUM_DEF", `${path} 缺少 enums 数组`);
  }
  return validateEnumDefs(doc.enums);
}

/**
 * 服务启动/bootstrap：为全部已激活行业的工作区装载第⑧槽枚举表。
 * 进程级注册表不持久（与 registerAskFactProvider 同构）——每次启动按 workspaces.industry
 * 从磁盘重建；Bundle 激活路径（activateBundle）另行即时注册本工作区。
 */
export async function registerFeedbackEnumsFromDisk(
  app: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> },
  bundlesRootDir: string,
): Promise<Array<{ workspaceId: string; industry: string; count: number }>> {
  const r = await app.query(`SELECT id, industry FROM workspaces WHERE industry IS NOT NULL`);
  const registered: Array<{ workspaceId: string; industry: string; count: number }> = [];
  for (const row of r.rows) {
    const workspaceId = String(row.id);
    const industry = String(row.industry);
    const defs = loadFeedbackEnumsFromBundle(`${bundlesRootDir}/${industry}`);
    if (defs && defs.length > 0) {
      registerFeedbackEnums(workspaceId, defs);
      registered.push({ workspaceId, industry, count: defs.length });
    }
  }
  return registered;
}
