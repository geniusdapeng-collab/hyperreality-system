// 【v2.2.5-审计修复】长度阈值从唯一真源 config/prompt-length.js 读取，
// 旧值 1500 是扩容前废弃规范（现行 TARGET 2470-3000 / HARD_MAX 3000）。
// 注意：本模块仅被 scripts/promptforge-director-worker.js（legacy）引用。
const PromptLengthConfig = require('../hyperreality-system/config/prompt-length.js');

class CharCounter {
  constructor() {
    this.TARGET_MAX = PromptLengthConfig.TARGET_MAX;
    this.HARD_LIMIT = PromptLengthConfig.HARD_MAX;
    this.SAFETY_MARGIN = PromptLengthConfig.SAFETY_MARGIN;
  }

  count(str) {
    if (!str || typeof str !== 'string') return 0;
    return [...str].length;
  }

  truncate(str, max = this.TARGET_MAX) {
    if (!str || typeof str !== 'string') return '';
    const chars = [...str];
    if (chars.length <= max) return str;
    return chars.slice(0, max).join('').trim();
  }

  utilization(str, max = this.TARGET_MAX) {
    const len = this.count(str);
    return max > 0 ? (len / max) : 0;
  }

  countWeighted(str) {
    // 仅供兼容旧日志展示，不参与业务逻辑
    if (!str || typeof str !== 'string') return 0;
    let total = 0;
    for (const char of str) {
      if (this._isChineseChar(char)) {
        total += 1.5;
      } else {
        total += 1;
      }
    }
    return total;
  }

  _isChineseChar(char) {
    const code = char.charCodeAt(0);
    return (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x20000 && code <= 0x2a6df)
    );
  }
}

const charCounter = new CharCounter();

module.exports = {
  CharCounter,
  charCounter
};
