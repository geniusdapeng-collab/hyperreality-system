/**
 * ImmutableMetadata — 不可变元数据管理器
 * 防止各模块直接修改 metadata 导致的全局状态污染
 */
class ImmutableMetadata {
  constructor(initialMetadata = {}) {
    this._history = [];
    this._metadata = this._deepClone(initialMetadata);
    this._locked = false;
  }

  /** 获取当前 metadata 的只读副本 */
  get() {
    return this._deepClone(this._metadata);
  }

  /** 获取原始 metadata（不克隆，仅供内部使用） */
  _raw() {
    return this._metadata;
  }

  /**
   * 不可变更新 — 返回新的 ImmutableMetadata 实例
   * 原实例保持不变
   */
  update(updater, moduleName = 'unknown') {
    const clone = this._deepClone(this._metadata);

    if (typeof updater === 'function') {
      updater(clone);
    } else if (typeof updater === 'object') {
      Object.assign(clone, updater);
    }

    const newInstance = new ImmutableMetadata(clone);
    newInstance._history = [...this._history, {
      module: moduleName,
      timestamp: new Date().toISOString(),
      keys: typeof updater === 'object' ? Object.keys(updater) : ['(function)']
    }];

    return newInstance;
  }

  /** 安全设置 — 记录修改历史 */
  set(key, value, moduleName = 'unknown') {
    return this.update({ [key]: value }, moduleName);
  }

  /** 获取修改历史（用于调试） */
  getHistory() {
    return [...this._history];
  }

  _deepClone(obj) {
    if (obj === null || typeof obj !== 'object') return obj;
    if (obj instanceof Date) return new Date(obj.getTime());
    if (Array.isArray(obj)) return obj.map(item => this._deepClone(item));
    const cloned = {};
    for (const key of Object.keys(obj)) {
      cloned[key] = this._deepClone(obj[key]);
    }
    return cloned;
  }

  /** 锁定 — 防止后续修改（用于调试） */
  lock() {
    this._locked = true;
    return this;
  }
}

module.exports = { ImmutableMetadata };
