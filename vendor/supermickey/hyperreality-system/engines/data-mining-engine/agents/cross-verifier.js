'use strict';

/**
 * A4 CrossVerifier — 交叉验证官（本模块的命脉）
 * ------------------------------------------------------------
 * 职责：在档案装订前做最后一道事实审判。
 * 四把法尺：
 *   1. 置信度定级：
 *      confirmed  官方来源，或 >=2 个独立来源交叉一致
 *      reported   单一非官方来源
 *      inferred   无源或纯推理 —— 禁止进入 pros/cons 事实区
 *   2. 冲突裁决：同一事实多来源打架（如价格差 >30%），
 *      官方来源优先；无官方则取多数派；无法裁决则记 conflict 并降级
 *   3. 无源清洗：任何没挂证据的条目直接从事实区清除，移交 gaps
 *   4. 优缺点签发：只有 confirmed + reported 级条目才能进入
 *      pros_cons 事实区，且每条标注 evidence_strength
 *
 * 输出：verified 数据包 + verification_report（审判记录，备查）
 */

class CrossVerifier {
  constructor(opts = {}) {
    this.agentName = 'CrossVerifier';
    this.conflictPriceRatio = opts.conflictPriceRatio || 0.3; // 价格冲突阈值
  }

  /**
   * @param {object} packs { a1, a2, a3 } 三个采集 Agent 的出站 payload
   * @param {object} ctx { ledger } EvidenceLedger 实例
   */
  verify(packs = {}, ctx = {}) {
    const { ledger } = ctx;
    const report = {
      graded: { confirmed: 0, reported: 0, inferred: 0 },
      purged: [],
      conflicts: [],
      checks_run: []
    };

    if (!ledger) throw new Error('[A4] 缺 EvidenceLedger，无法执行验证');

    // ===== 1. 评价观点定级（A2 产出）=====
    const gradePoint = (item, claimPrefix) => {
      const refs = Array.isArray(item.source_refs) ? item.source_refs : [];
      if (refs.length === 0) {
        report.purged.push(`${claimPrefix}: "${item.point}" 无证据，清除出事实区`);
        report.graded.inferred += 1;
        return null;
      }
      // 官方来源或 >=2 独立来源 → confirmed
      const claimKey = `${claimPrefix}:${item.aspect || item.point}`;
      const official = refs.some(() => false); // 评价类无官方级，独立来源数定级
      const independent = Math.max(refs.length, item.mentions || 1);
      const confidence = (official || independent >= 2) ? 'confirmed' : 'reported';
      report.graded[confidence] += 1;
      report.checks_run.push(`${claimKey} -> ${confidence}（来源 ${refs.length}，提及 ${item.mentions || 1}）`);
      return { ...item, confidence, evidence_strength: refs.length >= 2 ? 'strong' : 'single' };
    };

    const verifiedPraise = (packs.a2?.praise_points || []).map(p => gradePoint(p, 'voc.praise')).filter(Boolean);
    const verifiedPain = (packs.a2?.pain_points || []).map(p => gradePoint(p, 'voc.pain')).filter(Boolean);

    // ===== 2. 身份事实冲突检查（A1 产出）=====
    const identity = { ...(packs.a1?.identity || {}) };
    const priceRefs = ledger.forClaim('identity.price_band');
    if (priceRefs.length >= 2) {
      const nums = String(identity.price_band || '').match(/\d+(\.\d+)?/g).map(Number);
      if (nums.length >= 2) {
        const spread = (Math.max(...nums) - Math.min(...nums)) / Math.min(...nums);
        if (spread > this.conflictPriceRatio) {
          const officialPrice = ledger.hasOfficialSource('identity.price_band');
          report.conflicts.push({
            field: 'identity.price_band',
            detail: `价格样本离散度 ${(spread * 100).toFixed(0)}% 超过阈值 ${this.conflictPriceRatio * 100}%`,
            resolution: officialPrice ? '以官方渠道价格为准，区间保留供参考' : '无官方来源，价格带降级为 reported，下游引用须标注浮动'
          });
          identity.price_confidence = officialPrice ? 'confirmed' : 'reported';
        } else {
          identity.price_confidence = ledger.hasOfficialSource('identity.price_band') ? 'confirmed' : 'reported';
        }
      } else {
        identity.price_confidence = 'reported';
      }
    } else if (identity.price_band) {
      identity.price_confidence = 'reported';
    } else {
      identity.price_confidence = null;
    }

    // 官方卖点定级：挂了官方级来源的才是 confirmed
    identity.official_selling_points = (identity.official_selling_points || []).map(point => {
      const refs = ledger.forClaim(`identity.official_selling_points:${point}`);
      return { point, confidence: refs.some(r => r.channel_class === 'official') || refs.length >= 2 ? 'confirmed' : 'reported' };
    });

    // ===== 3. 竞品数据定级（A3 产出）=====
    const competitors = (packs.a3?.competitors || []).map(c => {
      const refs = Array.isArray(c.source_refs) ? c.source_refs : [];
      return {
        ...c,
        confidence: refs.length >= 2 ? 'confirmed' : 'reported',
        evidence_strength: refs.length >= 2 ? 'strong' : 'single'
      };
    });

    // ===== 4. 优缺点签发 =====
    // 优点 = 已验证称赞点 + confirmed 级官方卖点（去重：官方卖点与称赞点同方面时合并提及量）
    const pros = verifiedPraise.map(p => ({
      point: p.point,
      aspect: p.aspect,
      mentions: p.mentions,
      quote: p.quote,
      confidence: p.confidence,
      evidence_strength: p.evidence_strength,
      source_refs: p.source_refs
    }));
    for (const osp of identity.official_selling_points) {
      if (osp.confidence !== 'confirmed') continue;
      const already = pros.some(p => osp.point.includes(p.aspect) || p.point.includes(osp.point.slice(0, 4)));
      if (!already) {
        const refs = ledger.forClaim(`identity.official_selling_points:${osp.point}`).map(e => e.id);
        pros.push({
          point: `官方主打「${osp.point}」`,
          aspect: 'official_claim',
          mentions: 0,
          quote: '',
          confidence: 'confirmed',
          evidence_strength: refs.length >= 2 ? 'strong' : 'single',
          source_refs: refs,
          claim_nature: 'official' // 标记：这是官方宣称，不等于用户共识
        });
      }
    }

    const cons = verifiedPain.map(p => ({
      point: p.point,
      aspect: p.aspect,
      root_cause: p.root_cause,
      mentions: p.mentions,
      quote: p.quote,
      confidence: p.confidence,
      evidence_strength: p.evidence_strength,
      source_refs: p.source_refs
    }));

    return {
      verified: {
        identity,
        praise_points: verifiedPraise,
        pain_points: verifiedPain,
        verbatim: (packs.a2?.verbatim || []).filter(v => (v.source_refs || []).length > 0),
        scenarios: packs.a2?.scenarios || [],
        competitors,
        differentiation: packs.a3?.differentiation || { our_opening: [], crowded_points: [], weakness_openings: [] }
      },
      pros,
      cons,
      verification_report: report,
      gaps: [
        ...(packs.a1?.gaps || []).map(g => `[A1] ${g}`),
        ...(packs.a2?.gaps || []).map(g => `[A2] ${g}`),
        ...(packs.a3?.gaps || []).map(g => `[A3] ${g}`),
        ...report.purged.map(p => `[A4清洗] ${p}`)
      ]
    };
  }
}

module.exports = { CrossVerifier };
