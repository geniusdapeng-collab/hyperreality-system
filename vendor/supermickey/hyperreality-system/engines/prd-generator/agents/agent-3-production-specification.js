const { BaseAgent } = require('../../production-engine/agents/base-agent');

/**
 * Agent 3: ProductionSpecificationAgent
 * 制作规格 Agent - 核心 LLM Agent
 * 职责：生成视觉、音频、角色、场景的制作规格
 * 耗时：60-90s
 */
class ProductionSpecificationAgent extends BaseAgent {
  constructor(options = {}) {
    super(options);
    this.agentName = 'ProductionSpecificationAgent';
    this.timeoutMs = options.timeoutMs || 180000; // 3 分钟
  }

  async process(discoveryResult, creativeResult) {
    // 保存 discoveryResult 供 _parseResult 使用
    this._lastDiscoveryResult = discoveryResult;
    const prompt = this._buildPrompt(discoveryResult, creativeResult);
    
    try {
      // 【审计修复】同 Agent-2：修正 schema 错位、timeout 下发、包装解包三处问题
      const schema = {
        required: ['visualSpecification', 'audioSpecification']
      };
      const llmResult = await this._callLLM(prompt, schema, null, { timeoutMs: this.timeoutMs });
      const data = (llmResult && typeof llmResult === 'object' && 'result' in llmResult)
        ? llmResult.result : llmResult;
      if (data === null || data === undefined) {
        console.warn(`[${this.agentName}] LLM 返回为空，使用 fallback`);
        return this.fallback(discoveryResult, creativeResult);
      }
      return this._parseResult(typeof data === 'string' ? data : JSON.stringify(data), discoveryResult);
    } catch (error) {
      console.warn(`[${this.agentName}] LLM 调用失败: ${error.message}，使用 fallback`);
      return this.fallback(discoveryResult, creativeResult);
    }
  }

  _buildPrompt(discoveryResult, creativeResult) {
    const { upstreamFields, audienceProfile, sceneStructure, referenceCases, userModifications } = discoveryResult;
    const creativeCore = creativeResult?.creativeCore || {};
    
    const userModificationsSection = (userModifications && userModifications.length > 0)
      ? `\n【用户修改意见】\n${userModifications.map((m, i) => `${i + 1}. ${m}`).join('\n')}\n\n以上修改意见必须体现在制作规格中（视觉风格、角色设计、场景规划等方面）。`
      : '';
    
    // ⭐ v2.2.1-fix: 注入用户原始故事文本，制作规格需贴合原始素材
    const originalStory = discoveryResult._originalStoryText || discoveryResult.original_story_text || '';
    const originalStorySection = originalStory
      ? `\n【用户原始输入（制作依据）】\n${originalStory}\n\n以上原始素材是用户提供的完整故事，制作规格中的角色设计、场景规划、台词要求必须与原始素材保持一致。`
      : '';
    
    return `你是一位资深视频制作总监，正在制定详细的制作规格。

【产品定义】
视频类型: ${upstreamFields.type || '通用'}
类型细分: ${upstreamFields.type || '通用'}
目标时长: ${upstreamFields.duration_sec || sceneStructure?.totalDuration || '52'}秒

【创意核心】
核心主题: ${creativeCore.coreTheme || '未指定'}
创意钩子: ${creativeCore.creativeHook || '未指定'}
情绪弧线: ${creativeCore.emotionalArc || 'setup→rising→climax→falling→resolution'}

【视觉要求】
视觉风格: ${upstreamFields.visual_style || '未指定'}
特殊要求: ${upstreamFields.special_notes || '无'}

【参考案例】
参考影片: ${(referenceCases?.filmReferences || []).map(f => f.title || f).join(', ')}
风格参考: ${(referenceCases?.styleReferences || []).join(', ')}

【场景结构】
场景数: ${sceneStructure?.sceneCount || '3'}
场景详情: ${(sceneStructure?.scenes || []).map((s, i) => `场景${i+1}: ${s.duration || '10'}秒, ${s.purpose || '未指定'}`).join('; ')}

请输出 JSON 格式的制作规格（不要添加任何解释文本，只输出 JSON）：

{
  "visualSpecification": {
    "primaryStyle": "电影级写实|纪录片风格|广告级商业|艺术实验|赛博朋克|极简主义|复古风格|动漫风格",
    "colorPalette": { "dominant": "主色调", "accent": "强调色", "mood": "色彩情绪" },
    "lightingDirection": "光照描述（10-100字）",
    "cameraLanguage": "镜头语言描述（10-100字）",
    "visualReferences": ["《影片名》", "导演名"],
    "textureQuality": "超写实8K|写实|风格化|卡通|油画|像素",
    "specialVisualEffects": ["特效1", "特效2"]
  },
  "audioSpecification": {
    "musicStyle": "音乐风格（10-50字）",
    "soundDesign": "音效设计方向（10-50字）",
    "voicePolicy": "无对白|纯旁白|纯对白|旁白+对白|字幕+音乐|环境音为主",
    "audioMood": "音频情绪描述（10-50字）",
    "audioReferences": ["参考音乐/音效1"]
  },
  "characterSystem": {
    "characters": [
      {
        "characterId": "char_001",
        "name": "角色名",
        "role": "主角|配角|反派|群演|旁白",
        "ageRange": "儿童|青少年|青年|中年|老年|不限",
        "appearance": "外貌描述（10-300字）",
        "personality": "性格特征（5-200字）",
        "costume": "服装要求（5-200字）",
        "portraitPath": "",
        "consistencyRequirements": "跨镜头一致性要求"
      }
    ]
  },
  "scenePlan": {
    "scenes": [
      {
        "sceneId": "SC01",
        "sequence": 1,
        "purpose": "场景目的（10-200字）",
        "duration": 10,
        "emotionalBeat": "setup|rising|climax|falling|resolution|twist",
        "setting": "场景设定",
        "timeOfDay": "清晨|上午|正午|下午|傍晚|夜晚|深夜|不限",
        "keyProps": ["道具1"],
        "visualRequirements": ["视觉要求1"],
        "audioRequirements": ["音频要求1"],
        "dialogue": "台词（可为空字符串）"
      }
    ],
    "shotMapping": [
      {
        "sceneId": "SC01",
        "estimatedShots": 3,
        "shotBreakdownHint": ["establishing", "medium", "close-up"]
      }
    ]
  }
}

严格要求：
1. 所有枚举字段必须从指定枚举中选择
2. 数组字段长度在限定范围内
3. 字符串字段长度在限定范围内
4. 所有 required 字段必须存在
5. 角色数量根据场景推断（通常1-3个），每个角色必须完整填写9个字段
6. 场景数量与场景结构一致（${sceneStructure?.sceneCount || '3'}个），每个场景必须完整填写11个字段
7. shotMapping 必须与 scenes 一一对应，每个场景预估1-6个镜头
8. shotBreakdownHint 从以下选择：establishing, wide, medium, close-up, extreme-close-up, POV, drone, tracking, static
9. 角色 portraitPath 留空字符串（系统后续填充），但需标注是否需要生成定妆照
10. 只输出 JSON，不要任何 markdown 代码块标记，不要解释文本${originalStorySection}${userModificationsSection}`;
  }

  _parseResult(result, discoveryResult) {
    try {
      // 如果 result 是对象，尝试转换为字符串
      if (typeof result !== 'string') {
        result = typeof result === 'object' ? JSON.stringify(result) : String(result);
      }
      
      let clean = result.trim();
      if (clean.startsWith('```json')) clean = clean.slice(7);
      if (clean.startsWith('```')) clean = clean.slice(3);
      if (clean.endsWith('```')) clean = clean.slice(0, -3);
      clean = clean.trim();
      
      const parsed = JSON.parse(clean);
      
      // 【修复】字段缺失自动补全，不再抛错误
      const upstreamFields = this._lastDiscoveryResult?.upstreamFields || {};
      const type = upstreamFields.type || '通用';
      const duration = upstreamFields.duration_sec || 52;
      const sceneCount = 3;
      
      // 补全 visualSpecification
      if (!parsed.visualSpecification) {
        parsed.visualSpecification = {
          overallStyle: upstreamFields.visual_style || `${type}风格`,
          colorPalette: ['主色调', '辅助色', '点缀色'],
          lightingStyle: '自然光',
          cameraStyle: '标准镜头',
          specialVisualEffects: []
        };
        console.warn(`[${this.agentName}] ⚠️ visualSpecification 缺失，自动补全`);
      }
      
      // 补全 audioSpecification
      if (!parsed.audioSpecification) {
        parsed.audioSpecification = {
          musicStyle: '氛围音乐',
          soundDesign: '环境音效',
          voiceRequirement: upstreamFields.dialogue_requirement || '无对白',
          audioFormat: '立体声'
        };
        console.warn(`[${this.agentName}] ⚠️ audioSpecification 缺失，自动补全`);
      }
      
      // 补全 characterSystem
      if (!parsed.characterSystem) {
        parsed.characterSystem = {
          characters: [{
            id: 'C01',
            name: '主角',
            type: '主要角色',
            description: `${upstreamFields.theme || '故事'}的主角`,
            personality: '未指定',
            appearance: '未指定',
            costume: '日常服装',
            consistencyRequirements: '保持外貌、服装、气质在各镜头中一致',
            portraitPath: '',
            needsPortrait: true
          }]
        };
        console.warn(`[${this.agentName}] ⚠️ characterSystem 缺失，自动补全`);
      }
      
      // 补全 scenePlan
      if (!parsed.scenePlan) {
        const scenes = [];
        const shotMapping = [];
        const emotionalBeats = ['setup', 'rising', 'climax', 'falling', 'resolution'];
        for (let i = 0; i < sceneCount; i++) {
          const sceneId = `SC${String(i + 1).padStart(2, '0')}`;
          const sceneDuration = Math.floor(duration / sceneCount);
          scenes.push({
            sceneId,
            sequence: i + 1,
            purpose: `场景${i + 1}: 推进${type}主题叙事`,
            duration: sceneDuration,
            emotionalBeat: emotionalBeats[i % emotionalBeats.length],
            setting: '未指定场景',
            timeOfDay: '不限',
            keyProps: [],
            visualRequirements: [`${type}风格视觉呈现`],
            audioRequirements: ['环境音匹配'],
            dialogue: ''
          });
          shotMapping.push({
            sceneId,
            estimatedShots: Math.min(3, Math.max(1, Math.floor(sceneDuration / 10))),
            shotBreakdownHint: ['establishing', 'medium', 'close-up']
          });
        }
        parsed.scenePlan = { scenes, shotMapping };
        console.warn(`[${this.agentName}] ⚠️ scenePlan 缺失，自动补全`);
      }
      
      // 确保角色有 portraitPath
      if (parsed.characterSystem.characters) {
        parsed.characterSystem.characters.forEach(c => {
          if (!c.portraitPath) c.portraitPath = '';
          if (!c.consistencyRequirements) c.consistencyRequirements = '保持外貌、服装、气质在各镜头中一致';
        });
      }
      
      // 确保 shotMapping 与 scenes 对应
      if (parsed.scenePlan.scenes && !parsed.scenePlan.shotMapping) {
        parsed.scenePlan.shotMapping = parsed.scenePlan.scenes.map(s => ({
          sceneId: s.sceneId,
          estimatedShots: Math.min(3, Math.max(1, Math.floor(s.duration / 10))),
          shotBreakdownHint: ['establishing', 'medium', 'close-up']
        }));
      }
      
      return {
        visualSpecification: parsed.visualSpecification,
        audioSpecification: parsed.audioSpecification,
        characterSystem: parsed.characterSystem,
        scenePlan: parsed.scenePlan
      };
    } catch (error) {
      console.error(`[${this.agentName}] 解析失败: ${error.message}`);
      throw error;
    }
  }

  fallback(discoveryResult, creativeResult) {
    const { upstreamFields, sceneStructure } = discoveryResult;
    const type = upstreamFields.type || '通用';
    const duration = upstreamFields.duration_sec || sceneStructure?.totalDuration || 52;
    const sceneCount = sceneStructure?.sceneCount || 3;
    
    // 生成默认场景
    const scenes = [];
    const shotMapping = [];
    for (let i = 0; i < sceneCount; i++) {
      const sceneId = `SC${String(i + 1).padStart(2, '0')}`;
      const sceneDuration = Math.floor(duration / sceneCount);
      const emotionalBeats = ['setup', 'rising', 'climax', 'falling', 'resolution'];
      
      scenes.push({
        sceneId,
        sequence: i + 1,
        purpose: `场景${i + 1}: 推进${type}主题叙事`,
        duration: sceneDuration,
        emotionalBeat: emotionalBeats[i % emotionalBeats.length],
        setting: '未指定场景',
        timeOfDay: '不限',
        keyProps: [],
        visualRequirements: [`${type}风格视觉呈现`],
        audioRequirements: ['环境音匹配'],
        dialogue: ''
      });
      
      shotMapping.push({
        sceneId,
        estimatedShots: Math.min(3, Math.max(1, Math.floor(sceneDuration / 10))),
        shotBreakdownHint: ['establishing', 'medium', 'close-up']
      });
    }
    
    return {
      visualSpecification: {
        primaryStyle: '电影级写实',
        colorPalette: { dominant: '自然色调', accent: '暖色点缀', mood: '中性' },
        lightingDirection: '自然光为主，侧光突出主体',
        cameraLanguage: '稳定运镜，适当运动增加动态感',
        visualReferences: [type],
        textureQuality: '写实',
        specialVisualEffects: []
      },
      audioSpecification: {
        musicStyle: '环境音乐，配合情绪节奏',
        soundDesign: '环境音效为主，突出场景氛围',
        voicePolicy: '环境音为主',
        audioMood: '中性氛围',
        audioReferences: []
      },
      characterSystem: {
        characters: [{
          characterId: 'char_001',
          name: '主角',
          role: '主角',
          ageRange: '青年',
          appearance: '未指定外貌',
          personality: '未指定性格',
          costume: '日常服装',
          portraitPath: '',
          consistencyRequirements: '保持外貌、服装、气质在各镜头中一致'
        }]
      },
      scenePlan: {
        scenes,
        shotMapping
      }
    };
  }
}

module.exports = { ProductionSpecificationAgent };
