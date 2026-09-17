/**
 * 异兽类型分类体系
 * Beast Type Classification System
 * 
 * 功能：将山海经异兽分为神兽/凶兽/奇兽三类，分别赋予不同的质感/视觉锚点
 * 原则：基于原文描述+文化属性自动推断类型，不人工指定
 * 
 * v1.0 设计原则：
 * - 原文关键词自动映射类型
 * - 每类有默认质感模板（可覆盖）
 * - 类型决定Prompt基础风格，不决定具体特征
 */

class BeastTypeClassifier {
  constructor() {
    // 类型→默认质感映射
    this.TYPE_TEMPLATES = {
      'sacred': {
        // 神兽：毛发/光泽/优雅/温暖
        name: '神兽',
        bodyTexture: '毛发覆盖，丝滑光泽，柔软蓬松',
        skinQuality: '皮肤细腻，毛孔微小，有生物荧光纹路',
        aura: '神圣光环，温暖光芒，令人心生敬畏',
        colorTendency: '明亮色系，金银白为主',
        examples: ['九尾狐', '凤凰', '白泽', '麒麟']
      },
      'ferocious': {
        // 凶兽：皮肤/角质/压迫/危险
        name: '凶兽',
        bodyTexture: '粗糙表皮，角质突起，肌肉紧绷',
        skinQuality: '皮肤厚实，有伤疤/裂纹，暗色血管隐约可见',
        aura: '压迫感，危险气息，吞噬欲望',
        colorTendency: '暗色系，黑红青铜为主',
        examples: ['饕餮', '穷奇', '梼杌', '混沌']
      },
      'strange': {
        // 奇兽：混合/变异/诡异/独特
        name: '奇兽',
        bodyTexture: '混合质感，部分毛发部分皮肤，不规则纹理',
        skinQuality: '皮肤变异，有不自然突起或凹陷，颜色斑驳',
        aura: '诡异感，不可名状，超出认知',
        colorTendency: '斑驳色系，多种颜色混杂',
        examples: ['刑天', '相柳', '巴蛇']
      }
    };

    // 类型推断关键词（从原文提取）
    this.TYPE_KEYWORDS = {
      'sacred': ['祥瑞', '神圣', '通灵', '洁白', '金色', '九尾', '凤', '麟', '泽', '吉', '瑞', '仙'],
      'ferocious': ['食人', '凶', '恶', '饕餮', '穷奇', '梼杌', '混沌', '吞噬', '贪婪', '残忍', '暴'],
      'strange': ['无头', '九首', '人面蛇身', '鸟身龙首', '异', '怪', '奇', '刑天', '相柳']
    };
  }

  /**
   * 基于异兽档案自动推断类型
   * @param {Object} beastProfile - 异兽档案（v3.0标准）
   * @returns {string} 类型标识：sacred/ferocious/strange
   */
  classify(beastProfile) {
    const { name, category, origin, abilities, personality, culturalMapping } = beastProfile;
    
    // 组合所有文本进行关键词匹配
    const allText = [
      name, category, origin,
      ...(abilities || []),
      ...(personality?.traits || []),
      culturalMapping || '',
      JSON.stringify(beastProfile.visualAnchors || {})
    ].join(' ');

    // 统计每类关键词命中次数
    const scores = {
      sacred: 0,
      ferocious: 0,
      strange: 0
    };

    for (const [type, keywords] of Object.entries(this.TYPE_KEYWORDS)) {
      for (const kw of keywords) {
        const regex = new RegExp(kw, 'gi');
        const matches = allText.match(regex);
        if (matches) {
          scores[type] += matches.length;
        }
      }
    }

    // 额外加权：category字段直接匹配
    if (category?.includes('凶')) scores.ferocious += 3;
    if (category?.includes('神')) scores.sacred += 3;
    if (category?.includes('瑞')) scores.sacred += 3;
    if (category?.includes('异')) scores.strange += 2;

    // 取最高分的类型
    const maxType = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
    
    return {
      type: maxType[0], // sacred/ferocious/strange
      score: maxType[1],
      allScores: scores,
      template: this.TYPE_TEMPLATES[maxType[0]],
      confidence: maxType[1] > 0 ? 'high' : 'low'
    };
  }

  /**
   * 获取类型的默认质感描述
   */
  getDefaultTexture(type) {
    const template = this.TYPE_TEMPLATES[type];
    if (!template) return null;
    return {
      bodyTexture: template.bodyTexture,
      skinQuality: template.skinQuality,
      aura: template.aura,
      colorTendency: template.colorTendency
    };
  }

  /**
   * 批量分类（用于批量处理40只异兽）
   */
  batchClassify(beastProfiles) {
    const results = {};
    for (const profile of beastProfiles) {
      results[profile.id || profile.name] = this.classify(profile);
    }
    return results;
  }
}

module.exports = { BeastTypeClassifier };
