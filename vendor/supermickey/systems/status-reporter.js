/**
 * StatusReporter — 预生产状态持久化与消息控制
 * v6.2-patch84: 解决消息轰炸 + 突然中断 + 状态不透明问题
 *
 * 核心设计：
 * 1. 状态文件持久化：running-status.json 实时写入，随时可查
 * 2. 消息节流：每30秒最多发一次进度，关键节点才发
 * 3. 心跳机制：导演优化等长耗时环节每30秒报告一次
 * 4. 结果兜底：无论成功/失败/被杀，状态文件都会记录最终状态
 */

const fs = require('fs');
const path = require('path');

const STATUS_FILE = path.join(__dirname, '../running-status.json');
const HEARTBEAT_INTERVAL = 30000; // 30秒心跳
const MAX_MESSAGES = 5; // 整个预生产最多发5条消息到飞书

class StatusReporter {
  constructor(options = {}) {
    this.sessionId = options.sessionId || this._generateSessionId();
    this.projectName = options.projectName || '未知项目';
    this.startTime = Date.now();
    this.lastHeartbeat = 0;
    this.messageCount = 0;
    this.currentStage = '初始化';
    this.progress = 0;
    this.status = 'running'; // running | success | failed | killed
    this.result = null;
    this.error = null;
    this._heartbeatTimer = null;
    this._sendMessage = options.sendMessage || null; // 外部消息发送函数
  }

  _generateSessionId() {
    return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  }

  // 初始化状态文件
  init() {
    this._write({
      status: 'running',
      stage: '初始化',
      progress: 0,
      startedAt: new Date().toISOString(),
      estimatedEnd: null,
      sessionId: this.sessionId,
      projectName: this.projectName,
      message: '🎬 预生产启动中...'
    });
  }

  // 更新当前阶段（不发消息，只写文件）
  stage(name, progress, detail = '') {
    this.currentStage = name;
    this.progress = progress;
    this._write({
      status: 'running',
      stage: name,
      progress,
      detail,
      updatedAt: new Date().toISOString()
    });
  }

  // 发送关键消息（受 MAX_MESSAGES 限制）
  message(text, force = false) {
    if (!this._sendMessage) return;
    if (!force && this.messageCount >= MAX_MESSAGES) {
      // 消息配额用完，只写文件不发飞书
      this._write({ lastMessage: text, messageQueued: true });
      return;
    }
    this.messageCount++;
    this._sendMessage(text);
  }

  // 启动心跳（长耗时环节用）
  startHeartbeat(stageName, detail = '') {
    this.stopHeartbeat();
    this.currentStage = stageName;
    this._heartbeatTimer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
      const progress = this.progress || 0;
      this._write({
        status: 'running',
        stage: stageName,
        progress,
        detail: `${detail} | 已运行${elapsed}秒`,
        heartbeatAt: new Date().toISOString()
      });
      // 每30秒发一次进度消息（只发关键节点）
      if (this._sendMessage && this.messageCount < MAX_MESSAGES) {
        // 只发粗略进度，不发细节
        const mins = Math.floor(elapsed / 60);
        const secs = elapsed % 60;
        const timeStr = mins > 0 ? `${mins}分${secs}秒` : `${secs}秒`;
        this._sendMessage(`⏳ ${stageName} 进行中… 已用时${timeStr}，进度${progress}%`);
      }
    }, HEARTBEAT_INTERVAL);
  }

  stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  // 成功完成
  success(result, summary) {
    this.status = 'success';
    this.result = result;
    this.stopHeartbeat();
    this._write({
      status: 'success',
      stage: '完成',
      progress: 100,
      completedAt: new Date().toISOString(),
      totalDuration: Date.now() - this.startTime,
      summary,
      result: this._sanitizeResult(result)
    });
    this.message(`✅ 预生产完成！\n${summary}`, true);
  }

  // 失败
  fail(error, stage = '未知') {
    this.status = 'failed';
    this.error = error;
    this.stopHeartbeat();
    this._write({
      status: 'failed',
      stage,
      progress: this.progress,
      failedAt: new Date().toISOString(),
      error: error.message || String(error),
      stack: error.stack || ''
    });
    this.message(`❌ 预生产失败\n阶段：${stage}\n原因：${error.message || error}\n\n请查看 running-status.json 获取完整状态`, true);
  }

  // 被外部杀死（SIGTERM等）
  killed(signal = 'SIGTERM', stage = '未知') {
    this.status = 'killed';
    this.stopHeartbeat();
    this._write({
      status: 'killed',
      stage,
      progress: this.progress,
      killedAt: new Date().toISOString(),
      signal,
      message: '进程被外部系统终止，可能是运行超时。请重新运行或检查日志。'
    });
  }

  // 内部：写入状态文件
  _write(patch) {
    try {
      let existing = {};
      if (fs.existsSync(STATUS_FILE)) {
        try {
          existing = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
        } catch (e) {
          existing = {};
        }
      }
      const merged = { ...existing, ...patch, sessionId: this.sessionId };
      fs.writeFileSync(STATUS_FILE, JSON.stringify(merged, null, 2));
    } catch (e) {
      console.error('[StatusReporter] 写入状态文件失败:', e.message);
    }
  }

  // 清理结果中的敏感/大字段
  _sanitizeResult(result) {
    if (!result) return null;
    const sanitized = {};
    if (result.stages) {
      sanitized.stages = Object.keys(result.stages);
    }
    if (result.success !== undefined) {
      sanitized.success = result.success;
    }
    return sanitized;
  }

  // 读取当前状态（静态方法）
  static read() {
    try {
      if (fs.existsSync(STATUS_FILE)) {
        return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
      }
    } catch (e) {}
    return { status: 'unknown', message: '暂无状态记录' };
  }

  // 重置状态
  static reset() {
    try {
      if (fs.existsSync(STATUS_FILE)) {
        fs.unlinkSync(STATUS_FILE);
      }
    } catch (e) {}
  }
}

module.exports = { StatusReporter, HEARTBEAT_INTERVAL, MAX_MESSAGES };
