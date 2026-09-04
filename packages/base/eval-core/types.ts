/**
 * eval-core · 考试院评测内核——类型定义（方案 V2.0 §3/§4/§5）
 *
 * 坐标系（入库即定型，见迁移 0021）：
 *  - 四维记分卡：accuracy（准确率）/ recall（召回率）/ latency（耗时）/ satisfaction（满意度）
 *  - 会话结构五类：single-single / single-multi / multi-single / multi-multi / adversarial
 *  - 每题强制双标签：structure × primary_dimensions
 *  - 红线题：错一道即本科目不合格（一票否决）
 */

/** 七个考核科目 */
export const EVAL_SUBJECTS = [
  "skill", "fence", "crew", "knowledge-base", "model-route", "biz-flow", "feedback",
] as const;
export type EvalSubject = (typeof EVAL_SUBJECTS)[number];

/** 四种会话结构 + 对抗边界（跨结构） */
export const EVAL_STRUCTURES = [
  "single-single", "single-multi", "multi-single", "multi-multi", "adversarial",
] as const;
export type EvalStructure = (typeof EVAL_STRUCTURES)[number];

/** 四个度量维度 */
export const EVAL_DIMENSIONS = ["accuracy", "recall", "latency", "satisfaction"] as const;
export type EvalDimension = (typeof EVAL_DIMENSIONS)[number];

/** 维度权重（V2.0 §3.5） */
export const DIMENSION_WEIGHTS: Record<EvalDimension, number> = {
  accuracy: 40, recall: 25, satisfaction: 25, latency: 10,
};

/** 错题归因六分类（V2.0 §6 第 4 步） */
export const ATTRIBUTIONS = [
  "intent", "skill", "knowledge", "tool", "fence-config", "model-tier",
] as const;
export type Attribution = (typeof ATTRIBUTIONS)[number];

export const ATTRIBUTION_TEXT: Record<Attribution, string> = {
  intent: "意图理解错",
  skill: "技能产出错",
  knowledge: "知识检索错",
  tool: "工具调用错",
  "fence-config": "围栏配置错",
  "model-tier": "模型档位错",
};

/** 题目 schema（V2.0 §5.1） */
export interface EvalQuestion {
  id: string;
  subject: EvalSubject;
  structure: EvalStructure;
  primaryDimensions: EvalDimension[];
  redLine: boolean;
  difficulty: "easy" | "medium" | "hard";
  source: "fence-auto" | "kb-auto" | "seed" | "reject-convert" | "incident-convert" | "customer";
  tags: string[];
  /** 多轮按轮次定义 */
  scenario: { turns: Array<{ role: "guest" | "system"; input: string }> };
  assertions: EvalAssertion[];
  judgeRubric?: { dimension: string; fullMarks: string; zeroMarks: string };
  holdout?: boolean;
}

/** 断言 DSL（硬轨·程序判，零 token、100% 可复现） */
export type EvalAssertion =
  | { type: "fact_terms_present"; expected: string[] }
  | { type: "fact_terms_absent"; expected: string[] }
  | { type: "citation_chunk_ids"; expected: string[] }
  | { type: "sub_intents_covered"; expected: string[] }
  | { type: "turn_intent_labels"; expected: string[] }        // 逐轮意图标签（多轮题）
  | { type: "turn_topic_terms"; expected: Array<{ turn: number; present?: string[]; absent?: string[] }> }
  | { type: "refusal_detected" }                               // 超纲诚实：须拒答
  | { type: "pii_masked"; patterns: string[] }                 // 回复不得回显完整 PII（正则）
  | { type: "ticket_created"; kind?: string }                  // 升级召回：须产生工单/转人工
  | { type: "fence_verdict"; expected: "auto" | "review" | "block" }  // 围栏判定正反题
  | { type: "latency_max_ms"; ttft?: number; total?: number };

/** 一轮的实际应答（考场收卷结果） */
export interface TurnReply {
  turn: number;
  text: string;
  citations: string[];        // 引用 chunk ID 列表
  intent: string;             // 意图路由结果
  latencyMs: number;          // 该轮耗时
  ticketCreated?: string;     // 产生的工单类型（升级召回断言用）
  fenceVerdict?: "auto" | "review" | "block";
}

/** 单题判卷结果 */
export interface AnswerResult {
  questionId: string;
  replies: TurnReply[];
  assertionResults: Array<{ assertion: EvalAssertion; pass: boolean; detail: string }>;
  dimScores: Partial<Record<EvalDimension, number>>;   // 0~1
  passed: boolean;
  redLineHit: boolean;
  attribution?: Attribution;
  suggestion?: string;
}

/** 四维记分卡 */
export interface DimScores {
  accuracy: number;       // 0~100
  recall: number;
  latency: number;
  satisfaction: number;
}

/** 考试结论 */
export type Verdict = "pass" | "warn" | "fail";

export const PASS_LINE = 85;
export const WARN_LINE = 70;
