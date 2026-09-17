'use strict';

/**
 * HandoffValidator — Agent 交接闸机
 * ------------------------------------------------------------
 * 流水线上每一站的出站 payload 必须过闸机，才允许流入下一站。
 * 闸机做三层检查：
 *   L1 结构：必填字段在不在、类型对不对（硬失败，阻断流转）
 *   L2 纪律：事实区条目是否全部挂了证据编号（硬失败，阻断流转）
 *   L3 丰度：情报量是否达标（软失败，放行但打 needsMoreResearch 标记）
 *
 * 设计取向：宁可让下游拿到"标记了缺口"的档案，也不让
 * 未经验证的数据混进下游污染镜头生成。
 */

/** 各阶段出站契约 */
const STAGE_CONTRACTS = {
  A1_COLLECT: {
    hard: [
      { path: 'identity.name', type: 'string', nonEmpty: true, label: '商品名' },
      { path: 'identity.specs', type: 'object', label: '规格表' },
      { path: 'image_candidates', type: 'array', label: '商品图候选' }
    ],
    // 丰度门槛：低于则打标记
    richness: [
      { path: 'image_candidates', min: 2, gap: '商品图候选不足 2 张' },
      { path: 'identity.official_selling_points', min: 1, gap: '未采集到官方卖点' }
    ]
  },
  A2_MINE: {
    hard: [
      { path: 'praise_points', type: 'array', label: '称赞点' },
      { path: 'pain_points', type: 'array', label: '吐槽点' },
      { path: 'verbatim', type: 'array', label: '用户原话' },
      { path: 'scenarios', type: 'array', label: '使用场景' },
      { path: 'review_count', type: 'number', label: '评价样本量' }
    ],
    factArrays: ['praise_points', 'pain_points'],
    richness: [
      { path: 'praise_points', min: 2, gap: '称赞点不足 2 条（评价样本可能太薄）' },
      { path: 'pain_points', min: 1, gap: '未挖到吐槽点（警惕样本偏倚：全是好评通常不真实）' },
      { path: 'scenarios', min: 1, gap: '未提炼出使用场景' }
    ]
  },
  A3_SCOUT: {
    hard: [
      { path: 'competitors', type: 'array', label: '竞品列表' }
    ],
    richness: [
      { path: 'competitors', min: 1, gap: '未找到有效竞品' }
    ]
  },
  A4_VERIFY: {
    hard: [
      { path: 'verified.praise_points', type: 'array', label: '已验证称赞点' },
      { path: 'verified.pain_points', type: 'array', label: '已验证吐槽点' },
      { path: 'pros', type: 'array', label: '优点清单' },
      { path: 'cons', type: 'array', label: '缺点清单' },
      { path: 'verification_report', type: 'object', label: '验证报告' }
    ]
  },
  A5_BIND: {
    hard: [
      { path: 'dossier', type: 'object', label: '商品情报档案' },
      { path: 'cards.brief_card', type: 'object', label: 'Brief 摘要卡' },
      { path: 'cards.theme_card', type: 'object', label: '主题摘要卡' },
      { path: 'cards.insight_card', type: 'object', label: '洞察摘要卡' },
      { path: 'cards.prd_card', type: 'object', label: 'PRD 摘要卡' },
      { path: 'cards.portrait_manifest', type: 'object', label: '定妆照图档 manifest' },
      { path: 'cards.router_material', type: 'object', label: '技能路由素材卡' }
    ]
  }
};

function _get(obj, dotPath) {
  return dotPath.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function _typeOf(v) {
  if (Array.isArray(v)) return 'array';
  if (v === null) return 'null';
  return typeof v;
}

/**
 * 校验某阶段的出站 payload
 * @param {string} stage 阶段编号（STAGE_CONTRACTS 的 key）
 * @param {object} payload
 * @returns {{ok: boolean, hardFailures: string[], gaps: string[]}}
 *   ok=false 表示硬失败，流水线必须阻断该站出站
 */
function validateHandoff(stage, payload) {
  const contract = STAGE_CONTRACTS[stage];
  if (!contract) return { ok: false, hardFailures: [`未知阶段 ${stage}，无交接契约`], gaps: [] };

  const hardFailures = [];
  const gaps = [];

  for (const rule of contract.hard || []) {
    const v = _get(payload, rule.path);
    if (v === undefined || v === null) {
      hardFailures.push(`[${stage}] 缺必填字段 ${rule.path}（${rule.label}）`);
      continue;
    }
    const t = _typeOf(v);
    if (t !== rule.type) {
      hardFailures.push(`[${stage}] 字段 ${rule.path} 类型应为 ${rule.type}，实际 ${t}`);
      continue;
    }
    if (rule.nonEmpty && ((t === 'string' && !v.trim()) || (t === 'array' && v.length === 0))) {
      hardFailures.push(`[${stage}] 字段 ${rule.path}（${rule.label}）为空`);
    }
  }

  // 纪律检查：事实区条目必须挂证据编号
  for (const arrPath of contract.factArrays || []) {
    const arr = _get(payload, arrPath);
    if (!Array.isArray(arr)) continue;
    arr.forEach((item, i) => {
      const refs = item.source_refs || [];
      if (!Array.isArray(refs) || refs.length === 0) {
        hardFailures.push(`[${stage}] ${arrPath}[${i}] 未挂证据编号（无源断言禁止流转）`);
      }
    });
  }

  for (const rule of contract.richness || []) {
    const v = _get(payload, rule.path);
    const len = Array.isArray(v) ? v.length : (v == null ? 0 : 1);
    if (len < rule.min) gaps.push(`[${stage}] ${rule.gap}`);
  }

  return { ok: hardFailures.length === 0, hardFailures, gaps };
}

module.exports = { STAGE_CONTRACTS, validateHandoff };
