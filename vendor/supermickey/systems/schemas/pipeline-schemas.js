/**
 * Pipeline Schemas — 全链路数据契约验证
 * v1.0: Zod-style Schema 定义（纯JS实现，零外部依赖）
 * 
 * 核心原则：
 * 1. 每个阶段的数据输入/输出都必须通过Schema验证
 * 2. 先以警告模式运行（不阻断链路），收集2轮数据后切换严格模式
 * 3. 字段名变化必须通过Schema版本控制
 * 
 * 验证覆盖点：
 * - Stage 1→2: PRD Schema
 * - Stage 4→5: Character Profile Schema
 * - Stage 5→6: Shot Schema（核心）
 * - Stage 7→8: Storyboard Schema
 * - Stage 11: Render Prompt Input Schema
 */

'use strict';

// ============================================================
// 一、轻量Schema验证引擎（纯JS，零依赖）
// ============================================================

class SchemaValidator {
  constructor(name, schema) {
    this.name = name;
    this.schema = schema;
  }

  validate(data, options = {}) {
    const errors = [];
    const warnings = [];
    const strict = options.strict !== false;
    
    const result = this._validateObject(data, this.schema, '', errors, warnings, strict);
    
    return {
      valid: errors.length === 0,
      errors,
      warnings,
      data: result,
      schema: this.name
    };
  }

  _validateObject(obj, schema, path, errors, warnings, strict) {
    if (obj === null || obj === undefined) {
      if (schema.required) {
        errors.push(`${path || 'root'}: 必填字段缺失`);
      }
      return null;
    }

    if (typeof obj !== 'object') {
      errors.push(`${path || 'root'}: 期望对象类型，得到 ${typeof obj}`);
      return obj;
    }

    const result = Array.isArray(obj) ? [...obj] : { ...obj };

    // 验证字段
    for (const [key, fieldDef] of Object.entries(schema.fields || {})) {
      const fieldPath = path ? `${path}.${key}` : key;
      const value = obj[key];

      // 必填检查
      if (fieldDef.required && (value === undefined || value === null)) {
        errors.push(`${fieldPath}: 必填字段缺失`);
        continue;
      }

      if (value === undefined || value === null) {
        // 可选字段且有默认值
        if (fieldDef.default !== undefined) {
          result[key] = fieldDef.default;
        }
        continue;
      }

      // 类型检查
      const typeError = this._checkType(value, fieldDef.type, fieldPath);
      if (typeError) {
        errors.push(typeError);
        continue;
      }

      // 字符串约束
      if (fieldDef.type === 'string' && typeof value === 'string') {
        if (fieldDef.minLength && value.length < fieldDef.minLength) {
          errors.push(`${fieldPath}: 长度 ${value.length} < 最小 ${fieldDef.minLength}`);
        }
        if (fieldDef.maxLength && value.length > fieldDef.maxLength) {
          warnings.push(`${fieldPath}: 长度 ${value.length} > 建议最大 ${fieldDef.maxLength}（未阻断）`);
        }
        if (fieldDef.pattern && !fieldDef.pattern.test(value)) {
          errors.push(`${fieldPath}: 格式不匹配 ${fieldDef.pattern}`);
        }
        if (fieldDef.enum && !fieldDef.enum.includes(value)) {
          errors.push(`${fieldPath}: 值 "${value}" 不在允许列表 [${fieldDef.enum.join(', ')}]`);
        }
      }

      // 数字约束
      if (fieldDef.type === 'number' && typeof value === 'number') {
        if (fieldDef.min !== undefined && value < fieldDef.min) {
          errors.push(`${fieldPath}: ${value} < 最小 ${fieldDef.min}`);
        }
        if (fieldDef.max !== undefined && value > fieldDef.max) {
          errors.push(`${fieldPath}: ${value} > 最大 ${fieldDef.max}`);
        }
      }

      // 数组约束
      if (fieldDef.type === 'array' && Array.isArray(value)) {
        if (fieldDef.minItems && value.length < fieldDef.minItems) {
          errors.push(`${fieldPath}: 元素数 ${value.length} < 最小 ${fieldDef.minItems}`);
        }
        if (fieldDef.maxItems && value.length > fieldDef.maxItems) {
          warnings.push(`${fieldPath}: 元素数 ${value.length} > 建议最大 ${fieldDef.maxItems}`);
        }
        if (fieldDef.itemType) {
          for (let i = 0; i < value.length; i++) {
            const itemError = this._checkType(value[i], fieldDef.itemType, `${fieldPath}[${i}]`);
            if (itemError) {
              errors.push(itemError);
            }
          }
        }
      }

      // 嵌套对象
      if (fieldDef.type === 'object' && fieldDef.fields && typeof value === 'object') {
        result[key] = this._validateObject(value, fieldDef, fieldPath, errors, warnings, strict);
      }
    }

    // 检查未知字段（仅在严格模式下报错）
    if (strict) {
      const allowedFields = new Set(Object.keys(schema.fields || {}));
      for (const key of Object.keys(obj)) {
        if (!allowedFields.has(key)) {
          warnings.push(`${path ? `${path}.${key}` : key}: 未知字段（可能已废弃或拼写错误）`);
        }
      }
    }

    return result;
  }

  _checkType(value, expectedType, path) {
    if (!expectedType) return null;

    const actualType = Array.isArray(value) ? 'array' : (value === null ? 'null' : typeof value);

    if (expectedType === 'any') return null;
    if (expectedType === 'string' && actualType === 'string') return null;
    if (expectedType === 'number' && actualType === 'number') return null;
    if (expectedType === 'boolean' && actualType === 'boolean') return null;
    if (expectedType === 'array' && actualType === 'array') return null;
    if (expectedType === 'object' && actualType === 'object') return null;
    if (expectedType === 'function' && actualType === 'function') return null;

    // 联合类型
    if (expectedType.includes('|')) {
      const types = expectedType.split('|').map(t => t.trim());
      for (const t of types) {
        if (t === 'null' && value === null) return null;
        if (t === actualType) return null;
      }
    }

    return `${path}: 类型错误，期望 ${expectedType}，得到 ${actualType}`;
  }
}

// ============================================================
// 二、Schema 定义
// ============================================================

// 2.1 角色定义（Stage 4输出）
const CharacterProfileSchema = new SchemaValidator('CharacterProfile', {
  fields: {
    id: { type: 'string', required: true, pattern: /^[a-zA-Z0-9_-]+$/ },
    name: { type: 'string', required: true, minLength: 1, maxLength: 50 },
    role: { type: 'string', required: true, enum: ['protagonist', 'antagonist', 'supporting', 'beast', 'cameo'] },
    appearance: { type: 'string', maxLength: 1000 },
    age: { type: 'number|null', min: 0, max: 999 },
    gender: { type: 'string', enum: ['male', 'female', 'neutral', 'unknown'] },
    species: { type: 'string', maxLength: 50 },
    height: { type: 'number|null', min: 0.1, max: 1000 },
    // 视觉锚定
    visualSignature: { type: 'string', maxLength: 500 },
    costumePhotoPath: { type: 'string|null' },
    costumeVerified: { type: 'boolean', default: false },
    // 一致性追踪
    consistencyHash: { type: 'string|null' }
  }
});

// 2.2 镜头定义（Stage 5-7核心输出）
const ShotSchema = new SchemaValidator('Shot', {
  fields: {
    // 标识
    id: { type: 'string', required: true, pattern: /^[a-zA-Z0-9_-]+$/ },
    shotId: { type: 'string', pattern: /^[a-zA-Z0-9_-]+$/ }, // 别名兼容
    sequence: { type: 'number', required: true, min: 1 },
    
    // 场景
    scene: { type: 'string', required: true, minLength: 1, maxLength: 200 },
    sceneName: { type: 'string', maxLength: 200 }, // 别名兼容
    
    // 节拍
    beatName: { type: 'string', maxLength: 200 },
    type: { type: 'string', enum: ['opening', 'establishing', 'building', 'reveal', 'climax', 'resolution', 'transition', 'close-up', 'action', 'reaction'] },
    
    // 口播/叙事（核心字段）
    narration: { type: 'string', required: true, minLength: 1, maxLength: 2000 },
    narrationDuration: { type: 'number', min: 0.5, max: 60 },
    
    // 角色
    characters: { type: 'array', required: true, minItems: 0, itemType: 'object' },
    characterRoles: { type: 'array', itemType: 'string' }, // 别名兼容
    
    // 情绪
    emotionPhase: { type: 'string', required: true, enum: ['exposition', 'rising_action', 'complication', 'climax', 'falling_action', 'resolution'] },
    emotionalIntensity: { type: 'number', min: 0, max: 1 },
    
    // 视觉（Stage 7生成）
    visualPrompt: { type: 'string', maxLength: 1200 },
    visualPromptValidated: { type: 'boolean', default: false },
    prompt: { type: 'string', maxLength: 1200 }, // 别名兼容
    
    // 运镜（Stage 9生成）
    cameraMovement: { type: 'object', fields: {
      type: { type: 'string', enum: ['static', 'pan', 'tilt', 'dolly', 'truck', 'crane', 'handheld', 'steadicam', 'drone', 'orbit'] },
      direction: { type: 'string', maxLength: 100 },
      speed: { type: 'string', enum: ['slow', 'medium', 'fast', 'variable'] },
      description: { type: 'string', maxLength: 300 }
    }},
    
    // 时长（Stage 6生成）
    duration: { type: 'number', min: 1, max: 15 },
    shotDuration: { type: 'number', min: 1, max: 15 }, // 别名兼容
    targetDuration: { type: 'number', min: 1, max: 15 }, // 别名兼容
    
    // 渲染输出（Stage 11生成）
    renderOutput: { type: 'object', fields: {
      videoPath: { type: 'string|null' },
      frameCount: { type: 'number|null' },
      renderTimeMs: { type: 'number|null' },
      qualityScore: { type: 'number|null', min: 0, max: 1 }
    }},
    
    // 导演评分（Stage 16）
    directorScore: { type: 'number', min: 1, max: 10 },
    directorNotes: { type: 'string', maxLength: 1000 },
    
    // 质量评分
    qualityScore: { type: 'object', fields: {
      totalScore: { type: 'number', min: 0, max: 10 },
      narrativeScore: { type: 'number', min: 0, max: 10 },
      visualScore: { type: 'number', min: 0, max: 10 },
      technicalScore: { type: 'number', min: 0, max: 10 }
    }},
    score: { type: 'number', min: 0, max: 10 }, // 别名兼容
    
    // 元数据
    metadata: { type: 'object', fields: {
      createdAt: { type: 'number' },
      modifiedAt: { type: 'number' },
      stageVersion: { type: 'string' }
    }}
  }
});

// 2.3 故事板定义（Stage 7输出）
const StoryboardSchema = new SchemaValidator('Storyboard', {
  fields: {
    title: { type: 'string', required: true, minLength: 1, maxLength: 200 },
    totalShots: { type: 'number', required: true, min: 1 },
    acts: { type: 'array', itemType: 'object' },
    shots: { type: 'array', required: true, minItems: 1, itemType: 'object' },
    totalDuration: { type: 'number', min: 0 }
  }
});

// 2.4 渲染Prompt输入定义（Stage 11输入）
const RenderPromptInputSchema = new SchemaValidator('RenderPromptInput', {
  fields: {
    shotId: { type: 'string', required: true },
    prompt: { type: 'string', required: true, minLength: 10, maxLength: 1200 },
    negativePrompt: { type: 'string', maxLength: 500 },
    duration: { type: 'number', required: true, min: 1, max: 15 },
    style: { type: 'object', fields: {
      directorStyle: { type: 'array', itemType: 'string' },
      colorPalette: { type: 'array', itemType: 'string' },
      lightingPreset: { type: 'string' }
    }},
    continuity: { type: 'object', fields: {
      previousShotId: { type: 'string|null' },
      nextShotId: { type: 'string|null' },
      requiredVisualElements: { type: 'array', itemType: 'string' }
    }},
    referenceImages: { type: 'array', itemType: 'string' },
    referenceVideos: { type: 'array', itemType: 'string' }
  }
});

// 2.5 PRD定义（Stage 1输出）
const PRDSchema = new SchemaValidator('PRD', {
  fields: {
    version: { type: 'string', required: true },
    title: { type: 'string', required: true, minLength: 1, maxLength: 200 },
    logline: { type: 'string', maxLength: 500 },
    genre: { type: 'array', itemType: 'string' },
    tone: { type: 'array', itemType: 'string' },
    themes: { type: 'array', itemType: 'string' },
    targetAudience: { type: 'string' },
    duration: { type: 'object', required: true, fields: {
      totalMinutes: { type: 'number', min: 0.5, max: 120 },
      actBreakdown: { type: 'array', itemType: 'object' }
    }},
    characters: { type: 'object', required: true },
    emotionArc: { type: 'array', itemType: 'object' },
    visualStyle: { type: 'object', fields: {
      cinematography: { type: 'string' },
      colorPalette: { type: 'array', itemType: 'string' },
      lightingStyle: { type: 'string' }
    }}
  }
});

// 2.6 神兽定义（Beast Domain）
const BeastSchema = new SchemaValidator('Beast', {
  fields: {
    id: { type: 'string', required: true, pattern: /^[a-z0-9_]+$/ },
    canonicalName: { type: 'object', required: true, fields: {
      pinyin: { type: 'string', required: true },
      chinese: { type: 'string' },
      english: { type: 'string', required: true }
    }},
    aliases: { type: 'array', itemType: 'string' },
    category: { type: 'string', required: true, enum: ['divine_beast', 'ferocious_beast', 'auspicious_beast', 'spirit_beast', 'demon_beast', 'hybrid_beast'] },
    source: { type: 'string' },
    shanhaijingOriginal: { type: 'string' },
    nirathCore: { type: 'string' },
    description: { type: 'string', maxLength: 2000 },
    appearance: { type: 'object', fields: {
      body: { type: 'string' },
      head: { type: 'string' },
      face: { type: 'string' },
      legs: { type: 'string' },
      wings: { type: 'string' },
      tail: { type: 'string' },
      eyes: { type: 'string' },
      mane: { type: 'string' },
      special: { type: 'string' },
      colors: { type: 'string' }
    }},
    visualSignature: { type: 'object', fields: {
      description: { type: 'string', maxLength: 2000 },
      keyFeatures: { type: 'array', itemType: 'string' },
      colorPalette: { type: 'array', itemType: 'string' },
      negativePrompt: { type: 'string' }
    }},
    promptTemplate: { type: 'string', maxLength: 2000 },
    negativePrompt: { type: 'string', maxLength: 500 },
    lore: { type: 'object', fields: {
      summary: { type: 'string', maxLength: 1000 },
      abilities: { type: 'array', itemType: 'string' },
      temperament: { type: 'string', enum: ['benevolent', 'neutral', 'aggressive', 'unpredictable', 'ancient'] }
    }},
    habitat: { type: 'object', fields: {
      primary: { type: 'string' },
      secondary: { type: 'array', itemType: 'string' }
    }},
    version: { type: 'string', default: '1.0.0' },
    approved: { type: 'boolean', default: false }
  }
});

// ============================================================
// 三、Pipeline Schema 验证器（阶段边界守卫）
// ============================================================

class PipelineSchemaValidator {
  constructor() {
    this.validationLog = [];
    this.mode = 'warn'; // 'warn' | 'strict' — 渐进切换
  }

  setMode(mode) {
    this.mode = mode;
    console.log(`[PipelineSchemaValidator] 模式切换: ${mode}`);
  }

  /**
   * 验证阶段输入（在阶段入口调用）
   * @param {string} stageId - 阶段ID
   * @param {Object} data - 输入数据
   * @param {string} expectedSchema - 期望的Schema名称
   */
  validateStageInput(stageId, data, expectedSchema) {
    const schema = this.getSchema(expectedSchema);
    if (!schema) {
      console.warn(`[PipelineSchemaValidator] 未知Schema: ${expectedSchema}`);
      return { valid: true, skipped: true };
    }

    const result = schema.validate(data, { strict: this.mode === 'strict' });
    
    this.logValidation(stageId, 'input', result);

    if (!result.valid && this.mode === 'strict') {
      const errorMsg = `Stage ${stageId} 输入验证失败: ${result.errors.join('; ')}`;
      console.error(`[PipelineSchemaValidator] ${errorMsg}`);
      throw new Error(errorMsg);
    }

    if (!result.valid && this.mode === 'warn') {
      console.warn(`[PipelineSchemaValidator] Stage ${stageId} 输入验证警告: ${result.errors.join('; ')}`);
    }

    if (result.warnings.length > 0) {
      console.warn(`[PipelineSchemaValidator] Stage ${stageId} 输入警告: ${result.warnings.join('; ')}`);
    }

    return result;
  }

  /**
   * 验证Shot数组（核心验证）
   */
  validateShots(shots, options = {}) {
    if (!Array.isArray(shots)) {
      return { valid: false, errors: ['shots不是数组'] };
    }

    const errors = [];
    const warnings = [];
    const validatedShots = [];

    // 检查序列连续性
    const sequences = shots.map((s, i) => s.sequence || i + 1).sort((a, b) => a - b);
    for (let i = 0; i < sequences.length; i++) {
      if (sequences[i] !== i + 1) {
        errors.push(`序列不连续: 期望 ${i + 1}, 实际 ${sequences[i]}`);
      }
    }

    // 检查ID唯一性
    const ids = shots.map(s => s.id || s.shotId);
    const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (duplicates.length > 0) {
      errors.push(`重复Shot ID: ${[...new Set(duplicates)].join(', ')}`);
    }

    // 逐个验证
    for (let i = 0; i < shots.length; i++) {
      const shot = shots[i];
      const result = ShotSchema.validate(shot, { strict: this.mode === 'strict' });
      
      if (!result.valid) {
        errors.push(`Shot[${i}](${shot.id || '?'}): ${result.errors.join(', ')}`);
      }
      if (result.warnings.length > 0) {
        warnings.push(`Shot[${i}](${shot.id || '?'}): ${result.warnings.join(', ')}`);
      }

      validatedShots.push(result.data || shot);
    }

    // 检查口播完整性
    const emptyNarration = shots.filter(s => !s.narration || s.narration.trim().length === 0);
    if (emptyNarration.length > 0) {
      errors.push(`${emptyNarration.length} 个镜头缺少口播`);
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      shots: validatedShots
    };
  }

  /**
   * 验证渲染Prompt输入
   */
  validateRenderPrompt(data) {
    return RenderPromptInputSchema.validate(data, { strict: this.mode === 'strict' });
  }

  /**
   * 验证神兽数据
   */
  validateBeast(data) {
    return BeastSchema.validate(data, { strict: this.mode === 'strict' });
  }

  /**
   * 验证PRD
   */
  validatePRD(data) {
    return PRDSchema.validate(data, { strict: this.mode === 'strict' });
  }

  getSchema(name) {
    const schemas = {
      'CharacterProfile': CharacterProfileSchema,
      'Shot': ShotSchema,
      'Storyboard': StoryboardSchema,
      'RenderPromptInput': RenderPromptInputSchema,
      'PRD': PRDSchema,
      'Beast': BeastSchema
    };
    return schemas[name];
  }

  logValidation(stageId, direction, result) {
    this.validationLog.push({
      timestamp: Date.now(),
      stageId,
      direction,
      valid: result.valid,
      errorCount: result.errors?.length || 0,
      warningCount: result.warnings?.length || 0
    });
  }

  getValidationStats() {
    const total = this.validationLog.length;
    const failures = this.validationLog.filter(v => !v.valid).length;
    return {
      totalValidations: total,
      failures,
      failureRate: total > 0 ? (failures / total).toFixed(2) : 0,
      recentErrors: this.validationLog.filter(v => !v.valid).slice(-10)
    };
  }
}

// ============================================================
// 四、导出
// ============================================================

module.exports = {
  SchemaValidator,
  PipelineSchemaValidator,
  CharacterProfileSchema,
  ShotSchema,
  StoryboardSchema,
  RenderPromptInputSchema,
  PRDSchema,
  BeastSchema
};