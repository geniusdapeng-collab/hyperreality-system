/**
 * tRPC 根路由（B11 状态：system / auth / members / threads / approvals / inspection / skills
 * / workspace / nightShift / fence / roster / im 挂载；其余 router（events / bundle）后续按需要挂载）
 * 已挂载：B10 inspection（巡检 M9）/ skills（技能+意识 M8）；F3 workspace（档案/成员）/ nightShift（夜班投影）；
 * F8 fence（围栏版本化+dry-run）；F9 roster（P8 船员名册：人机混编投影 + 工时聚合 L6.3 + 档案全字段）；
 * B11 im（IM 通道域 D14：注册表/入站幂等/审批卡片出站/手势回调，Mock 驱动默认）
 * F11 bundles（P7 舰船换装坞：六槽注册表投影/起飞前检查单/profile 激活切换/五要素草稿向导）
 * 本文件同时是前端类型源：apps/web 经 `@workloom/server/router` 导入 AppRouter 类型。
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAppPool, getGatewayPool, getOwnerPool } from "@workloom/db";
import {
  getCapabilities,
  getMember,
  listMembers,
  signDemoToken,
  type Identity,
} from "@workloom/base/tenancy";
import { gatewayAppend, gatewayAppendOnClient, MockEmbedder, upsertMemoryInTx } from "@workloom/base/workdata";
import { makeReadableId } from "@workloom/shared";
import { capabilityWriteProcedure, protectedProcedure, publicProcedure, router, scopeOf, writeProcedure } from "./context.js";
import {
  ApprovalError,
  batchApprove,
  decide,
  expireSweep,
  listQueue,
} from "@workloom/base/review-console";
import { routeIntent, runAsk, runQuest } from "@workloom/runtime";
import { LlmIntentClassifier, type IntentClassifier } from "@workloom/runtime";
import { providerFromEnv, OpenAiCompatibleProvider } from "@workloom/base/model-router";
import { routedLlmCall, resetLlmAssembly } from "../service/llm.js";
import { creditsRouter, modelFeedbackRouter } from "./credits-router.js";
import { runRouterReviewBeat } from "@workloom/base/model-router";
import {
  loadCharter, parseCharter, transition, defaultCharter,
  runBriefingBeat, runQueueBeat, runDeviationBeat, runBreakerBeat, buildScorecard,
  runOutcomeReviewBeat, runHrReviewBeat, runBoardPackBeat, runOrgScanBeat, applyReplacement,
  buildFloor,
  type CeoTransition,
} from "@workloom/base/captain";
import {
  buildCandidateList,
  confirmNight,
  deliverPackage,
  ensureReady,
  NightTransitionError,
  pauseAll,
  resumeNight,
} from "@workloom/base/night-shift";
import {
  activateRuleVersion,
  confirmDryRun,
  createDryRun,
  fenceActivationFromProposal,
  fenceRuleRowId,
} from "@workloom/base/fence-engine";
import { MAX_CONCURRENT_THREADS, PLAN_TIERS } from "@workloom/shared";
import {
  dispatchFromAnomaly,
  DispatchError,
  inspectionStatusBar,
  resolveAnomaly,
  runInspectionScan,
} from "@workloom/base/inspection";
import {
  confirmSuggestion,
  createSkillDraft,
  detectSuggestions,
  dryRunSkill,
  installSkill,
  listInstalls,
  listSkills,
  rejectSuggestion,
  SkillError,
  uninstallSkill,
} from "@workloom/base/skills";
import {
  distStatus,
  loadStaging,
  rollbackSkill,
  setSilentMode,
  SkillOpsError,
  syncDistribution,
  type InstanceProfile,
} from "@workloom/base/skill-ops";
import {
  getRefluxOptIn,
  previewReflux,
  RefluxError,
  sendReflux,
  setRefluxOptIn,
} from "@workloom/base/skill-ops";
import {
  buildManifest,
  consoleHealth,
  ConsoleError,
  listInbox,
  officializeDraft,
  reviewRefluxDraft,
} from "@workloom/base/skill-ops";
import {
  boundOpenidOfMember,
  ChannelError,
  composeApprovalCard,
  handleGestureCallback,
  ingestInbound,
  listChannels,
  MockChannelDriver,
  sendApprovalCard,
  stableStringify,
  verifyChannelSignature,
  type ChannelDriver,
  type ApprovalChannel,
} from "@workloom/base/im-channels";
import {
  BundleError,
  activateBundle,
  computeAssembly,
  createBundleDraft,
  listProfileSlugs,
  recheckBundle,
} from "@workloom/base/bundles";
import { serviceRouter } from "../service/router.js";
import { appendEventOn } from "../service/events.js";
import {
  buildEvolutionScorecard,
  decayMemories,
  disableMemory,
  editMemoryContent,
  getFeedbackEnums,
  recallMemoriesByMember,
  runMemoryMinerBeat,
} from "@workloom/base/evolve";
import { getMemorySources, searchMemories } from "@workloom/base/workdata";

/** system router：健康检查（公开） */
const systemRouter = router({
  health: publicProcedure.query(async () => {
    let db: "up" | "down" = "down";
    try {
      await getAppPool().query("SELECT 1");
      db = "up";
    } catch {
      db = "down";
    }
    return {
      ok: true,
      service: "workloom-im-server",
      phase: "阶段二 后端 API（B5）",
      db,
      time: new Date().toISOString(),
    };
  }),
});

/* ================= 落地向导（D24：模拟运行态 → 真实经营 切换面） =================
 * 契约：首次安装开箱即为「全模拟运行态」（种子数据 + mock 模型），P0/工作台横幅常显提示；
 * 向导四步（自检 → 真实大模型 → 经营主体 → 启用真实模式）尽量自动化：
 *  - saveLlmConfig 真实试调通过才落盘（.env 四变量 + process.env + 清缓存，全链即时真实化）
 *  - activateRealMode 翻转 profiles.archive.dataMode（simulated→real），横幅熄灭
 * 全程五元事件留痕；API Key 只记掩码后 4 位（L6.2 同纪律）。
 */

/** 仓库根 .env 定位（cwd 可能是 apps/server 或仓库根；向上找 pnpm-workspace.yaml） */
function locateEnvFile(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return join(dir, ".env");
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return join(process.cwd(), ".env");
}

/** 四 env 写回 .env（保留其他行）+ 同步 process.env + 清 LLM 缓存（全链即时生效，无需重启）
 * 注意（D26 审计#5）：LLM 装配为进程级全局——部署口径是「一进程一工作区」（local-first 单店），
 * 多工作区共享进程时全租户共用同一装配；按工作区留痕仅为审计归属，不构成隔离。 */
function persistLlmEnv(cfg: { provider: string; baseUrl: string; apiKey: string; model: string }): void {
  const file = locateEnvFile();
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
  const set = (k: string, v: string) => {
    const i = lines.findIndex((l) => l.startsWith(`${k}=`));
    if (i >= 0) lines[i] = `${k}=${v}`;
    else lines.push(`${k}=${v}`);
    process.env[k] = v;
  };
  set("LLM_PROVIDER", cfg.provider);
  set("LLM_BASE_URL", cfg.baseUrl);
  set("LLM_API_KEY", cfg.apiKey);
  set("LLM_MODEL", cfg.model);
  writeFileSync(file, lines.filter((l, i) => l !== "" || i < lines.length - 1).join("\n"));
  cachedLlmCall = undefined; // 复位装配缓存（见 llmCall()/intentClassifier()）
  cachedClassifier = undefined;
  cachedIndustry = undefined;
  resetLlmAssembly(); // v3.0：模型池与行业策略缓存同步复位（写盘即全链生效免重启）
}

/** LLM 装配状态（真实=非 mock 且 baseUrl 齐备；apiKey 可空=免 key 网关） */
function llmAssembly(): { provider: string; model: string; baseUrl: string; real: boolean } {
  const provider = process.env.LLM_PROVIDER ?? "mock";
  const baseUrl = process.env.LLM_BASE_URL ?? "";
  return {
    provider,
    model: process.env.LLM_MODEL ?? "",
    baseUrl,
    real: provider !== "mock" && baseUrl.length > 0,
  };
}

/** 真实试调探针（落地向导「测试连接」：真实 round-trip 通过才允许保存） */
async function probeLlm(cfg: { baseUrl: string; apiKey?: string; model: string }): Promise<{ reply: string; latencyMs: number }> {
  const provider = new OpenAiCompatibleProvider(cfg.model, { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey || undefined });
  const t0 = Date.now();
  const res = await Promise.race([
    provider.chat([{ role: "user", content: "你是企业经营系统的数字员工。请用一句中文回答：你已在线，可以开始工作。" }]),
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error("模型响应超时（25s）")), 25_000)),
  ]);
  if (!res.text.trim()) throw new Error("模型返回为空");
  return { reply: res.text.trim().slice(0, 200), latencyMs: Date.now() - t0 };
}

const onboardingRouter = router({
  /** 运行态总览（P0 横幅/落地向导同一事实源）：数据模式 + LLM 装配 + 工作区规模 */
  status: protectedProcedure.query(async ({ ctx }) => {
    const scope = scopeOf(ctx.identity);
    const app = getAppPool();
    const client = await app.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
      const prof = await client.query<{ data_mode: string | null }>(
        `SELECT archive->>'dataMode' AS data_mode FROM profiles WHERE workspace_id=$1`,
        [scope.workspaceId],
      );
      const ws = await client.query<{ name: string; bundle_id: string | null; is_example: boolean }>(
        `SELECT name, bundle_id, is_example FROM workspaces WHERE id=$1`, [scope.workspaceId]);
      const n = async (sql: string) => Number((await client.query<{ n: string }>(sql, [scope.workspaceId])).rows[0]?.n ?? 0);
      const [events, members, agents, memories] = await Promise.all([
        n(`SELECT count(*)::text AS n FROM biz_events WHERE workspace_id=$1`),
        n(`SELECT count(*)::text AS n FROM members WHERE workspace_id=$1`),
        n(`SELECT count(*)::text AS n FROM agents WHERE workspace_id=$1`),
        n(`SELECT count(*)::text AS n FROM org_memory WHERE workspace_id=$1`),
      ]);
      await client.query("COMMIT");
      return {
        // 缺省按模拟态处理（种子库/历史库均无标记时横幅常显，宁可多提示不可漏提示）
        dataMode: (prof.rows[0]?.data_mode ?? "simulated") as "simulated" | "real",
        llm: llmAssembly(),
        workspace: { name: ws.rows[0]?.name ?? "", events, members, agents, memories },
        workspaceId: scope.workspaceId,
        // V4 §2 示例明示：示例包装配标记（SimBanner 银带语义事实源）
        bundle: { id: ws.rows[0]?.bundle_id ?? null, isExample: !!ws.rows[0]?.is_example },
      };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }),

  /** 第①步：真实大模型「测试连接」（真实 round-trip；不落盘、不留痕 key） */
  testLlm: writeProcedure
    .input(z.object({
      baseUrl: z.string().url().min(1),
      apiKey: z.string().max(200).default(""),
      model: z.string().min(1).max(80),
    }))
    .mutation(async ({ input }) => {
      try {
        const r = await probeLlm(input);
        return { ok: true as const, ...r };
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
      }
    }),

  /** 第①步保存：真实试调通过 → 写 .env 四变量 + 即时生效 + 事件留痕（key 只记掩码；provider=mock 为还原操作，免实测） */
  saveLlmConfig: writeProcedure
    .input(z.object({
      provider: z.string().min(1).max(40),
      baseUrl: z.string().max(200).default(""),
      apiKey: z.string().max(200).default(""),
      model: z.string().max(80).default(""),
    }))
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      if (input.provider !== "mock") {
        if (!z.string().url().safeParse(input.baseUrl).success || !input.model) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "真实模型装配需要合法的 baseUrl 与 model" });
        }
        try {
          await probeLlm({ baseUrl: input.baseUrl, apiKey: input.apiKey, model: input.model }); // 真实试调不过 → 拒绝保存（不落半残配置）
        } catch (err) {
          throw new TRPCError({ code: "BAD_REQUEST", message: `模型实测未通过，未保存：${err instanceof Error ? err.message : err}` });
        }
      }
      persistLlmEnv(input);
      // D16（#1/A）：事件写入并入显式事务（.env 落盘不可回滚，故事件写在其成功后同一 COMMIT 提交）
      const llmClient = await getAppPool().connect();
      try {
        await llmClient.query("BEGIN");
        await llmClient.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
        await llmClient.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
        await gatewayAppendOnClient(llmClient, {
          ...scope, actor: { id: ctx.identity.memberNo, type: "human" }, sessionId: `onboarding-${scope.workspaceId}`,
        }, {
          who: { type: "human", id: ctx.identity.memberNo },
          context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString() },
          object: { type: "workspace", id: scope.workspaceId },
          decision: {
            action: "onboarding.llm_configured",
            params: {
              provider: input.provider, base_url: input.baseUrl, model: input.model,
              key_mask: input.apiKey ? `***${input.apiKey.slice(-4)}` : "(免 key 网关)",
            },
            after: { real: input.provider !== "mock" },
            basis: ["落地向导：真实大模型装配（实测通过后写回 .env 四变量，全链即时生效）"],
          },
          rule_impact: [],
          model_trace: { model_id: "human-operator", tier: "standard" },
        });
        await llmClient.query("COMMIT");
      } catch (err) {
        await llmClient.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        llmClient.release();
      }
      return { ok: true, real: input.provider !== "mock" };
    }),

  /** 第②步：经营主体信息（工作区名 + 行业 + 简介 → 档案；事件留痕） */
  setupWorkspace: writeProcedure
    .input(z.object({
      displayName: z.string().min(1).max(60),
      industry: z.string().min(1).max(40),
      note: z.string().max(300).default(""),
    }))
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const app = getAppPool();
      const client = await app.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
        await client.query(`UPDATE workspaces SET name=$2, industry=$3 WHERE id=$1`, [scope.workspaceId, input.displayName, input.industry]);
        await client.query(
          `UPDATE profiles SET archive = jsonb_set(archive, '{business}', $2::jsonb), industry=$3, updated_at=now() WHERE workspace_id=$1`,
          [scope.workspaceId, JSON.stringify({ name: input.displayName, note: input.note, onboarded_at: new Date().toISOString() }), input.industry],
        );
        // D16（#1/A）：档案写与事件留痕同一事务同一 COMMIT
        await gatewayAppendOnClient(client, {
          ...scope, actor: { id: ctx.identity.memberNo, type: "human" }, sessionId: `onboarding-${scope.workspaceId}`,
        }, {
          who: { type: "human", id: ctx.identity.memberNo },
          context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString() },
          object: { type: "workspace", id: scope.workspaceId },
          decision: {
            action: "onboarding.workspace_profile",
            params: { name: input.displayName, industry: input.industry, note: input.note },
            after: {},
            basis: ["落地向导：经营主体信息写入一店一档（archive.business）"],
          },
          rule_impact: [],
          model_trace: { model_id: "human-operator", tier: "standard" },
        });
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
      return { ok: true };
    }),

  /** 第③步：启用真实模式（dataMode simulated→real；横幅熄灭；事件留痕。模拟期事件保留为「演示期」历史，可经 reset.sh 整库重建清空） */
  activateRealMode: writeProcedure.mutation(async ({ ctx }) => {
    const scope = scopeOf(ctx.identity);
    const app = getAppPool();
    const client = await app.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
      await client.query(
        `UPDATE profiles SET archive = jsonb_set(archive, '{dataMode}', '"real"'::jsonb), updated_at=now() WHERE workspace_id=$1`,
        [scope.workspaceId],
      );
      // D16（#1/A）：dataMode 翻转与事件留痕同一事务同一 COMMIT
      await gatewayAppendOnClient(client, {
        ...scope, actor: { id: ctx.identity.memberNo, type: "human" }, sessionId: `onboarding-${scope.workspaceId}`,
      }, {
        who: { type: "human", id: ctx.identity.memberNo },
        context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString() },
        object: { type: "workspace", id: scope.workspaceId },
        decision: {
          action: "onboarding.real_mode_activated",
          params: { from: "simulated", to: "real" },
          after: { dataMode: "real" },
          basis: ["落地向导收官：切换真实经营模式，模拟数据横幅熄灭；此后经营动作即真实数据"],
        },
        rule_impact: [],
        model_trace: { model_id: "human-operator", tier: "standard" },
      });
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    return { ok: true, dataMode: "real" as const };
  }),
});

/** auth router：演示身份登录（总纲 §2.4：选择种子成员签发 JWT） */
const authRouter = router({
  loginAs: publicProcedure
    .input(z.object({ workspaceSlug: z.string(), memberNo: z.string() }))
    .mutation(async ({ input }) => {
      const app = getAppPool();
      // 登录引导例外点（F7.1）：身份未建立前无法 set_config，workspace 解析走 owner 池
      const ws = await getOwnerPool().query<{ id: string; tenant_id: string }>(
        `SELECT id, tenant_id FROM workspaces WHERE slug=$1`,
        [input.workspaceSlug],
      );
      const wsRow = ws.rows[0];
      if (!wsRow) throw new TRPCError({ code: "NOT_FOUND", message: `工作区 ${input.workspaceSlug} 不存在` });
      const scope = { tenantId: wsRow.tenant_id, workspaceId: wsRow.id };
      const member = await getMember(app, scope, input.memberNo);
      if (!member) throw new TRPCError({ code: "NOT_FOUND", message: `成员 ${input.memberNo} 不存在` });
      // 租户版本（登录引导例外点：同上走 owner 池）
      const t = await getOwnerPool().query<{ plan: Identity["plan"] }>(`SELECT plan FROM tenants WHERE id=$1`, [scope.tenantId]);
      const identity: Identity = {
        memberId: member.id,
        memberNo: member.memberNo,
        name: member.name,
        role: member.role,
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        plan: t.rows[0]?.plan ?? "community",
      };
      return { token: await signDemoToken(identity), identity };
    }),
  /** 版本切换演示（F12 权限态：社区版/Pro/Teams/VPC 实切，F7.2 能力矩阵即时生效）
   *  owner 专属；写 tenants.plan（登录引导例外点同口径走 owner 池）+ 留痕 plan.switch（G8）+ 重签 JWT */
  setPlan: protectedProcedure
    .input(z.object({ plan: z.enum(PLAN_TIERS) }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.identity.role !== "owner") {
        throw new TRPCError({ code: "FORBIDDEN", message: "仅 owner 可切换租户版本（F7.1/E2.6，服务端 403）" });
      }
      const before = ctx.identity.plan;
      // D16（#1/A）：版本切换与事件同一事务（owner 通道单连接；函数 EXECUTE 对 owner 无限制）
      const ownerClient = await getOwnerPool().connect();
      try {
        await ownerClient.query("BEGIN");
        await ownerClient.query("SELECT set_config('app.tenant_id', $1, true)", [ctx.identity.tenantId]);
        await ownerClient.query("SELECT set_config('app.workspace_id', $1, true)", [ctx.identity.workspaceId]);
        await ownerClient.query(`UPDATE tenants SET plan=$2 WHERE id=$1`, [ctx.identity.tenantId, input.plan]);
        await gatewayAppendOnClient(ownerClient, {
          tenantId: ctx.identity.tenantId, workspaceId: ctx.identity.workspaceId,
          actor: { id: ctx.identity.memberNo, type: "human" },
        }, {
          who: { type: "human", id: ctx.identity.memberNo },
          context: {
            tenant_id: ctx.identity.tenantId, workspace_id: ctx.identity.workspaceId,
            time: new Date().toISOString(), channel: "inapp",
          },
          object: { type: "tenant", id: ctx.identity.tenantId },
          decision: {
            action: "plan.switch", before: { plan: before }, after: { plan: input.plan },
            basis: ["F7.2 版本能力矩阵即时生效", "F12 权限态演示"],
          },
          rule_impact: [],
        });
        await ownerClient.query("COMMIT");
      } catch (err) {
        await ownerClient.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        ownerClient.release();
      }
      const identity: Identity = { ...ctx.identity, plan: input.plan };
      return { token: await signDemoToken(identity), plan: input.plan };
    }),
});

/** members router：me（角色+版本能力下发，F5.6 三端一致的数据源）/ list */
const membersRouter = router({
  me: protectedProcedure.query(({ ctx }) => {
    return {
      identity: ctx.identity,
      capabilities: getCapabilities(ctx.identity.plan),
    };
  }),
  list: protectedProcedure.query(async ({ ctx }) => {
    return listMembers(getAppPool(), scopeOf(ctx.identity));
  }),
  /** F-NAME2：数字员工别名设置（显示层第三层；留痕上链，改别名零数据迁移） */
  updateAlias: writeProcedure
    .input(z.object({
      memberNo: z.string().min(1),
      alias: z.string().max(12).nullable(),          // null/空 = 清除别名回岗位名
      presetKey: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const app = getAppPool();
      const client = await app.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
        const alias = input.alias?.trim() || null;
        // 数字员工（agents，按 preset_key）优先；否则按人类成员 member_no
        let objectType = "member";
        let objectId = input.memberNo;
        let r;
        if (input.presetKey) {
          r = await client.query(
            `UPDATE agents SET alias=$3 WHERE preset_key=$1 AND workspace_id=$2 RETURNING id, name, alias`,
            [input.presetKey, scope.workspaceId, alias],
          );
          objectType = "agent";
          objectId = input.presetKey;
        } else {
          r = await client.query(
            `UPDATE members SET alias=$3 WHERE member_no=$1 AND workspace_id=$2 RETURNING member_no, name, alias`,
            [input.memberNo, scope.workspaceId, alias],
          );
        }
        if (!r.rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: `成员 ${input.memberNo} 不存在` });
        await appendEventOn(client, { workspaceId: scope.workspaceId, tenantId: scope.tenantId },
          { id: ctx.identity.memberNo, type: "human" }, {
            objectType, objectId,
            action: alias ? "member.alias.set" : "member.alias.clear",
            after: { alias, preset_key: input.presetKey ?? null },
          });
        await client.query("COMMIT");
        return { member: r.rows[0] };
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    }),
});

/** threads router：list（L7.1 越权返回空）/ dispatch（Quest 接口；H-10 越版 403+留痕） */
const threadsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const scope = scopeOf(ctx.identity);
    const app = getAppPool();
    const client = await app.connect();
    try {
      // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
      const r = await client.query(
        `SELECT id, title, mode, status, progress_done, progress_total, created_by, agent_id, created_at
         FROM threads WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 50`,
        [scope.workspaceId],
      );
      return r.rows;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      await client.query("COMMIT").catch(() => undefined);
      client.release();
    }
  }),

  /** Quest 派遣入口（B8：意图路由→含糊反问/建档；L3.1 并发上限；G8 留痕） */
  dispatch: capabilityWriteProcedure("quest")
    .input(
      z.object({
        title: z.string().min(1).max(500), // F3.1：≤500 字
        presetKey: z.string().default("pricing-agent"),
        runImmediately: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      // F3.2 意图路由（B8 接线：真实模型分类 → 超时/异常规则兜底 → 含糊反问；via 留痕）
      const intent = await routeIntent(input.title, intentClassifier(scope));
      if (intent.kind === "clarify") {
        // 含糊指令：反问澄清，不盲目建任务
        return { kind: "clarify" as const, question: intent.clarifyQuestion, via: intent.via };
      }
      const app = getAppPool();
      const client = await app.connect();
      let threadId: string;
      try {
        // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
        // L3.1：单工作区并发 ≤10，超出排队且可见（须在 RLS 上下文内统计，否则恒 0 行 fail-open）
        const conc = await client.query<{ c: string }>(
          `SELECT count(*) AS c FROM threads WHERE workspace_id=$1 AND status IN ('queued','running')`,
          [scope.workspaceId],
        );
        if (Number(conc.rows[0]?.c ?? 0) >= MAX_CONCURRENT_THREADS) {
          throw new TRPCError({
            code: "TOO_MANY_REQUESTS",
            message: `并发上限 ${MAX_CONCURRENT_THREADS}/工作区（L3.1/G11），已超出请稍后或排队`,
          });
        }
        // 号源走 SECURITY DEFINER 函数（0016：全库最大值绕 RLS——主键全库唯一，按本区分配必撞他区；
        // 历史教训：第二次派遣即 duplicate key，ASK/QUEST 主链路故障）
        const max = await client.query<{ n: number }>(
          `SELECT public.threads_max_t_no() AS n`,
        );
        threadId = makeReadableId("T", Number(max.rows[0]?.n ?? 100) + 1); // bigint 驱动返回 string，必须 Number() 防拼接（D29 教训）
        await client.query(
          `INSERT INTO threads (id, tenant_id, workspace_id, title, mode, status, created_by)
           VALUES ($1,$2,$3,$4,$5,'queued',$6)`,
          [threadId, scope.tenantId, scope.workspaceId, input.title, intent.mode, ctx.identity.memberNo],
        );
        // D16（#1/A）：建线程与派遣事件同一事务（G8 留痕不再独立于状态）
        await gatewayAppendOnClient(client, {
          ...scope,
          actor: { id: ctx.identity.memberNo, type: "human" },
          sessionId: threadId,
        }, {
          who: { type: "human", id: ctx.identity.memberNo },
          context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
          object: { type: "thread", id: threadId },
          decision: { action: "thread.dispatch", after: { threadId, title: input.title, mode: intent.mode, rationale: intent.rationale } },
          rule_impact: [],
        });
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        await client.query("COMMIT").catch(() => undefined);
        client.release();
      }
      // 派遣事件已随建线程同事务落库（D16；G8 三段瀑布同口径）
      // 演示驱动：立即执行 Quest 循环（生产由调度器拉取，B9）
      // ask 问询：即时应答（B8——取数为真、模型可插拔；不依赖 runImmediately 按钮）
      if (intent.mode === "ask") {
        const ra = await runAsk(getAppPool(), getGatewayPool(), scope, {
          threadId, goal: input.title, presetKey: "morning-briefing", llmCall: llmCall("ask-synthesize", scope),
        });
        return { kind: "routed" as const, mode: intent.mode, via: intent.via, threadId, status: ra.status, answer: ra.answer };
      }
      if (input.runImmediately && intent.mode === "quest") {
        const r = await runQuest(app, getGatewayPool(), scope, {
          threadId, goal: input.title, presetKey: input.presetKey, llmCall: llmCall("quest-plan", scope),
        });
        return { kind: "routed" as const, mode: intent.mode, via: intent.via, threadId, status: r.status, stepsDone: r.stepsDone, stepsTotal: r.stepsTotal };
      }
      return { kind: "routed" as const, mode: intent.mode, via: intent.via, threadId, status: "queued" as const };
    }),

  /** 线程详情（P2 线程头/信息面板；L7.1 越权返回空） */
  get: protectedProcedure
    .input(z.object({ threadId: z.string() }))
    .query(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const app = getAppPool();
      const client = await app.connect();
      try {
        // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
        const r = await client.query(
          `SELECT id, title, mode, status, progress_done, progress_total, created_by, agent_id, created_at, updated_at
           FROM threads WHERE workspace_id=$1 AND id=$2`,
          [scope.workspaceId, input.threadId],
        );
        return r.rows[0] ?? null;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        await client.query("COMMIT").catch(() => undefined);
        client.release();
      }
    }),

  /** 行动消息流（P2-⑤：该线程的事件流子序列投影，按 ts 升序；含 rule_impact/model_trace 渲染位） */
  events: protectedProcedure
    .input(z.object({ threadId: z.string(), limit: z.number().min(1).max(200).default(100) }))
    .query(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const app = getAppPool();
      const client = await app.connect();
      try {
        // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
        const r = await client.query<{ payload: unknown }>(
          `SELECT payload FROM biz_events
           WHERE workspace_id=$1 AND session_id=$2 ORDER BY seq ASC LIMIT $3`,
          [scope.workspaceId, input.threadId, input.limit],
        );
        return r.rows.map((x) => x.payload);
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        await client.query("COMMIT").catch(() => undefined);
        client.release();
      }
    }),

  /** 运行/续跑线程（replay 断点续跑幂等，E3.3/H-5；按线程模式分流：ask 应答 / agent 逐步确认 / quest 自主执行） */
  run: capabilityWriteProcedure("quest")
    .input(z.object({ threadId: z.string(), goal: z.string(), presetKey: z.string().default("pricing-agent") }))
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const app = getAppPool();
      const client = await app.connect();
      let mode: "ask" | "agent" | "quest" = "quest";
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
        const t = await client.query<{ mode: string }>(`SELECT mode FROM threads WHERE id=$1 AND workspace_id=$2`, [input.threadId, scope.workspaceId]);
        await client.query("COMMIT");
        if (t.rows[0]?.mode === "ask" || t.rows[0]?.mode === "agent") mode = t.rows[0].mode;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
      if (mode === "ask") {
        return runAsk(app, getGatewayPool(), scope, { threadId: input.threadId, goal: input.goal, presetKey: input.presetKey, llmCall: llmCall("ask-synthesize", scope) });
      }
      return runQuest(app, getGatewayPool(), scope, {
        threadId: input.threadId, goal: input.goal, presetKey: input.presetKey, mode, llmCall: llmCall("quest-plan", scope),
      });
    }),
});

/**
 * E1 联调接线（PF.5/F2.4）：审批手势通过后的副作用分发——
 * 被审批事件为 fence.rule.propose 且手势=通过 → 激活对应围栏规则版本（activateRuleVersion）。
 * 幂等：规则已离开 pending_approval/draft（重复回调/重复提案）时跳过不报错（L5.3 同口径）。
 * 返回激活的规则行 ID（未触发接线返回 null）。
 */
async function activateFenceRuleAfterApproval(
  scope: { tenantId: string; workspaceId: string },
  approvalId: string,
): Promise<string | null> {
  const app = getAppPool();
  const client = await app.connect();
  try {
    // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const r = await client.query<{ payload: unknown }>(
      `SELECT e.payload FROM approvals a JOIN biz_events e ON e.event_id = a.event_id
       WHERE a.approval_id=$1 AND a.workspace_id=$2`,
      [approvalId, scope.workspaceId],
    );
    const params = fenceActivationFromProposal(r.rows[0]?.payload, scope.workspaceId);
    if (!params) return null;
    // 审批留痕 ID = 手势回写事件（approval.gesture，F5.5 经安全网关落库）
    const g = await client.query<{ event_id: string }>(
      `SELECT event_id FROM biz_events
       WHERE workspace_id=$1 AND payload->'decision'->>'action'='approval.gesture'
         AND payload->'decision'->'after'->>'approvalId'=$2
       ORDER BY seq DESC LIMIT 1`,
      [scope.workspaceId, approvalId],
    );
    const approvalEventId = g.rows[0]?.event_id;
    if (!approvalEventId) return null;
    const st = await client.query<{ status: string }>(
      `SELECT status FROM fence_rules WHERE id=$1 AND workspace_id=$2`,
      [params.ruleRowId, scope.workspaceId],
    );
    const status = st.rows[0]?.status;
    if (status !== "draft" && status !== "pending_approval") return null; // 幂等跳过
    await activateRuleVersion(app, scope, { ...params, approvalEventId });
    return params.ruleRowId;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    await client.query("COMMIT").catch(() => undefined);
    client.release();
  }
}

/** approvals router（B6：统一队列/三手势/批量/超时扫描；L5.1 服务端强制鉴权） */
const approvalsRouter = router({
  list: protectedProcedure
    .input(z.object({ status: z.enum(["pending", "approved", "edited", "rejected", "expired"]).optional() }).optional())
    .query(async ({ ctx, input }) => {
      return listQueue(getAppPool(), scopeOf(ctx.identity), { status: input?.status });
    }),

  decide: protectedProcedure
    .input(
      z.object({
        approvalId: z.string(),
        gesture: z.enum(["approve", "edit", "reject"]),
        reasonEnum: z.string().optional(),
        reasonText: z.string().max(200).optional(),
        editedAfter: z.unknown().optional(),
        /** M1.3 归因分流（D24 修订 3）：edit 手势必填二分（纠错/口味） */
        editKind: z.enum(["correction", "preference"]).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const res = await decide(
          getAppPool(),
          getGatewayPool(),
          scopeOf(ctx.identity),
          { memberNo: ctx.identity.memberNo, role: ctx.identity.role },
          input.approvalId,
          { type: input.gesture, reasonEnum: input.reasonEnum, reasonText: input.reasonText, editedAfter: input.editedAfter, editKind: input.editKind },
        );
        // E1 联调接线（PF.5/F2.4）：fence.rule.propose 手势通过 → 激活规则版本
        if (!res.deduped && res.status === "approved") {
          await activateFenceRuleAfterApproval(scopeOf(ctx.identity), input.approvalId);
          // D22 汰换重生：hr.replacement 批准 → 旧停用 + 新员工上岗
          const scope2 = scopeOf(ctx.identity);
          const app2 = getAppPool();
          const c2 = await app2.connect();
          try {
            await c2.query("BEGIN");
            await c2.query("SELECT set_config('app.workspace_id', $1, true)", [scope2.workspaceId]);
            const snap = await c2.query<{ snapshot: Record<string, unknown> }>(
              `SELECT snapshot FROM approvals WHERE approval_id=$1`, [input.approvalId],
            );
            await c2.query("COMMIT");
            const ss = snap.rows[0]?.snapshot ?? {};
            if (ss.kind === "hr.replacement" && ss.design && typeof ss.agent_id === "string") {
              await applyReplacement(app2, scope2, ss.design as never, ss.agent_id);
            }
          } catch (e) {
            await c2.query("ROLLBACK").catch(() => undefined);
            throw e;
          } finally {
            c2.release();
          }
        }
        return res;
      } catch (err) {
        if (err instanceof ApprovalError) {
          throw new TRPCError({
            code: err.code === "FORBIDDEN_ROLE" ? "FORBIDDEN" : "BAD_REQUEST",
            message: err.message,
          });
        }
        throw err;
      }
    }),

  batchApprove: protectedProcedure
    .input(z.object({ approvalIds: z.array(z.string()).min(1).max(50) }))
    .mutation(async ({ ctx, input }) => {
      try {
        const res = await batchApprove(
          getAppPool(),
          getGatewayPool(),
          scopeOf(ctx.identity),
          { memberNo: ctx.identity.memberNo, role: ctx.identity.role },
          input.approvalIds,
        );
        // E1 联调接线（PF.5/F2.4）：批量采纳通过项同样触发围栏激活接线（防御性；围栏提案标记 high_risk 本不可批量）
        for (const id of res.approved) {
          await activateFenceRuleAfterApproval(scopeOf(ctx.identity), id);
        }
        return res;
      } catch (err) {
        if (err instanceof ApprovalError) {
          throw new TRPCError({ code: "FORBIDDEN", message: err.message });
        }
        throw err;
      }
    }),

  /** 超时升级扫描（F5.7；高危项不自动放行 L5.4）——由触发器/巡检调度调用 */
  sweep: writeProcedure.mutation(async ({ ctx }) => {
    return expireSweep(getAppPool(), getGatewayPool(), scopeOf(ctx.identity));
  }),
});

/** inspection router（B10/M9：巡检状态条 / 手动巡检 / 一键派单 / 回链） */
const inspectionRouter = router({
  /** 巡检状态条（F9.4 纯投影：正常项/总数 + 最近巡检时间 + 异常点名 ≤5 条） */
  status: protectedProcedure.query(async ({ ctx }) => {
    return inspectionStatusBar(getAppPool(), scopeOf(ctx.identity));
  }),
  /** 手动跑一轮巡检（生产由触发器引擎 cron 07:00 唤起，F9.1；演示手动触发） */
  run: writeProcedure.mutation(async ({ ctx }) => {
    return runInspectionScan(getAppPool(), getGatewayPool(), scopeOf(ctx.identity));
  }),
  /** 一键派单（F9.3：以异常事件为输入唤起业务 Agent；幂等 L9.3） */
  dispatch: writeProcedure
    .input(z.object({ anomalyEventId: z.string(), presetKey: z.string().default("review-agent") }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await dispatchFromAnomaly(getAppPool(), getGatewayPool(), scopeOf(ctx.identity), {
          anomalyEventId: input.anomalyEventId, presetKey: input.presetKey, by: ctx.identity.memberNo,
        });
      } catch (err) {
        if (err instanceof DispatchError) {
          throw new TRPCError({ code: err.code === "ANOMALY_NOT_FOUND" ? "NOT_FOUND" : "BAD_REQUEST", message: err.message });
        }
        throw err;
      }
    }),
  /** 处理结果回链（F9.3/E9.3：失败升级一级严重度 + 转需介入） */
  resolve: writeProcedure
    .input(z.object({ anomalyEventId: z.string(), threadId: z.string(), ok: z.boolean(), note: z.string().max(500).optional() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await resolveAnomaly(getAppPool(), getGatewayPool(), scopeOf(ctx.identity), {
          ...input, by: ctx.identity.memberNo,
        });
      } catch (err) {
        if (err instanceof DispatchError) {
          throw new TRPCError({ code: err.code === "ANOMALY_NOT_FOUND" ? "NOT_FOUND" : "BAD_REQUEST", message: err.message });
        }
        throw err;
      }
    }),
});

/** skills router（B10/M8：技能广场 / 安装绑定 / 零代码锻造 / 意识系统） */
/** 技能管理写操作角色守卫（E2.6/L5.1 同口径：readonly 服务端 403，前端隐藏非置灰） */
function assertSkillManage(role: string): void {
  if (role === "readonly") {
    throw new TRPCError({ code: "FORBIDDEN", message: "readonly 角色无技能管理权限（E2.6，服务端 403）" });
  }
}

const skillsRouter = router({
  list: protectedProcedure
    .input(z.object({ level: z.enum(["official", "team", "industry"]).optional() }).optional())
    .query(async ({ ctx, input }) => listSkills(getAppPool(), scopeOf(ctx.identity), { level: input?.level })),
  installs: protectedProcedure.query(async ({ ctx }) => {
    return listInstalls(getAppPool(), scopeOf(ctx.identity));
  }),
  /** F8.5 技能使用看板：每技能 30 天事件投影——调用=绑定 Agent 动作数 / 采纳率 / 驳回模式分布
   *  归因口径：agents.skills 声明（短名/全 id 双形态匹配）→ 绑定 Agent 的 who.id 事件聚合 */
  usage: protectedProcedure.query(async ({ ctx }) => {
    const scope = scopeOf(ctx.identity);
    const client = await getAppPool().connect();
    try {
      // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
      const skillIds = (await client.query<{ id: string }>(`SELECT id FROM skills ORDER BY id`)).rows.map((r) => r.id);
      const out: Record<string, {
        calls30: number; adopted30: number; rejected30: number; adoptionRate: number | null;
        rejectReasons: Array<{ reason: string; count: number }>;
        boundAgents: Array<{ id: string; presetKey: string; name: string }>;
      }> = {};
      for (const skillId of skillIds) {
        const short = skillId.replace(/^skill-[ti]?-?/, "");
        const agents = await client.query<{ id: string; preset_key: string; name: string }>(
          `SELECT id, preset_key, name FROM agents
           WHERE workspace_id=$1 AND (skills ? $2 OR skills ? $3) ORDER BY preset_key`,
          [scope.workspaceId, short, skillId],
        );
        const keys = agents.rows.map((a) => a.preset_key);
        if (keys.length === 0) {
          out[skillId] = { calls30: 0, adopted30: 0, rejected30: 0, adoptionRate: null, rejectReasons: [], boundAgents: [] };
          continue;
        }
        const calls = await client.query<{ c: string }>(
          `SELECT count(*) AS c FROM biz_events
           WHERE workspace_id=$1 AND created_at > now() - interval '30 days'
             AND payload->'who'->>'type'='agent' AND payload->'who'->>'id' = ANY($2)`,
          [scope.workspaceId, keys],
        );
        const gestures = await client.query<{ status: string; c: string }>(
          `SELECT a.status, count(*) AS c FROM approvals a
           JOIN biz_events e ON e.event_id = a.event_id
           WHERE e.workspace_id=$1 AND e.payload->'who'->>'id' = ANY($2)
             AND a.created_at > now() - interval '30 days'
           GROUP BY a.status`,
          [scope.workspaceId, keys],
        );
        const reasons = await client.query<{ reason: string; c: string }>(
          `SELECT a.gesture->>'reason_enum' AS reason, count(*) AS c FROM approvals a
           JOIN biz_events e ON e.event_id = a.event_id
           WHERE e.workspace_id=$1 AND e.payload->'who'->>'id' = ANY($2)
             AND a.status='rejected' AND a.created_at > now() - interval '30 days'
           GROUP BY 1 ORDER BY 2 DESC LIMIT 3`,
          [scope.workspaceId, keys],
        );
        const adopted = gestures.rows.filter((g) => g.status === "approved" || g.status === "edited").reduce((s, g) => s + Number(g.c), 0);
        const rejected = Number(gestures.rows.find((g) => g.status === "rejected")?.c ?? 0);
        out[skillId] = {
          calls30: Number(calls.rows[0]?.c ?? 0),
          adopted30: adopted,
          rejected30: rejected,
          adoptionRate: adopted + rejected > 0 ? adopted / (adopted + rejected) : null,
          rejectReasons: reasons.rows.map((r) => ({ reason: r.reason ?? "未填", count: Number(r.c) })),
          boundAgents: agents.rows.map((a) => ({ id: a.id, presetKey: a.preset_key, name: a.name })),
        };
      }
      return out;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      await client.query("COMMIT").catch(() => undefined);
      client.release();
    }
  }),
  /** 安装（F8.2 安装即绑定；L8.1 脱敏闸 / L8.2 白名单 / E8.1 冲突进审批 / F8.3 dry-run 前置） */
  install: protectedProcedure
    .input(z.object({ skillId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      assertSkillManage(ctx.identity.role);
      try {
        return await installSkill(getAppPool(), getGatewayPool(), scopeOf(ctx.identity), {
          skillId: input.skillId, by: ctx.identity.memberNo,
        });
      } catch (err) {
        if (err instanceof SkillError) {
          throw new TRPCError({ code: err.code === "NOT_FOUND" ? "NOT_FOUND" : "BAD_REQUEST", message: err.message });
        }
        throw err;
      }
    }),
  /** 卸载（L8.3 卸载即撤销围栏绑定） */
  uninstall: protectedProcedure
    .input(z.object({ skillId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      assertSkillManage(ctx.identity.role);
      try {
        return await uninstallSkill(getAppPool(), getGatewayPool(), scopeOf(ctx.identity), {
          skillId: input.skillId, by: ctx.identity.memberNo,
        });
      } catch (err) {
        if (err instanceof SkillError) {
          throw new TRPCError({ code: err.code === "NOT_FOUND" ? "NOT_FOUND" : "BAD_REQUEST", message: err.message });
        }
        throw err;
      }
    }),
  /** 零代码自定义技能草稿（F8.3 三要素；生成物进版本管理） */
  forge: protectedProcedure
    .input(z.object({
      name: z.string().min(1).max(100),
      description: z.string().max(500).default(""),
      triplet: z.object({ trigger: z.string().min(1), steps: z.array(z.string().min(1)).min(1), boundary: z.string().min(1) }),
      fenceBindings: z.array(z.string()).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      assertSkillManage(ctx.identity.role);
      return createSkillDraft(getAppPool(), getGatewayPool(), scopeOf(ctx.identity), { ...input, by: ctx.identity.memberNo });
    }),
  /** 生效前 dry-run 预览（F8.3/F2.5：回放最近 10 条） */
  dryRun: protectedProcedure
    .input(z.object({ skillId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await dryRunSkill(getAppPool(), getGatewayPool(), scopeOf(ctx.identity), {
          skillId: input.skillId, by: ctx.identity.memberNo,
        });
      } catch (err) {
        if (err instanceof SkillError) {
          throw new TRPCError({ code: "NOT_FOUND", message: err.message });
        }
        throw err;
      }
    }),
  awareness: router({
    /** 高频相似任务检测（F8.4：≥3 次/周建议固化；E8.3 驳回校准） */
    suggestions: protectedProcedure.query(async ({ ctx }) => {
      return detectSuggestions(getAppPool(), scopeOf(ctx.identity));
    }),
    /** 一键确认 → 生成触发器或新技能（F8.4） */
    confirm: protectedProcedure
      .input(z.object({
        suggestion: z.object({
          key: z.string(), objectType: z.string(), actionCategory: z.string(),
          count: z.number(), windowDays: z.number(), threshold: z.number(), sampleEventIds: z.array(z.string()),
        }),
        target: z.enum(["trigger", "skill"]),
        schedule: z.string().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        assertSkillManage(ctx.identity.role);
        return confirmSuggestion(getAppPool(), getGatewayPool(), scopeOf(ctx.identity), {
          suggestion: input.suggestion, target: input.target, schedule: input.schedule, by: ctx.identity.memberNo,
        });
      }),
    /** 驳回建议（E8.3 校准闭环：该类阈值 ×2） */
    reject: protectedProcedure
      .input(z.object({ key: z.string(), reason: z.string().max(200).optional() }))
      .mutation(async ({ ctx, input }) => {
        assertSkillManage(ctx.identity.role);
        return { eventId: await rejectSuggestion(getGatewayPool(), scopeOf(ctx.identity), { ...input, by: ctx.identity.memberNo }) };
      }),
  }),
  /** 技能保鲜环 · 下行分发（方案 v0.2 P0：官方运营台 → 客户实例）
   *  红线：L0/L1 内容面可静默（策略可配）；L2 执行面/权限面永不静默走审批；
   *        staging 五道预检不过不装载；一切动作进事件库哈希链 */
  skillOps: router({
    /** 分发状态投影（技能中心：staging 列表 / 静默策略 / 同步游标） */
    status: protectedProcedure.query(async ({ ctx }) => {
      return distStatus(getAppPool(), scopeOf(ctx.identity));
    }),
    /** 立即同步（手动触发=拉取通道同路径；夜班窗口自动同步复用本函数） */
    syncNow: protectedProcedure
      .input(z.object({ registryUrl: z.string().url().optional() }).optional())
      .mutation(async ({ ctx, input }) => {
        assertSkillManage(ctx.identity.role);
        const scope = scopeOf(ctx.identity);
        const instance = await instanceProfileOf(scope);
        try {
          return await syncDistribution(getAppPool(), getGatewayPool(), scope, {
            registryUrl: input?.registryUrl ?? process.env.SKILL_DIST_REGISTRY_URL ?? "",
            signingKey: process.env.SKILL_DIST_SIGNING_KEY ?? "",
            instance,
            by: ctx.identity.memberNo,
          });
        } catch (err) {
          throw mapSkillOpsError(err);
        }
      }),
    /** 分发策略（silent=L0/L1 默认静默 / prompt=提示后升级；autoSync=夜班自动同步总开关；L2 不可配置永远审批） */
    setPolicy: protectedProcedure
      .input(z.object({ mode: z.enum(["silent", "prompt"]).optional(), autoSync: z.boolean().optional() }))
      .mutation(async ({ ctx, input }) => {
        assertSkillManage(ctx.identity.role);
        try {
          return await setSilentMode(getAppPool(), getGatewayPool(), scopeOf(ctx.identity), {
            mode: input.mode, autoSync: input.autoSync, by: ctx.identity.memberNo,
          });
        } catch (err) {
          throw mapSkillOpsError(err);
        }
      }),
    /** 人工装载 staging 项（prompt 策略项 / L2 审批通过项——审批未过服务端拒绝） */
    loadStaging: protectedProcedure
      .input(z.object({ stagingId: z.string() }))
      .mutation(async ({ ctx, input }) => {
        assertSkillManage(ctx.identity.role);
        try {
          return await loadStaging(getAppPool(), getGatewayPool(), scopeOf(ctx.identity), {
            stagingId: input.stagingId, by: ctx.identity.memberNo,
          });
        } catch (err) {
          throw mapSkillOpsError(err);
        }
      }),
    /** 一键回滚（恢复装载前快照：skills 行 + install 快照同事务恢复） */
    rollback: protectedProcedure
      .input(z.object({ skillId: z.string() }))
      .mutation(async ({ ctx, input }) => {
        assertSkillManage(ctx.identity.role);
        try {
          return await rollbackSkill(getAppPool(), getGatewayPool(), scopeOf(ctx.identity), {
            skillId: input.skillId, by: ctx.identity.memberNo,
          });
        } catch (err) {
          throw mapSkillOpsError(err);
        }
      }),
    /** 上行回流（D19 四条红线：opt-in / 预览即所发 / 脱敏管道 / 发送留痕） */
    reflux: router({
      /** opt-in 状态查询（默认关） */
      optIn: protectedProcedure.query(async ({ ctx }) => {
        return { optIn: await getRefluxOptIn(getAppPool(), scopeOf(ctx.identity)) };
      }),
      /** opt-in 开关（客户治理主权，变更留痕） */
      setOptIn: protectedProcedure
        .input(z.object({ optIn: z.boolean() }))
        .mutation(async ({ ctx, input }) => {
          assertSkillManage(ctx.identity.role);
          try {
            return await setRefluxOptIn(getAppPool(), getGatewayPool(), scopeOf(ctx.identity), {
              optIn: input.optIn, by: ctx.identity.memberNo,
            });
          } catch (err) {
            throw mapRefluxError(err);
          }
        }),
      /** 预览（预览即所发：返回脱敏后完整上送包 + 六信号摘要，可编辑后放弃） */
      preview: protectedProcedure
        .input(z.object({ skillId: z.string() }))
        .query(async ({ ctx, input }) => {
          try {
            return await previewReflux(getAppPool(), scopeOf(ctx.identity), input.skillId);
          } catch (err) {
            throw mapRefluxError(err);
          }
        }),
      /** 发送（opt-in 未开启拒发；未配端点留 outbox；发送行为留痕） */
      send: protectedProcedure
        .input(z.object({ skillId: z.string() }))
        .mutation(async ({ ctx, input }) => {
          assertSkillManage(ctx.identity.role);
          try {
            return await sendReflux(getAppPool(), getGatewayPool(), scopeOf(ctx.identity), {
              skillId: input.skillId, by: ctx.identity.memberNo,
            });
          } catch (err) {
            throw mapRefluxError(err);
          }
        }),
    }),
    /** 官方运营台（仅 SKILL_OPS_MODE=official 部署启用；客户端调用一律 403） */
    console: router({
      health: protectedProcedure.query(async ({ ctx }) => {
        assertOfficialMode(ctx.identity.role);
        return consoleHealth(getAppPool());
      }),
      inbox: protectedProcedure.query(async ({ ctx }) => {
        assertOfficialMode(ctx.identity.role);
        return listInbox(getAppPool());
      }),
      review: protectedProcedure
        .input(z.object({ draftId: z.string(), gesture: z.enum(["approve", "reject"]), reason: z.string().max(200).optional() }))
        .mutation(async ({ ctx, input }) => {
          assertOfficialMode(ctx.identity.role);
          try {
            return await reviewRefluxDraft(getAppPool(), getGatewayPool(), scopeOf(ctx.identity), {
              draftId: input.draftId, by: ctx.identity.memberNo, gesture: input.gesture, reason: input.reason,
            });
          } catch (err) {
            throw mapConsoleError(err);
          }
        }),
      /** 官方化（须双人复核通过且执行人为复核成员之一；可附抽象完善终稿） */
      officialize: protectedProcedure
        .input(z.object({
          draftId: z.string(),
          final: z.object({ name: z.string().optional(), description: z.string().optional(), body: z.string().optional() }).optional(),
        }))
        .mutation(async ({ ctx, input }) => {
          assertOfficialMode(ctx.identity.role);
          try {
            return await officializeDraft(getAppPool(), getGatewayPool(), scopeOf(ctx.identity), {
              draftId: input.draftId, by: ctx.identity.memberNo, final: input.final,
            });
          } catch (err) {
            throw mapConsoleError(err);
          }
        }),
      /** 构建签名 manifest（官方技能库 → 分发包；GET /skill-dist/manifest.json 同逻辑对外服务） */
      buildManifest: protectedProcedure.mutation(async ({ ctx }) => {
        assertOfficialMode(ctx.identity.role);
        const key = process.env.SKILL_DIST_SIGNING_KEY ?? "";
        if (!key) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "未配置 SKILL_DIST_SIGNING_KEY" });
        return buildManifest(getAppPool(), { signingKey: key });
      }),
    }),
  }),
});

/** 官方运营台模式守卫（SKILL_OPS_MODE=official + 管理角色；客户端实例一律 403） */
function assertOfficialMode(role: string): void {
  assertSkillManage(role);
  if (process.env.SKILL_OPS_MODE !== "official") {
    throw new TRPCError({ code: "FORBIDDEN", message: "本实例非官方运营台部署（SKILL_OPS_MODE≠official），console 端点禁用" });
  }
}

function mapRefluxError(err: unknown): Error {
  if (err instanceof RefluxError) {
    const code = err.code === "NOT_FOUND" ? "NOT_FOUND" : "BAD_REQUEST";
    return new TRPCError({ code, message: err.message });
  }
  return err instanceof Error ? err : new Error(String(err));
}

function mapConsoleError(err: unknown): Error {
  if (err instanceof ConsoleError) {
    const code = err.code === "NOT_FOUND" ? "NOT_FOUND" : "BAD_REQUEST";
    return new TRPCError({ code, message: err.message });
  }
  return err instanceof Error ? err : new Error(String(err));
}

/** 本实例定向标签（投放匹配面：workspaces.industry 即已装配行业 Bundle；edition 走 env，默认 community） */
async function instanceProfileOf(scope: { tenantId: string; workspaceId: string }): Promise<InstanceProfile> {
  const client = await getAppPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    const r = await client.query<{ industry: string | null }>(`SELECT industry FROM workspaces WHERE id=$1`, [scope.workspaceId]);
    await client.query("COMMIT");
    return {
      bundles: r.rows[0]?.industry ? [r.rows[0].industry] : [],
      edition: process.env.SKILL_DIST_EDITION ?? "community",
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally { client.release(); }
}

function mapSkillOpsError(err: unknown): Error {
  if (err instanceof SkillOpsError) {
    const code = err.code === "NOT_FOUND" || err.code === "NO_SNAPSHOT" ? "NOT_FOUND" : "BAD_REQUEST";
    return new TRPCError({ code, message: err.message });
  }
  return err instanceof Error ? err : new Error(String(err));
}

/** workspace router（F3 起 P1 右栏数据源：一店一档投影 + 人机混编在线成员） */
const workspaceRouter = router({
  /** 一店一档投影（档案 chips：property/audience/history_curve 等；L7.1 越权空） */
  profile: protectedProcedure.query(async ({ ctx }) => {
    const scope = scopeOf(ctx.identity);
    const app = getAppPool();
    const client = await app.connect();
    try {
      // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
      const p = await client.query<{ archive: Record<string, unknown> }>(
        `SELECT archive FROM profiles WHERE workspace_id=$1`, [scope.workspaceId],
      );
      const w = await client.query<{ stage: string | null; name: string }>(
        `SELECT stage, name FROM workspaces WHERE id=$1`, [scope.workspaceId],
      );
      return { archive: p.rows[0]?.archive ?? {}, stage: w.rows[0]?.stage ?? null, name: w.rows[0]?.name ?? "" };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      await client.query("COMMIT").catch(() => undefined);
      client.release();
    }
  }),
  /** 人机混编在线成员（P1E6：Agent 夜班窗口内自动上线 M4；状态来自 agents.status） */
  agents: protectedProcedure.query(async ({ ctx }) => {
    const scope = scopeOf(ctx.identity);
    const app = getAppPool();
    const client = await app.connect();
    try {
      // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
      const r = await client.query<{
        id: string; preset_key: string; name: string; version: string; kind: string;
        readonly: boolean; status: string; meta: { night_shift?: boolean };
      }>(
        `SELECT id, preset_key, name, version, kind, readonly, status, meta
         FROM agents WHERE workspace_id=$1 ORDER BY preset_key`,
        [scope.workspaceId],
      );
      return r.rows;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      await client.query("COMMIT").catch(() => undefined);
      client.release();
    }
  }),
});

/** nightShift router（F3 起 P1 数据源：夜班状态胶囊 + 昨夜战报卡投影） */
const nightShiftRouter = router({
  /** 18:00 候选清单（F4.1：夜班 preset 覆盖过滤 + 谷时价 + 围栏摘要；E1 联调挂端点） */
  candidates: protectedProcedure.query(async ({ ctx }) => {
    return buildCandidateList(getAppPool(), scopeOf(ctx.identity));
  }),

  /** 开启夜班（F4.1 人类命令·不经模型轮次；ensureReady→confirmNight：围栏快照 F2.6 + 状态机 F4.8） */
  start: protectedProcedure
    .input(z.object({
      runDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      candidateIds: z.array(z.string()).default([]),
    }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.identity.role === "readonly") {
        throw new TRPCError({ code: "FORBIDDEN", message: "readonly 角色无权开启夜班（E2.6/L3.4，服务端 403）" });
      }
      const scope = scopeOf(ctx.identity);
      const runId = await ensureReady(getAppPool(), getGatewayPool(), scope, input.runDate);
      try {
        await confirmNight(getAppPool(), getGatewayPool(), scope, runId, ctx.identity.memberNo, input.candidateIds);
      } catch (err) {
        if (err instanceof NightTransitionError) {
          throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
        }
        throw err;
      }
      return { runId, status: "running" as const };
    }),

  /** 08:30 决策包投递（F4.4 三段投影；状态机 → package_generated，统计回写 night_runs.stats） */
  deliver: writeProcedure
    .input(z.object({
      runId: z.string(),
      window: z.object({ from: z.string(), to: z.string() }),
    }))
    .mutation(async ({ ctx, input }) => {
      return deliverPackage(getAppPool(), getGatewayPool(), scopeOf(ctx.identity), input.runId, input.window);
    }),

  /** 最近班次 + 状态机投影（F4.8）+ 决策包统计（F4.4，deliverPackage 回写的 stats） */
  current: protectedProcedure.query(async ({ ctx }) => {
    const scope = scopeOf(ctx.identity);
    const app = getAppPool();
    const client = await app.connect();
    try {
      // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
      const r = await client.query<{
        id: string; status: string; run_date: string; fence_snapshot_version: string | null;
        candidate_count: number; started_at: Date | null;
        stats: { done: number; pending: number; need_human: number; credits_used: number } | null;
      }>(
        `SELECT id, status, run_date, fence_snapshot_version, candidate_count, started_at, stats
         FROM night_runs WHERE workspace_id=$1 ORDER BY run_date DESC LIMIT 1`,
        [scope.workspaceId],
      );
      const row = r.rows[0];
      if (!row) return { configured: false as const };
      return {
        configured: true as const,
        run: {
          id: row.id, status: row.status, runDate: row.run_date,
          fenceSnapshot: row.fence_snapshot_version, candidateCount: row.candidate_count,
          startedAt: row.started_at?.toISOString() ?? null, stats: row.stats,
        },
      };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      await client.query("COMMIT").catch(() => undefined);
      client.release();
    }
  }),

  /** 班组消息流（P9E1：夜班频道事件流投影，ts 升序；夜班动作 100% 过围栏 L4.1） */
  events: protectedProcedure
    .input(z.object({ limit: z.number().min(1).max(200).default(80) }).optional())
    .query(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const app = getAppPool();
      const client = await app.connect();
      try {
        // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
        const r = await client.query<{ payload: unknown }>(
          `SELECT payload FROM biz_events
           WHERE workspace_id=$1 AND payload->'context'->>'channel' = '夜班'
           ORDER BY seq DESC LIMIT $2`,
          [scope.workspaceId, input?.limit ?? 80],
        );
        return r.rows.map((x) => x.payload).reverse(); // ts 升序
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        await client.query("COMMIT").catch(() => undefined);
        client.release();
      }
    }),

  /** 一键暂停（P9E2：二次确认在组件层；G5 端到端计时留痕；超时 P0 升级 E4.1） */
  pause: writeProcedure
    .input(z.object({ runId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await pauseAll(getAppPool(), getGatewayPool(), scopeOf(ctx.identity), input.runId, {
          memberNo: ctx.identity.memberNo, channel: "inapp",
        });
      } catch (err) {
        if (err instanceof NightTransitionError) {
          throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
        }
        throw err;
      }
    }),

  /** 恢复（E4.2：断点续跑由 runtime replay 保证） */
  resume: writeProcedure
    .input(z.object({ runId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await resumeNight(getAppPool(), getGatewayPool(), scopeOf(ctx.identity), input.runId, ctx.identity.memberNo);
      return { ok: true };
    }),

  /** 班组留言（P9E6：人给班组留言=五元事件留痕；触发的动作照常过围栏 L4.1/L4.4） */
  note: writeProcedure
    .input(z.object({ text: z.string().min(1).max(500) }))
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const r = await gatewayAppend(getGatewayPool(), {
        ...scope, actor: { id: ctx.identity.memberNo, type: "human" },
      }, {
        who: { type: "human", id: ctx.identity.memberNo },
        context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "夜班" },
        object: { type: "store", id: scope.workspaceId },
        decision: { action: "night.note", after: { text: input.text } },
        rule_impact: [],
      });
      return { eventId: r.eventId };
    }),
});

/** fence router（F8 起 P5 数据源：规则版本化投影 + 30 天触发聚合 + dry-run 生命周期 F2.4/F2.5） */
const fenceRouter = router({
  /** 规则列表（P5E2：级别 pill + 来源 + 30 天触发数；基线 🔒 集团强制 F2.3） */
  rules: protectedProcedure.query(async ({ ctx }) => {
    const scope = scopeOf(ctx.identity);
    const app = getAppPool();
    const client = await app.connect();
    try {
      // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
      const r = await client.query(
        `SELECT f.id, f.rule_id, f.version, f.workspace_id, f.name, f.level, f.match_spec,
                f.is_baseline, f.status, f.created_by, f.created_at,
                (SELECT count(*) FROM biz_events e
                  WHERE e.workspace_id=$1 AND e.created_at > now() - interval '30 days'
                    AND EXISTS (SELECT 1 FROM jsonb_array_elements(e.payload->'rule_impact') ri
                                WHERE ri->>'rule_id' = f.rule_id)) AS hits30
         FROM fence_rules f
         WHERE (f.workspace_id=$1 OR f.workspace_id='*') AND f.status IN ('active','pending_approval','draft')
         ORDER BY f.rule_id, f.created_at DESC`,
        [scope.workspaceId],
      );
      return r.rows;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      await client.query("COMMIT").catch(() => undefined);
      client.release();
    }
  }),

  /** 版本历史（P5E1：active/rolled_back/出厂基线 🔒；单调守卫 L2.1） */
  versions: protectedProcedure.query(async ({ ctx }) => {
    const scope = scopeOf(ctx.identity);
    const app = getAppPool();
    const client = await app.connect();
    try {
      // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
      const r = await client.query(
        `SELECT version, status, count(*) AS rules, min(created_at) AS created_at
         FROM fence_rules WHERE (workspace_id=$1 OR workspace_id='*')
         GROUP BY version, status ORDER BY min(created_at) DESC`,
        [scope.workspaceId],
      );
      return r.rows;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      await client.query("COMMIT").catch(() => undefined);
      client.release();
    }
  }),

  /** NL 新增群规 dry-run（P5E3/P5E4：候选规则回放最近 10 条 F2.5；未确认不生效 L2.4） */
  dryRun: writeProcedure
    .input(z.object({
      ruleId: z.string().regex(/^R\d+$/),
      name: z.string().min(1).max(100),
      level: z.enum(["auto", "review", "block"]),
      objectTypes: z.array(z.string()).min(1),
      actions: z.array(z.string()).min(1),
      when: z.string().min(1),
    }))
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      return createDryRun(getAppPool(), scope, {
        ruleId: input.ruleId,
        ruleVersion: "v-next",
        rules: [{
          rule_id: input.ruleId, version: "v-next", name: input.name, level: input.level,
          is_baseline: false, objectTypes: input.objectTypes, actions: input.actions, when: input.when,
        }],
        defaultLevel: "review",
        createdBy: ctx.identity.memberNo,
      });
    }),

  /** 确认 dry-run（人看过报告才激活 L2.4）→ 规则进 pending_approval + 变更审批（F2.4，走 P4 决断流） */
  confirmDryRun: writeProcedure
    .input(z.object({
      dryRunId: z.string(),
      rule: z.object({
        ruleId: z.string(), name: z.string(), level: z.enum(["auto", "review", "block"]),
        objectTypes: z.array(z.string()), actions: z.array(z.string()), when: z.string(),
      }),
    }))
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      await confirmDryRun(getAppPool(), scope, input.dryRunId);
      // 规则草稿进 pending_approval（激活须审批事件 ID，activateRuleVersion 在 P4 手势后调用——E1 已接线，见下方 decide/batchApprove）
      // D16（#1/A）：规则草稿行、提案事件、审批行三者同一事务同一 COMMIT
      const app = getAppPool();
      const client = await app.connect();
      let ev: { eventId: string };
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
        const rowId = fenceRuleRowId(input.rule.ruleId, scope.workspaceId);
        await client.query(
          `INSERT INTO fence_rules (id, rule_id, version, workspace_id, name, level, match_spec, action, is_baseline, status, created_by)
           VALUES ($1,$2,'v-next',$3,$4,$5,$6,$7,false,'pending_approval',$8)
           ON CONFLICT (id) DO NOTHING`,
          [rowId, input.rule.ruleId, scope.workspaceId, input.rule.name, input.rule.level,
           JSON.stringify({ object_types: input.rule.objectTypes, actions: input.rule.actions, when: input.rule.when }),
           JSON.stringify({ result: input.rule.level }), ctx.identity.memberNo],
        );
        ev = await gatewayAppendOnClient(client, {
          ...scope, actor: { id: ctx.identity.memberNo, type: "human" },
        }, {
          who: { type: "human", id: ctx.identity.memberNo },
          context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
          object: { type: "staff", id: input.rule.ruleId },
          decision: { action: "fence.rule.propose", after: { ...input.rule, dryRunId: input.dryRunId } },
          rule_impact: [],
        });
        // E1 联调接线（PF.5/F2.4）：围栏变更提案进 P4 决断队列——高危（不可批量采纳，须逐条手势，F5.4/G6）
        // 幂等：UNIQUE(event_id, channel) 冲突丢弃（L5.3 同口径）
        await client.query(
          `INSERT INTO approvals (approval_id, tenant_id, workspace_id, event_id, channel, status, snapshot)
           VALUES ($1,$2,$3,$4,'inapp','pending',$5)
           ON CONFLICT (event_id, channel) DO NOTHING`,
          [`apr-${ev.eventId.toLowerCase()}`, scope.tenantId, scope.workspaceId, ev.eventId,
           JSON.stringify({ after: input.rule, high_risk: true })],
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
      return { proposed: true, eventId: ev!.eventId };
    }),
});

/**
 * roster router（F9 起 P8 船员名册数据源：PRD P8-⑤ 数据来源逐条落地）
 *  - 成员列表 = 工作区成员（members）+ Agent preset 注册表投影（agents）
 *  - 工时统计 = 事件库聚合投影（动作数/采纳率/积分/峰谷占比，L6.3 账单=事件投影同口径）
 *  - 事件流 = 该 Agent 的 who.id 过滤投影（append-only 库只读）
 *  - LV/段位为游戏化界面叙事（规则手册 §3：本版不设数值门槛公式），由真实战绩确定性推导，不改业务机制
 *  - 本页无直接写入；「发消息·派遣」走 threads.dispatch（F3.1）；加装 preset 走 P7（§2.3）
 */
/** 游戏化展示层映射（界面叙事；输入全部为真实战绩聚合，确定性、零编造） */
function gameOf(xp: number): { level: number; rank: "青铜" | "白银" | "黄金" | "铂金" | "星钻"; xp: number; xpFloor: number; xpNext: number } {
  // level 阶梯：xp ≥ 8·LV² 升级（展示层自定映射，手册 §3 不定义公式）；LV.1 无门槛（floor=0）
  let level = 1;
  while (xp >= 8 * (level + 1) * (level + 1)) level += 1;
  const rank = level >= 15 ? "星钻" : level >= 10 ? "铂金" : level >= 6 ? "黄金" : level >= 3 ? "白银" : "青铜";
  return { level, rank, xp, xpFloor: level === 1 ? 0 : 8 * level * level, xpNext: 8 * (level + 1) * (level + 1) };
}

/** 夜班窗口判断（M4：22:00–08:00 内 night_shift Agent 自动上线；以服务器本地时区计，演示口径） */
function inNightWindow(now = new Date()): boolean {
  const h = now.getHours();
  return h >= 22 || h < 8;
}

const rosterRouter = router({
  /** 名册总览（p8 默认态：人类 3 + Agent 7 混编 + 30 天工时聚合 + 在线状态） */
  list: protectedProcedure.query(async ({ ctx }) => {
    const scope = scopeOf(ctx.identity);
    const app = getAppPool();
    const client = await app.connect();
    try {
      // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);

      // 人类成员 + 近 24h 活动信号推导在线（事件留痕为唯一事实源，不伪造 presence）
      const humans = await client.query<{
        member_no: string; name: string; role: string;
        active24h: string; decided30: string; dispatched30: string; rules30: string;
      }>(
        `SELECT m.member_no, m.name, m.role,
                (SELECT count(*) FROM biz_events e
                  WHERE e.workspace_id=$1 AND e.payload->'who'->>'id' = m.member_no
                    AND e.created_at > now() - interval '24 hours') AS active24h,
                (SELECT count(*) FROM approvals a
                  WHERE a.workspace_id=$1 AND a.decided_by = m.member_no
                    AND a.decided_at > now() - interval '30 days') AS decided30,
                (SELECT count(*) FROM biz_events e
                  WHERE e.workspace_id=$1 AND e.payload->'who'->>'id' = m.member_no
                    AND e.payload->'decision'->>'action' = 'thread.dispatch'
                    AND e.created_at > now() - interval '30 days') AS dispatched30,
                (SELECT count(*) FROM biz_events e
                  WHERE e.workspace_id=$1 AND e.payload->'who'->>'id' = m.member_no
                    AND e.payload->'decision'->>'action' IN ('fence.rule.propose','skill.forge','awareness.confirm')
                    AND e.created_at > now() - interval '30 days') AS rules30
         FROM members m WHERE m.workspace_id=$1 ORDER BY m.member_no`,
        [scope.workspaceId],
      );

      // Agent 成员 + 30 天工时聚合（L6.3：动作数/采纳/驳回/积分/峰谷占比全部事件投影）
      const agents = await client.query<{
        id: string; preset_key: string; name: string; version: string; kind: string;
        readonly: boolean; status: string; invalid_reason: string | null;
        fence_bindings: string[]; skills: string[];
        meta: { night_shift?: boolean; high_risk?: boolean; description?: string };
        actions30: string; adopted30: string; rejected30: string; credits30: string; offpeak30: string;
      }>(
        `SELECT a.id, a.preset_key, a.name, a.version, a.kind, a.readonly, a.status, a.invalid_reason,
                a.fence_bindings, a.skills, a.meta,
                (SELECT count(*) FROM biz_events e
                  WHERE e.workspace_id=$1 AND e.payload->'who'->>'id' = a.preset_key
                    AND e.created_at > now() - interval '30 days') AS actions30,
                (SELECT count(*) FROM approvals ap JOIN biz_events e ON e.event_id = ap.event_id
                  WHERE ap.workspace_id=$1 AND e.workspace_id=$1
                    AND e.payload->'who'->>'id' = a.preset_key
                    AND ap.status IN ('approved','edited')
                    AND ap.created_at > now() - interval '30 days') AS adopted30,
                (SELECT count(*) FROM approvals ap JOIN biz_events e ON e.event_id = ap.event_id
                  WHERE ap.workspace_id=$1 AND e.workspace_id=$1
                    AND e.payload->'who'->>'id' = a.preset_key
                    AND ap.status = 'rejected'
                    AND ap.created_at > now() - interval '30 days') AS rejected30,
                (SELECT COALESCE(sum((e.payload->'model_trace'->>'credits')::numeric), 0) FROM biz_events e
                  WHERE e.workspace_id=$1 AND e.payload->'who'->>'id' = a.preset_key
                    AND e.created_at > now() - interval '30 days') AS credits30,
                (SELECT COALESCE(sum((e.payload->'model_trace'->>'credits')::numeric)
                        FILTER (WHERE e.payload->'model_trace'->>'window' = 'off-peak'), 0) FROM biz_events e
                  WHERE e.workspace_id=$1 AND e.payload->'who'->>'id' = a.preset_key
                    AND e.created_at > now() - interval '30 days') AS offpeak30
         FROM agents a WHERE a.workspace_id=$1 ORDER BY a.preset_key`,
        [scope.workspaceId],
      );

      const nightNow = inNightWindow();
      return {
        nightWindow: { open: nightNow, range: "22:00–08:00" }, // M4 夜班窗口（PRD P8 页头口径）
        humans: humans.rows.map((h) => {
          const decided = Number(h.decided30), dispatched = Number(h.dispatched30), rules = Number(h.rules30);
          // 主理人 XP：裁决 ×3 + 派遣 ×2 + 沉淀 ×5（手册 §3.1 人只有三件事：供给/裁决/沉淀；权重为展示层映射）
          const xp = decided * 3 + dispatched * 2 + rules * 5;
          return {
            memberNo: h.member_no, name: h.name, role: h.role,
            online: Number(h.active24h) > 0,
            stats: { decided30: decided, dispatched30: dispatched, settled30: rules },
            game: gameOf(xp),
          };
        }),
        agents: agents.rows.map((a) => {
          const actions = Number(a.actions30), adopted = Number(a.adopted30), rejected = Number(a.rejected30);
          const credits = Number(a.credits30), offpeak = Number(a.offpeak30);
          const decided = adopted + rejected;
          // 船员 XP：动作 ×2 + 积分 ×1（展示层映射，输入均为 L6.3 事件投影）
          const xp = actions * 2 + credits;
          return {
            id: a.id, presetKey: a.preset_key, name: a.name, version: a.version, kind: a.kind,
            readonly: a.readonly, status: a.status, invalidReason: a.invalid_reason,
            fenceBindings: a.fence_bindings, skills: a.skills,
            nightShift: a.meta?.night_shift === true, highRisk: a.meta?.high_risk === true,
            description: a.meta?.description ?? "",
            // M4：夜班 preset 窗口内自动上线；其余待命；invalid=校验失败（F2.10 错误态）
            online: a.status === "ready" && a.meta?.night_shift === true && nightNow,
            stats: {
              actions30: actions, adopted30: adopted, rejected30: rejected,
              adoptionRate: decided > 0 ? adopted / decided : null,
              credits30: credits,
              offPeakRatio: credits > 0 ? offpeak / credits : null, // G9 峰谷投影
            },
            game: gameOf(xp),
          };
        }),
      };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      await client.query("COMMIT").catch(() => undefined);
      client.release();
    }
  }),

  /** 成员档案（p8_agent：身份与归属 / 围栏授权 F2.10 / 技能包 / 30 天战绩 L6.3 / 最近事件流） */
  profile: protectedProcedure
    .input(z.object({ agentId: z.string() }))
    .query(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const app = getAppPool();
      const client = await app.connect();
      try {
        // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);

        const ar = await client.query<{
          id: string; preset_key: string; name: string; version: string; kind: string;
          readonly: boolean; status: string; invalid_reason: string | null;
          fence_bindings: string[]; skills: string[];
          meta: {
            night_shift?: boolean; high_risk?: boolean; description?: string;
            tools?: Array<{ name: string; access: string; desc: string }>;
            write_back?: string[]; prompt?: { constraints?: string[] };
          };
        }>(
          `SELECT id, preset_key, name, version, kind, readonly, status, invalid_reason, fence_bindings, skills, meta
           FROM agents WHERE workspace_id=$1 AND id=$2`,
          [scope.workspaceId, input.agentId],
        );
        const agent = ar.rows[0];
        if (!agent) return null; // L7.1：越权/不存在一律返回空

        const ws = await client.query<{ name: string; bundle_id: string | null; is_example: boolean }>(
        `SELECT name, bundle_id, is_example FROM workspaces WHERE id=$1`, [scope.workspaceId]);

        // 航道许可：fence_bindings 逐条对账 fence_rules 当前 active 版本（缺规则=声明悬空，标红 F2.10）
        const fences = agent.fence_bindings.length === 0 ? [] : (await client.query<{
          rule_id: string; name: string; level: string; version: string; is_baseline: boolean;
        }>(
          `SELECT DISTINCT ON (rule_id) rule_id, name, level, version, is_baseline
           FROM fence_rules
           WHERE (workspace_id=$1 OR workspace_id='*') AND status='active' AND rule_id = ANY($2)
           ORDER BY rule_id, created_at DESC`,
          [scope.workspaceId, agent.fence_bindings],
        )).rows;

        // 技能包：preset 声明 skills × 技能注册表 × 本工作区安装态（F8.2 安装即绑定）
        const skillRows = agent.skills.length === 0 ? [] : (await client.query<{
          id: string; name: string; level: string; version: string; fence_bindings: string[]; installed: boolean;
        }>(
          // preset 声明为短名（revenue-manager），注册表主键带 skill- 前缀——两种形态都匹配
          `SELECT s.id, s.name, s.level, s.version, s.fence_bindings,
                  EXISTS(SELECT 1 FROM skill_installs si WHERE si.skill_id=s.id AND si.workspace_id=$1) AS installed
           FROM skills s
           WHERE s.id = ANY($2) OR s.id = ANY(ARRAY(SELECT 'skill-' || x FROM unnest($2::text[]) AS x))
           ORDER BY s.id`,
          [scope.workspaceId, agent.skills],
        )).rows;

        // 30 天战绩（L6.3 事件投影；驳回原因回流偏好记忆 F1.7 由 review-console 负责）
        const st = await client.query<{
          actions30: string; adopted30: string; rejected30: string; credits30: string; offpeak30: string;
        }>(
          `SELECT
             (SELECT count(*) FROM biz_events e WHERE e.workspace_id=$1 AND e.payload->'who'->>'id'=$2
               AND e.created_at > now() - interval '30 days') AS actions30,
             (SELECT count(*) FROM approvals ap JOIN biz_events e ON e.event_id=ap.event_id
               WHERE ap.workspace_id=$1 AND e.payload->'who'->>'id'=$2 AND ap.status IN ('approved','edited')
               AND ap.created_at > now() - interval '30 days') AS adopted30,
             (SELECT count(*) FROM approvals ap JOIN biz_events e ON e.event_id=ap.event_id
               WHERE ap.workspace_id=$1 AND e.payload->'who'->>'id'=$2 AND ap.status='rejected'
               AND ap.created_at > now() - interval '30 days') AS rejected30,
             (SELECT COALESCE(sum((e.payload->'model_trace'->>'credits')::numeric),0) FROM biz_events e
               WHERE e.workspace_id=$1 AND e.payload->'who'->>'id'=$2
               AND e.created_at > now() - interval '30 days') AS credits30,
             (SELECT COALESCE(sum((e.payload->'model_trace'->>'credits')::numeric)
                     FILTER (WHERE e.payload->'model_trace'->>'window'='off-peak'),0) FROM biz_events e
               WHERE e.workspace_id=$1 AND e.payload->'who'->>'id'=$2
               AND e.created_at > now() - interval '30 days') AS offpeak30`,
          [scope.workspaceId, agent.preset_key],
        );
        const s = st.rows[0]!;
        const actions = Number(s.actions30), adopted = Number(s.adopted30), rejected = Number(s.rejected30);
        const credits = Number(s.credits30), offpeak = Number(s.offpeak30);

        // 最近动作事件流（P8E5：who.id 过滤投影，ts 倒序取 12 条；点击进线程 → P2）
        const ev = await client.query<{
          event_id: string; session_id: string | null; created_at: Date; payload: {
            decision?: { action?: string };
            object?: { type?: string; id?: string };
            rule_impact?: Array<{ rule_id: string; result: string }>;
            receipt?: { synced?: boolean };
          };
        }>(
          `SELECT event_id, session_id, created_at, payload FROM biz_events
           WHERE workspace_id=$1 AND payload->'who'->>'id'=$2
           ORDER BY seq DESC LIMIT 12`,
          [scope.workspaceId, agent.preset_key],
        );

        return {
          agent: {
            id: agent.id, presetKey: agent.preset_key, name: agent.name, version: agent.version,
            kind: agent.kind, readonly: agent.readonly, status: agent.status, invalidReason: agent.invalid_reason,
            description: agent.meta?.description ?? "",
            nightShift: agent.meta?.night_shift === true, highRisk: agent.meta?.high_risk === true,
            tools: agent.meta?.tools ?? [], writeBack: agent.meta?.write_back ?? [],
            constraints: agent.meta?.prompt?.constraints ?? [],
          },
          workspaceName: ws.rows[0]?.name ?? "",
          bundle: "workloom-hotel", // 首版唯一行业 Bundle（D2）
          nightWindow: { open: inNightWindow(), range: "22:00–08:00" },
          fences: agent.fence_bindings.map((ruleId) => {
            const hit = fences.find((f) => f.rule_id === ruleId);
            return hit
              ? { ruleId, name: hit.name, level: hit.level, version: hit.version, isBaseline: hit.is_baseline, declared: true as const }
              : { ruleId, declared: false as const }; // 声明悬空：preset 声明了但规则不存在 → 标红
          }),
          skills: skillRows,
          stats: {
            actions30: actions, adopted30: adopted, rejected30: rejected,
            adoptionRate: adopted + rejected > 0 ? adopted / (adopted + rejected) : null,
            credits30: credits, offPeakRatio: credits > 0 ? offpeak / credits : null,
          },
          game: gameOf(actions * 2 + credits),
          events: ev.rows.map((e) => ({
            eventId: e.event_id,
            sessionId: e.session_id,
            time: e.created_at.toISOString(),
            action: e.payload.decision?.action ?? "",
            objectType: e.payload.object?.type ?? "",
            ruleResults: (e.payload.rule_impact ?? []).map((r) => `${r.rule_id}:${r.result}`),
            receiptSynced: e.payload.receipt?.synced === true, // 无回执标未核实（E3.7）
          })),
        };
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        await client.query("COMMIT").catch(() => undefined);
        client.release();
      }
    }),
});

/** im router（B11/D14：IM 通道域 tRPC 薄壳——通道注册表/入站/审批卡片出站/手势回调）
 *  Mock 驱动默认（D4 同纪律：无真实凭据全流程可跑）；真实通道凭据在 dsh 设置页配置（dsh-im，D14），
 *  凭据永不经事件明文（L7.3）。server 层只做装配与错误映射，纪律全部内聚在 packages/base/im-channels。 */
const imDriverKind = process.env.IM_DRIVER ?? "mock";
const imDrivers = new Map<ApprovalChannel, MockChannelDriver>();
function mockDriverFor(channel: ApprovalChannel): MockChannelDriver {
  let d = imDrivers.get(channel);
  if (!d) {
    d = new MockChannelDriver(channel);
    imDrivers.set(channel, d);
  }
  return d;
}
/** 通道域错误 → tRPC 映射：身份未映射=403（E5.2 无权审批）；其余通道错误=400 */
function imRethrow(err: unknown): never {
  if (err instanceof ChannelError) {
    throw new TRPCError({
      code: err.code === "IDENTITY_UNMAPPED" ? "FORBIDDEN" : "BAD_REQUEST",
      message: err.message,
    });
  }
  if (err instanceof ApprovalError) {
    throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
  }
  throw err;
}
/** P0-1：im.inbound 服务间密钥校验（dsh-im → server 内网调用面）
 *  env IM_BRIDGE_KEY 已配置：x-workloom-key 头必须匹配，否则 401；
 *  缺省（开发）：占位放行并 console.warn（生产必须配置，与 SERVICE_C_DEMO_AUTH 同纪律）。 */
function assertBridgeKey(headers: Headers): void {
  const key = process.env.IM_BRIDGE_KEY;
  if (!key) {
    console.warn("[im] IM_BRIDGE_KEY 未配置：im.inbound 服务间密钥校验占位放行（开发态；生产必须配置）");
    return;
  }
  if (headers.get("x-workloom-key") !== key) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "服务间密钥校验失败（x-workloom-key 与 IM_BRIDGE_KEY 不匹配）" });
  }
}
const imRouter = router({
  /** 通道注册表 + 驱动状态（P 设置页/联调用） */
  channels: protectedProcedure.query(() => ({
    driver: imDriverKind,
    channels: listChannels(),
  })),
  /** 入站 webhook（dsh-im 归一化后注入；幂等+PII 脱敏+openid 映射内聚在服务层） */
  inbound: writeProcedure
    .input(
      z.object({
        channel: z.enum(["inapp", "dingtalk", "wecom", "feishu"]),
        channelMsgId: z.string().min(1),
        conversationId: z.string().min(1),
        kind: z.enum(["direct", "group"]),
        senderOpenId: z.string().min(1),
        text: z.string().min(1).max(2000),
        sentAt: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      assertBridgeKey(ctx.headers); // P0-1：服务间密钥（缺省 dev 占位 warn）
      try {
        return await ingestInbound(getAppPool(), getGatewayPool(), scopeOf(ctx.identity), input);
      } catch (err) {
        imRethrow(err);
      }
    }),
  /** 审批卡片出站（F5.5 IM 卡片多通道；仅 pending 可发，出站留痕 approval.card.sent） */
  sendApprovalCard: writeProcedure
    .input(
      z.object({
        approvalId: z.string().min(1),
        channel: z.enum(["dingtalk", "wecom", "feishu"]),
        conversationId: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const client = await getAppPool().connect();
      try {
        // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
        const r = await client.query<{
          approval_id: string;
          event_id: string;
          snapshot: { expires_at?: string } | null;
          payload: unknown;
        }>(
          `SELECT a.approval_id, a.event_id, a.snapshot, e.payload
             FROM approvals a JOIN biz_events e ON e.event_id = a.event_id
            WHERE a.approval_id = $1 AND a.status = 'pending'`,
          [input.approvalId],
        );
        const row = r.rows[0];
        if (!row) {
          throw new TRPCError({ code: "NOT_FOUND", message: `审批单 ${input.approvalId} 不存在或已决（L7.1 越权返回空）` });
        }
        const card = composeApprovalCard(row as never);
        const sent = await sendApprovalCard(
          getGatewayPool(),
          scope,
          mockDriverFor(input.channel),
          { conversationId: input.conversationId },
          card,
          ctx.identity.memberNo,
        );
        return { ...sent, card };
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        imRethrow(err);
      } finally {
        await client.query("COMMIT").catch(() => undefined);
        client.release();
      }
    }),
  /** 手势回调（F5.4 手势回写多通道；decide 内聚 L5.1/L5.2/L5.3/E5.3 全纪律）
   *  P0-1 通道验签：secret 已配置 → x-channel-signature 必须通过；开发缺省 secret 降级为
   *  「仅允许会话成员本人操作」（operatorOpenId 必须等于当前会话成员在该通道绑定的 openid），响应标注 unsigned:true */
  callback: writeProcedure
    .input(
      z.object({
        channel: z.enum(["dingtalk", "wecom", "feishu"]),
        approvalId: z.string().min(1),
        operatorOpenId: z.string().min(1),
        conversationId: z.string().min(1),
        gesture: z.enum(["approve", "edit", "reject"]),
        reasonEnum: z.string().optional(),
        reasonText: z.string().max(200).optional(),
        editedAfter: z.unknown().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      // P0-1 验签 seam：body = 回调 payload 稳定 JSON（与 dsh-im 桥约定口径）
      const sig = verifyChannelSignature(input.channel, ctx.headers, stableStringify(input));
      if (!sig.verified) {
        if (!sig.unsigned) {
          // secret 已配置但验签失败（缺头/超时/比对不一致）→ 一律拒绝，不落本人降级
          throw new TRPCError({ code: "FORBIDDEN", message: `通道签名验证失败：${sig.reason}` });
        }
        // 开发降级（缺省 secret）：仅允许会话成员本人操作——冒名他人 openid 在此被拒
        const bound = await boundOpenidOfMember(getAppPool(), scope, input.channel, ctx.identity.memberNo);
        if (!bound || bound !== input.operatorOpenId) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: `未验签通道回调仅允许本人操作：operatorOpenId 须为当前会话成员 ${ctx.identity.memberNo} 在 ${input.channel} 绑定的 openid（P0-1 开发降级）`,
          });
        }
      }
      try {
        const r = await handleGestureCallback(
          getAppPool(),
          getGatewayPool(),
          scope,
          input,
          mockDriverFor(input.channel),
        );
        return { ...r, unsigned: sig.unsigned };
      } catch (err) {
        imRethrow(err);
      }
    }),
  /** mock 出站盒检视（IM_DRIVER=mock 联调/演示用；真实驱动下为空） */
  outbox: protectedProcedure
    .input(z.object({ channel: z.enum(["dingtalk", "wecom", "feishu"]) }))
    .query(({ input }) => ({
      driver: imDriverKind,
      outbox: imDrivers.get(input.channel)?.outbox ?? [],
    })),
});

/** bundles router（F11：P7 舰船换装坞——行业装配台 §2.2/§2.3；校验 F2.10/L1.6；权限 E2.6）
 *  数据来源（P7-⑤）：槽位=bundle 注册表实物投影（磁盘扫描）；校验=活算+留痕（biz_events bundle.*） */
function assertBundleManage(role: string): void {
  if (role === "readonly") {
    throw new TRPCError({ code: "FORBIDDEN", message: "readonly 角色无装配管理权限（E2.6，服务端 403）" });
  }
}
function bundleRethrow(err: unknown): never {
  if (err instanceof BundleError) {
    throw new TRPCError({
      code: err.code === "NOT_FOUND" ? "NOT_FOUND"
        : err.code === "ASSEMBLY_CHECK_FAILED" ? "PRECONDITION_FAILED"
        : "BAD_REQUEST",
      message: err.message,
      cause: err.checks ? { checks: err.checks } : undefined,
    });
  }
  throw err;
}

const bundlesRouter = router({
  /** 装配状态投影：全部 profile（注册表扫描）+ 选中 profile 六槽/检查单/班组（默认当前激活） */
  status: protectedProcedure
    .input(z.object({ slug: z.string().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const app = getAppPool();
      const scope = scopeOf(ctx.identity);
      // workspaces 有 RLS：必须在事务内设上下文再查（否则恒 0 行回退默认 industry）
      const ws = await (async () => {
        const c = await app.connect();
        try {
          await c.query("BEGIN");
          await c.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
          await c.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
          const r = await c.query<{ industry: string }>(`SELECT industry FROM workspaces WHERE id=$1`, [scope.workspaceId]);
          await c.query("COMMIT");
          return r;
        } catch (err) {
          await c.query("ROLLBACK").catch(() => undefined);
          throw err;
        } finally {
          c.release();
        }
      })();
      const activeSlug = ws.rows[0]?.industry ?? "hotel";
      const slugs = listProfileSlugs();
      const profiles = [] as Awaited<ReturnType<typeof computeAssembly>>[];
      for (const s of slugs) {
        try {
          profiles.push(await computeAssembly(app, scope, s));
        } catch {
          /* 注册表坏档不拖垮整页（L9.2：跳过并缺席，由校验页显式呈现缺失） */
        }
      }
      const selected = profiles.find((p) => p.slug === (input?.slug ?? activeSlug)) ?? profiles[0] ?? null;
      return { activeSlug, profiles, selected };
    }),
  /** 重跑校验并留痕（P7E3：修复后重跑；记录可查） */
  recheck: protectedProcedure
    .input(z.object({ slug: z.string() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await recheckBundle(getAppPool(), getGatewayPool(), scopeOf(ctx.identity), input.slug, ctx.identity.memberNo);
      } catch (err) {
        bundleRethrow(err);
      }
    }),
  /** 激活/切换 profile（F2.10：任一校验失败拒绝激活，PRECONDITION_FAILED 带检查单） */
  activate: protectedProcedure
    .input(z.object({ slug: z.string() }))
    .mutation(async ({ ctx, input }) => {
      assertBundleManage(ctx.identity.role);
      try {
        return await activateBundle(getAppPool(), getGatewayPool(), scopeOf(ctx.identity), input.slug, ctx.identity.memberNo);
      } catch (err) {
        bundleRethrow(err);
      }
    }),
  /** 新建行业 Bundle 五要素向导（P7E5/§2.3：草稿不进分发） */
  createDraft: protectedProcedure
    .input(z.object({
      slug: z.string(),
      displayName: z.string().min(1),
      version: z.string().min(1),
      changelog: z.string().min(1),
      fenceRef: z.string().min(1),
      ownerMemberNo: z.string().min(1),
    }))
    .mutation(async ({ ctx, input }) => {
      assertBundleManage(ctx.identity.role);
      try {
        return await createBundleDraft(getGatewayPool(), scopeOf(ctx.identity), input, ctx.identity.memberNo);
      } catch (err) {
        bundleRethrow(err);
      }
    }),
});

/**
 * 统一 LLM 调用面（B8/B9）：LLM_PROVIDER 非 mock 且凭据齐备 → 真实模型；
 * 默认 mock 或未配置 → undefined（各链路走确定性兜底，D4 全流程可跑）。
 * 模型出站强制脱敏（L6.2，OpenAiCompatibleProvider 内建不可绕过）。
 * 落地向导契约：写入 LLM_PROVIDER/LLM_BASE_URL/LLM_API_KEY/LLM_MODEL 四 env 即全链真实化。
 */
let cachedLlmCall: ((prompt: string) => Promise<string>) | null | undefined;
/**
 * 统一 LLM 调用面（v3.0 收口）：带 scope 时经 routedLlmCall 走 routeSmart 全链路
 * （场景表 × 套餐映射 × 降级链 × 真实计量 × model.call 事件留痕）；
 * 无 scope 或装配失败 → 旧轻量路径兜底；mock → undefined（via=rule 确定性兜底）。
 */
function llmCall(scene = "generic", scope?: { tenantId: string; workspaceId: string }): ((prompt: string) => Promise<string>) | undefined {
  if (scope) {
    const routed = routedLlmCall({
      gateway: getGatewayPool(), scope, scene,
      industryResolver: () => workspaceIndustry(scope),
    });
    if (routed) return routed;
  }
  if (cachedLlmCall !== undefined) return cachedLlmCall ?? undefined;
  try {
    if ((process.env.LLM_PROVIDER ?? "mock") === "mock") {
      cachedLlmCall = null;
      return undefined;
    }
    const provider = providerFromEnv(process.env.LLM_MODEL ?? "deepseek-chat");
    cachedLlmCall = async (prompt: string) => {
      const res = await provider.chat([{ role: "user", content: prompt }]);
      return res.text;
    };
    return cachedLlmCall;
  } catch {
    cachedLlmCall = null; // 配置缺失 → 兜底（via=rule 留痕）
    return undefined;
  }
}

/** 工作区行业（bundle 第⑦槽 model-policy.yml 按行业加载；进程级缓存） */
let cachedIndustry: string | null | undefined;
async function workspaceIndustry(scope: { workspaceId: string }): Promise<string | null> {
  if (cachedIndustry !== undefined) return cachedIndustry;
  try {
    const r = await getAppPool().query<{ industry: string | null }>(
      `SELECT industry FROM workspaces WHERE id=$1`, [scope.workspaceId]);
    cachedIndustry = r.rows[0]?.industry ?? null;
  } catch {
    cachedIndustry = null;
  }
  return cachedIndustry;
}

let cachedClassifier: IntentClassifier | null | undefined;
function intentClassifier(scope?: { tenantId: string; workspaceId: string }): IntentClassifier | undefined {
  if (scope) {
    const call = llmCall("intent-classify", scope);
    if (call) return new LlmIntentClassifier(call);
  }
  if (cachedClassifier !== undefined) return cachedClassifier ?? undefined;
  const call = llmCall("intent-classify");
  cachedClassifier = call ? new LlmIntentClassifier(call) : null;
  return cachedClassifier ?? undefined;
}

/**
 * 数字CEO（D21）：治理状态 + 深度授权 + 节拍手动触发 + 董事长队列 + 成绩单。
 * 写操作一律五元事件留痕；mode 守卫在节拍引擎内双保险（§12）。
 */
/** 风险揭示书版本（§12.2 第①步；文本见 docs/CEO-RISK-DISCLOSURE.md） */
const RISK_DISCLOSURE_VERSION = "risk-v1";
/** 深度授权必确认条款（§12.2 第②步，逐条勾选缺一不可） */
const REQUIRED_CLAUSES = ["自主调价", "自主采购", "自主对外回复", "试用降档规则", "AI 非法律责任主体·授权人承担经营决策责任"];

/** 宪章读写串行锁（D26 审计#6：grant/transit 为 load→transition→save 读改写，并发互踩会留下 from/to 失真的留痕） */
let charterLock: Promise<unknown> = Promise.resolve();
function withCharterLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = charterLock.then(fn, fn);
  charterLock = run.catch(() => undefined);
  return run;
}

const captainRouter = router({
  /** 治理状态：宪章 + 模式 + 授权信息 + 待审分层 */
  state: protectedProcedure.query(async ({ ctx }) => {
    const scope = scopeOf(ctx.identity);
    const app = getAppPool();
    const charter = await loadCharter(app, scope);
    const client = await app.connect();
    let tiers: Record<string, number> = {};
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
      const t = await client.query<{ tier: string; n: string }>(
        `SELECT tier, count(*)::text AS n FROM approvals WHERE workspace_id=$1 AND status='pending' GROUP BY 1`,
        [scope.workspaceId],
      );
      await client.query("COMMIT");
      tiers = Object.fromEntries(t.rows.map((x) => [x.tier, Number(x.n)]));
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    return { charter, pendingByTier: tiers, disclosureVersion: RISK_DISCLOSURE_VERSION, requiredClauses: REQUIRED_CLAUSES };
  }),

  /** 深度授权（§12.2）：条款全确认 → disabled → shadow；授权动作五元留痕（法律留痕） */
  grant: capabilityWriteProcedure("quest")
    .input(z.object({
      clauses: z.array(z.string()),
      autonomy: z.object({
        price_band: z.tuple([z.number(), z.number()]),
        procurement_cap: z.number(),
        campaign_cap: z.number(),
      }),
      shadowDays: z.number().int().min(1).max(14).default(3),
      trialDays: z.number().int().min(3).max(30).default(7),
      identityConfirmed: z.boolean(), // §12.2 第⑤步身份核验（演示环境布尔确认）
    }))
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const missing = REQUIRED_CLAUSES.filter((c) => !input.clauses.includes(c));
      if (missing.length) throw new TRPCError({ code: "BAD_REQUEST", message: `授权条款未全部确认：${missing.join("、")}` });
      if (!input.identityConfirmed) throw new TRPCError({ code: "BAD_REQUEST", message: "未完成身份核验（§12.2 第⑤步）" });
      const app = getAppPool();
      return withCharterLock(async () => {
      // D16（#1/A）：宪章读改写 + 授权事件同一事务同一 COMMIT；
      // 事件先落库取真实 eventId 回填 charter.grant.event_id（替换 E-GRANT-${Date.now()} 假 id）
      const client = await app.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
        const row = await client.query<{ archive: Record<string, unknown> }>(
          `SELECT archive FROM profiles WHERE workspace_id=$1 FOR UPDATE`,
          [scope.workspaceId],
        );
        const charter = parseCharter(row.rows[0]?.archive?.charter);
        const grantedAt = new Date().toISOString();
        const next = transition({ ...charter, autonomy: input.autonomy }, {
          kind: "grant",
          grant: {
            event_id: "", granted_by: ctx.identity.memberNo, granted_at: grantedAt,
            disclosure_version: RISK_DISCLOSURE_VERSION, clauses: input.clauses,
            shadow_days: input.shadowDays, trial_days: input.trialDays, trial_ends_at: null, retain_until: null,
          },
        });
        const ev = await gatewayAppendOnClient(client, {
          ...scope, actor: { id: ctx.identity.memberNo, type: "human" }, sessionId: `ceo-grant-${scope.workspaceId}`,
        }, {
          who: { type: "human", id: ctx.identity.memberNo },
          context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: grantedAt },
          object: { type: "company_ceo", id: scope.workspaceId },
          decision: {
            action: "captain.grant",
            params: { disclosure_version: RISK_DISCLOSURE_VERSION, clauses: input.clauses, autonomy: input.autonomy, shadow_days: input.shadowDays, trial_days: input.trialDays },
            after: { mode: next.mode },
            basis: ["深度授权六步完成：风险揭示/逐项确认/边界设定/试用计划/身份核验/签署", "此记录不可篡改不可删除（§12.2 第⑥步）"],
          },
          rule_impact: [],
          model_trace: { model_id: "human-chairman", tier: "standard" },
        });
        // 真实 eventId 回填宪章（法律留痕锚点：宪章 ↔ 授权事件可互查）
        if (next.grant) next.grant.event_id = ev.eventId;
        await client.query(
          `UPDATE profiles SET archive = jsonb_set(archive, '{charter}', $2::jsonb), updated_at=now() WHERE workspace_id=$1`,
          [scope.workspaceId, JSON.stringify(next)],
        );
        await client.query("COMMIT");
        return { mode: next.mode, grantEventId: ev.eventId };
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
      });
    }),

  /** 治理迁移：advance/expire/keep_long/keep_until/revoke/close（§12.1 状态机） */
  transit: capabilityWriteProcedure("quest")
    .input(z.object({ kind: z.enum(["advance", "expire", "keep_long", "keep_until", "revoke", "close"]), until: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const app = getAppPool();
      return withCharterLock(async () => {
      // D16（#1/A）：宪章读改写 + 迁移事件同一事务同一 COMMIT
      const client = await app.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
        const row = await client.query<{ archive: Record<string, unknown> }>(
          `SELECT archive FROM profiles WHERE workspace_id=$1 FOR UPDATE`,
          [scope.workspaceId],
        );
        const charter = parseCharter(row.rows[0]?.archive?.charter);
        const t: CeoTransition = input.kind === "keep_until"
          ? { kind: "keep_until", until: input.until ?? new Date(Date.now() + 30 * 86400e3).toISOString() }
          : { kind: input.kind };
        let next;
        try {
          next = transition(charter, t);
        } catch (e) {
          throw new TRPCError({ code: "BAD_REQUEST", message: (e as Error).message });
        }
        await client.query(
          `UPDATE profiles SET archive = jsonb_set(archive, '{charter}', $2::jsonb), updated_at=now() WHERE workspace_id=$1`,
          [scope.workspaceId, JSON.stringify(next)],
        );
        await gatewayAppendOnClient(client, {
          ...scope, actor: { id: ctx.identity.memberNo, type: "human" }, sessionId: `ceo-grant-${scope.workspaceId}`,
        }, {
          who: { type: "human", id: ctx.identity.memberNo },
          context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString() },
          object: { type: "company_ceo", id: scope.workspaceId },
          decision: {
            action: "captain.mode_change",
            params: { from: charter.mode, to: next.mode, by: ctx.identity.memberNo, kind: input.kind },
            after: { mode: next.mode },
            basis: [`董事长手动迁移：${charter.mode} → ${next.mode}`],
          },
          rule_impact: [],
          model_trace: { model_id: "human-chairman", tier: "standard" },
        });
        await client.query("COMMIT");
        return { mode: next.mode };
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
      });
    }),

  /** 手动触发节拍（演示/调度共用入口）：briefing/queue/deviation/breaker */
  runBeat: capabilityWriteProcedure("quest")
    .input(z.object({ beat: z.enum(["daily", "weekly", "monthly", "fleet_daily", "queue", "deviation", "breaker", "outcome", "hr", "board", "orgscan", "routerreview"]) }))
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const app = getAppPool();
      switch (input.beat) {
        case "queue": return runQueueBeat(app, scope, { llmCall: llmCall("ceo-decision", scope) });
        case "deviation": return runDeviationBeat(app, scope);
        case "breaker": return runBreakerBeat(app, scope);
        case "outcome": return runOutcomeReviewBeat(app, scope);
        case "hr": return runHrReviewBeat(app, scope, { llmCall: llmCall("hr-replacement", scope) });
        case "board": return runBoardPackBeat(app, scope, { llmCall: llmCall("briefing", scope) });
        case "orgscan": return runOrgScanBeat(app, scope);
        case "routerreview": return runRouterReviewBeat(app, getGatewayPool(), scope);
        default: {
          const kind = input.beat === "fleet_daily" ? "fleet_daily" : input.beat;
          // fleet_daily：单店模型退化为本店晨报口径（方案 §三：编制不空转；多店聚合在 P22 视图层轮询）
          const wsName = kind === "fleet_daily" ? "集团CEO" : undefined;
          const charter = await loadCharter(app, scope);
          const r = await runBriefingBeat(app, scope, kind, { llmCall: llmCall("briefing", scope) });
          // IM 通道推送（方案双通道；charter.briefing.channel=im|both 时推送，mock 驱动留痕）
          let imPushed = false;
          if (r.eventId && !r.skipped && charter.briefing.channel !== "app") {
            const textRow = await app.connect().then(async (c) => {
              try {
                await c.query("BEGIN");
                await c.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
                const q = await c.query<{ payload: Record<string, unknown> }>(`SELECT payload FROM biz_events WHERE event_id=$1`, [r.eventId]);
                await c.query("COMMIT");
                return q.rows[0]?.payload;
              } catch (e) { await c.query("ROLLBACK").catch(() => undefined); throw e; } finally { c.release(); }
            });
            const text = String(((textRow?.decision as Record<string, unknown>)?.after as Record<string, unknown>)?.text ?? "");
            if (text) {
              const driver = new MockChannelDriver("wecom");
              const sent = await driver.sendText({ conversationId: `chairman-${scope.workspaceId}` }, text);
              // 外发口径（D16 例外，先发后写，同 sendApprovalCard）：外发不可撤回，先发送后写事件；
              // 事件写失败补写补偿事件（im.outbound.unrecorded，best-effort 一次），再失败抛错人工对账
              const outboundActor = { id: "im-channels", type: "system" as const };
              const outboundBase = {
                who: { type: "system" as const, id: "im-channels" },
                context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "wecom" },
                object: { type: "conversation", id: `chairman-${scope.workspaceId}` },
                rule_impact: [] as never[],
              };
              try {
                await gatewayAppend(getGatewayPool(), { ...scope, actor: outboundActor }, {
                  ...outboundBase,
                  decision: {
                    action: "im.outbound",
                    params: { channel_msg_id: sent.channelMsgId, ref_event: r.eventId, kind },
                    after: { text: text.slice(0, 500) },
                    basis: [`简报双通道推送（charter.briefing.channel=${charter.briefing.channel}）`],
                  },
                });
              } catch (outErr) {
                console.warn(`[captain] im.outbound 留痕写失败（简报 ${r.eventId} 已外发 ${sent.channelMsgId}），补写补偿事件：`, outErr instanceof Error ? outErr.message : outErr);
                await gatewayAppend(getGatewayPool(), { ...scope, actor: outboundActor }, {
                  ...outboundBase,
                  decision: {
                    action: "im.outbound.unrecorded",
                    params: { channel_msg_id: sent.channelMsgId, ref_event: r.eventId, kind },
                    after: { original_action: "im.outbound", send_error: outErr instanceof Error ? outErr.message : String(outErr) },
                    basis: ["补偿事件：简报已外发但 im.outbound 留痕写失败（外发不可撤回，先发后写口径）"],
                  },
                });
              }
              imPushed = true;
            }
          }
          return { ...r, name: wsName ?? charter.identity.name, imPushed };
        }
      }
    }),

  /** 最近简报（P21 董事长视图数据源） */
  briefings: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(20).default(5) }).optional())
    .query(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const app = getAppPool();
      const client = await app.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
        const r = await client.query<{ event_id: string; payload: Record<string, unknown>; created_at: string }>(
          `SELECT event_id, payload, created_at FROM biz_events
           WHERE workspace_id=$1 AND payload->'decision'->>'action' IN ('ceo.briefing','ceo.decision','ceo.circuit_breaker','initiative.launch')
           ORDER BY seq DESC LIMIT $2`,
          [scope.workspaceId, input?.limit ?? 5],
        );
        await client.query("COMMIT");
        return r.rows;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    }),

  /** 董事长请示队列（L4 pending + 事件依据链；P21 inline 三手势数据源） */
  chairmanQueue: protectedProcedure.query(async ({ ctx }) => {
    const scope = scopeOf(ctx.identity);
    const app = getAppPool();
    const client = await app.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
      const r = await client.query<{
        approval_id: string; event_id: string; snapshot: Record<string, unknown>; payload: Record<string, unknown>;
      }>(
        `SELECT a.approval_id, a.event_id, a.snapshot, e.payload
         FROM approvals a JOIN biz_events e ON e.event_id = a.event_id AND e.workspace_id = a.workspace_id
         WHERE a.workspace_id=$1 AND a.status='pending' AND a.tier='l4_chairman'
         ORDER BY a.approval_id LIMIT 20`,
        [scope.workspaceId],
      );
      await client.query("COMMIT");
      return r.rows;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }),

  /** 董事长反馈（赞/踩 → ceo.feedback 事件 + 组织记忆奖励信号）
   *  D16（#1/A）：事件与 org_memory 写入同一事务同一 COMMIT；
   *  记忆写入走 workdata upsertMemoryInTx（内含 maskText 脱敏——修复 note 明文直插的 PII 漏脱敏） */
  feedback: writeProcedure
    .input(z.object({ eventId: z.string(), signal: z.enum(["up", "down"]), note: z.string().max(200).optional() }))
    .mutation(async ({ ctx, input }) => {
      const scope = scopeOf(ctx.identity);
      const app = getAppPool();
      const client = await app.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
        const ev = await gatewayAppendOnClient(client, {
          ...scope, actor: { id: ctx.identity.memberNo, type: "human" }, sessionId: `ceo-feedback-${scope.workspaceId}`,
        }, {
          who: { type: "human", id: ctx.identity.memberNo },
          context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString() },
          object: { type: "task", id: input.eventId },
          decision: {
            action: "ceo.feedback",
            params: { ref_event: input.eventId, signal: input.signal, note: input.note ?? "" },
            after: {},
            basis: [`董事长对决策 ${input.eventId} 的${input.signal === "up" ? "点赞" : "点踩"}（入组织记忆，成为后续决策奖励信号）`],
          },
          rule_impact: [],
          model_trace: { model_id: "human-chairman", tier: "standard" },
        });
        // 组织记忆写入（pattern 类：奖励/纠正信号；memoryId 由反馈事件派生可互查；内容经 maskText 脱敏）
        await upsertMemoryInTx(client, scope, {
          memoryId: `mem-fb-${ev.eventId.toLowerCase()}`,
          scope: "workspace",
          kind: "pattern",
          content: `【${ctx.identity.memberNo}】董事长${input.signal === "up" ? "认可" : "否定"}决策 ${input.eventId}${input.note ? `：${input.note}` : ""}`,
          sourceEvents: [ev.eventId, input.eventId],
        }, new MockEmbedder());
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
      return { ok: true };
    }),

  /** 经营剧场聚合态（P0 首页：治理态/请示/简报/员工卫星/实况流，5s 心跳数据源） */
  theater: protectedProcedure.query(async ({ ctx }) => {
    const scope = scopeOf(ctx.identity);
    const app = getAppPool();
    const charter = await loadCharter(app, scope);
    const client = await app.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
      const tiers = await client.query<{ tier: string; n: string }>(
        `SELECT tier, count(*)::text AS n FROM approvals WHERE workspace_id=$1 AND status='pending' GROUP BY 1`,
        [scope.workspaceId],
      );
      // 展示层过滤：E2E 测试标记（E2E-*）写入的晨报不返回给界面（哈希链不动、套件断言不受影响——套件直接查库）
      const briefing = await client.query<{ payload: Record<string, unknown>; created_at: string }>(
        `SELECT payload, created_at FROM biz_events WHERE workspace_id=$1 AND payload->'decision'->>'action' IN ('ceo.briefing','ceo.board_pack')
         AND payload->'decision'->'after'->>'text' NOT LIKE '%E2E-%'
         ORDER BY seq DESC LIMIT 1`,
        [scope.workspaceId],
      );
      const agents = await client.query<{ id: string; preset_key: string; name: string; alias: string | null }>(
        `SELECT id, preset_key, name, alias FROM agents WHERE workspace_id=$1 AND status='ready' ORDER BY id LIMIT 12`,
        [scope.workspaceId],
      );
      const grades = await client.query<{ agent_id: string; grade: string }>(
        `SELECT DISTINCT ON (payload->'decision'->'params'->>'agent_id')
           payload->'decision'->'params'->>'agent_id' AS agent_id,
           payload->'decision'->'params'->>'grade' AS grade
         FROM biz_events WHERE workspace_id=$1 AND payload->'decision'->>'action'='hr.review'
         ORDER BY 1, seq DESC`,
        [scope.workspaceId],
      );
      // ticker 同口径过滤测试噪声（E2E 标记与套件 mock 数据不进界面）
      const events = await client.query<{ event_id: string; action: string; who: string; created_at: string }>(
        `SELECT event_id, payload->'decision'->>'action' AS action, payload->'who'->>'id' AS who, created_at
         FROM biz_events WHERE workspace_id=$1
         AND payload->'decision'->'after'->>'text' NOT LIKE '%E2E-%'
         AND payload->'decision'->>'action' NOT LIKE 'test.%'
         ORDER BY seq DESC LIMIT 14`,
        [scope.workspaceId],
      );
      const ind = await client.query<{ industry: string | null }>(
        `SELECT industry FROM profiles WHERE workspace_id=$1`, [scope.workspaceId],
      );
      await client.query("COMMIT");
      const gradeMap = Object.fromEntries(grades.rows.map((g) => [g.agent_id, g.grade]));
      // D25 数字职场：行业场景包 + 员工状态派生（独立聚合，故障不阻塞剧场主数据）
      let floor: unknown = null;
      try {
        floor = await buildFloor(getAppPool(), scope, ind.rows[0]?.industry ?? null);
      } catch { floor = null; }
      return {
        mode: charter.mode,
        ceoName: charter.identity.name,
        pendingByTier: Object.fromEntries(tiers.rows.map((t) => [t.tier, Number(t.n)])),
        latestBriefing: briefing.rows[0]
          ? { text: String(((briefing.rows[0].payload.decision as Record<string, unknown>).after as Record<string, unknown>)?.text ?? ""), at: briefing.rows[0].created_at }
          : null,
        satellites: agents.rows.map((a) => ({ id: a.id, presetKey: a.preset_key, name: a.name, alias: a.alias, grade: gradeMap[a.id] ?? "正常" })),
        ticker: events.rows,
        floor,
      };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }),

  /** 成绩单（方案 §七） */
  scorecard: protectedProcedure.query(async ({ ctx }) => {
    return buildScorecard(getAppPool(), scopeOf(ctx.identity));
  }),
});

/** 组织记忆中心（D24 自我进化飞轮 M2：可读可改可禁用，纠偏与信任通道） */
const memoryRouter = router({
  /** 列表（作用域/种类/状态过滤 + 语义检索可选） */
  list: protectedProcedure
    .input(
      z.object({
        scope: z.enum(["workspace", "agent", "run"]).optional(),
        kind: z.enum(["preference", "pattern", "sop", "forbidden"]).optional(),
        status: z.enum(["active", "superseded", "recalled"]).optional(),
        subjectId: z.string().optional(),
        query: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }).optional(),
    )
    .query(async ({ ctx, input }) => {
      return searchMemories(getAppPool(), scopeOf(ctx.identity), {
        scope: input?.scope, kind: input?.kind, status: input?.status,
        subjectId: input?.subjectId, query: input?.query, limit: input?.limit,
      }, new MockEmbedder());
    }),

  /** 归因反查（验收断言：任一记忆可反查来源事件与被谁引用） */
  sources: protectedProcedure
    .input(z.object({ memoryId: z.string() }))
    .query(async ({ ctx, input }) => {
      return getMemorySources(getAppPool(), scopeOf(ctx.identity), input.memoryId);
    }),

  /** 人类编辑内容（M2.1 可读可改；写 memory.calibrate 事件留痕） */
  update: writeProcedure
    .input(z.object({ memoryId: z.string(), content: z.string().min(1).max(2000) }))
    .mutation(async ({ ctx, input }) => {
      return editMemoryContent(
        getAppPool(), getGatewayPool(), scopeOf(ctx.identity),
        { memberNo: ctx.identity.memberNo }, input.memoryId, input.content,
      );
    }),

  /** 人类禁用（回收区口径 F1.11；防记忆污染越用越偏） */
  disable: writeProcedure
    .input(z.object({ memoryId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      return disableMemory(
        getAppPool(), getGatewayPool(), scopeOf(ctx.identity),
        { memberNo: ctx.identity.memberNo }, input.memoryId,
      );
    }),

  /** 来源人一键清算（D24 修订 2：成员离任/换岗，作废其手势沉淀的偏好记忆） */
  recallBySource: writeProcedure
    .input(z.object({ memberId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      return recallMemoriesByMember(
        getAppPool(), getGatewayPool(), scopeOf(ctx.identity),
        { memberNo: ctx.identity.memberNo }, input.memberId,
      );
    }),

  /** 手动触发提炼节拍（演示/联调用；生产由夜班调度触发） */
  mineNow: writeProcedure.mutation(async ({ ctx }) => {
    return runMemoryMinerBeat(getAppPool(), getGatewayPool(), scopeOf(ctx.identity));
  }),

  /** 手动触发衰减扫描（同上） */
  decayNow: writeProcedure.mutation(async ({ ctx }) => {
    return decayMemories(getAppPool(), getGatewayPool(), scopeOf(ctx.identity));
  }),

  /** 本工作区装配的反馈枚举表（Bundle 第⑧槽；审批卡下拉数据源） */
  feedbackEnums: protectedProcedure.query(async ({ ctx }) => {
    return getFeedbackEnums(scopeOf(ctx.identity).workspaceId) ?? [];
  }),
});

/** 进化积分卡（D24 自我进化飞轮 M5：北极星=审批一次通过率，趋势看斜率） */
const evolutionRouter = router({
  scorecard: protectedProcedure.query(async ({ ctx }) => {
    return buildEvolutionScorecard(getAppPool(), scopeOf(ctx.identity));
  }),
});

export const appRouter = router({
  system: systemRouter,
  onboarding: onboardingRouter,
  auth: authRouter,
  members: membersRouter,
  threads: threadsRouter,
  approvals: approvalsRouter,
  inspection: inspectionRouter,
  skills: skillsRouter,
  workspace: workspaceRouter,
  nightShift: nightShiftRouter,
  fence: fenceRouter,
  roster: rosterRouter,
  im: imRouter,
  bundles: bundlesRouter,
  captain: captainRouter,
  service: serviceRouter,
  credits: creditsRouter,
  modelFeedback: modelFeedbackRouter,
  memory: memoryRouter,
  evolution: evolutionRouter,
});

export type AppRouter = typeof appRouter;
/** 上下文类型经 router 入口再导出（前端 AppRouter 类型可移植性，TS2742） */
export type { TrpcContext } from "./context.js";
export type { ExamSummary } from "../service/eval.js";
export type { BundleInstall, StaffingDraft } from "../service/bundle.js";
export type { IntelItem, RepoPulse } from "../service/aipm.js";
