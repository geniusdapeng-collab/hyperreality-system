'use strict';

/**
 * SummaryCards — 下游消费摘要卡生成器
 * ------------------------------------------------------------
 * 核心设计：各环节只拿切片，不读全档。
 * 六张卡，每张对应一个下游消费方的最小必要情报面：
 *   brief_card        → MarketingBriefParser：自动回填 Brief
 *   theme_card        → CreativeThemeGenerator：主题创意的事实底座
 *   insight_card      → RequirementDiscoveryEngine：洞察的证据锚点
 *   prd_card          → PRDGenerator：卖点→镜头映射依据
 *   portrait_manifest → ProductPortraitBranch：搜图交接（免重复检索）
 *   router_material   → MarketingSkillRouter：钩子选型素材
 *
 * 卡片纪律：
 *   - inferred 级条目不进入任何卡片
 *   - 卡片只承载"结论 + 证据强度"，完整溯源回档案查证
 *   - 卡片体积受控（每类条目封顶），防止情报过载冲垮下游上下文
 */

const CARD_LIMITS = {
  selling_points: 3,
  praise: 5,
  pain: 5,
  verbatim: 6,
  scenarios: 4,
  competitors: 3,
  data_points: 5,
  conflicts: 5,
  questions: 5
};

function _usable(item) {
  return item && (item.confidence === 'confirmed' || item.confidence === 'reported');
}

/** Brief 摘要卡：MarketingBriefParser 自动回填依据 */
function makeBriefCard(dossier) {
  const d = dossier;
  // 卖点优先级：用户共识 confirmed > 官方主打 confirmed > 用户共识 reported
  const userPros = (d.pros_cons.pros || []).filter(p => p.claim_nature !== 'official' && _usable(p));
  const officialPros = (d.pros_cons.pros || []).filter(p => p.claim_nature === 'official' && p.confidence === 'confirmed');
  const ranked = [...userPros.sort((a, b) => (b.mentions || 0) - (a.mentions || 0)), ...officialPros];
  const sellingPoints = [];
  for (const p of ranked) {
    const text = p.claim_nature === 'official'
      ? (p.point.match(/「(.+?)」/) || [])[1] || p.point
      : p.aspect && p.aspect !== 'official_claim' ? p.aspect : p.point;
    if (!sellingPoints.includes(text)) sellingPoints.push(text);
    if (sellingPoints.length >= CARD_LIMITS.selling_points) break;
  }

  const topScenario = (d.usage.scenarios || [])[0];
  const topCompetitor = (d.competitors || [])[0];

  return {
    card: 'brief_card',
    product: d.identity.name,
    category: d.identity.category,
    sellingPoints,
    audience: topScenario ? `${topScenario.persona}${topScenario.scene ? `（${topScenario.scene}）` : ''}` : undefined,
    competitor: topCompetitor ? topCompetitor.name : undefined,
    productHero: d.visual_assets.hero_image_id ? { heroImageId: d.visual_assets.hero_image_id } : undefined,
    evidence_note: `卖点来自 ${userPros.length} 条用户共识 + ${officialPros.length} 条官方确认主张，完整溯源见档案 ${d.product_id}`
  };
}

/** 主题摘要卡：创意主题的事实底座 */
function makeThemeCard(dossier) {
  const d = dossier;
  return {
    card: 'theme_card',
    product: d.identity.name,
    category: d.identity.category,
    emotional_anchors: (d.voice_of_customer.praise_points || []).filter(_usable).slice(0, 3).map(p => p.aspect),
    avoid_pits: (d.voice_of_customer.pain_points || []).filter(_usable).slice(0, 3).map(p => ({
      aspect: p.aspect, root_cause: p.root_cause
    })),
    differentiation_space: d.differentiation.our_opening || [],
    crowded_space: d.differentiation.crowded_points || [],
    top_scenarios: (d.usage.scenarios || []).slice(0, CARD_LIMITS.scenarios),
    verbatim_spark: (d.voice_of_customer.verbatim || []).slice(0, 3).map(v => v.text)
  };
}

/** 洞察摘要卡：需求洞察的证据锚点 */
function makeInsightCard(dossier) {
  const d = dossier;
  return {
    card: 'insight_card',
    product: d.identity.name,
    audience_profile: (d.usage.scenarios || []).slice(0, CARD_LIMITS.scenarios).map(s => ({
      persona: s.persona, scene: s.scene, moment: s.moment, mentions: s.mentions
    })),
    consensus_points: (d.pros_cons.pros || []).filter(_usable).slice(0, CARD_LIMITS.praise).map(p => ({
      point: p.point, confidence: p.confidence, mentions: p.mentions
    })),
    complaint_map: (d.pros_cons.cons || []).filter(_usable).slice(0, CARD_LIMITS.pain).map(c => ({
      point: c.point, root_cause: c.root_cause, confidence: c.confidence, mentions: c.mentions
    })),
    market_position: {
      price_band: d.identity.price_band,
      price_confidence: d.identity.price_confidence || 'unknown',
      our_opening: d.differentiation.our_opening,
      crowded_points: d.differentiation.crowded_points
    },
    competitor_briefs: (d.competitors || []).slice(0, CARD_LIMITS.competitors).map(c => ({
      name: c.name, price_band: c.price_band, selling_points: c.selling_points, weakness: c.weakness_notes || ''
    }))
  };
}

/** PRD 摘要卡：卖点→镜头映射依据 */
function makePrdCard(dossier) {
  const d = dossier;
  return {
    card: 'prd_card',
    product: d.identity.name,
    demo_scenes: (d.usage.scenarios || []).slice(0, CARD_LIMITS.scenarios).map(s => ({
      scene: s.scene || s.moment, persona: s.persona, mentions: s.mentions,
      suggest_fn: 'demo' // 演示节拍的场景来源
    })),
    selling_point_evidence: (d.pros_cons.pros || []).filter(_usable).slice(0, CARD_LIMITS.praise).map(p => ({
      point: p.point, nature: p.claim_nature || 'user', confidence: p.confidence
    })),
    compliance_redlines: (d.pros_cons.cons || []).filter(_usable).map(c =>
      `不得宣称与「${c.aspect}」相关的绝对化优势（用户有真实吐槽，宣称即翻车）`
    ),
    hook_candidates: {
      data_points: (d.hook_material.data_points || []).slice(0, CARD_LIMITS.data_points),
      conflicts: (d.hook_material.conflicts || []).slice(0, CARD_LIMITS.conflicts),
      questions: (d.hook_material.questions || []).slice(0, CARD_LIMITS.questions)
    }
  };
}

/** 定妆照图档 manifest：ProductPortraitBranch 搜图交接 */
function makePortraitManifest(dossier) {
  const d = dossier;
  return {
    card: 'portrait_manifest',
    product_id: d.product_id,
    product_name: d.identity.name,
    hero_image_id: d.visual_assets.hero_image_id,
    needs_more_reference: d.visual_assets.needs_more_reference,
    reference_images: (d.visual_assets.images || []).map(img => ({
      id: img.id, url: img.url, source: img.source, angle: img.angle,
      license_risk: img.license_risk, fetched_at: img.fetched_at
    })),
    handoff_note: '情报档案预填参考图，定妆照分支免重复检索；执行方仅需核对图片真实性与型号一致性'
  };
}

/** 技能路由素材卡：MarketingSkillRouter 钩子选型 */
function makeRouterMaterial(dossier) {
  const d = dossier;
  return {
    card: 'router_material',
    category: d.identity.category,
    product_kind: /服务|课程|培训|咨询|软件|SaaS|APP|App/.test(String(d.identity.category || '')) ? 'service' : 'physical',
    hook_material: {
      data_points: (d.hook_material.data_points || []).slice(0, CARD_LIMITS.data_points),
      conflicts: (d.hook_material.conflicts || []).slice(0, CARD_LIMITS.conflicts),
      questions: (d.hook_material.questions || []).slice(0, CARD_LIMITS.questions)
    },
    style_hints: {
      has_strong_data: (d.hook_material.data_points || []).length > 0,
      has_conflict: (d.hook_material.conflicts || []).length > 0,
      has_question: (d.hook_material.questions || []).length > 0
    }
  };
}

function makeAllCards(dossier) {
  return {
    brief_card: makeBriefCard(dossier),
    theme_card: makeThemeCard(dossier),
    insight_card: makeInsightCard(dossier),
    prd_card: makePrdCard(dossier),
    portrait_manifest: makePortraitManifest(dossier),
    router_material: makeRouterMaterial(dossier)
  };
}

module.exports = { makeAllCards, makeBriefCard, makeThemeCard, makeInsightCard, makePrdCard, makePortraitManifest, makeRouterMaterial, CARD_LIMITS };
