/**
 * video/studio-worker.ts —— 预生产运行工作器（融合设计 §3 门矩阵 G1–G7 接线）
 *
 * 职责：
 *  1. 内存 run 注册表（runId → 运行投影），studio.start 异步启动不阻塞 tRPC 响应
 *  2. onApproval：确认门 → gatewayAppendOnClient 落门动作事件 + INSERT approvals（pending）
 *     → 轮询审批状态（VM_APPROVAL_POLL_MS / VM_APPROVAL_TIMEOUT_MS）→ 映射 GateVerdict
 *  3. onEvent：pipeline.* 生命周期事件经 gatewayAppend 落五元事件库
 *  4. LLM engine：WorkloomLLMEngine.fromEnv()；为 null 拒绝启动（禁止静默降级，vendor 纪律）
 *
 * 纪律：门事件与 approvals 行同一事务同一 COMMIT（D16）；事件一律经 workdata 安全网关。
 * 注意：ApprovalCallback 签名（packages/video-studio，冻结）不透传 vendor 的 shouldAbort，
 *      本工作器以 run 注册表 aborted 位实现同等中止语义（轮询每拍检查）。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAppPool, getGatewayPool } from "@workloom/db";
import { gatewayAppend, gatewayAppendOnClient } from "@workloom/base/workdata";
import { newId } from "@workloom/shared";
import {
  VideoStudio,
  WorkloomLLMEngine,
  type ApprovalCallback,
  type EventSink,
  type GateKey,
  type GateVerdict,
  type RunInput,
} from "@videomanager/video-studio";

/* ================= 可配项（环境变量） ================= */

/** 审批等待上限（默认 2 小时；超时 → { approved:false, fatal:'timeout' }） */
const APPROVAL_TIMEOUT_MS = Number(process.env.VM_APPROVAL_TIMEOUT_MS ?? 7_200_000);
/** 审批状态轮询间隔（默认 2s） */
const APPROVAL_POLL_MS = Number(process.env.VM_APPROVAL_POLL_MS ?? 2_000);
/** 流水线总截止（透传 vendor STORMAXE_TOTAL_DEADLINE_MS 口径，默认 1 小时） */
const TOTAL_DEADLINE_MS = Number(process.env.VM_TOTAL_DEADLINE_MS ?? 3_600_000);

const here = path.dirname(fileURLToPath(import.meta.url));
/** 运行产物根（checkpoints/characters/confirmations）：默认仓库根 .vm-work/ */
const WORK_DIR = process.env.VM_WORK_DIR ?? path.resolve(here, "../../../..", ".vm-work");

/** 工作器系统身份（事件归因；网关段① human/system 无额外校验） */
const WORKER_ACTOR = { id: "video-studio", type: "system" } as const;

/* ================= run 注册表 ================= */

export type RunStatus = "running" | "awaiting_approval" | "finished" | "failed";

export interface RunEntry {
  runId: string;
  projectId: string;
  workspaceId: string;
  status: RunStatus;
  /** 当前待审批门（无待审批为 null） */
  currentGate: GateKey | null;
  /** 当前待审批单号（G8 队列可直查） */
  pendingApprovalId: string | null;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  resultSummary: Record<string, unknown> | null;
  /** shouldAbort 位：置 true 后轮询下一拍中断（见文件头说明） */
  aborted: boolean;
}

const runs = new Map<string, RunEntry>();

/** run 投影（studio.status 数据源；L7.1：跨工作区查询返回 null） */
export function getRun(runId: string, workspaceId: string): RunEntry | null {
  const entry = runs.get(runId);
  if (!entry || entry.workspaceId !== workspaceId) return null;
  return entry;
}

export class StudioWorkerError extends Error {
  constructor(
    public readonly code: "LLM_MISSING",
    message: string,
  ) {
    super(message);
    this.name = "StudioWorkerError";
  }
}

/* ================= 门对象映射（§3 审批点矩阵逐字口径） ================= */

function gateObjectOf(gate: GateKey, vendorType: string): { type: string; action: string } {
  switch (gate) {
    case "G1_DOSSIER": return { type: "dossier", action: "dossier.confirm" };
    case "G2_THEME": return { type: "theme", action: "theme.confirm" };
    case "G3_INSIGHT": return { type: "insight", action: "insight.confirm" };
    case "G4_PRD": return { type: "prd", action: "prd.confirm" };
    case "G5_PORTRAIT": return { type: "portrait_set", action: "portrait.confirm" };
    case "G6_PROMPT": return { type: "prompt_package", action: "prompt.confirm" };
    case "G7_FINAL": return { type: "project", action: "preproduction.finalize" };
    default: return { type: vendorType || "gate", action: `${vendorType || "gate"}.confirm` };
  }
}

/* ================= 审批轮询 ================= */

interface ApprovalPollRow {
  status: string;
  gesture: { reason_enum?: string; reason_text?: string; edited_after?: unknown } | null;
}

async function readApproval(
  scope: { tenantId: string; workspaceId: string },
  approvalId: string,
): Promise<ApprovalPollRow | null> {
  const client = await getAppPool().connect();
  try {
    // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    const r = await client.query<ApprovalPollRow>(
      `SELECT status, gesture FROM approvals WHERE approval_id=$1 AND workspace_id=$2`,
      [approvalId, scope.workspaceId],
    );
    await client.query("COMMIT");
    return r.rows[0] ?? null;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 轮询审批状态 → GateVerdict（尊重 entry.aborted；超时 fatal='timeout'） */
async function pollApproval(
  entry: RunEntry,
  scope: { tenantId: string; workspaceId: string },
  approvalId: string,
): Promise<GateVerdict> {
  const deadline = Date.now() + APPROVAL_TIMEOUT_MS;
  for (;;) {
    if (entry.aborted) return { approved: false, reason: "run-aborted", fatal: "abort" };
    if (Date.now() >= deadline) return { approved: false, reason: "approval-timeout", fatal: "timeout" };
    const row = await readApproval(scope, approvalId);
    if (row && row.status !== "pending") {
      if (row.status === "approved") return { approved: true };
      if (row.status === "edited") {
        // 编辑后采纳：edited_after 文本作为 suggestions 回传引擎（F5.2 手势语义）
        const edited = row.gesture?.edited_after;
        const text = typeof edited === "string" ? edited : edited !== undefined ? JSON.stringify(edited) : "";
        return { approved: true, suggestions: text ? [text] : [] };
      }
      if (row.status === "rejected") {
        return { approved: false, reason: row.gesture?.reason_text ?? row.gesture?.reason_enum ?? "rejected" };
      }
      // expired 等其余终态按驳回处理（L5.4：不存在超时自动放行）
      return { approved: false, reason: `approval-${row.status}` };
    }
    await sleep(APPROVAL_POLL_MS);
  }
}

/* ================= 启动入口 ================= */

interface Scope { tenantId: string; workspaceId: string }

/**
 * 异步启动一条预生产流水线（不阻塞 tRPC 响应；失败只反映在注册表投影）
 * @throws StudioWorkerError LLM_MISSING —— LLM_* 四环境变量未配齐（禁止静默降级）
 */
export function startRun(scope: Scope, input: RunInput): string {
  const llm = WorkloomLLMEngine.fromEnv();
  if (!llm) {
    throw new StudioWorkerError(
      "LLM_MISSING",
      "LLM 引擎未配置（需 LLM_BASE_URL/LLM_API_KEY/LLM_MODEL），拒绝启动预生产（vendor 纪律：禁止静默降级）",
    );
  }

  const entry: RunEntry = {
    runId: newId("RUN"),
    projectId: input.projectId,
    workspaceId: scope.workspaceId,
    status: "running",
    currentGate: null,
    pendingApprovalId: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    resultSummary: null,
    aborted: false,
  };
  runs.set(entry.runId, entry);

  const onEvent: EventSink = async (e) => {
    await gatewayAppend(getGatewayPool(), { ...scope, actor: { ...WORKER_ACTOR } }, {
      who: { ...WORKER_ACTOR },
      context: {
        tenant_id: scope.tenantId, workspace_id: scope.workspaceId,
        time: new Date().toISOString(), channel: "inapp",
      },
      object: { type: "video_project", id: e.projectId },
      decision: {
        action: e.kind,
        after: { runId: e.runId ?? entry.runId, gate: e.gate ?? null, ...(e.payload ?? {}) },
      },
      rule_impact: [],
    });
  };

  const onApproval: ApprovalCallback = async (req) => {
    // ApprovalCallback.gate 声明为 string，但适配层（studio.ts）保证已 resolveGate 过，运行时为 GateKey
    const gate = req.gate as GateKey;
    const gateObj = gateObjectOf(gate, req.vendorType);
    const objectId = gate === "G7_FINAL" ? input.projectId : `${input.projectId}:${gate.toLowerCase()}`;
    // D16（#1/A）：门动作事件与 approvals 行同一事务同一 COMMIT（模仿 fence.confirmDryRun 口径）
    const client = await getAppPool().connect();
    let approvalId: string;
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
      const ev = await gatewayAppendOnClient(client, { ...scope, actor: { ...WORKER_ACTOR } }, {
        who: { ...WORKER_ACTOR },
        context: {
          tenant_id: scope.tenantId, workspace_id: scope.workspaceId,
          time: new Date().toISOString(), channel: "inapp",
        },
        object: { type: gateObj.type, id: objectId },
        decision: {
          action: gateObj.action,
          after: { gate: req.gate, vendorType: req.vendorType, runId: entry.runId, title: req.title },
          basis: [`预生产确认门 ${req.gate}（§3 门矩阵：${gateObj.action} 默认 review）`],
        },
        rule_impact: [],
      });
      approvalId = `apr-${ev.eventId.toLowerCase()}`;
      await client.query(
        `INSERT INTO approvals (approval_id, tenant_id, workspace_id, event_id, channel, status, snapshot)
         VALUES ($1,$2,$3,$4,'inapp','pending',$5)
         ON CONFLICT (event_id, channel) DO NOTHING`,
        [
          approvalId, scope.tenantId, scope.workspaceId, ev.eventId,
          JSON.stringify({ contentMd: req.contentMd, gate: req.gate, vendorType: req.vendorType }),
        ],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }

    entry.currentGate = gate;
    entry.pendingApprovalId = approvalId!;
    entry.status = "awaiting_approval";
    const verdict = await pollApproval(entry, scope, approvalId!);
    entry.currentGate = null;
    entry.pendingApprovalId = null;
    if (entry.status === "awaiting_approval") entry.status = "running";
    return verdict;
  };

  const studio = new VideoStudio({
    llm,
    workDir: WORK_DIR,
    onApproval,
    onEvent,
    totalDeadlineMs: TOTAL_DEADLINE_MS,
  });

  // 异步执行：不阻塞 tRPC 响应；终态只写注册表投影（生命周期事件由 onEvent 落库）
  void (async () => {
    try {
      const result = await studio.runPreproduction(input);
      entry.status = "finished";
      entry.resultSummary = {
        success: result.success,
        stages: Object.keys(result.stages ?? {}),
      };
    } catch (err) {
      entry.status = "failed";
      entry.error = err instanceof Error ? err.message : String(err);
    } finally {
      entry.finishedAt = new Date().toISOString();
    }
  })();

  return entry.runId;
}
