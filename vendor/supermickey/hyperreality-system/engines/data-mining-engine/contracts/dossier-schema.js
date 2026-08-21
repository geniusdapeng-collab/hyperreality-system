'use strict';

/**
 * DossierSchema — 《商品情报档案》Schema 唯一权威定义
 * ------------------------------------------------------------
 * 珍妮纺织机·数据挖掘引擎的核心交付物契约。
 *
 * 设计原则：
 *   1. 每条事实必须可溯源（provenance 数组登记来源 + 采集日期）
 *   2. 每条观点必须带置信度（confirmed / reported / inferred）
 *   3. 字段缺失显式标记（needsMoreResearch），禁止用空值糊弄下游
 *   4. Schema 校验失败即装订失败，宁缺毋滥
 *
 * 置信度语义：
 *   confirmed  官方来源，或 >=2 个相互独立来源交叉一致
 *   reported   单一非官方来源，可用但须标注
 *   inferred   Agent 推理得出，仅作参考，禁止进入 pros/cons 事实区
 */

const CONFIDENCE_LEVELS = ['confirmed', 'reported', 'inferred'];
const LICENSE_RISK_LEVELS = ['low', 'mid', 'high'];

/** 生成一份空档案骨架（所有字段就位，便于下游防御性读取） */
function emptyDossier(productId = '') {
  return {
    product_id: productId,
    built_at: null,
    identity: {
      name: '',
      brand: '',
      category: '',
      model: '',
      specs: {},
      price_band: '',
      official_selling_points: []
    },
    visual_assets: {
      hero_image_id: null,
      images: [],
      needs_more_reference: true
    },
    usage: {
      scenarios: [],
      frequency_notes: []
    },
    voice_of_customer: {
      praise_points: [],
      pain_points: [],
      verbatim: []
    },
    pros_cons: { pros: [], cons: [] },
    competitors: [],
    differentiation: {
      our_opening: [],
      crowded_points: []
    },
    hook_material: {
      data_points: [],
      conflicts: [],
      questions: []
    },
    gaps: [],
    provenance: []
  };
}

/** 字段级校验规则（dot-path -> 规则） */
const RULES = [
  { path: 'product_id', type: 'string', required: true },
  { path: 'identity.name', type: 'string', required: true },
  { path: 'identity.category', type: 'string', required: false },
  { path: 'identity.specs', type: 'object', required: true },
  { path: 'visual_assets.images', type: 'array', required: true },
  { path: 'visual_assets.needs_more_reference', type: 'boolean', required: true },
  { path: 'usage.scenarios', type: 'array', required: true },
  { path: 'voice_of_customer.praise_points', type: 'array', required: true },
  { path: 'voice_of_customer.pain_points', type: 'array', required: true },
  { path: 'voice_of_customer.verbatim', type: 'array', required: true },
  { path: 'pros_cons.pros', type: 'array', required: true },
  { path: 'pros_cons.cons', type: 'array', required: true },
  { path: 'competitors', type: 'array', required: true },
  { path: 'hook_material.data_points', type: 'array', required: true },
  { path: 'hook_material.conflicts', type: 'array', required: true },
  { path: 'hook_material.questions', type: 'array', required: true },
  { path: 'gaps', type: 'array', required: true },
  { path: 'provenance', type: 'array', required: true }
];

/** 图片条目必填字段 */
const IMAGE_ITEM_RULES = ['id', 'url', 'source', 'angle', 'license_risk', 'fetched_at'];

/** 评价/优缺点条目置信度强制区 */
const CONFIDENCE_CONTAINER_PATHS = [
  'voice_of_customer.praise_points',
  'voice_of_customer.pain_points',
  'pros_cons.pros',
  'pros_cons.cons'
];

function _get(obj, dotPath) {
  return dotPath.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function _typeOf(v) {
  if (Array.isArray(v)) return 'array';
  if (v === null) return 'null';
  return typeof v;
}

/**
 * 校验档案是否符合 Schema
 * @param {object} dossier
 * @returns {{ok: boolean, issues: string[], warnings: string[]}}
 */
function validate(dossier) {
  const issues = [];
  const warnings = [];

  if (!dossier || typeof dossier !== 'object') {
    return { ok: false, issues: ['档案不是对象'], warnings };
  }

  for (const rule of RULES) {
    const v = _get(dossier, rule.path);
    if (v === undefined || v === null) {
      if (rule.required) issues.push(`缺必填字段 ${rule.path}`);
      continue;
    }
    const t = _typeOf(v);
    if (t !== rule.type) {
      issues.push(`字段 ${rule.path} 类型应为 ${rule.type}，实际 ${t}`);
      continue;
    }
    if (rule.type === 'string' && rule.required && !String(v).trim()) {
      issues.push(`必填字段 ${rule.path} 为空字符串`);
    }
  }

  // 图片条目逐条校验
  const images = _get(dossier, 'visual_assets.images');
  if (Array.isArray(images)) {
    images.forEach((img, i) => {
      for (const f of IMAGE_ITEM_RULES) {
        if (img[f] === undefined || img[f] === null || img[f] === '') {
          issues.push(`visual_assets.images[${i}] 缺字段 ${f}`);
        }
      }
      if (img.license_risk && !LICENSE_RISK_LEVELS.includes(img.license_risk)) {
        issues.push(`visual_assets.images[${i}].license_risk 非法值 "${img.license_risk}"`);
      }
    });
    if (images.length > 0 && !_get(dossier, 'visual_assets.hero_image_id')) {
      warnings.push('已有图片但未指定 hero_image_id');
    }
  }

  // 置信度强制 + 无源断言禁止入库
  for (const p of CONFIDENCE_CONTAINER_PATHS) {
    const arr = _get(dossier, p);
    if (Array.isArray(arr)) {
      arr.forEach((item, i) => {
        if (!item.confidence || !CONFIDENCE_LEVELS.includes(item.confidence)) {
          issues.push(`${p}[${i}] 缺合法 confidence（${CONFIDENCE_LEVELS.join('/')}）`);
        }
        if (item.confidence === 'inferred') {
          warnings.push(`${p}[${i}] 为 inferred 级，下游不得当作事实引用`);
        }
        const refs = item.source_refs || item.sources || [];
        if (!Array.isArray(refs) || refs.length === 0) {
          issues.push(`${p}[${i}] 无来源引用（无源断言禁止入库）`);
        }
      });
    }
  }

  return { ok: issues.length === 0, issues, warnings };
}

module.exports = {
  CONFIDENCE_LEVELS,
  LICENSE_RISK_LEVELS,
  emptyDossier,
  validate
};
