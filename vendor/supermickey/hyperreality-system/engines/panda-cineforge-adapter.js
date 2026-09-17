// engines/panda-cineforge-adapter.js
// PandaCineForge 适配器 — SuperMickey v2.1.0
// 负责 Node.js 主链路与 Python 引擎服务的通信

'use strict';

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

// ============================================================
// 配置与常量
// ============================================================

const DEFAULT_CONFIG = {
  enabled: false,           // 【严格默认关闭】必须显式启用
  mode: 'http',             // 'http' | 'process'（未来扩展）
  endpoint: 'http://127.0.0.1:8765',
  timeout: 5000,            // 5 秒超时降级
  retryAttempts: 1,         // 失败重试次数
  retryDelay: 500,          // 重试间隔（毫秒）
  autoStart: false,         // 是否自动启动 Python 服务
  skillDir: path.join(__dirname, '..', 'skills', 'panda-cineforge'),
  port: 8765,
};

// ============================================================
// 工具函数
// ============================================================

function log(level, message, meta = {}) {
  const prefix = `[PandaAdapter][${level.toUpperCase()}]`;
  if (level === 'error') {
    console.error(prefix, message, meta);
  } else {
    console.log(prefix, message, meta);
  }
}

/**
 * 发送 HTTP POST 请求
 * @param {string} url - 请求 URL
 * @param {object} data - 请求体
 * @param {number} timeout - 超时毫秒
 * @returns {Promise<object>}
 */
function httpPost(url, data, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const postData = JSON.stringify(data);
    
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || 80,
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
      timeout,
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve(json);
        } catch (e) {
          reject(new Error(`Invalid JSON response: ${body.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.write(postData);
    req.end();
  });
}

/**
 * 发送 HTTP GET 请求
 * @param {string} url - 请求 URL
 * @param {number} timeout - 超时毫秒
 * @returns {Promise<object>}
 */
function httpGet(url, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    
    const req = http.get(
      {
        hostname: parsed.hostname,
        port: parsed.port || 80,
        path: parsed.pathname,
        timeout,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error(`Invalid JSON response: ${body.slice(0, 200)}`));
          }
        });
      }
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

// ============================================================
// PandaCineForgeAdapter 类
// ============================================================

class PandaCineForgeAdapter {
  /**
   * @param {object} options - 配置选项
   * @param {boolean} options.enabled - 是否启用（严格默认 false）
   * @param {string} options.mode - 通信模式
   * @param {string} options.endpoint - 服务地址
   * @param {number} options.timeout - 请求超时（毫秒）
   * @param {boolean} options.autoStart - 是否自动启动 Python 服务
   * @param {string} options.skillDir - 技能目录路径
   * @param {number} options.port - 服务端口
   */
  constructor(options = {}) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...options,
    };
    
    this.enabled = this.config.enabled === true;
    this.available = false;      // 运行时可用状态
    this.serverProcess = null;   // Python 服务进程引用
    this.lastError = null;       // 上次错误
    this.stats = {
      recalls: 0,
      failures: 0,
      timeouts: 0,
    };

    if (this.enabled) {
      log('info', 'PandaCineForgeAdapter 已启用');
      // 延迟初始化：等首次调用时检查/启动服务
    } else {
      log('info', 'PandaCineForgeAdapter 已禁用（默认）');
    }
  }

  // ========== 服务生命周期 ==========

  /**
   * 启动 Python 服务（如果配置了 autoStart）
   * @returns {Promise<boolean>}
   */
  async start() {
    if (!this.enabled) {
      log('warn', '适配器已禁用，跳过启动');
      return false;
    }

    if (this.available) {
      return true;
    }

    // 先检查服务是否已运行
    try {
      const health = await this.health();
      if (health.status === 'ok' || health.status === 'degraded') {
        this.available = true;
        log('info', 'Python 服务已运行', { skills: health.skill_count });
        return true;
      }
    } catch (e) {
      log('info', 'Python 服务未运行，尝试启动...');
    }

    // 如果配置了 autoStart，尝试启动
    if (this.config.autoStart) {
      try {
        await this._spawnServer();
        // 等待服务就绪
        let attempts = 0;
        while (attempts < 10) {
          await new Promise(r => setTimeout(r, 500));
          try {
            const health = await this.health();
            if (health.status === 'ok' || health.status === 'degraded') {
              this.available = true;
              log('info', 'Python 服务启动成功');
              return true;
            }
          } catch (e) {
            attempts++;
          }
        }
        log('error', 'Python 服务启动超时');
        return false;
      } catch (e) {
        log('error', '启动 Python 服务失败', { error: e.message });
        return false;
      }
    }

    return false;
  }

  /**
   * 停止 Python 服务（如果由本实例启动）
   */
  stop() {
    if (this.serverProcess) {
      this.serverProcess.kill('SIGTERM');
      this.serverProcess = null;
      this.available = false;
      log('info', 'Python 服务已停止');
    }
  }

  /**
   * 内部：启动 Python 服务进程
   */
  _spawnServer() {
    return new Promise((resolve, reject) => {
      const serverPath = path.join(this.config.skillDir, 'server.py');
      const env = {
        ...process.env,
        PCF_PORT: String(this.config.port),
      };

      const proc = spawn('python3', [serverPath], {
        cwd: this.config.skillDir,
        env,
        detached: false,
      });

      proc.stdout.on('data', (data) => {
        log('info', `[Python] ${data.toString().trim()}`);
      });

      proc.stderr.on('data', (data) => {
        log('warn', `[Python] ${data.toString().trim()}`);
      });

      proc.on('error', (err) => {
        log('error', 'Python 进程错误', { error: err.message });
        reject(err);
      });

      proc.on('exit', (code) => {
        if (code !== 0 && code !== null) {
          log('error', `Python 进程退出，码: ${code}`);
        }
        this.serverProcess = null;
        this.available = false;
      });

      this.serverProcess = proc;
      // 给进程一点时间启动
      setTimeout(resolve, 1000);
    });
  }

  // ========== 核心 API ==========

  /**
   * 召回技能（热运行主入口）
   * @param {object} request - 召回请求
   * @param {string} request.call_id - 调用 ID
   * @param {string} request.caller_agent - 调用方 Agent
   * @param {object} request.route_fields - 结构化路由字段
   * @param {object} request.context - 上下文
   * @param {string} request.query_text - 查询文本
   * @param {string} request.recall_mode - 'fast' | 'full'
   * @param {number} request.topk - 返回数量
   * @returns {Promise<object>} 召回结果
   */
  async recall(request) {
    if (!this.enabled) {
      return { status: 'skipped', reason: 'adapter_disabled' };
    }

    if (!this.available) {
      const started = await this.start();
      if (!started) {
        this.stats.failures++;
        return { status: 'degraded', reason: 'service_unavailable' };
      }
    }

    const url = `${this.config.endpoint}/recall`;
    
    try {
      const result = await this._postWithRetry(url, request);
      this.stats.recalls++;
      return result;
    } catch (e) {
      this.stats.failures++;
      if (e.message.includes('timeout')) {
        this.stats.timeouts++;
      }
      this.lastError = e.message;
      log('error', '召回失败', { error: e.message, request: request.query_text });
      return { status: 'degraded', reason: 'recall_failed', error: e.message };
    }
  }

  /**
   * 冷启动：批量预置技能
   * @param {object} options
   * @param {array} options.matrix - 自定义矩阵（可选）
   * @param {boolean} options.enable_innovation - 是否启用组合创新
   * @returns {Promise<object>}
   */
  async coldStart(options = {}) {
    if (!this.enabled) {
      return { status: 'skipped', reason: 'adapter_disabled' };
    }

    if (!this.available) {
      const started = await this.start();
      if (!started) {
        return { status: 'error', reason: 'service_unavailable' };
      }
    }

    const url = `${this.config.endpoint}/cold_start`;
    
    try {
      return await this._postWithRetry(url, options);
    } catch (e) {
      log('error', '冷启动失败', { error: e.message });
      return { status: 'error', reason: 'cold_start_failed', error: e.message };
    }
  }

  /**
   * 反馈回传：驱动技能飞轮
   * @param {string} skillId - 技能 ID
   * @param {string} executionOutcome - 'success' | 'partial' | 'failed'
   * @param {number} qualityScore - 质量评分 0-100
   * @param {array} failureReasons - 失败原因（可选）
   * @param {array} userCorrections - 用户修正（可选）
   * @returns {Promise<object>}
   */
  async reportFeedback(skillId, executionOutcome, qualityScore, failureReasons, userCorrections) {
    if (!this.enabled) {
      return { status: 'skipped', reason: 'adapter_disabled' };
    }

    if (!this.available) {
      return { status: 'degraded', reason: 'service_unavailable' };
    }

    const url = `${this.config.endpoint}/feedback`;
    const payload = {
      skill_id: skillId,
      execution_outcome: executionOutcome,
      quality_score: qualityScore,
      failure_reasons: failureReasons,
      user_corrections: userCorrections,
    };

    try {
      return await this._postWithRetry(url, payload);
    } catch (e) {
      log('error', '反馈回传失败', { error: e.message, skillId });
      return { status: 'degraded', reason: 'feedback_failed', error: e.message };
    }
  }

  /**
   * 健康检查
   * @returns {Promise<object>}
   */
  async health() {
    try {
      const url = `${this.config.endpoint}/health`;
      return await httpGet(url, 2000);
    } catch (e) {
      return { status: 'unavailable', error: e.message };
    }
  }

  // ========== 内部工具 ==========

  /**
   * 带重试的 POST 请求
   */
  async _postWithRetry(url, data) {
    let lastError;
    for (let i = 0; i <= this.config.retryAttempts; i++) {
      try {
        return await httpPost(url, data, this.config.timeout);
      } catch (e) {
        lastError = e;
        if (i < this.config.retryAttempts) {
          await new Promise(r => setTimeout(r, this.config.retryDelay));
        }
      }
    }
    throw lastError;
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      ...this.stats,
      enabled: this.enabled,
      available: this.available,
      lastError: this.lastError,
    };
  }

  /**
   * 重置统计
   */
  resetStats() {
    this.stats = { recalls: 0, failures: 0, timeouts: 0 };
    this.lastError = null;
  }
}

// ============================================================
// 模块导出
// ============================================================

module.exports = {
  PandaCineForgeAdapter,
  DEFAULT_CONFIG,
};
