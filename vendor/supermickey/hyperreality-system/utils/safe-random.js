const crypto = require('crypto');

/**
 * SafeRandom - 加密安全随机数生成器
 * 替代 Math.random()，防止可预测序列和跨进程重复
 */
class SafeRandom {
  /**
   * 获取加密安全的随机整数 [0, max)
   */
  static randomInt(max) {
    if (!Number.isInteger(max) || max <= 0) return 0;
    return crypto.randomInt(0, max);
  }

  /**
   * 从数组中随机选择（加密安全）
   */
  static randomChoice(array) {
    if (!Array.isArray(array) || array.length === 0) return undefined;
    return array[crypto.randomInt(0, array.length)];
  }

  /**
   * Fisher-Yates 洗牌（加密安全）
   */
  static shuffle(array) {
    if (!Array.isArray(array)) return [];
    const result = [...array];
    for (let i = result.length - 1; i > 0; i--) {
      const j = crypto.randomInt(0, i + 1);
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }

  /**
   * 生成随机浮点数 [0, 1)
   */
  static randomFloat() {
    return crypto.randomInt(0, 1000000) / 1000000;
  }
}

module.exports = { SafeRandom };
