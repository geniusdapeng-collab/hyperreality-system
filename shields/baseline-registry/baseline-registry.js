/**
 * BaselineRegistry - 基线模板注册表（通用化版本）
 * 
 * 核心职责：
 * 1. 管理已审核通过的基线模板（按类型/版本）
 * 2. 提供热启动加载（基线 + LLM增量合并）
 * 3. 版本管理（v1.0 → v1.1 → v2.0）
 * 
 * 设计原则：
 * - 系统不预置任何默认模板或领域知识
 * - 所有基线必须由外部注册（人工审核通过后）
 * - 匹配基于通用相似度算法，不依赖具体关键词
 */

const fs = require('fs');
const path = require('path');

class BaselineRegistry {
  constructor(options = {}) {
    this.registryDir = options.registryDir || './shields/baseline-registry/templates';
    this.ensureDirectory();
    
    // 内存缓存
    this.cache = new Map();
    
    // 通用匹配权重（不依赖具体领域）
    this.matchWeights = options.matchWeights || {
      title: 0.3,        // 标题匹配权重
      style: 0.25,      // 风格匹配权重
      characters: 0.2,  // 角色匹配权重
      intent: 0.15,     // 意图匹配权重
      format: 0.1       // 格式匹配权重
    };
  }

  ensureDirectory() {
    if (!fs.existsSync(this.registryDir)) {
      fs.mkdirSync(this.registryDir, { recursive: true });
    }
  }

  /**
   * 注册新基线模板（外部审核通过后调用）
   * @param {string} type - 类型标识（由外部定义，系统不预设）
   * @param {string} version - 版本号
   * @param {Object} baseline - 基线数据（lockedFields + deltaFields）
   * @param {Object} metadata - 元数据（来源、描述等，由外部提供）
   */
  register(type, version, baseline, metadata = {}) {
    const templateId = `${type}_${version}`;
    const templatePath = path.join(this.registryDir, `${templateId}.json`);

    const template = {
      id: templateId,
      type,  // 使用 type 替代 category，更通用
      version,
      // 锁定的稳定字段（LLM不可覆盖）
      lockedFields: baseline.lockedFields || {},
      // 允许LLM覆盖的创意字段
      deltaFields: baseline.deltaFields || {},
      // 匹配特征（用于相似度匹配）
      matchFeatures: baseline.matchFeatures || {},
      // 元数据（由外部提供，系统不预设）
      metadata: {
        registeredAt: new Date().toISOString(),
        usageCount: 0,
        lastUsed: null,
        ...metadata  // 外部传入的元数据覆盖默认值
      }
    };

    // 写入文件
    fs.writeFileSync(templatePath, JSON.stringify(template, null, 2));
    
    // 更新内存缓存
    this.cache.set(templateId, template);

    console.log(`[BaselineRegistry] ✅ 基线模板已注册: ${templateId}`);
    return template;
  }

  /**
   * 加载基线模板
   * @param {string} type - 类型标识
   * @param {string} version - 版本号（默认最新）
   */
  load(type, version = null) {
    // 如果未指定版本，找最新版本
    if (!version) {
      version = this.getLatestVersion(type);
    }

    const templateId = `${type}_${version}`;

    // 先查内存缓存
    if (this.cache.has(templateId)) {
      const template = this.cache.get(templateId);
      this._updateUsage(template);
      return template;
    }

    // 从文件加载
    const templatePath = path.join(this.registryDir, `${templateId}.json`);
    if (!fs.existsSync(templatePath)) {
      console.warn(`[BaselineRegistry] ⚠️ 基线模板不存在: ${templateId}`);
      return null;  // 不返回默认基线，让调用方决定如何处理
    }

    const template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
    this.cache.set(templateId, template);
    this._updateUsage(template);
    
    console.log(`[BaselineRegistry] 📋 基线模板已加载: ${templateId}`);
    return template;
  }

  /**
   * 合并基线 + LLM增量
   * @param {Object} template - 基线模板
   * @param {Object} llmOutput - LLM生成的增量字段
   */
  merge(template, llmOutput) {
    const merged = {
      // 先填充锁定的稳定字段（LLM不可覆盖）
      ...template.lockedFields,
      
      // 再填充LLM生成的增量字段（只合并允许delta的字段）
      ...Object.entries(llmOutput || {}).reduce((acc, [key, value]) => {
        if (template.deltaFields[key] === true && value !== undefined && value !== null) {
          acc[key] = value;
        }
        return acc;
      }, {}),

      // 标记使用了基线
      _baselineUsed: template.id,
      _baselineVersion: template.version
    };

    console.log(`[BaselineRegistry] 🔀 基线合并完成: ${template.id}`);
    return merged;
  }

  /**
   * 通用相似度匹配（不依赖具体领域关键词）
   * @param {Object} requirement - 用户需求
   * @returns {Object} { type, template, score, isHotStart }
   */
  findBestMatch(requirement) {
    const templates = this.list();
    
    if (templates.length === 0) {
      return { type: null, template: null, score: 0, isHotStart: false };
    }

    let bestMatch = null;
    let bestScore = 0;

    for (const template of templates) {
      const score = this._calculateSimilarity(requirement, template);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = template;
      }
    }

    // 阈值判断：相似度 > 0.6 认为可以热启动
    const threshold = 0.6;
    const isHotStart = bestScore >= threshold;

    if (isHotStart && bestMatch) {
      const fullTemplate = this.load(bestMatch.type, bestMatch.version);
      return { type: bestMatch.type, template: fullTemplate, score: bestScore, isHotStart: true };
    }

    return { type: null, template: null, score: bestScore, isHotStart: false };
  }

  /**
   * 计算相似度（通用算法，不依赖具体领域）
   * 基于 matchFeatures 的键值匹配
   */
  _calculateSimilarity(requirement, template) {
    if (!template.matchFeatures || Object.keys(template.matchFeatures).length === 0) {
      return 0;  // 没有匹配特征的模板不参与匹配
    }

    let totalWeight = 0;
    let matchedWeight = 0;

    const reqText = JSON.stringify(requirement).toLowerCase();

    for (const [key, weight] of Object.entries(this.matchWeights)) {
      totalWeight += weight;
      
      const featureValue = template.matchFeatures[key];
      if (!featureValue) continue;

      // 支持字符串或数组形式的特征值
      const featureTexts = Array.isArray(featureValue) ? featureValue : [featureValue];
      
      for (const text of featureTexts) {
        if (reqText.includes(String(text).toLowerCase())) {
          matchedWeight += weight;
          break;  // 该维度已匹配，不再累加
        }
      }
    }

    return totalWeight > 0 ? matchedWeight / totalWeight : 0;
  }

  /**
   * 获取某类型的最新版本
   */
  getLatestVersion(type) {
    try {
      const files = fs.readdirSync(this.registryDir)
        .filter(f => f.startsWith(`${type}_`) && f.endsWith('.json'))
        .sort();
      
      if (files.length === 0) return null;
      
      const latest = files[files.length - 1];
      return latest.replace(`${type}_`, '').replace('.json', '');
    } catch (e) {
      return null;
    }
  }

  /**
   * 列出所有可用的基线模板
   */
  list() {
    try {
      const files = fs.readdirSync(this.registryDir)
        .filter(f => f.endsWith('.json'));
      
      return files.map(f => {
        const template = JSON.parse(fs.readFileSync(path.join(this.registryDir, f), 'utf8'));
        return {
          id: template.id,
          type: template.type,
          version: template.version,
          usageCount: template.metadata.usageCount,
          lastUsed: template.metadata.lastUsed,
          matchFeatures: template.matchFeatures
        };
      });
    } catch (e) {
      console.warn(`[BaselineRegistry] 读取模板列表失败: ${e.message}`);
      return [];
    }
  }

  /**
   * 从成功的项目中提取基线（通用提取，不依赖具体字段名）
   * @param {Object} projectOutput - 成功的项目输出
   * @param {Array<string>} stableFieldKeys - 稳定的字段名列表（由外部指定）
   * @param {Array<string>} creativeFieldKeys - 创意的字段名列表（由外部指定）
   */
  extractFromProject(projectOutput, stableFieldKeys = [], creativeFieldKeys = []) {
    const lockedFields = {};

    const shots = projectOutput.shots || [];
    if (shots.length === 0) return null;

    // 从第一个镜头提取稳定字段
    const firstShot = shots[0];
    for (const key of stableFieldKeys) {
      if (firstShot[key] !== undefined) {
        lockedFields[key] = firstShot[key];
      }
    }

    return {
      lockedFields,
      deltaFields: creativeFieldKeys.reduce((acc, key) => {
        acc[key] = true;
        return acc;
      }, {})
    };
  }

  _updateUsage(template) {
    template.metadata.usageCount++;
    template.metadata.lastUsed = new Date().toISOString();
    
    // 异步写回文件
    const templatePath = path.join(this.registryDir, `${template.id}.json`);
    setImmediate(() => {
      try {
        fs.writeFileSync(templatePath, JSON.stringify(template, null, 2));
      } catch (e) {
        console.warn(`[BaselineRegistry] 更新使用计数失败: ${e.message}`);
      }
    });
  }
}

module.exports = { BaselineRegistry };
