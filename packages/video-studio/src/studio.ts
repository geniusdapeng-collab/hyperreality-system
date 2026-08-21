/**
 * studio.ts —— 视频工作室核心桥：HyperrealitySystem（vendor）→ 视频经理运行时
 *
 * 职责：
 *  1. 装配 vendor 的 HyperrealitySystem（注入 WorkloomLLMEngine，禁止静默降级）
 *  2. 把 7 个确认门挂到宿主审批回调（宿主负责创建 IM 审批卡并等待裁决）
 *  3. 把流水线生命周期事件吐给宿主事件汇（宿主负责落 biz_events 五元事件）
 *  4. 产物（PRD/镜头提示词包/定妆照清单）以结构化结果返回，宿主入 asset-cms
 *
 * 本包不直接依赖 @workloom/* ——通过回调接口解耦，由 apps/server 完成接线。
 */

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installConfirmationHandler, type ConfirmationHandler } from "./confirmation.js";
import { resolveGate, type GateVerdict } from "./gates.js";
import { WorkloomLLMEngine } from "./llm-adapter.js";

/** vendor 引擎暴露的最小结构（HyperrealitySystem 实例方法） */
interface HyperrealitySystemLike {
  create(
    intent: string,
    metadata: Record<string, unknown>,
    options: Record<string, unknown>
  ): Promise<PreproductionResult>;
}

interface HyperrealitySystemCtor {
  new (options: Record<string, unknown>): HyperrealitySystemLike;
}

export interface PreproductionResult {
  success: boolean;
  stages?: Record<string, unknown>;
  [key: string]: unknown;
}

/** 宿主审批回调：收到待审批内容，返回裁决（由 IM 审批卡驱动） */
export type ApprovalCallback = (approval: {
  gate: string;
  vendorType: string;
  title: string;
  contentMd: string;
  runId: string | null;
}) => Promise<GateVerdict>;

/** 宿主事件汇：流水线生命周期事件（宿主落五元事件库） */
export type EventSink = (event: {
  kind:
    | "pipeline.started"
    | "pipeline.gate.requested"
    | "pipeline.gate.resolved"
    | "pipeline.finished"
    | "pipeline.failed";
  projectId: string;
  runId: string | null;
  gate?: string;
  payload?: Record<string, unknown>;
}) => void | Promise<void>;

export interface StudioConfig {
  llm: WorkloomLLMEngine;
  /** 项目工作目录（checkpoints / characters / confirmations 等运行产物根） */
  workDir: string;
  onApproval: ApprovalCallback;
  onEvent?: EventSink;
  /** 总截止（毫秒），默认 1 小时，与 vendor 默认一致 */
  totalDeadlineMs?: number;
  llmTimeoutMs?: number;
}

export interface RunInput {
  projectId: string;
  /** 创作意图原文（故事/主题/营销 Brief） */
  intent: string;
  metadata?: Record<string, unknown>;
  /** 是否为社媒营销类输入（决定是否强制情报层节点 0） */
  isMarketing?: boolean;
}

function resolveVendorEntry(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/ 运行（tsx）与 dist/ 运行（构建产物）两种布局都尝试
  const candidates = [
    path.resolve(here, "../../../vendor/supermickey/hyperreality-system/index.js"),
    path.resolve(here, "../../../../vendor/supermickey/hyperreality-system/index.js")
  ];
  const require = createRequire(import.meta.url);
  for (const p of candidates) {
    try {
      require.resolve(p);
      return p;
    } catch {
      /* try next */
    }
  }
  throw new Error("未找到 vendor/supermickey/hyperreality-system/index.js");
}

export class VideoStudio {
  private readonly cfg: StudioConfig;

  constructor(cfg: StudioConfig) {
    this.cfg = cfg;
  }

  /**
   * 跑一条完整预生产流水线（节点 0 情报 → 主题 → 洞察 → PRD → 镜头提示词 → 定妆照）
   * 渲染不在此内：渲染由 render-operator 消费 render_scripts 后单独执行（融合设计 §6）
   */
  async runPreproduction(input: RunInput): Promise<PreproductionResult> {
    const { cfg } = this;
    const require = createRequire(import.meta.url);
    const { HyperrealitySystem } = require(resolveVendorEntry()) as {
      HyperrealitySystem: HyperrealitySystemCtor;
    };

    const emit: EventSink = (e) => (cfg.onEvent ? cfg.onEvent(e) : undefined);
    let runId: string | null = null;

    const handler: ConfirmationHandler = async (req) => {
      const gate = resolveGate(req.type);
      await emit({
        kind: "pipeline.gate.requested",
        projectId: input.projectId,
        runId: req.runId ?? runId,
        gate,
        payload: { vendorType: req.type }
      });
      const verdict = await cfg.onApproval({
        gate,
        vendorType: req.type,
        title: `预生产确认门 · ${gate}`,
        contentMd: req.content,
        runId: req.runId ?? runId
      });
      await emit({
        kind: "pipeline.gate.resolved",
        projectId: input.projectId,
        runId: req.runId ?? runId,
        gate,
        payload: { approved: verdict.approved, reason: verdict.reason }
      });
      return verdict;
    };

    const uninstall = installConfirmationHandler(handler);

    // 与 vendor CLI（app/commands/preproduction.js）保持同一装配口径
    process.env.STORMAXE_TOTAL_DEADLINE_MS =
      process.env.STORMAXE_TOTAL_DEADLINE_MS ?? String(cfg.totalDeadlineMs ?? 3_600_000);

    const system = new HyperrealitySystem({
      llmEngine: cfg.llm,
      productionEngine: {
        agentConfig: {
          enableLLMAgents: true,
          llmTimeout: cfg.llmTimeoutMs ?? 180_000,
          llmMaxRetries: 2,
          llmModel: cfg.llm.model,
          fastModel: cfg.llm.fastModel,
          totalDeadlineMs: cfg.totalDeadlineMs ?? 3_600_000,
          promptFusionConcurrency: 1,
          checkpointDir: path.join(cfg.workDir, "checkpoints", input.projectId),
          enableResume: true
        }
      },
      charactersDir: path.join(cfg.workDir, "characters", input.projectId)
    });

    await emit({ kind: "pipeline.started", projectId: input.projectId, runId: null });
    try {
      const result = await system.create(input.intent, input.metadata ?? {}, {});
      await emit({
        kind: result.success ? "pipeline.finished" : "pipeline.failed",
        projectId: input.projectId,
        runId,
        payload: { stages: Object.keys(result.stages ?? {}) }
      });
      return result;
    } catch (err) {
      await emit({
        kind: "pipeline.failed",
        projectId: input.projectId,
        runId,
        payload: { error: err instanceof Error ? err.message : String(err) }
      });
      throw err;
    } finally {
      uninstall();
    }
  }
}
