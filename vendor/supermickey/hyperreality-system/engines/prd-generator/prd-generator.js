const { ProductDefinitionAgent } = require('./agents/agent-1-product-definition');
const { CreativeDirectionAgent } = require('./agents/agent-2-creative-direction');
const { ProductionSpecificationAgent } = require('./agents/agent-3-production-specification');
const { ConstraintSynthesisAgent } = require('./agents/agent-4-constraint-synthesis');
const { DeliveryStandardAgent } = require('./agents/agent-5-delivery-standard');
const { PRDSchema, ENUM_DEFAULTS } = require('./schema/prd-schema-v3');
const { validateCostQualityAlignment } = require('./validators/cost-quality-alignment');
const { generateSummary } = require('./utils/prd-summary');

/**
 * PRDGenerator v3.0
 * 产品需求文档生成器
 * 5 个 Agent 串行协作，输出结构化的产品制作需求
 */
class PRDGenerator {
  constructor(options = {}) {
    this.options = options;
    
    // Agent 初始化（带正确超时配置）
    this.agent1 = new ProductDefinitionAgent(options);
    this.agent2 = new CreativeDirectionAgent({ ...options, timeoutMs: options.agent2TimeoutMs || 120000 });
    this.agent3 = new ProductionSpecificationAgent({ ...options, timeoutMs: options.agent3TimeoutMs || 180000 });
    this.agent4 = new ConstraintSynthesisAgent(options);
    this.agent5 = new DeliveryStandardAgent(options);
    
    // 超时配置
    this.timeoutMs = options.timeoutMs || 600000; // 10 分钟总预算
    this.agent2TimeoutMs = options.agent2TimeoutMs || 120000; // 2 分钟
    this.agent3TimeoutMs = options.agent3TimeoutMs || 300000; // 5 分钟
  }

  /**
   * 主入口：生成 PRD
   * @param {object} discoveryResult - RequirementDiscoveryEngine 确认结果
   * @returns {object} 完整 PRD + 摘要
   */
  async generate(discoveryResult) {
    const startTime = Date.now();
    console.log(`[PRDGenerator] 🚀 开始生成 PRD...`);
    
    try {
      // Step 1: ProductDefinitionAgent（规则引擎，< 100ms）
      console.log(`[PRDGenerator] Step 1/5: 产品定义...`);
      const productResult = this.agent1.process(discoveryResult);
      
      // Step 2: CreativeDirectionAgent（LLM，30-60s）
      console.log(`[PRDGenerator] Step 2/5: 创意方向（LLM）...`);
      let creativeResult;
      try {
        creativeResult = await this._runWithTimeout(
          () => this.agent2.process(discoveryResult),
          this.agent2TimeoutMs,
          'Agent 2'
        );
      } catch (error) {
        console.warn(`[PRDGenerator] Agent 2 超时/失败: ${error.message}，使用 fallback`);
        creativeResult = this.agent2.fallback(discoveryResult);
      }
      
      // Step 3: ProductionSpecificationAgent（LLM，60-90s）
      console.log(`[PRDGenerator] Step 3/5: 制作规格（LLM）...`);
      let productionResult;
      try {
        productionResult = await this._runWithTimeout(
          () => this.agent3.process(discoveryResult, creativeResult),
          this.agent3TimeoutMs,
          'Agent 3'
        );
      } catch (error) {
        console.warn(`[PRDGenerator] Agent 3 超时/失败: ${error.message}，使用 fallback`);
        productionResult = this.agent3.fallback(discoveryResult, creativeResult);
      }
      
      // Step 4: ConstraintSynthesisAgent（规则引擎，< 100ms）
      console.log(`[PRDGenerator] Step 4/5: 约束合成...`);
      const constraintResult = this.agent4.process(
        discoveryResult,
        productResult,
        creativeResult,
        productionResult
      );
      
      // Step 5: DeliveryStandardAgent（规则引擎，< 100ms）
      console.log(`[PRDGenerator] Step 5/5: 交付标准...`);
      const deliveryResult = this.agent5.process(
        productResult,
        creativeResult,
        productionResult,
        constraintResult
      );
      
      // 合并所有 Agent 输出
      const prd = {
        ...productResult,
        ...creativeResult,
        ...productionResult,
        ...constraintResult,
        ...deliveryResult
      };
      
      // ⭐ v2.2.1-fix: 透传用户原始故事文本到 PRD，供下游消费
      const originalStory = discoveryResult.upstreamFields?._originalStoryText 
        || discoveryResult.upstreamFields?.original_story_text
        || discoveryResult._originalStoryText
        || discoveryResult.original_story_text
        || '';
      if (originalStory) {
        prd._originalStoryText = originalStory;
      }
      
      // 结构校验 + fallback 填充
      console.log(`[PRDGenerator] 🔍 结构校验...`);
      const validated = this._validateAndFill(prd);
      
      // 生成 PRD 摘要
      validated.prdSummary = generateSummary(validated);
      
      const elapsed = Date.now() - startTime;
      console.log(`[PRDGenerator] ✅ PRD 生成完成，耗时 ${elapsed}ms`);
      
      return validated;
    } catch (error) {
      console.error(`[PRDGenerator] ❌ 生成失败: ${error.message}`);
      throw error;
    }
  }

  /**
   * 带超时的 Agent 执行
   */
  async _runWithTimeout(fn, timeoutMs, agentName) {
    return Promise.race([
      fn(),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error(`${agentName} 超时 (${timeoutMs}ms)`)), timeoutMs)
      )
    ]);
  }

  /**
   * 结构校验 + 缺失字段 fallback 填充
   */
  _validateAndFill(prd) {
    const validated = JSON.parse(JSON.stringify(prd)); // 深拷贝
    
    // 校验每个 required 模块
    const requiredModules = PRDSchema.required;
    for (const module of requiredModules) {
      if (!validated[module]) {
        console.warn(`[PRDGenerator] 缺失模块: ${module}，使用 fallback 填充`);
        validated[module] = this._generateFallbackModule(module, validated);
      }
    }
    
    // 校验每个模块内的 required 字段
    this._fillMissingFields(validated, PRDSchema.properties);
    
    return validated;
  }

  _fillMissingFields(obj, schema, path = '') {
    if (!schema || !obj) return;
    
    if (schema.type === 'object' && schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        const currentPath = path ? `${path}.${key}` : key;
        
        if (schema.required?.includes(key) && obj[key] === undefined) {
          console.warn(`[PRDGenerator] 缺失字段: ${currentPath}，使用 fallback`);
          obj[key] = this._generateFallbackValue(propSchema, currentPath);
        }
        
        if (obj[key] !== undefined && obj[key] !== null) {
          this._fillMissingFields(obj[key], propSchema, currentPath);
        }
      }
    } else if (schema.type === 'array' && Array.isArray(obj) && schema.items) {
      obj.forEach((item, i) => {
        this._fillMissingFields(item, schema.items, `${path}[${i}]`);
      });
    }
  }

  _generateFallbackValue(schema, path) {
    if (schema.enum) {
      return schema.enum[0];
    }
    
    if (schema.type === 'string') {
      const defaults = {
        'projectDefinition.projectName': '未命名项目',
        'projectDefinition.sourceIntent': '未指定',
        'creativeCore.coreTheme': '待补充核心主题',
        'creativeCore.creativeHook': '待补充创意钩子',
        'visualSpecification.lightingDirection': '自然光为主',
        'visualSpecification.cameraLanguage': '稳定运镜',
        'audioSpecification.musicStyle': '环境音乐',
        'audioSpecification.soundDesign': '环境音效',
        'audioSpecification.audioMood': '中性氛围',
        'characterSystem.characters[].name': '未命名角色',
        'characterSystem.characters[].appearance': '未指定外貌',
        'characterSystem.characters[].personality': '未指定性格',
        'characterSystem.characters[].costume': '日常服装',
        'characterSystem.characters[].consistencyRequirements': '保持跨镜头一致性',
        'scenePlan.scenes[].purpose': '推进叙事',
        'scenePlan.scenes[].setting': '未指定场景',
        'scenePlan.scenes[].dialogue': '',
        'productionConstraints.technicalConstraints[]': '保持视觉一致性',
        'productionConstraints.businessConstraints[]': '符合平台规范',
        'productionConstraints.forbiddenElements[]': '低质量',
        'deliveryStandard.fallbackPlan.trigger': '质量低于阈值',
        'deliveryStandard.fallbackPlan.action': '降低复杂度',
        'deliveryStandard.fallbackPlan.expectedOutput': '保证可交付'
      };
      
      // 匹配路径模式
      for (const [pattern, value] of Object.entries(defaults)) {
        const regex = new RegExp(pattern.replace('[]', '\\[\\d+\\]').replace('.*', '\\.\\w+'));
        if (regex.test(path)) {
          return value;
        }
      }
      
      return '未指定';
    }
    
    if (schema.type === 'number') {
      return schema.minimum || 0;
    }
    
    if (schema.type === 'array') {
      return [];
    }
    
    if (schema.type === 'object') {
      return {};
    }
    
    return null;
  }

  _generateFallbackModule(module, prd) {
    const fallbacks = {
      projectDefinition: {
        projectId: 'fallback_' + Date.now(),
        projectName: prd.projectDefinition?.projectName || '未命名项目',
        version: '1.0.0',
        createdAt: new Date().toISOString(),
        sourceIntent: 'fallback'
      },
      productPositioning: {
        productType: '剧情短片',
        genre: '通用',
        targetPlatform: '通用',
        targetDuration: 52,
        aspectRatio: '16:9',
        resolution: '1080p',
        frameRate: 24
      },
      creativeCore: {
        coreTheme: '待补充核心主题',
        creativeHook: '待补充创意钩子',
        emotionalArc: 'setup→rising→climax→falling→resolution',
        keyMessages: ['P0: 核心信息'],
        twistPoint: '',
        endingType: '闭合式'
      },
      visualSpecification: {
        primaryStyle: '电影级写实',
        colorPalette: { dominant: '自然色调', accent: '暖色', mood: '中性' },
        lightingDirection: '自然光为主',
        cameraLanguage: '稳定运镜',
        visualReferences: ['通用参考'],
        textureQuality: '写实',
        specialVisualEffects: []
      },
      audioSpecification: {
        musicStyle: '环境音乐',
        soundDesign: '环境音效',
        voicePolicy: '环境音为主',
        audioMood: '中性氛围',
        audioReferences: []
      },
      characterSystem: {
        characters: []
      },
      scenePlan: {
        scenes: [],
        shotMapping: []
      },
      productionConstraints: {
        technicalConstraints: ['保持视觉一致性'],
        businessConstraints: ['符合平台规范'],
        forbiddenElements: ['低质量'],
        qualityThresholds: { visual: 0.75, audio: 0.70, narrative: 0.75, consistency: 0.70 },
        modelCapabilityBounds: {
          maxPromptComplexity: 'moderate',
          supportedEffects: ['基础调色'],
          consistencyStrategy: 'textual-description'
        }
      },
      audienceProfile: {
        primaryAudience: { ageRange: '25-30', gender: 'all', interests: ['通用'], consumptionLevel: 'medium' },
        emotionTriggers: ['好奇心'],
        contentExpectations: ['高质量内容']
      },
      referenceCases: {
        filmReferences: ['通用参考'],
        adReferences: [],
        styleReferences: ['通用风格']
      },
      deliveryStandard: {
        deliverables: [{ item: 'video_master', spec: 'MP4/H.264, 1080p', priority: 'required' }],
        acceptanceCriteria: { visual: 0.75, audio: 0.70, narrative: 0.75, consistency: 0.70 },
        outputFormat: { videoCodec: 'H.264', audioCodec: 'AAC', container: 'MP4' },
        revisionPolicy: { maxRevisions: 1, revisionScope: ['visual'] },
        fallbackPlan: { trigger: '质量低于阈值', action: '降低复杂度', expectedOutput: '保证可交付' },
        continuityCheckpoints: [{ checkpoint: 'scene-logic', validationMethod: '场景逻辑检查' }]
      },
      budgetProfile: null
    };
    
    return fallbacks[module] || {};
  }

  /**
   * 生成 Markdown 格式的 PRD 文档（供用户确认）
   */
  generateMarkdown(prd) {
    const summary = prd.prdSummary || generateSummary(prd);
    
    // ⭐ v2.2.1-fix: PRD 文档携带用户原始输入，供下游剧本/提示词生成参考
    const originalStory = prd.projectDefinition?._originalStoryText 
      || prd.projectDefinition?.original_story_text
      || prd._originalStoryText
      || prd.original_story_text
      || '';
    const originalStorySection = originalStory
      ? `\n\n---\n\n## 📖 用户原始输入（创作素材源）\n\n> 以下原始素材是用户提供的故事蓝本，剧本生成和提示词设计必须以此为核心依据：\n\n${originalStory}\n`
      : '';
    
    return `# 产品需求文档（PRD）

> 项目：${prd.projectDefinition?.projectName || '未命名'} | 版本：${prd.projectDefinition?.version || '1.0.0'}

---

## 摘要

| 项目 | 内容 |
|------|------|
| 类型 | ${prd.productPositioning?.productType || '未指定'} / ${prd.productPositioning?.genre || '未指定'} |
| 时长 | ${prd.productPositioning?.targetDuration || 52} 秒 |
| 平台 | ${prd.productPositioning?.targetPlatform || '未指定'} |
| 场景 | ${prd.scenePlan?.scenes?.length || 0} 场景 / ${prd.scenePlan?.shotMapping?.reduce((s, m) => s + (m.estimatedShots || 0), 0) || 0} 预估镜头 |
| 角色 | ${prd.characterSystem?.characters?.map(c => c.name).join(', ') || '无'} |

**核心钩子**：${prd.creativeCore?.creativeHook || '未指定'}${originalStorySection}

---

## 1. 项目定义

- **项目名称**：${prd.projectDefinition?.projectName || '未命名'}
- **项目 ID**：${prd.projectDefinition?.projectId || '未指定'}
- **版本**：${prd.projectDefinition?.version || '1.0.0'}
- **创建时间**：${prd.projectDefinition?.createdAt || '未指定'}

## 2. 产品定位

- **视频类型**：${prd.productPositioning?.productType || '未指定'}
- **类型细分**：${prd.productPositioning?.genre || '未指定'}
- **目标平台**：${prd.productPositioning?.targetPlatform || '未指定'}
- **目标时长**：${prd.productPositioning?.targetDuration || 52} 秒
- **画幅**：${prd.productPositioning?.aspectRatio || '16:9'}
- **分辨率**：${prd.productPositioning?.resolution || '1080p'}
- **帧率**：${prd.productPositioning?.frameRate || 24}fps

## 3. 创意核心

- **核心主题**：${prd.creativeCore?.coreTheme || '未指定'}
- **创意钩子**：${prd.creativeCore?.creativeHook || '未指定'}
- **情绪弧线**：${prd.creativeCore?.emotionalArc || '未指定'}
- **关键信息**：${(prd.creativeCore?.keyMessages || []).map(m => `- ${m}`).join('\n') || '未指定'}
- **反转/高潮**：${prd.creativeCore?.twistPoint || '无'}
- **结尾类型**：${prd.creativeCore?.endingType || '未指定'}

## 4. 视觉规格

- **主要风格**：${prd.visualSpecification?.primaryStyle || '未指定'}
- **色彩**：主色调 ${prd.visualSpecification?.colorPalette?.dominant || '未指定'}，强调色 ${prd.visualSpecification?.colorPalette?.accent || '未指定'}，情绪 ${prd.visualSpecification?.colorPalette?.mood || '未指定'}
- **光照**：${prd.visualSpecification?.lightingDirection || '未指定'}
- **镜头语言**：${prd.visualSpecification?.cameraLanguage || '未指定'}
- **纹理质量**：${prd.visualSpecification?.textureQuality || '未指定'}
- **参考**：${(prd.visualSpecification?.visualReferences || []).join(', ') || '未指定'}
- **特效**：${(prd.visualSpecification?.specialVisualEffects || []).join(', ') || '无'}

## 5. 音频规格

- **音乐风格**：${prd.audioSpecification?.musicStyle || '未指定'}
- **音效设计**：${prd.audioSpecification?.soundDesign || '未指定'}
- **配音策略**：${prd.audioSpecification?.voicePolicy || '未指定'}
- **音频情绪**：${prd.audioSpecification?.audioMood || '未指定'}
- **参考**：${(prd.audioSpecification?.audioReferences || []).join(', ') || '无'}

## 6. 角色系统

${(prd.characterSystem?.characters || []).map(c => `
### ${c.name} (${c.role})

- **年龄段**：${c.ageRange}
- **外貌**：${c.appearance}
- **性格**：${c.personality}
- **服装**：${c.costume}
- **一致性要求**：${c.consistencyRequirements}
`).join('\n') || '无角色'}

## 7. 场景规划

${(prd.scenePlan?.scenes || []).map((s, i) => `
### ${s.sceneId}（第 ${s.sequence} 场，${s.duration} 秒）

- **目的**：${s.purpose}
- **情绪节点**：${s.emotionalBeat}
- **设定**：${s.setting}
- **时间**：${s.timeOfDay}
- **道具**：${(s.keyProps || []).join(', ') || '无'}
- **视觉要求**：${(s.visualRequirements || []).join(', ') || '无'}
- **音频要求**：${(s.audioRequirements || []).join(', ') || '无'}
- **台词**：${s.dialogue || '无'}
- **预估镜头**：${prd.scenePlan?.shotMapping?.[i]?.estimatedShots || 3} 个（${(prd.scenePlan?.shotMapping?.[i]?.shotBreakdownHint || []).join(' → ') || '未指定'}）
`).join('\n') || '无场景'}

## 8. 制作约束

- **技术约束**：${(prd.productionConstraints?.technicalConstraints || []).map(c => `- ${c}`).join('\n') || '无'}
- **业务约束**：${(prd.productionConstraints?.businessConstraints || []).map(c => `- ${c}`).join('\n') || '无'}
- **禁止元素**：${(prd.productionConstraints?.forbiddenElements || []).map(c => `- ${c}`).join('\n') || '无'}
- **质量阈值**：视觉 ${prd.productionConstraints?.qualityThresholds?.visual || 0.75} / 音频 ${prd.productionConstraints?.qualityThresholds?.audio || 0.70} / 叙事 ${prd.productionConstraints?.qualityThresholds?.narrative || 0.75} / 一致性 ${prd.productionConstraints?.qualityThresholds?.consistency || 0.70}
- **模型能力**：复杂度 ${prd.productionConstraints?.modelCapabilityBounds?.maxPromptComplexity || 'moderate'}，策略 ${prd.productionConstraints?.modelCapabilityBounds?.consistencyStrategy || 'textual-description'}

## 9. 受众定位

- **主要受众**：${prd.audienceProfile?.primaryAudience?.ageRange || '未指定'} 岁，${prd.audienceProfile?.primaryAudience?.gender || 'all'}
- **兴趣标签**：${(prd.audienceProfile?.primaryAudience?.interests || []).join(', ') || '未指定'}
- **消费能力**：${prd.audienceProfile?.primaryAudience?.consumptionLevel || 'medium'}
- **情绪触发**：${(prd.audienceProfile?.emotionTriggers || []).join(', ') || '未指定'}
- **内容期望**：${(prd.audienceProfile?.contentExpectations || []).join(', ') || '未指定'}

## 10. 参考案例

- **影片**：${(prd.referenceCases?.filmReferences || []).join(', ') || '未指定'}
- **广告**：${(prd.referenceCases?.adReferences || []).join(', ') || '无'}
- **风格**：${(prd.referenceCases?.styleReferences || []).join(', ') || '未指定'}

## 11. 交付标准

### 交付物
${(prd.deliveryStandard?.deliverables || []).map(d => `- [${d.priority === 'required' ? '必' : '选'}] **${d.item}**：${d.spec}`).join('\n') || '无'}

### 验收标准
- 视觉质量：${prd.deliveryStandard?.acceptanceCriteria?.visual || 0.75}
- 音频质量：${prd.deliveryStandard?.acceptanceCriteria?.audio || 0.70}
- 叙事质量：${prd.deliveryStandard?.acceptanceCriteria?.narrative || 0.75}
- 一致性：${prd.deliveryStandard?.acceptanceCriteria?.consistency || 0.70}

### 输出格式
- 视频编码：${prd.deliveryStandard?.outputFormat?.videoCodec || 'H.264'}
- 音频编码：${prd.deliveryStandard?.outputFormat?.audioCodec || 'AAC'}
- 容器：${prd.deliveryStandard?.outputFormat?.container || 'MP4'}

### 降级预案
- **触发**：${prd.deliveryStandard?.fallbackPlan?.trigger || '未指定'}
- **动作**：${prd.deliveryStandard?.fallbackPlan?.action || '未指定'}
- **预期产出**：${prd.deliveryStandard?.fallbackPlan?.expectedOutput || '未指定'}

---

**请回复：确认 / 修改：xxx / 重新生成**

> PRD 生成耗时：${summary.generationTimeMs || '未记录'}ms
`;
  }
}

module.exports = { PRDGenerator };
