/**
 * P1-4 + P1-5 合并模块：技术规格词汇库 + 情绪-表情动态映射
 * 
 * P1-4: 清理无效技术声明，释放120-150字符预算
 * P1-5: 按情绪阶段动态生成微表情，替换静态模板
 * 
 * @version v1.0
 * @author 小G
 */

class TechSpecsAndEmotionMapper {
  constructor(options = {}) {
    this.mode = options.mode || 'seedance-2.0';
    
    // ===== P1-4: 技术规格词汇库 =====
    this.techSpecs = {
      // ❌ 无效声明（Midjourney时代遗产，对T2V模型无效）
      invalid: [
        '虚幻引擎5', 'Lumen全局光照', 'Nanite几何',
        '超写实3D数字人渲染', '8K分辨率',
        '写实概念美术', '光线追踪', '路径追踪',
        '次表面散射', '置换贴图'
      ],
      // ✅ 有效声明（对Seedance 2.0有实际影响）
      valid: [
        '电影级光影', '体积雾', '大气透视',
        '景深', '动态模糊', '镜头光晕',
        '微距摄影细节', 'IMAX画幅', '变形镜头',
        '黄金时段光照', '蓝调时刻光照', '轮廓光'
      ],
      // 🌟 Nirath专属有效声明
      nirathValid: [
        '双恒星日落玫瑰金光',
        '生物发光生态系统补光',
        '5800K暖金 + 6500K冷白',
        '非地球植被', '异星大气',
        '双星光创造层叠阴影'
      ]
    };
    
    // ===== P1-5: 情绪-表情动态映射 =====
    this.emotionExpressionMap = {
      'establishing': {
        facial: ['neutral relaxed expression', 'soft gentle gaze', 'natural breathing rhythm'],
        body: ['relaxed shoulders', 'open posture', 'natural stance'],
        mouth: ['lips gently closed', 'soft neutral mouth'],
        eyes: ['eyes calm and observant', 'gentle focus'],
        intensity: 'low'
      },
      'rising': {
        facial: ['alert expression', 'subtle tension in brow', 'slight widening of eyes'],
        body: ['body tensing slightly', 'weight shifting forward', 'hands readying'],
        mouth: ['lips parting slightly', 'breath quickening subtly'],
        eyes: ['eyes sharpening', 'scanning environment'],
        intensity: 'low-moderate'
      },
      'building': {
        facial: ['intense focused gaze', 'jaw slightly set', 'brow furrowed'],
        body: ['muscles engaged', 'leaning forward', 'dynamic tension'],
        mouth: ['lips pressed firm', 'controlled breathing'],
        eyes: ['eyes locked on target', 'determined focus'],
        intensity: 'moderate-high'
      },
      'climax': {
        facial: ['powerful determined expression', 'eyes wide with intensity'],
        body: ['dynamic action posture', 'full body engagement', 'maximum extension'],
        mouth: ['mouth open with effort', 'intense expression'],
        eyes: ['eyes sharp and piercing', 'reflecting dramatic light'],
        intensity: 'high'
      },
      'resolve': {
        facial: ['peaceful gentle expression', 'soft smile', 'relieved brow'],
        body: ['shoulders dropping tension', 'settling into calm', 'open relaxed posture'],
        mouth: ['gentle smile', 'soft breathing', 'calm lips'],
        eyes: ['eyes softening', 'peaceful gaze', 'warm reflection'],
        intensity: 'low'
      },
      'opening': {
        facial: ['awe-inspired expression', 'eyes wide with wonder', 'breath catching'],
        body: ['standing in awe', 'slight lean back', 'taking in 宏大尺度'],
        mouth: ['lips parted in wonder', 'soft awe expression'],
        eyes: ['eyes reflecting starlight', 'sparkling with wonder'],
        intensity: 'moderate'
      }
    };
    
    // 情绪阶段过渡映射（相邻阶段表情自然过渡）
    this.transitionMap = {
      'establishing→rising': ['curiosity replacing calm', 'attention focusing'],
      'rising→building': ['tension intensifying', 'determination forming'],
      'building→climax': ['effort peaking', 'transformation moment'],
      'climax→resolve': ['tension releasing', 'peace washing over'],
      'resolve→establishing': ['calm settling', 'new beginning']
    };
  }

  /**
   * P1-4: 清理Prompt中的无效技术声明
   * @param {string} prompt - 原始Prompt
   * @returns {Object} { cleaned, removed, freedChars }
   */
  cleanTechSpecs(prompt) {
    let cleaned = prompt;
    const removed = [];
    let freedChars = 0;
    
    for (const term of this.techSpecs.invalid) {
      const regex = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
      const matches = cleaned.match(regex);
      if (matches) {
        removed.push(term);
        freedChars += term.length * matches.length;
        cleaned = cleaned.replace(regex, '');
      }
    }
    
    // 清理多余空格和标点
    cleaned = cleaned.replace(/\s+/g, ' ').replace(/,\s*,/g, ',').replace(/^,\s*|\s*,$/g, '').trim();
    
    return {
      cleaned,
      removed,
      removedCount: removed.length,
      freedChars,
      validTermsInjected: this._injectValidSpecs(cleaned)
    };
  }

  /**
   * P1-4: 注入有效技术声明
   */
  _injectValidSpecs(prompt) {
    // 仅当Prompt有空间时才注入
    if (prompt.length >= 1470) return { injected: [], reason: '空间不足' };
    
    const toInject = [];
    const remaining = 1500 - prompt.length;
    
    // 优先注入通用有效声明
    for (const term of this.techSpecs.valid.slice(0, 3)) {
      if (!prompt.includes(term) && term.length < remaining - 10) {
        toInject.push(term);
      }
    }
    
    return { injected: toInject, count: toInject.length };
  }

  /**
   * P1-5: 按情绪阶段生成动态表情描述
   * @param {string} phase - 情绪阶段
   * @param {Object} options - 选项
   * @returns {Object} { facial, body, mouth, eyes, combined }
   */
  generateExpression(phase, options = {}) {
    const map = this.emotionExpressionMap[phase];
    if (!map) {
      return { error: `未知情绪阶段: ${phase}` };
    }
    
    const prevPhase = options.prevPhase;
    const nextPhase = options.nextPhase;
    
    // 基础表情
    const result = {
      phase,
      facial: this._selectFrom(map.facial, options.facialIntensity || 'moderate'),
      body: this._selectFrom(map.body, options.bodyIntensity || 'moderate'),
      mouth: this._selectFrom(map.mouth, options.mouthIntensity || 'moderate'),
      eyes: this._selectFrom(map.eyes, options.eyesIntensity || 'moderate'),
      intensity: map.intensity
    };
    
    // 如果有前一阶段，添加过渡表情
    if (prevPhase) {
      const transition = this.transitionMap[`${prevPhase}→${phase}`];
      if (transition) {
        result.transitionFrom = transition;
      }
    }
    
    // 如果有后一阶段，添加预示表情
    if (nextPhase) {
      const transition = this.transitionMap[`${phase}→${nextPhase}`];
      if (transition) {
        result.transitionTo = transition;
      }
    }
    
    // 组合成完整描述
    const parts = [result.facial, result.body, result.mouth, result.eyes].filter(Boolean);
    result.combined = parts.join(', ');
    
    return result;
  }

  /**
   * P1-5: 批量生成多镜头表情序列（确保连续性）
   * @param {Array} phases - 情绪阶段数组
   * @returns {Array} 每个镜头的表情描述
   */
  generateSequence(phases) {
    const sequence = [];
    
    for (let i = 0; i < phases.length; i++) {
      const phase = phases[i];
      const options = {
        prevPhase: i > 0 ? phases[i - 1] : null,
        nextPhase: i < phases.length - 1 ? phases[i + 1] : null
      };
      
      const expression = this.generateExpression(phase, options);
      sequence.push({
        shotIndex: i,
        phase,
        expression
      });
    }
    
    return sequence;
  }

  /**
   * P1-5: 验证情绪-表情一致性
   * @param {string} prompt - Prompt文本
   * @param {string} phase - 预期情绪阶段
   * @returns {Object} { consistent, score, mismatches }
   */
  validateEmotionConsistency(prompt, phase) {
    const map = this.emotionExpressionMap[phase];
    if (!map) return { error: `未知阶段: ${phase}` };
    
    const promptLower = prompt.toLowerCase();
    let matchCount = 0;
    const matches = [];
    
    // 检查正面匹配
    for (const category of ['facial', 'body', 'mouth', 'eyes']) {
      for (const expr of map[category]) {
        const exprLower = expr.toLowerCase();
        // 提取关键词（去掉形容词）
        const keywords = exprLower.split(/\s+/).filter(w => w.length > 3);
        for (const kw of keywords) {
          if (promptLower.includes(kw)) {
            matchCount++;
            matches.push(`${category}: ${expr}`);
            break;
          }
        }
      }
    }
    
    // 检查错配（其他阶段的独特表情词出现在当前阶段）
    const mismatches = [];
    
    // 每个阶段的"独特"关键词（仅该阶段出现，不会跨阶段重复）
    const uniquePhaseKeywords = {
      'establishing': ['serene', 'peaceful gaze', 'soft neutral'],
      'rising': ['anticipation', 'widening', 'scanning'],
      'building': ['intensifying', 'jaw set', 'leaning forward'],
      'climax': ['transformative', 'piercing', 'maximum extension'],
      'resolve': ['relieved', 'tension releasing', 'peace washing'],
      'opening': ['wonder', 'breath catching', 'starlight']
    };
    
    for (const [otherPhase, uniqueKeywords] of Object.entries(uniquePhaseKeywords)) {
      if (otherPhase === phase) continue;
      
      for (const kw of uniqueKeywords) {
        const kwLower = kw.toLowerCase();
        if (promptLower.includes(kwLower)) {
          mismatches.push({
            found: kw,
            expectedPhase: phase,
            actualPhase: otherPhase,
            severity: 'high'
          });
        }
      }
    }
    
    const score = Math.min(100, Math.round((matchCount / 8) * 100));
    const consistent = score >= 60 && mismatches.length === 0;
    
    return {
      consistent,
      score,
      matchCount,
      matches,
      mismatches,
      phase
    };
  }

  // ===== 辅助方法 =====
  _selectFrom(array, intensity) {
    if (!array || array.length === 0) return '';
    
    switch (intensity) {
      case 'minimal': return array[0];
      case 'moderate': return array[Math.floor(array.length / 2)];
      case 'intense': return array[array.length - 1];
      default: return array[Math.floor(Math.random() * array.length)];
    }
  }
}

module.exports = { TechSpecsAndEmotionMapper };
