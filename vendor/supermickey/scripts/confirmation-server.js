/**
 * confirmation-server.js - 确认服务 API（加固版 v2.1.13-fix）
 *
 * 安全策略：
 * 1. 只监听 127.0.0.1，逐请求校验回环来源
 * 2. 校验 X-Confirm-Token 头（timing-safe 比较）
 * 3. 每次请求（含被拒绝）追加写入 audit.log
 * 4. 确认文件补齐 type 字段
 * 5. type 参数白名单校验
 * 6. 【v2.1.12】确认文件写入 run_id（绑定当前运行），原子写防半成品读取
 *
 * 【v2.1.13-fix 服务器实例漂移修复】
 * 7. 密钥/token 热加载：每次签名前检查 .env 是否变更（mtime 触发重读），
 * 轮换密钥后无需重启服务器即可跟上——杜绝"旧实例持旧密钥静默服务"
 * 8. GET /health：返回版本号、PID、启动时间、密钥指纹（sha256 前 12 位，不可逆推），
 * 供 ensure-confirmation-server.js 做版本/密钥一致性握手
 * 9. PID 文件 + 端口占用友好报错：便于检测与清理旧实例
 *
 * 用法（HTTP POST，仅限本机）：
 * curl -X POST http://127.0.0.1:9876 \
 * -H "Content-Type: application/json" \
 * -H "X-Confirm-Token: <HUMAN_CONFIRMATION_TOKEN>" \
 * -d '{"type":"creative-theme","action":"approve","reason":"确认"}'
 * 健康检查：
 * curl http://127.0.0.1:9876/health
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const runCoordinator = require('./run-coordinator');

const SERVER_VERSION = 'v2.1.13-fix';
const SERVER_STARTED_AT = new Date().toISOString();

const ENV_PATH = path.join(__dirname, '..', '.env');
const PORT = process.env.CONFIRMATION_SERVER_PORT || 9876;
const AUDIT_LOG = path.join(__dirname, '..', 'hyperreality-system', 'output', 'confirmations', 'audit.log');
const SERVER_PID_PATH = path.join(__dirname, '..', 'hyperreality-system', 'output', 'confirmations', '.confirmation-server.pid');

// type 白名单：小写字母/数字开头，可含连字符，1-64 字符
const TYPE_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

// 请求体大小上限（64KB，确认请求正常只有几百字节）
const MAX_BODY_BYTES = 64 * 1024;

// ─────────────────────────────────────────────────────────────────────────────
// 密钥/token 加载与热更新
// 【v2.1.13】启动加载一次；此后每次签名前检查 .env mtime，变更即热更新。
// 解决事故：旧服务器实例内存持有旧密钥，轮换密钥后新主流程验签必失败、流程空转。
// ─────────────────────────────────────────────────────────────────────────────

let HUMAN_SECRET = null;
let HUMAN_TOKEN = null;
let _envMtimeMs = 0;

function loadEnvSecrets(force = false) {
 try {
 const stat = fs.statSync(ENV_PATH);
 if (!force && stat.mtimeMs === _envMtimeMs) return; // .env 未变，直接用内存值
 _envMtimeMs = stat.mtimeMs;
 const envContent = fs.readFileSync(ENV_PATH, 'utf8');

 const secretMatch = envContent.match(/HUMAN_CONFIRMATION_SECRET=(.+)/);
 const newSecret = secretMatch ? secretMatch[1].trim() : null;
 const tokenMatch = envContent.match(/HUMAN_CONFIRMATION_TOKEN=(.+)/);
 const newToken = tokenMatch ? tokenMatch[1].trim() : null;

 // 环境变量优先（与 v2.1.12 行为一致）；.env 仅在该变量未设置时兜底
 const effSecret = process.env.HUMAN_CONFIRMATION_SECRET || newSecret;
 const effToken = process.env.HUMAN_CONFIRMATION_TOKEN || newToken;

 if (effSecret !== HUMAN_SECRET) {
 const oldFp = HUMAN_SECRET ? secretFingerprint(HUMAN_SECRET) : 'null';
 HUMAN_SECRET = effSecret;
 console.log(`[ConfirmationServer] 密钥已${oldFp === 'null' ? '加载' : '热更新'}: ${oldFp} → ${secretFingerprint(HUMAN_SECRET)}`);
 }
 if (effToken !== HUMAN_TOKEN) {
 HUMAN_TOKEN = effToken;
 console.log('[ConfirmationServer] Token 已加载/热更新');
 }
 } catch (e) {
 // .env 不存在或读取失败：保留内存中的现有值
 HUMAN_SECRET = HUMAN_SECRET || process.env.HUMAN_CONFIRMATION_SECRET || null;
 HUMAN_TOKEN = HUMAN_TOKEN || process.env.HUMAN_CONFIRMATION_TOKEN || null;
 }
}

/**
 * 密钥指纹：sha256 前 12 位。用于版本/一致性握手，不可逆推原密钥。
 */
function secretFingerprint(secret) {
 if (!secret) return 'none';
 return crypto.createHash('sha256').update(String(secret)).digest('hex').slice(0, 12);
}

// 启动时首次加载
loadEnvSecrets(true);

if (!HUMAN_SECRET) {
 console.warn('⚠️ [ConfirmationServer] HUMAN_CONFIRMATION_SECRET 未配置（.env 缺失或无该字段）');
 console.warn(' 确认请求将返回 500；配置后无需重启，下次请求自动热加载');
}

// ─────────────────────────────────────────────────────────────────────────────
// 基础工具
// ─────────────────────────────────────────────────────────────────────────────

// timing-safe token 比较
function verifyToken(tokenHeader, expected) {
 if (!tokenHeader || !expected) return false;
 const a = Buffer.from(tokenHeader, 'utf8');
 const b = Buffer.from(expected, 'utf8');
 if (a.length !== b.length) return false;
 try {
 return crypto.timingSafeEqual(a, b);
 } catch {
 return false;
 }
}

function logAudit(clientIp, result, type, action, reason, filePath) {
 const dir = path.dirname(AUDIT_LOG);
 if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
 const entry = [
 new Date().toISOString(),
 clientIp,
 result,
 String(type || ''),
 String(action || ''),
 String(reason || ''),
 filePath || 'N/A'
 ].join(' | ') + '\n';
 fs.appendFileSync(AUDIT_LOG, entry, 'utf8');
}

function generateConfirmation(type, approved, reason) {
 // 【v2.1.13】每次签名前热检查 .env 变更（密钥轮换后无需重启本服务）
 loadEnvSecrets();

 if (!HUMAN_SECRET) {
 throw new Error('HUMAN_CONFIRMATION_SECRET 未配置');
 }
 const timestamp = Date.now();
 const nonce = crypto.randomBytes(16).toString('hex');
 const payload = `${type}:${timestamp}:${nonce}`;
 const signature = crypto.createHmac('sha256', HUMAN_SECRET).update(payload).digest('hex');

 // 【v2.1.12】绑定当前运行（无活动运行时 run_id 为 null，等待方按时间戳规则兜底）
 const currentRun = runCoordinator.getCurrentRun();

 const confirmData = {
 type,
 approved,
 timestamp,
 nonce,
 signature,
 reason: reason || '',
 confirmed_at: new Date().toISOString(),
 run_id: currentRun && currentRun.status === 'running' ? currentRun.run_id : null,
 key_fingerprint: secretFingerprint(HUMAN_SECRET) // 【v2.1.13】留痕：便于事后审计"当时用的是哪把钥匙"
 };

 const confirmPath = path.join(__dirname, '..', 'hyperreality-system', 'output', 'confirmations', `confirmation-${type}.json`);
 // 【v2.1.12】原子写（临时文件 + rename），轮询方不会读到写了一半的文件
 runCoordinator.atomicWriteSync(confirmPath, JSON.stringify(confirmData, null, 2));

 // 【v2.1.20-fix 确认后仍推送】与 human-confirm.js 一致的源侧 PENDING 清理
 try {
 const pendingPath = path.join(__dirname, '..', 'hyperreality-system', 'output', 'confirmations', 'PENDING.json');
 const pend = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
 if (pend && pend.pending === true && pend.type === type) {
 runCoordinator.atomicWriteSync(pendingPath, JSON.stringify({
 pending: false,
 type,
 run_id: pend.run_id || confirmData.run_id,
 cleared_at: new Date().toISOString(),
 cleared_by: 'confirmation-server'
 }, null, 2));
 }
 } catch (_) { /* 非关键路径 */ }

 return { file: confirmPath, timestamp, signature };
}

// ── 回环来源校验 ───────────────────────────────────────────────────────
function isLoopback(ip) {
 return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

// ─────────────────────────────────────────────────────────────────────────────
// PID 文件（供 ensure-confirmation-server.js 检测/清理旧实例）
// ─────────────────────────────────────────────────────────────────────────────

function writePidFile() {
 try {
 runCoordinator.atomicWriteSync(SERVER_PID_PATH, JSON.stringify({
 pid: process.pid,
 version: SERVER_VERSION,
 started_at: SERVER_STARTED_AT,
 port: PORT
 }, null, 2));
 } catch (_) { /* 非关键路径 */ }
}

function removePidFile() {
 try {
 const data = JSON.parse(fs.readFileSync(SERVER_PID_PATH, 'utf8'));
 if (data.pid === process.pid) fs.unlinkSync(SERVER_PID_PATH);
 } catch (_) { /* 已不存在 */ }
}

const server = http.createServer(async (req, res) => {
 const clientIp = req.socket.remoteAddress || 'unknown';

 // CORS 头保持原有（仅本地回环，无实际暴露风险）
 res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1');
 res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
 res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Confirm-Token');

 if (req.method === 'OPTIONS') {
 res.writeHead(200);
 res.end();
 return;
 }

 // 【v2.1.13】健康检查端点：版本/密钥指纹握手（无需 token，信息均不可利用）
 if (req.method === 'GET' && req.url === '/health') {
 loadEnvSecrets(); // 健康检查也触发热加载，确保指纹是最新的
 res.writeHead(200, { 'Content-Type': 'application/json' });
 res.end(JSON.stringify({
 ok: true,
 version: SERVER_VERSION,
 pid: process.pid,
 started_at: SERVER_STARTED_AT,
 port: PORT,
 secret_configured: !!HUMAN_SECRET,
 secret_fingerprint: secretFingerprint(HUMAN_SECRET)
 }));
 return;
 }

 if (req.method !== 'POST') {
 logAudit(clientIp, 'rejected-method', null, null, null, null);
 res.writeHead(405, { 'Content-Type': 'application/json' });
 res.end(JSON.stringify({ error: 'Method not allowed' }));
 return;
 }

 // 1. 回环来源校验
 if (!isLoopback(clientIp)) {
 logAudit(clientIp, 'rejected-origin', null, null, null, null);
 res.writeHead(403, { 'Content-Type': 'application/json' });
 res.end(JSON.stringify({ error: 'Forbidden: only loopback allowed' }));
 return;
 }

 // 2. X-Confirm-Token 校验
 const token = req.headers['x-confirm-token'];
 if (!verifyToken(token, HUMAN_TOKEN)) {
 logAudit(clientIp, 'rejected-token', null, null, null, null);
 res.writeHead(403, { 'Content-Type': 'application/json' });
 res.end(JSON.stringify({ error: 'Forbidden: invalid token' }));
 return;
 }

 let body = '';
 let bodyBytes = 0;
 let aborted = false;
 req.on('data', chunk => {
 bodyBytes += chunk.length;
 if (bodyBytes > MAX_BODY_BYTES) {
 // 【v2.1.12】请求体超限，直接断开
 aborted = true;
 logAudit(clientIp, 'rejected-oversize', null, null, `body>${MAX_BODY_BYTES}`, null);
 res.writeHead(413, { 'Content-Type': 'application/json' });
 res.end(JSON.stringify({ error: 'Payload too large' }));
 req.destroy();
 return;
 }
 body += chunk;
 });
 req.on('end', async () => {
 if (aborted) return;
 try {
 const data = JSON.parse(body);
 const { type, action, reason } = data;

 if (!type || !action) {
 logAudit(clientIp, 'rejected-params', type || null, action || null, reason || null, null);
 res.writeHead(400, { 'Content-Type': 'application/json' });
 res.end(JSON.stringify({ error: 'Missing type or action' }));
 return;
 }

 // 5. type 白名单校验
 if (!TYPE_RE.test(type)) {
 logAudit(clientIp, 'rejected-type', type, action, reason, null);
 res.writeHead(400, { 'Content-Type': 'application/json' });
 res.end(JSON.stringify({ error: 'Invalid type format' }));
 return;
 }

 const approved = action !== 'reject';
 const result = generateConfirmation(type, approved, reason || '');
 logAudit(clientIp, approved ? 'approved' : 'rejected', type, action, reason || '', result.file);

 res.writeHead(200, { 'Content-Type': 'application/json' });
 res.end(JSON.stringify({
 success: true,
 type,
 action,
 approved,
 file: result.file,
 timestamp: result.timestamp,
 server_version: SERVER_VERSION,
 key_fingerprint: secretFingerprint(HUMAN_SECRET)
 }));
 } catch (e) {
 logAudit(clientIp, 'rejected-error', null, null, e.message, null);
 res.writeHead(500, { 'Content-Type': 'application/json' });
 res.end(JSON.stringify({ error: e.message }));
 }
 });
});

module.exports = { server, generateConfirmation, SERVER_VERSION, secretFingerprint };

if (require.main === module) {
 server.on('error', (e) => {
 if (e.code === 'EADDRINUSE') {
 // 【v2.1.13】端口被占 = 极可能有旧实例在跑，给出明确处置指引（原来是 unhandled 崩溃）
 console.error('');
 console.error('⛔ '.repeat(15));
 console.error(`[ConfirmationServer] 端口 ${PORT} 已被占用——极可能有一个旧实例仍在运行！`);
 console.error('旧实例持有的可能是过期的密钥/代码，会导致主流程验签失败、流程空转。');
 console.error('处置（二选一）:');
 console.error(' 1. 自动检测并重启: node scripts/ensure-confirmation-server.js');
 console.error(' 2. 手动: curl -s http://127.0.0.1:' + PORT + '/health 查看现有实例版本，确认后 kill 其 PID');
 console.error('⛔ '.repeat(15));
 process.exit(1);
 }
 throw e;
 });

 server.listen(PORT, '127.0.0.1', () => {
 writePidFile();
 console.log(`[ConfirmationServer] ${SERVER_VERSION} 确认服务已启动: http://127.0.0.1:${PORT} (仅回环)`);
 console.log(`[ConfirmationServer] 密钥指纹: ${secretFingerprint(HUMAN_SECRET)} | PID: ${process.pid}`);
 });

 // 退出时清理 PID 文件
 process.on('exit', removePidFile);
 for (const sig of ['SIGTERM', 'SIGINT']) {
 process.on(sig, () => {
 removePidFile();
 process.exit(0);
 });
 }
}
