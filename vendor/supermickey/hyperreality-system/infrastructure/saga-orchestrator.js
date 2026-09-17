/**
 * Saga Orchestrator — 阶段编排与容错执行器 (SuperMickey 适配版)
 * 
 * 来源: 超短裙 short-video/infrastructure/saga-orchestrator.js
 * 适配: SuperMickey 四层架构 (Layer0→Layer1→Layer2→Layer3→Layer4)
 * 
 * 核心能力：
 * - 阶段原子性执行
 * - 补偿事务（下游失败时回滚上游）
 * - 自动重试（指数退避）
 * - 降级回退（skip / default_value）
 * - EventBus 集成
 */

'use strict';

// ============================================================
// SuperMickey Stage 定义（适配四层架构）
// ============================================================

const SUPERMICKEY_STAGE_DEFINITIONS = {
  'STAGE-SM-0': {
    id: 'STAGE-SM-0',
    name: '需求清单确认',
    phase: 'pre_production',
    blocking: true,
    required: true,
    timeoutMs: 1800000, // 30分钟（含人工确认）
    retryPolicy: { maxAttempts: 1, backoffMs: 5000 },
    compensate: async (result, context) => {
      if (context.requirementList) delete context.requirementList;
      console.log('[Saga:Compensate] STAGE-SM-0 已清理需求清单');
    }
  },
  'STAGE-SM-1': {
    id: 'STAGE-SM-1',
    name: '剧本引擎',
    phase: 'pre_production',
    blocking: true,
    required: true,
    timeoutMs: 300000, // 5分钟
    retryPolicy: { maxAttempts: 2, backoffMs: 5000 },
    compensate: async (result, context) => {
      if (context.scriptResult) delete context.scriptResult;
      console.log('[Saga:Compensate] STAGE-SM-1 已清理剧本数据');
    }
  },
  'STAGE-SM-2': {
    id: 'STAGE-SM-2',
    name: '制作引擎（含FieldGuard+导演技能+PromptGuardian）',
    phase: 'pre_production',
    blocking: true,
    required: true,
    timeoutMs: 600000, // 10分钟
    retryPolicy: { maxAttempts: 2, backoffMs: 5000 },
    compensate: async (result, context) => {
      if (context.productionResult) delete context.productionResult;
      console.log('[Saga:Compensate] STAGE-SM-2 已清理制作数据');
    }
  },
  'STAGE-SM-3': {
    id: 'STAGE-SM-3',
    name: '渲染引擎',
    phase: 'production',
    blocking: true,
    required: true,
    timeoutMs: 1800000, // 30分钟
    retryPolicy: { maxAttempts: 3, backoffMs: 10000 },
    compensate: async (result, context) => {
      if (context.renderResult) {
        console.log('[Saga:Compensate] STAGE-SM-3 清理渲染输出');
        delete context.renderResult;
      }
    }
  },
  'STAGE-SM-4': {
    id: 'STAGE-SM-4',
    name: '后期引擎',
    phase: 'post_production',
    blocking: false, // 非阻塞：后期失败不影响交付
    required: false,
    timeoutMs: 300000, // 5分钟
    retryPolicy: { maxAttempts: 2, backoffMs: 5000 },
    fallback: { strategy: 'skip' },
    compensate: null
  }
};

// ============================================================
// Saga Stage 执行器
// ============================================================

class SagaStage {
  constructor(config) {
    this.id = config.id;
    this.name = config.name;
    this.phase = config.phase || 'unknown';
    this.blocking = config.blocking !== false;
    this.required = config.required !== false;
    this.timeoutMs = config.timeoutMs || 120000;
    this.retryPolicy = config.retryPolicy || { maxAttempts: 1, backoffMs: 1000 };
    this.fallback = config.fallback || null;
    this.compensate = config.compensate || null;
  }

  async execute(handler, context, eventBus) {
    const maxAttempts = this.retryPolicy.maxAttempts || 1;
    const backoffMs = this.retryPolicy.backoffMs || 1000;
    
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        console.log(`[Saga] ${this.name} (Attempt ${attempt}/${maxAttempts})`);
        
        // 设置超时
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error(`Stage timeout after ${this.timeoutMs}ms`)), this.timeoutMs);
        });
        
        // 执行阶段
        const handlerPromise = handler(context);
        handlerPromise.catch(() => {}); // 【v2.1.6-fix】防止悬空 rejection
        const result = await Promise.race([
          handlerPromise,
          timeoutPromise
        ]);
        
        // 发送成功事件
        if (eventBus) {
          eventBus.emit('stage.complete', {
            stageId: this.id,
            stageName: this.name,
            attempt,
            result: !!result
          });
        }
        
        return { success: true, result, attempt };
      } catch (error) {
        console.error(`[Saga] ${this.name} failed (Attempt ${attempt}/${maxAttempts}): ${error.message}`);
        
        if (attempt < maxAttempts) {
          const delay = backoffMs * Math.pow(2, attempt - 1); // 指数退避
          console.log(`[Saga] Retrying in ${delay}ms...`);
          await this._sleep(delay);
        } else {
          // 所有重试失败
          if (eventBus) {
            eventBus.emit('stage.failed', {
              stageId: this.id,
              stageName: this.name,
              error: error.message,
              attempts: attempt
            });
          }
          
          return { success: false, error: error.message, attempt };
        }
      }
    }
  }

  async runCompensate(context) {
    if (this.compensate) {
      try {
        await this.compensate(context.result, context);
      } catch (e) {
        console.error(`[Saga] Compensation failed for ${this.name}: ${e.message}`);
      }
    }
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ============================================================
// Saga Orchestrator
// ============================================================

class SagaOrchestrator {
  constructor(options = {}) {
    this.stages = new Map();
    this.context = {};
    this.eventBus = options.eventBus || null;
    this.strictMode = options.strictMode !== false;
    
    // 注册默认阶段
    this._registerDefaultStages();
  }

  _registerDefaultStages() {
    for (const [id, config] of Object.entries(SUPERMICKEY_STAGE_DEFINITIONS)) {
      this.registerStage(id, config);
    }
  }

  registerStage(id, config) {
    this.stages.set(id, new SagaStage(config));
  }

  /**
   * 执行完整 Saga Pipeline
   * @param {Object} handlers - { stageId: async (context) => result }
   * @param {Object} initialContext - 初始上下文
   * @returns {Object} 执行结果
   */
  async execute(handlers, initialContext = {}) {
    this.context = { ...initialContext };
    const executedStages = [];
    const results = {};

    console.log('\n🎬 [SagaOrchestrator] 开始执行 SuperMickey Pipeline');

    for (const [stageId, stage] of this.stages) {
      const handler = handlers[stageId];
      
      if (!handler) {
        console.log(`[Saga] Skip ${stage.name}: no handler registered`);
        continue;
      }

      // 执行阶段
      const result = await stage.execute(handler, this.context, this.eventBus);
      
      if (result.success) {
        // 保存结果到上下文
        results[stageId] = result.result;
        executedStages.push(stage);
        console.log(`✅ [Saga] ${stage.name} 完成`);
      } else {
        // 阶段失败
        console.error(`❌ [Saga] ${stage.name} 失败: ${result.error}`);
        
        if (stage.fallback) {
          // 使用降级策略
          console.log(`[Saga] 应用降级策略: ${stage.fallback.strategy}`);
          if (stage.fallback.strategy === 'skip') {
            results[stageId] = null;
            continue;
          }
        }
        
        if (stage.blocking) {
          // 阻塞阶段失败：执行补偿并终止
          console.log('[Saga] 执行补偿事务...');
          for (let i = executedStages.length - 1; i >= 0; i--) {
            await executedStages[i].runCompensate(this.context);
          }
          
          return {
            success: false,
            failedStage: stageId,
            error: result.error,
            results
          };
        }
        
        // 非阻塞阶段失败：继续执行
        results[stageId] = { error: result.error };
      }
    }

    console.log('✅ [SagaOrchestrator] Pipeline 执行完成');
    
    return {
      success: true,
      results
    };
  }

  /**
   * 获取执行上下文（用于调试和回放）
   */
  getContext() {
    return this.context;
  }
}

module.exports = { SagaOrchestrator, SagaStage, SUPERMICKEY_STAGE_DEFINITIONS };
