/**
 * 通道分离系统 v1.0 (P0-2)
 * 旁白/视觉/口型三通道严格分离
 *
 * 核心设计：
 * - Narration Channel: 旁白文本 → TTS音频，绝不进入视觉Prompt
 * - Visual Prompt Channel: 纯视觉描述语言，仅画面可见内容
 * - Lip-Sync Channel: 仅画面内角色说话时启用，简化口型标签
 *
 * 约束：
 * - 旁白文学性叙事语言 ≠ 视觉描述语言
 * - 非说话场景绝不注入嘴部动作
 * - 每个通道独立输出，下游按需取用
 *
 * @version v1.0
 * @author 小G
 */

class PromptChannelSeparator {
  constructor(options = {}) {
    this.verbose = options.verbose || false;
    
    // 旁白→视觉转换词典（文学描述 → 视觉动作）
    this.narrationToVisualMap = {
      // 动作类
      '拨开': 'pushing aside',
      '迈出一步': 'stepping forward',
      '向前走去': 'walking forward',
      '停下脚步': 'stopping, standing still',
      '回头望去': 'turning head to look back',
      '抬头仰望': 'looking up',
      '蹲下身子': 'crouching down',
      '伸出手': 'extending hand',
      '后退一步': 'stepping back',
      '转身离开': 'turning around and walking away',
      // 情绪类
      '感到恐惧': 'fear showing in eyes',
      '充满好奇': 'curious expression',
      '感到敬畏': 'awe in expression',
      '露出微笑': 'smiling gently',
      // 环境类
      '深处': 'deep within',
      '旁边': 'beside',
      '前方': 'in the foreground'
    };
    
    // 视觉黑名单（旁白专属词汇，禁止进入视觉Prompt）
    this.visualBlacklist = [
      '然后', '接着', '突然', '于是', '但是', '然而',
      '他意识到', '她感到', '心中', '脑海里', '回忆',
      '仿佛', '好像', '似乎', '如同',
      '不知为何', '不知什么时候', '不知过了多久',
      '也许', '可能', '大概', '或许',
      '一边...一边', '不仅...还', '虽然...但是'
    ];
  }

  /**
   * 主入口：分离三通道
   * @param {Object} input - 输入数据
   * @param {string} input.narration - 旁白文本（文学性叙事）
   * @param {Object} input.scene - 场景信息
   * @param {Array} input.characters - 角色列表
   * @param {string} input.emotionPhase - 情绪阶段
   * @param {boolean} input.hasDialogue - 是否有画面内对话
   * @returns {Object} { narration, visualPrompt, lipSync }
   */
  separate(input) {
    const startTime = Date.now();
    console.log(`[ChannelSeparator] 🔧 三通道分离开始 | 场景: ${input.scene?.name || 'unknown'}`);
    
    // Step 1: 提取Narration通道（原始旁白，不变）
    const narration = this._extractNarration(input);
    
    // Step 2: 生成Visual Prompt通道（纯视觉描述）
    const visualPrompt = this._generateVisualPrompt(input, narration);
    
    // Step 3: 生成Lip-Sync通道（仅说话时启用）
    const lipSync = this._generateLipSync(input);
    
    // Step 4: 验证通道纯度
    const purity = this._validatePurity(narration, visualPrompt, lipSync);
    
    const duration = Date.now() - startTime;
    console.log(`[ChannelSeparator] ✅ 三通道分离完成 | 耗时: ${duration}ms`);
    console.log(`  Narration: ${narration.text.length}字符`);
    console.log(`  Visual: ${visualPrompt.length}字符`);
    console.log(`  LipSync: ${lipSync ? lipSync.length : 0}字符`);
    console.log(`  纯度检查: ${purity.passed ? '✅通过' : '❌有污染'}`);
    
    return {
      narration: {
        text: narration.text,
        ttsReady: narration.ttsReady,
        duration: narration.duration
      },
      visualPrompt: {
        text: visualPrompt,
        hasLipSync: !!lipSync
      },
      lipSync: lipSync ? {
        text: lipSync,
        active: input.hasDialogue === true
      } : null,
      purity,
      duration
    };
  }

  /**
   * 提取Narration通道
   * 保留原始旁白文本，不做修改
   */
  _extractNarration(input) {
    const text = input.narration || input.script || '';
    
    // 估算TTS时长（中文约5字符/秒，英文约12字符/秒）
    const cnChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    const enChars = text.length - cnChars;
    const duration = Math.ceil(cnChars / 5 + enChars / 12);
    
    return {
      text,
      ttsReady: true,
      duration
    };
  }

  /**
   * 生成Visual Prompt通道
   * 核心转换：旁白文学语言 → 视觉描述语言
   */
  _generateVisualPrompt(input, narration) {
    const parts = [];
    
    // 1. 场景基础视觉描述
    const sceneVisual = this._buildSceneVisual(input.scene);
    if (sceneVisual) parts.push(sceneVisual);
    
    // 2. 角色视觉描述（不含心理状态）
    const charVisual = this._buildCharacterVisual(input.characters, input.emotionPhase);
    if (charVisual) parts.push(charVisual);
    
    // 3. 从旁白中提取视觉动作（过滤心理/文学描述）
    const actionsFromNarration = this._extractVisualActions(narration.text);
    if (actionsFromNarration) parts.push(actionsFromNarration);
    
    // 4. 情绪视觉化（仅面部表情/肢体语言）
    const emotionVisual = this._buildEmotionVisual(input.emotionPhase);
    if (emotionVisual) parts.push(emotionVisual);
    
    return parts.filter(Boolean).join(', ');
  }

  /**
   * 生成Lip-Sync通道
   * 仅当画面内有角色说话时才生成
   */
  _generateLipSync(input) {
    // 只有明确标记hasDialogue=true时才生成
    if (input.hasDialogue !== true) {
      return null;
    }
    
    // 简化口型标签，仅标记说话状态
    const speaker = input.speakingCharacter || 'character';
    const intensity = input.speechIntensity || 'normal'; // whisper/normal/shout
    
    const lipSyncMap = {
      'whisper': `${speaker} lips moving gently, soft whispering expression`,
      'normal': `${speaker} mouth moving naturally, speaking expression`,
      'shout': `${speaker} mouth open wider, intense speaking expression`
    };
    
    return lipSyncMap[intensity] || lipSyncMap['normal'];
  }

  /**
   * 构建场景视觉描述
   */
  _buildSceneVisual(scene) {
    if (!scene) return '';
    
    // 使用sceneCore（视觉核心）而非完整场景描述
    const core = scene.sceneCore || scene.visualCore || scene.name || '';
    const shotType = scene.shotType || '电影级镜头';
    
    return `${shotType}, ${core}`;
  }

  /**
   * 构建角色视觉描述
   * 仅保留外貌+动作，过滤心理描述
   */
  _buildCharacterVisual(characters, emotionPhase) {
    if (!characters || characters.length === 0) return '';
    
    const descs = characters.map(char => {
      const visualParts = [];
      
      // 外貌（始终保留）
      if (char.appearance) visualParts.push(char.appearance);
      else if (char.description) {
        // 过滤掉心理描述词
        const filtered = this._filterMentalDescription(char.description);
        visualParts.push(filtered);
      }
      
      // 当前动作（不含心理动词）
      if (char.currentAction) {
        visualParts.push(char.currentAction);
      }
      
      // 表情（按情绪阶段，仅面部）
      if (emotionPhase) {
        const expression = this._getExpressionByPhase(emotionPhase);
        visualParts.push(expression);
      }
      
      return visualParts.join(', ');
    });
    
    return descs.join(' and ');
  }

  /**
   * 从旁白中提取纯视觉动作
   * 过滤文学性/心理性描述
   */
  _extractVisualActions(narrationText) {
    if (!narrationText) return '';
    
    // 移除视觉黑名单词汇
    let cleaned = narrationText;
    for (const word of this.visualBlacklist) {
      cleaned = cleaned.replace(new RegExp(word, 'g'), '');
    }
    
    // 提取可视觉化的动作短语
    const actions = [];
    for (const [cn, en] of Object.entries(this.narrationToVisualMap)) {
      if (cleaned.includes(cn)) {
        actions.push(en);
      }
    }
    
    // 如果无匹配动作，返回空（不强制塞入旁白原文）
    return actions.join(', ');
  }

  /**
   * 构建情绪视觉化
   * 仅保留可视觉化的面部/肢体表现
   */
  _buildEmotionVisual(emotionPhase) {
    const visualMap = {
      'establishing': 'calm composed expression, relaxed posture',
      'rising': 'alert expression, body tensing slightly',
      'building': 'intense focused gaze, muscles engaged',
      'climax': 'powerful determined expression, dynamic posture',
      'resolve': 'peaceful gentle expression, relaxed shoulders',
      'opening': 'awe-inspired expression, eyes wide with wonder'
    };
    return visualMap[emotionPhase] || '';
  }

  /**
   * 过滤心理描述词
   */
  _filterMentalDescription(text) {
    const mentalWords = [
      '感到', '觉得', '认为', '心想', '回忆', '想念',
      'fearful mind', 'anxious thoughts', 'worried about',
      'thinking of', 'remembering', 'missing'
    ];
    
    let filtered = text;
    for (const word of mentalWords) {
      filtered = filtered.replace(new RegExp(`[^,.]*${word}[^,.]*`, 'g'), '');
    }
    return filtered.replace(/\s+/g, ' ').trim();
  }

  /**
   * 按情绪阶段获取表情
   */
  _getExpressionByPhase(phase) {
    const map = {
      'establishing': 'neutral relaxed facial expression',
      'rising': 'slight widening of eyes, subtle tension',
      'building': 'focused intense gaze, jaw slightly set',
      'climax': 'powerful determined expression, eyes sharp',
      'resolve': 'peaceful gentle smile, soft eyes',
      'opening': 'awe and wonder, eyes reflecting starlight'
    };
    return map[phase] || 'natural expression';
  }

  /**
   * 验证通道纯度
   * 确保旁白不污染视觉Prompt
   */
  _validatePurity(narration, visualPrompt, lipSync) {
    const issues = [];
    
    // 检查1: visualPrompt中是否含有旁白原文
    if (narration.text && visualPrompt) {
      // 抽样检查：取旁白前20个字符
      const sample = narration.text.substring(0, 20);
      if (visualPrompt.includes(sample) && sample.length > 10) {
        issues.push('visualPrompt含有旁白原文');
      }
    }
    
    // 检查2: 非说话场景是否含有lipSync
    if (!lipSync && visualPrompt) {
      const lipKeywords = ['mouth moving', 'lips', 'speaking expression', '嘴部'];
      for (const kw of lipKeywords) {
        if (visualPrompt.includes(kw)) {
          issues.push(`非说话场景出现口型关键词: ${kw}`);
        }
      }
    }
    
    // 检查3: visualPrompt中是否含心理描述词
    for (const word of this.visualBlacklist) {
      if (visualPrompt.includes(word)) {
        issues.push(`visualPrompt含旁白词汇: ${word}`);
      }
    }
    
    return {
      passed: issues.length === 0,
      issues,
      issueCount: issues.length
    };
  }
}

module.exports = { PromptChannelSeparator };
