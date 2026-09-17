'use strict';

/**
 * A3 CompetitorScout — 竞品侦察员
 * ------------------------------------------------------------
 * 职责：搞清楚"我们在跟谁抢注意力，他们哪句话说透了，哪句没说透"。
 * 三段侦察：
 *   1. 发现：同品类 + 同价格带的直接竞品（默认封顶 3 个，防档案臃肿）
 *   2. 画像：每个竞品的价格带/卖点/视觉打法/爆款内容套路
 *   3. 空位：差异化分析 —— 我们的点里竞品没讲的（our_opening），
 *      和竞品全在讲的（crowded_points，硬碰硬是下策）
 *
 * 工作方式：
 *   plan(input)   → 产出《侦察任务书》：发现查询 + 单竞品画像查询模板
 *   distill(raw)  → 竞品归一化 → 相关性排序 → 空位计算
 *
 * 反虚构纪律：
 *   - 竞品卖点/价格无来源不回填
 *   - 爆款套路必须基于看到的真实内容归纳，标注样本量
 */

/** 价格带中点估算（用于价格 proximity 排序） */
function _priceMid(band) {
  const nums = String(band || '').match(/\d+(\.\d+)?/g);
  if (!nums || nums.length === 0) return null;
  const vals = nums.map(Number);
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

class CompetitorScout {
  constructor(opts = {}) {
    this.agentName = 'CompetitorScout';
    this.cap = Number(opts.cap) > 0 ? Number(opts.cap) : 3; // 竞品数量上限
  }

  /**
   * 产出《侦察任务书》
   * @param {object} input { name, category, price_band?, sellingPointCandidates? }
   */
  plan(input = {}) {
    if (!input.name || !input.category) throw new Error('[A3] 缺商品名或类目');
    const cat = input.category;
    const priceHint = input.price_band ? ` ${input.price_band}价位` : '';

    return {
      stage: 'A3_SCOUT',
      agent: this.agentName,
      competitor_cap: this.cap,
      discovery_queries: [
        { q: `${cat} 排行榜 热销 ${priceHint}`.trim(), intent: 'ranking', channel: '电商榜单' },
        { q: `${cat} 哪个牌子好 知乎`, intent: 'brand_compare', channel: '知乎' },
        { q: `${cat} 测评 对比 ${input.name}`, intent: 'head_to_head', channel: '评测媒体/社媒' },
        { q: `${cat} 推荐 小红书 ${priceHint}`.trim(), intent: 'ugc_recommend', channel: '小红书' }
      ],
      profile_template: {
        per_competitor_queries: [
          { q: '{竞品名} 价格 旗舰店', intent: 'comp_price' },
          { q: '{竞品名} 卖点 主打', intent: 'comp_points' },
          { q: '{竞品名} 广告 短视频 抖音', intent: 'comp_ads' },
          { q: '{竞品名} 差评 缺点', intent: 'comp_weakness' }
        ],
        fillback_format: {
          competitors: '[{ name, price_band?, price_source_url?, selling_points: [{point, source_url}], visual_style?, visual_source_url?, viral_patterns: [{pattern, sample_count, source_url}], weakness_notes? }]'
        }
      },
      selection_rule: [
        `只保留直接竞品（同品类且价格带重叠），间接替代品写入 adjacent_notes 不进 competitors`,
        `数量封顶 ${this.cap} 个，按"品类贴合度 + 价格重叠度 + 证据充分度"排序`,
        '每个竞品至少一条带来源的卖点才允许入列'
      ],
      discipline: [
        '竞品的差评同样是宝：它的弱点就是我们的攻击面，如实记录并带来源',
        '视觉打法描述必须基于真实看到的物料（主图风格/视频套路/花字用法），禁止臆测'
      ]
    };
  }

  /**
   * 归一化竞品数据 + 空位计算
   * @param {object} raw { competitors: [...], adjacent_notes? }
   * @param {object} ctx { input: { sellingPointCandidates?: [] }, ledger }
   */
  distill(raw = {}, ctx = {}) {
    const { input = {}, ledger } = ctx;
    const gaps = [];
    const ourPoints = Array.isArray(input.sellingPointCandidates) ? input.sellingPointCandidates : [];
    const ourMid = _priceMid(input.price_band);

    const cards = [];
    // 【修复 Bug4】回填键校验：契约外键名进 gaps，禁止静默丢弃
    // （如把 weakness_notes 误写为 weaknesses 时，弱点数据此前会零告警丢失）
    const KNOWN_KEYS = new Set([
      'name', 'category', 'price_band', 'price_source_url', 'selling_points',
      'visual_style', 'visual_source_url', 'viral_patterns', 'weakness_notes', 'adjacent_notes'
    ]);
    for (const c of Array.isArray(raw.competitors) ? raw.competitors : []) {
      if (!c) continue;
      const unknown = Object.keys(c).filter(k => !KNOWN_KEYS.has(k));
      if (unknown.length) {
        gaps.push(
          `竞品"${c.name || '未命名'}"回填含契约外键 ${unknown.join('/')}，内容已被忽略` +
          `——请对照 fillback_format 核对键名（弱点字段契约键为 weakness_notes，字符串）`
        );
      }
    }
    for (const c of Array.isArray(raw.competitors) ? raw.competitors : []) {
      if (!c || !c.name) continue;

      // 卖点：无源剔除
      const points = [];
      const pointRefs = [];
      for (const p of Array.isArray(c.selling_points) ? c.selling_points : []) {
        const point = typeof p === 'string' ? p : p?.point;
        const url = typeof p === 'object' ? p?.source_url : null;
        if (!point) continue;
        if (url && ledger) {
          const ref = ledger.register({ claimRef: `competitors.${c.name}.selling_points:${point}`, sourceUrl: url, channel: p.channel || '', agent: this.agentName });
          points.push(point); pointRefs.push(ref);
        }
      }
      if (points.length === 0) continue; // 无源卖点即出局（selection_rule）

      if (ledger && c.price_source_url) {
        ledger.register({ claimRef: `competitors.${c.name}.price_band`, sourceUrl: c.price_source_url, agent: this.agentName });
      }
      if (ledger && c.visual_source_url) {
        ledger.register({ claimRef: `competitors.${c.name}.visual_style`, sourceUrl: c.visual_source_url, agent: this.agentName });
      }

      const viralPatterns = (Array.isArray(c.viral_patterns) ? c.viral_patterns : [])
        .filter(v => v && v.pattern)
        .map(v => ({
          pattern: v.pattern,
          sample_count: Number(v.sample_count) || 1,
          source_refs: ledger && v.source_url
            ? [ledger.register({ claimRef: `competitors.${c.name}.viral:${v.pattern}`, sourceUrl: v.source_url, agent: this.agentName })]
            : []
        }));

      // 相关性评分：品类贴合（同名类目词）+ 价格重叠 + 证据量
      let relevance = 0;
      if (input.category && String(c.category || c.name).includes(String(input.category).slice(0, 2))) relevance += 2;
      const compMid = _priceMid(c.price_band);
      if (ourMid != null && compMid != null) {
        const ratio = Math.abs(compMid - ourMid) / ourMid;
        if (ratio <= 0.3) relevance += 3; else if (ratio <= 0.6) relevance += 1;
      }
      relevance += Math.min(points.length, 3) + Math.min(viralPatterns.length, 2);

      cards.push({
        name: c.name,
        price_band: c.price_band || '',
        selling_points: points,
        visual_style: c.visual_style || '',
        viral_patterns: viralPatterns,
        weakness_notes: c.weakness_notes || '',
        source_refs: pointRefs,
        _relevance: relevance
      });
    }

    cards.sort((a, b) => b._relevance - a._relevance);
    const competitors = cards.slice(0, this.cap).map(({ _relevance, ...rest }) => rest);
    if ((raw.competitors || []).length > this.cap) {
      gaps.push(`竞品候选 ${raw.competitors.length} 个，按相关性截断至 ${this.cap} 个`);
    }
    if (competitors.length === 0) gaps.push('无有效竞品入列（缺带来源的卖点）');

    // ===== 空位计算 =====
    const competitorPointText = competitors.flatMap(c => c.selling_points).join('|');
    const our_opening = ourPoints.filter(p => !competitorPointText.includes(p));
    const crowded_points = ourPoints.filter(p => competitorPointText.includes(p));

    // 竞品弱点 = 我们的攻击面（挂到空位里）
    const weaknessOpenings = competitors
      .filter(c => c.weakness_notes)
      .map(c => ({ competitor: c.name, weakness: c.weakness_notes }));

    return {
      competitors,
      adjacent_notes: raw.adjacent_notes || [],
      differentiation: {
        our_opening,
        crowded_points,
        weakness_openings: weaknessOpenings
      },
      gaps
    };
  }
}

module.exports = { CompetitorScout };
