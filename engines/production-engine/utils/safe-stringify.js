/**
 * 安全序列化工具
 * 生产引擎内部使用
 * 
 * 特性：
 * - 用 WeakSet 过滤循环引用
 * - 过滤内部字段（_blueprint, _adapter 等）
 * - 过滤函数类型
 */

function safeStringify(obj) {
  const seen = new WeakSet();
  return JSON.stringify(obj, (key, value) => {
    // 过滤内部字段
    if (['_blueprint', '_adapter', '_llm', '_engine', '_metadata_raw'].includes(key)) {
      return undefined;
    }
    // 过滤函数
    if (typeof value === 'function') return undefined;
    // 过滤循环引用
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return undefined;
      seen.add(value);
    }
    return value;
  }, 2);
}

module.exports = { safeStringify };
