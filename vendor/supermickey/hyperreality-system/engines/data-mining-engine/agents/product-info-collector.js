'use strict';

/**
 * A1 ProductInfoCollector — 商品情报采集员
 * ------------------------------------------------------------
 * 职责：把商品的"官方事实"和"真实外观"钉死。
 * 两个战场：
 *   战场一·身份事实：品名/品牌/类目/型号/规格/价格带/官方卖点
 *   战场二·商品图：官方图 + 实拍图，逐张评分、分级、去重，产出英雄照候选
 *
 * 工作方式（spec/api 双模）：
 *   plan(input)   → 产出《采集任务书》：查询矩阵 + 提取模板 + 回填格式
 *   distill(raw)  → 对执行方回填的原始结果做归一化/评分/去重/裁决
 *
 * 反虚构纪律：
 *   - 身份事实只接受带回填来源的字段，无源字段直接丢弃并记 gap
 *   - 图片必须逐张过真实性启发式（AI 生成嫌疑词、官渠加权）
 *   - 系列化产品强制型号甄别（与定妆照分支纪律对齐）
 */

const SERVICE_CATEGORY_PATTERN = /服务|课程|培训|咨询|旅游|本地生活|到店|家政|维修|金融|保险|医疗|医美|健身|教育|软件|SaaS|APP|App|应用|平台|办公|云/;

/** AI 生成图/概念图嫌疑词（出现在标题/来源描述中即扣分） */
const AI_SUSPECT_PATTERN = /AI生成|ai绘图|概念图|渲染图|效果图(?!片)|3D渲染|虚构|假想|design concept/i;

/** 官方渠道关键词（来源描述/标题命中即加权） */
const OFFICIAL_HINT = /官网|官方|旗舰店|自营|品牌店|official/i;

/** 图片候选条目评分权重 */
const IMAGE_SCORE = {
  OFFICIAL_CHANNEL: 30,      // 官方渠道
  ECOMMERCE_DETAIL: 15,      // 电商详情页
  RESOLUTION_OK: 20,         // 短边 >= 800px
  ANGLE_TAGGED: 5,           // 带角度标注
  AI_SUSPECT: -100,          // AI 生成嫌疑（直接出局）
  WATERMARK_SUSPECT: -10     // 水印嫌疑
};

class ProductInfoCollector {
  constructor(opts = {}) {
    this.minReferenceImages = opts.minReferenceImages || 2;
    this.agentName = 'ProductInfoCollector';
  }

  _productKind(input = {}) {
    return SERVICE_CATEGORY_PATTERN.test(String(input.category || '')) ? 'service' : 'physical';
  }

  /** 商品图编号前缀：品牌/品名拼音字母与数字，2-4 位 */
  static idPrefix(input = {}) {
    const base = `${input.brand || ''}${input.name || ''}`;
    const alnum = base.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    return (alnum.slice(0, 4) || 'PRD').padEnd(2, 'X');
  }

  /**
   * 产出《采集任务书》
   * @param {object} input { name, brand?, category?, model?, priceHint? }
   */
  plan(input = {}) {
    if (!input.name) throw new Error('[A1] 缺商品名 name，无法构建采集任务书');
    const kind = this._productKind(input);
    const base = [input.brand, input.name, input.model].filter(Boolean).join(' ');
    const cat = input.category || '';

    // 查询矩阵：每个查询带意图与目标渠道，执行方按此检索并回填
    const queries = kind === 'service'
      ? [
          { q: `${base} 官网`, intent: 'official_site', channel: '官网' },
          { q: `${base} 官方 介绍 服务 内容`, intent: 'official_info', channel: '官方社媒/官网' },
          { q: `${base} 价格 套餐`, intent: 'price', channel: '官网/电商' },
          { q: `${base} 官方 物料 品牌 视觉`, intent: 'brand_assets', channel: '官方社媒' },
          { q: `${base} 门店 实拍`, intent: 'real_scene', channel: '社媒/点评' },
          { q: `${base} 界面 截图 App`, intent: 'ui_capture', channel: '应用商店/官网' }
        ]
      : [
          { q: `${base} 官网`, intent: 'official_site', channel: '官网' },
          { q: `${base} ${cat} 旗舰店 商品页`.trim(), intent: 'flagship_page', channel: '电商旗舰店' },
          { q: `${base} 参数 规格`, intent: 'specs', channel: '官网/电商详情' },
          { q: `${base} 价格`, intent: 'price', channel: '电商' },
          { q: `${base} 官方产品图 高清`, intent: 'official_images', channel: '官网/旗舰店' },
          { q: `${base} 实拍 开箱`, intent: 'real_shots', channel: '社媒/评测' },
          { q: `${base} 白底图`, intent: 'white_bg', channel: '电商详情' }
        ];

    // 型号甄别（系列化产品纪律）
    const seriesVersionCheck = Boolean(input.model);
    if (seriesVersionCheck) {
      queries.push({ q: `${base} ${input.model} 发布 上市 时间`, intent: 'model_verify', channel: '官网/新闻' });
    }

    return {
      stage: 'A1_COLLECT',
      agent: this.agentName,
      product_kind: kind,
      queries,
      extraction_spec: {
        identity_fields: ['name', 'brand', 'category', 'model', 'price', 'currency', 'selling_points'],
        spec_fields_hint: kind === 'service'
          ? ['服务内容', '履约方式', '周期', '覆盖范围', '资质']
          : ['材质', '尺寸', '重量', '容量', '功率', '续航', '颜色', '产地'],
        price_rule: '记录看到的所有价格（原价/券后/不同规格），不得只记一个；币种必须标注'
      },
      image_spec: {
        min_images: this.minReferenceImages,
        requirements: [
          kind === 'service'
            ? '官方真实物料（官网/官方社媒/App界面/门店实拍），禁止 AI 生成图冒充'
            : '真实商品图，禁止 AI 生成图/概念图/渲染图冒充',
          '优先官方渠道图',
          '分辨率不低于 800px 短边（能查到尺寸就回填 width/height）',
          '覆盖至少两个不同角度/场景',
          '每张图必须回填：url、source（渠道描述）、page_url（所在页面）、angle（角度/场景描述）',
          '系列化产品逐张核对型号标识，剔除同系列旧款/近似款'
        ]
      },
      fillback_format: {
        identity: '{ name, brand, category, model, specs: {...}, prices: [{amount, currency, note, source_url}], official_selling_points: [{point, source_url}] }',
        images: '[{ url, source, page_url, angle, width?, height?, title? }]'
      },
      discipline: [
        '身份事实无来源一律不回填（宁缺毋滥）',
        '价格必须原样记录，禁止"大概一百多"式模糊回填',
        '看到的和推断的严格分开，推断写进 inferred_notes 不得混入 facts'
      ]
    };
  }

  /**
   * 归一化回填结果，产出 A1 出站 payload
   * @param {object} raw 执行方按 fillback_format 回填的数据
   * @param {object} ctx { input, ledger } ledger 为 EvidenceLedger 实例
   */
  distill(raw = {}, ctx = {}) {
    const { input = {}, ledger } = ctx;
    const gaps = [];
    const prefix = ProductInfoCollector.idPrefix(input);

    // ===== 身份事实归一化 =====
    const identity = {
      name: raw.identity?.name || input.name || '',
      brand: raw.identity?.brand || input.brand || '',
      category: raw.identity?.category || input.category || '',
      model: raw.identity?.model || input.model || '',
      specs: {},
      price_band: '',
      official_selling_points: []
    };

    // 规格表：只收带来源的键值
    const specEntries = Object.entries(raw.identity?.specs || {});
    for (const [k, v] of specEntries) {
      if (v && typeof v === 'object' && 'value' in v) {
        identity.specs[k] = v.value;
        if (ledger && v.source_url) {
          ledger.register({ claimRef: `identity.specs.${k}`, sourceUrl: v.source_url, channel: v.channel || '', agent: this.agentName });
        }
      } else if (v != null && v !== '') {
        identity.specs[k] = v; // 无来源规格保留但记 gap
        gaps.push(`规格 "${k}" 无来源，置信度降级`);
      }
    }

    // 价格带：全价格样本归一为区间
    const prices = Array.isArray(raw.identity?.prices) ? raw.identity.prices : [];
    const amounts = prices.map(p => Number(p.amount)).filter(n => Number.isFinite(n) && n > 0);
    if (amounts.length > 0) {
      const cur = prices.find(p => p.currency)?.currency || 'CNY';
      const lo = Math.min(...amounts), hi = Math.max(...amounts);
      identity.price_band = lo === hi ? `${cur} ${lo}` : `${cur} ${lo}-${hi}`;
      prices.forEach((p, i) => {
        if (ledger && p.source_url) {
          ledger.register({ claimRef: 'identity.price_band', sourceUrl: p.source_url, channel: p.channel || p.note || '', agent: this.agentName });
        } else if (ledger) {
          ledger.register({ claimRef: 'identity.price_band', origin: p.note || `执行方回填价格样本#${i + 1}`, agent: this.agentName });
        }
      });
    } else {
      gaps.push('未采集到价格信息，price_band 为空');
    }

    // 官方卖点：无源剔除
    const rawPoints = Array.isArray(raw.identity?.official_selling_points) ? raw.identity.official_selling_points : [];
    for (const p of rawPoints) {
      const point = typeof p === 'string' ? p : p?.point;
      const url = typeof p === 'object' ? p?.source_url : null;
      if (!point) continue;
      if (url && ledger) {
        ledger.register({ claimRef: `identity.official_selling_points:${point}`, sourceUrl: url, channel: p.channel || '', agent: this.agentName });
        identity.official_selling_points.push(point);
      } else {
        gaps.push(`官方卖点 "${point}" 无来源，已剔除出事实区`);
      }
    }

    // ===== 商品图归一化：评分 → 去重 → 排序 → 编号 =====
    const rawImages = Array.isArray(raw.images) ? raw.images : [];
    const scored = [];
    const seen = new Set();
    for (const img of rawImages) {
      if (!img || !img.url) continue;
      const key = String(img.url).split('?')[0].toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      let score = 0;
      const reasons = [];
      const text = `${img.title || ''} ${img.source || ''}`;

      if (AI_SUSPECT_PATTERN.test(text)) {
        score += IMAGE_SCORE.AI_SUSPECT; reasons.push('AI生成/概念图嫌疑，出局');
      }
      if (OFFICIAL_HINT.test(text)) { score += IMAGE_SCORE.OFFICIAL_CHANNEL; reasons.push('官方渠道'); }
      else if (/详情|商品页|detail|item/i.test(text)) { score += IMAGE_SCORE.ECOMMERCE_DETAIL; reasons.push('电商详情页'); }
      const shortEdge = Math.min(Number(img.width) || 0, Number(img.height) || 0);
      if (shortEdge >= 800) { score += IMAGE_SCORE.RESOLUTION_OK; reasons.push(`分辨率达标(${img.width}x${img.height})`); }
      if (img.angle) { score += IMAGE_SCORE.ANGLE_TAGGED; reasons.push('带角度标注'); }
      if (/水印|watermark/i.test(text)) { score += IMAGE_SCORE.WATERMARK_SUSPECT; reasons.push('水印嫌疑'); }

      if (score < 0) continue; // 出局

      // 授权风险分级：官方 low / 电商 mid / 其他 high
      const licenseRisk = OFFICIAL_HINT.test(text) ? 'low'
        : /详情|商品页|detail|item|电商|评价/i.test(text) ? 'mid' : 'high';

      scored.push({ ...img, _score: score, _reasons: reasons, license_risk: licenseRisk });
    }
    scored.sort((a, b) => b._score - a._score);

    const images = scored.map((img, i) => {
      const id = `${prefix}-${i === 0 ? 'HERO' : 'REF'}-${String(i + 1).padStart(3, '0')}`;
      if (ledger) {
        ledger.register({
          claimRef: `visual_assets.images:${id}`,
          sourceUrl: img.page_url || img.url,
          channel: img.source || '',
          agent: this.agentName,
          fetchedAt: img.fetched_at
        });
      }
      return {
        id,
        url: img.url,
        source: img.source || '',
        page_url: img.page_url || '',
        angle: img.angle || '',
        width: img.width || null,
        height: img.height || null,
        license_risk: img.license_risk,
        score: img._score,
        score_reasons: img._reasons,
        fetched_at: img.fetched_at || new Date().toISOString()
      };
    });

    const needsMore = images.length < this.minReferenceImages;
    if (needsMore) gaps.push(`有效商品图 ${images.length} 张，低于门槛 ${this.minReferenceImages} 张，needsMoreReference`);

    return {
      identity,
      image_candidates: images,
      hero_image_id: images.length > 0 ? images[0].id : null,
      needs_more_reference: needsMore,
      product_kind: this._productKind(input),
      inferred_notes: Array.isArray(raw.inferred_notes) ? raw.inferred_notes : [],
      gaps
    };
  }
}

module.exports = { ProductInfoCollector, SERVICE_CATEGORY_PATTERN };
