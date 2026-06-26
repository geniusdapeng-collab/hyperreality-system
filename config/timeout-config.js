/**
 * 超时配置中心
 * 超现实系统私有化版本 v1.0
 * 
 * 统一管理所有超时值，支持环境变量覆盖
 * 消除硬编码，提升可维护性
 */

const DEFAULT_TIMEOUTS = {
  // LLM 调用超时
  LLM_SHORT: 180000,    // 3分钟 - 简单查询
  LLM_MEDIUM: 300000,   // 5分钟 - 标准生成
  LLM_LONG: 600000,     // 10分钟 - 复杂任务
  LLM_AGENT: 300000,    // 5分钟 - Agent单次调用
  LLM_TIMEOUT_PER_SHOT: 180000, // 每镜头LLM生成时间（5分钟预算适配）
  
  // 渲染超时
  RENDER_SHORT: 120000,   // 2分钟 - 快速渲染
  RENDER_MEDIUM: 300000,  // 5分钟 - 标准渲染
  RENDER_LONG: 600000,    // 10分钟 - 高清渲染
  
  // 字段质量检查
  FIELD_CHECKER: 30000,   // 30秒 - 规则检查
  FIELD_CHECKER_LLM: 120000, // 2分钟 - LLM语义检查
  FIELD_REPAIRER: 60000,  // 1分钟 - 修复
  FIELD_REPAIRER_LLM: 180000, // 3分钟 - LLM修复
  
  // 其他
  PARALLEL_BATCH: 300000, // 5分钟 - 并行批处理
  SUBMIT_RENDER: 300000,  // 5分钟 - 渲染提交
  
  // 系统总预算（超现实系统：30分钟 = 1800秒）
  SYSTEM_BUDGET: 1800000, // 30分钟
};

/**
 * 从环境变量读取超时配置
 * 命名规则: HYPERREALITY_TIMEOUT_<NAME>
 * 例如: HYPERREALITY_TIMEOUT_LLM_MEDIUM=300000
 */
function loadTimeouts() {
  const timeouts = { ...DEFAULT_TIMEOUTS };
  
  for (const [key, defaultValue] of Object.entries(DEFAULT_TIMEOUTS)) {
    const envKey = `HYPERREALITY_TIMEOUT_${key}`;
    const envValue = process.env[envKey];
    if (envValue) {
      const parsed = parseInt(envValue, 10);
      if (!isNaN(parsed) && parsed > 0) {
        timeouts[key] = parsed;
      }
    }
  }
  
  return timeouts;
}

/**
 * 获取超时值（毫秒）
 * @param {string} key - 超时键名
 * @param {number} fallback - 回退值（毫秒）
 * @returns {number} 超时值（毫秒）
 */
function getTimeout(key, fallback = 300000) {
  const timeouts = loadTimeouts();
  return timeouts[key] || fallback;
}

module.exports = {
  DEFAULT_TIMEOUTS,
  loadTimeouts,
  getTimeout
};
