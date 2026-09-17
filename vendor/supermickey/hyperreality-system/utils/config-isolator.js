/**
 * ConfigIsolator - 配置隔离器
 * 确保每个运行实例拥有独立的配置副本
 */

class ConfigIsolator {
  static isolate(config) {
    if (!config || typeof config !== 'object') return config;
    if (typeof structuredClone === 'function') {
      try { return structuredClone(config); } catch (e) { console.warn('[ConfigIsolator] structuredClone 失败，降级:', e.message); }
    }
    return ConfigIsolator._manualDeepClone(config);
  }

  static _manualDeepClone(obj, refs = new WeakMap()) {
    if (obj === null || typeof obj !== 'object') return obj;
    if (refs.has(obj)) return refs.get(obj);
    if (obj instanceof Date) return new Date(obj.getTime());
    if (obj instanceof RegExp) return new RegExp(obj.source, obj.flags);
    if (Array.isArray(obj)) {
      const cloned = []; refs.set(obj, cloned);
      for (let i = 0; i < obj.length; i++) cloned[i] = ConfigIsolator._manualDeepClone(obj[i], refs);
      return cloned;
    }
    const cloned = {}; refs.set(obj, cloned);
    for (const key of Object.keys(obj)) cloned[key] = ConfigIsolator._manualDeepClone(obj[key], refs);
    return cloned;
  }

  static freeze(config) {
    if (!config || typeof config !== 'object') return config;
    Object.freeze(config);
    for (const key of Object.keys(config)) {
      const value = config[key];
      if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) ConfigIsolator.freeze(value);
    }
    return config;
  }
}

module.exports = { ConfigIsolator };
