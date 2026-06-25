'use strict';

/**
 * 全局错误码统一管理模块
 * 超现实系统适配版 v1.0
 * 
 * 所有 Layer/Engine/Service 统一使用，确保错误语义一致
 */

const ErrorCodes = {
  // 成功
  SUCCESS: 0,

  // 通用错误 (1-9)
  UNKNOWN_ERROR: 1,
  TIMEOUT: 2,
  OOM: 3,
  CONFIG_ERROR: 4,

  // 外部服务错误 (10-19)
  API_ERROR: 10,
  NETWORK_ERROR: 11,
  RATE_LIMIT: 12,
  AUTH_ERROR: 13,

  // 数据错误 (20-29)
  PARSE_ERROR: 20,
  VALIDATION_ERROR: 21,
  DATA_MISSING: 22,
  SCHEMA_MISMATCH: 23,

  // 质量相关错误 (30-39)
  QUALITY_FAIL: 30,
  REJECTED: 31,
  DEGRADED: 32,

  // Layer 执行错误 (40-49)
  LAYER_SKIP: 40,
  LAYER_DEGRADED: 41,
  LAYER_FATAL: 42,

  // 渲染相关错误 (50-59)
  RENDER_ERROR: 50,
  RENDER_TIMEOUT: 51,
  RENDER_REJECTED: 52,

  // 资源错误 (60-69)
  RESOURCE_NOT_FOUND: 60,
  RESOURCE_EXPIRED: 61,
  PORTRAIT_MISSING: 62,

  // 字段相关 (70-79)
  FIELD_MISSING: 70,
  FIELD_UNAUTHORIZED: 71,
  FIELD_DEGRADED: 72,
};

const ERROR_DESCRIPTIONS = {
  [ErrorCodes.SUCCESS]: '执行成功',
  [ErrorCodes.UNKNOWN_ERROR]: '未知错误',
  [ErrorCodes.TIMEOUT]: '执行超时',
  [ErrorCodes.OOM]: '内存不足',
  [ErrorCodes.CONFIG_ERROR]: '配置错误',
  [ErrorCodes.API_ERROR]: '外部API调用失败',
  [ErrorCodes.NETWORK_ERROR]: '网络错误',
  [ErrorCodes.RATE_LIMIT]: '请求频率限制',
  [ErrorCodes.AUTH_ERROR]: '认证失败',
  [ErrorCodes.PARSE_ERROR]: '数据解析失败',
  [ErrorCodes.VALIDATION_ERROR]: '数据校验失败',
  [ErrorCodes.DATA_MISSING]: '必要数据缺失',
  [ErrorCodes.SCHEMA_MISMATCH]: '数据结构不匹配',
  [ErrorCodes.QUALITY_FAIL]: '质量检查未通过',
  [ErrorCodes.REJECTED]: '内容被驳回',
  [ErrorCodes.DEGRADED]: '已降级执行',
  [ErrorCodes.LAYER_SKIP]: 'Layer被跳过',
  [ErrorCodes.LAYER_DEGRADED]: 'Layer已降级执行',
  [ErrorCodes.LAYER_FATAL]: 'Layer致命错误',
  [ErrorCodes.RENDER_ERROR]: '渲染失败',
  [ErrorCodes.RENDER_TIMEOUT]: '渲染超时',
  [ErrorCodes.RENDER_REJECTED]: '渲染被拒绝',
  [ErrorCodes.RESOURCE_NOT_FOUND]: '资源未找到',
  [ErrorCodes.RESOURCE_EXPIRED]: '资源已过期',
  [ErrorCodes.PORTRAIT_MISSING]: '角色定妆照缺失',
  [ErrorCodes.FIELD_MISSING]: '关键字段缺失',
  [ErrorCodes.FIELD_UNAUTHORIZED]: '字段越权修改',
  [ErrorCodes.FIELD_DEGRADED]: '字段降级标记',
};

function getDescription(code) {
  if (code === null || code === undefined || typeof code !== 'number') {
    return `未定义错误码(${code})`;
  }
  return ERROR_DESCRIPTIONS[code] || `未定义错误码(${code})`;
}

function isSuccess(code) {
  return code === ErrorCodes.SUCCESS;
}

function isFatal(code) {
  const fatalCodes = [ErrorCodes.UNKNOWN_ERROR, ErrorCodes.OOM, ErrorCodes.LAYER_FATAL];
  return fatalCodes.includes(code);
}

function isDegradable(code) {
  const degradableCodes = [
    ErrorCodes.TIMEOUT, ErrorCodes.API_ERROR, ErrorCodes.NETWORK_ERROR,
    ErrorCodes.RATE_LIMIT, ErrorCodes.QUALITY_FAIL, ErrorCodes.RENDER_ERROR,
    ErrorCodes.RENDER_TIMEOUT, ErrorCodes.DEGRADED
  ];
  return degradableCodes.includes(code);
}

function isFieldError(code) {
  return code >= 70 && code <= 79;
}

const ErrorCodeManager = {
  ...ErrorCodes,
  _descriptions: { ...ERROR_DESCRIPTIONS },
  _totalCodes: Object.keys(ErrorCodes).length,
  getDescription,
  isSuccess,
  isFatal,
  isDegradable,
  isFieldError,
  getInfo(code) {
    const keys = Object.keys(ErrorCodes);
    const name = keys.find((k) => ErrorCodes[k] === code) || 'UNKNOWN';
    return { code, name, description: getDescription(code) };
  },
  listAll() {
    return Object.keys(ErrorCodes).map((name) => ({
      code: ErrorCodes[name],
      name,
      description: ERROR_DESCRIPTIONS[ErrorCodes[name]] || '未定义描述',
    }));
  },
  printCheatsheet() {
    console.log('\n╔════════════════════════════════════════════════════════╗');
    console.log('║ 超现实系统错误码速查表 ║');
    console.log('╠════════════════════════════════════════════════════════╣');
    this.listAll().forEach(({ code, name, description }) => {
      console.log(`║ [${String(code).padStart(2, '0')}] ${name.padEnd(20)} ${description.padEnd(20)} ║`);
    });
    console.log('╚════════════════════════════════════════════════════════╝\n');
  },
};

module.exports = ErrorCodeManager;

// 自测试
if (require.main === module) {
  const assert = require('assert');
  console.log('\n[self-test] config/error-codes.js');
  let passed = 0, failed = 0;
  function test(name, fn) {
    try { fn(); console.log(` ✅ ${name}`); passed++; }
    catch (err) { console.error(` ❌ ${name} - ${err.message}`); failed++; }
  }
  test('SUCCESS = 0', () => assert.strictEqual(ErrorCodeManager.SUCCESS, 0));
  test('getDescription(2) = 执行超时', () => assert.strictEqual(ErrorCodeManager.getDescription(2), '执行超时'));
  test('isFatal(1) = true', () => assert.strictEqual(ErrorCodeManager.isFatal(1), true));
  test('isDegradable(2) = true', () => assert.strictEqual(ErrorCodeManager.isDegradable(2), true));
  test('isFieldError(70) = true', () => assert.strictEqual(ErrorCodeManager.isFieldError(70), true));
  test('isFieldError(10) = false', () => assert.strictEqual(ErrorCodeManager.isFieldError(10), false));
  console.log(`\n 结果: ${passed} 通过, ${failed} 失败\n`);
  process.exit(failed > 0 ? 1 : 0);
}
