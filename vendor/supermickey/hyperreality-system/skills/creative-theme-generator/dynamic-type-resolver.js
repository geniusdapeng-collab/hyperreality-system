
/**
 * DynamicTypeResolver - LLM 动态类型配置生成器
 * 
 * 当遇到 TYPE_LIBRARY 中不存在的自定义类型时，调用 LLM 动态生成类型配置，
 * 替代静态硬编码池子。支持本地缓存，避免重复调用。
 * 
 * @version 1.0.0
 */

const fs = require('fs');
const path = require('path');

class DynamicTypeResolver {
  constructor(options = {}) {
    this.llmEngine = options.llmEngine || null;
    this.cacheDir = options.cacheDir || path.join(__dirname, '../../../cache/type-configs');
    this.cacheEnabled = options.cacheEnabled !== false;
    this.timeoutMs = options.timeoutMs || 60000;
    
    // 确保缓存目录存在
    if (this.cacheEnabled && !fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  /**
   * 解析类型配置
   * @param {string} type - 类型名称
   * @param {Object} context - 上下文信息（用户输入、主题等）
   * @returns {Promise<Object>} 类型配置
   */
  async resolve(type, context = {}) {
    // 标准化类型名
    const normalizedType = this._normalizeTypeName(type);
    
    // 1. 检查缓存
    if (this.cacheEnabled) {
      const cached = this._loadFromCache(normalizedType);
      if (cached) {
        console.log(`[DynamicTypeResolver] ✅ 缓存命中: ${normalizedType}`);
        return cached;
      }
    }

    // 2. LLM 动态生成
    if (this.llmEngine) {
      try {
        const config = await this._generateWithLLM(normalizedType, context);
        
        // 保存缓存
        if (this.cacheEnabled) {
          this._saveToCache(normalizedType, config);
        }
        
        return config;
      } catch (e) {
        console.warn(`[DynamicTypeResolver] ⚠️ LLM 生成失败: ${e.message}，使用 fallback`);
      }
    }

    // 3. Fallback
    return this._fallbackConfig(normalizedType, context);
  }

  /**
   * 批量解析（用于一次性解析多个类型）
   */
  async resolveBatch(types, context = {}) {
    const results = {};
    for (const type of types) {
      results[type] = await this.resolve(type, context);
    }
    return results;
  }

  /**
   * 使用 LLM 生成类型配置
   */
  async _generateWithLLM(type, context) {
    const prompt = this._buildPrompt(type, context);
    
    console.log(`[DynamicTypeResolver] 🧠 调用 LLM 生成类型配置: ${type}`);
    
    let responseText = '';
    
    // 尝试 reasonStructured
    if (typeof this.llmEngine.reasonStructured === 'function') {
      const schema = this._getConfigSchema();
      const result = await this.llmEngine.reasonStructured(prompt, schema, {
        maxTokens: 4000,
        temperature: 1.0,
        timeoutMs: this.timeoutMs
      });
      // 【修复 P0-5】reasonStructured 返回信封 {success, data, ...}，必须检查 success 并提取 data
      if (result && result.success === true && result.data) {
        // 【v2.1.15-fix】校验配置完整性：畸形配置直接丢弃走 fallback，不入缓存
        this._validateConfig(result.data);
        return result.data;
      }
      if (result && result.success === false) {
        console.warn(`[DynamicTypeResolver] reasonStructured 失败: ${result.error || '未知错误'}`);
      }
      // 失败时不应返回信封对象，避免污染缓存
      throw new Error('reasonStructured 未返回有效数据');
    }
    
    // 尝试 generate
    if (typeof this.llmEngine.generate === 'function') {
      const result = await this.llmEngine.generate(prompt, {
        maxTokens: 4000,
        temperature: 1.0
      });
      responseText = result.content || '';
    }
    
    // 尝试 chat
    else if (typeof this.llmEngine.chat === 'function') {
      const result = await this.llmEngine.chat(
        '你是一位视频类型专家。只输出严格格式的JSON。',
        prompt,
        1.0
      );
      responseText = result.content || result.data || '';
    }
    
    else {
      throw new Error('LLM 引擎无可用的调用方法');
    }

    // 解析 JSON
    const jsonMatch = responseText.match(/```json\n?([\s\S]*?)\n?```/) ||
                      responseText.match(/{[\s\S]*}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);
      // 【v2.1.15-fix】同样校验完整性
      this._validateConfig(parsed);
      return parsed;
    }
    throw new Error('无法解析 LLM 输出');
  }

  /**
   * 【v2.1.15-fix】校验 LLM 生成的类型配置完整性
   * 防止畸形 JSON 被缓存后污染后续所有同类型生成
   */
  _validateConfig(config) {
    if (!config || typeof config !== 'object') {
      throw new Error('配置不是有效对象');
    }
    if (typeof config.typeName !== 'string' || !config.typeName.trim()) {
      throw new Error('配置缺少有效的 typeName 字段');
    }
    if (!Array.isArray(config.themes) || config.themes.length === 0) {
      throw new Error('配置缺少有效的 themes 数组');
    }
    return true;
  }

  /**
   * 构建 Prompt
   */
  _buildPrompt(type, context) {
    const { theme = '', description = '', tone = '', userInput = '' } = context;

    // 【v2.1.15-fix 主题漂移】完整用户输入是生成类型配置的首要依据。
    // 原实现只有类型名（还是20字符截断的）+三个空字段，LLM只能自由发挥
    const userInputSection = userInput
      ? `【用户完整输入——最重要依据】\n${userInput}\n`
      : '';

    return `你是一位视频类型学专家。请为以下视频类型生成完整的类型配置。

【类型名称】${type}

${userInputSection}【上下文】
- 用户主题: ${theme || '未指定'}
- 用户描述: ${description || '未指定'}
- 情绪基调: ${tone || '未指定'}

请生成该类型的标准配置，包含以下字段：

{
  "typeName": "类型名称（中文）",
  "category": "大类分类（如: 剧情/纪录/广告/艺术/MV/教育/旅游/美食/运动/恐怖/科幻/喜剧/爱情/家庭）",
  "themes": ["主题1", "主题2", "主题3", "主题4", "主题5"],
  "descriptionTemplate": "该类型视频的标准描述模板（50-200字，用{theme}作为占位符）",
  "visualFeatures": ["视觉特征1", "视觉特征2", "视觉特征3", "视觉特征4"],
  "toneOptions": ["情绪1", "情绪2", "情绪3"],
  "dialoguePattern": "台词要求模式（如: '无对白，依靠画面叙事' 或 '根据场景需要设计对白，不超过5句'）",
  "specialNotes": "特殊技术要求（如有）",
  "filmReferences": ["参考影片1", "参考影片2"],
  "typicalDuration": { "min": 30, "max": 120, "default": 60 },
  "targetAudience": "典型受众描述",
  "difficulty": "难度等级（简单/中等/困难/极高）"
}

【硬性要求——防止主题漂移】
1. 若提供了【用户完整输入】，typeName/themes/descriptionTemplate 必须紧扣该输入的
   核心内容（人物、地点、事件、情感），严禁套用到无关的通用题材
   （如用户写"滕王阁"不得生成"故宫"相关内容）
2. themes[0] 应直接提炼自用户输入的核心主题（如"滕王阁穿越记"），
   其余 themes 可为同类型拓展
3. descriptionTemplate 中的情节要素必须来自用户输入，不得虚构无关场景
4. themes 必须包含5个该类型的经典主题
5. 所有字段必须存在且不为空
6. 只输出 JSON，不要任何解释文本`;
  }

  /**
   * JSON Schema for validation
   */
  _getConfigSchema() {
    return {
      type: 'object',
      required: ['typeName', 'category', 'themes', 'descriptionTemplate', 'visualFeatures', 'toneOptions'],
      properties: {
        typeName: { type: 'string' },
        category: { type: 'string' },
        themes: { type: 'array', items: { type: 'string' }, minItems: 3 },
        descriptionTemplate: { type: 'string' },
        visualFeatures: { type: 'array', items: { type: 'string' } },
        toneOptions: { type: 'array', items: { type: 'string' } },
        dialoguePattern: { type: 'string' },
        specialNotes: { type: 'string' },
        filmReferences: { type: 'array', items: { type: 'string' } },
        typicalDuration: {
          type: 'object',
          properties: {
            min: { type: 'number' },
            max: { type: 'number' },
            default: { type: 'number' }
          }
        },
        targetAudience: { type: 'string' },
        difficulty: { type: 'string' }
      }
    };
  }

  /**
   * 【修复 P1-5】Fallback 配置使用中性描述，避免硬编码风格词（如"电影级"）与写实规则冲突
   */
  _fallbackConfig(type, context) {
    console.log(`[DynamicTypeResolver] 🔄 使用 fallback 配置: ${type}`);
    
    return {
      typeName: type,
      category: '通用',
      themes: [`${type}主题A`, `${type}主题B`, `${type}主题C`, '未命名主题', '探索未知'],
      descriptionTemplate: '一部关于{type}的视频作品，展现{theme}的独特魅力与情感深度',
      visualFeatures: ['写实风格', '自然光线', '真实环境', '细节丰富'],
      toneOptions: ['温暖治愈', '中性客观', '诗意哀伤'],
      dialoguePattern: '根据场景需要设计对白，不超过5句',
      specialNotes: '无特殊技术要求',
      filmReferences: ['《永恒和一日》', '《时间的风景》'],
      typicalDuration: { min: 30, max: 120, default: 60 },
      targetAudience: '大众观众',
      difficulty: '中等'
    };
  }

  /**
   * 缓存加载
   */
  _loadFromCache(type) {
    const cachePath = path.join(this.cacheDir, `${type}.json`);
    if (fs.existsSync(cachePath)) {
      try {
        return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      } catch (e) {
        console.warn(`[DynamicTypeResolver] ⚠️ 缓存读取失败: ${type}`);
      }
    }
    return null;
  }

  /**
   * 缓存保存
   */
  _saveToCache(type, config) {
    const cachePath = path.join(this.cacheDir, `${type}.json`);
    try {
      fs.writeFileSync(cachePath, JSON.stringify(config, null, 2), 'utf8');
      console.log(`[DynamicTypeResolver] 💾 缓存已保存: ${type}`);
    } catch (e) {
      console.warn(`[DynamicTypeResolver] ⚠️ 缓存保存失败: ${type}`);
    }
  }

  /**
   * 标准化类型名（用于文件名）
   */
  _normalizeTypeName(type) {
    return type.replace(/[^\w\u4e00-\u9fa5]/g, '_');
  }

  /**
   * 清除缓存
   */
  clearCache() {
    if (fs.existsSync(this.cacheDir)) {
      const files = fs.readdirSync(this.cacheDir);
      for (const file of files) {
        fs.unlinkSync(path.join(this.cacheDir, file));
      }
      console.log(`[DynamicTypeResolver] 🗑️ 已清除 ${files.length} 个缓存文件`);
    }
  }

  /**
   * 列出所有缓存
   */
  listCache() {
    if (!fs.existsSync(this.cacheDir)) return [];
    return fs.readdirSync(this.cacheDir)
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace('.json', ''));
  }
}

module.exports = { DynamicTypeResolver };