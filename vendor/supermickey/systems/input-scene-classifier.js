/**
 * 【场景分类器】Input Scene Classifier v1.0
 * 
 * 职责：
 * - 检测用户输入类型：单主题词 / 约束丰富 / 描述性文本 / 混合
 * - 决定后续处理路径：A_SPARSE(深度剖析) / B_CONSTRAINT_RICH(约束仲裁) / B_DESCRIPTIVE(正则提取)
 * 
 * 设计原则：
 * - 纯规则判断，无LLM调用，快速响应
 * - 不硬编码任何角色名或主题词
 * - 可扩展：支持新增场景类型
 */

class InputSceneClassifier {
  constructor(config = {}) {
    this.config = {
      // 主题词长度阈值（≤此字数视为主题词）
      sparseThreshold: config.sparseThreshold ?? 8,
      // 约束标记词库
      constraintMarkers: config.constraintMarkers ?? this.getDefaultConstraintMarkers(),
      // 描述性从句检测模式
      descriptivePatterns: config.descriptivePatterns ?? this.getDefaultDescriptivePatterns(),
      ...config
    };
  }

  /**
   * 主入口：分类用户输入
   * @param {string} inputText - 用户原始输入
   * @returns {Object} { scene, confidence, reason, raw }
   */
  classify(inputText) {
    const trimmed = inputText.trim();
    const charCount = this._countChars(trimmed);
    
    // 规则1：纯主题词（≤阈值字数，无明显描述性从句，无约束标记）
    if (charCount <= this.config.sparseThreshold 
        && !this._hasDescriptiveClause(trimmed)
        && !this._hasConstraintMarkers(trimmed)) {
      return {
        scene: 'A_SPARSE',
        confidence: 0.95,
        reason: `字数${charCount}≤${this.config.sparseThreshold}，无描述从句，无约束标记`,
        raw: trimmed
      };
    }
    
    // 规则2：含明确约束标记（"不要""改为""必须是"等）
    if (this._hasConstraintMarkers(trimmed)) {
      return {
        scene: 'B_CONSTRAINT_RICH',
        confidence: 0.90,
        reason: `检测到约束标记词：${this._extractConstraintMarkers(trimmed).join('、')}`,
        raw: trimmed
      };
    }
    
    // 规则3：长描述性文本（>50字或包含丰富描述）
    if (charCount > 50 || this._hasRichDescription(trimmed)) {
      return {
        scene: 'B_DESCRIPTIVE',
        confidence: 0.85,
        reason: `字数${charCount}>50或包含丰富描述性内容`,
        raw: trimmed
      };
    }
    
    // 规则4：混合场景（有描述但无明确约束）
    if (this._hasDescriptiveClause(trimmed)) {
      return {
        scene: 'B_DESCRIPTIVE',
        confidence: 0.75,
        reason: `包含描述性从句但无约束标记`,
        raw: trimmed
      };
    }
    
    // 默认：短描述（>8字但≤50字，无约束标记）
    return {
      scene: 'MIXED',
      confidence: 0.70,
      reason: `字数${charCount}，无明确分类特征`,
      raw: trimmed
    };
  }

  /**
   * 批量分类
   */
  classifyBatch(inputs) {
    return inputs.map(input => ({
      input: input,
      ...this.classify(input)
    }));
  }

  /**
   * 检测是否有描述性从句
   */
  _hasDescriptiveClause(text) {
    const patterns = this.config.descriptivePatterns;
    return patterns.some(p => p.test(text));
  }

  /**
   * 检测是否有约束标记
   */
  _hasConstraintMarkers(text) {
    return this.config.constraintMarkers.some(marker => marker.test(text));
  }

  /**
   * 提取具体的约束标记词
   */
  _extractConstraintMarkers(text) {
    const found = [];
    const markerWords = ['不要', '去掉', '没有', '删除', '改为', '改成', '必须是', '我要', '我想要', '务必', '一定要'];
    
    markerWords.forEach(word => {
      if (text.includes(word)) {
        found.push(word);
      }
    });
    
    return [...new Set(found)];
  }

  /**
   * 检测是否为丰富描述
   */
  _hasRichDescription(text) {
    // 检测是否包含多个标点（逗号/句号/分号）且字数>30
    const punctuationCount = (text.match(/[，。；]/g) || []).length;
    return punctuationCount >= 2 && text.length > 30;
  }

  /**
   * 字数统计（中文算1字，英文算0.5字）
   */
  _countChars(text) {
    const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    const englishChars = (text.match(/[a-zA-Z]/g) || []).length;
    return chineseChars + Math.ceil(englishChars * 0.5);
  }

  /**
   * 默认约束标记词库
   */
  getDefaultConstraintMarkers() {
    return [
      /不要/,           // "不要翅膀"
      /去掉/,           // "去掉四翼"
      /没有/,           // "没有五官"
      /删除/,           // "删除翅膀"
      /改为/,           // "改为九只脚"
      /改成/,           // "改成红色"
      /必须是?/,        // "必须是红色"
      /我要/,           // "我要九只脚"
      /我想要/,         // "我想要"
      /务必/,           // "务必"
      /一定要/,         // "一定要"
      /不能/,           // "不能"
      /禁止/,           // "禁止"
      /去掉?了/,       // "不要了"
      /改为?了/        // "改了"
    ];
  }

  /**
   * 默认描述性从句模式
   */
  getDefaultDescriptivePatterns() {
    return [
      /形如/,           // "形如黄囊"
      /状如/,           // "状如气囊"
      /有[一二三四五六七八九十\d]+/, // "有六只脚"
      /穿着/,           // "穿着红色衣服"
      /戴着/,           // "戴着眼镜"
      /身高/,           // "身高180"
      /[岁年]/,         // "8岁"
      /颜色/,           // "颜色是红色"
      /通体/,           // "通体赤红"
      /直径/,           // "直径1米"
      /大小/,           // "绵羊大小"
      /质感/,           // "质感柔软"
      /发光/,           // "身体发光"
      /透明/,           // "半透明"
      /[足翼翅腿脚臂手头尾角][一二三四五六七八九十\d]/, // "六足"
      /[一二三四五六七八九十\d]+[足翼翅腿脚臂手头尾角]/  // "6只脚"
    ];
  }
}

module.exports = InputSceneClassifier;
