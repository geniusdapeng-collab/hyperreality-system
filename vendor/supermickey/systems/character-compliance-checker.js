/**
 * 【角色合规检查器】Character Compliance Checker v2.0
 * 
 * 3级合规审查体系：
 * - L1 禁止级：绝对不可出现在prompt中的内容（拦截渲染）
 * - L2 模糊级：高风险内容，需人工确认（警告但允许通过）
 * - L3 注意级：建议优化但非强制（提示建议）
 * 
 * 职责：
 * - 扫描角色prompt的合规性
 * - 拦截违规内容
 * - 生成整改建议
 */

class CharacterComplianceChecker {
  constructor(config = {}) {
    this.config = {
      strictMode: config.strictMode ?? true,
      maxViolationsBeforeBlock: config.maxViolationsBeforeBlock ?? 1,
      ...config
    };
    
    // ====== L1 禁止级规则 ======
    this.L1_RULES = [
      {
        id: 'text_readable',
        name: '清晰可读文字',
        pattern: /(小字清晰可辨|印刷工整|字迹清晰|上面写着|文字清晰|清晰字体|工整字迹|清晰可读的?字|印刷体|手写字迹)/i,
        reason: 'AI生成文字极易出错，严禁要求"清晰可辨""印刷工整"',
        suggestion: '改为"模糊的背景文字"或"不清晰的 signage"或完全不提文字'
      },
      {
        id: 'text_complex',
        name: '复杂文字内容',
        pattern: /(写着[\u4e00-\u9fa5]{3,}|标语写着|招牌写着|横幅写着|告示写着|牌匾写着)/i,
        reason: 'AI无法准确生成中文文字内容，会出现乱字/错字',
        suggestion: '删除具体文字内容描述，改为"背景 signage"或"模糊标识"'
      },
      {
        id: 'realistic_photo_ref',
        name: '真人照片参考',
        pattern: /(真人照片|真实人物照片|照片级真实人脸|reference photo|photo reference|真实人脸照片)/i,
        reason: 'Seedance 2.0 API不支持真人照片作为人脸参考图，会被忽略',
        suggestion: '使用"超写实3D数字人渲染"风格替代真人照片'
      },
      {
        id: 'brand_logo',
        name: '品牌logo/商标',
        pattern: /(nike|adidas|gucci|lv|louis vuitton|logo清晰|品牌标志|商标)/i,
        reason: 'AI生成品牌logo会变形/错误，且可能涉及版权问题',
        suggestion: '删除品牌标识，使用通用描述（如"运动鞋"而非"Nike鞋"）'
      },
      {
        id: 'western_face',
        name: '西方面孔强制要求',
        pattern: /(西方脸|欧美面孔|caucasian|european face|western facial features|高鼻梁|深眼窝|欧式双眼皮|欧美式双眼皮|欧型眼|欧化面容)/i,
        reason: '项目要求亚洲面孔，西方面孔描述会导致角色偏离设定',
        suggestion: '改为"亚洲面孔""中国人面部特征"'
      },
      {
        id: 'unnatural_eye_color',
        name: '异常眼睛颜色',
        pattern: /(红[色]?眼睛|红[色]?瞳|血红眼|赤瞳|蓝[色]?眼睛|蓝[色]?瞳|海水蓝眼|黄[色]?眼睛|金瞳|绿[色]?眼睛|绿[色]?瞳|紫[色]?眼睛|紫[色]?瞳|橙[色]?眼睛|荧光眼|发光眼|眼睛发光|火光眼|眼睛里.{0,5}火|眼睛里.{0,5}光|眼睛里.{0,5}海水|霓虹眼|猫眼.{0,3}人类|猫眼.{0,3}人|竖瞳.{0,3}人)/i,
        reason: '队长全局约束：所有人物眼睛禁止红色/蓝色/黄色/绿色/紫色/橙色等非自然颜色，禁止火光/海水/荧光等异常效果，只允许正常人类眼色（黑色眼圈/棕色/深褐色/深灰色/琥珀色）',
        suggestion: '改为正常人类眼睛描述（如"黑色眼圈""深棕色眼睛""琥珀色眼睛""眼睛中反射对面景物影子"），删除任何彩色/发光/火光描述'
      }
    ];
    
    // ====== L2 模糊级规则 ======
    this.L2_RULES = [
      {
        id: 'hands_detail',
        name: '手部细节',
        pattern: /(手指纤细|手指修长|精致的手|手部特写|手指细节|美甲)/i,
        reason: 'AI手部生成易出错（多指/畸形），高风险',
        suggestion: '手部描述保持简单（"自然的手"），避免特写'
      },
      {
        id: 'anatomy',
        name: '解剖结构',
        pattern: /(骨骼结构|肌肉纹理|血管清晰可见|皮下血管|青筋暴露|骨骼清晰)/i,
        reason: '解剖结构描述易导致恐怖谷效应或渲染异常',
        suggestion: '使用"健康的肤色""自然的皮肤质感"替代'
      },
      {
        id: 'extreme_expression',
        name: '极端表情',
        pattern: /(极度恐惧|狰狞|扭曲的脸|面目狰狞|疯狂的表情|歇斯底里)/i,
        reason: '极端表情生成质量不稳定，可能变形',
        suggestion: '使用"担忧""紧张""惊讶"等中等强度表情'
      },
      {
        id: 'complex_reflection',
        name: '复杂反射',
        pattern: /(镜面反射|玻璃倒影|水面倒影清晰可见|镜子中清晰映出)/i,
        reason: '复杂反射易导致画面逻辑错误',
        suggestion: '简化反射描述（"柔和的环境光"）'
      }
    ];
    
    // ====== L3 注意级规则 ======
    this.L3_RULES = [
      {
        id: 'lighting_complex',
        name: '复杂光影',
        pattern: /(丁达尔效应|体积光|上帝之光|光束穿透|粒子光效)/i,
        reason: '复杂光影消耗提示词空间，且效果不稳定',
        suggestion: '如无必要可删除，或使用"柔和的自然光"'
      },
      {
        id: 'shadow_detail',
        name: '阴影细节',
        pattern: /(阴影清晰可见|影子轮廓分明|精确的影子)/i,
        reason: 'AI阴影生成可能逻辑错误',
        suggestion: '改为"自然的投影"或删除阴影描述'
      },
      {
        id: 'texture_overload',
        name: '质感堆砌',
        pattern: /(毛孔级纹理|纤维可见|编织纹理清晰|纹理极度清晰)/i,
        reason: '过度质感描述挤占提示词空间，边际效应递减',
        suggestion: '保留1-2个核心质感词即可'
      },
      {
        id: 'camera_movement',
        name: '运镜指令残留',
        pattern: /(一镜到底|镜头推进|摇镜头|推拉摇移|运镜)/i,
        reason: '运镜指令应放入camera-movement-system，不应在角色prompt中',
        suggestion: '将运镜描述移至镜头运动的camera字段'
      }
    ];
  }
  
  /**
   * 扫描prompt，返回合规报告
   * @param {string} prompt - 待检查的prompt文本
   * @param {Object} options - 检查选项
   * @returns {Object} 合规报告
   */
  scan(prompt, options = {}) {
    const report = {
      passed: true,
      level: 'PASS', // PASS / WARNING / BLOCK
      violations: {
        L1: [],
        L2: [],
        L3: []
      },
      summary: {
        total: 0,
        L1_count: 0,
        L2_count: 0,
        L3_count: 0
      },
      suggestions: [],
      cleanPrompt: prompt
    };
    
    // 检查L1（禁止级）
    for (const rule of this.L1_RULES) {
      const matches = this._findMatches(prompt, rule.pattern);
      if (matches.length > 0) {
        report.violations.L1.push({
          ruleId: rule.id,
          ruleName: rule.name,
          matches,
          reason: rule.reason,
          suggestion: rule.suggestion
        });
        report.suggestions.push(`[${rule.name}] ${rule.suggestion}`);
        
        // 从cleanPrompt中移除违规内容（近似）
        for (const match of matches) {
          report.cleanPrompt = report.cleanPrompt.replace(match, '[已移除违规内容]');
        }
      }
    }
    
    // 检查L2（模糊级）
    for (const rule of this.L2_RULES) {
      const matches = this._findMatches(prompt, rule.pattern);
      if (matches.length > 0) {
        report.violations.L2.push({
          ruleId: rule.id,
          ruleName: rule.name,
          matches,
          reason: rule.reason,
          suggestion: rule.suggestion
        });
        report.suggestions.push(`[建议] ${rule.name}: ${rule.suggestion}`);
      }
    }
    
    // 检查L3（注意级）
    for (const rule of this.L3_RULES) {
      const matches = this._findMatches(prompt, rule.pattern);
      if (matches.length > 0) {
        report.violations.L3.push({
          ruleId: rule.id,
          ruleName: rule.name,
          matches,
          reason: rule.reason,
          suggestion: rule.suggestion
        });
        report.suggestions.push(`[提示] ${rule.name}: ${rule.suggestion}`);
      }
    }
    
    // 统计
    report.summary.L1_count = report.violations.L1.length;
    report.summary.L2_count = report.violations.L2.length;
    report.summary.L3_count = report.violations.L3.length;
    report.summary.total = report.summary.L1_count + report.summary.L2_count + report.summary.L3_count;
    
    // 判定结果
    if (report.summary.L1_count > 0) {
      if (this.config.strictMode || report.summary.L1_count >= this.config.maxViolationsBeforeBlock) {
        report.passed = false;
        report.level = 'BLOCK';
      } else {
        report.level = 'WARNING';
      }
    } else if (report.summary.L2_count > 0) {
      report.level = 'WARNING';
    } else if (report.summary.L3_count > 0) {
      report.level = 'WARNING'; // L3存在时至少触发WARNING
    }
    
    return report;
  }
  
  /**
   * 批量扫描多个prompt
   */
  scanBatch(prompts) {
    return prompts.map((p, i) => ({
      index: i,
      ...this.scan(p)
    }));
  }
  
  /**
   * 扫描角色档案的合规性
   */
  scanCharacterCard(characterCard) {
    const results = {
      characterId: characterCard.id,
      characterName: characterCard.name,
      overallPassed: true,
      checks: []
    };
    
    // 扫描视觉身份描述
    if (characterCard.visualIdentity?.style) {
      results.checks.push({
        field: 'visualIdentity.style',
        ...this.scan(characterCard.visualIdentity.style)
      });
    }
    
    // 扫描各外观元素
    if (characterCard.visualIdentity?.appearance) {
      for (const [key, data] of Object.entries(characterCard.visualIdentity.appearance)) {
        if (data.description) {
          results.checks.push({
            field: `visualIdentity.appearance.${key}`,
            ...this.scan(data.description)
          });
        }
        if (data.promptFragment) {
          results.checks.push({
            field: `visualIdentity.appearance.${key}.promptFragment`,
            ...this.scan(data.promptFragment)
          });
        }
      }
    }
    
    // 扫描肖像配置
    if (characterCard.portraitConfig?.style) {
      results.checks.push({
        field: 'portraitConfig.style',
        ...this.scan(characterCard.portraitConfig.style)
      });
    }
    
    // 判定总体结果
    results.overallPassed = results.checks.every(c => c.passed);
    results.blockingViolations = results.checks.filter(c => c.level === 'BLOCK');
    results.warningViolations = results.checks.filter(c => c.level === 'WARNING');
    
    return results;
  }
  
  /**
   * 生成整改后的prompt
   */
  sanitize(prompt) {
    const report = this.scan(prompt);
    
    if (report.level === 'PASS') {
      return { prompt, changed: false, report };
    }
    
    let sanitized = prompt;
    
    // 移除L1违规内容
    for (const violation of report.violations.L1) {
      for (const match of violation.matches) {
        // 尝试智能替换：找到匹配词所在的短语/句子，用建议替代
        const sentence = this._extractSentence(sanitized, match);
        if (sentence) {
          // 简单策略：删除包含违规词的整个短语
          sanitized = sanitized.replace(sentence, '');
        } else {
          sanitized = sanitized.replace(match, '');
        }
      }
    }
    
    // 清理多余标点
    sanitized = sanitized
      .replace(/，{2,}/g, '，')
      .replace(/,{2,}/g, ',')
      .replace(/\s{2,}/g, ' ')
      .trim();
    
    return {
      prompt: sanitized,
      changed: sanitized !== prompt,
      report
    };
  }
  
  // ====== 内部工具方法 ======
  
  _findMatches(text, pattern) {
    const matches = [];
    let match;
    const regex = new RegExp(pattern.source, 'gi');
    while ((match = regex.exec(text)) !== null) {
      matches.push(match[0]);
    }
    return [...new Set(matches)]; // 去重
  }
  
  _extractSentence(text, keyword) {
    // 简单实现：找到keyword所在的句子（以标点分隔）
    const sentences = text.split(/([。，；！？.!?,;])/);
    for (let i = 0; i < sentences.length; i++) {
      if (sentences[i].includes(keyword)) {
        // 包含前后标点
        const prev = i > 0 ? sentences[i - 1] : '';
        const curr = sentences[i];
        const next = i < sentences.length - 1 ? sentences[i + 1] : '';
        return prev + curr + next;
      }
    }
    return null;
  }
}

module.exports = { CharacterComplianceChecker };
