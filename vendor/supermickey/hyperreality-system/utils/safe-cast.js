/**
 * SafeCast - 安全类型转换工具
 * 解决 JavaScript 隐式类型转换陷阱（0被视为falsy等）
 */
class SafeCast {
  /**
   * 安全获取数字（0、false 不被视为 falsy）
   */
  static number(value, fallback = 0) {
    if (value === null || value === undefined || Number.isNaN(value)) return fallback;
    const num = Number(value);
    return Number.isNaN(num) ? fallback : num;
  }

  /**
   * 安全获取字符串长度
   */
  static stringLength(value) {
    if (typeof value === 'string') return value.length;
    if (value === null || value === undefined) return 0;
    return String(value).length;
  }

  /**
   * 安全获取布尔值（false 不被视为 falsy）
   */
  static bool(value, fallback = false) {
    if (value === true || value === false) return value;
    if (value === 'true' || value === 1) return true;
    if (value === 'false' || value === 0) return false;
    return fallback;
  }

  /**
   * 安全获取数组长度
   */
  static arrayLength(value) {
    if (Array.isArray(value)) return value.length;
    return 0;
  }

  /**
   * 安全获取字符串（null/undefined 转为空字符串）
   */
  static string(value, fallback = '') {
    if (value === null || value === undefined) return fallback;
    return String(value);
  }

  /**
   * 安全获取对象属性（支持链式访问）
   */
  static get(obj, path, fallback = undefined) {
    if (!obj || typeof obj !== 'object') return fallback;
    const keys = path.split('.');
    let current = obj;
    for (const key of keys) {
      if (current === null || current === undefined) return fallback;
      current = current[key];
    }
    return current === undefined ? fallback : current;
  }
}

module.exports = { SafeCast };
