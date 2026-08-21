// story-craft-integration.js — StoryCraft Engine v1.0 集成层
// 集成到 production-engine Stage-5

const { ConceptForge } = require('./concept-forge');
const { BeatSheetEngine } = require('./beat-sheet-engine');
const { BeastPsycheGenerator } = require('./beast-psyche-generator');
const { DialogueDistiller } = require('./dialogue-distiller');
const { TwistValidator } = require('./twist-validator');
const { EncounterDynamics } = require('./encounter-dynamics');
const { LLMEngine } = require('../llm-reasoning-engine'); // v6.2-patch70: 接入 LLM 推理

class StoryCraftIntegration {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.strictMode = options.strictMode || false;
    this.maxRetries = options.maxRetries || 2;
    this.useLLM = options.useLLM !== false; // v6.2-patch70: 默认启用 LLM
    
    // 子模块实例
    this.conceptForge = new ConceptForge(options.conceptForge);
    this.beatSheetEngine = new BeatSheetEngine(options.beatSheet);
    this.psycheGenerator = new BeastPsycheGenerator(options.psyche);
    this.dialogueDistiller = new DialogueDistiller(options.dialogue);
    this.twistValidator = new TwistValidator(options.twist);
    this.encounterDynamics = new EncounterDynamics(options.encounter);
    
    // v6.2-patch70: LLM 推理引擎
    // v6.7.0-fix1: timeoutMs 300000 (5分钟) — 32k token输出量大，120s频繁超时
    this.llmEngine = new LLMEngine({
      model: options.llmModel || 'kimi-k2p6',
      mode: 'production',
      maxRetries: 3,
      timeoutMs: 300000, // 5分钟：32k token剧本创作需要充足时间
      // v6.2-patch80: 剧本创作需要大量LLM输出（场景描述/角色对话/世界观），提升maxTokens
      maxTokens: 32000
    });
    
    // v6.7.0-fix1: LLM调用统计（成功率追踪）
    this.llmStats = {
      totalCalls: 0,
      successCalls: 0,
      failCalls: 0,
      avgResponseTime: 0,
      totalResponseTime: 0
    };
  }

  // 核心方法：完整的 StoryCraft 流程（v6.2-patch70: LLM 推理版）
  async generateStory(projectConfig, beastProfile) {
    if (!this.enabled) {
      return { enabled: false, reason: 'StoryCraft disabled' };
    }

    const startTime = Date.now();
    const logs = [];
    
    try {
      // v6.2-patch70: 使用 LLM 生成高概念种子
      logs.push('[StoryCraft] Step 1: LLM 推理 — 生成高概念种子');
      const conceptResult = await this._llmGenerateConceptSeed(beastProfile);
      const selectedSeed = conceptResult.selected;
      logs.push(`[StoryCraft] LLM 生成 ${conceptResult.seeds.length} 个种子，选择: ${selectedSeed.id} (强度: ${selectedSeed.twistStrength})`);

      // v6.2-patch70: 使用 LLM 生成异兽心理画像
      logs.push('[StoryCraft] Step 2: LLM 推理 — 生成异兽心理画像');
      const psycheResult = await this._llmGeneratePsyche(beastProfile, selectedSeed);
      logs.push(`[StoryCraft] LLM 心理画像完成，独白数: ${Object.keys(psycheResult.monologues).length}`);

      // v6.2-patch70: 使用 LLM 生成 5 节拍结构
      logs.push('[StoryCraft] Step 3: LLM 推理 — 生成 5 节拍结构');
      const beatResult = await this._llmGenerateBeatSheet(selectedSeed, beastProfile, projectConfig);
      logs.push(`[StoryCraft] LLM 5 节拍生成完成，验证: ${beatResult.validation.isValid ? '通过' : '失败'}`);
      
      if (!beatResult.validation.isValid && this.strictMode) {
        return { enabled: true, success: false, stage: 'beatSheet', errors: beatResult.validation.errors, logs };
      }

      // v6.2-patch70: 使用 LLM 精炼台词
      logs.push('[StoryCraft] Step 4: LLM 推理 — 精炼台词');
      const dialogueResult = await this._llmDistillDialogues(psycheResult, beatResult);
      logs.push(`[StoryCraft] LLM 台词完成，异兽台词: ${Object.keys(dialogueResult.beastLines).length}`);

      // v6.2-patch70: 使用 LLM 验证反转质量
      logs.push('[StoryCraft] Step 5: LLM 推理 — 验证反转质量');
      const twistResult = await this._llmValidateTwist(beatResult, beastProfile);
      logs.push(`[StoryCraft] LLM 反转验证: ${twistResult.passed ? '通过' : '失败'} (分数: ${twistResult.score})`);

      // v6.2-patch70: 使用 LLM 生成相遇动力学
      logs.push('[StoryCraft] Step 6: LLM 推理 — 生成相遇动力学');
      const encounterResult = await this._llmGenerateDynamics(beatResult, psycheResult, dialogueResult);
      logs.push(`[StoryCraft] LLM 相遇动力学完成，${encounterResult.stages.length} 个阶段`);

      // 生成最终故事板
      let storyboard = this.generateFinalStoryboard(
        beatResult, 
        psycheResult, 
        dialogueResult, 
        encounterResult,
        projectConfig
      );

      // POV 视角锁定
      logs.push('[StoryCraft] Step 7: POV 视角锁定');
      storyboard.shots = this.beatSheetEngine.applyPOVToAllShots(storyboard.shots, beastProfile);
      logs.push(`[StoryCraft] POV 锁定完成，${storyboard.shots.length} 镜全部转为${beastProfile.name}主观视角`);

      const duration = Date.now() - startTime;
      logs.push(`[StoryCraft] ✅ LLM 推理完成！耗时 ${duration}ms`);

      return {
        enabled: true,
        success: true,
        storyboard,
        conceptSeed: selectedSeed,
        beatSheet: beatResult,
        psyche: psycheResult,
        dialogues: dialogueResult,
        twistValidation: twistResult,
        encounter: encounterResult,
        logs,
        metadata: {
          duration,
          beastName: beastProfile.name,
          theme: selectedSeed.theme,
          twistStrength: selectedSeed.twistStrength,
          generatedAt: new Date().toISOString(),
          llmEnabled: true, // v6.2-patch70: 标记使用了 LLM
          llmCalls: this.llmEngine.getStats().totalCalls
        }
      };

    } catch (error) {
      logs.push(`[StoryCraft] ❌ 错误: ${error.message}`);
      return {
        enabled: true,
        success: false,
        stage: 'error',
        error: error.message,
        logs
      };
    }
  }

  // ==================== v6.2-patch70: LLM 推理方法 ====================

  /**
   * LLM 推理：生成高概念种子
   */
  async _llmGenerateConceptSeed(beastProfile) {
    if (!this.useLLM) {
      return this.conceptForge.generateSeeds(beastProfile);
    }

    const prompt = `请为山海经异兽「${beastProfile.name}」生成 3 个高概念故事种子。

异兽档案：
- 姓名：${beastProfile.name}
- 特征：${beastProfile.signatureFeatures?.join('、') || '未知'}
- 弱点：${beastProfile.weaknesses?.join('、') || '未知'}
- 能力：${beastProfile.abilities?.join('、') || '未知'}
- 起源：${beastProfile.mythOrigin || '未知'}
- 栖息地：${beastProfile.nirathHabitat || beastProfile.habitat || '未知'}

要求：
1. 每个种子包含：id、theme（主题）、twist（反转）、emotionalAnchor（情绪锚点）、twistStrength（反转强度 1-10）
2. 主题要深刻，反转要有冲击力
3. 情绪锚点要具体可感
4. 最适合 60 秒短片的种子放在第一个

请输出 JSON 格式：`;

    const schema = {
      seeds: [
        { id: "seed_1", theme: "", twist: "", emotionalAnchor: "", twistStrength: 0 }
      ],
      selected: { id: "", theme: "", twist: "", emotionalAnchor: "", twistStrength: 0 }
    };

    const result = await this._trackedReason(prompt, schema, {}, "conceptSeed");
    
    if (result.success) {
      return result.data;
    }
    
    // LLM 失败回退到本地模板
    console.log('[StoryCraft] ⚠️ LLM 概念生成失败，回退到本地模板');
    return this.conceptForge.generateSeeds(beastProfile);
  }

  /**
   * LLM 推理：生成异兽心理画像
   */
  async _llmGeneratePsyche(beastProfile, conceptSeed) {
    if (!this.useLLM) {
      return this.psycheGenerator.generatePsyche(beastProfile, conceptSeed);
    }

    const prompt = `请为异兽「${beastProfile.name}」生成深度心理画像。

概念种子：${conceptSeed.theme}
反转：${conceptSeed.twist}

要求输出：
1. psyche.sensoryBlueprint（感知蓝图）：主要感官 + 超敏感官
2. psyche.desireCore（欲望内核）：want + need + lie + ghost
3. monologues（内心独白）：每个节拍 1 句独白，共 5 句
4. voiceSignature（声音签名）：风格、语速、语气词特征

请输出 JSON 格式：`;

    const schema = {
      psyche: {
        sensoryBlueprint: { primary: "", hyper: "" },
        desireCore: { want: "", need: "", lie: "", ghost: "" }
      },
      monologues: {},
      voiceSignature: { style: "", pace: "", tics: [] }
    };

    const result = await this._trackedReason(prompt, schema, {}, "psyche");
    
    if (result.success) {
      return result.data;
    }
    
    console.log('[StoryCraft] ⚠️ LLM 心理画像失败，回退到本地模板');
    return this.psycheGenerator.generatePsyche(beastProfile, conceptSeed);
  }

  /**
   * LLM 推理：生成 5 节拍结构
   */
  async _llmGenerateBeatSheet(conceptSeed, beastProfile, projectConfig) {
    if (!this.useLLM) {
      return this.beatSheetEngine.generateBeatSheet(conceptSeed, beastProfile, projectConfig);
    }

    const prompt = `请基于以下概念种子生成 5 节拍故事结构。

异兽：${beastProfile.name}
主题：${conceptSeed.theme}
反转：${conceptSeed.twist}
目标时长：${projectConfig.duration || 15} 秒

要求输出 5 个节拍（Beat），每个包含：
- id: beat_1 到 beat_5
- name: 节拍名称（如：开场、上升、中点、下降、结局）
- timeRange: { start, end }（秒）
- narrationTemplate: 旁白文本（按时长计算：每5秒约25字，必须饱满、有文学质感，禁止干瘪短句）
- visualPromptTemplate: 视觉描述（300-500字，必须详细描述：场景环境、角色外貌、动作姿态、光影氛围、色彩基调、材质细节、空间关系、情绪氛围。禁止泛泛而谈，必须有具体可感的视觉细节）
- emotionTarget: { emotion, intensity: 1-10 }
- twistElement: 该节拍的反转元素（如有）

validation: { isValid: true/false, errors: [] }

请输出 JSON 格式：`;

    const schema = {
      beats: [
        { id: "", name: "", timeRange: { start: 0, end: 0 }, narrationTemplate: "", visualPromptTemplate: "", emotionTarget: { emotion: "", intensity: 0 }, twistElement: "" }
      ],
      validation: { isValid: true, errors: [] }
    };

    const result = await this._trackedReason(prompt, schema, {}, "beatSheet");
    
    if (result.success) {
      return result.data;
    }
    
    console.log('[StoryCraft] ⚠️ LLM 节拍生成失败，回退到本地模板');
    return this.beatSheetEngine.generateBeatSheet(conceptSeed, beastProfile, projectConfig);
  }

  /**
   * LLM 推理：精炼台词
   */
  async _llmDistillDialogues(psycheResult, beatResult) {
    if (!this.useLLM) {
      return this.dialogueDistiller.distillDialogues(psycheResult, beatResult);
    }

    const prompt = `请为以下 5 节拍故事精炼台词和旁白。

心理画像：${JSON.stringify(psycheResult.psyche, null, 2)}
节拍结构：${JSON.stringify(beatResult.beats.map(b => ({ id: b.id, name: b.name, emotion: b.emotionTarget.emotion })), null, 2)}

要求：
1. 每个节拍最多 1 句异兽台词（beastLines）
2. 每个节拍最多 1 句小G台词（humanLines）
3. 旁白（nirathLines）用于叙事推进
4. 嘴部动作（mouthActions）与台词匹配
5. 钻石台词（最核心台词）不超过 3 句

请输出 JSON 格式：`;

    const schema = {
      beastLines: {},
      humanLines: {},
      nirathLines: {},
      mouthActions: {},
      metadata: { diamondQuotaTotal: 3, diamondQuotaUsed: 0 }
    };

    const result = await this._trackedReason(prompt, schema, {}, "dialogue");
    
    if (result.success) {
      return result.data;
    }
    
    console.log('[StoryCraft] ⚠️ LLM 台词精炼失败，回退到本地模板');
    return this.dialogueDistiller.distillDialogues(psycheResult, beatResult);
  }

  /**
   * LLM 推理：验证反转质量
   */
  async _llmValidateTwist(beatResult, beastProfile) {
    if (!this.useLLM) {
      return this.twistValidator.validateTwist(beatResult.beats, beastProfile);
    }

    const prompt = `请验证以下故事反转的质量。

异兽：${beastProfile.name}
节拍：${JSON.stringify(beatResult.beats.map(b => ({ id: b.id, twistElement: b.twistElement })), null, 2)}

从以下维度评分（1-10）：
1. Need揭示力：是否揭露深层心理需求
2. 静默预算：是否有无言高潮时刻
3. 情感可信度：情绪转折是否自然
4. 视觉冲击力：画面是否震撼
5. 余韵留存：结束后是否留下思考

要求：
- score: 总分（0-100）
- passed: score >= 70 为通过
- recommendation: 改进建议

请输出 JSON 格式：`;

    const schema = {
      score: 0,
      passed: false,
      recommendation: ""
    };

    const result = await this._trackedReason(prompt, schema, {}, "twist");
    
    if (result.success) {
      return result.data;
    }
    
    console.log('[StoryCraft] ⚠️ LLM 反转验证失败，回退到本地模板');
    return this.twistValidator.validateTwist(beatResult.beats, beastProfile);
  }

  /**
   * LLM 推理：生成相遇动力学
   */
  async _llmGenerateDynamics(beatResult, psycheResult, dialogueResult) {
    if (!this.useLLM) {
      return this.encounterDynamics.generateDynamics(beatResult, psycheResult, dialogueResult);
    }

    const prompt = `请生成异兽与小G的相遇动力学描述。

节拍：${JSON.stringify(beatResult.beats.map(b => ({ id: b.id, name: b.name })), null, 2)}
心理：${JSON.stringify(psycheResult.psyche?.desireCore || {}, null, 2)}

要求输出每个节拍的动力学阶段：
- stage.beast.bodyLanguage: 异兽肢体语言
- stage.beast.emotionalState: 异兽情绪状态
- stage.human.bodyLanguage: 小G肢体语言
- stage.human.emotionalState: 小G情绪状态
- stage.interaction.type: 互动类型
- stage.interaction.spatialRelationship: 空间关系
- stage.audience.perceives: 观众感知
- stage.audience.payoff: 情绪回报

请输出 JSON 格式：`;

    const schema = {
      stages: [
        {
          beatId: "",
          beast: { bodyLanguage: "", emotionalState: "", intention: "" },
          human: { bodyLanguage: "", emotionalState: "", intention: "" },
          interaction: { type: "", spatialRelationship: "" },
          audience: { perceives: "", payoff: "" }
        }
      ]
    };

    const result = await this._trackedReason(prompt, schema, {}, "dynamics");
    
    if (result.success) {
      return result.data;
    }
    
    console.log('[StoryCraft] ⚠️ LLM 动力学生成失败，回退到本地模板');
    return this.encounterDynamics.generateDynamics(beatResult, psycheResult, dialogueResult);
  }

  // 保留原有方法（generateFinalStoryboard, generateNarration, generateVisualPrompt, fallbackToLegacy）...


  // 生成最终故事板（兼容现有格式）
  generateFinalStoryboard(beatResult, psycheResult, dialogueResult, encounterResult, projectConfig) {
    const beats = beatResult.beats;
    const shots = [];
    
    beats.forEach((beat, index) => {
      const stage = encounterResult.stages.find(s => s.beatId === beat.id);
      const beastLine = dialogueResult.beastLines?.[beat.id];
      const humanLine = dialogueResult.humanLines?.[beat.id];
      const nirathLine = dialogueResult.nirathLines?.[beat.id];
      const mouthAction = dialogueResult.mouthActions?.[beat.id];
      
      // 生成 narration（合并独白+台词+潜台词）
      const narration = this.generateNarration(beat, psycheResult, beastLine, humanLine);
      
      // 生成 visualPrompt（合并视觉模板+互动动力学+叙事内容）
      const visualPrompt = this.generateVisualPrompt(beat, stage, dialogueResult, psycheResult);
      
      shots.push({
        id: `S${String(index + 1).padStart(2, '0')}`,
        beatId: beat.id,
        beatName: beat.name,
        timeRange: beat.timeRange,
        duration: beat.timeRange.end - beat.timeRange.start,
        
        // 叙事内容
        narration,
        visualPrompt,
        
        // 台词
        beastDialogue: beastLine || null,
        humanDialogue: humanLine || null,
        nirathDialogue: nirathLine || null,
        
        // 动作
        mouthAction: mouthAction?.action || (beastLine ? '嘴部张开正在异兽对话' : (humanLine ? '嘴部张开正在说话' : '嘴部自然闭合')),
        beastBodyLanguage: stage?.beast?.bodyLanguage || null,
        humanBodyLanguage: stage?.human?.bodyLanguage || null,
        
        // 情绪
        emotionTarget: beat.emotionTarget,
        beastEmotion: stage?.beast?.emotionalState || null,
        humanEmotion: stage?.human?.emotionalState || null,
        
        // 互动
        interactionType: stage?.interaction?.type || null,
        spatialRelationship: stage?.interaction?.spatialRelationship || null,
        
        // 观众
        audiencePerception: stage?.audience?.perceives || null,
        payoff: stage?.audience?.payoff || null,
        
        // 异兽心理
        beastMonologue: psycheResult.monologues?.[beat.id] || null,
        beastIntention: stage?.beast?.intention || null
      });
    });

    return {
      shots,
      beats: beatResult.beats,
      metadata: {
        totalShots: shots.length,
        totalDuration: shots.reduce((sum, s) => sum + s.duration, 0),
        emotionCurve: beatResult.emotionCurve,
        twistValidation: encounterResult.metadata
      }
    };
  }

  // 生成narration（合并多层信息，根据时长计算目标字数，避免干瘪短句）
  // v6.5.1-fix: 升级StoryCraft narration质量，按时长计算字数（5字/秒），生成饱满叙事
  generateNarration(beat, psycheResult, beastLine, humanLine) {
    const parts = [];
    
    // 基础叙事（必须优先使用，保证文学质感）
    if (beat.narrationTemplate) {
      parts.push(beat.narrationTemplate);
    }
    
    // 如果 narration 太短，自动扩展（确保时长匹配）
    const duration = (beat.timeRange?.end - beat.timeRange?.start) || 5;
    const targetChars = Math.floor(duration * 5.0); // 5字/秒目标
    const currentNarration = parts.join(' ');
    
    if (currentNarration.length < targetChars * 0.6) {
      // narration 严重不足，从其他维度补充
      const enrichments = [];
      
      // 1. 异兽内心独白（转化为叙述性描述）
      if (psycheResult.monologues?.[beat.id]) {
        const mono = psycheResult.monologues[beat.id];
        // 将独白转化为第三人称叙述
        enrichments.push(`它的内心在低语：${mono}`);
      }
      
      // 2. 情绪氛围描述
      if (beat.emotionTarget?.emotion) {
        const emotionDesc = {
          'awe': '空气中弥漫着敬畏的气息，每一次呼吸都像是与远古力量的对话',
          'fear': '恐惧如冰冷的触手攀上脊背，未知在这片异星荒野中悄然潜伏',
          'curiosity': '好奇如星火点燃，驱使着探索者向未知迈出每一步',
          'tension': '紧张感如同绷紧的弦，随时可能断裂，释放出无法预知的能量',
          'wonder': '惊奇如涟漪般扩散，这个异世界每一个角落都藏着不可思议的秘密'
        };
        if (emotionDesc[beat.emotionTarget.emotion]) {
          enrichments.push(emotionDesc[beat.emotionTarget.emotion]);
        }
      }
      
      // 3. 场景氛围
      if (beat.twistElement) {
        enrichments.push(`周围的空气似乎因${beat.twistElement}而微微震颤，现实与幻象的边界在此模糊`);
      }
      
      // 4. 动作细节
      if (psycheResult.psyche?.sensoryBlueprint?.primary) {
        enrichments.push(`感官被${psycheResult.psyche.sensoryBlueprint.primary}所占据，每一个细微变化都被无限放大`);
      }
      
      parts.push(...enrichments);
    }
    
    // 异兽台词（如果有，作为对话插入）
    if (beastLine) {
      parts.push(`（${beastLine.text}）`);
    }
    
    // 小G台词（如果有）
    if (humanLine) {
      parts.push(`小G："${humanLine.text}"`);
    }
    
    return parts.join(' ');
  }

  // 生成visualPrompt（合并视觉模板+互动动力学+叙事内容，自动丰富化到300-500字）
  // v6.5.1-fix: 升级StoryCraft视觉生成质量，避免下游频繁打补丁
  generateVisualPrompt(beat, stage, dialogueResult, psycheResult) {
    const parts = [];
    
    // 基础视觉模板（核心视觉描述）
    if (beat.visualPromptTemplate) {
      parts.push(`【视觉】${beat.visualPromptTemplate}`);
    }
    
    // 自动丰富化：如果视觉描述太短，从其他维度补充
    const baseVisual = beat.visualPromptTemplate || '';
    if (baseVisual.length < 200) {
      // 从场景描述补充环境细节
      const enrichments = [];
      
      // 1. 环境氛围
      if (beat.emotionTarget?.emotion) {
        const emotionLighting = {
          'awe': '神圣金色光晕笼罩，粒子在光束中漂浮',
          'fear': '暗红色警示光脉动，阴影在岩壁间扭曲',
          'curiosity': '蓝紫色探索光束扫描，未知符文隐隐发光',
          'tension': '双恒星光线形成戏剧性光比，明暗交界锋利如刃',
          'wonder': '生物荧光与恒星光辉交织，虹彩光晕在空气中折射'
        };
        if (emotionLighting[beat.emotionTarget.emotion]) {
          enrichments.push(`【氛围】${emotionLighting[beat.emotionTarget.emotion]}`);
        }
      }
      
      // 2. 材质细节
      if (beat.twistElement) {
        enrichments.push(`【材质】${beat.twistElement}的纹理清晰可见，表面有细微的能量流动痕迹`);
      }
      
      // 3. 空间深度
      if (stage?.interaction?.spatialRelationship) {
        enrichments.push(`【空间】${stage.interaction.spatialRelationship}，景深层次分明，前景植被虚化，背景山脉锐利`);
      }
      
      // 4. 动态元素
      if (stage?.beast?.bodyLanguage) {
        enrichments.push(`【动态】异兽${stage.beast.bodyLanguage}，动作充满力量感，肌肉线条在光照下清晰可见`);
      }
      if (stage?.human?.bodyLanguage) {
        enrichments.push(`【人物】小G${stage.human.bodyLanguage}，姿态传达出${stage.human?.emotionalState || '复杂情绪'}`);
      }
      
      // 5. Nirath 环境特征
      enrichments.push(`【环境】Nirath异世界生态：双恒星光照形成玫瑰金阴影，生物发光植物点缀地表，空气中漂浮着记忆能量微粒，远处可见奇异生物活动轨迹`);
      
      parts.push(...enrichments);
    }
    
    // 互动动力学（肢体语言）
    if (stage) {
      parts.push(`【动作】异兽：${stage.beast.bodyLanguage} | 小G：${stage.human.bodyLanguage} | 空间：${stage.interaction.spatialRelationship}`);
    }
    
    // 嘴部动作
    const mouthAction = dialogueResult.mouthActions?.[beat.id];
    if (mouthAction) {
      parts.push(`【嘴部】${mouthAction.action}`);
    }
    
    return parts.join('\n');
  }

  // 向后兼容：如果StoryCraft失败，回退到原有剧本生成
  fallbackToLegacy(projectConfig) {
    return {
      enabled: true,
      success: false,
      fallback: true,
      reason: 'StoryCraft failed, using legacy story generation',
      logs: ['[StoryCraft] 回退到原有剧本生成']
    };
  }
  // v6.7.0-fix1: LLM调用包装器（带统计追踪）
  async _trackedReason(prompt, schema, options = {}, label = 'unknown') {
    const startTime = Date.now();
    this.llmStats.totalCalls++;
    try {
      const result = await this.llmEngine.reasonStructured(prompt, schema, options);
      const elapsed = Date.now() - startTime;
      this.llmStats.totalResponseTime += elapsed;
      this.llmStats.avgResponseTime = Math.round(this.llmStats.totalResponseTime / this.llmStats.totalCalls);
      if (result.success) {
        this.llmStats.successCalls++;
        console.log(`[StoryCraft] ✅ LLM[${label}] 成功 | 耗时:${elapsed}ms | 成功率:${Math.round(this.llmStats.successCalls/this.llmStats.totalCalls*100)}%`);
      } else {
        this.llmStats.failCalls++;
        console.log(`[StoryCraft] ⚠️ LLM[${label}] 失败 | 耗时:${elapsed}ms | 原因:${result.error || 'unknown'}`);
      }
      return result;
    } catch (error) {
      const elapsed = Date.now() - startTime;
      this.llmStats.failCalls++;
      this.llmStats.totalResponseTime += elapsed;
      this.llmStats.avgResponseTime = Math.round(this.llmStats.totalResponseTime / this.llmStats.totalCalls);
      console.log(`[StoryCraft] ❌ LLM[${label}] 异常 | 耗时:${elapsed}ms | ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  // v6.7.0-fix1: 获取LLM统计
  getLLMStats() {
    const total = this.llmStats.totalCalls;
    return {
      ...this.llmStats,
      successRate: total > 0 ? Math.round(this.llmStats.successCalls / total * 100) : 0,
      failRate: total > 0 ? Math.round(this.llmStats.failCalls / total * 100) : 0
    };
  }
}

module.exports = { StoryCraftIntegration };

// 集成测试
if (require.main === module) {
  const integration = new StoryCraftIntegration({
    enabled: true,
    strictMode: false,
    maxRetries: 2
  });

  const projectConfig = {
    mode: 'nirath',
    duration: 15,
    storyCraftVersion: 'v1.0'
  };

  const beastProfile = {
    name: '饕餮',
    signatureFeatures: ['巨口永远张开（占面部2/3）', '腋下双眼（暗红色竖瞳）', '永不满足的饥饿'],
    weaknesses: ['骄傲', '对仁的渴望', '被误解的孤独'],
    abilities: ['吞噬万物', '过滤毒素', '转化能量'],
    mythOrigin: '羊身人面的远古凶兽',
    habitat: '钩吾山荒原',
    nirathHabitat: '钩吾山荒原'
  };

  integration.generateStory(projectConfig, beastProfile).then(result => {
    console.log('=== StoryCraft Integration 测试 ===');
    console.log('成功:', result.success);
    console.log('日志:');
    result.logs.forEach(log => console.log('  ', log));
    
    if (result.success) {
      console.log('\n故事板镜头数:', result.storyboard.shots.length);
      console.log('主题:', result.conceptSeed.theme);
      console.log('反转强度:', result.conceptSeed.twistStrength);
      console.log('反转验证:', result.twistValidation.passed, `(${result.twistValidation.score}/100)`);
      
      console.log('\n镜头预览:');
      result.storyboard.shots.forEach(shot => {
        console.log(`\n${shot.id} (${shot.beatName}):`);
        console.log(`  narration: ${shot.narration.substring(0, 50)}...`);
        console.log(`  beastDialogue: ${shot.beastDialogue?.text || '无'}`);
        console.log(`  humanDialogue: ${shot.humanDialogue?.text || '无'}`);
        console.log(`  emotion: ${shot.emotionTarget?.emotion}(${shot.emotionTarget?.intensity})`);
      });
    }
  });
}
