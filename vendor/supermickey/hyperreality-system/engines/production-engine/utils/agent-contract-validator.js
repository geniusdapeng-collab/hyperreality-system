/**
 * Agent 间数据契约校验器 v1.0
 * 【P0-ARCH-05 修复】显式校验 Agent 间传递的数据结构，防止字段缺失/类型错误导致下游崩溃
 * 
 * 职责：
 * - 定义各阶段输出数据的标准 Schema
 * - 校验 Agent 输出是否符合契约
 * - 提供自动修复能力（将无效数据修复为安全默认值）
 * - 记录校验失败日志，便于调试
 */

'use strict';

// Phase 1 → Phase 2 契约：剧本输出
const PHASE1_TO_PHASE2_CONTRACT = {
  shots: {
    type: 'array',
    required: true,
    minLength: 1,
    itemSchema: {
      shotId: { type: 'string', required: true, pattern: /^S-\d+$/ },
      scene: { type: 'string', required: true, minLength: 10 },
      action: { type: 'string', required: true, minLength: 5 },
      duration: { type: 'number', required: true, min: 1, max: 60 },
      characters: { type: 'array', required: false, itemType: 'string' },
      dialogue: { type: 'object', required: false },
      mood: { type: 'string', required: false },
      sceneType: { type: 'string', required: false },
      _meta: { type: 'object', required: false }
    }
  },
  blueprint: {
    type: 'object',
    required: true,
    fields: {
      meta: { type: 'object', required: true },
      character_system: { type: 'object', required: true },
      config: { type: 'object', required: false }
    }
  }
};

// Phase 2 → Phase 3 契约：视觉/音频输出
const PHASE2_TO_PHASE3_CONTRACT = {
  shots: {
    type: 'array',
    required: true,
    minLength: 1,
    itemSchema: {
      shotId: { type: 'string', required: true },
      // VisualLanguage 输出
      cameraString: { type: 'string', required: false, minLength: 10 },
      cameraMovement: { type: 'string', required: false },
      lighting: { type: 'string', required: false, minLength: 10 },
      lightingString: { type: 'string', required: false },
      timeline: { type: 'string', required: false },
      // AudioDesign 输出
      audio: { type: 'string', required: false },
      backgroundSound: { type: 'string', required: false },
      backgroundSoundString: { type: 'string', required: false },
      // 原始字段保留
      scene: { type: 'string', required: true },
      action: { type: 'string', required: true }
    }
  }
};

// Phase 3 → 输出 契约：PromptFusion 输出
const PHASE3_TO_OUTPUT_CONTRACT = {
  shots: {
    type: 'array',
    required: true,
    itemSchema: {
      shotId: { type: 'string', required: true },
      prompt: { type: 'string', required: true, minLength: 50 },
      promptCharCount: { type: 'number', required: true, min: 0 },
      degraded: { type: 'boolean', required: true },
      degradeReason: { type: 'string', required: false },
      fields: { type: 'object', required: true },
      // 关键字段必须存在
      director_instruction: { type: 'string', required: false },
      scene: { type: 'string', required: false },
      lighting: { type: 'string', required: false }
    }
  }
};

class AgentContractValidator {
  constructor(options = {}) {
    this.strict = options.strict !== false; // 默认严格模式
    this.autoFix = options.autoFix !== false; // 默认自动修复
    this.logLevel = options.logLevel || 'warn'; // debug | info | warn | error
    this.errors = [];
    this.warnings = [];
  }

  /**
   * 校验数据是否符合契约
   * @param {string} contractName - 契约名称 (phase1-phase2 | phase2-phase3 | phase3-output)
   * @param {object} data - 要校验的数据
   * @returns {object} { valid: boolean, errors: [], warnings: [], fixed: object|null }
   */
  validate(contractName, data) {
    this.errors = [];
    this.warnings = [];
    
    const contract = this._getContract(contractName);
    if (!contract) {
      return { valid: false, errors: [`未知契约: ${contractName}`], warnings: [], fixed: null };
    }

    const result = this._validateObject(data, contract, '');
    
    let fixed = null;
    let fixCount = 0;
    if (!result.valid && this.autoFix) {
      const autoFixResult = this._autoFix(data, contract, contractName);
      fixed = autoFixResult.data;
      fixCount = autoFixResult.fixCount;
    }

    return {
      valid: result.valid && this.errors.length === 0,
      errors: this.errors,
      warnings: this.warnings,
      fixed: fixed,
      fixCount: fixCount
    };
  }

  _getContract(name) {
    const contracts = {
      'phase1-phase2': PHASE1_TO_PHASE2_CONTRACT,
      'phase2-phase3': PHASE2_TO_PHASE3_CONTRACT,
      'phase3-output': PHASE3_TO_OUTPUT_CONTRACT
    };
    return contracts[name];
  }

  _validateObject(data, schema, path) {
    if (!data || typeof data !== 'object') {
      this.errors.push(`${path}: 期望对象，实际为 ${typeof data}`);
      return { valid: false };
    }

    let valid = true;
    for (const [key, rule] of Object.entries(schema)) {
      const value = data[key];
      const fieldPath = path ? `${path}.${key}` : key;

      if (rule.required && (value === undefined || value === null)) {
        this.errors.push(`${fieldPath}: 必填字段缺失`);
        valid = false;
        continue;
      }

      if (value === undefined || value === null) continue;

      const typeValid = this._checkType(value, rule.type, fieldPath);
      if (!typeValid) valid = false;

      if (rule.type === 'string' && typeof value === 'string') {
        if (rule.minLength && value.length < rule.minLength) {
          this.warnings.push(`${fieldPath}: 长度(${value.length}) < 最小要求(${rule.minLength})`);
        }
        if (rule.pattern && !rule.pattern.test(value)) {
          this.warnings.push(`${fieldPath}: 不匹配模式 ${rule.pattern}`);
        }
      }

      if (rule.type === 'number' && typeof value === 'number') {
        if (rule.min !== undefined && value < rule.min) {
          this.warnings.push(`${fieldPath}: 值(${value}) < 最小值(${rule.min})`);
        }
        if (rule.max !== undefined && value > rule.max) {
          this.warnings.push(`${fieldPath}: 值(${value}) > 最大值(${rule.max})`);
        }
      }

      if (rule.type === 'array' && Array.isArray(value)) {
        if (rule.minLength && value.length < rule.minLength) {
          this.errors.push(`${fieldPath}: 数组长度(${value.length}) < 最小要求(${rule.minLength})`);
          valid = false;
        }
        if (rule.itemSchema) {
          value.forEach((item, idx) => {
            const itemResult = this._validateObject(item, rule.itemSchema, `${fieldPath}[${idx}]`);
            if (!itemResult.valid) valid = false;
          });
        }
      }

      if (rule.fields && typeof value === 'object') {
        const nestedResult = this._validateObject(value, rule.fields, fieldPath);
        if (!nestedResult.valid) valid = false;
      }
    }

    return { valid };
  }

  _checkType(value, expectedType, path) {
    const actualType = Array.isArray(value) ? 'array' : typeof value;
    if (actualType !== expectedType) {
      this.errors.push(`${path}: 类型不匹配，期望 ${expectedType}，实际 ${actualType}`);
      return false;
    }
    return true;
  }

  _autoFix(data, schema, contractName) {
    // 【P2-Bug-11 修复】使用safe-clone替代JSON.parse(JSON.stringify())
    const { deepClone } = require('../../../utils/safe-clone');
    const fixed = deepClone(data);
    let fixCount = 0;

    for (const [key, rule] of Object.entries(schema)) {
      const value = fixed[key];

      // 修复缺失字段
      if (rule.required && (value === undefined || value === null)) {
        fixed[key] = this._generateDefault(rule, key, contractName);
        this.warnings.push(`${key}: 自动填充默认值`);
        fixCount++;
        continue;
      }

      if (value === undefined || value === null) continue;

      // 修复类型错误
      if (rule.type === 'string' && typeof value !== 'string') {
        fixed[key] = String(value);
        fixCount++;
      }
      if (rule.type === 'number' && typeof value !== 'number') {
        const parsed = parseFloat(value);
        fixed[key] = isNaN(parsed) ? this._generateDefault(rule, key, contractName) : parsed;
        fixCount++;
      }
      if (rule.type === 'array' && !Array.isArray(value)) {
        fixed[key] = [value];
        fixCount++;
      }

      // 修复字符串长度不足
      if (rule.type === 'string' && typeof fixed[key] === 'string' && rule.minLength) {
        if (fixed[key].length < rule.minLength) {
          fixed[key] = this._extendString(fixed[key], rule.minLength, key);
          fixCount++;
        }
      }

      // 递归修复嵌套对象
      if (rule.fields && typeof fixed[key] === 'object') {
        const nestedFixed = this._autoFix(fixed[key], rule.fields, contractName);
        fixed[key] = nestedFixed;
      }
    }

    console.log(`[AgentContractValidator] ${contractName} 自动修复: ${fixCount} 处`);
    return { data: fixed, fixCount };
  }

  _generateDefault(rule, key, contractName) {
    const defaults = {
      'phase1-phase2': {
        shots: [],
        shotId: 'S-01',
        scene: '场景描述待补充',
        action: '动作待补充',
        duration: 5,
        characters: [],
        mood: '中性',
        dialogue: { lines: [] }
      },
      'phase2-phase3': {
        cameraString: '固定机位，中景构图，主体清晰',
        lightingString: '自然光，5600K，三点布光',
        backgroundSoundString: '环境底噪，人声清晰',
        timeline: 'T00:00 - 开场;T00:05 - 结束'
      },
      'phase3-output': {
        prompt: '电影级写实风格，专业摄影布光，细腻质感，自然光效。场景：室内环境，真实材质。',
        promptCharCount: 50,
        degraded: true,
        degradeReason: '数据契约自动修复',
        fields: {}
      }
    };

    if (rule.type === 'string') return defaults[contractName]?.[key] || `${key}待补充`;
    if (rule.type === 'number') return rule.min || 0;
    if (rule.type === 'array') return [];
    if (rule.type === 'object') return {};
    if (rule.type === 'boolean') return false;
    return null;
  }

  _extendString(str, minLength, key) {
    const extensions = {
      scene: '，真实材质质感，电影级调色，专业构图',
      action: '，动作流畅自然，情绪真实',
      cameraString: '，画面稳定，焦点清晰',
      lighting: '，光线柔和均匀，阴影层次分明'
    };
    const suffix = extensions[key] || '，专业电影级制作';
    while (str.length < minLength) {
      str += suffix;
    }
    return str.slice(0, minLength * 2); // 不要无限增长
  }

  getStats() {
    return {
      errors: this.errors.length,
      warnings: this.warnings.length,
      errorList: this.errors,
      warningList: this.warnings
    };
  }
}

// 便捷函数：快速校验
function validateAgentContract(contractName, data, options = {}) {
  const validator = new AgentContractValidator(options);
  return validator.validate(contractName, data);
}

module.exports = {
  AgentContractValidator,
  validateAgentContract,
  PHASE1_TO_PHASE2_CONTRACT,
  PHASE2_TO_PHASE3_CONTRACT,
  PHASE3_TO_OUTPUT_CONTRACT
};
