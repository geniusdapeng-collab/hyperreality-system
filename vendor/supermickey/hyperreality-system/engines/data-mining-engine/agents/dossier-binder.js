'use strict';

/**
 * A5 DossierBinder — 档案装订员
 * ------------------------------------------------------------
 * 职责：把验证过的数据装订成《商品情报档案》，落盘沉淀，
 * 并为下游各环节裁剪摘要卡。
 * 三道工序：
 *   1. 钩子原料预制（hook_material）：把情报翻译成营销钩子素材
 *      - data_points：规格/价格里能做"数据式钩子"的硬数字
 *      - conflicts：  用户吐槽 vs 官方宣称的反差、竞品弱点
 *      - questions：  痛点转译成的疑问式钩子种子
 *   2. 装订：按 Schema 组装 → 强校验 → 失败即拒收（宁缺毋滥）
 *   3. 分发：六张摘要卡 + 落盘 + 索引登记
 */

const DossierSchema = require('../contracts/dossier-schema');
const SummaryCards = require('../contracts/summary-cards');

class DossierBinder {
  constructor(opts = {}) {
    this.agentName = 'DossierBinder';
    this.store = opts.store; // DossierStore 实例（可选，缺省不落盘只返回）
  }

  /**
   * @param {object} input
   * @param {string} input.productId
   * @param {object} input.verified   A4 的 verified 数据包
   * @param {object} input.pros       A4 签发优点
   * @param {object} input.cons       A4 签发缺点
   * @param {object} input.visual     A1 的 image_candidates/hero/needs_more
   * @param {object} input.ledger     EvidenceLedger
   * @param {object} input.reviewMeta A2 的样本信息 { review_count, cleaned }
   * @returns {{dossier, cards, saved?, validation}}
   */
  bind(input = {}) {
    const { productId, verified = {}, pros = [], cons = [], visual = {}, ledger, reviewMeta = {} } = input;
    if (!productId) throw new Error('[A5] 缺 productId');

    const dossier = DossierSchema.emptyDossier(productId);
    dossier.built_at = new Date().toISOString();

    // ===== 身份与图档 =====
    Object.assign(dossier.identity, verified.identity || {});
    dossier.visual_assets = {
      hero_image_id: visual.hero_image_id || null,
      images: (visual.image_candidates || []).map(img => ({
        id: img.id, url: img.url, source: img.source, angle: img.angle,
        license_risk: img.license_risk, fetched_at: img.fetched_at
      })),
      needs_more_reference: Boolean(visual.needs_more_reference)
    };

    // ===== 使用情况 =====
    dossier.usage = {
      scenarios: verified.scenarios || [],
      frequency_notes: reviewMeta.review_count
        ? [`评价样本 ${reviewMeta.review_count} 条（清洗：水军 ${reviewMeta.cleaned?.spam_removed || 0} / 重复 ${reviewMeta.cleaned?.duplicate_removed || 0}）`]
        : []
    };

    // ===== VOC =====
    dossier.voice_of_customer = {
      praise_points: (verified.praise_points || []).map(p => ({ ...p, sources: undefined })),
      pain_points: (verified.pain_points || []).map(p => ({ ...p, sources: undefined })),
      verbatim: verified.verbatim || []
    };

    // ===== 优缺点 =====
    dossier.pros_cons = { pros, cons };

    // ===== 竞品 =====
    dossier.competitors = verified.competitors || [];
    dossier.differentiation = {
      our_opening: verified.differentiation?.our_opening || [],
      crowded_points: verified.differentiation?.crowded_points || [],
      weakness_openings: verified.differentiation?.weakness_openings || []
    };

    // ===== 钩子原料预制 =====
    dossier.hook_material = this._buildHookMaterial(dossier);

    // ===== 溯源与缺口 =====
    dossier.provenance = ledger ? ledger.export() : [];
    dossier.gaps = input.gaps || [];

    // ===== 校验 =====
    const validation = DossierSchema.validate(dossier);
    if (!validation.ok) {
      const err = new Error(`[A5] 档案校验失败，拒绝装订：${validation.issues.join('；')}`);
      err.validation = validation;
      throw err;
    }

    // ===== 摘要卡 =====
    const cards = SummaryCards.makeAllCards(dossier);

    // ===== 落盘 =====
    let saved = null;
    if (this.store) saved = this.store.save(dossier);

    return { dossier, cards, saved, validation };
  }

  /** 钩子原料：把情报翻译成钩子 */
  _buildHookMaterial(dossier) {
    const data_points = [];
    const conflicts = [];
    const questions = [];

    // 数据式：规格硬数字 + 价格锚点
    for (const [k, v] of Object.entries(dossier.identity.specs || {})) {
      if (/\d/.test(String(v))) data_points.push(`${k}：${v}`);
      if (data_points.length >= 4) break;
    }
    if (dossier.identity.price_band) data_points.push(`价格带：${dossier.identity.price_band}`);

    // 冲突式：官方宣称 vs 用户吐槽（同方面即反差炸弹）
    for (const pro of dossier.pros_cons.pros) {
      if (pro.claim_nature !== 'official') continue;
      const clash = dossier.pros_cons.cons.find(c =>
        pro.point.includes(c.aspect) || (c.quote && pro.point.includes(c.aspect)));
      if (clash) {
        conflicts.push(`官方主打「${pro.point}」 vs 用户吐槽「${clash.point}」（${clash.mentions} 次提及）—— 正面回应即爆点，回避即翻车`);
      }
    }
    // 竞品弱点反差
    for (const w of dossier.differentiation.weakness_openings || []) {
      conflicts.push(`竞品「${w.competitor}」弱点：${w.weakness} —— 对比测评的天然弹药`);
    }

    // 疑问式：痛点转译
    for (const c of dossier.pros_cons.cons.slice(0, 4)) {
      questions.push(`为什么那么多人在乎「${c.aspect}」？（${c.mentions} 条真实评价提及）`);
    }
    for (const s of (dossier.usage.scenarios || []).slice(0, 2)) {
      if (s.scene) questions.push(`${s.persona}在${s.scene}最怕什么？`);
    }

    return {
      data_points: [...new Set(data_points)],
      conflicts: [...new Set(conflicts)],
      questions: [...new Set(questions)]
    };
  }
}

module.exports = { DossierBinder };
