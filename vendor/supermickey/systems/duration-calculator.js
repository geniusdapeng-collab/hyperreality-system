/**
 * 【系统级】时长计算器 v1
 * 根据 narration 字数自动计算镜头时长
 */

// 【v2.2.5-审计修复】语速从唯一真源 config/speech-rate.js 读取，
// 旧值 4.0-5.0 与真源基准（normal 3.5 / limit 4.5）冲突。
// 注意：本模块当前未被主链路引用（保留作历史参考）。
const SpeechRate = require('../hyperreality-system/config/speech-rate.js');

class DurationCalculator {
  constructor(config = {}) {
    this.config = {
      // 语速配置（字/秒）- 按场景类型动态选择，全部锚定真源档位
      speechSpeed: {
        'host': SpeechRate.RATES.slow,      // 开场白 - 偏慢，亲切感
        'explanation': SpeechRate.NORMAL,   // 科普讲解 - 标准
        'interaction': SpeechRate.RATES.fast, // 互动对话 - 偏快
        'symptom': SpeechRate.NORMAL,       // 症状讲解
        'lab': SpeechRate.NORMAL,           // 实验室讲解
        'summary': SpeechRate.RATES.slow,   // 总结 - 偏慢，清晰
        'default': SpeechRate.NORMAL
      },
      // API限制
      minDuration: 3,       // 最短3秒
      maxDuration: 15,       // Seedance API最大15秒（超短裙系统）
      // 缓冲时间（嘴巴动起来需要的时间）
      bufferSeconds: 0.5,
      ...config
    };
  }

  /**
   * 计算单镜时长
   * @param {string} narration - 口播原文
   * @param {string} shotType - 镜头类型
   * @returns {object} { duration, baseDuration, charCount, isValid, warning }
   */
  calculate(narration, shotType = 'default') {
    // 1. 计算中文字数（不含标点）
    const charCount = this.countChineseChars(narration);
    
    // 2. 获取语速
    const speed = this.config.speechSpeed[shotType] || this.config.speechSpeed.default;
    
    // 3. 计算基础时长（含缓冲）
    const baseDuration = (charCount / speed) + this.config.bufferSeconds;
    
    // 4. 应用约束
    const duration = Math.min(
      Math.max(Math.ceil(baseDuration), this.config.minDuration),
      this.config.maxDuration
    );
    
    // 5. 检查是否超限
    const isValid = baseDuration <= this.config.maxDuration;
    let warning = null;
    
    if (!isValid) {
      const maxChars = Math.floor((this.config.maxDuration - this.config.bufferSeconds) * speed);
      warning = {
        type: 'DURATION_OVERFLOW',
        message: `narration ${charCount}字需要约${Math.ceil(baseDuration)}秒，超过API限制${this.config.maxDuration}秒`,
        suggestion: `建议：\n1. 精简 narration 到 ${maxChars}字以内\n2. 或拆分为多镜（推荐）`,
        maxChars,
        currentChars: charCount
      };
    }
    
    return {
      duration,
      baseDuration: Math.ceil(baseDuration * 10) / 10, // 保留1位小数
      charCount,
      speed,
      isValid,
      warning,
      // v6.5.62-P1: 生成时间轴标记
      timeline: this._buildTimeline(duration, shotType)
    };
  }

  /**
   * 批量计算故事板所有镜头
   */
  calculateStoryboard(storyboard) {
    const shots = storyboard.shots || [];
    const results = [];
    let totalDuration = 0;
    let overflowCount = 0;

    console.log('⏱️  时长计算开始');
    console.log('='.repeat(60));

    shots.forEach(shot => {
      const narration = shot.narration || shot.line || '';
      const calc = this.calculate(narration, shot.type);
      
      // 更新故事板
      shot.duration = calc.duration;
      shot._durationCalc = calc; // 内部计算详情
      
      totalDuration += calc.duration;
      if (!calc.isValid) overflowCount++;
      
      results.push({
        id: shot.id,
        ...calc
      });

      const status = calc.isValid ? '✅' : '❌超限';
      console.log(`${shot.id} | ${calc.charCount}字 | ${calc.speed}字/秒 | 需${calc.baseDuration}秒 | 取${calc.duration}秒 ${status}`);
      
      if (calc.warning) {
        console.log(`   ⚠️  ${calc.warning.message}`);
      }
    });

    console.log('='.repeat(60));
    console.log(`总计: ${shots.length}镜 | ${totalDuration}秒 | 超限${overflowCount}镜`);
    
    return {
      results,
      totalDuration,
      overflowCount,
      isValid: overflowCount === 0
    };
  }

  /**
   * 统计中文字符数（不含标点）
   */
  countChineseChars(text) {
    if (!text) return 0;
    const chineseMatches = text.match(/[\u4e00-\u9fff]/g);
    return chineseMatches ? chineseMatches.length : 0;
  }

  /**
   * 生成精简建议
   */
  generateTrimSuggestion(shot, calc) {
    const maxChars = calc.warning?.maxChars || 20;
    const currentNarration = shot.narration || shot.line || '';
    
    return {
      original: currentNarration,
      originalChars: calc.charCount,
      targetChars: maxChars,
      suggestion: `将 ${calc.charCount}字 精简到 ${maxChars}字以内`,
      example: this.trimNarration(currentNarration, maxChars)
    };
  }

  /**
   * 简单精简narration（保留核心信息）
   */
  trimNarration(narration, maxChars) {
    const chars = narration.replace(/[^\u4e00-\u9fff]/g, '');
    if (chars.length <= maxChars) return narration;
    
    // 保留前半部分到maxChars
    let count = 0;
    let result = '';
    for (const char of narration) {
      if (/[\u4e00-\u9fff]/.test(char)) {
        count++;
        if (count > maxChars) break;
      }
      result += char;
    }
    return result + '...';
  }

  /**
   * v6.5.62-P1: 构建时间轴标记（timeline字段）
   * 格式：T00:XX-T00:XX / duration: Xs / type: XXX / mood: XXX
   */
  _buildTimeline(duration, shotType) {
    const start = 0; // 相对镜头起始时间
    const end = duration;
    
    const formatTime = (seconds) => {
      const mins = Math.floor(seconds / 60);
      const secs = Math.floor(seconds % 60);
      const tenths = Math.floor((seconds % 1) * 10);
      return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${tenths}`;
    };
    
    const typeMap = {
      'building': 'establishing',
      'discovery': 'discovery',
      'confrontation': 'confrontation',
      'climax': 'climax',
      'closing': 'resolution',
      'opening': 'opening'
    };
    
    return `T${formatTime(start)}-T${formatTime(end)} / duration: ${duration}s / type: ${typeMap[shotType] || 'normal'} / mood: ${shotType}`;
  }
}

module.exports = { DurationCalculator };
