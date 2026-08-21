'use strict';

/**
 * A2 ReviewMiner — 用户评价矿工
 * ------------------------------------------------------------
 * 职责：从真实用户评价里挖出营销弹药与避坑地图。
 * 四层矿脉：
 *   1. 称赞点（praise_points）：用户真实夸什么 —— 卖点校准器
 *   2. 吐槽点（pain_points）：用户真实骂什么 —— 创意避坑 + 反差钩子原料
 *   3. 用户原话（verbatim）：一字不改的高能句子 —— 花字/钩子文案弹药
 *   4. 使用场景（scenarios）：谁在什么时刻怎么用 —— 镜头演示节拍的排布依据
 *
 * 工作方式：
 *   plan(input)   → 产出《挖矿任务书》：分平台查询矩阵 + 回填格式
 *   distill(raw)  → 清洗（去水军/去重复）→ 方面级情感抽取 → 聚合计数 → 场景提炼
 *
 * 反虚构纪律：
 *   - 每条观点必须挂来源；聚合时保留代表性原话，禁止改写用户语义
 *   - 全是好评的样本直接打偏倚警报（真实商品必有差评）
 *   - 水军/广告/刷屏内容清洗出局，并报告清洗量
 */

/** 通用方面词库（方面 → 触发词）。执行方 LLM 可在此基础上按品类扩展 */
const ASPECT_LEXICON = {
  质量: ['质量', '做工', '耐用', '坏了', '裂', '断', '掉漆', '松动'],
  外观: ['颜值', '好看', '外观', '颜色', '高级感', '丑', '廉价感'],
  续航: ['续航', '电池', '充电', '电量', '耐用度'],
  尺寸便携: ['大小', '尺寸', '便携', '轻', '重', 'mini', '迷你', '口袋'],
  性能: ['风力', '力度', '效果', '性能', '速度', '噪音', '静音', '吵'],
  性价比: ['性价比', '值', '便宜', '贵', '价格', '划算', '不值'],
  物流包装: ['物流', '快递', '包装', '发货', '到货'],
  客服售后: ['客服', '售后', '退货', '换货', '维修', '服务态度'],
  易用性: ['操作', '上手', '安装', '使用难度', '说明书', '方便'],
  安全健康: ['安全', '异味', '过敏', '甲醛', '辐射', '材质安全', '孩子']
};

const POSITIVE_WORDS = ['好', '赞', '喜欢', '满意', '推荐', '值', '棒', '给力', '惊艳', '舒服', '不错', '爱了', '回购', '神器', '好用', '划算'];
const NEGATIVE_WORDS = ['差', '失望', '后悔', '退', '垃圾', '坑', '难用', '坏', '翻车', '踩雷', '不值', '鸡肋', '吵', '异味', '别买', '避雷'];

/** 差评根因分类（吐槽点 → 根因桶） */
const ROOT_CAUSE_MAP = {
  质量: 'quality_defect', 安全健康: 'safety_concern', 续航: 'endurance_gap',
  性能: 'performance_gap', 尺寸便携: 'form_factor', 性价比: 'value_mismatch',
  物流包装: 'fulfillment', 客服售后: 'after_sales', 易用性: 'usability', 外观: 'aesthetics',
  // 【修复 Bug3/优化点5】品类扩展方面的根因映射（配合 aspectLexiconExt 使用）
  维修成本: 'after_sales', 补能体验: 'endurance_gap', 驾乘舒适: 'performance_gap',
  智驾座舱: 'usability', 空间尺寸: 'form_factor'
};

/** 【优化点5】汽车品类扩展词库（执行方回填时经 input.aspectLexiconExt 注入即可启用） */
const AUTO_LEXICON_EXT = {
  维修成本: ['修车', '维修费', '保养贵', '配件', '喷漆', '保险涨'],
  补能体验: ['充电速度', '超充', '家充', '充电桩', '补能', '谷电'],
  驾乘舒适: ['减震', '悬架', '底盘', '座椅', '隔音', '胎噪', '风噪'],
  智驾座舱: ['辅助驾驶', '自动辅助', '车机', '中控屏', '语音'],
  空间尺寸: ['后排', '空间', '头部空间', '腿部', '储物', '后备箱']
};

/** 【v2.12.1 新增】SaaS/AI 产品品类扩展词库（经 input.aspectLexiconExt 注入启用）
 *  通用 ASPECT_LEXICON 为实物商品导向，AI 办公/软件类评价（生成质量/模板/积分额度）
 *  全量漏匹配会导致 pain_points/pros/cons 为空；本词库覆盖软件品类高频方面 */
const SAAS_LEXICON_EXT = {
  生成质量: ['生成质量', '效果', '准确', '能用', '成品', '返工', '可用'],
  模板设计: ['模板', '排版', '好看', '颜值', '设计', '美观'],
  速度效率: ['速度', '分钟', '效率', '快', '慢', '等待', '省时'],
  生态集成: ['钉钉', '飞书', '生态', '同步', '打通', '连接器', '集成'],
  稳定可靠: ['稳定', '崩溃', '卡顿', '乱码', '失败', '报错', 'bug', '闪退'],
  价格额度: ['价格', '积分', '额度', '免费', '付费', '订阅', '贵', '划算']
};

/** 场景提炼模式：人群/时刻/地点线索 */
const SCENE_PATTERNS = [
  { re: /给孩子|给宝宝|给娃|孩子用|婴儿|宝宝/g, persona: '母婴人群' },
  { re: /上班|通勤|办公室|工位|地铁|公交/g, persona: '通勤族', scene: '通勤/办公' },
  { re: /宿舍|学生|寝室|教室|图书馆/g, persona: '学生党', scene: '校园' },
  { re: /户外|露营|爬山|旅行|出差|旅游|海边/g, scene: '户外出行' },
  { re: /健身|跑步|运动|骑行/g, scene: '运动场景' },
  { re: /晚上|夜里|睡觉|床头|睡前/g, moment: '夜间' },
  { re: /夏天|高温|闷热|三伏/g, moment: '高温季' },
  { re: /厨房|做饭|炒菜/g, scene: '厨房' },
  { re: /化妆|补妆|美甲|理发店/g, scene: '美妆护理' }
];

class ReviewMiner {
  constructor(opts = {}) {
    this.agentName = 'ReviewMiner';
    this.minReviews = opts.minReviews || 10; // 样本量软门槛
  }

  /**
   * 产出《挖矿任务书》
   * @param {object} input { name, brand?, category?, sellingPointCandidates? }
   */
  plan(input = {}) {
    if (!input.name) throw new Error('[A2] 缺商品名 name');
    const base = [input.brand, input.name].filter(Boolean).join(' ');
    const points = Array.isArray(input.sellingPointCandidates) ? input.sellingPointCandidates : [];

    const queries = [
      { q: `${base} 真实评价 怎么样`, intent: 'general_reviews', channel: '电商评价/问答' },
      { q: `${base} 差评 缺点`, intent: 'negative_reviews', channel: '电商差评区/问答' },
      { q: `${base} 踩雷 避雷`, intent: 'fail_reports', channel: '社媒' },
      { q: `${base} 值得买吗 知乎`, intent: 'qa_threads', channel: '知乎' },
      { q: `${base} 使用感受 小红书`, intent: 'ugc_notes', channel: '小红书' },
      { q: `${base} 测评 对比`, intent: 'review_articles', channel: '评测媒体/社媒' },
      { q: `${base} 回购 用了 个月`, intent: 'long_term', channel: '电商追评/社媒' }
    ];
    // 每个候选卖点定向验证：官方吹的，用户认不认？
    for (const p of points.slice(0, 5)) {
      queries.push({ q: `${base} ${p} 真的吗`, intent: 'claim_check', channel: '问答/社媒', target_point: p });
    }

    return {
      stage: 'A2_MINE',
      agent: this.agentName,
      queries,
      sample_target: { min_reviews: this.minReviews, negative_share: '差评/中评样本不得低于 15%（防偏倚）' },
      fillback_format: {
        reviews: '[{ text, source(渠道描述), url, rating?(1-5), date?, helpful_votes? }]',
        note: '品类方面词库扩展：回填前可在 input.aspectLexiconExt 声明 {方面名: [触发词...]}（如汽车可用模块导出的 AUTO_LEXICON_EXT），distill 将与通用词库合并并按命中词数仲裁主方面'
      },
      discipline: [
        '评价必须原文回填，禁止改写/润色用户句子',
        '每条评价必须带来源；刷单嫌疑（模板化/无细节/集中爆发）照样回填但标注 suspect: true',
        '追加评价（用了N个月后的追评）价值最高，优先采集'
      ]
    };
  }

  /**
   * 清洗 + 挖掘回填评价
   * @param {object} raw { reviews: [...] }
   * @param {object} ctx { input, ledger }
   */
  distill(raw = {}, ctx = {}) {
    const { input = {}, ledger } = ctx;
    const reviews = Array.isArray(raw.reviews) ? raw.reviews : [];
    const gaps = [];

    // ===== 清洗：去重 + 水军出局 =====
    const seen = new Set();
    const clean = [];
    let spamCount = 0, dupCount = 0;
    for (const r of reviews) {
      if (!r || !r.text || String(r.text).trim().length < 4) { spamCount += 1; continue; }
      if (r.suspect === true) { spamCount += 1; continue; }
      const fp = String(r.text).replace(/\s+/g, '').slice(0, 40);
      if (seen.has(fp)) { dupCount += 1; continue; }
      seen.add(fp);
      clean.push(r);
    }

    // ===== 方面级情感抽取 =====
    const aspectHits = {}; // aspect -> {pos:[], neg:[]}
    const scenarioHits = new Map(); // key -> {persona?, scene?, moment?, count, quote}
    const verbatimCandidates = [];

    // 【修复 Bug3/优化点5】品类扩展词库通道：执行方可经 input.aspectLexiconExt 注入
    // 品类方面词（如汽车：维修成本/补能体验/驾乘舒适/智驾座舱/空间尺寸），与通用词库合并
    const ext = (input && input.aspectLexiconExt) || {};
    const lexicon = { ...ASPECT_LEXICON };
    for (const [aspect, words] of Object.entries(ext)) {
      lexicon[aspect] = [...(lexicon[aspect] || []), ...words];
    }

    // 【修复 Bug3】否定前缀抑制计数："不满意"/"不值"/"没味" 等不计入正/负向裸命中
    const countHits = (text, words) => words.reduce((n, w) => {
      let hits = 0, idx = -1;
      while ((idx = text.indexOf(w, idx + 1)) !== -1) {
        const prev2 = text.slice(Math.max(0, idx - 2), idx);
        if (!/(不|无|没|别|未)$/.test(prev2)) hits += 1;
      }
      return n + hits;
    }, 0);

    for (const r of clean) {
      const text = String(r.text);
      const rating = Number(r.rating) || null;
      const posScore = countHits(text, POSITIVE_WORDS);
      const negScore = countHits(text, NEGATIVE_WORDS);
      const sentiment = rating != null
        ? (rating >= 4 ? 'pos' : rating <= 2 ? 'neg' : (negScore > posScore ? 'neg' : 'pos'))
        : (negScore > posScore ? 'neg' : posScore > 0 ? 'pos' : 'neutral');

      const srcRef = ledger
        ? ledger.register({ claimRef: 'voc.raw_review', sourceUrl: r.url, origin: r.url ? undefined : (r.source || '执行方回填评价'), channel: r.source || '', agent: this.agentName, fetchedAt: r.date })
        : null;

      // 【修复 Bug3】主方面仲裁：得分 = 命中触发词数×2 + 品类扩展方面加权1
      // （执行方按品类注入的扩展方面比通用桶更精确，平分秋色时优先），
      // 仅入得分最高的主方面桶，避免"修车太贵……比充电费钱"被'充电'一词错拖进'续航'桶
      const hits = [];
      for (const [aspect, words] of Object.entries(lexicon)) {
        const n = words.reduce((cnt, w) => cnt + (text.includes(w) ? 1 : 0), 0);
        if (n > 0) hits.push({ aspect, score: n * 2 + (Object.prototype.hasOwnProperty.call(ext, aspect) ? 1 : 0) });
      }
      hits.sort((a, b) => b.score - a.score);
      if (hits.length > 0) {
        const primary = hits[0].aspect;
        aspectHits[primary] = aspectHits[primary] || { pos: [], neg: [] };
        const bucket = sentiment === 'neg' ? 'neg' : sentiment === 'pos' ? 'pos' : null;
        if (bucket) aspectHits[primary][bucket].push({ text, srcRef, rating });
      }

      // 场景提炼
      for (const sp of SCENE_PATTERNS) {
        if (sp.re.test(text)) {
          sp.re.lastIndex = 0;
          const key = `${sp.persona || ''}|${sp.scene || ''}|${sp.moment || ''}`;
          const cur = scenarioHits.get(key) || { persona: sp.persona || '', scene: sp.scene || '', moment: sp.moment || '', count: 0, quotes: [] };
          cur.count += 1;
          if (cur.quotes.length < 2) cur.quotes.push(text.slice(0, 80));
          scenarioHits.set(key, cur);
        }
      }

      // 原话候选：情绪浓度高、长度适中
      const emo = posScore + negScore;
      if (emo >= 1 && text.length >= 8 && text.length <= 80) {
        verbatimCandidates.push({ text, sentiment, emo, srcRef, source: r.source || '' });
      }
    }

    // ===== 聚合观点 =====
    const toPoint = (aspect, items, kind) => ({
      point: this._summarizeAspect(aspect, items, kind),
      aspect,
      mentions: items.length,
      quote: items[0]?.text.slice(0, 100) || '',
      source_refs: [...new Set(items.map(x => x.srcRef).filter(Boolean))],
      root_cause: kind === 'pain' ? (ROOT_CAUSE_MAP[aspect] || 'other') : undefined
    });

    const praise_points = [];
    const pain_points = [];
    for (const [aspect, buckets] of Object.entries(aspectHits)) {
      if (buckets.pos.length >= 1) praise_points.push(toPoint(aspect, buckets.pos, 'praise'));
      if (buckets.neg.length >= 1) pain_points.push(toPoint(aspect, buckets.neg, 'pain'));
    }
    praise_points.sort((a, b) => b.mentions - a.mentions);
    pain_points.sort((a, b) => b.mentions - a.mentions);

    // 原话：情绪浓度优先，正负能量均衡
    verbatimCandidates.sort((a, b) => b.emo - a.emo);
    const verbatim = verbatimCandidates.slice(0, 12).map(v => ({
      text: v.text,
      sentiment: v.sentiment,
      source: v.source,
      source_refs: v.srcRef ? [v.srcRef] : []
    }));

    const scenarios = [...scenarioHits.values()]
      .sort((a, b) => b.count - a.count)
      .map(s => ({ persona: s.persona || '泛人群', scene: s.scene || '', moment: s.moment || '', mentions: s.count, sample_quotes: s.quotes }));

    // ===== 偏倚检查 =====
    const negCount = clean.filter(r => (Number(r.rating) || 5) <= 2).length;
    if (clean.length < this.minReviews) gaps.push(`有效评价样本 ${clean.length} 条，低于门槛 ${this.minReviews} 条，结论置信度受限`);
    if (clean.length >= 3 && negCount === 0) gaps.push('样本零差评，存在严重偏倚嫌疑（真实商品必有差评），pain_points 可信度存疑');
    if (pain_points.length === 0 && clean.length >= 5) gaps.push('未挖到吐槽点：要么样本偏倚，要么挖掘词库需按品类扩展');

    return {
      review_count: clean.length,
      cleaned: { spam_removed: spamCount, duplicate_removed: dupCount },
      praise_points,
      pain_points,
      verbatim,
      scenarios,
      gaps
    };
  }

  /** 方面 → 观点句（保留用户语义骨架，不虚构细节） */
  _summarizeAspect(aspect, items, kind) {
    const verb = kind === 'praise' ? '认可' : '集中吐槽';
    return `用户${verb}「${aspect}」（${items.length} 次提及）`;
  }
}

module.exports = { ReviewMiner, ASPECT_LEXICON, ROOT_CAUSE_MAP, AUTO_LEXICON_EXT, SAAS_LEXICON_EXT };
