/**
 * Nirath Event Bus v1.0 — 轻量事件总线（试点版）
 * 
 * 设计原则：
 * 1. 基于 Node.js 原生 EventEmitter，零外部依赖
 * 2. 仅用于 Stage 7.2 + Stage 7.3 试点（非全链路）
 * 3. 支持双模式：直接调用（现有） + 事件驱动（新增）
 * 4. 事件 Schema：{ type, payload, metadata }
 * 5. 订阅者可选择同步/异步处理
 * 
 * 试点事件：
 * - storyboard.protagonist.enhanced: Stage 7.2 完成主角主动性注入
 * - storyboard.narration.trimmed: Stage 7.3 完成口播精简
 * 
 * 验证目标：直接调用结果 vs 事件驱动结果 100% 一致
 */

'use strict';

const EventEmitter = require('events');

// ============================================================
// 一、事件定义（Zod-free，纯 JS 描述）
// ============================================================

const EVENT_DEFINITIONS = {
  'storyboard.protagonist.enhanced': {
    description: 'Stage 7.2 主角主动性注入完成',
    payloadSchema: {
      storyboard: 'object',       // 增强后的故事板
      report: 'object',           // 注入报告
      protagonistId: 'string',  // 主角ID
      protagonistName: 'string'   // 主角名
    },
    requiredFields: ['storyboard', 'report']
  },
  'storyboard.narration.trimmed': {
    description: 'Stage 7.3 口播精简完成',
    payloadSchema: {
      storyboard: 'object',       // 精简后的故事板（已变异）
      report: 'object',           // 精简报告
      trimmedShots: 'array'       // 被修改的镜头列表
    },
    requiredFields: ['storyboard', 'report']
  }
};

// ============================================================
// 二、事件总线
// ============================================================

class NirathEventBus extends EventEmitter {
  constructor(options = {}) {
    super();
    this.name = options.name || 'nirath-pilot';
    this.enabled = options.enabled !== false;
    this.debug = options.debug || false;
    this.eventLog = [];
    this.subscriberStats = {};
    
    if (!this.enabled) {
      console.log(`[EventBus:${this.name}] 已禁用（试点模式）`);
    } else {
      console.log(`[EventBus:${this.name}] 初始化完成`);
    }
  }

  /**
   * 发布事件
   * @param {string} eventType - 事件类型
   * @param {Object} payload - 事件数据
   * @param {Object} metadata - 元数据（stageId, timestamp等）
   */
  publish(eventType, payload, metadata = {}) {
    if (!this.enabled) return;

    const eventDef = EVENT_DEFINITIONS[eventType];
    if (!eventDef) {
      console.warn(`[EventBus] 未知事件类型: ${eventType}`);
    }

    // 基础验证
    if (eventDef && eventDef.requiredFields) {
      for (const field of eventDef.requiredFields) {
        if (payload[field] === undefined || payload[field] === null) {
          console.warn(`[EventBus] 事件 ${eventType} 缺少必填字段: ${field}`);
        }
      }
    }

    const event = {
      type: eventType,
      payload: metadata.clonePayload ? this.deepClone(payload) : payload,
      metadata: {
        timestamp: Date.now(),
        busName: this.name,
        ...metadata
      }
    };

    this.eventLog.push(event);

    if (this.debug) {
      console.log(`[EventBus] 📤 发布 ${eventType}`, 
        Object.keys(payload).map(k => `${k}=${typeof payload[k]}`).join(', '));
    }

    this.emit(eventType, event);
  }

  /**
   * 订阅事件
   * @param {string} eventType - 事件类型
   * @param {Function} handler - 处理函数 (event) => result
   * @param {Object} options - { once, async }
   */
  subscribe(eventType, handler, options = {}) {
    if (!this.enabled) return () => {};

    const subscriberId = `${eventType}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    
    if (!this.subscriberStats[eventType]) {
      this.subscriberStats[eventType] = { subscribers: 0, invocations: 0 };
    }
    this.subscriberStats[eventType].subscribers++;

    const wrapper = async (event) => {
      try {
        this.subscriberStats[eventType].invocations++;
        
        if (this.debug) {
          console.log(`[EventBus] 📥 订阅者 ${subscriberId} 处理 ${eventType}`);
        }

        if (options.async !== false) {
          await handler(event.payload, event.metadata);
        } else {
          handler(event.payload, event.metadata);
        }
      } catch (e) {
        console.error(`[EventBus] 订阅者 ${subscriberId} 处理 ${eventType} 异常:`, e.message);
        if (options.throwErrors) throw e;
      }
    };

    if (options.once) {
      this.once(eventType, wrapper);
    } else {
      this.on(eventType, wrapper);
    }

    // 返回取消订阅函数
    return () => {
      this.off(eventType, wrapper);
      this.subscriberStats[eventType].subscribers--;
    };
  }

  /**
   * 等待事件（Promise包装）
   */
  waitFor(eventType, timeoutMs = 5000) {
    if (!this.enabled) return Promise.resolve(null);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off(eventType, handler);
        reject(new Error(`等待事件 ${eventType} 超时 ${timeoutMs}ms`));
      }, timeoutMs);

      const handler = (event) => {
        clearTimeout(timer);
        resolve(event.payload);
      };

      this.once(eventType, handler);
    });
  }

  /**
   * 获取事件日志
   */
  getEventLog(eventType) {
    if (eventType) {
      return this.eventLog.filter(e => e.type === eventType);
    }
    return [...this.eventLog];
  }

  /**
   * 获取订阅者统计
   */
  getSubscriberStats() {
    return { ...this.subscriberStats };
  }

  deepClone(obj) {
    if (obj === null || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(item => this.deepClone(item));
    const cloned = {};
    for (const key of Object.keys(obj)) {
      cloned[key] = this.deepClone(obj[key]);
    }
    return cloned;
  }
}

// ============================================================
// 三、Pipeline 事件订阅者包装器（试点）
// ============================================================

class PipelineEventSubscribers {
  constructor(eventBus, pipeline) {
    this.bus = eventBus;
    this.pipeline = pipeline;
    this.unsubscribers = [];
  }

  /**
   * 注册 Stage 7.2 订阅者（主角主动性注入）
   * 订阅：storyboard.created（Storyboard生成后自动触发）
   */
  registerProtagonistInjector() {
    const unsub = this.bus.subscribe('storyboard.created', async (payload, metadata) => {
      console.log(`[EventSub:7.2] 收到 storyboard.created，自动执行主动性注入`);
      
      const { storyboard, input } = payload;
      const result = await this.pipeline.stageProtagonistInitiative(storyboard, input);
      
      // 发布完成事件
      this.bus.publish('storyboard.protagonist.enhanced', {
        storyboard: storyboard, // 已变异
        report: result,
        protagonistId: input?.protagonistId || 'xiaoG',
        protagonistName: input?.protagonistName || '小G'
      }, { stageId: 'STAGE-7.2', triggeredBy: metadata });
      
      console.log(`[EventSub:7.2] 主动性注入完成 | 注入${result.totalInjections}个动作`);
    });

    this.unsubscribers.push(unsub);
    return unsub;
  }

  /**
   * 注册 Stage 7.3 订阅者（Narration精简）
   * 订阅：storyboard.protagonist.enhanced（7.2完成后触发）
   * 或者：storyboard.created（如果7.2跳过）
   */
  registerNarrationTrimmer() {
    const unsub = this.bus.subscribe('storyboard.protagonist.enhanced', async (payload, metadata) => {
      console.log(`[EventSub:7.3] 收到 storyboard.protagonist.enhanced，自动执行口播精简`);
      
      const { storyboard } = payload;
      // durations需要从某处获取，这里用storyboard中的时长
      const durations = storyboard.shots?.map(s => ({ duration: s.duration || 5 })) || [];
      
      const result = await this.pipeline.stageNarrationTrim(storyboard, durations);
      
      // 发布完成事件
      this.bus.publish('storyboard.narration.trimmed', {
        storyboard: storyboard, // 已变异
        report: result,
        trimmedShots: storyboard.shots?.filter(s => s._trimmed) || []
      }, { stageId: 'STAGE-7.3', triggeredBy: metadata });
      
      console.log(`[EventSub:7.3] 口播精简完成 | 精简${result.trimmedCount}句`);
    });

    this.unsubscribers.push(unsub);
    return unsub;
  }

  /**
   * 清理所有订阅
   */
  cleanup() {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
    console.log('[EventSubscribers] 已清理所有订阅');
  }
}

// ============================================================
// 四、导出
// ============================================================

module.exports = {
  NirathEventBus,
  PipelineEventSubscribers,
  EVENT_DEFINITIONS
};