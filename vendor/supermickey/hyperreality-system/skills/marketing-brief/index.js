'use strict';

/**
 * MarketingBriefParser（营销 Brief 输入层）
 * ------------------------------------------------------------
 * 【v2.5.0 新增】社媒营销包 SocialPack · P0-1
 *
 * 社媒营销场景的输入物不是"故事文本"，而是营销简报（Brief）。
 * 本模块把 Brief 规范化，并产出与创意主题确认单同规格的"Brief 确认单"，
 * 作为后续业务洞察/PRD/镜头设计的统一上游。
 *
 * Brief 字段：
 *   product        商品名（必填）
 *   category       品类（美妆/食品/3C/服饰/家居/服务/其他，影响合规品类规则）
 *   sellingPoints  核心卖点 ≤3（必填，花字与演示节拍的分配源）
 *   audience       目标人群
 *   goal           转化目标：seeding种草 | traffic引流 | conversion转化
 *   platform       平台（tiktok/douyin/xiaohongshu/instagram-reels）
 *   brand          品牌配置 {color, logoPosition, font}
 *   ctaText        自定义 CTA 文案（可选）
 *   competitor     竞品参照（可选）
 *   duration       目标总时长（默认 30s）
 */

const GOALS = { seeding: '种草', traffic: '引流', conversion: '转化' };

class MarketingBriefParser {
  /**
   * 规范化 Brief（宽容输入：字符串卖点自动拆分，缺省补默认）
   * @param {object} raw
   * @returns {{brief:object, issues:string[]}}
   */
  normalize(raw = {}) {
    const issues = [];
    const brief = { ...raw };

    if (!brief.product || !String(brief.product).trim()) issues.push('缺商品名 product');
    let points = brief.sellingPoints;
    if (typeof points === 'string') points = points.split(/[，,、;；]/).map(s => s.trim()).filter(Boolean);
    if (!Array.isArray(points) || points.length === 0) issues.push('缺核心卖点 sellingPoints（至少 1 个）');
    brief.sellingPoints = (points || []).slice(0, 3);
    if ((points || []).length > 3) issues.push('卖点超过 3 个，已截取前 3（移动端注意力上限）');

    brief.category = brief.category || '其他';
    brief.goal = GOALS[brief.goal] ? brief.goal : 'seeding';
    brief.platform = brief.platform || 'tiktok';
    brief.brand = brief.brand || {};
    brief.audience = brief.audience || '平台泛人群';
    brief.duration = Number(brief.duration) > 0 ? Number(brief.duration) : 30;

    // 【v2.6.0】P1-4 商品定妆照：营销片禁止虚构商品外观，英雄照实拍绑定为纪律项
    brief.productHero = brief.productHero || {};
    if (!brief.productHero.heroImageId) {
      issues.push('缺商品英雄照实拍绑定 productHero.heroImageId（营销片禁止虚构商品外观）');
    } else if (!/^[A-Z0-9]+-[A-Z]+-\d{3}$/.test(brief.productHero.heroImageId)) {
      issues.push(`英雄照编号格式不规范:"${brief.productHero.heroImageId}"（应为 前缀-类别-序号，如 QW-HERO-001）`);
    }

    return { brief, issues };
  }

  /**
   * 【珍妮纺织机对接】用情报档案 Brief 摘要卡自动回填空缺字段
   * ------------------------------------------------------------
   * 只填"用户没填"的字段，用户手填内容永远优先（档案是参谋不是替代）。
   * @param {object} raw  原始 Brief（normalize 之前的输入）
   * @param {object} card 珍妮纺织机产出的 brief_card
   * @returns {{raw: object, filled: string[]}} 回填后的 raw 与实际回填的字段清单
   */
  applyBriefCard(raw = {}, card = {}) {
    if (!card || card.card !== 'brief_card') return { raw, filled: [] };
    const filled = [];
    const next = { ...raw };

    if (!next.product && card.product) { next.product = card.product; filled.push('product'); }
    if (!next.category && card.category) { next.category = card.category; filled.push('category'); }
    const hasPoints = Array.isArray(next.sellingPoints) ? next.sellingPoints.length > 0 : Boolean(next.sellingPoints);
    if (!hasPoints && Array.isArray(card.sellingPoints) && card.sellingPoints.length > 0) {
      next.sellingPoints = card.sellingPoints.slice(0, 3);
      filled.push('sellingPoints');
    }
    if ((!next.audience || next.audience === '平台泛人群') && card.audience) {
      next.audience = card.audience; filled.push('audience');
    }
    if (!next.competitor && card.competitor) { next.competitor = card.competitor; filled.push('competitor'); }
    next.productHero = next.productHero || {};
    if (!next.productHero.heroImageId && card.productHero && card.productHero.heroImageId) {
      next.productHero.heroImageId = card.productHero.heroImageId;
      filled.push('productHero.heroImageId');
    }
    if (filled.length > 0) next._dataDossierNote = card.evidence_note || '字段由商品情报档案自动回填';
    return { raw: next, filled };
  }

  /**
   * 生成 Brief 确认单（与创意主题确认单同规格的盒式文本）
   */
  generateConfirmationSheet(brief) {
    const L = (label, text) => `║ ${label}: ${text}`;
    const points = brief.sellingPoints.map((p, i) => `${i + 1}.${p}`).join('  ');
    return [
      '╔══════════════════════════════════════════╗',
      '║      📣 社媒营销 Brief 确认单            ║',
      '╠══════════════════════════════════════════╣',
      L('类型', '社媒营销短视频'),
      L('商品', brief.product),
      L('品类', brief.category),
      L('核心卖点', points),
      L('目标人群', brief.audience),
      L('转化目标', GOALS[brief.goal]),
      L('投放平台', brief.platform),
      L('目标时长', `${brief.duration}s`),
      L('品牌色', brief.brand.color || '未指定（花字/CTA 用默认品牌主色位）'),
      L('CTA', brief.ctaText || '平台默认（TikTok: Follow for more · Link in bio）'),
      L('英雄照', brief.productHero && brief.productHero.heroImageId ? `实拍绑定 ${brief.productHero.heroImageId}` : '⚠️ 未绑定（渲染前必须补齐）'),
      brief.competitor ? L('竞品参照', brief.competitor) : null,
      '╠══════════════════════════════════════════╣',
      '║ 结构铁律:                                ║',
      '║ 1. 前 2-3 秒钩子窗口，商品/冲突在场      ║',
      '║ 2. 卖点 ≤3，每镜至多承接 1 个卖点花字    ║',
      '║ 3. 尾镜 CTA 收尾字强制在场               ║',
      '║ 4. 画面文字三层：字幕条/卖点花字/CTA     ║',
      '║ 5. 合规红线：零极限词、零欺骗性宣称      ║',
      '║ 6. 作品必须含片头镜头（主/副标题+动效）  ║',
      '║ 7. 事实红线：创意前提不得与产品真实矛盾  ║',
      '║ 8. 镜头时长经分配器产出，禁止手写均分    ║',
      '╚══════════════════════════════════════════╝'
    ].filter(Boolean).join('\n');
  }
}

module.exports = { MarketingBriefParser, GOALS };
