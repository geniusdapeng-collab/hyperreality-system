/**
 * inspection · 巡检项定义与确定性探针（F9.1）
 *  - 巡检项由行业包定义：内置默认=多渠道价格 / 状态同步 / 评价 / 违规（PRD M9.2 原文口径）
 *  - 探针为纯函数：输入只读快照（loadSnapshot 取自 profiles.archive / 事件流），输出 Finding 列表
 *  - 探针可注入（演示/测试用）；默认探针不编造数据——快照缺项时该检项记「无数据」而非假异常
 */

/** 异常分级（F9.2）：高/中/低三级 → 推送策略 P0/P1/P2 */
export type Severity = "high" | "medium" | "low";

export type CheckKind = "channel_price" | "state_sync" | "review" | "violation";

export interface CheckDef {
  id: string;
  kind: CheckKind;
  name: string;
}

/** 默认巡检项清单（F9.1；US9.5：新行业只配置检项清单即获得完整巡检能力） */
export const DEFAULT_CHECKS: CheckDef[] = [
  { id: "chk-channel-price", kind: "channel_price", name: "多渠道价格一致性" },
  { id: "chk-state-sync", kind: "state_sync", name: "状态同步" },
  { id: "chk-review", kind: "review", name: "新评价扫描" },
  { id: "chk-violation", kind: "violation", name: "违规巡检" },
];

export interface Finding {
  checkId: string;
  /** ok=正常 / anomaly=异常 / nodata=快照缺该项数据（不算正常项，不算异常） */
  status: "ok" | "anomaly" | "nodata";
  severity?: Severity;
  /** 面板展示摘要（渠道/账号点名走 objectId） */
  summary: string;
  objectType: string;
  objectId?: string;
  /** 同源聚合键（E9.2：推送风暴时同源异常聚合为一条摘要） */
  source: string;
}

/** 巡检只读快照（探针输入；字段均可选——缺什么探针报什么 nodata） */
export interface InspectionSnapshot {
  /** 渠道价格采样：archive.inspection.channels = [{ channel, price, parity }] */
  channels?: Array<{ channel: string; price?: number; parity?: boolean; status?: string }>;
  /** 状态同步采样：archive.inspection.stateUnits = [{ unit, synced }]（unit 含义由行业包定义） */
  stateUnits?: Array<{ unit: string; synced: boolean }>;
  /** 新评价采样：archive.inspection.reviews = [{ id, channel, score }]（≤3 分为差评） */
  reviews?: Array<{ id: string; channel: string; score: number }>;
  /** 违规采样：archive.inspection.violations = [{ id, kind, detail }] */
  violations?: Array<{ id: string; kind: string; detail: string }>;
}

export type Probe = (check: CheckDef, snapshot: InspectionSnapshot) => Finding[];

/* ---------- 默认探针（确定性；阈值与 seed/围栏同源，不新增数值） ---------- */

const channelPriceProbe: Probe = (check, s) => {
  if (!s.channels || s.channels.length === 0) {
    return [{ checkId: check.id, status: "nodata", summary: "无渠道价格快照", objectType: "channel", source: "channel_price" }];
  }
  return s.channels.map((c): Finding => {
    if (c.status && c.status !== "online") {
      return {
        checkId: check.id, status: "anomaly", severity: "high",
        summary: `渠道「${c.channel}」状态 ${c.status}（非 online）`, objectType: "channel", objectId: c.channel, source: "channel_price",
      };
    }
    if (c.parity === false) {
      return {
        checkId: check.id, status: "anomaly", severity: "medium",
        summary: `渠道「${c.channel}」价格不一致（parity=false）`, objectType: "channel", objectId: c.channel, source: "channel_price",
      };
    }
    return {
      checkId: check.id, status: "ok",
      summary: `渠道「${c.channel}」价格正常`, objectType: "channel", objectId: c.channel, source: "channel_price",
    };
  });
};

const stateSyncProbe: Probe = (check, s) => {
  if (!s.stateUnits || s.stateUnits.length === 0) {
    return [{ checkId: check.id, status: "nodata", summary: "无状态同步快照", objectType: "unit", source: "state_sync" }];
  }
  return s.stateUnits.map((r): Finding =>
    r.synced
      ? { checkId: check.id, status: "ok", summary: `单元「${r.unit}」状态已同步`, objectType: "unit", objectId: r.unit, source: "state_sync" }
      : { checkId: check.id, status: "anomaly", severity: "medium", summary: `单元「${r.unit}」状态未同步`, objectType: "unit", objectId: r.unit, source: "state_sync" },
  );
};

const reviewProbe: Probe = (check, s) => {
  if (!s.reviews) {
    return [{ checkId: check.id, status: "nodata", summary: "无评价快照", objectType: "review", source: "review" }];
  }
  if (s.reviews.length === 0) {
    return [{ checkId: check.id, status: "ok", summary: "无新增评价", objectType: "review", source: "review" }];
  }
  return s.reviews.map((r): Finding =>
    r.score <= 3
      ? { checkId: check.id, status: "anomaly", severity: "high", summary: `差评 ${r.score} 分（渠道 ${r.channel}）待跟进`, objectType: "review", objectId: r.id, source: "review" }
      : { checkId: check.id, status: "ok", summary: `评价 ${r.score} 分（渠道 ${r.channel}）正常`, objectType: "review", objectId: r.id, source: "review" },
  );
};

const violationProbe: Probe = (check, s) => {
  if (!s.violations) {
    return [{ checkId: check.id, status: "nodata", summary: "无违规快照", objectType: "violation", source: "violation" }];
  }
  if (s.violations.length === 0) {
    return [{ checkId: check.id, status: "ok", summary: "无违规", objectType: "violation", source: "violation" }];
  }
  return s.violations.map((v): Finding => ({
    checkId: check.id, status: "anomaly", severity: "high",
    summary: `违规（${v.kind}）：${v.detail}`, objectType: "violation", objectId: v.id, source: "violation",
  }));
};

export const DEFAULT_PROBES: Record<CheckKind, Probe> = {
  channel_price: channelPriceProbe,
  state_sync: stateSyncProbe,
  review: reviewProbe,
  violation: violationProbe,
};

/** 跑一轮检项（纯函数）：checks × probes → findings；单项探针抛错向上抛（由 scan 负责失败事件化，L9.2） */
export function runChecks(
  checks: CheckDef[],
  snapshot: InspectionSnapshot,
  probes: Record<CheckKind, Probe> = DEFAULT_PROBES,
): Finding[] {
  const out: Finding[] = [];
  for (const c of checks) {
    const probe = probes[c.kind];
    if (!probe) throw new Error(`检项「${c.id}」无对应探针（kind=${c.kind}）`);
    out.push(...probe(c, snapshot));
  }
  return out;
}

/** 同源聚合（E9.2）：同 source 的异常合并为一条摘要，详单进面板 */
export function aggregateBySource(findings: Finding[]): Array<{ source: string; severity: Severity; count: number; items: Finding[] }> {
  const groups = new Map<string, Finding[]>();
  for (const f of findings.filter((x) => x.status === "anomaly")) {
    const list = groups.get(f.source) ?? [];
    list.push(f);
    groups.set(f.source, list);
  }
  const rank: Record<Severity, number> = { high: 3, medium: 2, low: 1 };
  return [...groups.entries()].map(([source, items]) => ({
    source,
    severity: items.reduce<Severity>((acc, i) => (rank[i.severity ?? "low"] > rank[acc] ? (i.severity ?? "low") : acc), "low"),
    count: items.length,
    items: items.sort((a, b) => rank[b.severity ?? "low"] - rank[a.severity ?? "low"]),
  }));
}
