/**
 * 【v6.2-patch52】时长-字数一致性校准器
 * DurationNarrationAlignment
 *
 * 产品机制：在 NarrationAutoTrim 之后、故事板校验之前，
 * 自动检查每镜 narration 字数与分配时长的匹配度。
 * 如果不匹配，优先从低重要性镜头"借"时长，不增加总预算。
 * 解决「时长分配基于估算，但实际 narration 字数随机膨胀」的系统性问题。
 *
 * 挂载点：Stage 7.4（Stage 7.3 之后、Stage 8 之前）
 *
 * 【v2.2.5-审计修复】语速从唯一真源 config/speech-rate.js 读取。
 * 旧值 5.0 字/秒与真源基准 3.5 冲突，会把"超速"误判为"合规"。
 * 注意：本模块当前未被主链路引用（保留作历史参考），新代码请走
 * hyperreality-system/utils/dialogue-timing-calculator.js。
 */

const SpeechRate = require('../hyperreality-system/config/speech-rate.js');

class DurationNarrationAlignment {
  constructor(config = {}) {
    this.config = {
      // 舒适语速（字/秒），与唯一真源一致
      comfortSpeed: SpeechRate.NORMAL,
      // 留白缓冲（秒），结尾镜需要额外留白
      endingBuffer: 1.0,
      // 普通镜头缓冲
      normalBuffer: 0.5,
      // 最低时长限制
      minDuration: 4,
      // 最高时长限制
      maxDuration: 20,
      ...config
    };
  }

  /**
   * 主入口：校准时长-字数一致性
   * @param {Array} shots - 故事板镜头数组
   * @returns {Object} 校准结果
   */
  align(shots) {
    const issues = [];
    const adjustments = [];
    let totalBorrowed = 0;

    // 第一轮：检测所有不匹配
    const mismatches = [];
    for (const shot of shots) {
      const narration = shot.narration || shot.text || '';  // v6.5.65-P8-fix: 同时支持 narration 和 text 字段
      const duration = shot.duration || shot.allocatedDuration || 5;
      const type = shot.type || 'default';
      const importance = shot.importance || 5;

      // 计算需要的最小时长
      const charCount = this.countAllChars(narration);
      const buffer = (type === 'closing' || type === 'ending' || type === 'resolution') 
        ? this.config.endingBuffer 
        : this.config.normalBuffer;
      const requiredDuration = Math.ceil(charCount / this.config.comfortSpeed + buffer);

      if (requiredDuration > duration) {
        mismatches.push({
          shotId: shot.id,
          type,
          importance,
          duration,
          requiredDuration,
          deficit: requiredDuration - duration,
          charCount,
          narration: narration  // v6.5.65-P8-fix: 记录实际使用的文本
        });
      }
    }

    if (mismatches.length === 0) {
      return {
        aligned: true,
        shots,
        adjustments: [],
        issues: [],
        report: '所有镜头时长-字数匹配，无需调整'
      };
    }

    // 第二轮：尝试从低重要性镜头"借"时长
    // 按重要性升序排列可借镜头的候选池
    const donorCandidates = shots
      .filter(s => !mismatches.some(m => m.shotId === s.id))
      .map(s => ({
        shotId: s.id,
        type: s.type,
        importance: s.importance || 5,
        duration: s.duration || s.allocatedDuration || 5,
        narration: s.narration || ''
      }))
      .sort((a, b) => a.importance - b.importance); // 低重要性优先

    const adjustedShots = shots.map(s => ({ ...s })); // 深拷贝
    let totalDurationAdded = 0; // v6.5.65-P8-fix: 记录总增加时长

    for (const mismatch of mismatches) {
      let remainingDeficit = mismatch.deficit;

      // 尝试从候选池借时长
      for (const donor of donorCandidates) {
        if (remainingDeficit <= 0) break;
        
        // v6.6.2-fix: 使用 adjustedShots 中的实时 duration，而非原始值
        const donorIndex = adjustedShots.findIndex(s => s.id === donor.shotId);
        if (donorIndex < 0) continue;
        const donorCurrentDuration = adjustedShots[donorIndex].duration || 0;
        
        if (donorCurrentDuration <= this.config.minDuration) continue;

        // 计算可借的最大时长（基于实时 duration）
        const donorNarration = donor.narration;
        const donorCharCount = this.countAllChars(donorNarration);
        const donorBuffer = (donor.type === 'closing') ? this.config.endingBuffer : this.config.normalBuffer;
        const donorRequired = Math.ceil(donorCharCount / this.config.comfortSpeed + donorBuffer);
        const maxBorrow = donorCurrentDuration - Math.max(donorRequired, this.config.minDuration);

        if (maxBorrow <= 0) continue;

        const borrow = Math.min(maxBorrow, remainingDeficit);

        // 执行借调
        const mismatchIndex = adjustedShots.findIndex(s => s.id === mismatch.shotId);

        if (mismatchIndex >= 0) {
          // v6.5.36-fix: 借调后不超过 maxDuration 上限（硬规则要求15秒）
          const maxAllowed = 15; // 与硬规则对齐
          const afterBorrow = adjustedShots[mismatchIndex].duration + borrow;
          const cappedBorrow = afterBorrow > maxAllowed ? (maxAllowed - adjustedShots[mismatchIndex].duration) : borrow;
          if (cappedBorrow <= 0) continue;

          adjustedShots[donorIndex].duration -= cappedBorrow;
          adjustedShots[mismatchIndex].duration += cappedBorrow;
          remainingDeficit -= cappedBorrow;
          totalBorrowed += cappedBorrow;

          adjustments.push({
            from: donor.shotId,
            to: mismatch.shotId,
            amount: cappedBorrow,
            reason: `${mismatch.shotId} narration ${mismatch.charCount}字 需要 ${mismatch.requiredDuration}秒，原分配 ${mismatch.duration}秒`
          });
        }
      }

      // v6.5.65-P8-fix: 如果借调后仍不够，增加总时长（不报错，只警告）
      if (remainingDeficit > 0) {
        const mismatchIndex = adjustedShots.findIndex(s => s.id === mismatch.shotId);
        if (mismatchIndex >= 0) {
          // 增加该镜头时长，不超过 maxDuration
          const addDuration = Math.min(remainingDeficit, 15 - adjustedShots[mismatchIndex].duration);
          if (addDuration > 0) {
            adjustedShots[mismatchIndex].duration += addDuration;
            totalDurationAdded += addDuration;
            remainingDeficit -= addDuration;
            adjustments.push({
              to: mismatch.shotId,
              amount: addDuration,
              reason: `${mismatch.shotId} narration ${mismatch.charCount}字 需要 ${mismatch.requiredDuration}秒，原分配 ${mismatch.duration}秒，借调不足，增加时长 ${addDuration}秒`
            });
          }
        }
      }

      // 如果增加后仍不够，记录警告（非错误）
      if (remainingDeficit > 0) {
        issues.push({
          shotId: mismatch.shotId,
          type: 'duration_insufficient',
          severity: 'warning', // v6.5.65-P8-fix: 降级为警告，不阻断流程
          message: `${mismatch.shotId}: narration ${mismatch.charCount}字 需要 ${mismatch.requiredDuration}秒，分配 ${mismatch.duration}秒，借调+增加后仍缺 ${remainingDeficit}秒（建议精简 narration）`,
          suggestion: `建议精简 narration ${mismatch.charCount}字 → ${Math.floor((mismatch.duration - this.config.endingBuffer) * this.config.comfortSpeed)}字`
        });
      }
    }

    // v6.5.65-P8-fix: 如果有增加总时长，报告
    if (totalDurationAdded > 0) {
      issues.push({
        shotId: 'TOTAL',
        type: 'duration_extended',
        severity: 'info',
        message: `总时长增加 ${totalDurationAdded}秒 以容纳 narration 字数`,
        suggestion: '预生产模式允许，生产环境需确认总时长预算'
      });
    }

    return {
      aligned: issues.filter(i => i.severity === 'error').length === 0, // v6.5.65-P8-fix: 只有 error 才视为失败
      shots: adjustedShots,
      adjustments,
      issues,
      report: issues.length === 0
        ? `时长-字数校准完成：借调 ${totalBorrowed}秒，增加 ${totalDurationAdded}秒，${adjustments.length} 次调整`
        : `时长-字数校准完成：借调 ${totalBorrowed}秒，增加 ${totalDurationAdded}秒，${issues.filter(i => i.severity === 'warning').length} 个警告`
    };
  }

  /**
   * 统计所有非空白字符（与故事板校验器一致）
   */
  countAllChars(text) {
    return text.replace(/\s/g, '').length;
  }
}

module.exports = { DurationNarrationAlignment };
