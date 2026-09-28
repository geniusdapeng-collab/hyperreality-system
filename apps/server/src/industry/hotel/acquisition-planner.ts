/**
 * 酒店获客行业规划器（QuestPlanner seam 的行业实现）。
 *
 * 为什么需要它：基座确定性规划器只按装配工具生成空参步骤，而围栏的判定条件是
 * 业务参数（R6 `params.rating<=3`、R1 `after.price/before.price`）——缺数据时按 D27
 * 「宁错杀」熔断，于是"差评必审挂起""越线调价上浮"这类获客闭环在演示里根本走不到。
 *
 * 行业规划器的职责：把店长/老板的口语目标翻译成**带业务上下文**的步骤，并且**不猜数据**：
 *   - 能从目标或一店一档（价带、房型、评分）推导的参数才写进步骤；
 *   - 推不出来就省略，让围栏按失败关闭处理（宁可挂起，不可误放）。
 * 参数一旦进入围栏就不可能被模型改写——这里只做确定性直译，不做任何"取巧补数"。
 */
import { planQuest, type AssembledPreset, type QuestPlanner, type QuestStep } from "@workloom/runtime";
import { OFF_PEAK_WINDOW } from "@workloom/shared";

/**
 * 夜班窗口判定（与 trpc 的 inNightWindow / OFF_PEAK_WINDOW 同口径：22:00–08:00，服务器本地时区）。
 *
 * 为什么规划器必须带上这个上下文：围栏规则 R7/R8 的 when 直接读 `context.night_shift`，
 * 而表达式求值器对**缺失路径**是抛错（E2.1 按 block 处理）——不给上下文时，
 * 一次普通的调价会被夜班规则误熔断。这里把可推导的事实显式写进步骤，
 * 让 R7（夜班 ≤3% 自动）/R8（夜班 >3% 挂起）按设计生效。
 */
function inNightWindow(now = new Date()): boolean {
  const start = Number(OFF_PEAK_WINDOW.start.slice(0, 2));
  const end = Number(OFF_PEAK_WINDOW.end.slice(0, 2));
  const hour = now.getHours();
  return start > end ? hour >= start || hour < end : hour >= start && hour < end;
}

/** 一店一档里与获客闭环相关的字段（缺失即视为未建档，相关意图退回通用规划） */
interface PlanningArchive {
  business?: Record<string, unknown>;
  property?: { name?: string; rooms?: number };
  entity_card?: { product_lines?: Array<{ model?: string; name?: string }>; core_selling_points?: string[] };
  content_assets?: { materials?: number };
  conversion_assets?: { coupon_skus?: Array<{ sku?: string; title?: string; stock?: number }> };
  forbidden?: string[];
}

function archiveOf(preset: AssembledPreset): PlanningArchive {
  const essentials = preset.essentials as unknown as { archive?: Record<string, unknown> } | undefined;
  return (essentials?.archive ?? {}) as PlanningArchive;
}

/** 价带中值：一店一档里 [低位, 高位] 的中值（展示层口径，不引入小数噪音） */
function bandMid(band: unknown): number | undefined {
  if (!Array.isArray(band) || band.length !== 2) return undefined;
  const lower = Number(band[0]);
  const upper = Number(band[1]);
  if (!Number.isFinite(lower) || !Number.isFinite(upper)) return undefined;
  return Math.round((lower + upper) / 2);
}

/** 房型词尾最小匹配长度：中文房型词通常 3 字（大床房/双床房/亲子房），太短会跨房型串味 */
const ROOM_SUFFIX_MIN = 3;

interface RoomAnchor {
  /** 命中的价带 key（写进步骤 params，便于追溯用了哪个价带） */
  roomType: string;
  /** 锚点价（命中多个候选时为最低中值，见下） */
  anchor: number;
  /** 是否由"目标点名房型"精确命中（精确命中优先于词尾匹配） */
  exact: boolean;
}

/**
 * 价格锚点解析：目标里到底说的是哪档价。
 *
 * ① 目标直接包含价带 key（"把雅致大床房调到 600"）→ 精确命中，直接用该档；
 * ② 否则按**房型词尾**匹配（"飞猪大床房" → 命中含"大床房"结尾的档位）：口语目标里常见的
 *    是简称或带渠道修辞的说法，要求逐字包含 key 会让绝大部分真实指令取不到价；
 * ③ 命中多档时不猜具体房型，取**最低中值**当锚点：锚点只用于保底价与越带判定，
 *    取最低在涨价方向最容易撞保底价熔断、在降价方向最容易跌破底线——即两个方向都最保守，
 *    绝不会因为取了偏高的锚点而放宽（D27 宁可挂起，不可误放）；
 * ④ 一档都没命中（或价带缺字段）→ 返回空，由调用方省略 before/after，交围栏失败关闭。
 */
function roomAnchorsOf(goal: string, archive: PlanningArchive): RoomAnchor[] {
  const bands = archive.business?.price_bands as Record<string, unknown> | undefined;
  if (!bands) return [];
  const entries = Object.entries(bands)
    .map(([roomType, band]) => ({ roomType, anchor: bandMid(band) }))
    .filter((row): row is { roomType: string; anchor: number } => row.anchor !== undefined);
  if (entries.length === 0) return [];

  const exact = entries.filter((row) => goal.includes(row.roomType));
  if (exact.length > 0) return exact.map((row) => ({ ...row, exact: true }));

  const bySuffix = entries.filter((row) => {
    for (let len = row.roomType.length - 1; len >= ROOM_SUFFIX_MIN; len -= 1) {
      if (goal.includes(row.roomType.slice(-len))) return true;
    }
    return false;
  });
  return bySuffix.map((row) => ({ ...row, exact: false }));
}

/** 锚点选择：精确命中 > 词尾匹配；同档位取最低中值（保守），并给出用到的房型名 */
function priceAnchorOf(goal: string, archive: PlanningArchive): RoomAnchor | undefined {
  const anchors = roomAnchorsOf(goal, archive);
  if (anchors.length === 0) return undefined;
  const exact = anchors.filter((row) => row.exact);
  const pool = exact.length > 0 ? exact : anchors;
  return [...pool].sort((a, b) => a.anchor - b.anchor)[0];
}

/** 调价意图：百分比（"调 5%"）或绝对价（"调到 510"/"¥510"） */
function priceIntentOf(goal: string): { kind: "percent"; pct: number } | { kind: "absolute"; value: number } | null {
  const percent = /([+-]?\d+(?:\.\d+)?)\s*(?:%|个点|个百分点)/.exec(goal);
  if (percent) {
    const pct = Number(percent[1]);
    if (Number.isFinite(pct) && Math.abs(pct) <= 100) return { kind: "percent", pct };
  }
  const absolute = /(?:到|至|为|¥|￥)\s*(\d{2,6}(?:\.\d+)?)/.exec(goal);
  if (absolute) {
    const value = Number(absolute[1]);
    if (Number.isFinite(value) && value > 0) return { kind: "absolute", value };
  }
  return null;
}

/** 评价评分：目标里明说"2 分差评"就用它；只说"差评"按最差一档 2 分处理（宁可送审） */
function ratingOf(goal: string): number {
  const explicit = /([1-5])\s*分/.exec(goal);
  if (explicit) return Number(explicit[1]);
  return 2;
}

function step(input: {
  index: number; action: string; objectType: string; tool: string;
  params?: Record<string, unknown>; objectId?: string;
  before?: unknown; after?: unknown; context?: Record<string, unknown>; label: string;
}): QuestStep {
  return {
    stepId: `s${input.index}`,
    action: input.action,
    objectType: input.objectType,
    tool: input.tool,
    params: input.params ?? {},
    ...(input.objectId ? { objectId: input.objectId } : {}),
    ...(input.before !== undefined ? { before: input.before } : {}),
    ...(input.after !== undefined ? { after: input.after } : {}),
    ...(input.context !== undefined ? { context: input.context } : {}),
    label: input.label,
  };
}

/**
 * 行业规划器入口。未知意图一律交回基座确定性规划（不因为行业化而吞掉通用能力）。
 */
export function acquisitionQuestPlanner(goal: string): QuestPlanner {
  return (_goal, preset) => {
    const tools = new Set(preset.tools.map((tool) => tool.name));
    const archive = archiveOf(preset);

    // ① 口碑：差评回复（R6 差评必审挂起 → 人批 → 续跑）
    if (/(差评|评价|口碑|回复).*(回复|处理|跟进)?/.test(goal) && tools.has("review.reply")) {
      return [
        step({ index: 1, action: "review.list", objectType: "review", tool: "review.list", label: "拉取各渠道新评价" }),
        step({
          index: 2, action: "review.reply", objectType: "review", tool: "review.reply", objectId: "RV-DEMO-01",
          params: {
            review_id: "RV-DEMO-01",
            rating: ratingOf(goal),
            text: "很抱歉给您带来不便，我们已记录并安排专人跟进，欢迎随时联系前台。",
          },
          label: "起草并提交评价回复",
        }),
      ];
    }

    // ② 收益：调价（报价带内 auto / 越带与缺基准 → 围栏失败关闭）
    const priceIntent = priceIntentOf(goal);
    const mentionsPrice = /(调价|涨价|降价|定价|改价|房价|价格|调[到整])/.test(goal);
    if ((priceIntent || mentionsPrice) && tools.has("pms.price.write")) {
      const intent = priceIntent;
      // 锚点只认目标里点到的房型价带（精确 > 词尾，见 roomAnchorsOf）；取不到就不造数
      const matched = priceAnchorOf(goal, archive);
      const roomType = matched?.roomType ?? "主打房型";
      const anchor = matched?.anchor;
      let before: { price: number } | undefined;
      let after: { price: number } | undefined;
      if (intent?.kind === "percent") {
        // 百分比意图必须落在**真实价位**上：围栏除了比值（R1 涨幅 ≤8%），还有绝对价规则
        // （R2 保底价 ¥380）。历史上的 100 归一化基准会让 after.price=102 直接撞保底价熔断，
        // 于是"调 5%"在演示与生产里都跑不成；缺锚点时宁可不给数（交围栏失败关闭）。
        if (anchor !== undefined) {
          before = { price: anchor };
          after = { price: Number((anchor * (1 + intent.pct / 100)).toFixed(2)) };
        }
      } else if (intent?.kind === "absolute" && anchor !== undefined) {
        before = { price: anchor };
        after = { price: intent.value };
      }
      return [
        step({ index: 1, action: "pms.price.read", objectType: "room_price", tool: "pms.price.read", params: { room_type: roomType }, label: `读取${roomType}当前价格` }),
        step({
          index: 2, action: "price.adjust", objectType: "room_price", tool: "pms.price.write", objectId: "OBJ-DLX-01",
          params: { room_type: roomType, ...(intent ? { price: intent.kind === "absolute" ? intent.value : after?.price } : {}) },
          ...(before ? { before } : {}), ...(after ? { after } : {}),
          // 围栏 R3/R7/R8 读 context：channel_new 对"调价"恒为 false（不是新渠道首发），
          // night_shift 由当前时间推导——两键齐备才不会因缺失路径被误熔断（见 inNightWindow 注释）。
          context: { channel_new: false, night_shift: inNightWindow() },
          label: intent ? `提交${roomType}调价` : "提交调价（未识别到目标价位，交围栏失败关闭）",
        }),
      ];
    }

    // ③ 客房履约：送物/维修/清洁（工单类型 + 房间号从目标直译）
    if (/(送|维修|报修|打扫|换床单|加床)/.test(goal) && tools.has("task.dispatch")) {
      const room = /(\d{3,4})\s*(?:房|房间)?/.exec(goal)?.[1];
      const kind = /(维修|报修|坏|故障|漏水|不制冷)/.test(goal) ? "repair" : "delivery";
      return [
        step({
          index: 1, action: "service.ticket.create", objectType: "ticket", tool: "task.dispatch",
          params: { kind, ...(room ? { room } : {}), request: goal.slice(0, 80) },
          label: `${kind === "repair" ? "报修" : "送物"}派单`,
        }),
      ];
    }

    // ④ 巡检：渠道/房价/评价三项只读扫描（只读动作恒 auto，异常进事件与告警）
    if (/(巡检|体检|检查|扫描)/.test(goal) && tools.has("price.scan")) {
      const steps: QuestStep[] = [];
      let index = 1;
      for (const [tool, objectType, label] of [
        ["channel.status.read", "hotel-channel", "渠道状态巡检"],
        ["price.scan", "room_price", "价格/房态扫描"],
        ["review.scan", "review", "新评价扫描"],
      ] as const) {
        if (!tools.has(tool)) continue;
        steps.push(step({ index, action: tool, objectType, tool, label }));
        index += 1;
      }
      if (steps.length > 0) return steps;
    }

    // ⑤ 内容：草稿→发布（发布必审 G9 由围栏把关）
    if (/(内容|文案|种草|短视频|发布)/.test(goal) && tools.has("content.draft")) {
      const steps: QuestStep[] = [
        step({ index: 1, action: "content.draft", objectType: "content", tool: "content.draft", params: { brief: goal.slice(0, 120) }, label: "生成内容草稿" }),
      ];
      if (tools.has("content.publish")) {
        steps.push(step({ index: 2, action: "content.publish", objectType: "content", tool: "content.publish", params: { brief: goal.slice(0, 120) }, label: "提交发布（公网外发必审）" }));
      }
      return steps;
    }

    /**
     * ⑥ 视觉：生图/海报/配图 → 直连视觉工位的 AI 生图工具（Ark seedream）。
     *
     * 2026-09-20 真机修复：LLM 规划器对视觉目标会给出**空参步骤**（compose 缺 recipe、
     * render 缺 project…），桥侧一律 bad_request，等于"派了活但出不了图"。
     * 这里做确定性直译：把整句规格作为 prompt 交给 `visualwrite.generate`，
     * 由视觉工位产出成品图并回 sha256 回执；出图即完成，围栏/回执语义不变。
     */
    if (/(海报|配图|封面|生图|出图|主视觉|图片|素材图|生成.{0,12}图|画一?[张幅].{0,12}图|做一?[张幅].{0,12}图)/.test(goal) && tools.has("visualwrite.generate")) {
      return [
        step({
          index: 1,
          action: "visualwrite.generate",
          objectType: "visual_asset",
          tool: "visualwrite.generate",
          params: { prompt: goal.slice(0, 1200) },
          label: "按规格生成主视觉（AI 生图）",
        }),
      ];
    }

    // 未知意图：交回基座确定性规划（行业化不吞通用能力）
    return planQuest(goal, preset);
  };
}
