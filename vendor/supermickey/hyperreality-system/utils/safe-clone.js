/**
 * SafeClone - 安全深拷贝工具
 * 处理循环引用、BigInt、Date、RegExp、Map、Set 等特殊类型
 * 替代 JSON.parse(JSON.stringify()) 的所有使用场景
 */

class SafeClone {
  constructor(options = {}) {
    this.maxDepth = options.maxDepth || 100;
    this.trackKeys = options.trackKeys || ['prompt', '_generatedPrompt', 'fields', 'timing'];
  }

  deepClone(obj, depth = 0, refs = new WeakMap()) {
    if (depth > this.maxDepth) {
      console.warn(`[SafeClone] 达到最大深度 ${this.maxDepth}，返回引用`);
      return obj;
    }

    if (obj === null || typeof obj !== 'object') {
      if (typeof obj === 'bigint') return Number(obj);
      return obj;
    }

    if (refs.has(obj)) return refs.get(obj);

    if (obj instanceof Date) return new Date(obj.getTime());
    if (obj instanceof RegExp) return new RegExp(obj.source, obj.flags);

    if (obj instanceof Map) {
      const cloned = new Map();
      refs.set(obj, cloned);
      for (const [key, value] of obj) {
        cloned.set(this.deepClone(key, depth + 1, refs), this.deepClone(value, depth + 1, refs));
      }
      return cloned;
    }

    if (obj instanceof Set) {
      const cloned = new Set();
      refs.set(obj, cloned);
      for (const value of obj) cloned.add(this.deepClone(value, depth + 1, refs));
      return cloned;
    }

    if (Array.isArray(obj)) {
      const cloned = [];
      refs.set(obj, cloned);
      for (let i = 0; i < obj.length; i++) cloned[i] = this.deepClone(obj[i], depth + 1, refs);
      return cloned;
    }

    const cloned = {};
    refs.set(obj, cloned);
    const keys = Object.keys(obj);
    for (const key of keys) {
      if (key.startsWith('_') && obj[key] === obj) continue;
      cloned[key] = this.deepClone(obj[key], depth + 1, refs);
    }
    return cloned;
  }

  cloneShots(shots) {
    if (!Array.isArray(shots)) return shots;
    const startTime = Date.now();
    const cloned = this.deepClone(shots);
    console.log(`[SafeClone] 克隆 ${shots.length} 个镜头, 耗时 ${Date.now() - startTime}ms`);
    return cloned;
  }

  safeStringify(obj) {
    const refs = new WeakSet();
    return JSON.stringify(obj, (key, value) => {
      if (typeof value === 'object' && value !== null) {
        if (refs.has(value)) return '[Circular Reference]';
        refs.add(value);
      }
      if (typeof value === 'bigint') return Number(value);
      if (typeof value === 'function') return `[Function: ${value.name || 'anonymous'}]`;
      return value;
    }, 2);
  }
}

const defaultClone = new SafeClone();

module.exports = {
  SafeClone,
  deepClone: (obj) => defaultClone.deepClone(obj),
  cloneShots: (shots) => defaultClone.cloneShots(shots),
  safeStringify: (obj) => defaultClone.safeStringify(obj)
};
