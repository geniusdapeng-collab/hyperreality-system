/**
 * 【约束仲裁引擎】Constraint Arbitration Engine v1.1
 * 
 * v1.1 修复：
 * - 添加单位映射表（脚→足，翅膀→翼，等）
 * - 标准化用户输入中的单位词
 * - 修复单位匹配逻辑
 * 
 * 职责：
 * - 将用户约束(P0/P1)应用到角色Profile
 * - 处理冲突：P0覆盖P1，P1覆盖知识库
 * - 输出带冲突标记的最终Profile
 * 
 * 核心原则：
 * 用户硬约束(P0) > 用户事实描述(P1) > 知识库/系统默认
 */

class ConstraintArbitrationEngine {
  constructor(config = {}) {
    this.config = {
      // 冲突检测阈值
      conflictThreshold: config.conflictThreshold ?? 0.5,
      // 是否自动应用P0约束
      autoApplyP0: config.autoApplyP0 ?? true,
      // 是否保留原始值用于审计
      preserveOriginal: config.preserveOriginal ?? true,
      // 单位映射表：用户常用词 → 标准词
      unitMapping: config.unitMapping ?? this.getDefaultUnitMapping(),
      ...config
    };
  }

  /**
   * 主入口：仲裁用户约束与角色Profile
   */
  arbitrate(priorityLayers, baseProfile, options = {}) {
    const { P0_HARD, P1_FACT } = priorityLayers;
    
    console.log(`⚖️ 启动约束仲裁引擎...`);
    console.log(`   P0硬约束: ${P0_HARD.length}条`);
    console.log(`   P1事实描述: ${P1_FACT.length}条`);
    
    // 深拷贝原始Profile
    let profile = JSON.parse(JSON.stringify(baseProfile));
    
    // 初始化审计日志
    const auditLog = [];
    const appliedConstraints = {
      P0: [],
      P1: [],
      conflicts: []
    };
    
    // Step 1: 应用P1事实描述（覆盖知识库的冲突部分）
    if (P1_FACT.length > 0) {
      const p1Result = this.applyP1Constraints(profile, P1_FACT);
      profile = p1Result.profile;
      appliedConstraints.P1 = p1Result.applied;
      auditLog.push(...p1Result.log);
    }
    
    // Step 2: 应用P0硬约束（最高优先级，强制覆盖）
    if (P0_HARD.length > 0 && this.config.autoApplyP0) {
      const p0Result = this.applyP0Constraints(profile, P0_HARD);
      profile = p0Result.profile;
      appliedConstraints.P0 = p0Result.applied;
      auditLog.push(...p0Result.log);
    }
    
    // Step 3: 冲突检测与标记
    const conflicts = this.detectConflicts(baseProfile, profile, P0_HARD, P1_FACT);
    appliedConstraints.conflicts = conflicts;
    
    // Step 4: 添加仲裁元数据
    profile._arbitration = {
      timestamp: new Date().toISOString(),
      version: 'v1.1',
      originalProfileId: baseProfile.id,
      p0Count: P0_HARD.length,
      p1Count: P1_FACT.length,
      conflictCount: conflicts.length,
      auditLog: auditLog
    };
    
    // 如果有冲突，在Profile中标记
    if (conflicts.length > 0) {
      profile._conflicts = conflicts;
      console.log(`⚠️ 检测到 ${conflicts.length} 个冲突，已按优先级解决`);
      conflicts.forEach(c => {
        console.log(`   ${c.type}: ${c.unit || c.field} ${c.original} → ${c.modified} (原因: ${c.reason})`);
      });
    }
    
    return {
      profile,
      conflicts,
      auditLog,
      appliedConstraints
    };
  }

  /**
   * 标准化单位词（用户输入 → 标准词）
   */
  _normalizeUnit(unit) {
    const mapping = this.config.unitMapping;
    return mapping[unit] || unit;
  }

  /**
   * 查找Profile中的肢体（使用标准化匹配）
   */
  _findLimb(countArray, targetUnit) {
    if (!countArray || !Array.isArray(countArray)) return null;
    
    const normalizedTarget = this._normalizeUnit(targetUnit);
    
    return countArray.find(c => {
      const normalizedUnit = this._normalizeUnit(c.unit);
      return normalizedUnit === normalizedTarget ||
             c.unit === targetUnit ||
             targetUnit.includes(c.unit) ||
             c.unit.includes(targetUnit);
    });
  }

  /**
   * 查找Profile中的肢体索引
   */
  _findLimbIndex(countArray, targetUnit) {
    if (!countArray || !Array.isArray(countArray)) return -1;
    
    const normalizedTarget = this._normalizeUnit(targetUnit);
    
    return countArray.findIndex(c => {
      const normalizedUnit = this._normalizeUnit(c.unit);
      return normalizedUnit === normalizedTarget ||
             c.unit === targetUnit ||
             targetUnit.includes(c.unit) ||
             c.unit.includes(targetUnit);
    });
  }

  /**
   * 应用P1事实描述
   */
  applyP1Constraints(profile, p1Constraints) {
    const applied = [];
    const log = [];
    
    for (const constraint of p1Constraints) {
      const result = this.applySingleP1(profile, constraint);
      if (result.applied) {
        applied.push({
          constraint: constraint.text,
          field: result.field,
          value: result.value
        });
        log.push(`[P1] 应用: "${constraint.text}" → ${result.field}=${JSON.stringify(result.value)}`);
      }
    }
    
    return { profile, applied, log };
  }

  /**
   * 应用单个P1约束
   */
  applySingleP1(profile, constraint) {
    const text = constraint.text;
    const vi = profile.visualIdentity || {};
    
    // P1-数量
    const countMatch = text.match(/([一二三四五六七八九十\d]+)(?:只|条|个|片|根|对|双)?(?:足|翼|翅|腿|脚|臂|手|头|尾|角)/);
    if (countMatch) {
      const number = this._parseNumber(countMatch[1]);
      const unitMatch = text.match(/(?:足|翼|翅|腿|脚|臂|手|头|尾|角)/);
      const rawUnit = unitMatch ? unitMatch[0] : '肢体';
      const unit = this._normalizeUnit(rawUnit);
      
      if (!vi.count) vi.count = [];
      
      const existing = this._findLimb(vi.count, rawUnit);
      if (existing) {
        if (this.config.preserveOriginal && !existing.originalNumber) {
          existing.originalNumber = existing.number;
        }
        existing.number = number;
        existing.source = 'P1_FACT';
      } else {
        vi.count.push({
          number,
          unit,
          distribution: '用户指定',
          source: 'P1_FACT'
        });
      }
      
      return { applied: true, field: `count.${unit}`, value: number };
    }
    
    // P1-颜色
    const colorMatch = text.match(/([红黄白黑青蓝紫橙绿金银])色?/);
    if (colorMatch) {
      if (!vi.color) vi.color = [];
      if (!vi.color.includes(colorMatch[1])) {
        vi.color.push(colorMatch[1]);
      }
      return { applied: true, field: 'color', value: colorMatch[1] };
    }
    
    // P1-形态
    const shapeMatch = text.match(/形如([^，。]+)|状如([^，。]+)/);
    if (shapeMatch) {
      const shape = shapeMatch[1] || shapeMatch[2];
      if (!vi.shape) vi.shape = [];
      if (!vi.shape.includes(shape)) {
        vi.shape.push(shape);
      }
      return { applied: true, field: 'shape', value: shape };
    }
    
    // P1-大小
    const sizeMatch = text.match(/(?:直径|大小|约)\s*([\d\.]+)\s*(米|厘米|毫米|尺)/);
    if (sizeMatch) {
      if (!vi.size) vi.size = [];
      vi.size.push(`${sizeMatch[1]}${sizeMatch[2]}`);
      return { applied: true, field: 'size', value: `${sizeMatch[1]}${sizeMatch[2]}` };
    }
    
    // P1-面部
    const faceMatch = text.match(/(无面目|没有五官|无脸|没有眼睛|没有嘴巴|光滑曲面)/);
    if (faceMatch) {
      if (!vi.face) vi.face = [];
      if (!vi.face.includes(faceMatch[1])) {
        vi.face.push(faceMatch[1]);
      }
      return { applied: true, field: 'face', value: faceMatch[1] };
    }
    
    return { applied: false };
  }

  /**
   * 应用P0硬约束
   */
  applyP0Constraints(profile, p0Constraints) {
    const applied = [];
    const log = [];
    
    for (const constraint of p0Constraints) {
      const result = this.applySingleP0(profile, constraint);
      if (result.applied) {
        applied.push({
          constraint: constraint.text,
          field: result.field,
          originalValue: result.originalValue,
          newValue: result.newValue
        });
        log.push(`[P0] 强制: "${constraint.text}" → ${result.field} ${result.originalValue}→${result.newValue}`);
      }
    }
    
    return { profile, applied, log };
  }

  /**
   * 应用单个P0约束
   */
  applySingleP0(profile, constraint) {
    const text = constraint.text;
    const vi = profile.visualIdentity || {};
    
    // P0-数量修改：支持"改为X只/Y条"和"X改为Y条"两种格式
    let countModifyMatch = text.match(/(?:改为?|改成?|有?了?|我要)\s*([一二三四五六七八九十\d]+)\s*(?:只|条|个|片|根|对|双)?\s*(足|翼|翅|腿|脚|臂|手|头|尾|角|翅膀)/);
    let newNumber, rawUnit;
    
    if (countModifyMatch) {
      // 格式1: "改为9只脚" → group1=number, group2=unit
      newNumber = this._parseNumber(countModifyMatch[1]);
      rawUnit = countModifyMatch[2];
    } else {
      // 格式2: "脚改为10条" → group1=unit, group2=number
      countModifyMatch = text.match(/(足|翼|翅|腿|脚|臂|手|头|尾|角|翅膀)\s*(?:改为?|改成?)\s*([一二三四五六七八九十\d]+)\s*(?:只|条|个|片|根|对|双)?/);
      if (countModifyMatch) {
        newNumber = this._parseNumber(countModifyMatch[2]);
        rawUnit = countModifyMatch[1];
      }
    }
    if (countModifyMatch) {
      const unit = this._normalizeUnit(rawUnit);
      
      // 确保vi.count是数组格式
      if (!vi.count) {
        vi.count = [];
      } else if (typeof vi.count === 'object' && !Array.isArray(vi.count)) {
        // 转换对象格式 {legs: 6, wings: 4} → 数组格式
        const countArray = [];
        for (const [key, value] of Object.entries(vi.count)) {
          countArray.push({
            number: value,
            unit: key === 'legs' ? '足' : key === 'wings' ? '翼' : key,
            distribution: '知识库默认'
          });
        }
        vi.count = countArray;
      }
      
      const existingIndex = this._findLimbIndex(vi.count, rawUnit);
      
      if (existingIndex >= 0) {
        const existing = vi.count[existingIndex];
        const originalValue = existing.number;
        if (this.config.preserveOriginal && !existing.originalNumber) {
          existing.originalNumber = originalValue;
        }
        existing.number = newNumber;
        existing.modifiedBy = 'P0_HARD';
        existing.modifiedAt = new Date().toISOString();
        
        return {
          applied: true,
          field: `count.${unit}`,
          originalValue,
          newValue: newNumber
        };
      } else {
        // 知识库中没有此肢体，用户要求新增
        vi.count.push({
          number: newNumber,
          unit,
          distribution: '用户强制添加',
          source: 'P0_HARD',
          isNew: true
        });
        return {
          applied: true,
          field: `count.${unit}`,
          originalValue: 0,
          newValue: newNumber
        };
      }
    }
    
    // P0-移除约束：支持"不要翅膀""去掉四翼""翅膀不要了"等格式
    const removeMatch = text.match(/(?:不要|去掉|没有|删除)\s*(?:了?)?\s*(?:任何|所有)?\s*(足|翼|翅|腿|脚|臂|手|头|尾|角|翅膀|眼睛|鼻子|嘴巴|耳朵|五官|毛发|尾巴|兽耳|兽尾)/) ||
                        text.match(/(翅膀|翼|翅|足|脚|腿|臂|手|头|尾|角|尾巴|兽耳|兽尾|五官|眼睛|鼻子|嘴巴|耳朵|毛发)\s*(?:不要|去掉|没有|删除)/);
    if (removeMatch) {
      const rawTarget = removeMatch[1];
      const target = this._normalizeUnit(rawTarget);
      
      // 确保vi.count是数组格式
      if (!vi.count) {
        vi.count = [];
      } else if (typeof vi.count === 'object' && !Array.isArray(vi.count)) {
        // 转换对象格式 → 数组格式
        const countArray = [];
        for (const [key, value] of Object.entries(vi.count)) {
          countArray.push({
            number: value,
            unit: key === 'legs' ? '足' : key === 'wings' ? '翼' : key,
            distribution: '知识库默认'
          });
        }
        vi.count = countArray;
      }
      
      // 找到匹配的肢体索引（使用标准化匹配）
      const existingIndex = this._findLimbIndex(vi.count, rawTarget);
      
      if (existingIndex >= 0) {
        const removed = vi.count[existingIndex];
        const originalValue = removed.number;
        
        // 从count数组中移除
        vi.count.splice(existingIndex, 1);
        
        // 记录移除
        if (!profile._removedByConstraint) profile._removedByConstraint = [];
        profile._removedByConstraint.push({
          unit: target,
          originalNumber: originalValue,
          removedBy: 'P0_HARD',
          removedAt: new Date().toISOString()
        });
        
        return {
          applied: true,
          field: `count.${target}`,
          originalValue,
          newValue: 0
        };
      } else {
        // 知识库中没有此肢体，但用户明确要求不要
        // 仍然记录移除（防止后续默认添加）
        if (!profile._removedByConstraint) profile._removedByConstraint = [];
        profile._removedByConstraint.push({
          unit: target,
          originalNumber: 0,
          removedBy: 'P0_HARD',
          note: '知识库中不存在，已标记为禁止'
        });
        
        return {
          applied: true,
          field: `count.${target}`,
          originalValue: 0,
          newValue: 0
        };
      }
    }
    
    // P0-颜色强制："必须是红色"
    const colorForceMatch = text.match(/(?:必须是?|改为?|改成?)\s*([红黄白黑青蓝紫橙绿金银]+)色?/);
    if (colorForceMatch) {
      const color = colorForceMatch[1];
      const originalColors = vi.color ? [...vi.color] : [];
      
      vi.color = [color]; // 强制替换为单一颜色
      vi._colorForced = true;
      vi._originalColors = originalColors;
      
      return {
        applied: true,
        field: 'color',
        originalValue: originalColors,
        newValue: [color]
      };
    }
    
    // P0-形态强制："必须是囊状"
    const shapeForceMatch = text.match(/(?:必须是?|形如|状如)\s*([^，。]{2,10})/);
    if (shapeForceMatch && !text.includes('足') && !text.includes('翼')) {
      const shape = shapeForceMatch[1];
      const originalShapes = vi.shape ? [...vi.shape] : [];
      
      vi.shape = [shape];
      vi._shapeForced = true;
      vi._originalShapes = originalShapes;
      
      return {
        applied: true,
        field: 'shape',
        originalValue: originalShapes,
        newValue: [shape]
      };
    }
    
    return { applied: false };
  }

  /**
   * 冲突检测
   */
  detectConflicts(originalProfile, modifiedProfile, p0Constraints, p1Constraints) {
    const conflicts = [];
    const originalVI = originalProfile.visualIdentity || {};
    const modifiedVI = modifiedProfile.visualIdentity || {};
    
    // 确保count是数组格式
    const originalCount = this._normalizeCount(originalVI.count);
    const modifiedCount = this._normalizeCount(modifiedVI.count);
    
    // 检测1：数量修改冲突
    if (originalCount.length > 0) {
      for (const orig of originalCount) {
        const normalizedOrigUnit = this._normalizeUnit(orig.unit);
        const mod = modifiedCount.find(c => this._normalizeUnit(c.unit) === normalizedOrigUnit);
        
        if (mod && mod.number !== orig.number) {
          // 检查是否是P0导致的修改
          const p0Caused = p0Constraints.some(p0 => 
            p0.numberChange?.target && this._normalizeUnit(p0.numberChange.target) === normalizedOrigUnit
          );
          
          conflicts.push({
            type: 'COUNT_OVERRIDE',
            priority: p0Caused ? 'P0' : 'P1',
            unit: orig.unit,
            original: orig.number,
            modified: mod.number,
            reason: p0Caused ? '用户硬约束(P0)' : '用户事实描述(P1)',
            severity: p0Caused ? 'info' : 'warning'
          });
        }
        if (!mod) {
          // 肢体被移除
          const p0Removed = p0Constraints.some(p0 => 
            p0.removal?.target && this._normalizeUnit(p0.removal.target) === normalizedOrigUnit
          );
          
          conflicts.push({
            type: 'LIMB_REMOVED',
            priority: p0Removed ? 'P0' : 'P1',
            unit: orig.unit,
            original: orig.number,
            modified: 0,
            reason: p0Removed ? '用户明确去除(P0)' : '未知原因',
            severity: p0Removed ? 'info' : 'warning'
          });
        }
      }
    }
    
    // 检测2：颜色强制冲突
    const originalColors = Array.isArray(originalVI.color) ? originalVI.color : (originalVI.color ? [originalVI.color] : []);
    if (originalColors.length > 0 && modifiedVI._colorForced) {
      const originalColorStr = originalColors.join('、');
      const newColors = Array.isArray(modifiedVI.color) ? modifiedVI.color : (modifiedVI.color ? [modifiedVI.color] : []);
      const newColorStr = newColors.join('、');
      
      if (originalColorStr !== newColorStr) {
        conflicts.push({
          type: 'COLOR_OVERRIDE',
          priority: 'P0',
          field: 'color',
          original: originalColorStr,
          modified: newColorStr,
          reason: '用户颜色强制(P0)',
          severity: 'info'
        });
      }
    }
    
    // 检测3：新增肢体（知识库中没有但用户要求添加）
    if (modifiedCount.length > 0) {
      for (const mod of modifiedCount) {
        if (mod.isNew) {
          conflicts.push({
            type: 'LIMB_ADDED',
            priority: 'P0',
            unit: mod.unit,
            original: 0,
            modified: mod.number,
            reason: '用户强制添加(P0)',
            severity: 'info',
            note: '知识库中原本不存在此肢体'
          });
        }
      }
    }
    
    return conflicts;
  }

  /**
   * 辅助：将count字段统一为数组格式
   */
  _normalizeCount(countField) {
    if (!countField) return [];
    if (Array.isArray(countField)) return countField;
    if (typeof countField === 'object') {
      // 对象格式 { legs: 6, wings: 4 }
      const result = [];
      for (const [key, value] of Object.entries(countField)) {
        result.push({
          number: value,
          unit: key === 'legs' ? '足' : key === 'wings' ? '翼' : key,
          distribution: '知识库默认'
        });
      }
      return result;
    }
    return [];
  }

  /**
   * 解析中文/阿拉伯数字
   */
  _parseNumber(str) {
    const chineseMap = { '一':1, '二':2, '两':2, '三':3, '四':4, '五':5, '六':6, '七':7, '八':8, '九':9, '十':10 };
    
    if (/^\d+$/.test(str)) {
      return parseInt(str);
    }
    
    let result = 0;
    let temp = 0;
    for (let char of str) {
      if (chineseMap[char] === 10) {
        result += (temp || 1) * 10;
        temp = 0;
      } else {
        temp = chineseMap[char] || 0;
      }
    }
    return result + temp;
  }

  /**
   * 生成仲裁报告
   */
  generateReport(arbitrationResult) {
    const { profile, conflicts, auditLog, appliedConstraints } = arbitrationResult;
    
    const lines = [];
    lines.push('=== 约束仲裁报告 ===');
    lines.push(`原始角色: ${profile._arbitration?.originalProfileId || 'unknown'}`);
    lines.push(`仲裁时间: ${profile._arbitration?.timestamp || new Date().toISOString()}`);
    lines.push('');
    
    lines.push(`【P0硬约束】已应用 ${appliedConstraints.P0.length} 条:`);
    for (const p0 of appliedConstraints.P0) {
      lines.push(`  - ${p0.field}: ${p0.originalValue} → ${p0.newValue}`);
      lines.push(`    依据: "${p0.constraint}"`);
    }
    
    if (appliedConstraints.P0.length === 0) {
      lines.push('  (无P0约束)');
    }
    
    lines.push('');
    lines.push(`【P1事实描述】已应用 ${appliedConstraints.P1.length} 条:`);
    for (const p1 of appliedConstraints.P1) {
      lines.push(`  - ${p1.field}: ${JSON.stringify(p1.value)}`);
      lines.push(`    依据: "${p1.constraint}"`);
    }
    
    if (appliedConstraints.P1.length === 0) {
      lines.push('  (无P1约束)');
    }
    
    lines.push('');
    lines.push(`【冲突检测】发现 ${conflicts.length} 个冲突:`);
    for (const conflict of conflicts) {
      const icon = conflict.priority === 'P0' ? '✅' : '⚠️';
      lines.push(`  ${icon} [${conflict.type}] ${conflict.unit || conflict.field}`);
      lines.push(`     ${conflict.original} → ${conflict.modified} (${conflict.reason})`);
      if (conflict.note) {
        lines.push(`     备注: ${conflict.note}`);
      }
    }
    
    if (conflicts.length === 0) {
      lines.push('  (无冲突)');
    }
    
    lines.push('');
    lines.push('【审计日志】');
    for (const log of auditLog) {
      lines.push(`  ${log}`);
    }
    
    return lines.join('\n');
  }

  /**
   * 默认单位映射表
   */
  getDefaultUnitMapping() {
    return {
      // 足的别名
      '脚': '足',
      '腿': '足',
      '足部': '足',
      // 翼的别名
      '翅膀': '翼',
      '翅': '翼',
      '羽翼': '翼',
      '翼翅': '翼',
      // 头的别名
      '头部': '头',
      // 手的别名
      '手部': '手',
      // 尾巴的别名
      '尾': '尾',
      '尾部': '尾',
      '尾巴': '尾'
    };
  }
}

module.exports = ConstraintArbitrationEngine;
