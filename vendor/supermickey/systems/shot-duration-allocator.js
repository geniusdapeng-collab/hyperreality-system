/**
 * 【系统级】镜头时长分配 Agent v2
 * 三阶段流水线：分析(analyze) → 分配(allocate) → 优化(optimize)
 * 
 * 核心升级（v2 vs v1）：
 * 1. 对象重要性驱动：importance(1-10)独立于字数决定时长
 * 2. 3-12秒弹性区间：替代硬编码3-5秒，按角色类型自适应
 * 3. 双池模型：语音基线池(60%) + 弹性加成池(40%)
 * 4. 重要性系数：critical 2.0x / high 1.6x / medium 1.0x / low 0.6x
 * 5. 三级自优化：L1压缩→L2精简建议→L3强制降级（不直接报错）
 * 6. 节奏曲线：起承转合/渐进式/波浪式/倒金字塔
 */

const SpeechRate = require('../hyperreality-system/config/speech-rate');

class ShotDurationAllocatorV2 {
  constructor(config = {}) {
    // 角色类型配置（时长基线 + 默认重要性 + 视觉复杂度）
    this.roleConfig = {
      'opening':     { min: 6, max: 12, baseImportance: 5, visualComplexity: 2, desc: '开场白' },
      'definition':  { min: 5, max: 10, baseImportance: 8, visualComplexity: 5, desc: '定义/概念' },
      'explanation': { min: 5, max: 12, baseImportance: 7, visualComplexity: 4, desc: '讲解/原理' },
      'demonstration':{ min: 6, max: 12, baseImportance: 9, visualComplexity: 8, desc: '示例/演示' },
      'interaction': { min: 4, max: 8,  baseImportance: 4, visualComplexity: 2, desc: '互动/提问' },
      'transition':  { min: 3, max: 6,  baseImportance: 3, visualComplexity: 2, desc: '过渡/衔接' },
      'highlight':   { min: 4, max: 8,  baseImportance: 7, visualComplexity: 4, desc: '强调/重点' },
      'closing':     { min: 5, max: 10, baseImportance: 4, visualComplexity: 2, desc: '结尾/总结' },
      // 🔥 v6.2-patch48-fix: 新增StoryCraft beatName角色
      'discovery':   { min: 5, max: 12, baseImportance: 6, visualComplexity: 5, desc: '发现/钩子' },
      'twist':       { min: 6, max: 12, baseImportance: 9, visualComplexity: 6, desc: '反转/转折' },
      'reveal':      { min: 6, max: 12, baseImportance: 8, visualComplexity: 6, desc: '揭露/真相' },
      'resolve':     { min: 5, max: 10, baseImportance: 7, visualComplexity: 4, desc: '解决/余韵' }
    };

    // 类型映射（兼容现有type字段 + StoryCraft beatName）
    this.typeMapping = {
      'host': 'opening',
      'explanation': 'explanation',
      'interaction': 'interaction',
      'symptom': 'explanation',
      'lab': 'explanation',
      'summary': 'closing',
      'definition': 'definition',
      'demonstration': 'demonstration',
      'highlight': 'highlight',
      'transition': 'transition',
      // 🔥 v1.1-fix: StoryCraft beatName映射
      '钩子': 'discovery',
      'hook': 'discovery',
      '深入': 'explanation',
      'deepen': 'explanation',
      '裂缝': 'interaction',
      'crack': 'interaction',
      '翻转': 'highlight',
      'twist': 'highlight',
      'climax': 'highlight',
      '余韵': 'closing',
      'resonance': 'closing',
      'resolution': 'closing'
    };

    this.config = {
      minDuration: 3,           // 绝对下限
      maxDuration: 15,          // 绝对上限（Seedance API真实上限，v6.0-patch31-fix: 从12改为15）
      maxShots: 20,             // 最多镜头数
      voicePoolRatio: 0.60,     // 语音基线池比例
      elasticPoolRatio: 0.40,   // 弹性加成池比例
      limitSpeed: SpeechRate.LIMIT,          // 【一致性修复】与校验侧统一口径：极限语速（字/秒）
      comfortSpeed: SpeechRate.NORMAL,         // 舒适语速（字/秒）
      bufferSeconds: 0.5,       // 缓冲时间
      // 语速配置（字/秒）- 按场景类型（用于可读性语速参考）
      speedMap: {
        'opening': 4.0,
        'definition': 4.5,
        'explanation': 4.5,
        'demonstration': 4.5,
        'interaction': 5.0,
        'transition': 5.0,
        'highlight': 4.5,
        'closing': 4.0,
        'default': 4.5
      },
      // 合并规则
      mergeRules: {
        maxNarrationsPerShot: 3,
        allowCrossTypeMerge: false,
        mustAloneTypes: ['opening', 'interaction', 'closing']
      },
      // 节奏曲线模板
      rhythmCurves: {
        'classic': { name: '起承转合', pattern: [1.2, 0.9, 1.0, 1.3, 0.8] },
        'progressive': { name: '渐进式', pattern: [0.9, 1.0, 1.1, 1.2, 1.3] },
        'wave': { name: '波浪式', pattern: [1.2, 0.8, 1.2, 0.8, 1.0] },
        'inverted': { name: '倒金字塔', pattern: [1.4, 1.1, 0.9, 0.8, 0.7] }
      },
      ...config
    };
  }

  /**
   * ========== 主入口 ==========
   */
  allocate(script) {
    const { totalDuration, narrations, rhythmCurve = 'classic' } = script;
    
    console.log('⏱️  镜头时长分配 v2 开始');
    console.log('='.repeat(60));
    console.log(`总时长预算: ${totalDuration}秒`);
    console.log(`narration数量: ${narrations.length}句`);
    console.log(`节奏曲线: ${this.config.rhythmCurves[rhythmCurve]?.name || '经典'}`);
    console.log('='.repeat(60));

    // ========== Stage 1: 内容分析 ==========
    console.log('\n📊 Stage 1: 内容分析...');
    const analyzed = this.analyze(narrations);
    this.printAnalysis(analyzed);

    // ========== Stage 2: 时长分配 ==========
    console.log('\n🎯 Stage 2: 时长分配...');
    const allocation = this.allocateInternal(analyzed, totalDuration);
    if (allocation.error) {
      return allocation; // L2/L3错误返回
    }
    this.printAllocation(allocation);

    // ========== Stage 3: 节奏优化 ==========
    console.log('\n🎵 Stage 3: 节奏优化...');
    const optimized = this.optimizeRhythm(allocation.shots, totalDuration, rhythmCurve);
    this.printOptimization(optimized);

    // ========== 最终验证 ==========
    const validation = this.validate(optimized.shots, totalDuration);

    // 生成报告
    const summary = this.generateSummary(optimized.shots, totalDuration, allocation);

    console.log('\n' + '='.repeat(60));
    console.log('📋 分配报告 v2');
    console.log('='.repeat(60));
    console.log(`总镜头: ${summary.totalShots}`);
    console.log(`总分配: ${summary.totalAllocated}秒 / ${totalDuration}秒预算`);
    console.log(`剩余额度: ${summary.remaining}秒`);
    console.log(`平均每镜: ${summary.averageDuration.toFixed(1)}秒`);
    console.log(`优化等级: ${allocation.optimizationLevel || 'L0-正常'}`);
    console.log(`节奏曲线: ${this.config.rhythmCurves[rhythmCurve]?.name || '经典'}`);
    console.log(`时长跨度: ${summary.minDuration}-${summary.maxDuration}秒`);
    console.log(`验证结果: ${validation.valid ? '✅通过' : '❌失败'}`);
    if (allocation.warnings?.length > 0) {
      console.log(`\n⚠️  警告 (${allocation.warnings.length}项):`);
      allocation.warnings.forEach(w => console.log(`   - ${w}`));
    }

    return {
      shots: optimized.shots,
      summary,
      validation,
      optimizationLevel: allocation.optimizationLevel || 'L0',
      warnings: allocation.warnings || []
    };
  }

  /**
   * ========== Stage 1: 内容分析 ==========
   * 语义角色识别 + 对象重要性评估 + 视觉复杂度评估
   */
  analyze(narrations) {
    return narrations.map((n, index) => {
      const charCount = this.countChineseChars(n.text);
      
      // 角色识别（type → role）
      let role = this.typeMapping[n.type] || 'explanation';
      const roleCfg = this.roleConfig[role];
      
      // 对象重要性（用户提供 > 角色默认 > 位置推断）
      let importance = n.importance;
      // 修复：如果importance是字符串（如'critical'/'high'），转换为数字
      if (typeof importance === 'string') {
        importance = this.stringImportanceToNumber(importance);
      }
      if (importance === undefined || importance === null) {
        // 用户提供priority字段时，映射到importance
        if (n.priority !== undefined) {
          importance = this.priorityToImportance(n.priority);
        } else {
          importance = roleCfg.baseImportance;
        }
      }
      // 首段自动提升为开场白
      if (index === 0 && role !== 'opening') {
        role = 'opening';
        importance = Math.max(importance, 5);
      }
      // 末段自动识别为结尾
      if (index === narrations.length - 1 && role === 'explanation') {
        role = 'closing';
        importance = Math.min(importance, 5);
      }

      // 视觉复杂度（用户提供 > 角色默认）
      const visualComplexity = n.visualComplexity || roleCfg.visualComplexity;

      // 语音基线（极限语速计算，只保证"说得完"）
      const voiceBaseline = Math.max(
        Math.ceil((charCount / this.config.limitSpeed) + this.config.bufferSeconds),
        this.config.minDuration
      );

      // 可读性语速参考（用于后续warning）
      const comfortSpeed = this.config.speedMap[role] || this.config.speedMap.default;
      const comfortDuration = Math.ceil((charCount / comfortSpeed) + this.config.bufferSeconds);

      return {
        ...n,
        charCount,
        role,
        roleDesc: roleCfg.desc,
        importance,
        importanceLevel: this.importanceToLevel(importance),
        visualComplexity,
        voiceBaseline,
        comfortDuration,
        // 时长范围建议
        suggestedMin: roleCfg.min,
        suggestedMax: roleCfg.max
      };
    });
  }

  /**
   * ========== Stage 2: 时长分配 ==========
   * 双池模型：语音基线池(60%) + 弹性加成池(40%)
   */
  allocateInternal(analyzed, totalDuration) {
    const voicePool = totalDuration * this.config.voicePoolRatio;   // 60%
    const elasticPool = totalDuration * this.config.elasticPoolRatio; // 40%

    // 计算每句的初步时长
    const withAllocation = analyzed.map(n => {
      // 重要性系数
      const importanceCoeff = this.importanceToCoeff(n.importance);
      
      // 视觉复杂度加成
      const visualBonus = n.visualComplexity * 0.3;
      
      // 初步时长 = 语音基线 × 重要性系数 + 视觉加成
      let rawDuration = n.voiceBaseline * importanceCoeff + visualBonus;
      
      // 裁剪到角色建议范围
      rawDuration = Math.max(n.suggestedMin, Math.min(n.suggestedMax, rawDuration));
      
      // 裁剪到硬约束
      rawDuration = Math.max(this.config.minDuration, Math.min(this.config.maxDuration, rawDuration));
      
      return {
        ...n,
        importanceCoeff: importanceCoeff.toFixed(2),
        visualBonus: visualBonus.toFixed(1),
        rawDuration: Math.round(rawDuration)
      };
    });

    // 计算初步总时长
    const totalRaw = withAllocation.reduce((sum, n) => sum + n.rawDuration, 0);
    const totalVoiceBaseline = withAllocation.reduce((sum, n) => sum + n.voiceBaseline, 0);

    let optimizationLevel = 'L0';
    let warnings = [];

    // ========== L0: 正常分配 ==========
    if (totalRaw <= totalDuration) {
      console.log(`   L0: 初步时长${totalRaw}秒 ≤ 预算${totalDuration}秒，正常分配`);
      
      // 余量再分配：优先给high/critical镜头
      let remaining = totalDuration - totalRaw;
      const prioritized = [...withAllocation].map((n, i) => ({ ...n, index: i }))
        .sort((a, b) => b.importance - a.importance);
      
      const allocated = withAllocation.map(n => ({ ...n, duration: n.rawDuration }));
      
      for (const p of prioritized) {
        if (remaining <= 0) break;
        const maxAdd = Math.min(remaining, this.config.maxDuration - allocated[p.index].duration);
        if (maxAdd > 0) {
          allocated[p.index].duration += maxAdd;
          remaining -= maxAdd;
        }
      }

      return { shots: this.groupToShots(allocated), optimizationLevel, warnings, totalRaw };
    }

    // ========== L1: 智能压缩 ==========
    // 压缩率 = 1.0 - (importance - 3) × 0.06
    // critical(10): 0.58, high(8): 0.70, medium(5): 0.88, low(3): 1.00
    console.log(`   L1: 初步时长${totalRaw}秒 > 预算${totalDuration}秒，触发智能压缩`);
    
    const compressed = withAllocation.map(n => {
      const compressionRate = Math.max(0.3, 1.0 - (n.importance - 3) * 0.06);
      // 压缩语音基线，视觉加成不压缩
      const compressedVoice = n.voiceBaseline * compressionRate;
      let compressedDuration = compressedVoice + n.visualComplexity * 0.3;
      
      // 裁剪
      compressedDuration = Math.max(n.suggestedMin, Math.min(n.suggestedMax, compressedDuration));
      compressedDuration = Math.max(this.config.minDuration, Math.min(this.config.maxDuration, compressedDuration));
      
      return {
        ...n,
        compressionRate: compressionRate.toFixed(2),
        compressedVoice: compressedVoice.toFixed(1),
        duration: Math.round(compressedDuration)
      };
    });

    const totalCompressed = compressed.reduce((sum, n) => sum + n.duration, 0);
    
    if (totalCompressed <= totalDuration) {
      optimizationLevel = 'L1';
      warnings.push(`L1智能压缩已触发：语速提升至极限，重要内容优先保障`);
      
      // 余量再分配
      let remaining = totalDuration - totalCompressed;
      const prioritized = [...compressed].map((n, i) => ({ ...n, index: i }))
        .sort((a, b) => b.importance - a.importance);
      
      for (const p of prioritized) {
        if (remaining <= 0) break;
        const maxAdd = Math.min(remaining, this.config.maxDuration - compressed[p.index].duration);
        if (maxAdd > 0) {
          compressed[p.index].duration += maxAdd;
          remaining -= maxAdd;
        }
      }
      
      return { shots: this.groupToShots(compressed), optimizationLevel, warnings, totalRaw };
    }

    // ========== L2: 精简建议 ==========
    console.log(`   L2: 压缩后${totalCompressed}秒仍 > 预算${totalDuration}秒，需要精简内容`);
    
    const overload = totalCompressed - totalDuration;
    const suggestions = [];
    
    // 找出可精简的低重要性内容
    const lowPriorityItems = compressed.filter(n => n.importance <= 4)
      .sort((a, b) => a.importance - b.importance);
    
    if (lowPriorityItems.length > 0) {
      const canSave = lowPriorityItems.reduce((sum, n) => sum + n.duration, 0);
      suggestions.push(`删除${lowPriorityItems.length}句低优先级内容(importance≤4)，可节省约${canSave}秒`);
    }
    
    // 建议增加预算
    const suggestedBudget = Math.ceil(totalCompressed / 5) * 5;
    suggestions.push(`建议将总时长预算从${totalDuration}秒增至${suggestedBudget}秒`);
    
    // 建议精简高字数低重要性内容
    const pruneCandidates = compressed
      .filter(n => n.importance <= 5 && n.charCount > 20)
      .map(n => `${n.id}: ${n.charCount}字, importance=${n.importance}, 可精简至${Math.floor((n.duration - 0.5) * this.config.limitSpeed)}字`);
    
    if (pruneCandidates.length > 0) {
      suggestions.push(`以下 narration 字数多但重要性低，建议精简：`);
      pruneCandidates.forEach(c => suggestions.push(`   - ${c}`));
    }

    // ========== L3: 强制降级（用户选择不修改时） ==========
    // 这里提供L2输出，让上层决策。如果用户选择强制分配，调用forcedAllocate
    return {
      error: 'CONTENT_OVERLOAD_L2',
      message: `内容超载${overload}秒（压缩后${totalCompressed} > 预算${totalDuration}），需要精简或增加预算`,
      optimizationLevel: 'L2',
      totalRaw,
      totalCompressed,
      totalDuration,
      overload,
      suggestions,
      warnings: [...warnings, `L2: 内容超载${overload}秒，建议精简或增加预算`],
      narrations: compressed.map(n => ({
        id: n.id,
        text: n.text.substring(0, 40) + '...',
        charCount: n.charCount,
        importance: n.importance,
        role: n.role,
        voiceBaseline: n.voiceBaseline,
        rawDuration: n.rawDuration,
        compressedDuration: n.duration,
        compressionRate: n.compressionRate
      }))
    };
  }

  /**
   * L3: 强制降级分配（当用户选择不精简内容时）
   */
  forcedAllocate(script) {
    const { totalDuration, narrations } = script;
    
    console.log('⏱️  L3强制降级分配开始');
    console.log('='.repeat(60));
    console.log(`总时长预算: ${totalDuration}秒（强制模式）`);
    console.log('='.repeat(60));

    const analyzed = this.analyze(narrations);
    
    // 强制模式：取消所有加成，只用语音基线
    const forced = analyzed.map(n => {
      let duration = n.voiceBaseline;
      // 硬约束裁剪
      duration = Math.max(this.config.minDuration, Math.min(this.config.maxDuration, duration));
      return { ...n, duration: Math.round(duration) };
    });

    // 归一化到预算
    const totalForced = forced.reduce((sum, n) => sum + n.duration, 0);
    
    if (totalForced > totalDuration) {
      // 按比例压缩
      const ratio = totalDuration / totalForced;
      forced.forEach(n => {
        n.duration = Math.max(this.config.minDuration, Math.floor(n.duration * ratio));
      });
    }

    // 处理余量
    let totalAllocated = forced.reduce((sum, n) => sum + n.duration, 0);
    let remaining = totalDuration - totalAllocated;
    
    if (remaining > 0) {
      const prioritized = [...forced].map((n, i) => ({ ...n, index: i }))
        .sort((a, b) => b.importance - a.importance);
      for (const p of prioritized) {
        if (remaining <= 0) break;
        const maxAdd = Math.min(remaining, this.config.maxDuration - forced[p.index].duration);
        if (maxAdd > 0) {
          forced[p.index].duration += maxAdd;
          remaining -= maxAdd;
        }
      }
    }

    const shots = this.groupToShots(forced);
    const optimized = this.optimizeRhythm(shots, totalDuration, script.rhythmCurve || 'classic');

    return {
      shots: optimized.shots,
      optimizationLevel: 'L3',
      warnings: ['L3强制降级：所有加成已取消，成片可能语速过快，建议后续精简内容'],
      summary: this.generateSummary(optimized.shots, totalDuration, { totalRaw: totalForced })
    };
  }

  /**
   * ========== Stage 3: 节奏优化 ==========
   * 节奏曲线拟合 + 相邻差异平滑 + 疲劳度检查
   */
  optimizeRhythm(shots, totalDuration, curveType = 'classic') {
    const curve = this.config.rhythmCurves[curveType] || this.config.rhythmCurves.classic;
    const pattern = curve.pattern;
    
    // 1. 节奏曲线拟合：根据位置调整时长
    const avgDuration = totalDuration / shots.length;
    const rhythmAdjusted = shots.map((shot, index) => {
      const patternIndex = Math.min(index, pattern.length - 1);
      const multiplier = pattern[patternIndex];
      const targetDuration = avgDuration * multiplier;
      
      // 在原duration基础上，向target靠近（权重30%）
      const blended = shot.duration * 0.7 + targetDuration * 0.3;
      
      return {
        ...shot,
        duration: Math.round(Math.max(this.config.minDuration, Math.min(this.config.maxDuration, blended))),
        rhythmPosition: this.getRhythmPosition(index, shots.length),
        rhythmAdjustment: (targetDuration - shot.duration).toFixed(1)
      };
    });

    // 2. 相邻差异平滑：避免连续相同时长
    const smoothed = [...rhythmAdjusted];
    for (let i = 1; i < smoothed.length; i++) {
      const diff = Math.abs(smoothed[i].duration - smoothed[i-1].duration);
      if (diff < 1) {
        // 差异太小，尝试制造节奏变化
        let changed = false;
        if (smoothed[i].importance >= smoothed[i-1].importance) {
          // 当前镜更重要或同等：尝试增加当前镜，减少前一镜
          if (smoothed[i].duration < this.config.maxDuration) {
            smoothed[i].duration = Math.min(this.config.maxDuration, smoothed[i].duration + 1);
            changed = true;
          } else if (smoothed[i-1].duration > this.config.minDuration) {
            // 当前镜已达上限，减少前一镜
            smoothed[i-1].duration = Math.max(this.config.minDuration, smoothed[i-1].duration - 1);
            changed = true;
          }
        } else {
          // 前一镜更重要：尝试增加前一镜，减少当前镜
          if (smoothed[i-1].duration < this.config.maxDuration) {
            smoothed[i-1].duration = Math.min(this.config.maxDuration, smoothed[i-1].duration + 1);
            changed = true;
          } else if (smoothed[i].duration > this.config.minDuration) {
            // 前一镜已达上限，减少当前镜
            smoothed[i].duration = Math.max(this.config.minDuration, smoothed[i].duration - 1);
            changed = true;
          }
        }
        // 如果两个都卡在边界无法调整，跳过（边界情况）
        if (!changed) {
          console.log(`   ℹ️  镜头${smoothed[i-1].id}(${smoothed[i-1].duration}秒)和${smoothed[i].id}(${smoothed[i].duration}秒)均卡在边界，无法调整节奏差异`);
        }
      }
    }

    // 3. 疲劳度检查：连续同角色不超过2镜
    const fatigueWarnings = [];
    let sameRoleCount = 1;
    for (let i = 1; i < smoothed.length; i++) {
      // 🔥 v1.1-fix: groupToShots 用 type 字段存储角色类型，回退到 role
      const currentRole = smoothed[i].type || smoothed[i].role || 'unknown';
      const prevRole = smoothed[i-1].type || smoothed[i-1].role || 'unknown';
      if (currentRole === prevRole) {
        sameRoleCount++;
        if (sameRoleCount >= 3) {
          fatigueWarnings.push(`镜头${smoothed[i-2].id}-${smoothed[i].id}连续3镜同角色(${currentRole})，建议拆分或插入过渡`);
        }
      } else {
        sameRoleCount = 1;
      }
    }

    // 4. 最终归一化到总预算
    let totalAllocated = smoothed.reduce((sum, s) => sum + s.duration, 0);
    let remaining = totalDuration - totalAllocated;
    
    // 微调时长使总和等于预算（从最后一镜开始调整）
    let adjustIndex = smoothed.length - 1;
    while (Math.abs(remaining) >= 1 && adjustIndex >= 0) {
      const shot = smoothed[adjustIndex];
      const maxAdjust = remaining > 0 
        ? this.config.maxDuration - shot.duration
        : shot.duration - this.config.minDuration;
      
      const adjust = Math.min(Math.abs(remaining), maxAdjust) * (remaining > 0 ? 1 : -1);
      shot.duration += adjust;
      remaining -= adjust;
      adjustIndex--;
    }

    return {
      shots: smoothed,
      curve: curve.name,
      fatigueWarnings
    };
  }

  /**
   * 智能分组：将 narration 组合并为镜头
   */
  groupToShots(narrations) {
    const groups = [];
    let currentGroup = [];
    
    narrations.forEach((n, index) => {
      // 必须独立的类型
      const mustAlone = n.mustAlone || this.config.mergeRules.mustAloneTypes.includes(n.role);
      
      if (mustAlone) {
        if (currentGroup.length > 0) {
          groups.push([...currentGroup]);
          currentGroup = [];
        }
        groups.push([n]);
        return;
      }
      
      // 检查是否可以合并
      const canMerge = currentGroup.length === 0 || (
        currentGroup.length < this.config.mergeRules.maxNarrationsPerShot &&
        (this.config.mergeRules.allowCrossTypeMerge || currentGroup[0].role === n.role) &&
        currentGroup.reduce((sum, m) => sum + m.duration, 0) + n.duration <= this.config.maxDuration
      );
      
      if (canMerge) {
        currentGroup.push(n);
      } else {
        if (currentGroup.length > 0) {
          groups.push([...currentGroup]);
        }
        currentGroup = [n];
      }
    });
    
    if (currentGroup.length > 0) {
      groups.push(currentGroup);
    }

    // 创建镜头
    return groups.map((group, index) => {
      const narrationIds = group.map(n => n.id);
      const narrationText = group.map(n => n.text).join('');
      const totalDuration = group.reduce((sum, n) => sum + n.duration, 0);
      const maxImportance = Math.max(...group.map(n => n.importance));
      const maxVisual = Math.max(...group.map(n => n.visualComplexity));
      
      return {
        id: `S${String(index + 1).padStart(2, '0')}`,
        narrationIds,
        narration: narrationText,
        type: group[0].role,
        importance: maxImportance,
        visualComplexity: maxVisual,
        duration: totalDuration,
        charCount: group.reduce((sum, n) => sum + n.charCount, 0),
        voiceBaseline: group.reduce((sum, n) => sum + n.voiceBaseline, 0),
        optimizationLogs: group.map(n => ({
          id: n.id,
          importance: n.importance,
          compressionRate: n.compressionRate,
          visualBonus: n.visualBonus
        }))
      };
    });
  }

  /**
   * 辅助方法：重要性转等级
   */
  importanceToLevel(score) {
    if (score >= 9) return 'critical';
    if (score >= 7) return 'high';
    if (score >= 4) return 'medium';
    return 'low';
  }

  /**
   * 辅助方法：重要性转系数
   */
  importanceToCoeff(score) {
    // linear mapping: 3->0.6, 5->1.0, 8->1.6, 10->2.0
    return 0.6 + (score - 3) * 0.175;
  }

  /**
   * 辅助方法：字符串importance（critical/high/medium/low）转数字
   */
  stringImportanceToNumber(str) {
    const mapping = {
      'critical': 10,
      'high': 8,
      'medium': 5,
      'low': 3
    };
    return mapping[str] || 5;
  }

  /**
   * 辅助方法：priority(1-5) 转 importance(1-10)
   */
  priorityToImportance(priority) {
    // priority 1=最高 → importance 10
    // priority 5=最低 → importance 3
    return Math.max(3, 11 - priority * 2);
  }

  /**
   * 辅助方法：获取节奏位置
   */
  getRhythmPosition(index, total) {
    if (total <= 2) return index === 0 ? '起' : '合';
    if (index === 0) return '起';
    if (index === total - 1) return '合';
    if (index < total * 0.4) return '承';
    return '转';
  }

  /**
   * 打印分析结果
   */
  printAnalysis(analyzed) {
    console.log('   角色识别 + 重要性评估:');
    analyzed.forEach(n => {
      console.log(`   ${n.id}: ${n.roleDesc} | ${n.charCount}字 | importance=${n.importance}(${n.importanceLevel}) | visual=${n.visualComplexity} | 语音基线=${n.voiceBaseline}秒`);
    });
  }

  /**
   * 打印分配结果
   */
  printAllocation(allocation) {
    if (allocation.error) {
      console.log(`   ${allocation.optimizationLevel}: ${allocation.message}`);
      allocation.suggestions?.forEach(s => console.log(`      💡 ${s}`));
      return;
    }
    
    console.log('   初步时长分配:');
    allocation.shots.forEach(shot => {
      const logs = shot.optimizationLogs.map(l => 
        `${l.id}(imp=${l.importance},压缩=${l.compressionRate || '无'},视觉+${l.visualBonus || 0})`
      ).join(', ');
      console.log(`   ${shot.id}: ${shot.duration}秒 | ${shot.type} | ${logs}`);
    });
  }

  /**
   * 打印优化结果
   */
  printOptimization(optimized) {
    console.log(`   节奏曲线: ${optimized.curve}`);
    optimized.shots.forEach(shot => {
      console.log(`   ${shot.id}: ${shot.duration}秒 | ${shot.rhythmPosition} | 节奏调整${shot.rhythmAdjustment > 0 ? '+' : ''}${shot.rhythmAdjustment}秒`);
    });
    if (optimized.fatigueWarnings.length > 0) {
      console.log('   ⚠️ 疲劳度警告:');
      optimized.fatigueWarnings.forEach(w => console.log(`      ${w}`));
    }
  }

  /**
   * 验证结果
   */
  validate(shots, totalDuration) {
    const errors = [];
    const warnings = [];
    
    shots.forEach(shot => {
      if (shot.duration < this.config.minDuration) {
        errors.push(`${shot.id}时长${shot.duration}秒 < 最小${this.config.minDuration}秒`);
      }
      if (shot.duration > this.config.maxDuration) {
        errors.push(`${shot.id}时长${shot.duration}秒 > 最大${this.config.maxDuration}秒`);
      }
    });
    
    if (shots.length > this.config.maxShots) {
      errors.push(`总镜头数${shots.length} > 最大${this.config.maxShots}`);
    }
    
    const totalAllocated = shots.reduce((sum, s) => sum + s.duration, 0);
    if (totalAllocated > totalDuration) {
      errors.push(`总时长${totalAllocated}秒 > 预算${totalDuration}秒`);
    }
    
    if (totalAllocated < totalDuration * 0.7) {
      warnings.push(`总时长${totalAllocated}秒 远小于预算${totalDuration}秒(${((totalAllocated/totalDuration)*100).toFixed(0)}%)，内容可能不足`);
    }
    
    return { valid: errors.length === 0, errors, warnings };
  }

  /**
   * 生成报告
   */
  generateSummary(shots, totalDuration, allocation = {}) {
    const totalAllocated = shots.reduce((sum, s) => sum + s.duration, 0);
    const durations = shots.map(s => s.duration);
    
    return {
      totalShots: shots.length,
      totalAllocated,
      remaining: totalDuration - totalAllocated,
      averageDuration: totalAllocated / shots.length,
      minDuration: Math.min(...durations),
      maxDuration: Math.max(...durations),
      durationRange: `${Math.min(...durations)}-${Math.max(...durations)}秒`,
      shotDetails: shots.map(s => ({
        id: s.id,
        duration: s.duration,
        type: s.type,
        importance: s.importance,
        charCount: s.charCount,
        narrationCount: s.narrationIds.length,
        rhythmPosition: s.rhythmPosition
      }))
    };
  }

  /**
   * 统计中文字符数
   */
  countChineseChars(text) {
    if (!text) return 0;
    const chineseMatches = text.match(/[\u4e00-\u9fff]/g);
    return chineseMatches ? chineseMatches.length : 0;
  }
}

// 导出时同时保留旧类名兼容性
module.exports = { ShotDurationAllocator: ShotDurationAllocatorV2 };

// CLI用法
if (require.main === module) {
  const fs = require('fs');
  const scriptPath = process.argv[2];
  
  if (!scriptPath) {
    console.log('用法: node shot-duration-allocator.js <script.json>');
    process.exit(1);
  }
  
  const scriptData = fs.readFileSync(scriptPath, 'utf8');
  const script = JSON.parse(scriptData);
  const allocator = new ShotDurationAllocatorV2();
  const result = allocator.allocate(script);
  
  // 保存结果
  const outputPath = scriptPath.replace('.json', '-v2-draft.json');
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
  console.log(`\n💾 结果已保存: ${outputPath}`);
}
