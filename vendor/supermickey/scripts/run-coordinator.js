/**
 * run-coordinator.js - 预生产运行协调器（单实例锁 + 运行身份 + 确认文件生命周期）
 *
 * 【v2.1.12-fix 多进程竞态修复】新增模块
 *
 * 解决的问题：
 * 1. 多进程重复启动：同一时刻只允许一个预生产流程存活（PID 锁文件 + 存活探测 +
 * stale 锁接管），入口脚本与 HyperrealitySystem.create() 双层防护
 * 2. 确认文件竞态消费：确认文件验证通过后改为"归档"（rename 到 archive/consumed/），
 * 不再 unlinkSync 删除；配合 run_id 绑定，杜绝进程B消费进程C的确认
 * 3. 残留确认自动放行：每次运行生成唯一 run_id 并写入 .current-run.json；
 * 确认文件必须 (a) run_id 匹配（若携带）且 (b) 时间戳晚于本次 .md 生成时间，
 * 否则一律归档拒绝，永不自动放行旧确认
 * 4. 残留状态污染：新运行启动时可调用 archiveStaleConfirmations() 把上一轮遗留的
 * confirmation-*.md / confirmation-*.json 全部归档，确认目录以干净状态开始
 *
 * 本模块只依赖 Node 内置模块，所有写文件操作均为 临时文件+rename 原子写。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── 路径约定（与 confirmation-server.js / human-confirm.js / gatekeeper 完全一致）──
const CONFIRMATIONS_DIR = path.join(__dirname, '..', 'hyperreality-system', 'output', 'confirmations');
const LOCK_PATH = path.join(__dirname, '..', 'hyperreality-system', 'output', '.preproduction.lock');
const RUN_STATE_PATH = path.join(CONFIRMATIONS_DIR, '.current-run.json');

// 归档子目录类别
const ARCHIVE_CATEGORIES = ['consumed', 'rejected', 'stale', 'pre-run', 'replay'];

// ─────────────────────────────────────────────────────────────────────────────
// 基础工具
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 原子写文件：先写临时文件再 rename，杜绝轮询方读到写了一半的文件
 */
function atomicWriteSync(filePath, content) {
 const dir = path.dirname(filePath);
 if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
 const tmp = path.join(dir, `.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
 fs.writeFileSync(tmp, content);
 fs.renameSync(tmp, filePath);
}

function readJsonSafe(filePath) {
 try {
 return JSON.parse(fs.readFileSync(filePath, 'utf8'));
 } catch (_) {
 return null;
 }
}

/**
 * 探测进程是否存活（信号 0 不发送真实信号，仅做错误检查）
 */
function isProcessAlive(pid) {
 if (!pid || typeof pid !== 'number' || pid <= 0) return false;
 try {
 process.kill(pid, 0);
 return true;
 } catch (e) {
 // EPERM = 进程存在但属于其他用户（本系统都是本机 root，基本不会发生）
 return e.code === 'EPERM';
 }
}

// ─────────────────────────────────────────────────────────────────────────────
// 单实例锁
// ─────────────────────────────────────────────────────────────────────────────

let _lockHeldByThisProcess = false;
let _exitHookRegistered = false;

function _registerExitHook() {
 if (_exitHookRegistered) return;
 _exitHookRegistered = true;
 process.on('exit', () => {
 try { releaseLock(); } catch (_) { /* 退出阶段静默 */ }
 });
}

/**
 * 读取当前锁持有者信息（无锁返回 null）
 */
function getLockHolder() {
 const holder = readJsonSafe(LOCK_PATH);
 if (!holder || typeof holder.pid !== 'number') return null;
 return holder;
}

/**
 * 获取预生产单实例锁
 *
 * @param {Object} meta - { title, intent, source }
 * @param {Object} opts - { force } force=true 时即使持有者是活进程也强制接管（慎用）
 * @returns {Object} { acquired, reason?, holder?, tookOverStale?, forcedOverLiveHolder?, reentrant? }
 */
function acquireLock(meta = {}, opts = {}) {
 const force = opts.force === true;

 // 本进程已持有锁 → 幂等重入（入口脚本与 create() 双层加锁时用到）
 if (_lockHeldByThisProcess) {
 const mine = getLockHolder();
 if (mine && mine.pid === process.pid) {
 return { acquired: true, reentrant: true };
 }
 // 锁文件被外部删除/替换 → 视为未持有，继续走正常获取流程
 _lockHeldByThisProcess = false;
 }

 const lockData = {
 pid: process.pid,
 title: String(meta.title || '未命名'),
 intent: String(meta.intent || '').substring(0, 120),
 source: String(meta.source || 'unknown'),
 started_at: new Date().toISOString(),
 started_ms: Date.now()
 };

 for (let attempt = 0; attempt < 2; attempt++) {
 // 第一选择：原子创建（wx 排他），无争用时直接成功
 try {
 const dir = path.dirname(LOCK_PATH);
 if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
 fs.writeFileSync(LOCK_PATH, JSON.stringify(lockData, null, 2), { flag: 'wx' });
 _lockHeldByThisProcess = true;
 _registerExitHook();
 return { acquired: true };
 } catch (e) {
 if (e.code !== 'EEXIST') throw e;
 }

 // 锁已存在 → 检查持有者
 const holder = getLockHolder();

 // 锁文件损坏/读不出 → 按 stale 处理，原子重写接管
 if (!holder) {
 try { fs.unlinkSync(LOCK_PATH); } catch (_) { /* 可能已被对方释放 */ }
 continue;
 }

 if (holder.pid === process.pid) {
 // 自己上一轮没释放干净（同进程重复 acquire）
 atomicWriteSync(LOCK_PATH, JSON.stringify(lockData, null, 2));
 _lockHeldByThisProcess = true;
 _registerExitHook();
 return { acquired: true, reentrant: true };
 }

 const holderAlive = isProcessAlive(holder.pid);
 if (holderAlive && !force) {
 return {
 acquired: false,
 reason: 'lock-held',
 holder
 };
 }

 // 持有者已死，或 force 强制接管 → 原子重写（rename 是原子操作）
 atomicWriteSync(LOCK_PATH, JSON.stringify(lockData, null, 2));

 // 二次校验：确认锁确实归自己（极小窗口内的最后一写者获胜）
 const final = getLockHolder();
 if (!final || final.pid !== process.pid) {
 return { acquired: false, reason: 'lock-race-lost', holder: final };
 }

 _lockHeldByThisProcess = true;
 _registerExitHook();
 return {
 acquired: true,
 tookOverStale: !holderAlive,
 forcedOverLiveHolder: holderAlive,
 previousHolder: holder
 };
 }

 return { acquired: false, reason: 'lock-unstable', holder: getLockHolder() };
}

/**
 * 释放锁（仅当锁属于本进程时才删除，避免误删他人锁）
 */
function releaseLock() {
 if (!_lockHeldByThisProcess) return false;
 const holder = getLockHolder();
 if (holder && holder.pid === process.pid) {
 try { fs.unlinkSync(LOCK_PATH); } catch (_) { /* 已不存在 */ }
 }
 _lockHeldByThisProcess = false;
 return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// 运行身份（run_id）
// ─────────────────────────────────────────────────────────────────────────────

function _pad(n) { return String(n).padStart(2, '0'); }

function generateRunId() {
 const d = new Date();
 const stamp = `${d.getFullYear()}${_pad(d.getMonth() + 1)}${_pad(d.getDate())}-${_pad(d.getHours())}${_pad(d.getMinutes())}${_pad(d.getSeconds())}`;
 return `run-${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * 开启一次新运行：写入 .current-run.json（原子写），返回 run_id
 */
function startRun(meta = {}) {
 const runId = generateRunId();
 const state = {
 run_id: runId,
 pid: process.pid,
 title: String(meta.title || '未命名'),
 status: 'running',
 started_at: new Date().toISOString()
 };
 atomicWriteSync(RUN_STATE_PATH, JSON.stringify(state, null, 2));
 return runId;
}

/**
 * 结束运行：状态标记为 finished（保留文件供审计与 human-confirm 提示）
 */
function finishRun(runId) {
 const state = readJsonSafe(RUN_STATE_PATH);
 if (!state || (runId && state.run_id !== runId)) return false;
 state.status = 'finished';
 state.finished_at = new Date().toISOString();
 atomicWriteSync(RUN_STATE_PATH, JSON.stringify(state, null, 2));
 return true;
}

/**
 * 读取当前运行状态（无则返回 null）
 */
function getCurrentRun() {
 return readJsonSafe(RUN_STATE_PATH);
}

// ─────────────────────────────────────────────────────────────────────────────
// 确认文件归档（替代 unlinkSync 的"消费删除"）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 把确认文件原子归档到 confirmations/archive/<category>/ 下
 * rename 同分区原子；跨设备兜底 copy+unlink。源文件不存在时静默成功。
 *
 * @param {string} absPath - 待归档文件绝对路径
 * @param {string} category - consumed | rejected | stale | pre-run | replay
 * @param {string} note - 附加到文件名的简短说明（可选）
 * @returns {string|null} 归档后的新路径；源文件不存在返回 null
 */
function archiveConfirmation(absPath, category, note = '') {
 if (!fs.existsSync(absPath)) return null;
 const safeCategory = ARCHIVE_CATEGORIES.includes(category) ? category : 'rejected';
 const archiveDir = path.join(CONFIRMATIONS_DIR, 'archive', safeCategory);
 if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });

 const base = path.basename(absPath);
 const notePart = note ? `.${String(note).replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 40)}` : '';
 const target = path.join(archiveDir, `${base}.${Date.now()}${notePart}`);

 try {
 fs.renameSync(absPath, target);
 } catch (e) {
 // 跨设备兜底
 try {
 fs.copyFileSync(absPath, target);
 fs.unlinkSync(absPath);
 } catch (_) {
 return null;
 }
 }
 return target;
}

/**
 * 新一轮运行开始前，把确认目录里上一轮遗留的 confirmation-*.md / confirmation-*.json
 * 全部归档到 archive/pre-run/（保留 audit.log、.current-run.json、archive/ 本身）
 *
 * @returns {string[]} 被归档的文件名列表
 */
function archiveStaleConfirmations() {
 const archived = [];
 if (!fs.existsSync(CONFIRMATIONS_DIR)) return archived;

 for (const name of fs.readdirSync(CONFIRMATIONS_DIR)) {
 if (!/^confirmation-.+\.(md|json)$/.test(name)) continue;
 const src = path.join(CONFIRMATIONS_DIR, name);
 try {
 if (!fs.statSync(src).isFile()) continue;
 } catch (_) { continue; }
 const target = archiveConfirmation(src, 'pre-run');
 if (target) archived.push(name);
 }
 return archived;
}

module.exports = {
 CONFIRMATIONS_DIR,
 LOCK_PATH,
 RUN_STATE_PATH,
 atomicWriteSync,
 readJsonSafe,
 isProcessAlive,
 getLockHolder,
 acquireLock,
 releaseLock,
 generateRunId,
 startRun,
 finishRun,
 getCurrentRun,
 archiveConfirmation,
 archiveStaleConfirmations
};