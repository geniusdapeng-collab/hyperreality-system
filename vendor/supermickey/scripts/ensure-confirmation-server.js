#!/usr/bin/env node
/**
 * ensure-confirmation-server.js - 确认服务器健康自检与自愈（v2.1.13-fix 新增）
 *
 * 解决的事故场景（2026-07-19 晨）：
 * 昨天启动的旧确认服务器实例在内存里跑了 16 小时，持有轮换前的旧密钥；
 * agent 代用户调确认服务时，旧实例签出的确认文件被新主流程验签拒绝，
 * 主流程空转直至被后台超时杀死，用户被迫二次确认。
 *
 * 本脚本逻辑：
 * 1. GET /health 探测现有实例
 *    - 无响应 → 无实例（或卡死）→ 清理残留 PID 文件后启动新实例
 *    - 版本过旧 → 旧代码实例 → 杀旧启新
 *    - 密钥指纹不一致 → 密钥已漂移 → 杀旧启新
 *    - 版本+指纹都一致 → 健康 → 直接复用，退出 0
 * 2. 新实例以 detached 方式后台启动，日志写入 confirmation-server.log，
 *    并轮询等待 /health 通过（最多 15 秒）后才返回
 *
 * 用法：
 *   node scripts/ensure-confirmation-server.js        # 自检+自愈
 *   node scripts/ensure-confirmation-server.js --force # 无条件杀掉重启
 *   node scripts/ensure-confirmation-server.js --status # 只查看状态不动作
 *
 * 主流程入口（run-preproduction-iron-pot-star.js）启动时会自动调用本脚本。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = parseInt(process.env.CONFIRMATION_SERVER_PORT || '9876', 10);
const ENV_PATH = path.join(__dirname, '..', '.env');
const CONF_DIR = path.join(__dirname, '..', 'hyperreality-system', 'output', 'confirmations');
const PID_PATH = path.join(CONF_DIR, '.confirmation-server.pid');
const LOG_PATH = path.join(CONF_DIR, 'confirmation-server.log');
const SERVER_SCRIPT = path.join(__dirname, 'confirmation-server.js');
const EXPECTED_VERSION = 'v2.1.13-fix';

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const STATUS_ONLY = args.includes('--status');

function log(...a) { console.log('[ensure-confirm-server]', ...a); }

// ── 读取当前 .env 的密钥指纹（期望指纹）──────────────────────────────────
function expectedFingerprint() {
  try {
    const envContent = fs.readFileSync(ENV_PATH, 'utf8');
    const m = envContent.match(/HUMAN_CONFIRMATION_SECRET=(.+)/);
    const secret = process.env.HUMAN_CONFIRMATION_SECRET || (m && m[1].trim());
    if (!secret) return 'none';
    return crypto.createHash('sha256').update(String(secret)).digest('hex').slice(0, 12);
  } catch (_) {
    return process.env.HUMAN_CONFIRMATION_SECRET
      ? crypto.createHash('sha256').update(process.env.HUMAN_CONFIRMATION_SECRET).digest('hex').slice(0, 12)
      : 'none';
  }
}

// ── GET /health（2 秒超时）──────────────────────────────────────────────
function fetchHealth() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/health', timeout: 2000 }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch (_) { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function isAlive(pid) {
  if (!pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function readPidFile() {
  try { return JSON.parse(fs.readFileSync(PID_PATH, 'utf8')); } catch (_) { return null; }
}

function killPid(pid, why) {
  if (!isAlive(pid)) return false;
  log(`终止旧实例 PID=${pid}（${why}）`);
  try { process.kill(pid, 'SIGTERM'); } catch (_) { /* ignore */ }
  // 最多等 3 秒，没死再 SIGKILL
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    const now = Date.now();
    while (Date.now() - now < 100) { /* busy-wait 100ms */ }
  }
  if (isAlive(pid)) {
    log(`SIGTERM 未生效，升级 SIGKILL PID=${pid}`);
    try { process.kill(pid, 'SIGKILL'); } catch (_) { /* ignore */ }
  }
  return !isAlive(pid);
}

// ── 启动新实例（detached 后台运行，日志落盘）─────────────────────────────
function startServer() {
  if (!fs.existsSync(CONF_DIR)) fs.mkdirSync(CONF_DIR, { recursive: true });
  const out = fs.openSync(LOG_PATH, 'a');
  const err = fs.openSync(LOG_PATH, 'a');
  const child = spawn(process.execPath, [SERVER_SCRIPT], {
    detached: true,
    stdio: ['ignore', out, err],
    env: { ...process.env }
  });
  child.unref();
  log(`已启动新实例 PID=${child.pid}（日志: ${LOG_PATH}）`);
  return child.pid;
}

async function waitHealthy(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const h = await fetchHealth();
    if (h && h.ok) return h;
    await new Promise(r => setTimeout(r, 400));
  }
  return null;
}

(async () => {
  const expected = expectedFingerprint();
  if (expected === 'none') {
    log('⚠️ 警告: .env 中未配置 HUMAN_CONFIRMATION_SECRET，确认服务即使启动也无法签名');
  }

  const health = await fetchHealth();

  if (STATUS_ONLY) {
    if (!health) {
      log(`状态: 端口 ${PORT} 无运行中的实例`);
      const pf = readPidFile();
      if (pf) log(`残留 PID 文件: ${JSON.stringify(pf)}`);
    } else {
      log(`状态: 实例运行中 PID=${health.pid} | 版本=${health.version} | 指纹=${health.secret_fingerprint} | 启动于=${health.started_at}`);
      log(`期望: 版本=${EXPECTED_VERSION} | 指纹=${expected}`);
      log(health.version === EXPECTED_VERSION && health.secret_fingerprint === expected ? '结论: ✅ 一致，无需处理' : '结论: ⚠️ 不一致，建议运行不带 --status 的本脚本自愈');
    }
    process.exit(0);
  }

  // ── 判定现有实例是否可用 ──────────────────────────────────────────────
  let needRestart = FORCE;
  let reason = FORCE ? '--force 指定' : '';

  if (!FORCE) {
    if (!health) {
      needRestart = true;
      reason = '端口无响应（无实例或实例卡死）';
    } else if (health.version !== EXPECTED_VERSION) {
      needRestart = true;
      reason = `版本过旧 (${health.version} → ${EXPECTED_VERSION})`;
    } else if (health.secret_fingerprint !== expected) {
      needRestart = true;
      reason = `密钥指纹漂移 (${health.secret_fingerprint} → ${expected})`;
    }
  }

  if (!needRestart) {
    log(`✅ 现有实例健康: PID=${health.pid} | 版本=${health.version} | 指纹=${health.secret_fingerprint}，直接复用`);
    process.exit(0);
  }

  log(`需要重启确认服务器: ${reason}`);

  // ── 杀旧 ─────────────────────────────────────────────────────────────
  const pidFromHealth = health && health.pid;
  const pidFromFile = (readPidFile() || {}).pid;
  const victim = pidFromHealth || pidFromFile;
  if (victim && isAlive(victim)) {
    killPid(victim, reason);
  } else if (!health) {
    log('无存活实例需要清理');
  }
  try { fs.unlinkSync(PID_PATH); } catch (_) { /* 无残留 */ }

  // ── 启新 ─────────────────────────────────────────────────────────────
  const newPid = startServer();
  const h = await waitHealthy(15000);
  if (!h) {
    console.error(`❌ 新实例 (PID=${newPid}) 15 秒内未通过健康检查，请查看日志: ${LOG_PATH}`);
    process.exit(1);
  }
  if (h.secret_fingerprint !== expected) {
    console.error(`❌ 新实例指纹 (${h.secret_fingerprint}) 与 .env 期望 (${expected}) 仍不一致，请检查 .env 配置`);
    process.exit(1);
  }
  log(`✅ 确认服务器已就绪: PID=${h.pid} | 版本=${h.version} | 指纹=${h.secret_fingerprint}`);
  process.exit(0);
})().catch(e => {
  console.error('[ensure-confirm-server] 执行失败:', e.message);
  process.exit(1);
});
