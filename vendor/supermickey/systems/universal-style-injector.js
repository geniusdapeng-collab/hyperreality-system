/**
 * 通用写实风格注入器
 * 自动检测并修正Prompt中的非写实风格词汇
 * 强制注入写实风格约束
 */

class UniversalStyleInjector {
  constructor(styleMode = 'universal-realistic') {
    this.styleMode = styleMode;
    this.bannedTerms = [
      // 卡通/动漫类
      '卡通', '动漫', '二次元', 'Q版', '萌系', 'chibi', 'kawaii',
      'cartoon', 'anime', 'manga', 'comic style', 'toon',
      // 奇幻类
      '奇幻', '魔法', '仙侠', '修仙', '神兽', '妖怪', '精灵',
      'fantasy', 'magical', 'fairy', 'mythical', 'creature',
      // 科幻/超现实类
      '科幻', '超现实', '未来主义', '赛博朋克', '霓虹',
      'sci-fi', 'cyberpunk', 'futuristic', 'neon',
      // 游戏类
      '游戏', '游戏化', 'UI元素', '血条', '技能特效',
      'game', 'gaming', 'hud', 'health bar', 'skill effect',
      // 过度美化类
      '完美无瑕', '瓷肌', '磨皮', '网红脸', '整容脸',
      'perfect skin', 'porcelain', 'plastic surgery',
      // 不自然特效类
      '发光', '粒子特效', '能量波动', '魔法光芒',
      'glowing', 'particles', 'energy wave', 'magic light',
      // 眼睛颜色禁忌（队长全局约束）
      '红眼睛', '红瞳', '血红眼', '赤瞳', '蓝眼睛', '蓝瞳', '黄眼睛', '金瞳', '绿眼睛', '绿瞳', '紫眼睛', '紫瞳', '橙眼睛', '荧光眼', '发光眼', '眼睛发光', '火光眼',
      'red eyes', 'blue eyes', 'yellow eyes', 'green eyes', 'purple eyes', 'orange eyes', 'glowing eyes', 'neon eyes', 'fluorescent eyes',
      // 水晶 — 全局禁用（v6.0-patch38新增）
      '水晶', '水晶矿脉', '水晶柱', '水晶簇', '晶体', '石英晶体', '六棱柱',
      'crystal', 'crystals', 'quartz', 'crystal cluster', 'crystal pillar',
      // 欧美化类（亚洲项目专用）
      '金发', '碧眼', '红发', '欧美',
      'blonde', 'blue eyes', 'red hair', 'western',
      // 其他
      '3D渲染', 'CG渲染', '3D动画',
      '3D render', 'CG render', '3D animation'
    ];
    
    // 🔥 新增：画面文字约束 - 禁止小字清晰可辨等描述
    this.bannedTextPatterns = [
      // 小字/详细文字
      '小字清晰', '文字清晰可辨', '印刷工整', '字迹清晰',
      '小字', '详细文字', '文字内容丰富', '文字说明详细',
      'small text', 'clearly readable', 'printed neatly',
      // 大量文字
      '各种文字', '大量文字', '文字密集', '满屏文字',
      'lots of text', 'dense text', 'full of text',
      // 具体文字内容描述
      '上面写着', '标注着', '写着', '显示着',
      '上面写着', '标注', '显示'
    ];
    
    // 🔥 新增：允许的大字描述（最多4-6个字）
    this.allowedBigText = [
      '健康知识讲堂', '运动康复', '健康科普',
      'health', 'tips', 'care'
    ];
    
    this.realisticPrefix = {
      indoor: '真实摄影风格，室内场景，自然光，纪录片质感，',
      outdoor: '真实摄影风格，户外场景，自然光，纪录片质感，',
      studio: '真实摄影风格，摄影棚场景，专业布光，纪录片质感，',
      default: '真实摄影风格，自然光，纪录片质感，'
    };
    
    this.realisticSuffix = '，写实电影摄影，高清画质，绝非卡通动漫，真实环境真实人物';
  }
  
  /**
   * 注入写实风格
   * @param {string} prompt - 原始Prompt
   * @param {Object} options - 选项
   * @returns {string} - 处理后的Prompt
   */
  inject(prompt, options = {}) {
    const originalLength = prompt.length;
    
    // 1. 风格合规检查
    const violations = this.checkViolations(prompt);
    if (violations.length > 0) {
      throw new Error(
        `【风格违规】Prompt包含非写实词汇：${violations.join('、')}\n` +
        `请修改后重新提交。详见 rules/UNIVERSAL_STYLE_RULES.md`
      );
    }
    
    // 🔥 新增：2. 画面文字约束检查
    const textViolations = this.checkTextViolations(prompt);
    if (textViolations.length > 0) {
      throw new Error(
        `【画面文字违规】Prompt包含过多小字描述：${textViolations.join('、')}\n` +
        `系统规则：\n` +
        `  ❌ 禁止：小字清晰可辨、印刷工整、文字内容丰富、详细文字说明等\n` +
        `  ✅ 允许：大背景少量大字（最多4-6个字，如"健康知识讲堂"）\n` +
        `  ✅ 建议：用视觉元素替代文字（示意图、图标、颜色对比）\n` +
        `请精简文字描述，改为视觉化表达。`
      );
    }
    
    // 3. 字数利用率检查（系统级保障）
    const utilization = this.checkUtilization(prompt, options);
    if (!utilization.isValid && utilization.status === '字数不足') {
      throw new Error(
        `【字数不足】当前Prompt ${originalLength}字，利用率 ${utilization.percentage}%\n` +
        `系统要求：每个镜头独立提交，字数应接近980字（建议950-980字）\n` +
        `请补充更多场景细节、光影描述、质感细节后再提交。`
      );
    }
    
    // 4. 删除边缘化非写实词汇（软处理）
    let cleaned = this.softClean(prompt);
    
    // 5. 注入写实前缀
    const sceneType = options.sceneType || 'default';
    const prefix = this.realisticPrefix[sceneType] || this.realisticPrefix.default;
    
    // 6. 注入写实后缀
    const suffix = this.realisticSuffix;
    
    // 7. 组合最终Prompt
    const finalPrompt = prefix + cleaned + suffix;
    
    // 8. 字数检查（上限）
    if (finalPrompt.length > 1500) {
      console.warn(`⚠️ 注入后Prompt超长: ${finalPrompt.length} > 1500，尝试压缩...`);
      return this.compress(finalPrompt, 1500);
    }
    
    return finalPrompt;
  }
  
  /**
   * 字数利用率检查
   * 系统级保障：每个镜头独立提交，应充分利用980字空间（英文字符上限）
   */
  checkUtilization(prompt, options = {}) {
    const length = prompt.length;
    const maxLength = options.maxLength || 1500;  // 统一为980英文字符上限
    const minLength = options.minLength || 1470; // 最低利用率门槛95%
    const percentage = Math.round((length / maxLength) * 100);
    
    return {
      length,
      maxLength,
      minLength,
      percentage,
      isValid: length >= minLength && length <= maxLength,
      status: length < minLength ? '字数不足' : (length > maxLength ? '超限' : '正常'),
      message: length < minLength 
        ? `⚠️ 字数利用率仅 ${percentage}%，建议补充至950-980字`
        : (length > maxLength 
            ? `❌ 超限 ${length - maxLength}字，需精简`
            : `✅ 利用率 ${percentage}%，符合要求`)
    };
  }
  
  /**
   * 🔥 新增：检查画面文字违规
   * 禁止小字清晰可辨等描述，只允许大背景少量大字
   */
  checkTextViolations(prompt) {
    const violations = [];
    for (const pattern of this.bannedTextPatterns) {
      if (prompt.includes(pattern)) {
        violations.push(pattern);
      }
    }
    return violations;
  }
  
  /**
   * 检查违规词汇
   */
  checkViolations(prompt) {
    const violations = [];
    for (const term of this.bannedTerms) {
      if (prompt.toLowerCase().includes(term.toLowerCase())) {
        violations.push(term);
      }
    }
    return violations;
  }
  
  /**
   * 软清理（删除轻微非写实描述）
   */
  softClean(prompt) {
    const softTerms = [
      '体积光', '丁达尔效应', '粒子', '梦幻', '唯美',
      '体积光', '神光', '粒子', '梦幻', '美感'
    ];
    
    let cleaned = prompt;
    for (const term of softTerms) {
      cleaned = cleaned.replace(new RegExp(term, 'gi'), '');
    }
    return cleaned;
  }
  
  /**
   * 压缩Prompt字数
   */
  compress(prompt, maxLength) {
    // 策略1：删除次要修饰
    let compressed = prompt
      .replace(/，画面细腻柔和/g, '')
      .replace(/，治愈感/g, '')
      .replace(/，温馨轻松/g, '')
      .replace(/，情绪沉重压抑/g, '')
      .replace(/，情绪危急紧迫/g, '')
      .replace(/，温暖希望氛围/g, '');
    
    // 策略2：删除重复描述
    if (compressed.length > maxLength) {
      compressed = compressed.replace(/，[^，]{10,20}，/g, '，');
    }
    
    // 最后手段：截断
    if (compressed.length > maxLength) {
      compressed = compressed.substring(0, maxLength);
    }
    
    return compressed;
  }
  
  /**
   * 验证Prompt是否合规
   */
  validate(prompt) {
    const violations = this.checkViolations(prompt);
    return {
      valid: violations.length === 0,
      violations: violations,
      message: violations.length > 0 
        ? `违规词汇：${violations.join('、')}` 
        : '风格合规'
    };
  }
}

module.exports = { UniversalStyleInjector };
