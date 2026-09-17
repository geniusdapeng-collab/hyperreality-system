/**
 * Commercial Mode Enhancer — 商业化模式增强 (SuperMickey 适配版)
 *
 * 融入点: Layer 2 (制作引擎后) 或 Layer 4 (后期引擎)
 * 可选模式：在 options.commercialMode 启用时注入
 *
 * 核心能力：
 * 1. 品牌元素注入（logo位置、品牌色、产品展示）
 * 2. 广告法合规检查（极限词、虚假宣传）
 * 3. 投放平台适配（抖音/快手/B站等）
 * 4. 目标受众匹配度分析
 */

class CommercialModeEnhancer {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.platform = options.platform || 'douyin'; // douyin, kuaishou, bilibili, xiaohongshu
    this.brandConfig = options.brandConfig || null;
    
    // 广告法极限词库
    this.forbiddenWords = [
      '最', '第一', '顶级', '国家级', '最高级', '最佳', '唯一', '首创',
      '绝对', '万能', '永久', '100%', '保证', '承诺', '无效退款'
    ];
    
    // 平台适配规则
    this.platformRules = {
      douyin: {
        aspectRatio: '9:16',
        duration: { min: 3, max: 60 },
        textStyle: 'large_bold',
        hookRequirement: '前3秒必须出现产品或品牌'
      },
      kuaishou: {
        aspectRatio: '9:16',
        duration: { min: 3, max: 120 },
        textStyle: 'friendly_casual',
        hookRequirement: '前5秒必须有冲突或反转'
      },
      bilibili: {
        aspectRatio: '16:9',
        duration: { min: 15, max: 300 },
        textStyle: 'anime_inspired',
        hookRequirement: '前10秒必须有核心内容预览'
      },
      xiaohongshu: {
        aspectRatio: '3:4',
        duration: { min: 5, max: 180 },
        textStyle: 'lifestyle_elegant',
        hookRequirement: '前3秒必须有高颜值画面'
      }
    };
  }

  /**
   * 主入口：增强 shots 的商业化元素
   * @param {Array} shots - shots 数组
   * @param {Object} options - { brandConfig, platform }
   * @returns {Object} { shots, enhancements, complianceReport }
   */
  enhance(shots, options = {}) {
    if (!this.enabled || !shots || shots.length === 0) {
      return { shots, enhancements: [], complianceReport: { passed: true, issues: [] } };
    }

    const platform = options.platform || this.platform;
    const brandConfig = options.brandConfig || this.brandConfig;
    const platformRule = this.platformRules[platform] || this.platformRules.douyin;

    console.log(`\n📺 [CommercialMode] 商业化模式增强 (${platform})...`);

    const enhancements = [];
    const complianceIssues = [];

    for (let i = 0; i < shots.length; i++) {
      const shot = shots[i];
      const shotEnhancement = {
        shotId: shot.shotId || i,
        brandElements: [],
        platformOptimizations: [],
        complianceChecks: []
      };

      // 1. 品牌元素注入
      if (brandConfig) {
        const brandEls = this._injectBrandElements(shot, brandConfig);
        shotEnhancement.brandElements = brandEls;
        
        // 将品牌元素注入到 shot 的 prompt 中
        for (const el of brandEls) {
          if (el.type === 'brand_color' && shot.lighting) {
            shot.lighting = `${shot.lighting}, ${el.description}`;
          }
          if (el.type === 'product_showcase' && shot.action) {
            shot.action = `${shot.action}, ${el.description}`;
          }
        }
      }

      // 2. 广告法合规检查
      const text = `${shot.prompt || ''} ${shot.description || ''} ${shot.action || ''}`;
      for (const word of this.forbiddenWords) {
        if (text.includes(word)) {
          complianceIssues.push({
            shotId: shot.shotId || i,
            word,
            suggestion: `替换为更中性的表达，避免使用"${word}"`
          });
          shotEnhancement.complianceChecks.push({
            type: 'forbidden_word',
            word,
            status: 'warning',
            suggestion: `替换为更中性的表达`
          });
        }
      }

      // 3. 平台适配优化
      const platformOpts = this._optimizeForPlatform(shot, platformRule, i);
      shotEnhancement.platformOptimizations = platformOpts;

      enhancements.push(shotEnhancement);
    }

    const compliancePassed = complianceIssues.length === 0;

    console.log(`   ✅ 商业化增强完成: ${enhancements.length} 个镜头`);
    if (!compliancePassed) {
      console.warn(`   ⚠️ 合规警告: ${complianceIssues.length} 项`);
      for (const issue of complianceIssues.slice(0, 3)) {
        console.warn(`      • Shot ${issue.shotId}: 禁用词"${issue.word}"`);
      }
    }
    console.log(`   平台适配: ${platform} | 比例: ${platformRule.aspectRatio}`);

    return {
      shots,
      enhancements,
      complianceReport: {
        passed: compliancePassed,
        issues: complianceIssues
      }
    };
  }

  _injectBrandElements(shot, brandConfig) {
    const elements = [];
    const { brandName, brandColor, logoPosition, productName } = brandConfig;

    if (brandColor) {
      elements.push({
        type: 'brand_color',
        description: `画面主色调调整为品牌色 ${brandColor}，增强品牌辨识度`
      });
    }

    if (logoPosition) {
      elements.push({
        type: 'logo_position',
        description: `品牌 Logo 置于画面${logoPosition}，保持可见但不遮挡主体`
      });
    }

    if (productName) {
      elements.push({
        type: 'product_showcase',
        description: `自然融入 ${productName} 产品展示，避免硬广感`
      });
    }

    if (brandName) {
      elements.push({
        type: 'brand_mention',
        description: `在合适时机提及品牌名"${brandName}"，增强记忆点`
      });
    }

    return elements;
  }

  _optimizeForPlatform(shot, platformRule, index) {
    const optimizations = [];

    // 前3秒钩子检查
    if (index < 3 && platformRule.hookRequirement) {
      optimizations.push({
        type: 'hook_check',
        description: platformRule.hookRequirement
      });
    }

    // 时长检查
    const duration = shot.duration || 5;
    if (duration < platformRule.duration.min) {
      optimizations.push({
        type: 'duration_warning',
        description: `时长 ${duration}s 低于平台最小 ${platformRule.duration.min}s`
      });
    }
    if (duration > platformRule.duration.max) {
      optimizations.push({
        type: 'duration_warning',
        description: `时长 ${duration}s 超过平台最大 ${platformRule.duration.max}s`
      });
    }

    return optimizations;
  }
}

module.exports = { CommercialModeEnhancer };
