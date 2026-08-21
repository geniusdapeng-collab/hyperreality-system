/**
 * SafeRegex - 安全正则工具
 * 防止灾难性回溯（ReDoS）
 */
class SafeRegexSimple {
  /**
   * 带输入长度限制的正则匹配
   * 超长输入截断，防止 ReDoS
   */
  static test(pattern, str, maxLength = 10000) {
    if (!str || typeof str !== 'string') return false;
    if (str.length > maxLength) {
      console.warn(`[SafeRegex] 输入过长(${str.length}), 截断至 ${maxLength}`);
      str = str.substring(0, maxLength);
    }
    return pattern.test(str);
  }

  /**
   * 带输入长度限制的全局匹配
   */
  static match(pattern, str, maxLength = 10000) {
    if (!str || typeof str !== 'string') return null;
    if (str.length > maxLength) {
      console.warn(`[SafeRegex] 输入过长(${str.length}), 截断至 ${maxLength}`);
      str = str.substring(0, maxLength);
    }
    return str.match(pattern);
  }

  /**
   * 带输入长度限制的 exec 循环
   */
  static execAll(pattern, str, maxLength = 10000) {
    if (!str || typeof str !== 'string') return [];
    if (str.length > maxLength) {
      console.warn(`[SafeRegex] 输入过长(${str.length}), 截断至 ${maxLength}`);
      str = str.substring(0, maxLength);
    }
    const matches = [];
    let match;
    const safePattern = new RegExp(pattern.source, pattern.flags.replace('g', '') + 'g');
    while ((match = safePattern.exec(str)) !== null) {
      matches.push(match);
      if (matches.length > 1000) break; // 防止无限循环
    }
    return matches;
  }
}

module.exports = { SafeRegexSimple };
