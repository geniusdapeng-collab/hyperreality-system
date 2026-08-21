'use strict';

/**
 * ProductHeroDesigner（商品定妆照设计器）
 * ------------------------------------------------------------
 * 【v2.6.0 新增】社媒营销包 SocialPack · P1-4
 *
 * 复用角色定妆照机制，为商品建立"英雄照绑定"体系：
 * 营销片的转化可信度来自商品真实感——UI 截图/产品实拍必须绑定，
 * 禁止渲染层虚构商品外观（虚构 UI 是营销片翻车头号原因）。
 *
 * 三层锚点（守卫可校验的硬规则）：
 *   1) 英雄照绑定  —— 实拍素材编号（heroImageId），格式 [A-Z0-9]+-[A-Z]+-\d{3}
 *   2) 材质/LOGO 锚点 —— 材质质感描述 + LOGO 位置与最小画面占比
 *   3) 卖点特写锚点 —— 与镜头承接卖点对应的特写动作/部位
 *
 * 跨镜头一致性：【商品一致性】字段锁定 LOGO 位置/英雄照角度/配色，
 * 同一 Brief 的 N 个镜头商品外观不得漂移。
 *
 * 输入：brief.productHero = {
 *   heroImageId: 'QW-HERO-001'（必填，实拍绑定；缺失时 normalize 记 issue）
 *   materials: ['磨砂玻璃质感UI卡片', ...],
 *   logo: { position: '界面左上角', minSizePct: 5 },
 *   closeups: ['生成按钮按下瞬间', '翻页动效']（卖点特写候选，按镜头卖点轮换）
 * }
 */

class ProductHeroDesigner {
  /** 英雄照绑定编号格式（实拍素材库编号纪律） */
  static HERO_ID_PATTERN = /^[A-Z0-9]+-[A-Z]+-\d{3}$/;

  /**
   * 【v2.10.0 新增】商品类型判定：服务/虚拟/软件类无实物外观，
   * 锚点文案按类型变形（实物=英雄照/材质锚点；服务=品牌视觉资产/视觉识别锚点）。
   * 判定依据：productHero.assetType 显式声明 > brief.category 模糊归类 > 默认实物
   */
  _productKind(brief = {}) {
    const hero = brief.productHero || {};
    if (hero.assetType) {
      return /service|virtual|brand/i.test(hero.assetType) ? 'service' : 'physical';
    }
    const cat = String(brief.category || '');
    if (/服务|课程|培训|咨询|旅游|本地生活|到店|家政|维修|金融|保险|医疗|医美|健身|教育|软件|SaaS|APP|App|应用|平台|办公|云/.test(cat)) {
      return 'service';
    }
    return 'physical';
  }

  /**
   * 生成【商品锚点】字段（实物与服务/虚拟类双形态，锚点纪律两类通用）
   * @param {object} shot 镜头数据（shotId/sellingPoint）
   * @param {object} brief 营销 Brief（product/productHero）
   * @returns {{fieldText:string, anchors:object}}
   */
  designAnchor(shot = {}, brief = {}) {
    const hero = brief.productHero || {};
    const product = brief.product || '商品';
    const heroId = hero.heroImageId || '待绑定';
    const materials = (hero.materials && hero.materials.length ? hero.materials : null);
    const logo = hero.logo || {};
    const logoPos = logo.position || '画面内商品主体上';
    const logoPct = Number(logo.minSizePct) > 0 ? Number(logo.minSizePct) : 5;
    const closeup = this._pickCloseup(shot, hero);
    const kind = this._productKind(brief);

    const anchors = { heroImageId: heroId, materials: (materials || []).join('、'), logoPosition: logoPos, logoMinSizePct: logoPct, closeup, kind };
    let fieldText;
    if (kind === 'service') {
      // 服务/虚拟类：品牌视觉资产绑定（品牌物料/界面/门店/人员实拍），锚点=视觉识别元素
      fieldText = [
        `${product}品牌视觉资产绑定（${heroId}），禁止虚构品牌视觉与界面元素`,
        `视觉识别锚点：${materials ? materials.join('、') : '品牌色/LOGO/官方界面'}`,
        `LOGO锚点：${logoPos}，占画面不小于 ${logoPct}%`,
        `卖点特写锚点：${closeup}`
      ].join('；');
    } else {
      // 实物类：英雄照实拍绑定，锚点=材质
      fieldText = [
        `${product}英雄照实拍绑定（${heroId}），禁止虚构商品外观与 UI 元素`,
        `材质锚点：${materials ? materials.join('、') : '商品真实材质'}`,
        `LOGO锚点：${logoPos}，占画面不小于 ${logoPct}%`,
        `卖点特写锚点：${closeup}`
      ].join('；');
    }
    return { fieldText, anchors };
  }

  /**
   * 生成【商品一致性】字段（跨镜头锁定，按商品类型变形）
   */
  designConsistency(brief = {}) {
    const hero = brief.productHero || {};
    const logo = hero.logo || {};
    const logoPos = logo.position || '画面内商品主体上';
    const heroId = hero.heroImageId || '待绑定';
    const kind = this._productKind(brief);
    if (kind === 'service') {
      return `全片品牌视觉一致性锁定：视觉资产统一绑定 ${heroId}，LOGO 固定${logoPos}，界面/品牌配色与视觉资产角度跨镜一致，禁止同片出现第二套品牌视觉`;
    }
    return `全片商品一致性锁定：英雄照统一绑定 ${heroId}，LOGO 固定${logoPos}，界面配色与英雄照角度跨镜一致，禁止同片出现第二种商品外观`;
  }

  /** 按镜头承接卖点轮换特写锚点（语义优先 + hash 兜底，保持确定性） */
  _pickCloseup(shot, hero) {
    const closeups = Array.isArray(hero.closeups) ? hero.closeups.filter(Boolean) : [];
    if (!closeups.length) return '商品核心功能区特写';
    // 【v2.9.0-fix】语义优先：镜头卖点/场景/动作文本命中特写关键词时直接对齐，
    // 避免"换电池镜头分到摄像头开孔"式的语义错位；无命中回退确定性轮换
    const semantic = `${shot.sellingPoint || ''}|${shot.scene || ''}|${shot.action || ''}`;
    const hit = closeups.find(c =>
      String(c).split(/[、/]/).some(k => k.length >= 2 && semantic.includes(k)));
    if (hit) return hit;
    const h = String(shot.shotId || 'S0').split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    return closeups[h % closeups.length];
  }
}

module.exports = { ProductHeroDesigner };
