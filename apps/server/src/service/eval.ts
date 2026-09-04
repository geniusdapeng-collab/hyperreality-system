/**
 * service/eval · 考试院服务端（方案 V2.0 §6/§12）
 *  - 考场编排：题库装载 → 分层抽样 → 真实管线收卷（service-dialog handleMessage）→ 硬判 → 记分卡
 *  - 隔离纪律：考场会话以 eval-<examId> 前缀的 c_user_id 发起，与真实客人天然分流；
 *    写操作题（投诉/工单类）走到"挂起待审批"即收卷（dialog 本身只起草不执行）。
 *  - 硬轨零 token；软题 L3 阅卷 P1 接入（judgeRubric 已入库待用）。
 */
import { randomUUID } from "node:crypto";
import { svcQuery, serviceTx } from "./events.js";
import { handleMessage } from "./dialog.js";
import {
  assembleScorecard, computeDelta, evaluateAll, gradeAnswer, stratifiedSample,
  HOTEL_CS_SEED_QUESTIONS,
  type AnswerResult, type DimScores, type EvalQuestion, type Verdict,
} from "@workloom/base/eval-core";

const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;

/* ---------------- DB 行 ↔ 领域对象 ---------------- */
interface QuestionRow extends Record<string, unknown> {
  id: string; subject: string; structure: string; primary_dimensions: unknown;
  red_line: boolean; difficulty: string; source: string; tags: unknown;
  scenario: unknown; assertions: unknown; judge_rubric: unknown; holdout: boolean;
}

function toQuestion(row: QuestionRow): EvalQuestion {
  return {
    id: row.id,
    subject: row.subject as EvalQuestion["subject"],
    structure: row.structure as EvalQuestion["structure"],
    primaryDimensions: row.primary_dimensions as EvalQuestion["primaryDimensions"],
    redLine: row.red_line,
    difficulty: row.difficulty as EvalQuestion["difficulty"],
    source: row.source as EvalQuestion["source"],
    tags: row.tags as string[],
    scenario: row.scenario as EvalQuestion["scenario"],
    assertions: row.assertions as EvalQuestion["assertions"],
    judgeRubric: row.judge_rubric as EvalQuestion["judgeRubric"],
    holdout: row.holdout,
  };
}

/* ---------------- 题库 ---------------- */

/** 题库为空时自动播种子题（酒店客服科四种结构+红线），返回题量 */
export async function seedQuestionsIfEmpty(workspaceId: string): Promise<number> {
  return serviceTx(workspaceId, async (client) => {
    const cur = await client.query(`SELECT count(*)::int AS c FROM eval_questions`);
    if (cur.rows[0].c > 0) return 0;
    for (const q of HOTEL_CS_SEED_QUESTIONS) {
      await client.query(
        `INSERT INTO eval_questions
           (id, workspace_id, subject, structure, primary_dimensions, red_line, difficulty, source, tags, scenario, assertions, judge_rubric, holdout)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,false)`,
        [
          newId("evq"), workspaceId, q.subject, q.structure,
          JSON.stringify(q.primaryDimensions), q.redLine, q.difficulty, q.source,
          JSON.stringify(q.tags), JSON.stringify(q.scenario),
          JSON.stringify(q.assertions), q.judgeRubric ? JSON.stringify(q.judgeRubric) : null,
        ],
      );
    }
    return HOTEL_CS_SEED_QUESTIONS.length;
  });
}

export async function listQuestions(workspaceId: string) {
  const rows = await svcQuery<QuestionRow & { created_at: string }>(
    workspaceId,
    `SELECT * FROM eval_questions WHERE status='active' ORDER BY structure, red_line DESC, created_at`,
  );
  return rows.map((row) => ({ ...toQuestion(row), createdAt: row.created_at }));
}

/* ---------------- 考试编排 ---------------- */

export interface ExamSummary {
  id: string; examType: string; triggerSource: string; totalQuestions: number;
  status: string; totalScore: number | null; dimScores: DimScores | null;
  redLineHit: boolean; verdict: Verdict | null; startedAt: string; finishedAt: string | null;
}

/** 开考：真实管线收卷 + 硬判 + 记分卡 + 报告，全流程一个函数走完（P0 同步执行，题量小） */
export async function runExam(workspaceId: string, opts: {
  examType: "on-change" | "weekly" | "onboarding";
  triggerSource?: string;
  subjectScope?: string[];
  perStructure?: number;
}): Promise<{ exam: ExamSummary; answers: AnswerResult[]; report: unknown }> {
  await seedQuestionsIfEmpty(workspaceId);

  const examId = newId("evx");
  const perStructure = opts.perStructure ?? 5;

  // 装载题库（可按科目限定）
  const scope = opts.subjectScope ?? [];
  const qRows = await svcQuery<QuestionRow>(
    workspaceId,
    scope.length > 0
      ? `SELECT * FROM eval_questions WHERE status='active' AND subject = ANY($2)`
      : `SELECT * FROM eval_questions WHERE status='active'`,
    scope.length > 0 ? [scope] : [],
  );
  const pool = qRows.map(toQuestion);
  if (pool.length === 0) throw new Error("题库为空——请先播种或添加考题");

  const sampled = stratifiedSample(pool, perStructure);

  // 考场虚拟考生（c_conversations 外键需要；eval- 前缀与真实客人天然分流。
  // 必须在考场事务外独立提交——dialog 内部嵌套开新连接，看不到本事务未提交行）
  await svcQuery(workspaceId,
    `INSERT INTO c_users (id, workspace_id, channel, openid, nickname)
     VALUES ($1, current_setting('app.workspace_id', true), 'h5', $1, '考场虚拟考生')
     ON CONFLICT (id) DO NOTHING`,
    [`eval-${examId}`]);

  return serviceTx(workspaceId, async (client, sc) => {
    await client.query(
      `INSERT INTO eval_exams (id, workspace_id, exam_type, trigger_source, subject_scope, total_questions, status)
       VALUES ($1,$2,$3,$4,$5,$6,'running')`,
      [examId, workspaceId, opts.examType, opts.triggerSource ?? "manual",
       JSON.stringify(scope), sampled.length],
    );

    // 真实管线收卷：harness 适配 service-dialog handleMessage
    const answers: AnswerResult[] = [];
    for (const q of sampled) {
      const replies = await import("@workloom/base/eval-core").then(async ({ runQuestion }) =>
        runQuestion(q, async ({ conversationId, text, cUserId }) => {
          const r = await handleMessage({
            workspaceId, cUserId, channel: "h5", text, conversationId,
          });
          return {
            conversationId: r.conversationId,
            answer: r.answer,
            citations: (r.citations ?? []).map((c) => typeof c === "string" ? c : `${(c as { documentTitle?: string }).documentTitle ?? "kb"}`),
            intent: r.intent,
            ticketKind: r.ticketDraft?.kind,
          };
        }, examId));

      const results = evaluateAll(q.assertions, replies);
      const graded = gradeAnswer(q, replies, results);
      answers.push(graded);

      await client.query(
        `INSERT INTO eval_answers
           (id, workspace_id, exam_id, question_id, replies, assertion_results, dim_scores, passed, red_line_hit, attribution, suggestion)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          newId("eva"), workspaceId, examId, q.id,
          JSON.stringify(graded.replies), JSON.stringify(graded.assertionResults),
          JSON.stringify(graded.dimScores), graded.passed, graded.redLineHit,
          graded.attribution ?? null, graded.suggestion ?? null,
        ],
      );
    }

    // 记分卡 + delta（vs 上一场同类型）
    const card = assembleScorecard(answers);
    const prev = await client.query<{ total_score: string; dim_scores: DimScores }>(
      `SELECT total_score, dim_scores FROM eval_exams
       WHERE workspace_id=$1 AND exam_type=$2 AND status='done' AND id<>$3
       ORDER BY started_at DESC LIMIT 1`,
      [workspaceId, opts.examType, examId],
    );
    const prevCard = prev.rows[0]
      ? { totalScore: Number(prev.rows[0].total_score), dimScores: prev.rows[0].dim_scores }
      : null;
    const delta = computeDelta(
      { totalScore: card.totalScore, dimScores: card.dimScores }, prevCard);

    await client.query(
      `UPDATE eval_exams SET status='done', total_score=$2, dim_scores=$3, red_line_hit=$4, verdict=$5, finished_at=now()
       WHERE id=$1`,
      [examId, card.totalScore, JSON.stringify(card.dimScores), card.redLineHit, card.verdict],
    );

    const wrongAnswers = answers.filter((a) => !a.passed);
    const reportId = newId("evr");
    await client.query(
      `INSERT INTO eval_reports
         (id, workspace_id, exam_id, total_score, dim_scores, subject_scores, delta, verdict, red_line_hit, wrong_count, suggestions)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        reportId, workspaceId, examId, card.totalScore, JSON.stringify(card.dimScores),
        JSON.stringify({}), JSON.stringify(delta), card.verdict, card.redLineHit,
        wrongAnswers.length,
        JSON.stringify(wrongAnswers.map((a) => ({ questionId: a.questionId, attribution: a.attribution, suggestion: a.suggestion }))),
      ],
    );

    const examRow = await client.query(
      `SELECT * FROM eval_exams WHERE id=$1`, [examId]);
    const e = examRow.rows[0];
    const exam: ExamSummary = {
      id: e.id, examType: e.exam_type, triggerSource: e.trigger_source,
      totalQuestions: e.total_questions, status: e.status,
      totalScore: e.total_score === null ? null : Number(e.total_score),
      dimScores: e.dim_scores, redLineHit: e.red_line_hit, verdict: e.verdict,
      startedAt: e.started_at, finishedAt: e.finished_at,
    };
    return { exam, answers, report: { id: reportId, delta, verdict: card.verdict } };
  });
}

export async function listExams(workspaceId: string, limit = 20): Promise<ExamSummary[]> {
  const rows = await svcQuery<Record<string, unknown> & { id: string }>(
    workspaceId,
    `SELECT * FROM eval_exams ORDER BY started_at DESC LIMIT $2`,
    [limit],
  );
  return rows.map((e) => ({
    id: e.id as string,
    examType: e.exam_type as string,
    triggerSource: e.trigger_source as string,
    totalQuestions: e.total_questions as number,
    status: e.status as string,
    totalScore: e.total_score === null ? null : Number(e.total_score),
    dimScores: e.dim_scores as DimScores | null,
    redLineHit: e.red_line_hit as boolean,
    verdict: e.verdict as Verdict | null,
    startedAt: e.started_at as string,
    finishedAt: e.finished_at as string | null,
  }));
}

export async function latestReport(workspaceId: string) {
  const rows = await svcQuery<Record<string, unknown>>(workspaceId,
    `SELECT * FROM eval_reports ORDER BY created_at DESC LIMIT 1`);
  return rows[0] ?? null;
}

export async function listAnswers(workspaceId: string, examId: string) {
  return svcQuery<Record<string, unknown>>(workspaceId,
    `SELECT a.*, q.subject, q.structure, q.red_line, q.tags, q.scenario
     FROM eval_answers a JOIN eval_questions q ON q.id = a.question_id
     WHERE a.exam_id=$2 ORDER BY a.created_at`,
    [examId]);
}

/* ---------------- 设置 ---------------- */

export async function getSettings(workspaceId: string) {
  const rows = await svcQuery<Record<string, unknown>>(workspaceId,
    `SELECT * FROM eval_settings WHERE workspace_id=current_setting('app.workspace_id', true)`);
  if (rows[0]) return rows[0];
  // 懒初始化默认设置
  await svcQuery(workspaceId,
    `INSERT INTO eval_settings (workspace_id) VALUES (current_setting('app.workspace_id', true)) ON CONFLICT DO NOTHING`);
  const again = await svcQuery<Record<string, unknown>>(workspaceId,
    `SELECT * FROM eval_settings WHERE workspace_id=current_setting('app.workspace_id', true)`);
  return again[0];
}

export async function setPromotionGate(workspaceId: string, enabled: boolean) {
  await svcQuery(workspaceId,
    `UPDATE eval_settings SET promotion_gate=$2, updated_at=now()
     WHERE workspace_id=current_setting('app.workspace_id', true)`,
    [enabled]);
  return getSettings(workspaceId);
}
