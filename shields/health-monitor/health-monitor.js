/**
 * HealthMonitor - 健康监控与自愈护盾
 * 
 * 核心职责：
 * 1. 实时监控Agent健康状态（心跳/响应时间/成功率）
 * 2. 异常自动告警（飞书/日志）
3. 补偿事务：Stage失败时自动回滚
 * 4. 自恢复：Agent崩溃时自动重启
 * 
 * 设计原则：
 * - 轻量级，不引入外部依赖（Redis/Kafka）
 * - 进程内监控，基于EventEmitter
 * - 失败时自动清理，不产生脏数据
 */

const EventEmitter = require('events');

class HealthMonitor extends EventEmitter {
  constructor(options = {}) {
    super();
    
    // 监控配置
    this.checkInterval = options.checkInterval || 30000; // 30秒检查一次
    this.latencyThreshold = options.latencyThreshold || 120000; // 2分钟告警
    this.successRateThreshold = options.successRateThreshold || 0.8; // 80%成功率
    this.maxRestartAttempts = options.maxRestartAttempts || 3; // 最多重启3次

    // Agent注册表
    this.agents = new Map();
    
    // 补偿事务记录
    this.compensations = [];
    
    // 外部告警处理器
    this.alertHandler = options.alertHandler || null;
    
    // 启动监控循环
    this._startMonitoring();
    
    // 监听系统事件
    this._setupEventListeners(this.alertHandler);
  }

  /**
   * 注册Agent
   * @param {string} agentId - Agent标识
   * @param {Object} agent - Agent实例
   */
  registerAgent(agentId, agent) {
    this.agents.set(agentId, {
      instance: agent,
      health: {
        status: 'healthy', // healthy / warning / critical / dead
        lastHeartbeat: Date.now(),
        totalCalls: 0,
        failedCalls: 0,
        avgLatency: 0,
        restartCount: 0
      },
      history: [] // 最近10次调用记录
    });

    console.log(`[HealthMonitor] ✅ Agent已注册: ${agentId}`);
  }

  /**
   * 记录调用结果
   * @param {string} agentId - Agent标识
   * @param {boolean} success - 是否成功
   * @param {number} latency - 延迟(ms)
   */
  recordCall(agentId, success, latency) {
    const agentInfo = this.agents.get(agentId);
    if (!agentInfo) return;

    const health = agentInfo.health;
    health.totalCalls++;
    
    if (!success) {
      health.failedCalls++;
    }

    // 更新平均延迟（指数移动平均）
    const alpha = 0.2;
    health.avgLatency = health.avgLatency * (1 - alpha) + latency * alpha;

    // 记录历史
    agentInfo.history.push({ success, latency, timestamp: Date.now() });
    if (agentInfo.history.length > 10) {
      agentInfo.history.shift();
    }

    // 更新心跳
    health.lastHeartbeat = Date.now();
  }

  /**
   * 注册补偿事务
   * @param {string} stageId - Stage标识
   * @param {Function} compensateFn - 补偿函数
   */
  registerCompensation(stageId, compensateFn) {
    this.compensations.push({ stageId, compensateFn, timestamp: Date.now() });
    console.log(`[HealthMonitor] 📝 补偿事务已注册: ${stageId}`);
  }

  /**
   * 执行补偿（回滚）
   * @param {string} failedStageId - 失败的Stage
   */
  async compensate(failedStageId) {
    console.log(`[HealthMonitor] 🔄 执行补偿回滚，失败Stage: ${failedStageId}`);

    // 找到失败Stage之前的所有补偿
    const failedIndex = this.compensations.findIndex(c => c.stageId === failedStageId);
    if (failedIndex === -1) return;

    // 倒序执行补偿
    for (let i = failedIndex - 1; i >= 0; i--) {
      const { stageId, compensateFn } = this.compensations[i];
      try {
        await compensateFn();
        console.log(`[HealthMonitor] ✅ 补偿成功: ${stageId}`);
      } catch (error) {
        console.error(`[HealthMonitor] ❌ 补偿失败: ${stageId}, ${error.message}`);
        // 补偿失败不阻断，继续回滚前面的
      }
    }

    // 清空已执行的补偿
    this.compensations = this.compensations.slice(failedIndex + 1);
  }

  /**
   * 启动监控循环
   */
  _startMonitoring() {
    setInterval(() => {
      this._checkAllAgents();
    }, this.checkInterval);

    console.log(`[HealthMonitor] 🏥 健康监控已启动，检查间隔: ${this.checkInterval}ms`);
  }

  /**
   * 检查所有Agent
   */
  _checkAllAgents() {
    for (const [agentId, agentInfo] of this.agents.entries()) {
      const health = agentInfo.health;
      const now = Date.now();

      // 1. 检查心跳超时（5分钟无响应认为死亡）
      const heartbeatTimeout = 300000;
      if (now - health.lastHeartbeat > heartbeatTimeout) {
        this._handleDeadAgent(agentId, '心跳超时');
        continue;
      }

      // 2. 检查平均延迟
      if (health.avgLatency > this.latencyThreshold) {
        this._handleSlowAgent(agentId, health.avgLatency);
      }

      // 3. 检查成功率
      const successRate = health.totalCalls > 0 
        ? (health.totalCalls - health.failedCalls) / health.totalCalls 
        : 1;
      
      if (successRate < this.successRateThreshold && health.totalCalls > 10) {
        this._handleUnhealthyAgent(agentId, successRate);
      }
    }
  }

  /**
   * 处理无响应Agent
   */
  _handleDeadAgent(agentId, reason) {
    const agentInfo = this.agents.get(agentId);
    if (!agentInfo) return;

    agentInfo.health.status = 'dead';
    console.error(`[HealthMonitor] 💀 Agent死亡: ${agentId}, 原因: ${reason}`);

    // 告警
    this.emit('alert', {
      level: 'critical',
      agentId,
      message: `Agent ${agentId} 无响应，需要人工介入`,
      timestamp: Date.now()
    });

    // 尝试重启
    this._restartAgent(agentId);
  }

  /**
   * 处理慢Agent
   */
  _handleSlowAgent(agentId, latency) {
    const agentInfo = this.agents.get(agentId);
    if (!agentInfo) return;

    agentInfo.health.status = 'warning';
    console.warn(`[HealthMonitor] 🐌 Agent响应过慢: ${agentId}, 平均延迟: ${Math.round(latency)}ms`);

    this.emit('alert', {
      level: 'warning',
      agentId,
      message: `Agent ${agentId} 响应过慢: ${Math.round(latency)}ms`,
      timestamp: Date.now()
    });
  }

  /**
   * 处理不健康Agent
   */
  _handleUnhealthyAgent(agentId, successRate) {
    const agentInfo = this.agents.get(agentId);
    if (!agentInfo) return;

    agentInfo.health.status = 'critical';
    console.warn(`[HealthMonitor] ⚠️ Agent成功率过低: ${agentId}, 成功率: ${(successRate * 100).toFixed(1)}%`);

    this.emit('alert', {
      level: 'critical',
      agentId,
      message: `Agent ${agentId} 成功率过低: ${(successRate * 100).toFixed(1)}%`,
      timestamp: Date.now()
    });

    // 尝试重启
    this._restartAgent(agentId);
  }

  /**
   * 重启Agent
   */
  async _restartAgent(agentId) {
    const agentInfo = this.agents.get(agentId);
    if (!agentInfo) return;

    if (agentInfo.health.restartCount >= this.maxRestartAttempts) {
      console.error(`[HealthMonitor] ❌ Agent ${agentId} 重启次数已达上限(${this.maxRestartAttempts})，停止自动重启`);
      this.emit('alert', {
        level: 'critical',
        agentId,
        message: `Agent ${agentId} 重启失败，已达最大尝试次数`,
        timestamp: Date.now()
      });
      return;
    }

    agentInfo.health.restartCount++;
    console.log(`[HealthMonitor] 🔄 尝试重启Agent: ${agentId} (第${agentInfo.health.restartCount}次)`);

    try {
      // 调用Agent的重启方法（如果有）
      if (agentInfo.instance && typeof agentInfo.instance.restart === 'function') {
        await agentInfo.instance.restart();
      }

      // 重置健康状态
      agentInfo.health.status = 'healthy';
      agentInfo.health.lastHeartbeat = Date.now();
      agentInfo.health.failedCalls = 0;
      agentInfo.health.totalCalls = 0;

      console.log(`[HealthMonitor] ✅ Agent重启成功: ${agentId}`);

      this.emit('recovered', {
        agentId,
        restartCount: agentInfo.health.restartCount,
        timestamp: Date.now()
      });

    } catch (error) {
      console.error(`[HealthMonitor] ❌ Agent重启失败: ${agentId}, ${error.message}`);
    }
  }

  /**
   * 设置事件监听
   * @param {Function} alertHandler - 外部告警处理器（可选）
   */
  _setupEventListeners(alertHandler) {
    // 监听告警事件，输出到日志
    this.on('alert', (alert) => {
      const level = alert.level.toUpperCase();
      console.log(`[HealthMonitor:${level}] ${alert.message}`);
      
      // 如果外部提供了告警处理器，调用它
      if (alertHandler && typeof alertHandler === 'function') {
        try {
          alertHandler(alert);
        } catch (e) {
          console.warn(`[HealthMonitor] 外部告警处理器失败: ${e.message}`);
        }
      }
    });

    // 监听恢复事件
    this.on('recovered', (event) => {
      console.log(`[HealthMonitor] 🎉 Agent恢复: ${event.agentId}`);
    });
  }

  /**
   * 获取Agent健康状态
   */
  getHealthStatus(agentId = null) {
    if (agentId) {
      const agentInfo = this.agents.get(agentId);
      return agentInfo ? { ...agentInfo.health, id: agentId } : null;
    }

    const statuses = {};
    for (const [id, info] of this.agents.entries()) {
      statuses[id] = { ...info.health, id };
    }
    return statuses;
  }

  /**
   * 获取监控统计
   */
  getStats() {
    let totalCalls = 0;
    let totalFailures = 0;
    let healthyCount = 0;
    let warningCount = 0;
    let criticalCount = 0;

    for (const info of this.agents.values()) {
      totalCalls += info.health.totalCalls;
      totalFailures += info.health.failedCalls;
      
      switch (info.health.status) {
        case 'healthy': healthyCount++; break;
        case 'warning': warningCount++; break;
        case 'critical':
        case 'dead': criticalCount++; break;
      }
    }

    return {
      totalAgents: this.agents.size,
      healthy: healthyCount,
      warning: warningCount,
      critical: criticalCount,
      totalCalls,
      totalFailures,
      successRate: totalCalls > 0 ? ((totalCalls - totalFailures) / totalCalls).toFixed(4) : 'N/A',
      activeCompensations: this.compensations.length
    };
  }

  /**
   * 停止监控
   */
  stop() {
    if (this._monitorInterval) {
      clearInterval(this._monitorInterval);
      this._monitorInterval = null;
    }
    console.log('[HealthMonitor] 🛑 健康监控已停止');
  }
}

module.exports = { HealthMonitor };
