'use strict';

const SpeechRate = require('../config/speech-rate');

/**
 * Dialogue Timing Calculator
 * 台词时长计算器
 * 
 * 核心功能：
 * 1. 根据台词字数和语速计算朗读时长
 * 2. 校验台词时长 vs 镜头时长是否匹配
 * 3. 提供自动调整建议
 * 
 * v1.0.0 | 2026-06-30
 */

class DialogueTimingCalculator {
  constructor(options = {}) {
    // 【一致性修复】语速从唯一真源读取
    this.speechRates = { ...SpeechRate.RATES, ...options.speechRates };

    // 配置参数
    this.config = {
      // 台词占镜头时长的最大比例（留余量给动作/表情）
      maxDialogueRatio: SpeechRate.MAX_DIALOGUE_RATIO,
      // 台词占镜头时长的警告比例
      warningDialogueRatio: 0.6,
      // 最小镜头时长（秒）
      minShotDuration: 3,
      // 最大单句台词字数
      maxLineLength: 50,
      // 是否自动调整
      autoAdjust: options.autoAdjust !== false,
      // 调整策略：'shorten'（缩短台词）|'extend'（延长镜头）|'smart'（智能选择）
      adjustStrategy: options.adjustStrategy || 'smart',
      ...options
    };
  }

  /**
   * 计算台词朗读时长（秒）
   * @param {string|Object} dialogue - 台词文本或台词对象
   * @param {string} emotion - 情绪类型（影响语速）
   * @returns {number} 朗读时长（秒）
   */
  calculateDuration(dialogue, emotion = 'normal') {
    const text = this._extractText(dialogue);
    if (!text) return 0;

    const charCount = this._countChars(text);
    const rate = this._getSpeechRate(emotion);
    
    // 基础时长 = 字数 / 语速
    let duration = charCount / rate;
    
    // 标点符号停顿补偿（每个标点+0.3秒）
    const punctuationCount = (text.match(/[，。！？；：""''（）、]/g) || []).length;
    duration += punctuationCount * 0.3;
    
    // 句末停顿补偿（每句+0.5秒）
    const sentenceCount = (text.match(/[。！？]/g) || []).length;
    duration += sentenceCount * 0.5;

    return Math.ceil(duration);
  }

  /**
   * 校验单个镜头的台词时长
   * @param {Object} shot - 镜头对象
   * @returns {Object} 校验结果
   */
  validateShot(shot) {
    if (!shot) {
      return { valid: false, error: '镜头对象为空' };
    }

    const shotDuration = shot.duration || shot.timing?.duration;
    if (!shotDuration || shotDuration <= 0) {
      return { valid: false, error: '镜头时长无效' };
    }

    // 检查是否有台词
    const dialogue = shot.dialogue;
    if (!dialogue || (!dialogue.lines?.length && !dialogue.blocks?.length && !dialogue.text)) {
      return { valid: true, hasDialogue: false }; // 无台词，无需校验
    }

    // 计算台词时长
    const emotion = shot.emotion || shot.mood || 'normal';
    const dialogueDuration = this.calculateDuration(dialogue, emotion);
    
    if (dialogueDuration === 0) {
      return { valid: true, hasDialogue: false };
    }

    const ratio = dialogueDuration / shotDuration;

    // 情况1：台词溢出（台词时长 > 镜头时长）
    if (dialogueDuration > shotDuration) {
      const overflow = dialogueDuration - shotDuration;
      const suggestedMaxChars = Math.floor(shotDuration * this.speechRates.normal);
      
      return {
        valid: false,
        severity: 'critical',
        issue: '台词溢出',
        hasDialogue: true,
        dialogueDuration,
        shotDuration,
        overflow,
        ratio: ratio.toFixed(2),
        suggestion: `台词需${dialogueDuration}秒，镜头仅${shotDuration}秒（溢出${overflow}秒）。建议缩短台词至${suggestedMaxChars}字以内，或延长镜头至${dialogueDuration}秒`,
        autoFix: this.config.autoAdjust ? this._generateFix(shot, 'overflow') : null
      };
    }

    // 情况2：台词占比过高（>80%）
    if (ratio > this.config.maxDialogueRatio) {
      return {
        valid: true,
        severity: 'warning',
        issue: '台词占比过高',
        hasDialogue: true,
        dialogueDuration,
        shotDuration,
        ratio: (ratio * 100).toFixed(1) + '%',
        suggestion: `台词占${(ratio * 100).toFixed(1)}%，建议缩短台词或增加镜头时长，留出动作表演空间`,
        autoFix: this.config.autoAdjust ? this._generateFix(shot, 'high_ratio') : null
      };
    }

    // 情况3：台词占比警告（>60%）
    if (ratio > this.config.warningDialogueRatio) {
      return {
        valid: true,
        severity: 'info',
        issue: '台词占比偏高',
        hasDialogue: true,
        dialogueDuration,
        shotDuration,
        ratio: (ratio * 100).toFixed(1) + '%',
        suggestion: `台词占${(ratio * 100).toFixed(1)}%，可考虑增加动作或表情描述`,
        autoFix: null
      };
    }

    // 情况4：正常
    return {
      valid: true,
      severity: 'ok',
      issue: null,
      hasDialogue: true,
      dialogueDuration,
      shotDuration,
      ratio: (ratio * 100).toFixed(1) + '%',
      suggestion: null,
      autoFix: null
    };
  }

  /**
   * 批量校验剧本的所有镜头
   * @param {Array} shots - 镜头数组
   * @returns {Object} 批量校验结果
   */
  validateShots(shots) {
    if (!Array.isArray(shots)) {
      return { valid: false, error: '镜头数组无效' };
    }

    const results = shots.map((shot, index) => ({
      shotIndex: index,
      shotId: shot.shot_id || shot.scene_id || `S-${index + 1}`,
      ...this.validateShot(shot)
    }));

    const criticalIssues = results.filter(r => r.severity === 'critical');
    const warnings = results.filter(r => r.severity === 'warning');
    const infos = results.filter(r => r.severity === 'info');

    return {
      valid: criticalIssues.length === 0,
      totalShots: shots.length,
      shotsWithDialogue: results.filter(r => r.hasDialogue).length,
      criticalCount: criticalIssues.length,
      warningCount: warnings.length,
      infoCount: infos.length,
      results,
      summary: this._generateSummary(results)
    };
  }

  /**
   * 生成自动修复建议
   */
  _generateFix(shot, issueType) {
    const strategy = this.config.adjustStrategy;
    const shotDuration = shot.duration || shot.timing?.duration;
    const dialogue = shot.dialogue;
    const text = this._extractText(dialogue);
    const currentChars = this._countChars(text);

    if (issueType === 'overflow') {
      // 台词溢出
      if (strategy === 'shorten' || strategy === 'smart') {
        // 缩短台词
        const targetChars = Math.floor(shotDuration * this.speechRates.normal);
        const shortened = this._shortenText(text, targetChars);
        return {
          type: 'shorten_dialogue',
          description: '缩短台词至适合镜头时长',
          originalText: text,
          suggestedText: shortened,
          originalChars: currentChars,
          targetChars
        };
      } else if (strategy === 'extend') {
        // 延长镜头
        const dialogueDuration = this.calculateDuration(dialogue);
        return {
          type: 'extend_shot',
          description: '延长镜头时长以容纳台词',
          originalDuration: shotDuration,
          suggestedDuration: dialogueDuration + 2 // +2秒余量
        };
      }
    } else if (issueType === 'high_ratio') {
      // 台词占比过高
      if (strategy === 'extend' || strategy === 'smart') {
        // 延长镜头
        const targetDuration = Math.ceil(currentChars / this.speechRates.normal / 0.6);
        return {
          type: 'extend_shot',
          description: '延长镜头时长以降低台词占比',
          originalDuration: shotDuration,
          suggestedDuration: targetDuration
        };
      }
    }

    return null;
  }

  /**
   * 缩短文本至目标字数
   */
  _shortenText(text, targetChars) {
    if (text.length <= targetChars) return text;
    
    // 优先保留前半句（通常包含关键信息）
    let shortened = text.substring(0, targetChars);
    
    // 尽量在句末截断
    const lastPunctuation = shortened.lastIndexOf('。');
    if (lastPunctuation > targetChars * 0.7) {
      shortened = shortened.substring(0, lastPunctuation + 1);
    }
    
    return shortened;
  }

  /**
   * 生成校验摘要
   */
  _generateSummary(results) {
    const critical = results.filter(r => r.severity === 'critical');
    const warnings = results.filter(r => r.severity === 'warning');

    if (critical.length > 0) {
      return `发现 ${critical.length} 个严重问题：台词溢出。需要修复后才能继续。`;
    } else if (warnings.length > 0) {
      return `发现 ${warnings.length} 个警告：台词占比过高。建议优化。`;
    } else {
      return '所有镜头台词时长校验通过。';
    }
  }

  /**
   * 提取台词文本
   */
  _extractText(dialogue) {
    if (!dialogue) return '';
    if (typeof dialogue === 'string') return dialogue;
    if (dialogue.text) return dialogue.text;
    if (dialogue.lines && Array.isArray(dialogue.lines) && dialogue.lines.length > 0) {
      return dialogue.lines.map(l => l.text || l).join('');
    }
    if (dialogue.blocks && Array.isArray(dialogue.blocks) && dialogue.blocks.length > 0) {
      return dialogue.blocks.map(b => b.line || b.text || '').join('');
    }
    return '';
  }

  /**
   * 统计中文字符数
   */
  _countChars(text) {
    if (!text) return 0;
    // 匹配中文字符、英文单词、数字
    const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    const englishWords = (text.match(/[a-zA-Z]+/g) || []).length;
    const numbers = (text.match(/\d+/g) || []).length;
    return chineseChars + englishWords + numbers;
  }

  /**
   * 获取语速
   */
  _getSpeechRate(emotion) {
    const emotionMap = {
      'calm': 'slow',
      'sad': 'slow',
      'peaceful': 'slow',
      'normal': 'normal',
      'neutral': 'normal',
      'happy': 'normal',
      'excited': 'fast',
      'tense': 'fast',
      'angry': 'fast',
      'urgent': 'rapid',
      'panic': 'rapid'
    };

    const rateKey = emotionMap[emotion?.toLowerCase()] || 'normal';
    return this.speechRates[rateKey] || this.speechRates.normal;
  }
}

module.exports = { DialogueTimingCalculator };

// 自检
if (require.main === module) {
  const calc = new DialogueTimingCalculator();
  
  console.log('[自检] 语速配置:', calc.speechRates);
  
  // 测试1：正常台词
  const text1 = '孙悟空，你逃不出我的手掌心！';
  const duration1 = calc.calculateDuration(text1, 'angry');
  console.log(`[自检] "${text1}" 愤怒语速: ${duration1}秒`);
  
  // 测试2：溢出场景
  const shot2 = {
    shot_id: 'S-01',
    duration: 5,
    emotion: 'normal',
    dialogue: {
      lines: [{ text: '大圣，这妖怪好生厉害，我们需得从长计议，不可轻举妄动啊！' }]
    }
  };
  const result2 = calc.validateShot(shot2);
  console.log('[自检] 溢出检测结果:', result2.issue, result2.suggestion);
  
  // 测试3：批量校验
  const shots = [
    { shot_id: 'S-01', duration: 10, emotion: 'normal', dialogue: { lines: [{ text: '你好世界' }] } },
    { shot_id: 'S-02', duration: 5, emotion: 'angry', dialogue: { lines: [{ text: '这是很长的台词，应该溢出' }] } },
    { shot_id: 'S-03', duration: 8, emotion: 'calm', dialogue: { lines: [{ text: '平静地说一些话' }] } }
  ];
  const batch = calc.validateShots(shots);
  console.log('[自检] 批量校验:', batch.summary);
}
