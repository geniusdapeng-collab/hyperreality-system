/**
 * 【意图分层器】Intent Priority Layer v1.0
 * 
 * 职责：
 * - 将用户输入解析为三层优先级结构
 * - P0硬约束（必须100%遵从）
 * - P1事实描述（尽量遵从）
 * - P2氛围风格（参考性遵从）
 * 
 * 核心逻辑：
 * P0 > P1 > P2（优先级覆盖关系）
 * 用户硬约束 > 用户事实描述 > 系统默认
 */

class IntentPriorityLayer {
  constructor(config = {}) {
    this.config = {
      // P0标记词库（硬约束指示词）
      p0Markers: config.p0Markers ?? this.getDefaultP0Markers(),
      // P2标记词库（氛围风格指示词）
      p2Markers: config.p2Markers ?? this.getDefaultP2Markers(),
      // 数量单位词库
      countUnits: config.countUnits ?? ['足', '翼', '翅', '腿', '脚', '臂', '手', '头', '尾', '角', '眼', '耳', '嘴'],
      // 颜色词库
      colorWords: config.colorWords ?? ['红', '赤', '黄', '白', '黑', '青', '蓝', '紫', '橙', '绿', '金', '银'],
      ...config
    };
  }

  /**
   * 主入口：解析用户输入为三层优先级
   * @param {string} inputText - 用户原始输入
   * @returns {Object} { P0_HARD, P1_FACT, P2_VIBE, raw, metadata }
   */
  parse(inputText) {
    const trimmed = inputText.trim();
    
    const constraints = {
      P0_HARD: [],
      P1_FACT: [],
      P2_VIBE: [],
      raw: trimmed,
      metadata: {
        totalSegments: 0,
        p0Count: 0,
        p1Count: 0,
        p2Count: 0
      }
    };
    
    // Step 1: 将输入分割为语义片段（按标点或连接词）
    const segments = this._segmentInput(trimmed);
    constraints.metadata.totalSegments = segments.length;
    
    // Step 2: 逐段分析并归类
    for (const segment of segments) {
      const classification = this._classifySegment(segment);
      
      switch (classification.priority) {
        case 'P0':
          constraints.P0_HARD.push({
            text: segment,
            type: classification.type,
            confidence: classification.confidence
          });
          break;
        case 'P1':
          constraints.P1_FACT.push({
            text: segment,
            type: classification.type,
            confidence: classification.confidence
          });
          break;
        case 'P2':
          constraints.P2_VIBE.push({
            text: segment,
            type: classification.type,
            confidence: classification.confidence
          });
          break;
      }
    }
    
    // Step 3: 后处理——提取结构化约束
    constraints.P0_HARD = this._extractStructuredConstraints(constraints.P0_HARD);
    constraints.P1_FACT = this._extractStructuredConstraints(constraints.P1_FACT);
    
    constraints.metadata.p0Count = constraints.P0_HARD.length;
    constraints.metadata.p1Count = constraints.P1_FACT.length;
    constraints.metadata.p2Count = constraints.P2_VIBE.length;
    
    return constraints;
  }

  /**
   * 将输入分割为语义片段
   */
  _segmentInput(text) {
    // 先按逗号/分号/句号分割
    const byPunctuation = text.split(/[，；。!！?？]/).map(s => s.trim()).filter(Boolean);
    
    // 对每个片段，如果有"但/不过/然而/但是"等转折词，进一步分割
    const segments = [];
    for (const seg of byPunctuation) {
      const turningParts = seg.split(/(?:但|但是|不过|然而|只是)/);
      if (turningParts.length > 1) {
        // 有转折，第一部分是基准，第二部分是修改
        segments.push(turningParts[0].trim());
        for (let i = 1; i < turningParts.length; i++) {
          segments.push('转折修改：' + turningParts[i].trim());
        }
      } else {
        segments.push(seg);
      }
    }
    
    return segments.filter(s => s.length > 0);
  }

  /**
   * 对单个片段进行优先级分类
   */
  _classifySegment(segment) {
    // 检测P0标记
    const hasP0Marker = this.config.p0Markers.some(marker => marker.test(segment));
    if (hasP0Marker) {
      return {
        priority: 'P0',
        type: this._determineP0Type(segment),
        confidence: 0.90
      };
    }
    
    // 检测P2标记
    const hasP2Marker = this.config.p2Markers.some(marker => marker.test(segment));
    if (hasP2Marker && !this._hasFactIndicators(segment)) {
      return {
        priority: 'P2',
        type: 'vibe',
        confidence: 0.80
      };
    }
    
    // 默认P1：包含事实性描述
    const factType = this._determineP1Type(segment);
    if (factType) {
      return {
        priority: 'P1',
        type: factType,
        confidence: 0.85
      };
    }
    
    // 无法分类的片段，根据内容判断
    if (segment.length <= 4 && !this._hasFactIndicators(segment)) {
      // 短片段，可能是主题词
      return {
        priority: 'P1',
        type: 'topic',
        confidence: 0.60
      };
    }
    
    return {
      priority: 'P2',
      type: 'unclassified',
      confidence: 0.50
    };
  }

  /**
   * 确定P0约束的具体类型
   */
  _determineP0Type(segment) {
    if (/不要|去掉|没有|删除|禁止|不能/.test(segment)) {
      return 'remove';  // 移除约束
    }
    if (/改为|改成|必须是|一定要|务必/.test(segment)) {
      return 'modify';  // 修改约束
    }
    if (/我要|我想要|给我|加上/.test(segment)) {
      return 'add';     // 添加约束
    }
    return 'unspecified';
  }

  /**
   * 确定P1事实的具体类型
   */
  _determineP1Type(segment) {
    // 数量特征
    if (new RegExp(`[一二三四五六七八九十\\d]+(?:${this.config.countUnits.join('|')})`).test(segment) ||
        new RegExp(`(?:${this.config.countUnits.join('|')})[一二三四五六七八九十\\d]+`).test(segment)) {
      return 'count';
    }
    
    // 颜色特征
    if (this.config.colorWords.some(c => segment.includes(c))) {
      return 'color';
    }
    
    // 形态特征
    if (/形如|状如|像|似|呈|为/.test(segment)) {
      return 'shape';
    }
    
    // 大小特征
    if (/米|尺|寸|大小|高|宽|长|直径/.test(segment)) {
      return 'size';
    }
    
    // 质感特征
    if (/软|硬|滑|粗糙|光滑|透明|半透明|发光/.test(segment)) {
      return 'texture';
    }
    
    // 面部特征
    if (/眼|鼻|嘴|耳|脸|面目|五官/.test(segment)) {
      return 'face';
    }
    
    // 主题词（可能是角色名）
    if (segment.length <= 6 && !segment.includes('，')) {
      return 'topic';
    }
    
    return null;
  }

  /**
   * 检测是否包含事实性指标
   */
  _hasFactIndicators(segment) {
    const factPatterns = [
      /[一二三四五六七八九十\d]+[足翼翅腿脚臂手头尾角]/,
      /(?:足翼翅腿脚臂手头尾角)[一二三四五六七八九十\d]+/,
      /[红黄白黑青蓝紫橙绿金银]色?/,
      /形如|状如|直径|身高|大小/,
      /米|厘米|毫米/
    ];
    return factPatterns.some(p => p.test(segment));
  }

  /**
   * 提取结构化约束
   */
  _extractStructuredConstraints(constraintList) {
    return constraintList.map(item => {
      const structured = { ...item };
      
      // 提取数量修改
      const countMatch = item.text.match(/(?:改为?|改成?|有?了?)\s*([一二三四五六七八九十\d]+)\s*([只条个片根对双]+)?\s*([足翼翅腿脚臂手头尾角])/);
      if (countMatch) {
        structured.numberChange = {
          action: 'modify',
          target: countMatch[3],
          newValue: this._parseNumber(countMatch[1]),
          unit: countMatch[2] || ''
        };
      }
      
      // 提取移除约束
      const removeMatch = item.text.match(/(?:不要|去掉|没有|删除)\s*([足翼翅腿脚臂手头尾角]|翅膀|眼睛|鼻子|嘴巴|耳朵|五官|毛发|尾巴)/);
      if (removeMatch) {
        structured.removal = {
          action: 'remove',
          target: removeMatch[1]
        };
      }
      
      // 提取颜色强制
      const colorMatch = item.text.match(/(?:必须是?|改为?|改成?)\s*([红黄白黑青蓝紫橙绿金银]+)色?/);
      if (colorMatch) {
        structured.colorForce = {
          action: 'set',
          color: colorMatch[1]
        };
      }
      
      return structured;
    });
  }

  /**
   * 解析中文数字/阿拉伯数字
   */
  _parseNumber(str) {
    const chineseMap = { '一':1, '二':2, '两':2, '三':3, '四':4, '五':5, '六':6, '七':7, '八':8, '九':9, '十':10, '百':100 };
    
    if (/^\d+$/.test(str)) {
      return parseInt(str);
    }
    
    let result = 0;
    let temp = 0;
    for (let char of str) {
      if (chineseMap[char] === 100) {
        result += (temp || 1) * 100;
        temp = 0;
      } else if (chineseMap[char] === 10) {
        result += (temp || 1) * 10;
        temp = 0;
      } else {
        temp = chineseMap[char] || 0;
      }
    }
    return result + temp;
  }

  /**
   * 检查约束是否与Profile冲突
   */
  detectConflicts(constraints, profile) {
    const conflicts = [];
    
    // 检查P0数量修改是否与Profile冲突
    for (const p0 of constraints.P0_HARD) {
      if (p0.numberChange && profile.visualIdentity?.count) {
        const original = profile.visualIdentity.count.find(
          c => c.unit.includes(p0.numberChange.target) || p0.numberChange.target.includes(c.unit)
        );
        if (original && original.number !== p0.numberChange.newValue) {
          conflicts.push({
            type: 'COUNT_OVERRIDE',
            priority: 'P0',
            unit: p0.numberChange.target,
            original: original.number,
            modified: p0.numberChange.newValue,
            constraint: p0.text
          });
        }
      }
      
      // 检查P0移除是否与Profile冲突
      if (p0.removal && profile.visualIdentity?.count) {
        const original = profile.visualIdentity.count.find(
          c => c.unit.includes(p0.removal.target) || p0.removal.target.includes(c.unit)
        );
        if (original) {
          conflicts.push({
            type: 'LIMB_REMOVED',
            priority: 'P0',
            unit: p0.removal.target,
            original: original.number,
            modified: 0,
            constraint: p0.text
          });
        }
      }
    }
    
    return conflicts;
  }

  /**
   * 默认P0标记词
   */
  getDefaultP0Markers() {
    return [
      /不要/, /去掉/, /没有/, /删除/, /禁止/, /不能/,
      /改为/, /改成/, /必须是?/, /一定要/, /务必/,
      /我要/, /我想要/, /给我/, /加上/
    ];
  }

  /**
   * 默认P2标记词
   */
  getDefaultP2Markers() {
    return [
      /温暖/, /神秘/, /可爱/, /威严/, /优雅/, /恐怖/,
      /感觉/, /氛围/, /风格/, /气质/, / vibe/, / mood/,
      /像.*一样/, /仿佛/, /宛如/, /如同/
    ];
  }
}

module.exports = IntentPriorityLayer;
