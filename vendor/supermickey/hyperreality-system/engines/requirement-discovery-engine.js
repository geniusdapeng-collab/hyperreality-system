/**
 * RequirementDiscoveryEngine - 需求洞察引擎
 * 
 * 职责：基于上游 CreativeThemeGenerator 输出的 12 字段，进行深度业务洞察
 * 输出：《业务需求对齐清单》- 结构化、强约束、可直接进入 PRD 环节
 * 
 * 设计原则：
 * - 输入只认上游 12 字段，不从用户原始输入重新解析
 * - 4 个 Agent 串行执行，每个有独立超时保护
 * - 输出严格遵循 JSON Schema，缺失字段自动兜底
 * - 用户只确认 Yes/No，不主动追问
 * 
 * @version 1.0.0
 * @date 2026-07-04
 */

// ===== JSON Schema 定义 =====

const AudienceProfileSchema = {
  type: "object",
  required: ["primaryAudience", "emotionTriggers", "contentExpectations"],
  properties: {
    primaryAudience: {
      type: "object",
      required: ["ageRange", "gender", "interestTags", "consumptionLevel"],
      properties: {
        ageRange: { type: "string", enum: ["18-24", "25-30", "31-35", "36-40", "40+"] },
        gender: { type: "string", enum: ["male", "female", "all"] },
        interestTags: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 5 },
        occupation: { type: "string" },
        consumptionLevel: { type: "string", enum: ["low", "medium", "high", "luxury"] }
      }
    },
    secondaryAudience: { type: "array", items: { type: "string" }, maxItems: 3 },
    emotionTriggers: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 5 },
    painPoints: { type: "array", items: { type: "string" }, maxItems: 3 },
    contentExpectations: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 4 }
  },
  additionalProperties: false
};

const SceneStructureSchema = {
  type: "object",
  required: ["opening", "scenes", "ending", "totalDuration", "sceneCount"],
  properties: {
    opening: {
      type: "object",
      required: ["duration", "purpose", "keyElements"],
      properties: {
        duration: { type: "number", minimum: 3, maximum: 15 },
        purpose: { type: "string", minLength: 10, maxLength: 100 },
        keyElements: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 }
      }
    },
    scenes: {
      type: "array",
      items: {
        type: "object",
        required: ["index", "duration", "purpose", "keyElements", "emotionalBeat"],
        properties: {
          index: { type: "number" },
          duration: { type: "number", minimum: 5, maximum: 60 },
          purpose: { type: "string", minLength: 10, maxLength: 100 },
          keyElements: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 },
          emotionalBeat: { type: "string", enum: ["setup", "rising", "climax", "falling", "resolution", "twist"] }
        }
      },
      minItems: 2,
      maxItems: 8
    },
    ending: {
      type: "object",
      required: ["duration", "purpose", "keyElements"],
      properties: {
        duration: { type: "number", minimum: 3, maximum: 15 },
        purpose: { type: "string", minLength: 10, maxLength: 100 },
        keyElements: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 }
      }
    },
    totalDuration: { type: "number" },
    sceneCount: { type: "number" },
    narrativeArc: { type: "string", enum: ["linear", "loop", "flashback", "parallel", "twist"] }
  },
  additionalProperties: false
};

const RiskAssessmentSchema = {
  type: "object",
  required: ["technicalRisks", "businessConstraints", "mitigationSuggestions"],
  properties: {
    technicalRisks: {
      type: "array",
      items: {
        type: "object",
        required: ["risk", "level", "impact"],
        properties: {
          risk: { type: "string" },
          level: { type: "string", enum: ["high", "medium", "low"] },
          impact: { type: "string" }
        }
      },
      minItems: 1,
      maxItems: 5
    },
    businessConstraints: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      maxItems: 4
    },
    mitigationSuggestions: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      maxItems: 4
    }
  },
  additionalProperties: false
};

const ReferenceCasesSchema = {
  type: "object",
  required: ["filmReferences", "adReferences", "styleReferences"],
  properties: {
    filmReferences: {
      type: "array",
      items: {
        type: "object",
        required: ["title", "relevance", "keyTakeaway"],
        properties: {
          title: { type: "string" },
          relevance: { type: "string", enum: ["high", "medium", "low"] },
          keyTakeaway: { type: "string" }
        }
      },
      minItems: 2,
      maxItems: 4
    },
    adReferences: {
      type: "array",
      items: {
        type: "object",
        required: ["brand", "relevance", "keyTakeaway"],
        properties: {
          brand: { type: "string" },
          relevance: { type: "string", enum: ["high", "medium", "low"] },
          keyTakeaway: { type: "string" }
        }
      },
      minItems: 1,
      maxItems: 3
    },
    styleReferences: {
      type: "array",
      items: { type: "string" },
      minItems: 2,
      maxItems: 4
    }
  },
  additionalProperties: false
};

const RequirementAlignmentSchema = {
  type: "object",
  required: [
    "upstreamFields",
    "audienceProfile",
    "sceneStructure",
    "riskAssessment",
    "referenceCases",
    "confirmationStatus"
  ],
  properties: {
    upstreamFields: { type: "object" },
    audienceProfile: AudienceProfileSchema,
    sceneStructure: SceneStructureSchema,
    riskAssessment: RiskAssessmentSchema,
    referenceCases: ReferenceCasesSchema,
    confirmationStatus: {
      type: "object",
      required: ["status", "timestamp"],
      properties: {
        status: { type: "string", enum: ["pending", "confirmed", "modified"] },
        userFeedback: { type: "string" },
        timestamp: { type: "string" }
      }
    }
  },
  additionalProperties: false
};

// ===== Agent 基类 =====

class BaseDiscoveryAgent {
  constructor(options = {}) {
    this.name = options.name || 'unnamed-agent';
    this.llmEngine = options.llmEngine || null;
    this.timeoutMs = options.timeoutMs || 90000; // 90 秒默认
    this.maxRetries = options.maxRetries || 1;
  }

  async run(input, schema) {
    const startTime = Date.now();
    
    for (let i = 0; i <= this.maxRetries; i++) {
      try {
        const result = await this._callLLM(input, schema);
        const validated = this._validateAndFill(result, schema);
        console.log(`   [${this.name}] ✅ 完成 (${Date.now() - startTime}ms)`);
        return validated;
      } catch (error) {
        console.warn(`   [${this.name}] ⚠️ 第${i + 1}次失败: ${error.message}`);
        if (i === this.maxRetries) {
          console.warn(`   [${this.name}] ❌ 全部失败，使用兜底规则`);
          return this._fallback(input, schema);
        }
      }
    }
  }

  async _callLLM(input, schema) {
    if (!this.llmEngine) {
      throw new Error('LLM 引擎未初始化');
    }

    const prompt = this._buildPrompt(input);
    
    // 【方案A-fix】原始故事文本注入：从 input 中提取并追加到 prompt
    const originalStory = input._originalStoryText || input.original_story_text || '';
    const fullPrompt = originalStory ? `${prompt}\n\n## 📖 原始故事文本（需求分析的核心依据）\n${originalStory}` : prompt;
    
    // 超时保护
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('LLM 调用超时')), this.timeoutMs);
    });

    let responseText = '';

    try {
      if (typeof this.llmEngine.reasonStructured === 'function') {
        // 【v2.1.9-fix】SceneArchitect 的 schema 过大，导致 prompt 膨胀挤干 content
        // 改用 prompt 自描述模式，不传 schema 给 reasonStructured
        const useSchema = this.name === 'SceneArchitect' ? null : schema;
        console.log(`[DEBUG] Agent=${this.name}, useSchema=${useSchema === null ? 'null' : 'provided'}, schemaSize=${useSchema ? JSON.stringify(useSchema).length : 0}`);
        
        // 【v2.1.9-fix2】SceneArchitect 在 JSON mode 下 content 始终为 0
        // 改用普通 mode + 手动解析 JSON
        if (this.name === 'SceneArchitect') {
          const result = await Promise.race([
            this.llmEngine.reason(fullPrompt, { 
              maxTokens: 4000, 
              temperature: 1.0,
              timeoutMs: this.timeoutMs,
              forceJson: false
            }),
            timeoutPromise
          ]);
          if (!result.success) throw new Error(result.error);
          // 手动从 content 提取 JSON
          const extracted = this.llmEngine._extractJsonObject(result.content);
          if (!extracted) throw new Error('无法从 content 提取 JSON');
          return JSON.parse(extracted);
        }
        
        const result = await Promise.race([
          this.llmEngine.reasonStructured(fullPrompt, useSchema, { 
            maxTokens: 4000, 
            temperature: 1.0,
            timeoutMs: this.timeoutMs 
          }),
          timeoutPromise
        ]);
        return result.data || result;
      } else if (typeof this.llmEngine.generate === 'function') {
        const result = await Promise.race([
          this.llmEngine.generate(fullPrompt, { maxTokens: 4000, temperature: 1.0 }),
          timeoutPromise
        ]);
        responseText = result.content || '';
      } else if (typeof this.llmEngine.chat === 'function') {
        const result = await Promise.race([
          this.llmEngine.chat('你是一位资深视频业务分析师。只输出严格格式的JSON。', prompt, 1.0),
          timeoutPromise
        ]);
        responseText = result.content || result.data || '';
      } else {
        throw new Error('LLM 引擎无可用的调用方法');
      }
    } catch (error) {
      throw error;
    }

    // 解析 JSON
    try {
      const jsonMatch = responseText.match(/```json\n?([\s\S]*?)\n?```/) ||
                        responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[1] || jsonMatch[0]);
      }
      throw new Error('无法解析 LLM 输出为 JSON');
    } catch (e) {
      throw new Error(`JSON 解析失败: ${e.message}`);
    }
  }

  _validateAndFill(result, schema) {
    // 递归检查 required 字段，缺失则使用 _fallback 补全
    return this._fillDefaults(result, schema);
  }

  _fillDefaults(result, schema, path = '') {
    if (!result || typeof result !== 'object') {
      return this._fallback({}, schema);
    }

    const filled = { ...result };

    // 检查 required 字段
    if (schema.required) {
      for (const key of schema.required) {
        if (filled[key] === undefined || filled[key] === null) {
          // 从 fallback 获取默认值
          const fallback = this._fallback({}, schema);
          filled[key] = fallback[key];
        }
      }
    }

    // 递归处理对象属性
    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (filled[key] && propSchema.type === 'object') {
          filled[key] = this._fillDefaults(filled[key], propSchema, `${path}.${key}`);
        }
      }
    }

    // 递归处理数组 items
    if (schema.items && Array.isArray(filled)) {
      filled = filled.map((item, i) => 
        this._fillDefaults(item, schema.items, `${path}[${i}]`)
      );
    }

    return filled;
  }

  _buildPrompt(input) {
    throw new Error('子类必须实现 _buildPrompt');
  }

  _fallback(input, schema) {
    throw new Error('子类必须实现 _fallback');
  }
}

// ===== 4 个洞察 Agent =====

class AudienceProfiler extends BaseDiscoveryAgent {
  constructor(options) {
    super({ name: 'AudienceProfiler', ...options });
  }

  _buildPrompt(input) {
    const { type, theme, tone, description, target_audience } = input;
    return `你是一位操过多个全球爆款短片的传播策略师。基于视频主题做受众分析，但你输出的不是"人群标签"，而是"这群人为什么会在第3秒停下来、在第50秒转发"。

视频类型: ${type}
核心主题: ${theme}
情绪基调: ${tone || '未指定'}
主题描述: ${description || '未提供'}
用户指定受众: ${target_audience || '未指定'}

【分析心法】
1. emotionTriggers 必须写到具体画面级：不是'匠人精神感人'，而是'老匠人颤抖的手与一整车人的安危之间的张力'——每个触发点都要能直接翻译成镜头。
2. painPoints 写现代生活的缺失感（快节奏/技艺消逝/承诺稀缺），不写生理痛点。
3. contentExpectations 至少包含一条'无需字幕也能看懂的视觉叙事'类全球化要求，和一条'可复述可转发的钉子台词'类传播要求。
4. secondaryAudience 写'有具体记忆关联的人'（去过京都的游客/手艺人），不写泛人群。

【原始故事文本是核心依据】所有结论必须能从原文细节里找到出处，禁止套模板。

请输出 JSON 格式的受众分析：
{
  "primaryAudience": {
    "ageRange": "18-24|25-30|31-35|36-40|40+",
    "gender": "male|female|all",
    "interestTags": ["标签1", "标签2", "标签3"],
    "occupation": "主要职业群体",
    "consumptionLevel": "low|medium|high|luxury"
  },
  "secondaryAudience": ["次要受众1", "次要受众2"],
  "emotionTriggers": ["情绪触发点1", "情绪触发点2", "情绪触发点3"],
  "painPoints": ["痛点1", "痛点2"],
  "contentExpectations": ["期望1", "期望2", "期望3"]
}

要求：
1. ageRange 必须从枚举中选择
2. gender 必须从枚举中选择
3. interestTags 2-5个
4. consumptionLevel 必须从枚举中选择
5. 所有字段必须存在`;
  }

  _fallback(input) {
    const typeToAudience = {
      '硬科幻': { ageRange: '25-30', gender: 'male', interestTags: ['科幻', '科技', '电影'], consumptionLevel: 'medium' },
      '赛博朋克': { ageRange: '18-24', gender: 'all', interestTags: ['科幻', '潮流', '游戏'], consumptionLevel: 'medium' },
      '武侠动作': { ageRange: '25-30', gender: 'male', interestTags: ['武侠', '动作', '国风'], consumptionLevel: 'medium' },
      '恐怖悬疑': { ageRange: '25-30', gender: 'all', interestTags: ['悬疑', '恐怖', '推理'], consumptionLevel: 'medium' },
      '自然纪录片': { ageRange: '31-35', gender: 'all', interestTags: ['自然', '纪录片', '科普'], consumptionLevel: 'high' },
      '商业广告': { ageRange: '25-30', gender: 'all', interestTags: ['品牌', '消费', '生活方式'], consumptionLevel: 'high' },
      '科普教育': { ageRange: '25-30', gender: 'all', interestTags: ['知识', '学习', '科普'], consumptionLevel: 'medium' },
      '音乐MV': { ageRange: '18-24', gender: 'all', interestTags: ['音乐', '舞蹈', '潮流'], consumptionLevel: 'medium' },
      '家庭温情': { ageRange: '31-35', gender: 'all', interestTags: ['家庭', '温情', '生活'], consumptionLevel: 'medium' },
      '浪漫爱情': { ageRange: '18-24', gender: 'female', interestTags: ['爱情', '浪漫', '情感'], consumptionLevel: 'medium' },
      '喜剧荒诞': { ageRange: '18-24', gender: 'all', interestTags: ['喜剧', '幽默', '娱乐'], consumptionLevel: 'low' },
      '历史战争': { ageRange: '31-35', gender: 'male', interestTags: ['历史', '战争', '军事'], consumptionLevel: 'medium' },
      '社会现实': { ageRange: '25-30', gender: 'all', interestTags: ['社会', '现实', '纪实'], consumptionLevel: 'medium' },
      '艺术实验': { ageRange: '25-30', gender: 'all', interestTags: ['艺术', '实验', '独立'], consumptionLevel: 'medium' },
      '运动竞技': { ageRange: '18-24', gender: 'male', interestTags: ['运动', '竞技', '热血'], consumptionLevel: 'medium' },
      '美食文化': { ageRange: '25-30', gender: 'all', interestTags: ['美食', '文化', '生活'], consumptionLevel: 'medium' },
      '文化遗产': { ageRange: '31-35', gender: 'all', interestTags: ['文化', '遗产', '历史'], consumptionLevel: 'high' },
      '旅游推广': { ageRange: '25-30', gender: 'all', interestTags: ['旅行', '摄影', '生活方式'], consumptionLevel: 'high' }
    };

    const defaultAudience = { ageRange: '25-30', gender: 'all', interestTags: ['通用'], consumptionLevel: 'medium' };
    const primary = typeToAudience[input.type] || defaultAudience;

    return {
      primaryAudience: {
        ...primary,
        occupation: 'general'
      },
      secondaryAudience: ['general audience'],
      emotionTriggers: ['情感共鸣', '视觉享受'],
      painPoints: [],
      contentExpectations: ['高质量内容', '清晰表达']
    };
  }
}

class SceneArchitect extends BaseDiscoveryAgent {
  constructor(options) {
    super({ name: 'SceneArchitect', ...options });
  }

  _buildPrompt(input) {
    const { type, theme, duration_sec, tone, description } = input;
    const duration = duration_sec || 45;
    const sceneCount = Math.min(Math.max(Math.ceil(duration / 15), 2), 8);

    // 【P0-PE-01】根据类型注入电影语法参考
    const filmGrammar = this._getFilmGrammar(type);

    return `你是一位电影导演，正在为AI视频生成系统设计场景结构。每个场景的设计要回答三个问题：观众看到了什么？观众感受到了什么？观众为什么继续看下去？

视频类型: ${type}
核心主题: ${theme}
目标时长: ${duration}秒
情绪基调: ${tone || '未指定'}
主题描述: ${description || '未提供'}

${filmGrammar}

请设计 ${sceneCount} 个场景（含开场和结尾），总时长约 ${duration} 秒。

输出 JSON 格式（严格遵守，只输出合法 JSON，不要 markdown 代码块）：
{"opening":{"duration":10,"purpose":"开场目的 —— 观众第一眼看到什么？为什么会被吸引？","keyElements":["元素1","元素2"]},"scenes":[{"index":1,"duration":10,"purpose":"场景目的 —— 如果删掉这镜，故事会损失什么？","keyElements":["元素1","元素2"],"emotionalBeat":"setup"}],"ending":{"duration":10,"purpose":"结尾目的 —— 观众离开时会记住什么？","keyElements":["元素1","元素2"]},"totalDuration":${duration},"sceneCount":${sceneCount},"narrativeArc":"linear"}

要求：
1. 所有场景时长之和 ≈ ${duration} 秒
2. 每个场景必须有 emotionalBeat（从枚举中选一个：setup/rising/climax/falling/resolution/twist）
3. 场景按叙事节奏排列：setup → rising → climax → resolution
4. 关键元素 1-3 个
5. purpose 必须具体、电影化，避免"推动叙事发展"这种泛化描述。要回答：观众看到了什么具体画面？感受到了什么情绪？为什么继续看？
6. 只输出 JSON，不要任何解释文字

【结构心法——三幕呼吸法】
1. opening（前3秒抓眼）：第一帧即悬念——把全片最大的矛盾浓缩成一个画面（巨大vs渺小/颤抖的手vs一整车安危），禁止平铺直叙的建立镜头。
2. 每个 scenes[i].purpose 必须写'删掉这镜故事会损失什么'——答不上来就说明这镜该删。
3. 情绪弧线必须有'换气口'：高潮(climax)之后、结尾(ending)之前，安排一个 falling 级的留白场景（3-6秒），让最后的释放有落差。60秒短片没有喘息就是噪音。
4. ending 必须落到'一个特写+一句台词'的收束结构：观众最后记住的永远是一个细节，不是一个道理。
5. keyElements 只写能被镜头拍到的物理元素，禁止'氛围''感觉'类词。

【时长铁律】所有场景时长之和≈目标时长；climax 场景时长必须≥任一其他场景的1.3倍——重点不突出等于没有重点。`;
  }

  // 【P0-PE-01 新增】类型化电影语法引导
  _getFilmGrammar(type) {
    const grammar = {
      '硬科幻': '【电影语法参考】关注：空间尺度感、科技纹理细节、冷色调光影、未知文明的神秘感',
      '赛博朋克': '【电影语法参考】关注：霓虹反射、雨夜氛围、高低反差构图、东方未来主义',
      '武侠动作': '【电影语法参考】关注：动作留白、气流轨迹、武器反光、身体动态线',
      '恐怖悬疑': '【电影语法参考】关注：阴影层次、声音引导视线、封闭空间压迫感、未知轮廓',
      '自然纪录片': '【电影语法参考】关注：自然光变化、微距纹理、生物行为瞬间、生态系统的关联性',
      '商业广告': '【电影语法参考】关注：产品质感光、品牌色自然融入、生活方式氛围、欲望触发点',
      '音乐MV': '【电影语法参考】关注：节拍可视化、色彩情绪映射、舞蹈动态线、视觉节奏剪辑点',
      '家庭温情': '【电影语法参考】关注：自然光室内、人物互动微表情、日常仪式感、温暖色调',
      '浪漫爱情': '【电影语法参考】关注：眼神光、身体距离变化、环境情绪映射、时间流逝感',
      '艺术实验': '【电影语法参考】关注：抽象形态运动、色彩情绪、超现实空间、视觉隐喻',
      '社会现实': '【电影语法参考】关注：真实环境质感、自然光下的社会纹理、人物与环境的关系、长镜头中的时间流动'
    };
    return grammar[type] || '【电影语法参考】关注：视觉焦点引导、情绪光影、空间层次、动作张力';
  }

  _fallback(input) {
    const duration = input.duration_sec || 45;
    const sceneCount = Math.min(Math.max(Math.ceil(duration / 15), 2), 8);
    const perScene = Math.floor((duration - 6) / sceneCount); // 开场3s + 结尾3s

    const scenes = [];
    const beats = ['setup', 'rising', 'climax', 'falling', 'resolution'];
    
    for (let i = 0; i < sceneCount; i++) {
      scenes.push({
        index: i + 1,
        duration: perScene,
        purpose: `场景${i + 1}：推动叙事发展`,
        keyElements: ['核心动作', '情绪表达'],
        emotionalBeat: beats[i % beats.length]
      });
    }

    return {
      opening: {
        duration: 3,
        purpose: '建立场景氛围，引入主题',
        keyElements: ['环境展示', '主题暗示']
      },
      scenes,
      ending: {
        duration: 3,
        purpose: '总结收尾，留下印象',
        keyElements: ['情绪收束', '主题呼应']
      },
      totalDuration: duration,
      sceneCount: sceneCount,
      narrativeArc: 'linear'
    };
  }
}

class RiskAssessor extends BaseDiscoveryAgent {
  constructor(options) {
    super({ name: 'RiskAssessor', ...options });
  }

  _buildPrompt(input) {
    const { type, theme, visual_style, special_notes } = input;
    return `你是一位既懂 AI 视频生成模型能力边界、又懂影视制作的技术制片人。评估的核心问题是：这个故事里哪些画面是当前视频生成模型最容易翻车的？翻车了会不会毁掉全片？

视频类型: ${type}
核心主题: ${theme}
视觉风格: ${visual_style || '未指定'}
特殊要求: ${special_notes || '无'}

【评估心法】
1. 只评'致命级画面'：精细手部动作（系扣/咬绳/穿引）、大尺度木构透视、跨时空闪回的角色呼应、万人大场面——凡是模型弱项+故事泪点重叠的地方，才是 high。
2. 每条 mitigation 必须是可执行的镜头语言方案：'拆分为2-3个连续特写降低单镜头动作复杂度'、'用仰拍局部+声音设计暗示规模代替全景人群'——禁止'加强质量控制'类废话。
3. businessConstraints 必须包含：全球观众零背景知识可懂、无字幕依赖、无虚构特效元素（真实祭典/纪实类）。

请输出 JSON 格式：
{
  "technicalRisks": [
    {
      "risk": "风险描述",
      "level": "high|medium|low",
      "impact": "影响描述"
    }
  ],
  "businessConstraints": [
    "业务约束1",
    "业务约束2"
  ],
  "mitigationSuggestions": [
    "缓解建议1",
    "缓解建议2"
  ]
}

要求：
1. technicalRisks 1-5 个
2. businessConstraints 1-4 个
3. mitigationSuggestions 1-4 个
4. 风险 level 必须从枚举中选择`;
  }

  _fallback(input) {
    const typeToRisks = {
      '硬科幻': [
        { risk: '特效渲染复杂度高', level: 'high', impact: '可能需要更长的渲染时间' },
        { risk: '科学准确性要求', level: 'medium', impact: '需要专业顾问审核' }
      ],
      '赛博朋克': [
        { risk: '霓虹光效渲染', level: 'medium', impact: '需要精确的体积光模拟' }
      ],
      '武侠动作': [
        { risk: '动作流畅度', level: 'high', impact: '需要专业的动作设计' },
        { risk: '服装布料解算', level: 'medium', impact: '古风服装需要精细模拟' }
      ],
      '恐怖悬疑': [
        { risk: '氛围营造', level: 'medium', impact: '需要精确的光影和音效配合' }
      ],
      '自然纪录片': [
        { risk: '素材质量', level: 'medium', impact: '需要高质量的实拍素材或精细的3D建模' }
      ],
      '商业广告': [
        { risk: '产品展示精度', level: 'high', impact: '需要精确还原产品细节' }
      ],
      '音乐MV': [
        { risk: '音画同步', level: 'high', impact: '需要精确的时间轴控制' }
      ]
    };

    const defaultRisks = [
      { risk: 'AI生成质量不确定性', level: 'medium', impact: '可能需要多次迭代' },
      { risk: '时长控制', level: 'low', impact: '需要精确的镜头时长分配' }
    ];

    return {
      technicalRisks: typeToRisks[input.type] || defaultRisks,
      businessConstraints: ['目标时长限制', '平台画幅要求'],
      mitigationSuggestions: ['预留重试时间', '准备备选方案']
    };
  }
}

class ReferenceCurator extends BaseDiscoveryAgent {
  constructor(options) {
    super({ name: 'ReferenceCurator', ...options });
  }

  _buildPrompt(input) {
    const { type, theme, tone, visual_style } = input;
    return `你是一位泡在片库里的剪辑指导。推荐对标案例的唯一标准是：这部片子里有哪一个具体手法，可以直接搬进我们这条片子？

视频类型: ${type}
核心主题: ${theme}
情绪基调: ${tone || '未指定'}
视觉风格: ${visual_style || '未指定'}

【推荐心法】
1. filmReferences 的 keyTakeaway 必须写'手法'不写'主题'：坏例子'体现了匠人精神'；好例子'用手部特写与日常细节承载情感重量，全程无配乐煽情'。
2. 至少一部同文化语境的东方克制系参考（是枝裕和/小津/职人纪录片），至少一部不同语境但同情绪结构的参考（让观众知道这种感动是全球通用的）。
3. adReferences 选 60-90 秒内完成完整情感弧线的标杆（Apple新春短片级），takeaway 写'弧线结构'。
4. styleReferences 写可执行的视听策略：'冷暖色调区分闪回时空'、'声音先行：号子声承担叙事'。

请输出 JSON 格式：
{
  "filmReferences": [
    {
      "title": "影片名称（带《》）",
      "relevance": "high|medium|low",
      "keyTakeaway": "可借鉴要点"
    }
  ],
  "adReferences": [
    {
      "brand": "品牌名称",
      "relevance": "high|medium|low",
      "keyTakeaway": "可借鉴要点"
    }
  ],
  "styleReferences": [
    "风格参考1",
    "风格参考2"
  ]
}

要求：
1. filmReferences 2-4 个
2. adReferences 1-3 个
3. styleReferences 2-4 个
4. 影片名称必须带《》
5. 相关度必须从枚举中选择`;
  }

  _fallback(input) {
    const typeToFilms = {
      '硬科幻': [
        { title: '《星际穿越》', relevance: 'high', keyTakeaway: '科学叙事与视觉震撼的结合' },
        { title: '《2001太空漫游》', relevance: 'high', keyTakeaway: '极简美学与哲学深度' }
      ],
      '赛博朋克': [
        { title: '《银翼杀手2049》', relevance: 'high', keyTakeaway: '霓虹美学与雨夜氛围' },
        { title: '《攻壳机动队》', relevance: 'high', keyTakeaway: '赛博朋克视觉标杆' }
      ],
      '武侠动作': [
        { title: '《卧虎藏龙》', relevance: 'high', keyTakeaway: '武侠美学的国际表达' },
        { title: '《一代宗师》', relevance: 'high', keyTakeaway: '功夫与哲学的融合' }
      ],
      '恐怖悬疑': [
        { title: '《遗传厄运》', relevance: 'high', keyTakeaway: '心理恐怖的渐进营造' }
      ],
      '自然纪录片': [
        { title: '《蓝色星球》', relevance: 'high', keyTakeaway: '自然美学的极致呈现' }
      ],
      '商业广告': [
        { title: '《她》', relevance: 'medium', keyTakeaway: '科技美学的情感表达' }
      ],
      '音乐MV': [
        { title: '《爱乐之城》', relevance: 'high', keyTakeaway: '音乐与视觉的完美结合' }
      ],
      '家庭温情': [
        { title: '《海街日记》', relevance: 'high', keyTakeaway: '日常温情的细腻表达' }
      ],
      '浪漫爱情': [
        { title: '《爱》', relevance: 'high', keyTakeaway: '爱情叙事的克制表达' }
      ],
      '艺术实验': [
        { title: '《镜子》', relevance: 'high', keyTakeaway: '诗意影像的语言探索' }
      ]
    };

    const defaultFilms = [
      { title: '《星际穿越》', relevance: 'medium', keyTakeaway: '电影级质感参考' },
      { title: '《布达佩斯大饭店》', relevance: 'medium', keyTakeaway: '视觉风格参考' }
    ];

    return {
      filmReferences: typeToFilms[input.type] || defaultFilms,
      adReferences: [
        { brand: 'Apple', relevance: 'medium', keyTakeaway: '极简美学与产品展示' }
      ],
      styleReferences: ['电影级质感', '专业摄影']
    };
  }
}

// ===== 主引擎 =====

class RequirementDiscoveryEngine {
  constructor(options = {}) {
    this.llmEngine = options.llmEngine || null;
    this.timeoutMs = options.timeoutMs || 720000; // 【v2.1.8-fix】12 分钟总预算
    this.agentTimeoutMs = options.agentTimeoutMs || 180000; // 【v2.1.8-fix】180 秒/Agent
    
    // 初始化 4 个 Agent
    this.agents = {
      audience: new AudienceProfiler({ 
        llmEngine: this.llmEngine, 
        timeoutMs: this.agentTimeoutMs  // 【v2.1.8-fix】180秒/Agent
      }),
      scene: new SceneArchitect({ 
        llmEngine: this.llmEngine, 
        timeoutMs: this.agentTimeoutMs  // 【v2.1.8-fix】180秒/Agent
      }),
      risk: new RiskAssessor({ 
        llmEngine: this.llmEngine, 
        timeoutMs: this.agentTimeoutMs  // 【v2.1.8-fix】180秒/Agent
      }),
      reference: new ReferenceCurator({ 
        llmEngine: this.llmEngine, 
        timeoutMs: this.agentTimeoutMs  // 【v2.1.8-fix】180秒/Agent
      })
    };

    this.startTime = null;
  }

  /**
   * 主入口：基于上游 12 字段生成业务需求对齐清单
   * @param {Object} upstreamFields - CreativeThemeGenerator 输出的 12 字段
   * @returns {Object} 结构化需求对齐清单
   */
  async discover(upstreamFields) {
    console.log('\n🔍 [RequirementDiscoveryEngine] 开始需求洞察...');
    this.startTime = Date.now();

    // 检查总预算
    const budgetCheck = this._checkBudget(0, '启动');
    if (!budgetCheck.ok) {
      console.warn(`   ⚠️ 预算不足，使用极速模式（规则推断）`);
      return this._fastMode(upstreamFields);
    }

    const results = {
      upstreamFields: this._sanitizeUpstreamFields(upstreamFields),
      audienceProfile: null,
      sceneStructure: null,
      riskAssessment: null,
      referenceCases: null,
      confirmationStatus: {
        status: 'pending',
        timestamp: new Date().toISOString()
      }
    };

    // Agent 1: AudienceProfiler
    if (this._checkBudget(this.agentTimeoutMs, 'AudienceProfiler')) {
      try {
        results.audienceProfile = await this.agents.audience.run(upstreamFields, AudienceProfileSchema);
      } catch (e) {
        console.warn(`   [AudienceProfiler] 失败: ${e.message}`);
        results.audienceProfile = this.agents.audience._fallback(upstreamFields);
      }
    } else {
      results.audienceProfile = this.agents.audience._fallback(upstreamFields);
    }

    // Agent 2: SceneArchitect
    if (this._checkBudget(this.agentTimeoutMs, 'SceneArchitect')) {
      try {
        results.sceneStructure = await this.agents.scene.run(upstreamFields, SceneStructureSchema);
      } catch (e) {
        console.warn(`   [SceneArchitect] 失败: ${e.message}`);
        results.sceneStructure = this.agents.scene._fallback(upstreamFields);
      }
    } else {
      results.sceneStructure = this.agents.scene._fallback(upstreamFields);
    }

    // Agent 3: RiskAssessor
    if (this._checkBudget(this.agentTimeoutMs, 'RiskAssessor')) {
      try {
        results.riskAssessment = await this.agents.risk.run(upstreamFields, RiskAssessmentSchema);
      } catch (e) {
        console.warn(`   [RiskAssessor] 失败: ${e.message}`);
        results.riskAssessment = this.agents.risk._fallback(upstreamFields);
      }
    } else {
      results.riskAssessment = this.agents.risk._fallback(upstreamFields);
    }

    // Agent 4: ReferenceCurator
    if (this._checkBudget(this.agentTimeoutMs, 'ReferenceCurator')) {
      try {
        results.referenceCases = await this.agents.reference.run(upstreamFields, ReferenceCasesSchema);
      } catch (e) {
        console.warn(`   [ReferenceCurator] 失败: ${e.message}`);
        results.referenceCases = this.agents.reference._fallback(upstreamFields);
      }
    } else {
      results.referenceCases = this.agents.reference._fallback(upstreamFields);
    }

    const totalTime = Date.now() - this.startTime;
    console.log(`   ✅ 需求洞察完成 (${totalTime}ms)`);
    console.log(`      受众: ${results.audienceProfile.primaryAudience.ageRange} | 场景: ${results.sceneStructure.sceneCount}个 | 风险: ${results.riskAssessment.technicalRisks.length}个 | 参考: ${results.referenceCases.filmReferences.length}个`);

    return results;
  }

  /**
   * 极速模式：全部使用规则推断，不调用 LLM
   */
  _fastMode(upstreamFields) {
    console.log('   [极速模式] 使用规则推断...');
    return {
      upstreamFields: this._sanitizeUpstreamFields(upstreamFields),
      audienceProfile: this.agents.audience._fallback(upstreamFields),
      sceneStructure: this.agents.scene._fallback(upstreamFields),
      riskAssessment: this.agents.risk._fallback(upstreamFields),
      referenceCases: this.agents.reference._fallback(upstreamFields),
      confirmationStatus: {
        status: 'pending',
        timestamp: new Date().toISOString()
      }
    };
  }

  /**
   * 检查预算
   */
  _checkBudget(needMs, label) {
    if (!this.startTime) return { ok: true };
    const elapsed = Date.now() - this.startTime;
    const remaining = this.timeoutMs - elapsed;
    
    if (remaining < needMs) {
      console.log(`   [Budget] ⚠️ 预算不足(剩${remaining}ms)，跳过 ${label}`);
      return { ok: false, remaining };
    }
    return { ok: true, remaining };
  }

  /**
   * 清理上游字段（只保留必要字段）
   */
  _sanitizeUpstreamFields(fields) {
    const allowed = [
      'type', 'theme', 'duration_sec', 'tone', 'visual_style',
      'dialogue_requirement', 'special_notes', 'target_audience',
      'creative_style', 'difficulty', 'description',
      // 【方案A-fix】原始故事文本透传
      '_originalStoryText', 'original_story_text'
    ];
    
    const sanitized = {};
    for (const key of allowed) {
      if (fields[key] !== undefined) {
        sanitized[key] = fields[key];
      }
    }
    return sanitized;
  }

  /**
   * 生成 Markdown 供人工确认
   */
  generateMarkdown(discoveryResult) {
    const { upstreamFields, audienceProfile, sceneStructure, riskAssessment, referenceCases } = discoveryResult;
    
    // 【方案A-fix】原始故事文本加入需求洞察确认单
    const originalStory = upstreamFields._originalStoryText || upstreamFields.original_story_text || '';
    const storySection = originalStory ? `

## 📖 原始故事文本（完整版）

> 以下内容是所有需求分析的核心依据，请核对 LLM 是否正确理解了故事的关键细节：

${originalStory}

---
` : '';
    
    return `# 业务需求对齐清单

> 系统: 超级小香宝 v2.1.8
> 生成时间: ${new Date().toISOString()}
${storySection}
---

## 一、上游已确认内容

| 字段 | 值 |
|------|-----|
| 视频类型 | ${upstreamFields.type || '未指定'} |
| 核心主题 | ${upstreamFields.theme || '未指定'} |
| 目标时长 | ${upstreamFields.duration_sec || '未指定'}秒 |
| 情绪基调 | ${upstreamFields.tone || '未指定'} |
| 视觉风格 | ${upstreamFields.visual_style || '未指定'} |
| 创意系数 | ${upstreamFields.creative_style || '未指定'} |

---

## 二、深度洞察

### 2.1 目标受众画像

**主要受众**
- 年龄段: ${audienceProfile.primaryAudience.ageRange}
- 性别: ${audienceProfile.primaryAudience.gender === 'all' ? '不限' : audienceProfile.primaryAudience.gender === 'male' ? '男性为主' : '女性为主'}
- 兴趣标签: ${audienceProfile.primaryAudience.interestTags.join('、')}
- 消费水平: ${audienceProfile.primaryAudience.consumptionLevel === 'high' ? '高' : audienceProfile.primaryAudience.consumptionLevel === 'medium' ? '中' : '低'}

**情绪触发点**
${audienceProfile.emotionTriggers.map((t, i) => `${i + 1}. ${t}`).join('\n')}

**内容期望**
${audienceProfile.contentExpectations.map((e, i) => `${i + 1}. ${e}`).join('\n')}

---

### 2.2 场景结构建议

**叙事弧线**: ${sceneStructure.narrativeArc || '线性'}
**总场景数**: ${sceneStructure.sceneCount}个
**总时长**: ${sceneStructure.totalDuration}秒

**开场** (${sceneStructure.opening.duration}秒)
- 目的: ${sceneStructure.opening.purpose}
- 关键元素: ${sceneStructure.opening.keyElements.join('、')}

**主体场景**
${sceneStructure.scenes.map(s => `
场景 ${s.index} (${s.duration}秒) [${s.emotionalBeat}]
- 目的: ${s.purpose}
- 关键元素: ${s.keyElements.join('、')}
`).join('\n')}

**结尾** (${sceneStructure.ending.duration}秒)
- 目的: ${sceneStructure.ending.purpose}
- 关键元素: ${sceneStructure.ending.keyElements.join('、')}

---

### 2.3 技术难点预判

${riskAssessment.technicalRisks.map(r => `- **${r.risk}** [${r.level === 'high' ? '高风险' : r.level === 'medium' ? '中风险' : '低风险'}]: ${r.impact}`).join('\n')}

**缓解建议**
${riskAssessment.mitigationSuggestions.map((s, i) => `${i + 1}. ${s}`).join('\n')}

---

### 2.4 对标参考

**参考影片**
${referenceCases.filmReferences.map(f => `- ${f.title} [${f.relevance === 'high' ? '高度相关' : f.relevance === 'medium' ? '中度相关' : '参考'}]: ${f.keyTakeaway}`).join('\n')}

**风格参考**
${referenceCases.styleReferences.map((s, i) => `${i + 1}. ${s}`).join('\n')}

---

## 三、最终业务需求确认

□ 以上清单确认无误，进入 PRD 环节  
□ 需要修改：[请直接填写修改意见，如"场景2不要"或"时长改60s"]

**请回复：确认 / 修改：xxx / 重新生成**
`;
  }
}

module.exports = { RequirementDiscoveryEngine };
