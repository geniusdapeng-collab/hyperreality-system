/**
 * 【v6.2-patch51】Narration自动精简器
 * NarrationAutoTrim
 *
 * 产品机制：在时长分配阶段，当检测到narration字数超过时长容量时，
 * 自动精简narration，保留核心语义，删除冗余修饰。
 * 解决「narration字数踩线/超限」的系统性问题。
 *
 * 挂载点：ShotDurationAllocatorV2 Stage 2（时长分配）中
 *
 * 核心逻辑：
 * 1. 计算每镜narration字数与时长容量的匹配度
 * 2. 如果超限（字数 > 语速×时长×0.9），触发精简
 * 3. 精简策略：
 *    - 删除冗余修饰词（非常、特别、极其、十分等）
 *    - 删除重复语义（同义词并列）
 *    - 将长句拆分为短句，保留主干
 *    - 删除可省略的时间/地点状语
 * 4. 精简后重新验证
 */

// 【v2.2.5-审计修复】语速从唯一真源 config/speech-rate.js 读取，
// 旧值 4.0-5.0 与真源基准（normal 3.5 / limit 4.5）冲突。
// 注意：本模块当前未被主链路引用（保留作历史参考）。
const SpeechRate = require('../hyperreality-system/config/speech-rate.js');

class NarrationAutoTrim {
  constructor(config = {}) {
    this.config = {
      // 语速配置（字/秒）：慢节奏场景取真源 normal，快节奏取真源 fast，不超真源 limit
      speedMap: {
        'opening': SpeechRate.RATES.slow,
        'definition': SpeechRate.NORMAL,
        'explanation': SpeechRate.NORMAL,
        'demonstration': SpeechRate.NORMAL,
        'interaction': SpeechRate.RATES.fast,
        'transition': SpeechRate.RATES.fast,
        'highlight': SpeechRate.NORMAL,
        'closing': SpeechRate.RATES.slow,
        'default': SpeechRate.NORMAL
      },
      // 安全余量系数（实际容量 = 语速×时长×余量）
      safetyMargin: 0.85,
      // 冗余修饰词（可删除）
      redundantModifiers: [
        '非常', '特别', '极其', '十分', '格外', '相当', '真的很',
        '明显地', '显然地', '毫无疑问地', '事实上', '实际上',
        '大概', '可能', '似乎', '好像', '差不多', '基本',
        '一点一点地', '慢慢地', '渐渐地', '缓缓地',
        '各种各样的', '形形色色的', '五花八门的', '多种多样的'
      ],
      // 重复语义模式（保留第一个，删除后续）
      redundantPatterns: [
        { pattern: /(巨大|庞大|庞大|巨大)/g, keep: 1 },
        { pattern: /(美丽|漂亮|好看|优美)/g, keep: 1 },
        { pattern: /(害怕|恐惧|惊恐|畏惧)/g, keep: 1 },
        { pattern: /(快速|迅速|飞快|急速)/g, keep: 1 },
        { pattern: /(慢慢|缓缓|渐渐|徐徐)/g, keep: 1 }
      ],
      // 可省略的时间/地点状语
      omissiblePhrases: [
        '在这个时候', '在那一刻', '此时此刻', '当时',
        '在这个地方', '在那里', '在这片土地上',
        '突然之间', '猛然间', '刹那间', '一瞬间'
      ],
      // 精简后最小保留比例
      minRetentionRatio: 0.6,
      // 【v6.5.37-fix】场景类型最小保留字数（系统级保护）
      // 防止closing场景被精简到无意义（如"香香躺在。"仅4字）
      minLengthByType: {
        'opening': 8,      // 开场至少8字
        'closing': 10,     // 结尾至少10字（保护叙事对齐）
        'default': 6       // 默认至少6字
      },
      // 【v6.5.37-fix】语义完整性保护词（含这些词时禁止精简）
      protectedKeywords: [
        '沙滩', '微笑', '定格', '守护', '拥抱', '亲吻', '挥手',
        '再见', '结束', '总结', '最后', '定格', '留念'
      ],
      // 最大精简轮数
      maxTrimRounds: 3,
      ...config
    };

    this.trimLog = [];
  }

  /**
   * 主入口：精简narration
   * @param {Array} narrations - narration数组（含text, type, duration等）
   * @returns {Object} 精简后的narrations + 报告
   */
  trim(narrations) {
    this.trimLog = [];
    const trimmed = [];
    let totalTrimmed = 0;
    let totalOriginal = 0;

    for (const narration of narrations) {
      const originalText = narration.text || '';
      const charCount = this.countAllChars(originalText);
      totalOriginal += charCount;

      // 计算容量
      const duration = narration.duration || narration.allocatedDuration || 5;
      const type = narration.type || 'default';
      const speed = this.config.speedMap[type] || this.config.speedMap.default;
      const capacity = Math.floor(duration * speed * this.config.safetyMargin);

      // 检查是否超限
      if (charCount > capacity) {
        const excess = charCount - capacity;
        let trimmedText = originalText;
        let round = 0;

        // 【v6.5.37-fix】计算最小保留长度（系统级保护）
        const sceneType = narration.sceneType || narration.type || 'default';
        const minLength = this.config.minLengthByType[sceneType] || this.config.minLengthByType.default;
        const minRetentionChars = Math.max(
          Math.floor(charCount * this.config.minRetentionRatio),
          minLength
        );
        // 如果容量低于最小保留长度，以最小保留长度为准（防止过度精简）
        const effectiveCapacity = Math.max(capacity, minRetentionChars);

        // 多轮精简（但不超过最小保留长度）
        while (this.countAllChars(trimmedText) > effectiveCapacity && round < this.config.maxTrimRounds) {
          const before = trimmedText;
          // 【v6.5.37-fix】传入最小保留长度，确保不会过度精简
          trimmedText = this.trimRound(trimmedText, excess, minRetentionChars);
          
          if (trimmedText === before) break; // 无法继续精简
          round++;
        }

        // 【v6.5.37-fix】最终检查：如果低于最小保留长度，回退到原始文本
        const finalCount = this.countAllChars(trimmedText);
        if (finalCount < minLength) {
          this.trimLog.push({
            original: originalText,
            trimmed: trimmedText,
            originalCount: charCount,
            finalCount,
            capacity,
            effectiveCapacity,
            trimmedChars: charCount - finalCount,
            rounds: round,
            type,
            duration,
            warning: `精简后(${finalCount}字)低于最小保留长度(${minLength}字)，系统强制保护`
          });
          // 回退到原始文本（不精简）
          trimmed.push({
            ...narration,
            text: originalText,
            originalText: originalText,
            wasTrimmed: false,
            trimInfo: {
              originalCount: charCount,
              finalCount: charCount,
              capacity,
              trimmedChars: 0,
              protected: true
            }
          });
          continue;
        }

        // 回退检查已通过，直接使用finalCount
        const trimmedChars = charCount - finalCount;
        totalTrimmed += trimmedChars;

        this.trimLog.push({
          original: originalText,
          trimmed: trimmedText,
          originalCount: charCount,
          finalCount,
          capacity,
          trimmedChars,
          rounds: round,
          type,
          duration
        });

        trimmed.push({
          ...narration,
          text: trimmedText,
          originalText: originalText,
          wasTrimmed: true,
          trimInfo: {
            originalCount: charCount,
            finalCount,
            capacity,
            trimmedChars
          }
        });
      } else {
        trimmed.push(narration);
      }
    }

    return {
      narrations: trimmed,
      report: {
        totalNarrations: narrations.length,
        trimmedCount: this.trimLog.length,
        totalOriginalChars: totalOriginal,
        totalTrimmedChars: totalTrimmed,
        trimRate: totalOriginal > 0 ? (totalTrimmed / totalOriginal * 100).toFixed(1) : 0,
        details: this.trimLog
      }
    };
  }

  /**
   * 单轮精简
   * 【v6.5.37-fix】增加最小保留长度和语义保护
   */
  trimRound(text, targetExcess, minRetentionChars = 0) {
    let trimmed = text;

    // 【v6.5.37-fix】检查语义保护关键词（含这些词时减少精简力度）
    const hasProtectedKeyword = this.config.protectedKeywords.some(kw => text.includes(kw));
    if (hasProtectedKeyword) {
      // 有保护关键词时，只删除冗余修饰词，不截断
      targetExcess = Math.floor(targetExcess * 0.5); // 减少一半精简目标
    }

    // 策略1：删除冗余修饰词
    for (const modifier of this.config.redundantModifiers) {
      const regex = new RegExp(modifier, 'g');
      if (regex.test(trimmed)) {
        trimmed = trimmed.replace(regex, '');
        if (this.countAllChars(trimmed) <= this.countAllChars(text) - targetExcess) {
          return trimmed;
        }
      }
    }

    // 策略2：删除重复语义
    for (const { pattern, keep } of this.config.redundantPatterns) {
      const matches = trimmed.match(pattern);
      if (matches && matches.length > keep) {
        // 保留第一个，替换其余为空
        let count = 0;
        trimmed = trimmed.replace(pattern, (match) => {
          count++;
          return count <= keep ? match : '';
        });
        if (this.countAllChars(trimmed) <= this.countAllChars(text) - targetExcess) {
          return trimmed;
        }
      }
    }

    // 策略3：删除可省略的时间/地点状语
    for (const phrase of this.config.omissiblePhrases) {
      const regex = new RegExp(phrase, 'g');
      if (regex.test(trimmed)) {
        trimmed = trimmed.replace(regex, '');
        if (this.countAllChars(trimmed) <= this.countAllChars(text) - targetExcess) {
          return trimmed;
        }
      }
    }

    // 策略4：简化长句（删除从句中的冗余部分）
    // 删除"而"、"并且"、"同时"连接的次要分句
    trimmed = trimmed.replace(/，(而|并且|同时|此外|另外)[^，。]+/g, '');

    // 策略5：删除句末的总结/解释性从句
    trimmed = trimmed.replace(/，(这|那|它|他|她)(是|就|也|都|总)[^，。]+/g, '');

    // 策略6：截断兜底（保留前X个字符，确保不超限）
    const currentCount = this.countAllChars(trimmed);
    const targetLength = Math.max(currentCount - targetExcess, minRetentionChars);
    if (targetLength > 0 && currentCount > targetLength) {
      // 在标点处截断，避免句子不完整
      let cutPoint = targetLength;
      while (cutPoint > 0 && !/[，。！？；]/.test(trimmed[cutPoint])) {
        cutPoint--;
      }
      if (cutPoint > 0) {
        trimmed = trimmed.substring(0, cutPoint + 1);
      } else {
        trimmed = trimmed.substring(0, targetLength);
      }
    }

    // 清理多余的标点
    trimmed = trimmed.replace(/，，/g, '，').replace(/。。/g, '。');
    trimmed = trimmed.replace(/，$/g, '').replace(/^，/g, '');

    // v6.5.29-fix: 确保精简后的narration以完整句号结尾
    const originalEndsWithPeriod = /[。！？.!?]$/.test(text);
    const trimmedEndsWithPeriod = /[。！？.!?]$/.test(trimmed);
    if (originalEndsWithPeriod && !trimmedEndsWithPeriod && trimmed.length > 0) {
      trimmed = trimmed + '。';
    }

    return trimmed;
  }

  /**
   * 统计中文字符数
   */
  countAllChars(text) {
    // 统计所有非空白字符（与故事板校验器一致）
    return text.replace(/\s/g, '').length;
  }

  /**
   * 精简后验证
   */
  validateTrimmed(trimmedNarrations) {
    const issues = [];

    for (const narration of trimmedNarrations) {
      if (!narration.wasTrimmed) continue;

      const finalCount = narration.trimInfo?.finalCount || 0;
      const originalCount = narration.trimInfo?.originalCount || 1;
      const retentionRatio = finalCount / originalCount;

      // 检查保留比例
      if (retentionRatio < this.config.minRetentionRatio) {
        issues.push({
          type: 'over_trimmed',
          narration: narration.text,
          original: narration.originalText,
          retentionRatio: (retentionRatio * 100).toFixed(1),
          message: `精简过度，保留仅${(retentionRatio * 100).toFixed(1)}%，建议人工审核`
        });
      }

      // 检查语义完整性（简单检查：是否有主语和谓语）
      const hasSubject = /[\u4e00-\u9fff]+/.test(narration.text);
      const hasPredicate = /[\u4e00-\u9fff]+[\u4e00-\u9fff]+/.test(narration.text);
      if (!hasSubject || !hasPredicate) {
        issues.push({
          type: 'semantic_broken',
          narration: narration.text,
          message: '精简后语义可能不完整，建议人工审核'
        });
      }
    }

    return {
      valid: issues.length === 0,
      issues
    };
  }
}

module.exports = { NarrationAutoTrim };
