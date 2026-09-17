/**
 * gates.ts —— SuperMickey 确认门 ↔ 视频经理审批点映射（融合设计 §3）
 *
 * vendor 引擎内部的确认门 type 字面值保持原样（唯一真源在 vendor 代码），
 * 本模块只负责把 type 翻译成业务门 G1-G7，供围栏与审批卡使用。
 */

export type GateKey =
  | "G1_DOSSIER"
  | "G2_THEME"
  | "G3_INSIGHT"
  | "G4_PRD"
  | "G5_PORTRAIT"
  | "G6_PROMPT"
  | "G7_FINAL"
  | "UNKNOWN";

/** vendor 确认门 type → 业务门 */
const GATE_MAP: Record<string, GateKey> = {
  // 节点 0：商品情报档案（珍妮纺织机确认单）
  dossier: "G1_DOSSIER",
  "data-mining-dossier": "G1_DOSSIER",
  "product-dossier": "G1_DOSSIER",
  // 节点 A：创意主题 / 营销 Brief
  "creative-theme": "G2_THEME",
  theme: "G2_THEME",
  brief: "G2_THEME",
  // 节点 B：业务需求对齐清单
  requirement: "G3_INSIGHT",
  "requirement-list": "G3_INSIGHT",
  insight: "G3_INSIGHT",
  // 节点 C：PRD
  prd: "G4_PRD",
  // 定妆照
  portraits: "G5_PORTRAIT",
  portrait: "G5_PORTRAIT",
  "portrait-set": "G5_PORTRAIT",
  // 提示词审核
  prompt: "G6_PROMPT",
  prompts: "G6_PROMPT",
  "prompt-review": "G6_PROMPT",
  // 预生产最终确认
  preproduction: "G7_FINAL",
  "preproduction-final": "G7_FINAL",
  final: "G7_FINAL"
};

export function resolveGate(vendorType: string): GateKey {
  const key = (vendorType || "").trim().toLowerCase();
  return GATE_MAP[key] ?? "UNKNOWN";
}

/** 审批裁决结果（与 vendor confirmation-waiter 返回约定一致） */
export interface GateVerdict {
  approved: boolean;
  reason?: string;
  suggestions?: string[];
  fatal?: string;
}

/** 待审批内容（由 vendor 桥传入） */
export interface GateRequest {
  type: string;
  content: string;
  runId: string | null;
  shouldAbort?: () => boolean;
}
