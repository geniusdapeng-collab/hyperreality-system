/**
 * inspection · 行业无关巡检契约与确定性执行器（F9.1）
 *
 * 基座只定义“检项、快照、探针、发现”的协议，不内置渠道、价格、评价等
 * 任何行业对象、阈值或用户文案。生产调用方必须从已验证的活动 Bundle 解析
 * 出受控行业适配器；没有适配器时由 scan 失败关闭，绝不把空配置当作巡检正常。
 */

/** 异常分级（F9.2）：高/中/低三级 → 推送策略 P0/P1/P2 */
export type Severity = "high" | "medium" | "low";

/** 行业自有的受控检项类型；基座不枚举行业种类。 */
export type CheckKind = string;

export interface CheckDef {
  id: string;
  kind: CheckKind;
  /** 面向用户的中文检项名称，由行业适配器提供。 */
  name: string;
}

export interface Finding {
  checkId: string;
  /** ok=正常 / anomaly=异常 / nodata=快照缺该项数据（不算正常项，不算异常） */
  status: "ok" | "anomaly" | "nodata";
  severity?: Severity;
  /** 面板展示摘要；行业对象名与文案必须由行业适配器生成。 */
  summary: string;
  objectType: string;
  objectId?: string;
  /** 同源聚合键（E9.2：推送风暴时同源异常聚合为一条摘要） */
  source: string;
}

/**
 * 行业巡检快照的透明载体。字段 Schema 及解析责任属于受控行业适配器，基座
 * 不猜测 channels/reviews/rooms 等业务字段。
 */
export type InspectionSnapshot = Readonly<Record<string, unknown>>;

export type Probe = (check: CheckDef, snapshot: InspectionSnapshot) => Finding[];

export interface InspectionAdapter {
  /** 随服务端制品审核的受控适配器标识。 */
  id: string;
  /** 必须对应活动 Bundle 装配出的只读数字员工岗位。 */
  presetKey: string;
  checks: readonly CheckDef[];
  probes: Readonly<Record<string, Probe>>;
}

export class InspectionConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InspectionConfigurationError";
  }
}

function validateConfiguration(checks: readonly CheckDef[], probes: Readonly<Record<string, Probe>>): void {
  if (checks.length === 0) {
    throw new InspectionConfigurationError("当前行业包未声明巡检检项，已停止运行");
  }
  const ids = new Set<string>();
  for (const check of checks) {
    if (!check.id.trim() || !check.kind.trim() || !check.name.trim()) {
      throw new InspectionConfigurationError("行业巡检检项缺少标识、类型或中文名称");
    }
    if (ids.has(check.id)) {
      throw new InspectionConfigurationError(`行业巡检检项标识重复：${check.id}`);
    }
    ids.add(check.id);
    if (typeof probes[check.kind] !== "function") {
      throw new InspectionConfigurationError(`检项「${check.id}」没有已登记探针`);
    }
  }
}

/**
 * 跑一轮由行业适配器显式声明的检项。第三个参数没有默认值，避免任何调用方
 * 在 Bundle/适配器缺失时悄悄落回某个示例行业。
 */
export function runChecks(
  checks: readonly CheckDef[],
  snapshot: InspectionSnapshot,
  probes: Readonly<Record<string, Probe>>,
): Finding[] {
  validateConfiguration(checks, probes);
  const out: Finding[] = [];
  for (const check of checks) out.push(...probes[check.kind]!(check, snapshot));
  return out;
}

/** 同源聚合（E9.2）：同 source 的异常合并为一条摘要，详单进面板。 */
export function aggregateBySource(findings: Finding[]): Array<{ source: string; severity: Severity; count: number; items: Finding[] }> {
  const groups = new Map<string, Finding[]>();
  for (const finding of findings.filter((item) => item.status === "anomaly")) {
    const list = groups.get(finding.source) ?? [];
    list.push(finding);
    groups.set(finding.source, list);
  }
  const rank: Record<Severity, number> = { high: 3, medium: 2, low: 1 };
  return [...groups.entries()].map(([source, items]) => ({
    source,
    severity: items.reduce<Severity>((current, item) => (
      rank[item.severity ?? "low"] > rank[current] ? (item.severity ?? "low") : current
    ), "low"),
    count: items.length,
    items: items.sort((left, right) => rank[right.severity ?? "low"] - rank[left.severity ?? "low"]),
  }));
}
