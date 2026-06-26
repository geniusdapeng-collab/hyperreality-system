/**
 * GlobalNegativePromptInjector - 全局负面提示词注入器
 * v2.1.5-fix: 为片头和内容镜头提供专用负面提示词生成
 */

class GlobalNegativePromptInjector {
  constructor() {
    // L1: 全局基础负面约束（所有镜头必加）
    this.L1 = [
      'low quality', 'blurry', 'distorted', 'deformed',
      'ugly', 'duplicate', 'watermark', 'signature',
      'text', 'logo', 'cropped', 'out of frame',
      'worst quality', 'normal quality', 'jpeg artifacts',
      'error', 'missing fingers', 'extra digit',
      'fewer digits', 'mutation', ' mutated',
      'extra limbs', 'extra arms', 'extra legs',
      'malformed limbs', 'fused fingers', 'too many fingers',
      'long neck', 'cross-eyed', 'blurred eyes',
      'bad face', 'asymmetric eyes', 'bad mouth'
    ];

    // L2: 角色相关负面约束（有人物时加）
    this.L2 = [
      'bad anatomy', 'disfigured', 'poorly drawn face',
      'cloned face', 'disconnected limbs', 'missing arms',
      'missing legs', 'extra foot', 'bad knee',
      'extra knees', 'more than 2 legs', 'more than 2 arms',
      'malformed knees', 'deformed legs', 'bad tail',
      'fused knee', 'fused leg', 'fused ankle'
    ];

    // L3: 画面质量负面约束（高质量要求时加）
    this.L3 = [
      'oversaturated', 'underexposed', 'overexposed',
      'bad contrast', 'flat lighting', 'harsh shadows',
      'grainy', 'noisy', 'pixelated', 'artifacts',
      'banding', 'chroma aberration', 'lens flare'
    ];
  }

  /**
   * 生成通用负面提示词
   * @param {Object} options
   * @param {string} options.level - 约束级别: L1/L2/L3
   * @param {number} options.maxLength - 最大长度限制
   * @param {boolean} options.includeCharacterCount - 是否包含字符数统计
   * @returns {string} 负面提示词
   */
  generate(options = {}) {
    const { level = 'L1', maxLength = 300, includeCharacterCount = false } = options;
    
    let constraints = [];
    
    if (level === 'L1' || level === 'L2' || level === 'L3') {
      constraints.push(...this.L1);
    }
    if (level === 'L2' || level === 'L3') {
      constraints.push(...this.L2);
    }
    if (level === 'L3') {
      constraints.push(...this.L3);
    }
    
    const result = constraints.join(', ');
    
    if (includeCharacterCount) {
      return `【负面约束】${result}`;
    }
    return result;
  }

  /**
   * v2.1.5-fix: 生成片头镜头专用负面提示词
   * 片头镜头使用L1全局约束，限制更严格
   * @param {Object} options
   * @param {number} options.maxLength - 最大长度
   * @returns {string} 负面提示词
   */
  generateForOpeningShot(options = {}) {
    const { maxLength = 250 } = options;
    // 片头镜头使用L1全局约束，避免复杂元素干扰标题展示
    return this.generate({ level: 'L1', maxLength, includeCharacterCount: true });
  }

  /**
   * v2.1.5-fix: 生成内容镜头专用负面提示词
   * 内容镜头使用完整L1约束
   * @param {Object} options
   * @param {number} options.maxLength - 最大长度
   * @returns {string} 负面提示词
   */
  generateForContentShot(options = {}) {
    const { maxLength = 300 } = options;
    // 内容镜头使用L1约束，确保画面质量
    return this.generate({ level: 'L1', maxLength, includeCharacterCount: true });
  }

  /**
   * 生成L3级完整约束（最高质量要求）
   * @param {Object} options
   * @returns {string} 负面提示词
   */
  generateL3Template(options = {}) {
    const { shotType = 'content', specifics = {} } = options;
    return this.generate({ level: 'L3', includeCharacterCount: true });
  }
}

module.exports = { GlobalNegativePromptInjector };
