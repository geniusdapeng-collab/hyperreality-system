/**
 * 【v6.2-patch51】结尾镜情绪增强器
 * 【v6.2-patch63-fix】修复【视觉】标记边界污染问题
 * ClosingShotEmotionalBooster
 *
 * 产品机制：识别结尾/余韵/高潮镜，自动注入情绪增强关键词和光影描述。
 * 解决「结尾镜Prompt质感评分偏低」的系统性问题。
 *
 * 挂载点：NirathMasterPipeline Stage 11（渲染核心）中，Prompt生成后
 *
 * 核心逻辑：
 * 1. 识别结尾类型镜头（closing/resolution/余韵）
 * 2. 检测当前情绪描述密度
 * 3. 自动注入情绪关键词（温柔/信任/释然/温暖等）
 * 4. 增强光影描述（暖色调递进/光晕扩散/柔和边缘等）
 * 5. 增加空间深度描述（环境呼应开场但已重生/改变）
 */

class ClosingShotEmotionalBooster {
  constructor(config = {}) {
    this.config = {
      // 结尾镜类型
      closingTypes: ['closing', 'resolution', 'resonance', '余韵', 'resolve', 'climax', '高潮', 'ending', 'finale'],
      // 情绪关键词库（按情绪层级）
      emotionKeywords: {
        gentle: ['温柔', '柔和', '轻盈', '细腻', '恬静', '安宁'],
        trust: ['信任', '接纳', '敞开', '不设防', '坦然', '安心'],
        release: ['释然', '放下', '解脱', '轻盈', '自由', '舒展'],
        warmth: ['温暖', '治愈', '融化', '拥抱', '依偎', '陪伴'],
        transcendence: ['升华', '超越', '蜕变', '新生', '绽放', '觉醒'],
        quiet: ['宁静', '静谧', '沉寂', '无声', '凝固', '永恒']
      },
      // 光影增强描述
      lightEnhancements: [
        '暖金色光芒从双恒星洒落，在角色身上形成柔和光晕',
        '光影边缘柔和虚化，如梦境般朦胧',
        '暖色调从琥珀色渐变为淡金色，温度感递进',
        '环境光反射在角色瞳孔中，形成微小光斑',
        '逆光轮廓光勾勒角色边缘，神圣而温暖'
      ],
      // 空间深度增强
      spaceEnhancements: [
        '远景环境呼应开场但已重生/改变，形成叙事闭环',
        '背景细节暗示时间的流逝和变化',
        '环境从冷色调渐变为暖色调，暗示情感转变',
        '远景中出现之前镜头的呼应元素，形成视觉回声'
      ],
      // 情绪密度阈值（每100字符中至少出现N个情绪词）
      emotionDensityThreshold: 2,
      // 最大注入次数
      maxInjectionsPerShot: 3,
      // 注入位置标记
      injectMarkers: ['【视觉】', '【环境布景】', '【技术规格】'],
      ...config
    };

    this.boosterLog = [];
  }

  /**
   * 主入口：增强结尾镜情绪
   * @param {Object} renderResult - 渲染结果（含prompt）
   * @param {Object} shot - 镜头信息
   * @returns {Object} 增强后的结果 + 报告
   */
  boost(renderResult, shot) {
    const shotType = shot.type || shot.beatName || '';

    // 检查是否是结尾镜
    if (!this.isClosingShot(shotType)) {
      return { result: renderResult, enhanced: false, reason: '非结尾镜，跳过' };
    }

    let prompt = renderResult.prompt || '';
    this.boosterLog = [];
    let injections = 0;

    // 1. 检测当前情绪密度
    const emotionDensity = this.detectEmotionDensity(prompt);

    // 2. 如果情绪密度不足，注入情绪关键词
    if (emotionDensity < this.config.emotionDensityThreshold) {
      const emotionInjection = this.injectEmotionKeywords(prompt, shot);
      if (emotionInjection.success) {
        prompt = emotionInjection.prompt;
        injections++;
        this.boosterLog.push({
          type: 'emotion',
          keywords: emotionInjection.keywords,
          density: emotionInjection.newDensity
        });
      }
    }

    // 3. 检测光影描述
    const hasLightDescription = this.config.lightEnhancements.some(
      light => prompt.includes(light.substring(0, 20))
    );

    if (!hasLightDescription && injections < this.config.maxInjectionsPerShot) {
      const lightInjection = this.injectLightEnhancement(prompt, shot);
      if (lightInjection.success) {
        prompt = lightInjection.prompt;
        injections++;
        this.boosterLog.push({
          type: 'light',
          description: lightInjection.description
        });
      }
    }

    // 4. 检测空间深度描述
    const hasSpaceDescription = this.config.spaceEnhancements.some(
      space => prompt.includes(space.substring(0, 20))
    );

    if (!hasSpaceDescription && injections < this.config.maxInjectionsPerShot) {
      const spaceInjection = this.injectSpaceEnhancement(prompt, shot);
      if (spaceInjection.success) {
        prompt = spaceInjection.prompt;
        injections++;
        this.boosterLog.push({
          type: 'space',
          description: spaceInjection.description
        });
      }
    }

    // 5. 特殊处理：静默高潮标记
    if (shot.isSilentClimax || shot.narration?.includes('静默高潮')) {
      const silentBoost = this.boostSilentClimax(prompt, shot);
      if (silentBoost.success) {
        prompt = silentBoost.prompt;
        injections++;
        this.boosterLog.push({
          type: 'silent',
          description: silentBoost.description
        });
      }
    }

    const enhancedResult = { ...renderResult, prompt };

    return {
      result: enhancedResult,
      enhanced: injections > 0,
      injections,
      emotionDensity: this.detectEmotionDensity(prompt),
      log: this.boosterLog,
      report: {
        shotId: shot.id || shot.shotId,
        type: shotType,
        originalDensity: emotionDensity,
        finalDensity: this.detectEmotionDensity(prompt),
        injections,
        details: this.boosterLog
      }
    };
  }

  /**
   * 判断是否为结尾镜
   */
  isClosingShot(shotType) {
    if (!shotType) return false;
    const type = shotType.toLowerCase();
    return this.config.closingTypes.some(ct => type.includes(ct.toLowerCase()));
  }

  /**
   * 检测情绪密度（每100字符的情绪词数量）
   */
  detectEmotionDensity(prompt) {
    const allEmotions = Object.values(this.config.emotionKeywords).flat();
    let count = 0;
    for (const emotion of allEmotions) {
      if (prompt.includes(emotion)) {
        count++;
      }
    }
    return (count / prompt.length) * 100;
  }

  /**
   * 注入情绪关键词
   */
  injectEmotionKeywords(prompt, shot) {
    // 根据shot情绪选择最合适的情绪层级
    const shotEmotion = shot.emotion || shot.emotionState || 'warmth';
    let targetEmotion = 'warmth';

    if (shotEmotion.includes('tension') || shotEmotion.includes('紧张')) targetEmotion = 'trust';
    if (shotEmotion.includes('sad') || shotEmotion.includes('悲伤')) targetEmotion = 'release';
    if (shotEmotion.includes('awe') || shotEmotion.includes('敬畏')) targetEmotion = 'transcendence';
    if (shotEmotion.includes('quiet') || shotEmotion.includes('安静')) targetEmotion = 'quiet';

    const keywords = this.config.emotionKeywords[targetEmotion] || this.config.emotionKeywords.warmth;
    const selected = keywords.slice(0, 2); // 选择2个关键词

    // 在【视觉】或【叙事】后插入
    const insertMarker = prompt.includes('【视觉】') ? '【视觉】' : '【叙事】';
    const markerIndex = prompt.indexOf(insertMarker);

    let newPrompt;
    if (markerIndex >= 0) {
      // v6.2-patch63-fix: 找到【视觉】区块的结束位置（下一个【或行尾），在区块末尾插入
      const blockStart = markerIndex + insertMarker.length;
      const nextBlockIndex = prompt.indexOf('【', blockStart);
      const insertPos = nextBlockIndex >= 0 ? nextBlockIndex : prompt.length;
      newPrompt = prompt.substring(0, insertPos) +
        '。情绪氛围：' + selected.join('、') +
        prompt.substring(insertPos);
    } else {
      // 默认在prompt开头插入
      newPrompt = '情绪基调：' + selected.join('、') + '。' + prompt;
    }

    return {
      success: true,
      prompt: newPrompt,
      keywords: selected,
      newDensity: this.detectEmotionDensity(newPrompt)
    };
  }

  /**
   * 注入光影增强
   */
  injectLightEnhancement(prompt, shot) {
    const light = this.config.lightEnhancements[
      Math.floor(Math.random() * this.config.lightEnhancements.length)
    ];

    // 在【环境布景】后或【明亮约束】前插入
    const insertMarker = prompt.includes('【环境布景】') ? '【环境布景】' :
                         prompt.includes('【明亮约束】') ? '【明亮约束】' : null;

    let newPrompt;
    if (insertMarker) {
      const markerIndex = prompt.indexOf(insertMarker);
      // 找到标记行的末尾
      const lineEnd = prompt.indexOf('\n', markerIndex);
      const insertPos = lineEnd > 0 ? lineEnd : markerIndex + insertMarker.length;
      newPrompt = prompt.substring(0, insertPos) + '\n【光影增强】' + light + '\n' + prompt.substring(insertPos);
    } else {
      newPrompt = prompt + '\n【光影增强】' + light;
    }

    return {
      success: true,
      prompt: newPrompt,
      description: light
    };
  }

  /**
   * 注入空间深度增强
   */
  injectSpaceEnhancement(prompt, shot) {
    const space = this.config.spaceEnhancements[
      Math.floor(Math.random() * this.config.spaceEnhancements.length)
    ];

    // 在【视觉】后插入
    const insertMarker = prompt.includes('【视觉】') ? '【视觉】' : '【叙事】';
    const markerIndex = prompt.indexOf(insertMarker);

    let newPrompt;
    if (markerIndex >= 0) {
      const lineEnd = prompt.indexOf('\n', markerIndex);
      const insertPos = lineEnd > 0 ? lineEnd : markerIndex + insertMarker.length;
      newPrompt = prompt.substring(0, insertPos) + '\n【空间深度】' + space + '\n' + prompt.substring(insertPos);
    } else {
      newPrompt = prompt + '\n【空间深度】' + space;
    }

    return {
      success: true,
      prompt: newPrompt,
      description: space
    };
  }

  /**
   * 静默高潮特殊增强
   */
  boostSilentClimax(prompt, shot) {
    const silentDescriptions = [
      '时间仿佛静止，只有光线在缓慢流动',
      '无声中，情感的重量比任何语言都更清晰',
      '画面凝固在最具张力的瞬间，留白给观者感受',
      '没有台词，只有呼吸声和环境的细微声响',
      '角色的眼神和微表情成为唯一的叙事语言'
    ];

    const desc = silentDescriptions[Math.floor(Math.random() * silentDescriptions.length)];

    // 在【⚠️静默高潮】标记后插入
    const marker = '【⚠️静默高潮';
    const markerIndex = prompt.indexOf(marker);

    let newPrompt;
    if (markerIndex >= 0) {
      const insertPos = markerIndex + marker.length;
      newPrompt = prompt.substring(0, insertPos) + '：' + desc + '\n' + prompt.substring(insertPos);
    } else {
      newPrompt = '【⚠️静默高潮】' + desc + '\n' + prompt;
    }

    return {
      success: true,
      prompt: newPrompt,
      description: desc
    };
  }
}

module.exports = { ClosingShotEmotionalBooster };
