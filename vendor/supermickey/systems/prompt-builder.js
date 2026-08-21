/**
 * Prompt构建器 v1.0
 * 基于镜头参数构建完整的Seedance Prompt
 * 
 * 功能：
 * - 结构化Prompt组装（场景+角色+运镜+风格）
 * - 字数优化（最大化980字符利用率）
 * - 合规检查（禁用词过滤）
 * - Nirath风格注入
 * 
 * @version v1.0
 * @author 小G
 */

class PromptBuilder {
  constructor(options = {}) {
    this.maxLength = options.maxLength || 1500;
    this.targetLength = options.targetLength || 1470;
    this.mode = options.mode || 'nirath';
    
    // 禁用关键词
    this.bannedKeywords = [
      '中国风', '古风', '传统', '水墨', '国风', '仙侠', '武侠',
      'chinese style', 'traditional chinese', 'ink wash', 'oriental',
      'lo-fi', 'anime', 'cartoon', 'cartoony', 'stylized', 'toon'
    ];
    
    // Nirath风格参数
    // v6.2-patch63-fix: 清理UE5/Lumen/Nanite等英文技术声明，替换为中文等效描述
    this.nirathTechTail = '超写实数字渲染，概念美术级质感，双恒星日落玫瑰金光照，生物发光生态补光，影视级画面构图，IMAX画幅，空气透视感，皮肤与材质微距摄影级细节，写实风格，外星繁茂植被覆盖岩石地表，背景可见奇异生物活动。';
  }

  /**
   * 构建Prompt（核心方法）
   * @param {Object} params - 构建参数
   * @param {string} params.sceneName - 场景名
   * @param {string} params.script - narration文本
   * @param {Array} params.characters - 角色列表
   * @param {string} params.type - 镜头类型
   * @param {string} params.emotionPhase - 情绪阶段
   * @param {Object} params.movement - 运镜配置
   * @param {string} params.mouthAction - 嘴部动作
   * @returns {Object} { prompt, length, utilization, status }
   */
  build(params) {
    const startTime = Date.now();
    console.log(`[PromptBuilder] 🔧 开始构建Prompt | 场景: ${params.sceneName}`);
    
    // 1. 构建基础Prompt
    let prompt = this._buildBasePrompt(params);
    
    // 2. 注入Nirath风格
    prompt = this._injectNirathStyle(prompt);
    
    // 3. 注入运镜描述
    if (params.movement) {
      prompt = this._injectCameraMovement(prompt, params.movement);
    }
    
    // 4. 注入嘴部动作
    if (params.mouthAction) {
      prompt = this._injectMouthAction(prompt, params.mouthAction);
    }
    
    // 5. 字数优化（填充至目标长度）
    prompt = this._optimizeLength(prompt, params);
    
    // 6. 合规检查
    const compliance = this._checkCompliance(prompt);
    
    const length = prompt.length;
    const utilization = length / this.maxLength;
    
    let status = 'normal';
    if (length >= 970 && length <= 1500) status = 'ideal';
    else if (length > 1500) status = 'overflow';
    else if (length < 850) status = 'underflow';
    
    const duration = Date.now() - startTime;
    console.log(`[PromptBuilder] ✅ Prompt构建完成 | ${length}字符 | 利用率: ${Math.round(utilization * 100)}% | 状态: ${status} | 耗时: ${duration}ms`);
    
    return {
      prompt,
      length,
      utilization: Math.round(utilization * 100),
      utilizationStatus: status === 'ideal' ? '🔥理想' : status === 'overflow' ? '❌超标' : status === 'underflow' ? '⚠️不足' : '正常',
      status,
      compliance,
      duration
    };
  }

  /**
   * 构建基础Prompt（v6.2-patch88-fix: 支持voiceover+dialogue分离）
   */
  _buildBasePrompt(params) {
    const parts = [];
    
    // 1. 场景描述
    const sceneDesc = this._buildSceneDescription(params.sceneName, params.type);
    parts.push(sceneDesc);
    
    // 2. 角色描述
    if (params.characters && params.characters.length > 0) {
      const charDesc = this._buildCharacterDescription(params.characters);
      parts.push(charDesc);
    }
    
    // 3. 情绪/氛围
    const emotionDesc = this._buildEmotionDescription(params.emotionPhase);
    parts.push(emotionDesc);
    
    // 4. 【v6.2-patch89-底层约束】旁白归零：不使用voiceover，全部转为dialogue
    // 禁止第三人称旁白，所有叙事必须通过角色台词直接表达
    // 原因：旁白辅助表现是低质量的，真正的电影叙事是角色自己说出来的
    
    // 5. dialogue融入（如果存在）- 角色台词
    if (params.dialogue && params.dialogue.length > 0) {
      const dialogueDesc = this._buildDialogueDescription(params.dialogue, params.type);
      parts.push(dialogueDesc);
    }
    
    // 6. 向后兼容：如果只有script（旧版narration），自动转为dialogue
    if (!params.dialogue && params.script) {
      // 旧版 narration 自动转为角色独白
      const autoDialogue = [{
        speaker: 'xiaoG', // 默认主角
        type: 'MONOLOGUE',
        text: params.script,
        lipSync: true,
        emotion: '中性'
      }];
      const dialogueDesc = this._buildDialogueDescription(autoDialogue, params.type);
      parts.push(dialogueDesc);
    }
    
    return parts.join('. ') + '.';
  }

  /**
   * 构建场景描述
   */
  _buildSceneDescription(sceneName, type) {
    const sceneMap = {
      '永夜裂谷': 'Eternal Night Canyon of Nirath, obsidian cliffs with bioluminescent veins, twin stars casting rose-gold shadows across crystalline formations',
      '青丘灵原': 'Qingqiu Spirit Plains, jade-green grasslands with floating spore clouds, soft diffused light from gentle bioluminescence',
      '钟山之巅': 'Zhongshan Peak, volcanic crater with magma flows, crimson-amber lighting from thermal vents',
      '银色湖泊': 'Silver Lake, mirror-like surface reflecting dual stars, bioluminescent plankton creating ethereal glow',
      '建木林': 'Jianmu Forest, towering bio-mechanical trees with copper-lichen bark, spore filaments drifting in wind',
      'default': `Nirath异星景观, ${sceneName}, 写实科幻生态系统`
    };
    
    const desc = sceneMap[sceneName] || sceneMap['default'];
    
    // 根据镜头类型调整
    const typePrefix = {
      'opening': 'Epic establishing shot,',
      'environment': 'Wide environmental shot,',
      'reveal': 'Dramatic reveal shot,',
      'interaction': 'Intimate interaction shot,',
      'climax': 'Intense climax shot,',
      'closing': 'Peaceful closing shot,'
    };
    
    return `${typePrefix[type] || 'Cinematic shot,'} ${desc}`;
  }

  /**
   * 构建角色描述
   */
  _buildCharacterDescription(characters) {
    const charParts = [];
    
    for (const char of characters) {
      if (char === 'xiaoG') {
        charParts.push('young protagonist with warm expression, detailed facial features, natural skin texture with visible pores and subtle subsurface scattering');
      } else if (char === 'zhu-long') {
        charParts.push('massive serpentine creature with crimson scales, amber eyes glowing with inner fire, obsidian horns reflecting starlight');
      } else {
        charParts.push(`character ${char} with detailed features`);
      }
    }
    
    return `Characters: ${charParts.join(', ')}.`;
  }

  /**
   * 构建情绪描述
   */
  _buildEmotionDescription(emotionPhase) {
    const emotionMap = {
      'establishing': 'Atmospheric mood: calm anticipation, soft ambient lighting',
      'curiosity': 'Atmospheric mood: curious exploration, gentle wonder in lighting',
      'awe': 'Atmospheric mood: overwhelming awe, dramatic lighting contrast',
      'wonder': 'Atmospheric mood: magical wonder, soft bioluminescent glow',
      'tension': 'Atmospheric mood: rising tension, sharp shadow edges',
      'triumph': 'Atmospheric mood: epic triumph, golden god-rays piercing through',
      'peace': 'Atmospheric mood: peaceful resolution, warm gentle lighting',
      'closure': 'Atmospheric mood: quiet closure, fading ambient light',
      'neutral': 'Atmospheric mood: balanced neutral lighting'
    };
    
    return emotionMap[emotionPhase] || emotionMap['neutral'];
  }

  /**
   * 构建narration描述（将narration转化为视觉描述）
   * v6.2-patch88: 向后兼容，当只有旧版script时使用
   */
  _buildNarrationDescription(script, type) {
    // 提取关键词并转化为视觉元素
    const visualElements = [];
    
    if (script.includes('小G') || script.includes('主角')) {
      visualElements.push('protagonist in frame');
    }
    if (script.includes('烛龙') || script.includes('神兽')) {
      visualElements.push('mythical creature presence');
    }
    if (script.includes('光') || script.includes('亮')) {
      visualElements.push('dramatic light sources');
    }
    if (script.includes('探索') || script.includes('走')) {
      visualElements.push('exploratory movement');
    }
    
    if (visualElements.length > 0) {
      return `Visual narrative: ${visualElements.join(', ')}.`;
    }
    
    return '';
  }

  /**
   * 构建voiceover描述（第三人称旁白）
   * v6.2-patch88-fix: 旁白只作为场景描述，不对嘴
   */
  _buildVoiceoverDescription(voiceover, type) {
    if (!voiceover || voiceover.trim().length === 0) return '';
    
    // 旁白转化为环境/场景描述，不对嘴
    return `【旁白/Voiceover】${voiceover}。场景氛围描述，画外音，不对嘴。`;
  }

  /**
   * 构建dialogue描述（角色台词）
   * v6.2-patch88-fix: 角色台词必须标注说话者、情绪、对嘴要求
   */
  _buildDialogueDescription(dialogue, type) {
    if (!dialogue || dialogue.length === 0) return '';
    
    const parts = [];
    
    for (const line of dialogue) {
      const { speaker, type: dialogueType, text, lipSync, emotion } = line;
      
      // 根据话语类型生成不同的Prompt片段
      let dialoguePrompt = '';
      
      switch (dialogueType) {
        case 'DIALOGUE':
          // 对话：角色间对话，必须对嘴
          dialoguePrompt = `【对话指令/Dialogue】${speaker}（${emotion}）："${text}"。角色直接对话，必须对嘴，口型动作与台词情绪匹配。`;
          break;
        case 'MONOLOGUE':
          // 独白：角色自言自语，对嘴
          dialoguePrompt = `【对话指令/Monologue】${speaker}（${emotion}，内心独白）："${text}"。角色自言自语，对嘴，口型动作自然流畅。`;
          break;
        case 'WHISPER':
          // 低语：对嘴但幅度小
          dialoguePrompt = `【对话指令/Whisper】${speaker}（${emotion}，低语）："${text}"。角色低声说话，对嘴但口型幅度小，配气息音。`;
          break;
        case 'TELEPATHY':
          // 心灵感应：不对嘴，用眼神+音效
          dialoguePrompt = `【对话指令/Telepathy】${speaker}（${emotion}，心灵感应）："${text}"。非语言交流，不对嘴，眼神光效+低频磁场震颤音效表现。`;
          break;
        case 'NARRATION':
          // 旁白：不对嘴
          dialoguePrompt = `【旁白/Narration】${speaker}："${text}"。画外音旁白，不对嘴。`;
          break;
        default:
          dialoguePrompt = `【对话指令】${speaker}（${emotion}）："${text}"。`;
      }
      
      parts.push(dialoguePrompt);
    }
    
    return parts.join('\n');
  }

  /**
   * 注入Nirath风格
   */
  _injectNirathStyle(prompt) {
    // 确保Prompt开头包含Nirath风格参数
    if (!prompt.includes('hyper-realistic') && !prompt.includes('Unreal Engine 5')) {
      prompt = `${this.nirathTechTail} ${prompt}`;
    }
    
    // 确保双星光照
    if (!prompt.includes('dual') && !prompt.includes('twin')) {
      prompt += ' Binary star system visible in sky, dual-source lighting.';
    }
    
    return prompt;
  }

  /**
   * 注入运镜描述
   */
  _injectCameraMovement(prompt, movement) {
    if (movement.description) {
      prompt += ` Camera: ${movement.description}.`;
    }
    
    if (movement.isFPV) {
      prompt += ' 第一人称视角, 沉浸式FPV电影摄影。';;
    }
    
    return prompt;
  }

  /**
   * 注入嘴部动作
   */
  _injectMouthAction(prompt, mouthAction) {
    if (mouthAction && !prompt.includes(mouthAction.substring(0, 20))) {
      prompt += ` Character action: ${mouthAction}.`;
    }
    return prompt;
  }

  /**
   * 字数优化（填充至目标长度）
   */
  _optimizeLength(prompt, params) {
    const currentLength = prompt.length;
    
    if (currentLength >= this.targetLength) {
      return prompt;
    }
    
    const deficit = this.targetLength - currentLength;
    const fillers = [];
    
    // 1. 填充材质细节
    if (params.sceneName) {
      const materialDesc = this._getMaterialDescription(params.sceneName);
      if (materialDesc) fillers.push(materialDesc);
    }
    
    // 2. 填充光照细节
    const lightingDesc = this._getLightingDescription(params.emotionPhase);
    fillers.push(lightingDesc);
    
    // 3. 填充环境细节
    const envDesc = this._getEnvironmentDescription(params.sceneName);
    fillers.push(envDesc);
    
    // 4. 填充质感增强
    const qualityBoost = [
      'Subsurface scattering on skin and translucent materials.',
      'Volumetric god-rays piercing through atmospheric haze.',
      'Microscopic dust particles floating in light beams.',
      'Anisotropic reflections on wet surfaces.',
      '边缘色散模拟电影级真实感.'
    ];
    
    // 按需要填充
    let added = 0;
    for (const filler of fillers) {
      if (added < deficit) {
        prompt += ` ${filler}`;
        added += filler.length;
      }
    }
    
    // 如果还不够，添加通用质感
    if (prompt.length < this.targetLength) {
      const needChars = this.targetLength - prompt.length;
      const itemsToAdd = Math.min(Math.ceil(needChars / 80), qualityBoost.length);
      prompt += ' ' + qualityBoost.slice(0, itemsToAdd).join(' ');
    }
    
    // 确保不超过上限
    if (prompt.length > this.maxLength) {
      prompt = prompt.substring(0, this.maxLength - 3) + '...';
    }
    
    return prompt;
  }

  /**
   * 获取材质描述
   */
  _getMaterialDescription(sceneName) {
    const materials = {
      '永夜裂谷': 'Materials: obsidian-glass cliffs with internal glow, superconductor-crystal formations pulsing electric blue.',
      '青丘灵原': 'Materials: bioluminescent-tissue grass blades, memory-moss carpets glowing under twin stars.',
      '钟山之巅': 'Materials: supercritical-fluid lava pools, obsidian-glass formations.',
      'default': 'Materials: Nirath-native substances with unique optical properties.'
    };
    
    return materials[sceneName] || materials['default'];
  }

  /**
   * 获取光照描述
   */
  _getLightingDescription(emotionPhase) {
    const lighting = {
      'establishing': 'Lighting: soft ambient, dual-star rose-glow, gentle bioluminescent fill.',
      'awe': 'Lighting: dramatic contrast, intense key light, deep shadows with bioluminescent accents.',
      'tension': 'Lighting: sharp shadows, high contrast, flickering light sources.',
      'triumph': '光照: 明亮全光谱, 金色神光, 体积光柱。',
      'default': 'Lighting: dual-star amber-violet, bioluminescent fill light pulses softly.'
    };
    
    return lighting[emotionPhase] || lighting['default'];
  }

  /**
   * 获取环境描述
   */
  _getEnvironmentDescription(sceneName) {
    const env = {
      '永夜裂谷': 'Environment: deep canyon with crystalline formations, floating spore particles, distant bioluminescent flora.',
      '青丘灵原': 'Environment: vast plains with gentle hills, floating seed pods, distant forest edge.',
      '钟山之巅': 'Environment: volcanic peak with smoke plumes, thermal vents glowing, distant lava flows.',
      'default': 'Environment: realistic medical or educational setting with natural lighting and authentic details.'
    };
    
    return env[sceneName] || env['default'];
  }

  /**
   * 合规检查
   */
  _checkCompliance(prompt) {
    const issues = [];
    
    for (const banned of this.bannedKeywords) {
      const regex = /[\u4e00-\u9fa5]/.test(banned)
        ? new RegExp(banned, 'gi')
        : new RegExp(`\\b${banned}\\b`, 'gi');
      
      if (regex.test(prompt)) {
        issues.push({
          type: 'banned_keyword',
          keyword: banned,
          message: `Prompt包含禁用词: ${banned}`
        });
      }
    }
    
    return {
      passed: issues.length === 0,
      issues,
      issueCount: issues.length
    };
  }

  /**
   * 批量构建Prompt
   */
  buildBatch(shots) {
    const results = [];
    
    for (const shot of shots) {
      const result = this.build({
        sceneName: shot.scene,
        script: shot.narration,
        characters: shot.characters,
        type: shot.type,
        emotionPhase: shot.emotionPhase,
        movement: shot.cameraMovement,
        mouthAction: shot.mouthAction
      });
      
      results.push({
        shotId: shot.id,
        ...result
      });
    }
    
    return results;
  }
}

module.exports = { PromptBuilder };

// CLI入口
if (require.main === module) {
  const builder = new PromptBuilder({ mode: 'nirath' });
  
  const result = builder.build({
    sceneName: '永夜裂谷',
    script: '我是小G，今天带大家来到永夜裂谷',
    characters: ['xiaoG'],
    type: 'opening',
    emotionPhase: 'establishing',
    mouthAction: '嘴部张开说话，右手抬起打招呼'
  });
  
  console.log('\n=== Prompt构建结果 ===');
  console.log(`字数: ${result.length}`);
  console.log(`利用率: ${result.utilization}%`);
  console.log(`状态: ${result.utilizationStatus}`);
  console.log(`合规: ${result.compliance.passed ? '通过' : '未通过'}`);
  console.log('\n=== Prompt内容 ===');
  console.log(result.prompt);
}
