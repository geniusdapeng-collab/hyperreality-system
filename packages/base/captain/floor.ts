/**
 * captain/floor · 数字职场（D25）——员工状态派生 + 场景包
 *
 * 口径：职场地图上员工的每一个动作都是事件库实时派生（忠实纪律：动作即数据）——
 *  - working      有 running 线程（threads.agent_id）
 *  - queued       有排队中线程（threads.status='queued'，建档即归属）
 *  - asking       有 pending 请示且事件 actor=该员工（L2 以上皆举手，tier 随事件上桌）
 *  - blocked      近 30 分钟异常/驳回/围栏熔断事件关联该员工
 *  - celebrating  近 10 分钟线程完成/夜班包生成事件关联该员工（前端 3s 彩带后回位）
 *  - collab       近 10 分钟跨员工交接（write_back/转派）——β 批次走位动画，本批归并 working
 *  - idle         无任务待命（休息角）；disabled 工位清空名牌变灰
 * 优先级：blocked > asking（与 celebrating 共存：状态保持 asking，另带 celebrating 标志与双信息气泡）> celebrating > working > queued > idle
 *
 * 场景包：声明式 JSON（地板网格/工位锚点/道具/CEO 指挥台/休息角/入口/主题色），
 * 行业包经 registerFloorSceneProvider() 或 bundles/<industry>/floor-scene.json 覆盖；
 * 底座内置通用办公室，零行业词汇。
 */
import type pg from "pg";

/* ================= 类型 ================= */

export type FloorAgentState =
  /** queued（GR-27/X-07）：已建档但尚未开跑的排队任务——此前 `agent_id=NULL` 被 running/queued 过滤条件整条滤掉 */
  | "working" | "queued" | "asking" | "blocked" | "celebrating" | "collab" | "idle" | "disabled";

export interface FloorAgent {
  id: string;
  presetKey: string;
  name: string;
  state: FloorAgentState;
  stationId: string | null;      // 工位锚点（disabled 为 null）
  currentThread: { id: string; title: string } | null;
  pendingTier: string | null;    // asking 时：l2_captain/l3_fleet/l4_chairman
  approvalId: string | null;     // asking 时：审批单号（原地三手势用）
  /**
   * 与 blocked 共存（MC-114）：该员工既有 30 分钟内的异常/驳回/熔断事件，又有 pending 请示。
   * 状态仍按 V-06 纪律显示 blocked（出事优先），但 pendingTier/approvalId 一并下发，
   * 前端据此同时渲染「遇阻」与「请您定」，且点击直达审批卡——不再让遇阻态吃掉待裁信息。
   */
  asking?: boolean;
  /**
   * 该员工当前 pending 审批总数（MC-114 补充）：楼层每员工只给一个直达号（最早一条，FIFO），
   * 多项待裁时用计数把「还有几项」显式带出，避免其余审批在投影里被静默隐藏。
   */
  pendingCount?: number;
  /** 近 10 分钟内该员工刚完成过任务（与 asking 共存：请示仍为主态，庆祝作为附加信号） */
  celebrating?: boolean;
  statusLine: string;            // 头顶气泡一句话（最近动作中文摘要）
}

export interface SceneStation { id: string; x: number; y: number; kind: "desk" | "counter" | "bench" | "monitor" }
export interface SceneProp { kind: string; x: number; y: number; label?: string }

export interface FloorScene {
  id: string;
  name: string;
  theme: { floorA: string; floorB: string; wall: string; accent: string; night: boolean };
  grid: { w: number; h: number };          // 逻辑网格（等距变换前端做）
  stations: SceneStation[];
  props: SceneProp[];
  ceoDesk: { x: number; y: number };
  lounge: { x: number; y: number };
  entrance: { x: number; y: number };
}

export interface FloorPayload {
  scene: FloorScene;
  agents: FloorAgent[];
}

/* ================= 通用办公室（底座默认，零行业词汇） ================= */

export function defaultOfficeScene(): FloorScene {
  return {
    id: "office-generic",
    name: "总部办公区",
    theme: { floorA: "#2a2a3d", floorB: "#1c1c2a", wall: "#3d3d55", accent: "#8ad8ff", night: false },
    grid: { w: 8, h: 8 },
    stations: [
      { id: "st-1", x: 1.5, y: 2.5, kind: "desk" },
      { id: "st-2", x: 3.0, y: 1.8, kind: "desk" },
      { id: "st-3", x: 4.5, y: 2.5, kind: "desk" },
      { id: "st-4", x: 6.0, y: 1.8, kind: "desk" },
      { id: "st-5", x: 2.2, y: 4.2, kind: "desk" },
      { id: "st-6", x: 5.2, y: 4.2, kind: "desk" },
      { id: "st-7", x: 3.6, y: 5.2, kind: "bench" },
      { id: "st-8", x: 6.4, y: 3.4, kind: "monitor" },
    ],
    props: [
      { kind: "whiteboard", x: 0.6, y: 1.2, label: "作战白板" },
      { kind: "plant", x: 7.2, y: 0.9 },
      { kind: "plant", x: 0.8, y: 6.8 },
      { kind: "sofa", x: 1.4, y: 6.2, label: "休息角" },
      { kind: "coffee", x: 2.4, y: 6.6 },
    ],
    ceoDesk: { x: 3.8, y: 0.6 },
    lounge: { x: 1.6, y: 6.3 },
    entrance: { x: 7.4, y: 7.2 },
  };
}

/* ================= 场景包装配（行业挂钩 + 磁盘约定） ================= */

let customSceneProvider: ((industry: string) => FloorScene | undefined) | undefined;
/** 行业场景包注册位（行业 Bundle 启动时调用；进程级单例，与 registerAskFactProvider 同范式） */
export function registerFloorSceneProvider(p: (industry: string) => FloorScene | undefined): void {
  customSceneProvider = p;
}

/** 场景包解析：行业注册 > 磁盘约定（bundles/<industry>/floor-scene.json） > 通用办公室 */
export async function resolveFloorScene(industry: string | null | undefined): Promise<FloorScene> {
  if (industry) {
    if (customSceneProvider) {
      const s = customSceneProvider(industry);
      if (s) return s;
    }
    try {
      const { readFile } = await import("node:fs/promises");
      const { join, dirname } = await import("node:path");
      let dir = process.cwd();
      for (let i = 0; i < 6; i++) {
        try {
          const raw = await readFile(join(dir, "bundles", industry, "floor-scene.json"), "utf8");
          const parsed = JSON.parse(raw) as FloorScene;
          if (parsed && Array.isArray(parsed.stations) && parsed.ceoDesk) return parsed;
        } catch { /* 继续向上找 */ }
        const up = dirname(dir);
        if (up === dir) break;
        dir = up;
      }
    } catch { /* 落入默认 */ }
  }
  return defaultOfficeScene();
}

/* ================= 员工状态派生（只读 SQL，事务级双 GUC） ================= */

interface Scope { tenantId: string; workspaceId: string }

export async function deriveFloor(app: pg.Pool, scope: Scope, scene: FloorScene): Promise<FloorAgent[]> {
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);

    const agents = (await client.query<{ id: string; preset_key: string; name: string; status: string }>(
      `SELECT id, preset_key, name, status FROM agents WHERE workspace_id=$1 ORDER BY preset_key`,
      [scope.workspaceId],
    )).rows;

    // running/queued 线程（agent_id 归属；取每员工最新一条）
    const running = (await client.query<{ agent_id: string; id: string; title: string }>(
      `SELECT DISTINCT ON (agent_id) agent_id, id, title FROM threads
       WHERE workspace_id=$1 AND status='running' AND agent_id IS NOT NULL
       ORDER BY agent_id, updated_at DESC`,
      [scope.workspaceId],
    )).rows;

    /**
     * X-07：排队中（queued）与执行中（running）分开取——派单不立即执行时线程落在 queued，
     * 此前与 running 混在同一查询里，前端无法区分"在跑"与"在排队"；建档写 agent_id 后即可归属。
     */
    const queued = (await client.query<{ agent_id: string; id: string; title: string }>(
      `SELECT DISTINCT ON (agent_id) agent_id, id, title FROM threads
       WHERE workspace_id=$1 AND status='queued' AND agent_id IS NOT NULL
       ORDER BY agent_id, updated_at DESC`,
      [scope.workspaceId],
    )).rows;

    // pending 请示：approvals.snapshot->>'actor' 或事件 who（五元 who.id = preset_key）
    const asking = (await client.query<{ actor: string; tier: string; action: string; approval_id: string; pending_count: number }>(
      `SELECT e.payload->'who'->>'id' AS actor, a.tier,
              e.payload->'decision'->>'action' AS action, a.approval_id,
              count(*) OVER (PARTITION BY e.payload->'who'->>'id')::int AS pending_count
       FROM approvals a JOIN biz_events e ON e.event_id=a.event_id AND e.workspace_id=a.workspace_id
       WHERE a.workspace_id=$1 AND a.status='pending'
       ORDER BY a.created_at ASC`,
      [scope.workspaceId],
    )).rows;

    // 近 30 分钟遇阻：围栏熔断（rule_impact 含 result=blocked，与全库裁决同构）/失败/异常/驳回（actor=preset_key）
    const blocked = (await client.query<{ actor: string; action: string }>(
      `SELECT DISTINCT payload->'who'->>'id' AS actor, payload->'decision'->>'action' AS action
       FROM biz_events
       WHERE workspace_id=$1 AND created_at > now() - interval '30 minutes'
         AND (payload->'rule_impact' @> jsonb_build_array(jsonb_build_object('result', 'blocked'))
           OR payload->'decision'->>'action' LIKE '%.failed'
           OR payload->'decision'->>'action' LIKE 'anomaly.%'
           OR payload->'decision'->>'action' = 'inspect.anomaly'
           OR payload->'decision'->'params'->>'gesture' = 'reject')`,
      [scope.workspaceId],
    )).rows;

    // 近 10 分钟庆祝：线程完成（threads.closed_at 近窗，agent_id 归属）+ 夜班包/董事会包交付
    const celebThreads = (await client.query<{ agent_id: string }>(
      `SELECT DISTINCT agent_id FROM threads
       WHERE workspace_id=$1 AND agent_id IS NOT NULL AND closed_at > now() - interval '10 minutes'`,
      [scope.workspaceId],
    )).rows;
    const celebEvents = (await client.query<{ actor: string; action: string }>(
      `SELECT DISTINCT payload->'who'->>'id' AS actor, payload->'decision'->>'action' AS action
       FROM biz_events
       WHERE workspace_id=$1 AND created_at > now() - interval '10 minutes'
         AND payload->'decision'->>'action' IN ('night.package.deliver','ceo.board_pack','task.complete')`,
      [scope.workspaceId],
    )).rows;

    // 每员工最近动作一句话（头顶气泡）
    const lastActions = (await client.query<{ actor: string; action: string }>(
      `SELECT DISTINCT ON (payload->'who'->>'id') payload->'who'->>'id' AS actor,
              payload->'decision'->>'action' AS action
       FROM biz_events WHERE workspace_id=$1
       ORDER BY payload->'who'->>'id', seq DESC`,
      [scope.workspaceId],
    )).rows;

    await client.query("COMMIT");

    const runningBy = new Map(running.map((r) => [r.agent_id, r]));
    const queuedBy = new Map(queued.map((r) => [r.agent_id, r]));
    // asking/blocked/celebrating 的 actor 是 preset_key（五元 who.id）
    const askingBy = new Map<string, typeof asking[number]>();
    for (const r of asking) if (!askingBy.has(r.actor)) askingBy.set(r.actor, r);
    const blockedSet = new Set(blocked.map((r) => r.actor));
    // 庆祝双通道：事件 actor（preset_key）+ 近窗完成线程的 agent_id
    const celebSet = new Set(celebEvents.map((r) => r.actor));
    const celebAgentIds = new Set(celebThreads.map((r) => r.agent_id));
    const lastBy = new Map(lastActions.map((r) => [r.actor, r.action]));

    // 工位分配：按 preset 顺序循环映射场景 stations（人数超工位时共站，前端按 id 微偏移站位）
    const usable = scene.stations;
    const out: FloorAgent[] = [];
    agents.forEach((a, i) => {
      const station = usable.length ? usable[i % usable.length]! : null;
      const last = lastBy.get(a.preset_key) ?? "";
      if (a.status === "disabled") {
        out.push({ id: a.id, presetKey: a.preset_key, name: a.name, state: "disabled", stationId: null, currentThread: null, pendingTier: null, approvalId: null, statusLine: "已离任" });
        return;
      }
      const ask = askingBy.get(a.preset_key);
      const celebrating = celebSet.has(a.preset_key) || celebAgentIds.has(a.id);
      /**
       * 优先级（第四/五轮定稿）：blocked > celebrating > asking > working > queued > idle。
       *  - blocked 对 celebrating 保持优先（suite V-06 既有纪律：出事就先显示遇阻，不报喜）；
       *  - celebrating 对 asking 优先（X-05：队列堆积不得压掉刚完成的正反馈，气泡里保留请示与直达号）。
       */
      if (blockedSet.has(a.preset_key)) {
        /**
         * MC-114（M3 联动实测）：pricing-agent 既有近 30 分钟 blocked 事件、又有 pending 审批时，
         * 旧口径只输出 `state=blocked` + pendingTier/approvalId=null —— 楼层上看不到「有单待裁」，
         * 审批直达号也随之丢失（`pendingByTier` 里却有这条审批，面与面自相矛盾）。
         * 现口径：blocked 主态保留（V-06：出事优先显示遇阻），同时并列 asking 信息（信息不丢）。
         */
        const askBlocked = askingBy.get(a.preset_key);
        out.push({
          id: a.id, presetKey: a.preset_key, name: a.name, state: "blocked", stationId: station?.id ?? null,
          currentThread: null,
          pendingTier: askBlocked?.tier ?? null,
          approvalId: askBlocked?.approval_id ?? null,
          ...(askBlocked ? { pendingCount: askBlocked.pending_count } : {}),
          ...(askBlocked ? { asking: true } : {}),
          ...(celebrating ? { celebrating: true } : {}),
          statusLine: askBlocked
            ? `遇阻：${last} · 请示待裁：${askBlocked.action}${askBlocked.pending_count > 1 ? `（共 ${askBlocked.pending_count} 项待裁）` : ""}`
            : `遇阻：${last}`,
        });
        return;
      }
      /**
       * X-05（2026-09-28 实测）：庆祝态被"请示待裁"永久压制——CEO 岗位一旦挂着 pending 审批，
       * asking 恒真，刚完成的任务在楼层上永远看不到正反馈（队列越积越"全员请示无人庆祝"）。
       * 口径改为**共存**：刚完成（近 10 分钟）优先渲染庆祝，同时在气泡里保留请示信息与审批单号，
       * 点击仍能直达审批（不丢信息，也不压正反馈）。
       */
      /**
       * X-05：刚完成（近 10 分钟）与请示共存时**不再互相压制**——
       * 状态仍为 asking（审批必须显眼、可直达、可被门禁断言），另带 celebrating 标志与"刚完成"气泡，
       * 前端据此同时渲染庆祝与举手（既不让队列堆积吃掉正反馈，也不让庆祝淹没待审）。
       */
      if (ask) {
        out.push({
          id: a.id, presetKey: a.preset_key, name: a.name, state: "asking", stationId: station?.id ?? null,
          currentThread: null, pendingTier: ask.tier, approvalId: ask.approval_id,
          pendingCount: ask.pending_count,
          ...(celebrating ? { celebrating: true } : {}),
          statusLine: `${celebrating ? `请示待裁：${ask.action} · 刚完成：${last}` : `请示待裁：${ask.action}`}`
            + (ask.pending_count > 1 ? `（共 ${ask.pending_count} 项待裁）` : ""),
        });
        return;
      }
      if (celebrating) {
        out.push({
          id: a.id, presetKey: a.preset_key, name: a.name, state: "celebrating", stationId: station?.id ?? null,
          currentThread: null, pendingTier: null, approvalId: null, celebrating: true,
          statusLine: `刚完成：${last}`,
        });
        return;
      }
      const run = runningBy.get(a.id);
      if (run) {
        out.push({ id: a.id, presetKey: a.preset_key, name: a.name, state: "working", stationId: station?.id ?? null, currentThread: { id: run.id, title: run.title }, pendingTier: null, approvalId: null, statusLine: run.title });
        return;
      }
      const waiting = queuedBy.get(a.id);
      if (waiting) {
        out.push({ id: a.id, presetKey: a.preset_key, name: a.name, state: "queued", stationId: station?.id ?? null, currentThread: { id: waiting.id, title: waiting.title }, pendingTier: null, approvalId: null, statusLine: `排队中：${waiting.title}` });
        return;
      }
      out.push({ id: a.id, presetKey: a.preset_key, name: a.name, state: "idle", stationId: station?.id ?? null, currentThread: null, pendingTier: null, approvalId: null, statusLine: last ? `最近：${last}` : "待命" });
    });
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** 聚合入口（theater 端点用）：行业场景 + 员工状态一次给齐 */
export async function buildFloor(app: pg.Pool, scope: Scope, industry: string | null | undefined): Promise<FloorPayload> {
  const scene = await resolveFloorScene(industry);
  const agents = await deriveFloor(app, scope, scene);
  return { scene, agents };
}
