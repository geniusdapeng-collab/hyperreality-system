/**
 * Event Bus - 全链路事件追踪与回放 (SuperMickey 适配版)
 *
 * 来源: 超短裙 short-video/infrastructure/event-bus.js
 * 适配: SuperMickey 四层架构
 *
 * 核心能力:
 * - 发布/订阅事件
 * - Mutations追踪(状态变更的不可变记录)
 * - 事件回放(重现任意时刻的系统状态)
 * - 异步事件处理
 */

'use strict';
const EventEmitter = require('events');

// ============================================================
// SuperMickey 事件定义
// ============================================================

const SUPERMICKEY_EVENT_DEFINITIONS = {
  // Pipeline 生命周期
  'pipeline.started': {
    description: 'Pipeline开始执行',
    requiredFields: ['traceId', 'timestamp']
  },
  'pipeline.completed': {
    description: 'Pipeline成功完成',
    requiredFields: ['traceId', 'durationMs']
  },
  'pipeline.failed': {
    description: 'Pipeline失败',
    requiredFields: ['traceId', 'failedAt', 'error']
  },

  // Layer 生命周期
  'layer.started': {
    description: 'Layer开始执行',
    requiredFields: ['layerId', 'layerName', 'traceId']
  },
  'layer.completed': {
    description: 'Layer成功完成',
    requiredFields: ['layerId', 'layerName', 'traceId', 'durationMs']
  },
  'layer.failed': {
    description: 'Layer失败',
    requiredFields: ['layerId', 'layerName', 'traceId', 'error']
  },

  // 阶段事件
  'stage.started': {
    description: 'Stage开始执行',
    requiredFields: ['stageId', 'stageName', 'traceId']
  },
  'stage.completed': {
    description: 'Stage成功完成',
    requiredFields: ['stageId', 'stageName', 'traceId', 'durationMs']
  },
  'stage.failed': {
    description: 'Stage失败',
    requiredFields: ['stageId', 'stageName', 'traceId', 'error']
  },

  // 数据变更
  'data.mutated': {
    description: '数据字段被修改',
    requiredFields: ['layerId', 'field', 'oldValue', 'newValue']
  },

  // 质量检查
  'quality.checked': {
    description: '质量检查完成',
    requiredFields: ['layerId', 'checkType', 'passed']
  },

  // 情绪追踪
  'emotion.detected': {
    description: '情绪意图被解析',
    requiredFields: ['layerId', 'emotion', 'intensity']
  },

  // LLM 调用
  'llm.called': {
    description: 'LLM调用',
    requiredFields: ['layerId', 'provider', 'durationMs', 'status']
  }
};

// ============================================================
// Event Bus
// ============================================================

class EventBus extends EventEmitter {
  constructor(options = {}) {
    super();
    this.name = options.name || 'supermickey-bus';
    this.events = [];
    this.mutations = [];
    this.maxEvents = options.maxEvents || 10000;
    this.enabled = options.enabled !== false;
    this._sessionListeners = []; // 【v2.1.6-fix】会话监听器，便于批量清理

    // 【审计修复】自动清理定时器，防止 mutations 无限累积
    this.cleanupInterval = options.cleanupInterval || 60000; // 1分钟
    this._startAutoCleanup();
  }

  /**
   * 【v2.1.6-fix】重写 on 方法，跟踪会话监听器
   */
  on(eventName, listener) {
    super.on(eventName, listener);
    // 【P1-Bug7 修复】添加时间戳，便于定期清理过期监听器
    this._sessionListeners.push({ eventName, listener, addedAt: Date.now() });
    this._cleanupOldListeners(); // 定期清理
    return this;
  }

  /**
   * 【v2.1.6-fix】重写 once 方法，跟踪会话监听器
   */
  once(eventName, listener) {
    const wrapped = (...args) => {
      listener(...args);
      this._removeSessionListener(eventName, wrapped);
    };
    super.once(eventName, wrapped);
    this._sessionListeners.push({ eventName, listener: wrapped });
    return this;
  }

  /**
   * 【v2.1.6-fix】清理当前会话的所有监听器
   */
  clearSessionListeners() {
    for (const { eventName, listener } of this._sessionListeners) {
      super.off(eventName, listener);
    }
    this._sessionListeners = [];
  }

  _removeSessionListener(eventName, listener) {
    this._sessionListeners = this._sessionListeners.filter(
      (sl) => !(sl.eventName === eventName && sl.listener === listener)
    );
  }

  /**
   * 【P1-Bug7 修复】定期清理过期的监听器引用，防止内存泄漏
   */
  _cleanupOldListeners(maxAgeMs = 3600000) {
    const now = Date.now();
    const beforeLen = this._sessionListeners.length;
    this._sessionListeners = this._sessionListeners.filter(sl => {
      if (now - (sl.addedAt || 0) > maxAgeMs) {
        try { super.off(sl.eventName, sl.listener); } catch (_) {}
        return false;
      }
      return true;
    });
    const removed = beforeLen - this._sessionListeners.length;
    if (removed > 0) {
      console.log(`[EventBus] 清理了 ${removed} 个过期监听器引用`);
    }
  }

  /**
   * 发布事件
   * @param {string} eventName - 事件名称
   * @param {Object} payload - 事件数据
   */
  emit(eventName, payload = {}) {
    if (!this.enabled) return;

    const event = {
      name: eventName,
      timestamp: Date.now(),
      payload: this._sanitizePayload(payload)
    };

    this.events.push(event);

    // 限制事件数量
    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(-this.maxEvents);
    }

    // 调用父类的emit
    super.emit(eventName, event);
  }

  /**
   * 记录数据变更(Mutation)
   * @param {string} layerId - 层级ID
   * @param {string} field - 字段名
   * @param {*} oldValue - 旧值
   * @param {*} newValue - 新值
   */
  mutate(layerId, field, oldValue, newValue) {
    if (!this.enabled) return;

    const mutation = {
      layerId,
      field,
      oldValue: this._sanitizeValue(oldValue),
      newValue: this._sanitizeValue(newValue),
      timestamp: Date.now()
    };

    this.mutations.push(mutation);

    this.emit('data.mutated', mutation);
  }

  /**
   * 【审计修复】自动清理旧 mutations,防止内存泄漏
   */
  _startAutoCleanup() {
    if (this._cleanupTimer) return;

    this._cleanupTimer = setInterval(() => {
      // 清理5分钟前的 mutations
      const cutoff = Date.now() - 300000;
      const before = this.mutations.length;
      this.mutations = this.mutations.filter(m => m.timestamp > cutoff);
      const after = this.mutations.length;

      if (before !== after) {
        console.log(`[EventBus] 自动清理: ${before - after} 条旧 mutations 已移除`);
      }
    }, this.cleanupInterval);
    // 【v2.2.8-审计修复】unref：内部清理定时器无权阻止进程退出。
    // 旧实现漏 unref，凡实例化 EventBus 的脚本/测试（如 tests/module-load-test.js）
    // 业务逻辑结束后进程被永久挂住；调用方 destroy() 依然可主动清理。
    this._cleanupTimer.unref();
  }

  /**
   * 【审计修复】销毁 EventBus,清理资源
   */
  destroy() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
    this.events = [];
    this.mutations = [];
    this.removeAllListeners();
  }

  /**
   * 获取事件追踪
   * @returns {Array} 事件列表
   */
  getTrace() {
    return this.events;
  }

  /**
   * 获取Mutations
   * @returns {Array} Mutation列表
   */
  getMutations() {
    return this.mutations;
  }

  /**
   * 回放事件到指定时间点
   * @param {number} timestamp - 时间戳
   * @returns {Array} 该时间点前的事件
   */
  replayUntil(timestamp) {
    return this.events.filter(e => e.timestamp <= timestamp);
  }

  /**
   * 获取指定层级的所有事件
   * @param {string} layerId - 层级ID
   * @returns {Array} 事件列表
   */
  getLayerEvents(layerId) {
    return this.events.filter(e => e.payload.layerId === layerId);
  }

  /**
   * 生成执行报告
   * @returns {Object} 报告
   */
  generateReport() {
    const layers = {};
    const stages = {};

    for (const event of this.events) {
      if (event.payload.layerId) {
        layers[event.payload.layerId] = (layers[event.payload.layerId] || 0) + 1;
      }
      if (event.payload.stageId) {
        stages[event.payload.stageId] = (stages[event.payload.stageId] || 0) + 1;
      }
    }

    return {
      totalEvents: this.events.length,
      totalMutations: this.mutations.length,
      layers,
      stages,
      duration: this.events.length > 0
        ? this.events[this.events.length - 1].timestamp - this.events[0].timestamp
        : 0
    };
  }

  /**
   * 清空事件(谨慎使用)
   */
  clear() {
    this.events = [];
    this.mutations = [];
  }

  // ========== 私有方法 ==========

  _sanitizePayload(payload, options = {}) {
    // 【P1-Bug7 修复】可配置截断+日志记录，避免静默数据丢失
    const maxStringLength = options.maxStringLength || 10000; // 默认10KB
    const shouldTruncate = options.truncate !== false;
    try {
      return JSON.parse(JSON.stringify(payload, (key, value) => {
        if (typeof value === 'function') return undefined;
        if (value instanceof Buffer) return '<Buffer>';
        if (typeof value === 'string' && value.length > maxStringLength) {
          if (shouldTruncate) {
            console.warn(`[EventBus] Payload字段 '${key}' 被截断: ${value.length} → ${maxStringLength} chars`);
            return value.substring(0, maxStringLength) + `...[truncated:${value.length}]`;
          }
        }
        return value;
      }));
    } catch (e) {
      console.error('[EventBus] Payload serialization failed:', e.message);
      return { error: 'Payload serialization failed', originalError: e.message };
    }
  }

  _sanitizeValue(value) {
    if (typeof value === 'string' && value.length > 500) {
      return value.substring(0, 500) + '...';
    }
    return value;
  }
}

module.exports = { EventBus, SUPERMICKEY_EVENT_DEFINITIONS };
