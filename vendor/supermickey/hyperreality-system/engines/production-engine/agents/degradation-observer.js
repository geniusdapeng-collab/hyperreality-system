/**
 * degradation-observer.js - 降级观测与熔断器
 * 监控镜头降级率，触发熔断保护
 */

class DegradationObserver {
  constructor(options = {}) {
    this.softThreshold = options.softThreshold || 3;      // 软熔断：连续失败镜头数
    this.hardThreshold = options.hardThreshold || 5;      // 硬熔断：连续失败镜头数
    this.degradationRateThreshold = options.degradationRateThreshold || 0.5; // 降级率阈值
    this.pauseDurationMs = options.pauseDurationMs || 30000; // 软熔断暂停时间
    
    this.consecutiveFailures = 0;
    this.totalShots = 0;
    this.degradedShots = 0;
    this.state = 'CLOSED'; // CLOSED | OPEN (软熔断) | HALF_OPEN | HARD_OPEN
    this.lastFailureTime = null;
    this.pauseEndTime = null;
    
    this.logs = [];
  }
  
  /**
   * 记录镜头结果
   * 【P1-QUAL-03 修复】区分"失败"和"降级但成功"，避免降级率高估3倍
   * 【P1-PROMPT-01 修复】新增degradedScore量化降级严重程度(0-100)
   */
  recordShot(shotId, success, degraded, degradeReason = null) {
    this.totalShots++;
    
    // 【P1-QUAL-03 修复】正确分类：
    // - 真正失败：success=false（LLM调用失败、超时等）
    // - 降级但成功：success=true, degraded=true（降级路径生成但可用）
    // - 完全成功：success=true, degraded=false
    const isFailed = !success;           // 真正失败
    const isDegraded = degraded;         // 降级（可能成功也可能失败）
    
    if (isFailed) {
      // 只有真正失败才计入连续失败
      this.consecutiveFailures++;
      this.lastFailureTime = Date.now();
    } else {
      this.consecutiveFailures = 0; // 重置连续失败计数
    }
    
    if (isDegraded) {
      this.degradedShots++;
    }
    
    // 【P1-PROMPT-01 修复】计算degradedScore (0-100)
    // 基于：连续失败权重(50%) + 降级率权重(30%) + 错误模式权重(20%)
    const degradedScore = this._calculateDegradedScore();
    
    const degradationRate = this.degradedShots / this.totalShots;
    
    this.logs.push({
      shotId,
      success,
      degraded,
      degradedScore, // 【P1-PROMPT-01 修复】新增
      degradeReason,
      consecutiveFailures: this.consecutiveFailures,
      degradationRate,
      timestamp: Date.now()
    });
    
    // 检查熔断条件
    return this._checkCircuitBreaker();
  }
  
  /**
   * 【P1-PROMPT-01 修复】计算降级严重程度评分 (0-100)
   * 0 = 完全健康, 100 = 严重降级
   */
  _calculateDegradedScore() {
    if (this.totalShots === 0) return 0;
    
    // 1. 连续失败因子 (0-50分)
    const consecutiveFactor = Math.min(this.consecutiveFailures / this.hardThreshold, 1) * 50;
    
    // 2. 降级率因子 (0-30分)
    const degradationRate = this.degradedShots / this.totalShots;
    const rateFactor = Math.min(degradationRate / this.degradationRateThreshold, 1) * 30;
    
    // 3. 错误模式因子 (0-20分)
    let patternFactor = 0;
    if (this.logs.length > 0) {
      const recentLogs = this.logs.slice(-5);
      const uniqueReasons = new Set(recentLogs.filter(l => l.degradeReason).map(l => l.degradeReason));
      // 错误越集中越严重（同一原因反复出现）
      const lastReason = recentLogs[recentLogs.length - 1]?.degradeReason;
      const sameReasonCount = recentLogs.filter(l => l.degradeReason === lastReason).length;
      patternFactor = (sameReasonCount / 5) * 20;
    }
    
    return Math.round(consecutiveFactor + rateFactor + patternFactor);
  }
  
  /**
   * 检查熔断状态
   * 【P1-QUAL-03 修复】硬熔断只基于真正失败(连续失败)，降级但成功不触发硬熔断
   */
  _checkCircuitBreaker() {
    const degradationRate = this.degradedShots / this.totalShots;
    const degradedScore = this._calculateDegradedScore();
    
    // 硬熔断：连续真正失败 5 个（降级但成功不算）
    // 或降级率 > 50% 且至少有4个样本
    if (this.consecutiveFailures >= this.hardThreshold || 
        (this.totalShots >= 4 && degradationRate >= this.degradationRateThreshold)) {
      if (this.state !== 'HARD_OPEN') {
        this.state = 'HARD_OPEN';
        const report = this._generateReport();
        console.error(`[DegradationObserver] 🔴 硬熔断触发！连续失败 ${this.consecutiveFailures} 个镜头，降级率 ${(degradationRate * 100).toFixed(1)}%，降级评分 ${degradedScore}`);
        console.error(`[DegradationObserver] 熔断报告: ${JSON.stringify(report, null, 2)}`);
        return { action: 'STOP', reason: 'hard-circuit-break', report };
      }
      return { action: 'STOP', reason: 'hard-circuit-break-active' };
    }
    
    // 软熔断：连续 3 个真正失败（降级但成功不触发）
    if (this.consecutiveFailures >= this.softThreshold && this.state !== 'OPEN') {
      this.state = 'OPEN';
      this.pauseEndTime = Date.now() + this.pauseDurationMs;
      console.warn(`[DegradationObserver] 🟡 软熔断触发！暂停 ${this.pauseDurationMs}ms，降级评分 ${degradedScore}`);
      return { action: 'PAUSE', duration: this.pauseDurationMs, reason: 'soft-circuit-break', degradedScore };
    }
    
    // 检查是否在暂停期
    if (this.state === 'OPEN' && this.pauseEndTime) {
      if (Date.now() < this.pauseEndTime) {
        const remaining = this.pauseEndTime - Date.now();
        return { action: 'PAUSE', duration: remaining, reason: 'cooldown' };
      }
      // 暂停结束，进入半开状态
      this.state = 'HALF_OPEN';
      this.consecutiveFailures = 0;
      console.log(`[DegradationObserver] 🟢 暂停结束，进入半开状态`);
    }
    
    return { action: 'CONTINUE', state: this.state };
  }
  
  /**
   * 检查是否允许继续
   */
  canProceed() {
    if (this.state === 'HARD_OPEN') {
      return { allowed: false, reason: 'hard-circuit-break-active', report: this._generateReport() };
    }
    
    if (this.state === 'OPEN' && this.pauseEndTime && Date.now() < this.pauseEndTime) {
      return { allowed: false, reason: 'soft-circuit-break-cooldown', remaining: this.pauseEndTime - Date.now() };
    }
    
    return { allowed: true, state: this.state };
  }
  
  /**
   * 生成降级报告
   */
  _generateReport() {
    const degradationRate = this.totalShots > 0 ? this.degradedShots / this.totalShots : 0;
    const recentLogs = this.logs.slice(-10);
    
    // 分析错误模式
    const errorPatterns = {};
    for (const log of recentLogs) {
      if (log.degradeReason) {
        errorPatterns[log.degradeReason] = (errorPatterns[log.degradeReason] || 0) + 1;
      }
    }
    
    return {
      totalShots: this.totalShots,
      degradedShots: this.degradedShots,
      degradationRate,
      degradedScore: this._calculateDegradedScore(), // 【P1-PROMPT-01 修复】
      consecutiveFailures: this.consecutiveFailures,
      state: this.state,
      errorPatterns,
      recommendations: this._generateRecommendations(degradationRate, errorPatterns)
    };
  }
  
  /**
   * 生成建议
   */
  _generateRecommendations(degradationRate, errorPatterns) {
    const recommendations = [];
    
    if (degradationRate > 0.5) {
      recommendations.push('降级率超过 50%，建议检查 API 配置或网络连接');
    }
    
    if (errorPatterns['insufficient time budget'] || errorPatterns['LLM timeout']) {
      recommendations.push('超时错误频繁，建议增加超时时间或检查网络延迟');
    }
    
    if (errorPatterns['LLM engine not available'] || errorPatterns['API key invalid']) {
      recommendations.push('API 服务不可用，建议检查 API Key 和服务状态');
    }
    
    if (errorPatterns['JSON parse error'] || errorPatterns['Schema validation failed']) {
      recommendations.push('解析错误频繁，建议检查 prompt 长度或 schema 复杂度');
    }
    
    if (recommendations.length === 0) {
      recommendations.push('降级原因分散，建议查看详细日志分析');
    }
    
    return recommendations;
  }
  
  /**
   * 重置状态
   */
  reset() {
    this.consecutiveFailures = 0;
    this.totalShots = 0;
    this.degradedShots = 0;
    this.state = 'CLOSED';
    this.lastFailureTime = null;
    this.pauseEndTime = null;
    this.logs = [];
    console.log('[DegradationObserver] 状态已重置');
  }
  
  /**
   * 获取当前统计
   */
  getStats() {
    return {
      totalShots: this.totalShots,
      degradedShots: this.degradedShots,
      degradationRate: this.totalShots > 0 ? this.degradedShots / this.totalShots : 0,
      consecutiveFailures: this.consecutiveFailures,
      state: this.state
    };
  }
}

module.exports = { DegradationObserver };
