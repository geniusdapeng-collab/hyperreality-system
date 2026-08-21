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

    // 【v2.1.8-审计修复】Error 对象序列化为可读格式
    if (value instanceof Error) {
      return {
        __type: 'Error',
        message: value.message,
        stack: value.stack,
        name: value.name,
        // 保留 Error 上可能附加的其他可枚举属性
        ...Object.entries(value).reduce((acc, [k, v]) => {
          if (typeof v !== 'function') acc[k] = v;
          return acc;
        }, {})
      };
    }

    // 过滤循环引用
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
    }
    return value;
  }, 2);
}

module.exports = { safeStringify };