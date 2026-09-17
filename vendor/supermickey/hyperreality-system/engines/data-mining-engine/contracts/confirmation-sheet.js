'use strict';

/**
 * DossierConfirmationSheet — 商品情报档案确认单
 * ------------------------------------------------------------
 * 珍妮纺织机的人工确认闸交付物，与创意主题确认单同规格：
 * 档案在注入下游（Brief 回填 / 摘要卡分发）之前，必须经人工确认。
 * 确认单只摆"会影响下游决策的关键事实"，全量细节回档案查证。
 */

function _yn(flag, trueText, falseText) {
  return flag ? (trueText || '是') : (falseText || '否');
}

/**
 * 生成盒式确认单文本
 * @param {object} dossier 商品情报档案
 * @param {object} cards   六张摘要卡
 * @param {object} [opts]  { reused?: boolean, stale?: boolean }
 */
function generateDossierConfirmationSheet(dossier, cards = {}, opts = {}) {
  const d = dossier || {};
  const id = d.identity || {};
  const brief = cards.brief_card || {};
  const imgs = (d.visual_assets && d.visual_assets.images) || [];
  const gaps = d.gaps || [];

  const L = (label, text) => `║ ${label}: ${text}`;
  const lines = [
    '╔══════════════════════════════════════════╗',
    '║      🧵 商品情报档案确认单（珍妮纺织机） ║',
    '╠══════════════════════════════════════════╣',
    L('档案编号', d.product_id || '未登记'),
    L('商品', [id.brand, id.name, id.model].filter(Boolean).join(' ') || '未命名'),
    L('品类', id.category || '未分类'),
    L('价格带', id.price_band ? `${id.price_band}${id.price_confidence ? `（${id.price_confidence}）` : ''}` : '未采集'),
    L('商品图', `${imgs.length} 张${imgs[0] ? `，英雄照 ${imgs[0].id}` : ''}${d.visual_assets && d.visual_assets.needs_more_reference ? ' ⚠️低于参考图门槛' : ''}`),
    L('卖点候选', (brief.sellingPoints || []).join(' / ') || '无（需人工补齐）'),
    L('人群', brief.audience || '未提炼'),
    L('竞品', (d.competitors || []).map(c => c.name).join(' / ') || '未侦察到'),
    L('情报来源', `${(d.provenance || []).length} 条已登记证据`),
  ];

  if (opts.reused) {
    lines.push(L('复用', `命中既有档案${opts.stale ? '（已过期 stale，建议刷新）' : '（有效期内）'}`));
  }

  lines.push('╠══════════════════════════════════════════╣');

  if (gaps.length > 0) {
    lines.push('║ ⚠️ 情报缺口（下游不得当事实引用）:');
    gaps.slice(0, 6).forEach(g => lines.push(`║   - ${g}`));
    if (gaps.length > 6) lines.push(`║   ... 共 ${gaps.length} 条，详见档案 gaps`);
    lines.push('╠══════════════════════════════════════════╣');
  }

  lines.push(
    '║ 确认纪律:                                ║',
    '║ 1. 卖点/评价/竞品均须来自真实来源        ║',
    '║ 2. inferred 级情报禁止进入下游事实引用   ║',
    '║ 3. 商品图仅作定妆照参考，须核对真实性    ║',
    '║ 4. 确认后 Brief 自动回填 + 摘要卡分发    ║',
    '║ 5. 驳回则情报层整体退出本次任务          ║',
    '╚══════════════════════════════════════════╝'
  );
  return lines.join('\n');
}

module.exports = { generateDossierConfirmationSheet };
