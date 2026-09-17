/**
 * Dialogue Distributor v1.0
 * 台词分配专家 — 叙事文本 → 旁白 + 角色台词
 * 
 * 职责：
 * 1. 把叙事文本拆解为【旁白/Voiceover】和【角色台词/Dialogue】
 * 2. 旁白：第三人称场景描述、背景交代、主题升华
 * 3. 台词：角色直接说出的语言，推动关系/揭示性格
 * 4. 角色台词必须指定 SPEAKER + TYPE + TEXT
 * 5. 动作描述留在【视觉】或【角色动作】字段，不混入台词
 * 
 * 话语类型：
 * - DIALOGUE: 角色间对话，必须对嘴
 * - MONOLOGUE: 角色独白，对嘴
 * - WHISPER: 低语/耳语，对嘴但幅度小
 * - TELEPATHY: 心灵感应，不对嘴，用眼神+音效
 * - NARRATION: 画外音旁白，不对嘴
 * 
 * @version v1.0
 * @author 小G
 */

class DialogueDistributor {
  constructor(options = {}) {
    this.options = options;
    
    // 【v6.2-patch89-底层约束】旁白归零
// 系统级原则：影片里不要旁白（Voiceover），所有叙事必须通过角色台词（Dialogue）直接表达
// 原因：旁白辅助表现是低质量的，真正的电影叙事是角色自己说出来的
const NO_VOICEOVER = true;
    this.DIALOGUE_TYPES = {
      DIALOGUE: { label: '对话', lipSync: true, mouthIntensity: 'normal' },
      MONOLOGUE: { label: '独白', lipSync: true, mouthIntensity: 'expressive' },
      WHISPER: { label: '低语', lipSync: true, mouthIntensity: 'subtle' },
      TELEPATHY: { label: '心灵感应', lipSync: false, mouthIntensity: 'none' },
      NARRATION: { label: '旁白', lipSync: false, mouthIntensity: 'none' }
    };
  }

  /**
   * 主入口：从镜头中提取台词（旁白归零，全部转为角色台词）
   * 【v6.2-patch89-底层约束】NO_VOICEOVER = true
   * 所有叙事文本必须转化为角色直接说出的台词，禁止第三人称旁白
   * @param {Object} shot - 镜头数据
   * @returns {Object} { dialogue, hasDialogue }
   */
  distribute(shot) {
    const result = {
      dialogue: [],
      hasDialogue: false
    };
    
    // 如果已有 dialogue 字段，直接使用（但过滤掉任何 NARRATION 类型）
    if (shot.dialogue && shot.dialogue.length > 0) {
      result.dialogue = shot.dialogue.filter(d => d.type !== 'NARRATION');
      result.hasDialogue = result.dialogue.length > 0;
      return result;
    }
    
    // 从 narration 中提取（强制全部转为台词）
    const narration = shot.narration || '';
    if (!narration) return result;
    
    // 强制全部转为角色台词（独白或心灵感应）
    const allDialogue = this._convertAllToDialogue(narration, shot);
    
    result.dialogue = allDialogue;
    result.hasDialogue = allDialogue.length > 0;
    
    return result;
  }

  /**
   * 【v6.2-patch89-底层约束】强制全部转为角色台词
   * 所有 narration 文本必须转化为角色直接说出的台词
   * 策略：
   * 1. 场景描述 → 角色内心独白（小G观察到的）
   * 2. 神兽动作 → 心灵感应（TELEPATHY）
   * 3. 情感描述 → 角色独白（MONOLOGUE）
   * 4. 禁止任何第三人称旁白
   */
  _convertAllToDialogue(narration, shot) {
    const dialogueLines = [];
    const characters = shot.characters || [];
    
    // 如果 narration 为空，返回空
    if (!narration || narration.trim().length === 0) return dialogueLines;
    
    // 按句子分割
    const sentences = narration.split(/([。！？\.\!\?]+)/).filter(s => s.trim());
    const fullSentences = [];
    for (let i = 0; i < sentences.length; i += 2) {
      const text = sentences[i];
      const punct = sentences[i + 1] || '。';
      if (text.trim()) {
        fullSentences.push(text + punct);
      }
    }
    
    // 确定主要说话者（根据镜头角色）
    const mainSpeaker = this._inferMainSpeaker(narration, characters);
    
    // 如果有神兽角色，检测神兽相关描述 → 转为心灵感应
    const beastId = characters.find(c => ['tao-tie', 'zhu-long', 'jiu-wei'].includes(c));
    
    // 分段处理：把场景描述转为角色的"所见所感"独白
    let monologueText = '';
    let telepathyText = '';
    
    for (const sentence of fullSentences) {
      const trimmed = sentence.trim();
      if (!trimmed) continue;
      
      // 检测是否包含神兽动作/特征 → 转为神兽心灵感应
      if (beastId && this._isBeastDescription(trimmed, beastId)) {
        if (telepathyText) telepathyText += '，';
        telepathyText += trimmed;
      } else {
        // 其他描述 → 转为角色独白（主角观察到的）
        if (monologueText) monologueText += '，';
        monologueText += trimmed;
      }
    }
    
    // 构建独白台词
    if (monologueText && mainSpeaker) {
      // 将第三人称描述转化为第一人称内心独白
      const firstPersonText = this._convertToFirstPerson(monologueText, mainSpeaker);
      dialogueLines.push({
        speaker: mainSpeaker,
        type: 'MONOLOGUE',
        text: firstPersonText,
        lipSync: true,
        emotion: this._inferEmotion(monologueText)
      });
    }
    
    // 构建心灵感应台词
    if (telepathyText && beastId) {
      dialogueLines.push({
        speaker: beastId,
        type: 'TELEPATHY',
        text: telepathyText,
        lipSync: false,
        emotion: this._inferEmotion(telepathyText)
      });
    }
    
    return dialogueLines;
  }

  /**
   * 推断主要说话者（主角优先）
   */
  _inferMainSpeaker(narration, characters) {
    if (characters.includes('xiaoG')) return 'xiaoG';
    if (characters.includes('nuanNuan')) return 'nuanNuan';
    if (characters.length > 0) return characters[0];
    return 'unknown';
  }

  /**
   * 检测是否是神兽描述
   */
  _isBeastDescription(sentence, beastId) {
    const beastKeywords = {
      'tao-tie': ['饕餮', '羊身', '人面', '巨口', '利齿', '腋下', '蹄', '角', '吞噬'],
      'zhu-long': ['烛龙', '蛇身', '赤色', '睁眼', '闭眼', '竖瞳', '龙'],
      'jiu-wei': ['九尾', '狐', '尾巴', '白毛', '媚']
    };
    
    const keywords = beastKeywords[beastId] || [];
    return keywords.some(kw => sentence.includes(kw));
  }

  /**
   * 将第三人称描述转化为第一人称内心独白
   * 例："小G站在钩吾废墟边缘" → "我站在这片废墟边缘，感受到..."
   */
  _convertToFirstPerson(text, speaker) {
    // 替换主语
    let converted = text
      .replace(/小G/g, '我')
      .replace(/主角/g, '我')
      .replace(/少年/g, '我');
    
    // 添加内心感受前缀（如果还没有）
    if (!converted.includes('我') && !converted.includes('感到') && !converted.includes('觉得')) {
      converted = '我看到' + converted;
    }
    
    return converted;
  }

  /**
   * 分类句子：旁白 vs 台词
   */
  _classifySentence(sentence, shot) {
    const result = {
      isDialogue: false,
      speaker: '',
      type: 'NARRATION',
      text: sentence,
      lipSync: false,
      emotion: '中性'
    };
    
    // 1. 直接引语检测（带引号）
    const quoteMatch = sentence.match(/[\"\']([^\"\']+)[\"\']/);
    if (quoteMatch) {
      result.isDialogue = true;
      result.type = 'DIALOGUE';
      result.text = quoteMatch[1];
      result.lipSync = true;
      result.speaker = this._inferSpeaker(sentence, shot);
      result.emotion = this._inferEmotion(sentence);
      return result;
    }
    
    // 2. 内心独白检测（"想"、"心想"、"默念"等）
    const innerPatterns = ['心想', '想', '默念', '告诉自己', '内心'];
    if (innerPatterns.some(p => sentence.includes(p))) {
      result.isDialogue = true;
      result.type = 'MONOLOGUE';
      result.text = sentence.replace(/.*?[心想默念告诉自己].*?[：:]?/, '').trim();
      result.lipSync = true;
      result.speaker = this._inferSpeaker(sentence, shot);
      result.emotion = this._inferEmotion(sentence);
      if (!result.text) result.text = sentence; // 如果提取失败，用原句
      return result;
    }
    
    // 3. 低语/耳语检测
    const whisperPatterns = ['低语', '耳语', '轻声', '悄悄', '呢喃'];
    if (whisperPatterns.some(p => sentence.includes(p))) {
      result.isDialogue = true;
      result.type = 'WHISPER';
      result.text = sentence;
      result.lipSync = true;
      result.speaker = this._inferSpeaker(sentence, shot);
      result.emotion = this._inferEmotion(sentence);
      return result;
    }
    
    // 4. 神兽心灵感应/共鸣检测（无人类语言，用磁场/眼神/共鸣）
    const telepathyPatterns = ['注视', '凝视', '共鸣', '震颤', '感应', '磁场', '眼神', '目光'];
    const beastPatterns = ['饕餮', 'tao-tie', '神兽', '巨兽'];
    if (telepathyPatterns.some(p => sentence.includes(p)) && beastPatterns.some(p => sentence.includes(p))) {
      result.isDialogue = true;
      result.type = 'TELEPATHY';
      result.text = sentence;
      result.lipSync = false;
      result.speaker = 'tao-tie';
      result.emotion = this._inferEmotion(sentence);
      return result;
    }
    
    // 5. 角色直接动作+心理（可作为独白）
    const actionDialoguePatterns = ['鼓起勇气', '深吸一口气', '咬牙', '下定决心'];
    if (actionDialoguePatterns.some(p => sentence.includes(p))) {
      const speaker = this._inferSpeaker(sentence, shot);
      // 如果主角动作，转化为内心独白
      if (speaker === 'xiaoG') {
        result.isDialogue = true;
        result.type = 'MONOLOGUE';
        result.text = sentence;
        result.lipSync = true;
        result.speaker = speaker;
        result.emotion = this._inferEmotion(sentence);
        return result;
      }
    }
    
    // 默认：旁白
    return result;
  }

  /**
   * 推断说话者
   */
  _inferSpeaker(sentence, shot) {
    const characters = shot.characters || [];
    
    // 1. 句子主语检测
    if (sentence.includes('小G') || sentence.includes('少年')) return 'xiaoG';
    if (sentence.includes('饕餮') || sentence.includes('tao-tie')) return 'tao-tie';
    
    // 2. 根据镜头角色推断
    if (characters.length === 1) return characters[0];
    if (characters.length > 1) {
      // 多角色时，根据动作推断
      if (sentence.includes('注视') || sentence.includes('看') || sentence.includes('后退')) {
        // 通常是小G在看/后退
        return 'xiaoG';
      }
    }
    
    return characters[0] || 'unknown';
  }

  /**
   * 推断情绪
   */
  _inferEmotion(sentence) {
    const emotionMap = {
      '激动': '激动',
      '紧张': '紧张',
      '恐惧': '恐惧',
      '愤怒': '愤怒',
      '温柔': '温柔',
      '坚定': '坚定',
      '犹豫': '犹豫',
      '悲伤': '悲伤',
      '喜悦': '喜悦',
      '惊讶': '惊讶',
      '敬畏': '敬畏',
      '勇气': '坚定',
      '鼓起勇气': '坚定',
      '小心翼翼': '谨慎',
      '缓缓': '平静',
      '轻轻': '温柔',
      '震撼': '震撼',
      '绝望': '绝望'
    };
    
    for (const [keyword, emotion] of Object.entries(emotionMap)) {
      if (sentence.includes(keyword)) return emotion;
    }
    
    return '中性';
  }

  /**
   * 提取独白（当没有直接检测到台词时）
   * 【v6.2-patch88-fix】严格模式：只有明确的内心独白标记才提取
   * 避免把第三人称旁白中的"感到""觉得"等词误判为角色台词
   */
  _extractMonologue(narration, shot) {
    // 严格的内心独白标记（必须包含这些明确的标记词）
    const strictMonologueMarkers = ['心想', '心中暗想', '默念', '告诉自己', '内心独白', '自言自语'];
    const hasStrictMarker = strictMonologueMarkers.some(p => narration.includes(p));
    
    // 如果没有严格标记，不提取独白（保持纯旁白）
    if (!hasStrictMarker) {
      return null;
    }
    
    // 有严格标记时，提取独白内容
    const speaker = this._inferSpeaker(narration, shot);
    
    // 提取独白文本（从标记词后面开始）
    let monologueText = narration;
    for (const marker of strictMonologueMarkers) {
      const idx = narration.indexOf(marker);
      if (idx >= 0) {
        // 找到标记词，提取后面的内容（去除"："或":"）
        monologueText = narration.substring(idx + marker.length)
          .replace(/^[：:]/, '')
          .trim();
        break;
      }
    }
    
    if (!monologueText) return null;
    
    return {
      speaker: speaker,
      type: 'MONOLOGUE',
      text: monologueText.substring(0, 100), // 限制长度
      lipSync: true,
      emotion: this._inferEmotion(narration)
    };
  }

  /**
   * 格式化台词为 Prompt 可用的标记
   */
  formatForPrompt(dialogue, voiceover) {
    const parts = [];
    
    // 1. 旁白标记
    if (voiceover) {
      parts.push(`[VOICEOVER]\n${voiceover}`);
    }
    
    // 2. 台词标记
    for (const line of dialogue) {
      const typeLabel = this.DIALOGUE_TYPES[line.type]?.label || line.type;
      const lipSyncTag = line.lipSync ? ' LIP_SYNC:yes' : ' LIP_SYNC:no';
      
      parts.push(`[DIALOGUE speaker="${line.speaker}" type="${line.type}" emotion="${line.emotion}"${lipSyncTag}]\n${line.text}`);
    }
    
    return parts.join('\n\n');
  }

  /**
   * 检查嘴型动作与台词的硬关联
   * @returns {Object} { valid, issues }
   */
  validateLipSync(shot) {
    const issues = [];
    const hasMouthAction = !!(shot.mouthAction && shot.mouthAction.includes('嘴部'));
    const hasDialogue = shot.dialogue && shot.dialogue.length > 0;
    const hasLipSyncDialogue = hasDialogue && shot.dialogue.some(d => d.lipSync);
    
    // 规则1：有台词且需要对嘴 → 必须有 mouthAction
    if (hasLipSyncDialogue && !hasMouthAction) {
      issues.push({
        severity: 'high',
        message: `镜头 ${shot.shotId} 有角色台词(LIP_SYNC:yes)但无嘴型动作描述`,
        fix: '添加 mouthAction: 嘴部自然张开正在说话，口型动作自然流畅'
      });
    }
    
    // 规则2：有 mouthAction 但无台词 → 嘴型动作无意义
    if (hasMouthAction && !hasLipSyncDialogue) {
      issues.push({
        severity: 'medium',
        message: `镜头 ${shot.shotId} 有嘴型动作但无角色台词，角色在"对嘴型说话"但说的是空气`,
        fix: '要么添加角色台词，要么移除嘴型动作（如果是旁白不需要对嘴）'
      });
    }
    
    return {
      valid: issues.length === 0,
      issues
    };
  }
}

module.exports = { DialogueDistributor };
