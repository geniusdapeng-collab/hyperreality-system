/**
 * 派活岗位路由（N-14，2026-09-28 真机实证）。
 *
 * 问题：`resolveDispatchPresetKey` 原先只按 **Bundle 清单顺序**取第一个 kind=orchestrator 的就绪岗位——
 * geo-growth 的 presets 列表里 `production-planner`（视频生产编排员）排在 `growth-lead` 之前，
 * 于是"统计渠道线索并做复盘"这类增长任务被派给视频工装的岗位：
 * 工装工具（shot.decompose/shootlist.emit/ai_task.emit）与任务语义无关，交付物必然错位。
 *
 * 口径：先按**任务语义**做确定性匹配（视觉/视频/增长/发布四类通用能力域），
 * 未命中再落行业默认指挥岗位；都取不到时由调用方回落到 Bundle 顺序 → 指挥层兜底 → 任意就绪员工。
 * 本表运行在部署层（apps/server），行业词不进底座（D18）。
 */

export interface DispatchRoutingInput {
  goal: string;
  industry?: string | null;
}

interface RoutingRule {
  id: string;
  /** 任务语义匹配（口语说法覆盖） */
  match: RegExp;
  /** 优先岗位（按序取第一个就绪项） */
  presets: string[];
}

/**
 * 通用能力域 → 岗位偏好。顺序即优先级：越具体的域越靠前
 * （例如"生成视频封面图"同时含"视频"和"封面"，按视觉域处理更贴合真实交付物）。
 */
const RULES: RoutingRule[] = [
  {
    id: "visual",
    match: /海报|配图|封面|生图|出图|主视觉|素材图|图片|生成.{0,12}图|画一?[张幅].{0,12}图|做一?[张幅].{0,12}图/,
    presets: ["visual-designer", "cover-designer", "cro-designer"],
  },
  {
    id: "video",
    match: /视频|短片|成片|影片|分镜|镜头|口播|剪辑|宣传片|TVC|纪录片|混剪|配乐|调色|字幕/,
    presets: ["director", "production-planner", "scriptwriter", "explainer-director"],
  },
  {
    id: "publish",
    match: /发布|外发|分发|投放|加投|上架|群发|铺量/,
    presets: ["publish-operator", "source-distributor", "distribution-operator"],
  },
  {
    /**
     * N-13（第三轮实测）验收项：「把雅致大床房调价到 510 元」必须落到持有 pms.price.write 的定价岗位，
     * 而不是 orchestrator 的晨报工具——价格/库存/券务类目标走定价与券务岗位。
     */
    id: "pricing",
    match: /调价|定价|改价|价格|房价|报价|折扣|优惠|券|库存|房态|保底价/,
    presets: ["pricing-agent", "coupon-operator", "revenue-manager", "ads-optimizer"],
  },
  {
    id: "service-ops",
    match: /报修|维修|派单|送物|清洁|打扫|客房|入住|退房|前台|接听|工单/,
    presets: ["frontdesk-agent", "housekeeper-agent", "ai-receptionist", "phone-agent"],
  },
  {
    id: "growth",
    match: /增长|复盘|预算|投放|线索|转化|渠道|获客|ROI|CAC|漏斗|实验|内容规划|选题|能见度|GEO|排名|信源/,
    presets: ["growth-lead", "growth-strategist", "data-board-officer"],
  },
];

/** 行业默认指挥岗位（Bundle 清单顺序缺省时使用；hotel 保持原"清单顺序"行为，不在此表内） */
const INDUSTRY_DEFAULTS: Record<string, string[]> = {
  "geo-growth": ["growth-lead", "growth-strategist"],
  "ai-video": ["director", "production-planner"],
  // hotel：默认指挥岗位不放生产编排（那是 ai-video 依赖包带来的视频岗），走公司与增长负责人
  hotel: ["company-ceo", "growth-lead"],
};

/** 返回按优先级排序的候选岗位（纯函数，便于单测与复盘"为什么派给了谁"） */
export function preferredDispatchPresets(input: DispatchRoutingInput): string[] {
  const goal = input.goal ?? "";
  const out: string[] = [];
  const push = (key: string) => { if (key && !out.includes(key)) out.push(key); };
  for (const rule of RULES) {
    if (rule.match.test(goal)) rule.presets.forEach(push);
  }
  for (const key of INDUSTRY_DEFAULTS[input.industry ?? ""] ?? []) push(key);
  return out;
}
