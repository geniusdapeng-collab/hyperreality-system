// engines/script-engine/core/script-validator.js
// Script Validator - 剧本校验与质量评估
// 版本：v1.0 | 日期：2026-06-07

class ScriptValidator {
  constructor(options = {}) {
    this.config = {
      // 时长约束
      minDuration: 15,
      maxDuration: 300,
      
      // 场景数量约束
      minScenes: 3,
      maxScenes: 10,
      
      // 台词约束
      // B4-fix: 与 v6.37 标准(≤50字)对齐
      maxLineLength: 50, // 字（v6.37标准：单句台词≤50字）
      minScenesWithDialogue: 1,
      
      // 质量阈值
      qualityThresholds: {
        structural_integrity: 70,
        emotional_impact: 60,
        character_consistency: 80,
        dialogue_quality: 70,
        visual_feasibility: 60
      },
      
      // Nirath 约束
      nirathRequiredElements: ['Nirath', '硅', '双月', '晶体', '等离子'],
      forbiddenElements: ['旁白', 'voiceover', '金属光泽', 'unnatural_eye_color'], // 【P1-13 修复】移除'解说'，避免误杀教育/纪录片内容,
      
      ...options
    };
  }

  /**
   * 主入口：完整校验剧本
   * @param {ScriptBlueprint} blueprint - 剧本蓝图
   * @returns {object} 校验报告
   */
  validate(blueprint) {
    const checks = [];
    
    // 1. 结构完整性检查
    const structuralChecks = this._checkStructure(blueprint);
    checks.push(...structuralChecks);
    
    // 2. 时长检查
    const durationChecks = this._checkDuration(blueprint);
    checks.push(...durationChecks);
    
    // 3. 台词检查
    const dialogueChecks = this._checkDialogue(blueprint);
    checks.push(...dialogueChecks);
    
    // 4. 角色一致性检查
    const characterChecks = this._checkCharacters(blueprint);
    checks.push(...characterChecks);
    
    // 5. Nirath 世界观检查（如果是 Nirath 世界观）
    if (blueprint.world_setting?.world_id === 'nirath') {
      const nirathChecks = this._checkNirathWorld(blueprint);
      checks.push(...nirathChecks);
    }
    
    // 6. 禁止元素检查
    const forbiddenChecks = this._checkForbiddenElements(blueprint);
    checks.push(...forbiddenChecks);
    
    // 7. 质量评分
    const scores = this._calculateScores(blueprint, checks);
    
    // 汇总
    const failedChecks = checks.filter(c => c.passed === false);
    // 【P1-12 修复】只统计 critical 级别失败，warning 不阻塞 passed
    const criticalFails = checks.filter(c => c.passed === false && c.severity === 'critical');
    const passed = criticalFails.length === 0 && scores.overall >= 60;
    
    return {
      blueprint_id: blueprint.blueprint_id,
      passed,
      overall_score: scores.overall,
      checks,
      scores: {
        detailed: scores.detailed,
        summary: scores.summary
      },
      issues: failedChecks.map(c => ({
        category: c.category,
        severity: c.severity,
        message: c.message,
        suggestion: c.suggestion
      })),
      timestamp: new Date().toISOString()
    };
  }

  /**
   * 结构完整性检查
   */
  _checkStructure(blueprint) {
    const checks = [];
    const structure = blueprint.structure;
    
    // 检查幕结构
    checks.push({
      category: 'structure',
      name: 'acts_exist',
      passed: structure.acts && structure.acts.length > 0,
      severity: 'critical',
      message: structure.acts?.length ? `有 ${structure.acts.length} 幕` : '缺少幕结构',
      suggestion: '必须至少包含 1 幕'
    });
    
    // 检查场景数量
    const sceneCount = structure.scenes?.length || 0;
    checks.push({
      category: 'structure',
      name: 'scene_count',
      passed: sceneCount >= this.config.minScenes && sceneCount <= this.config.maxScenes,
      severity: 'critical',
      message: `有 ${sceneCount} 个场景`,
      suggestion: `场景数量应在 ${this.config.minScenes}-${this.config.maxScenes} 之间`
    });
    
    // 检查场景连续性
    let continuous = true;
    let lastEnd = 0;
    for (const scene of (structure.scenes || [])) {
      if (scene.timing) {
        if (Math.abs(scene.timing.start - lastEnd) > 1) {
          continuous = false;
        }
        lastEnd = scene.timing.end;
      }
    }
    checks.push({
      category: 'structure',
      name: 'scene_continuity',
      passed: continuous,
      severity: 'warning',
      message: continuous ? '场景时序连续' : '场景时序存在断层',
      suggestion: '确保场景时间轴连续无断层'
    });
    
    // 检查场景 ID 唯一性
    const sceneIds = (structure.scenes || []).map(s => s.scene_id);
    const uniqueIds = new Set(sceneIds);
    checks.push({
      category: 'structure',
      name: 'scene_id_unique',
      passed: sceneIds.length === uniqueIds.size,
      severity: 'critical',
      message: sceneIds.length === uniqueIds.size ? '场景 ID 唯一' : '存在重复场景 ID',
      suggestion: '确保每个场景 ID 唯一'
    });
    
    return checks;
  }

  /**
   * 时长检查
   */
  _checkDuration(blueprint) {
    const checks = [];
    const targetDuration = blueprint.meta?.target_duration || 120;
    const actualDuration = blueprint.getTotalDuration();
    
    checks.push({
      category: 'duration',
      name: 'total_duration_match',
      passed: Math.abs(actualDuration - targetDuration) <= 5,
      severity: 'critical',
      message: `目标时长 ${targetDuration}s, 实际时长 ${actualDuration}s`,
      suggestion: `总时长应与目标时长一致（误差≤5s）`
    });
    
    checks.push({
      category: 'duration',
      name: 'duration_in_range',
      passed: actualDuration >= this.config.minDuration && actualDuration <= this.config.maxDuration,
      severity: 'critical',
      message: `实际时长 ${actualDuration}s`,
      suggestion: `时长应在 ${this.config.minDuration}-${this.config.maxDuration}s 之间`
    });
    
    // 检查每个场景时长
    for (const scene of (blueprint.structure.scenes || [])) {
      if (scene.timing) {
        const duration = scene.timing.duration;
        checks.push({
          category: 'duration',
          name: `scene_${scene.scene_id}_duration`,
          // B3-fix: 与 v6.37 标准对齐（过渡8-10s，核心12-15s，上限60s）
          passed: duration > 0 && duration <= 60,
          severity: 'warning',
          message: `场景 ${scene.scene_id} 时长 ${duration}s`,
          suggestion: '单个场景时长应在 8-60s 之间（过渡8-10s，核心12-15s）'
        });
      }
    }
    
    return checks;
  }

  /**
   * 台词检查
   */
  _checkDialogue(blueprint) {
    const checks = [];
    const scenes = blueprint.structure.scenes || [];
    
    // 统计有台词的场景
    // 【P1-14 修复】同时检查 lines 和 blocks 两种格式
    const hasDialogueContent = (d) => (d?.lines?.length > 0) || (d?.blocks?.length > 0);
    const scenesWithDialogue = scenes.filter(s => s.dialogue?.has_dialogue && hasDialogueContent(s.dialogue));
    
    checks.push({
      category: 'dialogue',
      name: 'has_dialogue',
      passed: scenesWithDialogue.length >= this.config.minScenesWithDialogue,
      severity: 'critical',
      message: `${scenesWithDialogue.length}/${scenes.length} 场景有台词`,
      suggestion: '必须至少包含台词的场景'
    });
    
    // 检查台词长度
    let longLines = 0;
    for (const scene of scenes) {
      if (scene.dialogue?.lines) {
        for (const line of scene.dialogue.lines) {
          if (line.text && line.text.length > this.config.maxLineLength) {
            longLines++;
          }
        }
      }
      // 【P1-14 修复】遍历 blocks 格式
      if (scene.dialogue?.blocks) {
        for (const block of scene.dialogue.blocks) {
          if (block.line && block.line.length > this.config.maxLineLength) {
            longLines++;
          }
        }
      }
    }
    
    checks.push({
      category: 'dialogue',
      name: 'line_length',
      passed: longLines === 0,
      severity: 'warning',
      message: longLines === 0 ? '所有台词长度合规' : `${longLines} 句台词超过 ${this.config.maxLineLength} 字`,
      suggestion: `台词每句不超过 ${this.config.maxLineLength} 字`
    });
    
    // 检查是否包含旁白（禁止）
    let hasVoiceover = false;
    for (const scene of scenes) {
      if (scene.voice_over?.text) {
        hasVoiceover = true;
        break;
      }
    }
    
    checks.push({
      category: 'dialogue',
      name: 'no_voiceover',
      passed: !hasVoiceover,
      severity: 'critical',
      message: hasVoiceover ? '检测到旁白（禁止）' : '无旁白，合规',
      suggestion: '全局禁止旁白，只保留角色对话'
    });
    
    return checks;
  }

  /**
   * 角色一致性检查
   */
  _checkCharacters(blueprint) {
    const checks = [];
    const characters = blueprint.character_system?.characters || [];
    const characterIds = characters.map(c => c.character_id);
    
    // 检查主角存在
    const hasProtagonist = characters.some(c => c.role === 'protagonist');
    checks.push({
      category: 'character',
      name: 'has_protagonist',
      passed: hasProtagonist,
      severity: 'critical',
      message: hasProtagonist ? '主角已定义' : '缺少主角定义',
      suggestion: '必须定义 protagonist 角色'
    });
    
    // 检查角色核心特征
    for (const character of characters) {
      if (character.visual_anchor?.core_features) {
        const featureCount = character.visual_anchor.core_features.length;
        checks.push({
          category: 'character',
          name: `character_${character.character_id}_features`,
          passed: featureCount >= 2 && featureCount <= 5,
          severity: 'warning',
          message: `角色 ${character.character_id} 有 ${featureCount} 个核心特征`,
          suggestion: '核心特征应在 2-5 个之间'
        });
      }
    }
    
    // 检查场景中引用的角色是否已定义
    for (const scene of (blueprint.structure.scenes || [])) {
      if (scene.characters) {
        for (const cid of scene.characters) {
          checks.push({
            category: 'character',
            name: `scene_${scene.scene_id}_character_${cid}`,
            passed: characterIds.includes(cid),
            severity: 'critical',
            message: characterIds.includes(cid) ? `角色 ${cid} 已定义` : `角色 ${cid} 未定义`,
            suggestion: '场景中引用的角色必须在 character_system 中定义'
          });
        }
      }
    }
    
    return checks;
  }

  /**
   * Nirath 世界观检查
   */
  _checkNirathWorld(blueprint) {
    const checks = [];
    const scenes = blueprint.structure.scenes || [];
    
    // 检查是否包含 Nirath 环境元素
    let hasNirathElements = false;
    for (const scene of scenes) {
      if (scene.setting) {
        for (const element of this.config.nirathRequiredElements) {
          if (scene.setting.includes(element)) {
            hasNirathElements = true;
            break;
          }
        }
      }
      if (scene.visual_notes) {
        for (const element of this.config.nirathRequiredElements) {
          if (scene.visual_notes.includes(element)) {
            hasNirathElements = true;
            break;
          }
        }
      }
    }
    
    checks.push({
      category: 'nirath',
      name: 'nirath_elements',
      passed: hasNirathElements,
      severity: 'warning',
      message: hasNirathElements ? '包含 Nirath 环境元素' : '缺少 Nirath 环境元素',
      suggestion: `场景设定应包含 Nirath 特征元素：${this.config.nirathRequiredElements.join(', ')}`
    });
    
    // 检查是否违反明亮风格约束
    let hasDarkStyle = false;
    for (const scene of scenes) {
      if (scene.visual_notes) {
        const darkKeywords = ['暗黑', '黑暗', 'night', 'dark', '漆黑', '阴郁'];
        for (const keyword of darkKeywords) {
          if (scene.visual_notes.includes(keyword)) {
            hasDarkStyle = true;
            break;
          }
        }
      }
    }
    
    checks.push({
      category: 'nirath',
      name: 'bright_style',
      passed: !hasDarkStyle,
      severity: 'critical',
      message: hasDarkStyle ? '检测到暗黑风格（禁止）' : '明亮风格，合规',
      suggestion: 'Nirath 要求明亮多色彩强质感场景，禁止暗黑风格'
    });
    
    return checks;
  }

  /**
   * 禁止元素检查
   */
  _checkForbiddenElements(blueprint) {
    const checks = [];
    const scenes = blueprint.structure.scenes || [];
    
    for (const forbidden of this.config.forbiddenElements) {
      let found = false;
      let location = '';
      
      for (const scene of scenes) {
        const allText = JSON.stringify(scene);
        if (allText.includes(forbidden)) {
          found = true;
          location = scene.scene_id;
          break;
        }
      }
      
      checks.push({
        category: 'forbidden',
        name: `forbidden_${forbidden}`,
        passed: !found,
        severity: 'critical',
        message: found ? `检测到禁用元素 "${forbidden}"（场景 ${location}）` : `无 "${forbidden}"`,
        suggestion: `全局禁止 "${forbidden}"`
      });
    }
    
    return checks;
  }

  /**
   * 计算质量评分
   */
  _calculateScores(blueprint, checks) {
    const detailed = {};
    
    // 结构完整性评分
    const structuralChecks = checks.filter(c => c.category === 'structure');
    const structuralPassed = structuralChecks.filter(c => c.passed).length;
    detailed.structural_integrity = Math.round((structuralPassed / structuralChecks.length) * 100) || 0;
    
    // 时长合规评分
    const durationChecks = checks.filter(c => c.category === 'duration');
    const durationPassed = durationChecks.filter(c => c.passed).length;
    detailed.duration_compliance = Math.round((durationPassed / durationChecks.length) * 100) || 0;
    
    // 台词质量评分
    const dialogueChecks = checks.filter(c => c.category === 'dialogue');
    const dialoguePassed = dialogueChecks.filter(c => c.passed).length;
    detailed.dialogue_quality = Math.round((dialoguePassed / dialogueChecks.length) * 100) || 0;
    
    // 角色一致性评分
    const characterChecks = checks.filter(c => c.category === 'character');
    const characterPassed = characterChecks.filter(c => c.passed).length;
    detailed.character_consistency = Math.round((characterPassed / characterChecks.length) * 100) || 0;
    
    // Nirath 世界观评分
    const nirathChecks = checks.filter(c => c.category === 'nirath');
    const nirathPassed = nirathChecks.filter(c => c.passed).length;
    detailed.nirath_compliance = nirathChecks.length > 0 ? Math.round((nirathPassed / nirathChecks.length) * 100) : 100;
    
    // 综合评分
    const overall = Math.round(
      (detailed.structural_integrity * 0.25 +
       detailed.duration_compliance * 0.20 +
       detailed.dialogue_quality * 0.25 +
       detailed.character_consistency * 0.20 +
       detailed.nirath_compliance * 0.10)
    );
    
    return {
      overall,
      detailed,
      summary: {
        total_checks: checks.length,
        passed_checks: checks.filter(c => c.passed).length,
        failed_checks: checks.filter(c => !c.passed).length,
        critical_issues: checks.filter(c => !c.passed && c.severity === 'critical').length
      }
    };
  }

  /**
   * 生成修复建议
   */
  generateRepairPlan(validationReport) {
    const issues = validationReport.issues || [];
    const repairs = [];
    
    for (const issue of issues) {
      switch (issue.category) {
        case 'structure':
          repairs.push({
            type: 'structure',
            action: 'adjust_structure',
            description: issue.message,
            suggestion: issue.suggestion
          });
          break;
          
        case 'duration':
          repairs.push({
            type: 'duration',
            action: 'adjust_timing',
            description: issue.message,
            suggestion: issue.suggestion
          });
          break;
          
        case 'dialogue':
          repairs.push({
            type: 'dialogue',
            action: 'rewrite_dialogue',
            description: issue.message,
            suggestion: issue.suggestion
          });
          break;
          
        case 'character':
          repairs.push({
            type: 'character',
            action: 'add_character',
            description: issue.message,
            suggestion: issue.suggestion
          });
          break;
          
        case 'nirath':
          repairs.push({
            type: 'world_setting',
            action: 'adjust_setting',
            description: issue.message,
            suggestion: issue.suggestion
          });
          break;
          
        case 'forbidden':
          repairs.push({
            type: 'content',
            action: 'remove_forbidden',
            description: issue.message,
            suggestion: issue.suggestion
          });
          break;
      }
    }
    
    return {
      blueprint_id: validationReport.blueprint_id,
      repairs,
      priority: issues.filter(i => i.severity === 'critical').length > 0 ? 'high' : 'medium'
    };
  }
}

module.exports = { ScriptValidator };
