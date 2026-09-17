// pipeline-state-machine.js
// Pipeline 状态机 + 真·断点续跑 v1.0.0
// 状态机驱动、原子提交、Stage级恢复
// 日期: 2026-06-26

const fs = require('fs');
const path = require('path');

const CHECKPOINT_DIR = path.join(__dirname, '../../checkpoints');

// 标准Stage定义（有序）
const STANDARD_STAGES = [
  { name: 'INIT', description: '初始化', retryable: false },
  { name: 'REQUIREMENT_PARSED', description: '需求解析完成', retryable: false },
  { name: 'SCRIPT_COMPLETE', description: '剧本生成完成', retryable: true, agent: 'script-generator' },
  { name: 'SCENE_DESIGN_COMPLETE', description: '场景设计完成', retryable: true, agent: 'scene-design' },
  { name: 'OPENING_DESIGN_COMPLETE', description: '片头设计完成', retryable: true, agent: 'opening-design' },
  { name: 'VISUAL_LANGUAGE_COMPLETE', description: '视觉语言完成', retryable: true, agent: 'visual-language' },
  { name: 'AUDIO_DESIGN_COMPLETE', description: '音频设计完成', retryable: true, agent: 'audio-design' },
  { name: 'CONTINUITY_REVIEW_COMPLETE', description: '连续性审查完成', retryable: true, agent: 'continuity-review' },
  { name: 'PROMPT_FUSION_COMPLETE', description: 'Prompt融合完成', retryable: true, agent: 'prompt-fusion' },
  { name: 'QUALITY_CHECK_COMPLETE', description: '质量检查完成', retryable: true, agent: 'quality-check' },
  { name: 'RENDER_READY', description: '可渲染状态', retryable: false }
];

class PipelineStateMachine {
  constructor(projectId, options = {}) {
    this.projectId = projectId;
    this.options = options;
    this.stages = STANDARD_STAGES;
    this.currentState = 'INIT';
    this.stateIndex = 0;
    this.checkpointData = {};
    this.failureLog = [];
    this.compensationStack = [];
    
    // 【P0-Bug-2 修复】checkpoint数据限制，防止无限累积
    this._maxCheckpointDataSize = options.maxCheckpointDataSize || 50 * 1024 * 1024; // 50MB
    this._maxFailureLogSize = options.maxFailureLogSize || 1000;
    this._checkpointKeysLimit = options.checkpointKeysLimit || 5; // 只保留最近5个stage
    
    this._ensureDir();
    this._loadCheckpoint();
  }
  
  _ensureDir() {
    if (!fs.existsSync(CHECKPOINT_DIR)) {
      fs.mkdirSync(CHECKPOINT_DIR, { recursive: true });
    }
  }
  
  _checkpointPath() {
    return path.join(CHECKPOINT_DIR, `state-${this.projectId}.json`);
  }
  
  _tempCheckpointPath() {
    return path.join(CHECKPOINT_DIR, `.state-${this.projectId}.json.tmp`);
  }
  
  /**
   * 加载已有checkpoint（断点续跑）
   */
  _loadCheckpoint() {
    const cpPath = this._checkpointPath();
    if (fs.existsSync(cpPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(cpPath, 'utf8'));
        this.currentState = data.currentState || 'INIT';
        this.stateIndex = this.stages.findIndex(s => s.name === this.currentState);
        this.checkpointData = data.checkpointData || {};
        this.failureLog = data.failureLog || [];
        console.log(`[StateMachine] 加载checkpoint: ${this.projectId} @ ${this.currentState}`);
      } catch (e) {
        console.warn('[StateMachine] checkpoint加载失败，从头开始:', e.message);
      }
    }
  }
  
  /**
   * 原子提交checkpoint
   * 【P0-Bug-2 修复】限制checkpoint数据大小，使用异步I/O避免阻塞事件循环
   */
  async _atomicCheckpoint(stageName, data = {}) {
    // 【P0-Bug-2 修复】只保留最近N个stage数据
    const keys = Object.keys(this.checkpointData);
    if (keys.length >= this._checkpointKeysLimit) {
      const keysToDelete = keys.slice(0, keys.length - this._checkpointKeysLimit + 1);
      for (const key of keysToDelete) {
        delete this.checkpointData[key];
      }
    }
    
    // 【P0-Bug-2 修复】限制单个checkpoint数据大小
    const serialized = JSON.stringify(data);
    if (serialized.length > this._maxCheckpointDataSize) {
      console.warn(`[StateMachine] Stage ${stageName} 数据 ${serialized.length} bytes 超过限制，仅保存元数据`);
      this.checkpointData[stageName] = {
        timestamp: Date.now(),
        dataSize: serialized.length,
        dataSummary: `[Data truncated: ${serialized.length} bytes]`
      };
    } else {
      this.checkpointData[stageName] = {
        timestamp: Date.now(),
        data
      };
    }
    
    // 【P0-Bug-2 修复】限制failureLog大小
    if (this.failureLog.length > this._maxFailureLogSize) {
      this.failureLog = this.failureLog.slice(-this._maxFailureLogSize);
    }
    
    const payload = {
      projectId: this.projectId,
      currentState: stageName,
      checkpointData: this.checkpointData,
      failureLog: this.failureLog,
      updatedAt: new Date().toISOString()
    };
    
    try {
      // 【P0-Bug-2 修复】使用异步I/O替代同步I/O
      const fsPromises = require('fs').promises;
      const tmpPath = this._tempCheckpointPath();
      const finalPath = this._checkpointPath();
      await fsPromises.writeFile(tmpPath, JSON.stringify(payload));
      await fsPromises.rename(tmpPath, finalPath);
      console.log(`[StateMachine] checkpoint异步原子提交: ${stageName}`);
    } catch (e) {
      console.error('[StateMachine] checkpoint提交失败:', e.message);
    }
  }
  
  /**
   * 获取当前状态信息
   */
  getStatus() {
    const stage = this.stages[this.stateIndex];
    return {
      projectId: this.projectId,
      currentState: this.currentState,
      stateIndex: this.stateIndex,
      totalStages: this.stages.length,
      progress: ((this.stateIndex / (this.stages.length - 1)) * 100).toFixed(1) + '%',
      currentStage: stage?.description || '未知',
      retryable: stage?.retryable || false,
      failureCount: this.failureLog.length,
      lastFailure: this.failureLog[this.failureLog.length - 1] || null
    };
  }
  
  /**
   * 执行单个Stage
   * @param {Function} stageExecutor - 异步执行函数
   * @param {Function} compensator - 补偿函数（可选）
   */
  async executeStage(stageName, stageExecutor, compensator = null) {
    const stage = this.stages.find(s => s.name === stageName);
    if (!stage) {
      throw new Error(`未知Stage: ${stageName}`);
    }
    
    console.log(`[StateMachine] ====== 执行Stage: ${stageName} (${stage.description}) ======`);
    const startTime = Date.now();
    
    try {
      // 执行Stage
      const result = await stageExecutor();
      
      // 记录补偿方法
      if (compensator) {
        this.compensationStack.push({ stage: stageName, compensate: compensator });
      }
      
      // 更新状态
      this.currentState = stageName;
      this.stateIndex = this.stages.indexOf(stage);
      
      // 原子提交
      await this._atomicCheckpoint(stageName, { result: true, duration: Date.now() - startTime });
      
      console.log(`[StateMachine] Stage完成: ${stageName} (${Date.now() - startTime}ms)`);
      return result;
      
    } catch (err) {
      // 记录失败
      this.failureLog.push({
        stage: stageName,
        error: err.message,
        stack: err.stack,
        timestamp: Date.now()
      });
      
      console.error(`[StateMachine] Stage失败: ${stageName} - ${err.message}`);
      
      // 如果Stage可重试，尝试补偿后重跑
      if (stage.retryable) {
        console.log(`[StateMachine] Stage ${stageName} 可重试，执行补偿...`);
        await this._compensate();
        throw new RecoverableError(stageName, err);
      }
      
      throw err;
    }
  }
  
  /**
   * 执行补偿（倒序回滚）
   * 【P0-Bug-1 修复】使用pop()实现真正的LIFO，避免reverse()原地反转破坏顺序
   */
  async _compensate() {
    console.log(`[StateMachine] 执行补偿事务，回滚${this.compensationStack.length}个Stage...`);
    
    // 使用pop()从尾部弹出，实现真正的LIFO（最后执行的先补偿）
    while (this.compensationStack.length > 0) {
      const item = this.compensationStack.pop();
      try {
        await item.compensate();
        console.log(`[StateMachine] 补偿完成: ${item.stage}`);
      } catch (e) {
        console.error(`[StateMachine] 补偿失败: ${item.stage} - ${e.message}`);
        // 补偿失败记录到failureLog，不中断后续补偿
        this.failureLog.push({
          stage: item.stage,
          error: e.message,
          stack: e.stack,
          timestamp: Date.now(),
          type: 'compensation_failure'
        });
      }
    }
    
    this.compensationStack = [];
  }
  
  /**
   * 从断点恢复运行
   * @param {Function} stageExecutors - 各Stage的执行函数映射 { stageName: executor }
   */
  async resume(stageExecutors) {
    console.log(`[StateMachine] 从状态 ${this.currentState} 恢复，当前进度 ${this.stateIndex}/${this.stages.length - 1}`);
    
    // 找到当前状态对应的索引
    const startIdx = this.stateIndex + 1; // 从下一个Stage开始
    const errors = [];
    
    for (let i = startIdx; i < this.stages.length; i++) {
      const stage = this.stages[i];
      const executor = stageExecutors[stage.name];
      
      if (!executor) {
        console.warn(`[StateMachine] 未找到Stage ${stage.name} 的执行器，跳过`);
        continue;
      }
      
      // 【v2.1.8-审计修复】每个Stage独立try-catch，单个失败不中断整体恢复
      try {
        await this.executeStage(stage.name, executor);
      } catch (err) {
        console.error(`[StateMachine] Stage ${stage.name} 执行失败(恢复模式下): ${err.message}`);
        errors.push({ stage: stage.name, error: err.message, timestamp: Date.now() });

        // 如果Stage可重试，记录到failureLog后继续下一个
        if (stage.retryable) {
          this.failureLog.push({
            stage: stage.name,
            error: err.message,
            timestamp: Date.now(),
            context: 'resume_mode'
          });
          // 保存中断状态checkpoint
          await this._atomicCheckpoint(stage.name, {
            resumeFailed: true,
            error: err.message,
            errors
          });
          continue; // 【关键】继续下一个Stage，而不是中断
        } else {
          // 不可重试的Stage失败，才中断
          throw err;
        }
      }
    }
    
    console.log(`[StateMachine] 项目完成: ${this.projectId}${errors.length > 0 ? ` (有${errors.length}个Stage失败)` : ''}`);
    return { completed: errors.length === 0, finalState: this.currentState, errors };
  }
  
  /**
   * 从头运行（忽略已有checkpoint）
   */
  async runFromStart(stageExecutors) {
    console.log(`[StateMachine] 从头运行项目: ${this.projectId}`);
    this.currentState = 'INIT';
    this.stateIndex = 0;
    this.checkpointData = {};
    this.failureLog = [];
    this.compensationStack = [];
    
    // 清理旧checkpoint
    try {
      if (fs.existsSync(this._checkpointPath())) {
        fs.unlinkSync(this._checkpointPath());
      }
    } catch (e) {
      console.warn('[StateMachine] 清理旧checkpoint失败:', e.message);
    }
    
    return this.resume(stageExecutors);
  }
  
  /**
   * 强制重跑某个Stage（从该Stage开始恢复）
   */
  async rerunFrom(stageName, stageExecutors) {
    const idx = this.stages.findIndex(s => s.name === stageName);
    if (idx === -1) {
      throw new Error(`未知Stage: ${stageName}`);
    }
    
    this.currentState = this.stages[idx - 1]?.name || 'INIT';
    this.stateIndex = idx - 1;
    
    console.log(`[StateMachine] 从Stage ${stageName} 重新运行`);
    return this.resume(stageExecutors);
  }
  
  /**
   * 清理项目checkpoint
   */
  cleanup() {
    try {
      const cpPath = this._checkpointPath();
      if (fs.existsSync(cpPath)) {
        fs.unlinkSync(cpPath);
        console.log(`[StateMachine] 清理checkpoint: ${this.projectId}`);
      }
    } catch (e) {
      console.warn('[StateMachine] 清理失败:', e.message);
    }
  }
}

/**
 * 可恢复错误
 */
class RecoverableError extends Error {
  constructor(stageName, originalError) {
    super(`Stage ${stageName} 可恢复失败: ${originalError.message}`);
    this.stageName = stageName;
    this.originalError = originalError;
    this.recoverable = true;
  }
}

module.exports = { PipelineStateMachine, RecoverableError, STANDARD_STAGES };
