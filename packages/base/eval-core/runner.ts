/**
 * eval-core · 考场执行器（方案 V2.0 §6 第 2 步）
 * 考题经系统正常入口驱动真实管线（service-dialog handleMessage），
 * 逐轮收卷：回复文本 / 引用 / 意图 / 耗时 / 工单——日记就是答题卡。
 * 隔离纪律：考场会话以 eval- 前缀的 c_user_id 发起，与真实客人会话天然分流；
 *           写操作题（ticket 类）走到"挂起待审批"即收卷（handleMessage 本身只起草不执行）。
 */
import type { EvalQuestion, TurnReply } from "./types.js";

/** 对话管线最小接口（由调用方注入 service-dialog handleMessage 的适配） */
export interface DialogHarness {
  (input: { conversationId?: string; text: string; cUserId: string }): Promise<{
    conversationId: string;
    answer: string;
    citations: string[];
    intent: string;
    ticketKind?: string;
  }>;
}

/** 执行一道题的全部轮次，返回逐轮应答 */
export async function runQuestion(
  question: EvalQuestion,
  harness: DialogHarness,
  examId: string,
): Promise<TurnReply[]> {
  const replies: TurnReply[] = [];
  let conversationId: string | undefined;
  // 考场身份：eval-<examId> 前缀——与真实客人分流，考后可按前缀清理
  const cUserId = `eval-${examId}`;

  const turns = question.scenario.turns;
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]!;
    if (turn.role !== "guest") continue;   // system 轮（如围栏动作注入）由 fence 断言通道处理
    const t0 = Date.now();
    const result = await harness({ conversationId, text: turn.input, cUserId });
    const latencyMs = Date.now() - t0;
    conversationId = result.conversationId;
    replies.push({
      turn: i + 1,
      text: result.answer,
      citations: result.citations,
      intent: result.intent,
      latencyMs,
      ticketCreated: result.ticketKind,
    });
  }
  return replies;
}

/** 分层抽样（方案 V2.0 §4：四种结构每场全覆盖） */
export function stratifiedSample<T extends { structure: string }>(
  questions: T[],
  perStructure: number,
): T[] {
  const byStructure = new Map<string, T[]>();
  for (const q of questions) {
    const list = byStructure.get(q.structure) ?? [];
    list.push(q);
    byStructure.set(q.structure, list);
  }
  const sampled: T[] = [];
  for (const list of byStructure.values()) {
    // 洗牌后取前 N（每场题面不同，配合参数化变体防背题）
    const shuffled = [...list].sort(() => Math.random() - 0.5);
    sampled.push(...shuffled.slice(0, perStructure));
  }
  return sampled;
}
