'use strict';

/**
 * MessageEnvelope — Agent 间数据管道信封
 * ------------------------------------------------------------
 * 珍妮纺织机流水线中，Agent 之间传递的不是裸数据，而是带完整
 * 追踪信息的信封。信封解决四个问题：
 *   1. 可追溯：trace_id 贯穿全程，任何一条情报能倒查到哪个
 *      Agent 在哪个阶段、基于哪些证据产出
 *   2. 可校验：每个信封进出都要过 HandoffValidator 闸机
 *   3. 可审计：payload 带 sha256 校验和，防篡改、防串包
 *   4. 可回放：created_at + stage 序列支持流水线回放诊断
 */

const crypto = require('crypto');

let _seq = 0;

function _checksum(payload) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(payload == null ? null : payload))
    .digest('hex')
    .slice(0, 16);
}

/**
 * 创建一个信封
 * @param {object} opts
 * @param {string} opts.traceId   流水线追踪编号（同一次挖掘任务全程一致）
 * @param {string} opts.stage     阶段编号：A1_COLLECT / A2_MINE / A3_SCOUT / A4_VERIFY / A5_BIND
 * @param {string} opts.agent     产出 Agent 名
 * @param {string} opts.mode      spec | api
 * @param {object} opts.payload   业务数据本体
 * @param {string[]} [opts.evidenceRefs] 本信封payload引用的证据编号（EvidenceLedger 登记号）
 * @param {string} [opts.prevChecksum] 上游信封校验和（链式锁定，防跳站）
 */
function create(opts = {}) {
  const payload = opts.payload == null ? {} : opts.payload;
  return {
    envelope_id: `ENV-${(++_seq).toString().padStart(5, '0')}`,
    trace_id: opts.traceId || 'TRACE-UNBOUND',
    stage: opts.stage || 'UNKNOWN',
    agent: opts.agent || 'unknown',
    mode: opts.mode || 'spec',
    payload,
    evidence_refs: Array.isArray(opts.evidenceRefs) ? opts.evidenceRefs : [],
    prev_checksum: opts.prevChecksum || null,
    checksum: _checksum(payload),
    created_at: new Date().toISOString()
  };
}

/**
 * 校验信封完整性（结构 + 校验和）
 * @returns {{ok: boolean, issues: string[]}}
 */
function verify(env) {
  const issues = [];
  if (!env || typeof env !== 'object') return { ok: false, issues: ['信封不是对象'] };
  if (!env.envelope_id) issues.push('缺 envelope_id');
  if (!env.trace_id || env.trace_id === 'TRACE-UNBOUND') issues.push('缺有效 trace_id');
  if (!env.stage) issues.push('缺 stage');
  if (!env.agent) issues.push('缺 agent');
  if (!env.checksum) {
    issues.push('缺 checksum');
  } else if (_checksum(env.payload) !== env.checksum) {
    issues.push('checksum 校验失败：payload 与摘要不一致（串包或篡改）');
  }
  return { ok: issues.length === 0, issues };
}

/** 生成流水线追踪编号 */
function newTraceId(productId = '') {
  const stamp = Date.now().toString(36).toUpperCase();
  const rand = crypto.randomBytes(2).toString('hex').toUpperCase();
  const head = String(productId || 'GEN').replace(/[^A-Z0-9]/gi, '').slice(0, 8).toUpperCase() || 'GEN';
  return `LOOM-${head}-${stamp}-${rand}`;
}

module.exports = { create, verify, newTraceId };
