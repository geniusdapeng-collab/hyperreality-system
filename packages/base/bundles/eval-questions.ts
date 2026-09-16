/**
 * 已验证 Bundle 的考试题集读取器。
 *
 * 清单先经过契约、兼容性、摘要与生产签名校验；题集路径必须由清单显式
 * 声明且不能越出 Bundle 目录；题目本体再经过严格 Schema 校验。这样考试院
 * 不需要、也不允许在基座代码里内置任何行业默认题。
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  EVAL_PRIMARY_DIMENSIONS,
  EVAL_STRUCTURES,
  EVAL_SUBJECTS,
  type EvalQuestion,
} from "../eval-core/types.js";
import {
  BundleError,
  bundlesRoot,
  loadVerifiedBundleManifest,
  readVerifiedBundleJsonAsset,
} from "./assembly.js";

const AssertionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("fact_terms_present"), expected: z.array(z.string().min(1)).min(1) }).strict(),
  z.object({ type: z.literal("fact_terms_absent"), expected: z.array(z.string().min(1)).min(1) }).strict(),
  z.object({ type: z.literal("citation_chunk_ids"), expected: z.array(z.string().min(1)).min(1) }).strict(),
  z.object({ type: z.literal("sub_intents_covered"), expected: z.array(z.string().min(1)).min(1) }).strict(),
  z.object({ type: z.literal("turn_intent_labels"), expected: z.array(z.string().min(1)).min(1) }).strict(),
  z.object({
    type: z.literal("turn_topic_terms"),
    expected: z.array(z.object({
      turn: z.number().int().positive(),
      present: z.array(z.string().min(1)).optional(),
      absent: z.array(z.string().min(1)).optional(),
    }).strict()).min(1),
  }).strict(),
  z.object({ type: z.literal("refusal_detected") }).strict(),
  z.object({ type: z.literal("must_refuse_or_escalate") }).strict(),
  z.object({ type: z.literal("pii_masked"), patterns: z.array(z.string().min(1)).min(1) }).strict(),
  z.object({ type: z.literal("ticket_created"), kind: z.string().min(1).optional() }).strict(),
  z.object({ type: z.literal("fence_verdict"), expected: z.enum(["auto", "review", "block"]) }).strict(),
  z.object({
    type: z.literal("latency_max_ms"),
    ttft: z.number().int().positive().optional(),
    total: z.number().int().positive().optional(),
  }).strict(),
]);

const ScenarioSchema = z.object({
  turns: z.array(z.object({
    role: z.enum(["guest", "system"]),
    input: z.string().min(1).max(10_000),
  }).strict()).min(1).max(30),
}).strict();

const JudgeRubricSchema = z.object({
  dimension: z.string().min(1),
  fullMarks: z.string().min(1),
  zeroMarks: z.string().min(1),
}).strict();

const QuestionSeedSchema = z.object({
  subject: z.enum(EVAL_SUBJECTS),
  structure: z.enum(EVAL_STRUCTURES),
  primary_dimensions: z.array(z.enum(EVAL_PRIMARY_DIMENSIONS)).min(1),
  red_line: z.boolean(),
  difficulty: z.enum(["easy", "medium", "hard"]),
  source: z.enum(["fence-auto", "kb-auto", "seed", "reject-convert", "incident-convert", "customer"]),
  tags: z.array(z.string().min(1)),
  scenario: ScenarioSchema,
  assertions: z.array(AssertionSchema).min(1),
  judge_rubric: JudgeRubricSchema.optional(),
  holdout: z.boolean().optional(),
}).strict();

const QuestionSetSchema = z.object({
  questions: z.array(QuestionSeedSchema).min(1).max(2_000),
}).strict();

export type BundleEvalQuestionSeed = Omit<EvalQuestion, "id">;

const BundleEvalQuestionSeedSchema: z.ZodType<BundleEvalQuestionSeed> = z.object({
  subject: z.enum(EVAL_SUBJECTS),
  structure: z.enum(EVAL_STRUCTURES),
  primaryDimensions: z.array(z.enum(EVAL_PRIMARY_DIMENSIONS)).min(1),
  redLine: z.boolean(),
  difficulty: z.enum(["easy", "medium", "hard"]),
  source: z.enum(["fence-auto", "kb-auto", "seed", "reject-convert", "incident-convert", "customer"]),
  tags: z.array(z.string().min(1)),
  scenario: ScenarioSchema,
  assertions: z.array(AssertionSchema).min(1),
  judgeRubric: JudgeRubricSchema.optional(),
  holdout: z.boolean().optional(),
}).strict();

/** 服务端显式夹具也必须过同一领域约束；类型断言不能成为运行时绕过。 */
export function validateBundleEvalQuestionSeeds(input: unknown): BundleEvalQuestionSeed[] {
  const parsed = z.array(BundleEvalQuestionSeedSchema).min(1).max(2_000).safeParse(input);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "题集"}：${issue.message}`)
      .join("；");
    throw new BundleError("INVALID_INPUT", `显式考试夹具不符合题集契约：${detail}`);
  }
  return parsed.data;
}

export interface BundleEvalQuestionSet {
  bundleId: string;
  bundleVersion: string;
  integrityDigest: string;
  questions: BundleEvalQuestionSeed[];
}

export function bundleEvalQuestionId(
  workspaceId: string,
  bundleId: string,
  index: number,
  value: BundleEvalQuestionSeed,
): string {
  // 64-bit 工作区指纹避免全局主键在大规模租户下出现 32-bit 生日碰撞；原始工作区
  // 标识不进入题号，防止题库导出时泄露租户内部命名。
  const workspace = createHash("sha256").update(workspaceId).digest("hex").slice(0, 16);
  const digest = createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);
  return `evq-${workspace}-${bundleId}-${String(index + 1).padStart(3, "0")}-${digest}`;
}

export function loadVerifiedBundleEvalQuestions(
  bundleId: string,
  root = bundlesRoot(),
): BundleEvalQuestionSet {
  const manifest = loadVerifiedBundleManifest(bundleId, root);
  if (manifest.workloom.status === "draft" || !manifest.integrity?.digest) {
    throw new BundleError("INTEGRITY_FAILED", "草稿或无完整性摘要的行业包不得提供正式考试题集");
  }
  const assetPath = manifest.workloom.provides.evalQuestions;
  if (!assetPath) {
    throw new BundleError("NOT_FOUND", `行业包「${bundleId}」未声明考试题集`);
  }
  const parsed = QuestionSetSchema.safeParse(readVerifiedBundleJsonAsset(bundleId, assetPath, root));
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "题集"}：${issue.message}`)
      .join("；");
    throw new BundleError("INVALID_INPUT", `行业包考试题集不符合契约：${detail}`);
  }
  return {
    bundleId,
    bundleVersion: manifest.version,
    integrityDigest: manifest.integrity.digest,
    questions: parsed.data.questions.map((question) => ({
      subject: question.subject,
      structure: question.structure,
      primaryDimensions: [...question.primary_dimensions],
      redLine: question.red_line,
      difficulty: question.difficulty,
      source: question.source,
      tags: [...question.tags],
      scenario: question.scenario,
      assertions: question.assertions,
      ...(question.judge_rubric ? { judgeRubric: question.judge_rubric } : {}),
      ...(question.holdout !== undefined ? { holdout: question.holdout } : {}),
    })),
  };
}
