/**
 * BaselineRegistry - 基线模板注册表
 * 
 * 核心职责：
 * 1. 管理已审核通过的基线模板（按题材/类型/版本）
 * 2. 提供热启动加载（基线 + LLM增量合并）
 * 3. 版本管理（v1.0 → v1.1 → v2.0）
 * 
 * 基线模板结构：
 * - lockedFields: 锁定的稳定字段（导演指令、约束、负面提示等）
 * - deltaFields: 允许LLM覆盖的创意字段（场景、动作、台词、运镜）
 * - metadata: 版本信息、审核人、审核时间
 */

const fs = require('fs');
const path = require('path');

class BaselineRegistry {
  constructor(options = {}) {
    this.registryDir = options.registryDir || './shields/baseline-registry/templates';
    this.ensureDirectory();
    
    // 内存缓存
    this.cache = new Map();
    
    // 题材分类映射
    this.categoryMap = {
      'health': '健康科普',
      'medical': '医疗科普',
      'education': '教育科普',
      'product': '产品广告',
      'story': '故事短片',
      'default': '通用基线'
    };
  }

  ensureDirectory() {
    if (!fs.existsSync(this.registryDir)) {
      fs.mkdirSync(this.registryDir, { recursive: true });
    }
  }

  /**
   * 注册新基线模板（冷启动后人工审核通过）
   * @param {string} category - 题材类型（health/medical/education等）
   * @param {string} version - 版本号（如 v1.0）
   * @param {Object} baseline - 基线数据
   * @param {Object} approval - 审核信息
   */
  register(category, version, baseline, approval = {}) {
    const templateId = `${category}_${version}`;
    const templatePath = path.join(this.registryDir, `${templateId}.json`);

    const template = {
      id: templateId,
      category,
      version,
      // 锁定的稳定字段（LLM不可覆盖）
      lockedFields: {
        directorInstruction: baseline.directorInstruction || '',
        constraint: baseline.constraint || '',
        baseline: baseline.baseline || '',
        negativePrompt: baseline.negativePrompt || '',
        colorScience: baseline.colorScience || '',
        renderStyle: baseline.renderStyle || '',
        characterConstraint: baseline.characterConstraint || '',
        consistency: baseline.consistency || '',
        brightConstraint: baseline.brightConstraint || '',
        aspectRatio: baseline.aspectRatio || '16:9',
        frameRate: baseline.frameRate || '24fps',
        resolution: baseline.resolution || '1920x1080'
      },
      // 允许LLM覆盖的创意字段
      deltaFields: {
        scene: true,
        action: true,
        dialogue: true,
        camera: true,
        mood: true,
        lighting: true,
        timeline: true,
        backgroundSound: true
      },
      // 审核信息
      metadata: {
        approvedBy: approval.approvedBy || 'system',
        approvedAt: approval.approvedAt || new Date().toISOString(),
        description: approval.description || '',
        sourceProject: approval.sourceProject || '',
        usageCount: 0,
        lastUsed: null
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
   * 加载基线模板（热启动）
   * @param {string} category - 题材类型
   * @param {string} version - 版本号（默认最新）
   */
  load(category, version = null) {
    // 如果未指定版本，找最新版本
    if (!version) {
      version = this.getLatestVersion(category);
    }

    const templateId = `${category}_${version}`;

    // 先查内存缓存
    if (this.cache.has(templateId)) {
      const template = this.cache.get(templateId);
      this._updateUsage(template);
      return template;
    }

    // 从文件加载
    const templatePath = path.join(this.registryDir, `${templateId}.json`);
    if (!fs.existsSync(templatePath)) {
      console.warn(`[BaselineRegistry] ⚠️ 基线模板不存在: ${templateId}，将使用默认基线`);
      return this._createDefaultBaseline(category);
    }

    const template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
    this.cache.set(templateId, template);
    this._updateUsage(template);
    
    console.log(`[BaselineRegistry] 📋 基线模板已加载: ${templateId} (已使用${template.metadata.usageCount}次)`);
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
      
      // 再填充LLM生成的增量字段（如果存在）
      ...Object.entries(llmOutput).reduce((acc, [key, value]) => {
        // 只合并允许delta的字段
        if (template.deltaFields[key] === true && value) {
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
   * 检查输入是否匹配基线模板（用于热启动判断）
   * @param {Object} requirement - 用户需求
   */
  findBestMatch(requirement) {
    const category = this._detectCategory(requirement);
    const template = this.load(category);
    
    return {
      category,
      template,
      isHotStart: template.metadata.usageCount > 0
    };
  }

  /**
   * 自动检测题材类型
   */
  _detectCategory(requirement) {
    const text = JSON.stringify(requirement).toLowerCase();
    
    const keywords = {
      'health': ['健康', '养生', '科普', '横纹肌', '护理', '健康护理'],
      'medical': ['医疗', '医院', '疾病', '治疗', '药品', '医生'],
      'education': ['教育', '教学', '学习', '知识', '课程', '培训'],
      'product': ['产品', '广告', '商品', '品牌', '销售', '推广', 'cleanmaster'],
      'story': ['故事', '剧情', '短片', '电影', '叙事', '角色']
    };

    for (const [category, words] of Object.entries(keywords)) {
      if (words.some(w => text.includes(w))) {
        return category;
      }
    }

    return 'default';
  }

  /**
   * 获取某题材的最新版本
   */
  getLatestVersion(category) {
    const files = fs.readdirSync(this.registryDir)
      .filter(f => f.startsWith(`${category}_`) && f.endsWith('.json'))
      .sort();
    
    if (files.length === 0) return 'v1.0';
    
    const latest = files[files.length - 1];
    return latest.replace(`${category}_`, '').replace('.json', '');
  }

  /**
   * 列出所有可用的基线模板
   */
  list() {
    const files = fs.readdirSync(this.registryDir)
      .filter(f => f.endsWith('.json'));
    
    return files.map(f => {
      const template = JSON.parse(fs.readFileSync(path.join(this.registryDir, f), 'utf8'));
      return {
        id: template.id,
        category: template.category,
        version: template.version,
        usageCount: template.metadata.usageCount,
        lastUsed: template.metadata.lastUsed,
        approvedBy: template.metadata.approvedBy
      };
    });
  }

  /**
   * 从成功的项目中提取基线
   * @param {Object} projectOutput - 成功的项目输出
   */
  extractFromProject(projectOutput) {
    const lockedFields = {};
    const deltaFields = {};

    // 遍历所有镜头，统计哪些字段是稳定的（所有镜头一致）
    const shots = projectOutput.shots || [];
    if (shots.length === 0) return null;

    const stableKeys = [
      'directorInstruction', 'constraint', 'baseline', 'negativePrompt',
      'colorScience', 'renderStyle', 'characterConstraint', 'consistency',
      'brightConstraint', 'aspectRatio', 'frameRate', 'resolution'
    ];

    const creativeKeys = [
      'scene', 'action', 'dialogue', 'camera', 'mood', 'lighting',
      'timeline', 'backgroundSound'
    ];

    // 提取第一个镜头的稳定字段作为基线
    const firstShot = shots[0];
    stableKeys.forEach(key => {
      if (firstShot[key]) lockedFields[key] = firstShot[key];
    });

    return {
      lockedFields,
      deltaFields: creativeKeys.reduce((acc, key) => {
        acc[key] = true;
        return acc;
      }, {})
    };
  }

  /**
   * 创建默认基线（兜底）
   */
  _createDefaultBaseline(category) {
    return {
      id: `${category}_default`,
      category,
      version: 'default',
      lockedFields: {
        directorInstruction: '好莱坞纪录片质感，写实风格，无特效',
        constraint: 'Aspect ratio: 16:9, Resolution: 1920x1080, Format: MP4, Frame rate: 24fps',
        baseline: '8K resolution, cinematic quality, highly detailed, photorealistic',
        negativePrompt: 'no text, no watermark, no logo, no cartoon style',
        colorScience: 'REC.709 color space, natural skin tones',
        renderStyle: 'cinematic film look, 35mm texture',
        characterConstraint: '保持角色形象一致，服装发型每帧统一',
        consistency: '禁止角色变形或分身',
        brightConstraint: 'bright lighting, well-lit scene, clear visibility',
        aspectRatio: '16:9',
        frameRate: '24fps',
        resolution: '1920x1080'
      },
      deltaFields: {
        scene: true, action: true, dialogue: true, camera: true,
        mood: true, lighting: true, timeline: true, backgroundSound: true
      },
      metadata: {
        approvedBy: 'system',
        approvedAt: new Date().toISOString(),
        description: '自动生成的默认基线',
        usageCount: 0,
        lastUsed: null
      }
    };
  }

  _updateUsage(template) {
    template.metadata.usageCount++;
    template.metadata.lastUsed = new Date().toISOString();
    
    // 异步写回文件（不阻塞主流程）
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
