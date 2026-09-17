/**
 * 操作审计日志系统 — Operation Audit Logger v1.0 (P1)
 * 
 * 持久化所有系统操作到 audit-logs/YYYY-MM-DD.jsonl
 * 
 * 记录字段：
 *   - timestamp: ISO 8601
 *   - operation: 操作类型（render/submit/validate/generate等）
 *   - module: 模块名（seedance-render-engine/production-engine等）
 *   - actor: 执行者（system/user/scheduled）
 *   - input: 输入摘要（对象，敏感信息脱敏）
 *   - output: 输出摘要（对象）
 *   - result: 结果状态（success/failure/pending）
 *   - duration: 耗时(ms)
 *   - error: 错误信息（失败时）
 *   - metadata: 扩展元数据
 * 
 * 用法：
 *   const audit = require('./audit-logger');
 *   await audit.log('render', 'seedance-render-engine', { shotId: 'S01' });
 */

const fss = require('fs');
const path = require('path');
const os = require('os');

const AUDIT_DIR = path.join(os.homedir(), '.openclaw', 'workspace', 'audit-logs');

// 确保目录存在
function ensureDir() {
  if (!fss.existsSync(AUDIT_DIR)) {
    fss.mkdirSync(AUDIT_DIR, { recursive: true });
  }
}

// 获取今天的日志文件路径
function getLogFile() {
  const today = new Date().toISOString().split('T')[0];
  return path.join(AUDIT_DIR, `${today}.jsonl`);
}

// 敏感信息脱敏
function sanitize(data) {
  if (!data || typeof data !== 'object') return data;
  
  const sensitive = ['apiKey', 'token', 'password', 'secret', 'key', 'auth'];
  const sanitized = {};
  
  for (const [k, v] of Object.entries(data)) {
    const lowerK = k.toLowerCase();
    if (sensitive.some(s => lowerK.includes(s))) {
      sanitized[k] = '[REDACTED]';
    } else if (typeof v === 'object' && v !== null) {
      sanitized[k] = sanitize(v);
    } else {
      sanitized[k] = v;
    }
  }
  
  return sanitized;
}

// 截断超长字符串
function truncate(str, maxLen = 500) {
  if (!str || typeof str !== 'string') return str;
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen) + '...[截断]';
}

/**
 * 记录审计日志
 * @param {string} operation - 操作类型
 * @param {string} module - 模块名
 * @param {object} options - 选项
 *   @param {string} options.actor - 执行者 (default: 'system')
 *   @param {object} options.input - 输入数据
 *   @param {object} options.output - 输出数据
 *   @param {string} options.result - 结果状态 (success/failure/pending)
 *   @param {number} options.duration - 耗时(ms)
 *   @param {string} options.error - 错误信息
 *   @param {object} options.metadata - 扩展元数据
 */
async function log(operation, module, options = {}) {
  ensureDir();
  
  const record = {
    timestamp: new Date().toISOString(),
    operation,
    module,
    actor: options.actor || 'system',
    input: sanitize(options.input) || {},
    output: sanitize(options.output) || {},
    result: options.result || 'success',
    duration: options.duration || 0,
  };
  
  if (options.error) {
    record.error = truncate(options.error, 1000);
  }
  
  if (options.metadata) {
    record.metadata = sanitize(options.metadata);
  }
  
  // 写入JSONL（追加模式）
  const line = JSON.stringify(record) + '\n';
  const logFile = getLogFile();
  
  try {
    fss.appendFileSync(logFile, line);
  } catch (e) {
    console.error(`[AuditLogger] 写入失败: ${e.message}`);
  }
}

/**
 * 批量记录审计日志
 */
async function logBatch(records) {
  for (const record of records) {
    await log(record.operation, record.module, record.options);
  }
}

/**
 * 获取今天的审计日志
 */
function getTodayLogs() {
  const logFile = getLogFile();
  if (!fss.existsSync(logFile)) return [];
  
  const content = fss.readFileSync(logFile, 'utf8').trim();
  if (!content) return [];
  
  return content.split('\n').map(line => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

/**
 * 按模块过滤日志
 */
function getLogsByModule(module, date = new Date().toISOString().split('T')[0]) {
  const logFile = path.join(AUDIT_DIR, `${date}.jsonl`);
  if (!fss.existsSync(logFile)) return [];
  
  const content = fss.readFileSync(logFile, 'utf8').trim();
  if (!content) return [];
  
  return content.split('\n').map(line => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(r => r && r.module === module);
}

/**
 * 获取审计统计
 */
function getStats(date) {
  if (date) {
    const logs = getLogsByModule('*', date);
    return calcStats(logs);
  }
  
  // 查询所有日期
  if (!fss.existsSync(AUDIT_DIR)) return { total: 0, byModule: {}, byResult: { success: 0, failure: 0, pending: 0 } };
  
  const files = fss.readdirSync(AUDIT_DIR).filter(f => f.endsWith('.jsonl'));
  let allLogs = [];
  
  for (const file of files) {
    const content = fss.readFileSync(path.join(AUDIT_DIR, file), 'utf8').trim();
    if (!content) continue;
    const logs = content.split('\n').map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
    allLogs.push(...logs);
  }
  
  return calcStats(allLogs);
}

function calcStats(logs) {
  const stats = {
    total: logs.length,
    byModule: {},
    byResult: { success: 0, failure: 0, pending: 0 },
  };
  
  for (const log of logs) {
    stats.byModule[log.module] = (stats.byModule[log.module] || 0) + 1;
    stats.byResult[log.result] = (stats.byResult[log.result] || 0) + 1;
  }
  
  return stats;
}

module.exports = {
  log,
  logBatch,
  getTodayLogs,
  getLogsByModule,
  getStats,
};
