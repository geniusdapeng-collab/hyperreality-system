#!/usr/bin/env node
/**
 * 【P0】世界观一致性引擎 — Worldview Consistency Engine v1.0
 * 
 * 职责：确保每集视频的异兽呈现、场景美学、叙事口吻
 *       都和山海经/Nirath世界观严格对齐
 * 
 * 位置：导演系统生成剧集计划后，剧本生成前
 * 角色：自动守门员 + 文化基因注入器
 */

const fs = require('fs');
const path = require('path');

// ========== 配置层 ==========
const WORLDVIEW_CONFIG = {
  // 山海经世界观锚点
  shanhaijing: {
    // 原文引用（用于Prompt直接嵌入）
    // 支持拼音ID（zhuLong/nuanNuan等）和中文名（烛龙/帝江等）双索引
    originalTexts: {
      // 中文名索引
      '帝江': '天山有神焉，其状如黄囊，赤如丹火，六足四翼，浑敦无面目，是识歌舞',
      '白泽': '东望山有兽，名曰白泽，能言语，达万物之情',
      '旋龟': '怪水之中，多玄龟，鸟首虺尾',
      '九尾狐': '青丘之山有兽，其状如狐而九尾',
      '烛龙': '钟山之神，名曰烛阴，视为昼，瞑为夜，吹为冬，呼为夏',
      // 拼音ID索引（导演系统传参用）
      'zhuLong': '钟山之神，名曰烛阴，视为昼，瞑为夜，吹为冬，呼为夏',
      'nuanNuan': '天山有神焉，其状如黄囊，赤如丹火，六足四翼，浑敦无面目，是识歌舞',
      'xuanGui': '怪水之中，多玄龟，鸟首虺尾',
      'baiZe': '东望山有兽，名曰白泽，能言语，达万物之情',
      'jiuWeiHu': '青丘之山有兽，其状如狐而九尾'
    },
    // 文化基因词汇库
    culturalVocabulary: [
      '青丘', '钟山', '不周山', '昆仑', '弱水', '建木', '扶桑',
      '灵气', '祥瑞', '镇守', '觉醒', '归元', '混沌', '太素',
      '云雾缭绕', '古木参天', '飞瀑流泉', '瑞光', '霞光'
    ],
    // 禁止词汇（西方/现代科技）
    // 注意：使用完整词汇匹配，避免误伤正常中文词汇
    forbiddenVocabulary: [
      '城堡', '教堂', '骑士', '魔法阵', '女巫', '吸血鬼', '狼人',
      '机器人', '赛博朋克', '全息投影', '激光', '机甲', '太空舱',
      '欧美', '美式', '西方', '西洋', '欧洲', '美式风格',
      '哥特', '巴洛克', '洛可可',
      '魔法师', '魔法棒', '魔杖', '魔咒'
    ]
  },
  
  // Nirath科技废墟锚点
  nirath: {
    // 科技废墟元素（用于场景注入）
    techRuins: [
      '半埋在藤蔓中的青铜机械装置',
      '长满苔藓的金属管道系统',
      '断裂的水晶能量柱（微光闪烁）',
      '风化的合金石碑（刻有未知符号）',
      '被植被覆盖的圆形拱门结构',
      '锈迹斑斑的齿轮组（与树根缠绕）',
      '半透明的能量残余（空气中漂浮）'
    ],
    // 色彩系统
    colorPalette: {
      primary: ['琥珀金', '青丘碧', '太素银', '丹火赤'],
      secondary: ['藤蔓绿', '苔藓灰', '水晶紫', '古铜棕'],
      forbidden: ['霓虹粉', '电子蓝', '荧光绿', '赛博紫']
    },
    // 生态逻辑
    ecology: {
      lightSource: ['双恒星', '发光苔藓', '水晶折射', '生物荧光'],
      waterSystem: ['液态汞湖泊', '弱水流', '灵泉', '飞瀑'],
      vegetation: ['荧光高草', '水晶树', '藤蔓网络', '孢子植物']
    }
  },
  
  // 叙事口吻锚定
  narrativeTone: {
    // 主角口吻（8岁男孩小G）
    protagonist: {
      style: '温柔、好奇、坚定',
      vocabulary: ['我想', '我觉得', '也许', '可能', '为什么', '如果'],
      forbidden: ['必须', '一定', '绝对', '毫无疑问', '显然']
    },
    // 叙事视角
    perspective: {
      type: '第一人称沉浸式',
      depth: '主观感受优先，客观描述辅助',
      emotion: '情绪外露，不隐藏脆弱'
    },
    // 核心主题句（每集必须出现）
    coreTheme: '记忆即存在。看见即救赎。'
  }
};

// ========== 一致性校验器 ==========
class WorldviewConsistencyChecker {
  constructor(config = WORLDVIEW_CONFIG) {
    this.config = config;
    this.issues = [];
  }

  /**
   * 全量校验入口
   * @param {Object} episodePlan - 剧集计划
   * @returns {Object} 校验结果
   */
  validate(episodePlan) {
    this.issues = [];
    
    // 1. 异兽外观校验
    this._validateBeastAppearance(episodePlan.beastId, episodePlan.acts);
    
    // 2. 场景美学校验
    this._validateSceneAesthetics(episodePlan.acts);
    
    // 3. 叙事口吻校验
    this._validateNarrativeTone(episodePlan.acts);
    
    // 4. 禁用词检查
    this._validateForbiddenWords(episodePlan);
    
    // 5. 核心主题句检查
    this._validateCoreTheme(episodePlan);
    
    return {
      valid: this.issues.length === 0,
      issues: this.issues,
      severity: this._calculateSeverity(),
      report: this._generateReport()
    };
  }

  /**
   * 异兽外观校验
   * 检查Prompt中是否包含山海经原文特征和Nirath设定
   */
  _validateBeastAppearance(beastId, acts) {
    if (!beastId) return;
    
    const originalText = this.config.shanhaijing.originalTexts[beastId];
    if (!originalText) {
      this.issues.push({
        type: 'beast_missing',
        level: 'ERROR',
        message: `异兽 "${beastId}" 未在山海经原文库中注册`,
        suggestion: '请在data/nirath-creature-data.js中添加该异兽的山海经原文'
      });
      return;
    }
    
    // 提取山海经关键特征
    const keyFeatures = this._extractKeyFeatures(originalText);
    
    // 检查每幕的Prompt是否包含这些特征
    acts.forEach((act, index) => {
      const actContent = JSON.stringify(act).toLowerCase();
      const missingFeatures = keyFeatures.filter(feature => 
        !actContent.includes(feature.toLowerCase())
      );
      
      if (missingFeatures.length > keyFeatures.length * 0.5) {
        this.issues.push({
          type: 'beast_feature_missing',
          level: 'WARNING',
          act: index + 1,
          message: `第${index + 1}幕缺少异兽"${beastId}"的关键特征`,
          missing: missingFeatures,
          suggestion: `应包含: ${keyFeatures.join(', ')}`
        });
      }
    });
  }

  /**
   * 场景美学校验
   * 检查场景描述是否包含Nirath科技废墟元素
   */
  _validateSceneAesthetics(acts) {
    acts.forEach((act, index) => {
      const actContent = JSON.stringify(act);
      
      // 检查是否包含Nirath元素
      const hasNirathElements = this.config.nirath.techRuins.some(ruin => 
        actContent.includes(ruin)
      );
      
      // 检查色彩系统
      const hasValidColors = this.config.nirath.colorPalette.primary.some(color =>
        actContent.includes(color)
      );
      
      // 检查禁用色彩
      const hasForbiddenColors = this.config.nirath.colorPalette.forbidden.some(color =>
        actContent.includes(color)
      );
      
      if (!hasNirathElements && index > 0) { // 第一幕可以纯自然
        this.issues.push({
          type: 'scene_nirath_missing',
          level: 'WARNING',
          act: index + 1,
          message: `第${index + 1}幕缺少Nirath科技废墟元素`,
          suggestion: '建议注入: ' + this.config.nirath.techRuins.slice(0, 3).join(', ')
        });
      }
      
      if (hasForbiddenColors) {
        this.issues.push({
          type: 'scene_forbidden_color',
          level: 'ERROR',
          act: index + 1,
          message: `第${index + 1}幕使用了禁用色彩`,
          forbidden: this.config.nirath.colorPalette.forbidden.filter(c => actContent.includes(c)),
          suggestion: `应使用: ${this.config.nirath.colorPalette.primary.join(', ')}`
        });
      }
    });
  }

  /**
   * 叙事口吻校验
   * 检查台词是否符合"8岁男孩情书"温柔基调
   */
  _validateNarrativeTone(acts) {
    acts.forEach((act, index) => {
      const narration = act.narration || '';
      if (!narration) return;
      
      // 检查主角口吻
      const hasProtagonistStyle = this.config.narrativeTone.protagonist.vocabulary.some(word =>
        narration.includes(word)
      );
      
      // 检查禁用词汇
      const usedForbidden = this.config.narrativeTone.protagonist.forbidden.filter(word =>
        narration.includes(word)
      );
      
      // 情绪外露检查（简单启发式）
      const emotionWords = ['觉得', '感觉', '喜欢', '害怕', '开心', '难过', '想'];
      const hasEmotion = emotionWords.some(word => narration.includes(word));
      
      if (usedForbidden.length > 0) {
        this.issues.push({
          type: 'tone_forbidden_word',
          level: 'WARNING',
          act: index + 1,
          message: `第${index + 1}幕台词使用了不适合8岁男孩的词汇`,
          words: usedForbidden,
          suggestion: '应使用更温柔、不确定性的表达'
        });
      }
      
      if (!hasEmotion && narration.length > 20) {
        this.issues.push({
          type: 'tone_emotion_missing',
          level: 'INFO',
          act: index + 1,
          message: `第${index + 1}幕台词情绪表达可加强`,
          suggestion: '建议加入主观感受词：我觉得、我想、我感觉'
        });
      }
    });
  }

  /**
   * 禁用词检查
   */
  _validateForbiddenWords(episodePlan) {
    const content = JSON.stringify(episodePlan);
    const foundForbidden = this.config.shanhaijing.forbiddenVocabulary.filter(word =>
      content.includes(word)
    );
    
    if (foundForbidden.length > 0) {
      this.issues.push({
        type: 'forbidden_word',
        level: 'ERROR',
        message: '检测到山海经世界观禁用词汇',
        words: foundForbidden,
        suggestion: '请替换为东方奇幻/Nirath风格词汇'
      });
    }
  }

  /**
   * 核心主题句检查
   */
  _validateCoreTheme(episodePlan) {
    const content = JSON.stringify(episodePlan);
    const theme = this.config.narrativeTone.coreTheme;
    
    if (!content.includes('记忆即存在') && !content.includes('看见即救赎')) {
      this.issues.push({
        type: 'core_theme_missing',
        level: 'WARNING',
        message: '剧集计划未包含核心主题句',
        theme: theme,
        suggestion: `建议在结尾或高潮部分加入: "${theme}"`
      });
    }
  }

  // ========== 辅助方法 ==========
  
  _extractKeyFeatures(originalText) {
    // 从山海经原文提取关键视觉特征
    const features = [];
    
    // 颜色
    const colorMatches = originalText.match(/赤|黄|青|白|黑|丹/g);
    if (colorMatches) features.push(...colorMatches);
    
    // 身体部位
    const bodyMatches = originalText.match(/足|翼|尾|首|面|目/g);
    if (bodyMatches) features.push(...bodyMatches);
    
    // 数量
    const numberMatches = originalText.match(/[一二三四五六七八九十]+/g);
    if (numberMatches) features.push(...numberMatches);
    
    // 特殊特征
    if (originalText.includes('无面目')) features.push('无面目');
    if (originalText.includes('识歌舞')) features.push('识歌舞');
    if (originalText.includes('能言语')) features.push('能言语');
    
    return [...new Set(features)]; // 去重
  }

  _calculateSeverity() {
    const errors = this.issues.filter(i => i.level === 'ERROR').length;
    const warnings = this.issues.filter(i => i.level === 'WARNING').length;
    const infos = this.issues.filter(i => i.level === 'INFO').length;
    
    if (errors > 0) return 'BLOCKING';
    if (warnings > 2) return 'HIGH';
    if (warnings > 0) return 'MEDIUM';
    if (infos > 0) return 'LOW';
    return 'PASS';
  }

  _generateReport() {
    const severity = this._calculateSeverity();
    const errors = this.issues.filter(i => i.level === 'ERROR');
    const warnings = this.issues.filter(i => i.level === 'WARNING');
    const infos = this.issues.filter(i => i.level === 'INFO');
    
    return {
      summary: `一致性检查: ${errors.length}错误, ${warnings.length}警告, ${infos.length}提示`,
      severity,
      canProceed: severity !== 'BLOCKING',
      recommendations: this._generateRecommendations()
    };
  }

  _generateRecommendations() {
    const recommendations = [];
    
    if (this.issues.some(i => i.type === 'scene_nirath_missing')) {
      recommendations.push('建议在所有幕中加入Nirath科技废墟元素，保持双重视觉');
    }
    
    if (this.issues.some(i => i.type === 'tone_emotion_missing')) {
      recommendations.push('建议加强台词情绪外露，体现8岁男孩的温柔与脆弱');
    }
    
    if (this.issues.some(i => i.type === 'core_theme_missing')) {
      recommendations.push('建议在剧集高潮部分加入核心主题句"记忆即存在。看见即救赎。"');
    }
    
    return recommendations;
  }
}

// ========== 文化基因注入器 ==========
class CulturalGeneInjector {
  constructor(config = WORLDVIEW_CONFIG) {
    this.config = config;
  }

  /**
   * 注入Nirath科技废墟元素到场景描述
   */
  injectNirathElements(sceneDescription, intensity = 'medium') {
    const elements = this.config.nirath.techRuins;
    const count = intensity === 'high' ? 3 : intensity === 'medium' ? 2 : 1;
    const selected = this._shuffle(elements).slice(0, count);
    
    return `${sceneDescription}，背景中${selected.join('，')}`;
  }

  /**
   * 注入色彩系统
   */
  injectColorPalette(prompt, palette = 'primary') {
    const colors = this.config.nirath.colorPalette[palette] || this.config.nirath.colorPalette.primary;
    const colorDesc = colors.slice(0, 2).join('与');
    
    return `${prompt}，整体色调以${colorDesc}为主`;
  }

  /**
   * 注入生态逻辑元素
   */
  injectEcologyElements(sceneDescription, type = 'mixed') {
    const { lightSource, waterSystem, vegetation } = this.config.nirath.ecology;
    
    const elements = [
      ...lightSource.slice(0, 1),
      ...waterSystem.slice(0, 1),
      ...vegetation.slice(0, 1)
    ];
    
    return `${sceneDescription}，${elements.join('，')}`;
  }

  /**
   * 强化主角口吻
   * 使用确定性选择（基于narration内容哈希）
   */
  enhanceProtagonistTone(narration) {
    // 在开头或结尾加入主观感受
    const prefixes = ['我觉得', '我想', '我感觉'];
    // 使用narration内容哈希进行确定性选择
    const hash = narration.split('').reduce((a, b) => a + b.charCodeAt(0), 0);
    const prefix = prefixes[hash % prefixes.length];
    
    if (!narration.includes('我')) {
      return `${prefix}，${narration}`;
    }
    
    return narration;
  }

  _shuffle(array) {
    // 使用确定性排序替代随机shuffle
    return [...array].sort((a, b) => {
      // 基于字符串内容的确定性排序
      const hashA = String(a).split('').reduce((sum, c) => sum + c.charCodeAt(0), 0);
      const hashB = String(b).split('').reduce((sum, c) => sum + c.charCodeAt(0), 0);
      return hashA - hashB;
    });
  }
}

// ========== 世界观一致性引擎主类 ==========
class WorldviewConsistencyEngine {
  constructor(config = WORLDVIEW_CONFIG) {
    this.config = config;
    this.checker = new WorldviewConsistencyChecker(config);
    this.injector = new CulturalGeneInjector(config);
  }

  /**
   * 处理剧集计划（校验 + 注入）
   * @param {Object} episodePlan - 原始剧集计划
   * @returns {Object} 处理后的剧集计划 + 校验报告
   */
  process(episodePlan) {
    console.log('🌍 世界观一致性引擎启动...');
    
    // 1. 校验
    const validation = this.checker.validate(episodePlan);
    console.log(`   ${validation.report.summary}`);
    console.log(`   严重级别: ${validation.severity}`);
    
    if (validation.severity === 'BLOCKING') {
      console.log('   ⛔ 阻塞性问题发现，请先修复后再继续');
      validation.issues.filter(i => i.level === 'ERROR').forEach(issue => {
        console.log(`   ❌ ${issue.message}`);
        if (issue.suggestion) console.log(`      💡 ${issue.suggestion}`);
      });
      return {
        episodePlan,
        validation,
        canProceed: false
      };
    }
    
    // 2. 注入文化基因
    const enhancedPlan = this._injectCulturalGenes(episodePlan);
    
    // 3. 输出报告
    console.log('   ✅ 世界观一致性处理完成');
    if (validation.issues.length > 0) {
      console.log('   ⚠️ 非阻塞性问题:');
      validation.issues.forEach(issue => {
        console.log(`      ${issue.level === 'WARNING' ? '⚠️' : 'ℹ️'} ${issue.message}`);
      });
    }
    
    return {
      episodePlan: enhancedPlan,
      validation,
      canProceed: true
    };
  }

  /**
   * 注入文化基因到剧集计划
   */
  _injectCulturalGenes(plan) {
    const enhanced = JSON.parse(JSON.stringify(plan)); // 深拷贝
    
    if (enhanced.acts) {
      enhanced.acts.forEach((act, index) => {
        // 为每幕注入Nirath元素
        if (act.description) {
          act.description = this.injector.injectNirathElements(
            act.description,
            index === 0 ? 'low' : 'medium' // 第一幕轻量注入
          );
        }
        
        // 注入色彩系统
        if (act.prompt) {
          act.prompt = this.injector.injectColorPalette(act.prompt);
        }
        
        // 强化台词口吻
        if (act.narration && act.narration.length > 10) {
          act.narration = this.injector.enhanceProtagonistTone(act.narration);
        }
      });
    }
    
    // 注入核心主题句（如果缺失）
    if (!JSON.stringify(enhanced).includes('记忆即存在')) {
      const lastAct = enhanced.acts?.[enhanced.acts.length - 1];
      if (lastAct) {
        lastAct.narration = lastAct.narration 
          ? `${lastAct.narration}。记忆即存在。看见即救赎。`
          : '记忆即存在。看见即救赎。';
      }
    }
    
    return enhanced;
  }

  /**
   * 快速校验（仅检查，不注入）
   */
  quickCheck(episodePlan) {
    return this.checker.validate(episodePlan);
  }

  /**
   * 获取配置
   */
  getConfig() {
    return this.config;
  }
}

// ========== 便捷导出 ==========
module.exports = {
  WorldviewConsistencyEngine,
  WorldviewConsistencyChecker,
  CulturalGeneInjector,
  WORLDVIEW_CONFIG,
  
  // 快捷方法
  process: (plan) => new WorldviewConsistencyEngine().process(plan),
  quickCheck: (plan) => new WorldviewConsistencyChecker().validate(plan)
};

// CLI测试入口
if (require.main === module) {
  console.log('🌍 世界观一致性引擎测试模式');
  
  // 模拟测试
  const engine = new WorldviewConsistencyEngine();
  const testPlan = {
    beastId: '帝江',
    acts: [
      {
        actNumber: 1,
        name: '相遇',
        description: '银色湖泊旁',
        narration: '小G看到了暖暖',
        prompt: '超写实CG渲染'
      }
    ]
  };
  
  const result = engine.process(testPlan);
  console.log('\n校验结果:', result.validation.report);
  console.log('能否继续:', result.canProceed);
}
