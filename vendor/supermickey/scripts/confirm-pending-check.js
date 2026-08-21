#!/usr/bin/env node
/**
 * confirm-pending-check.js - 待确认一次性检查器（v2.1.20-fix）
 *
 * 【v2.1.20-fix 确认后仍推送/死流程持续推送】
 * 1. 流程死亡检测闭环：锁与运行状态均无存活进程时，
 * (a) 把 .current-run.json 标记为 terminated（不再是永远 running 的僵尸状态）
 * (b) 只发一次死亡通告（含当前待确认环节的简短说明），此后绝对静默——
 * 不再像 v2.1.19 那样每次 cron 都重新警告一遍
 * 2. 确认源侧清理（human-confirm.js / confirmation-server.js 已同步修改），
 * 本检查器的 alreadyConfirmed 自愈作为兜底双保险
 *
 * 【定位】确认推送闭环的"最后一公里"，专为 cron 定时调用设计：
 * - 一次性执行（不是守护进程），无僵尸进程、无 stdout 管道问题
 * - 有新的待确认 → 把完整内容打印到 stdout 并以退出码 42 标记"转发给用户"
 * - 已推送过 → 静默（去重）
 * - 流程疑似死亡 → 输出醒目警告
 *
 * 【v2.1.19-fix 不停催确认修复】
 * 1. 去重键由 type:generated_at 改为 type+确认文件内容哈希——
 * 线上 waiter 若定时重写 PENDING.json 并刷新 generated_at，
 * 旧去重键每轮失效导致"每轮全量重推"；内容哈希与重写次数无关，天然稳定
 * 2. 自愈机制：PENDING 仍 pending=true，但 confirmation-<type>.json 已存在
 * （用户已确认）或已被归档消费 → 就地修正 PENDING 为 false 并【静默退出】，
 * 不再依赖预生产进程清除 PENDING，"已确认还催"从根上断掉
 * 3. 稀疏提醒：完整内容只推一次；之后每 STORMAXE_REMIND_MIN 分钟（默认30，0=关闭）
 * 只发两行短提醒，不再刷全文
 *
 * 【SOP 铁律】退出码 0 = 绝对静默，AI 助手不得向用户发送任何消息（含"无新内容"）；
 * 只有退出码 42 才允许转发。
 *
 * 退出码：
 * 42 = 有需要转发的内容（stdout 即为待转发内容）
 * 0 = 静默（禁止发任何消息）
 * 1 = 执行异常
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const runCoordinator = require('./run-coordinator');

const CONF_DIR = runCoordinator.CONFIRMATIONS_DIR;
const PENDING_PATH = path.join(CONF_DIR, 'PENDING.json');
const MARKER_PATH = path.join(CONF_DIR, '.push-marker.json');

const EXIT_FORWARD = 42;

// 稀疏提醒间隔（默认 30 分钟；STORMAXE_REMIND_MIN=0 关闭提醒）
const REMIND_MS = (() => {
 const v = parseInt(process.env.STORMAXE_REMIND_MIN || '', 10);
 return Number.isFinite(v) ? v * 60 * 1000 : 30 * 60 * 1000;
})();

function readJson(file) {
 try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function writeJsonAtomic(file, data) {
 try {
 const tmp = `${file}.tmp-${process.pid}`;
 fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
 fs.renameSync(tmp, file);
 } catch (_) { /* 写失败不影响主流程 */ }
}

/** 读取确认正文（去 HTML 注释头），失败返回 null */
function readMdBody(mdPath) {
 try {
 const raw = fs.readFileSync(mdPath, 'utf8');
 return raw.replace(/^<!--[\s\S]*?-->\n?/, '').trim();
 } catch (_) {
 return null;
 }
}

/** 去重键：type + 内容哈希（PENDING 被重写刷新 generated_at 也不受影响） */
function dedupKey(state, body) {
 const hashSource = body !== null ? body : `${state.type}:${state.generated_at || ''}`;
 const hash = crypto.createHash('md5').update(hashSource).digest('hex').slice(0, 12);
 return `${state.type}:${hash}`;
}

/** 检查该环节是否已被确认（json 在热路径 或 已归档消费） */
function alreadyConfirmed(state, mdMtimeMs) {
 const type = state.type;
 // ① 热路径上确认文件已存在（用户已执行 human-confirm / 服务端已签发）
 if (fs.existsSync(path.join(CONF_DIR, `confirmation-${type}.json`))) return true;
 // ② 归档目录里存在晚于 .md 生成的消费记录
 for (const sub of ['consumed', 'replay']) {
 const dir = path.join(CONF_DIR, 'archive', sub);
 try {
 if (!fs.existsSync(dir)) continue;
 const hit = fs.readdirSync(dir).some(f => {
 if (!f.startsWith(`confirmation-${type}.json.`)) return false;
 try { return fs.statSync(path.join(dir, f)).mtimeMs >= mdMtimeMs - 60 * 1000; } catch (_) { return false; }
 });
 if (hit) return true;
 } catch (_) { /* ignore */ }
 }
 return false;
}

function main() {
 const state = readJson(PENDING_PATH);

 // ── 无待确认 ──────────────────────────────────────────────────────────
 if (!state || state.pending !== true) {
 if (state && state.pending === false) {
 const marker = readJson(MARKER_PATH);
 if (marker && marker.lastPushedKey) {
 writeJsonAtomic(MARKER_PATH, { lastPushedKey: null, cleared_at: new Date().toISOString() });
 }
 }
 process.exit(0);
 }

 const mdPath = state.md_path;
 const body = mdPath ? readMdBody(mdPath) : null;
 let mdMtime = 0;
 try { mdMtime = fs.statSync(mdPath).mtimeMs; } catch (_) { /* ignore */ }

 // ── 【v2.1.19】自愈：PENDING 还挂着，但其实已经确认过了 ──────────────
 if (alreadyConfirmed(state, mdMtime)) {
 writeJsonAtomic(PENDING_PATH, { pending: false, type: state.type, run_id: state.run_id, healed_at: new Date().toISOString(), heal_reason: 'confirmed-detected-by-checker' });
 writeJsonAtomic(MARKER_PATH, { lastPushedKey: null, cleared_at: new Date().toISOString() });
 // 绝对静默退出（不打 42，一行日志也不给——助手没有任何可转发的内容）
 process.exit(0);
 }

 // ── 流程存活检查（提前：死亡时走专门分支）────────────────────────────
 const lock = runCoordinator.getLockHolder();
 const lockAlive = lock && runCoordinator.isProcessAlive(lock.pid);
 const run = runCoordinator.getCurrentRun();
 const runAlive = run && run.status === 'running' && runCoordinator.isProcessAlive(run.pid);
 const processAlive = lockAlive || runAlive;

 const marker0 = readJson(MARKER_PATH) || {};

 // ── 【v2.1.20】流程死亡分支：标记 terminated + 一次性死亡通告 + 此后静默 ──
 if (!processAlive) {
 // (a) 僵尸运行状态修复：.current-run.json 仍 running 但 PID 已死 → 标记 terminated
 if (run && run.status === 'running' && run.pid && !runCoordinator.isProcessAlive(run.pid)) {
 try {
 runCoordinator.atomicWriteSync(runCoordinator.RUN_STATE_PATH, JSON.stringify({
 ...run, status: 'terminated', terminated_at: new Date().toISOString(),
 terminate_reason: 'pid-dead-detected-by-confirm-check'
 }, null, 2));
 } catch (_) { /* 非关键路径 */ }
 }
 // (b) 死亡通告只发一次（按环节+内容哈希去重）
 const deadKey = `dead:${dedupKey(state, body)}`;
 if (marker0.deadNotifiedKey === deadKey) {
 process.exit(0); // 已通告过，绝对静默
 }
 writeJsonAtomic(MARKER_PATH, { ...marker0, deadNotifiedKey: deadKey, deadNotifiedAt: new Date().toISOString() });
 const deadLines = [
 `⛔ 【流程已终止】预生产流程已不在运行（运行: ${state.run_id || 'unknown'}）`,
 ` 当前挂起的 ${state.type} 环节确认已失效——即使确认也无法继续。`,
 ` 处置：重启预生产流程后，系统会重新生成该环节并再次推送。`,
 ` （本条为一次性通告，在流程重启前不会再重复提醒）`
 ];
 console.log(deadLines.join('\n'));
 process.exit(EXIT_FORWARD);
 }

 // ── 去重判定 ──────────────────────────────────────────────────────────
 const key = dedupKey(state, body);
 const marker = marker0;

 if (marker.lastPushedKey === key) {
 // 已推过：仅按稀疏间隔发短提醒（默认30分钟；0=关闭）
 if (REMIND_MS > 0) {
 const lastRemind = Date.parse(marker.lastRemindAt || marker.pushed_at || 0);
 if (Number.isFinite(lastRemind) && Date.now() - lastRemind >= REMIND_MS) {
 writeJsonAtomic(MARKER_PATH, { ...marker, lastRemindAt: new Date().toISOString() });
 console.log(`⏰ 【仍待确认】${state.type} 环节的确认内容已于 ${marker.pushed_at ? marker.pushed_at.substring(11, 16) : '此前'} 推送，您回复"确认"即可继续（运行: ${state.run_id || 'unknown'}）`);
 process.exit(EXIT_FORWARD);
 }
 }
 process.exit(0);
 }

 // ── 首次推送：输出完整内容（流程存活已在前置分支确认）──────────────
 const lines = [];
 lines.push(`🔔 【待确认】${state.type} 环节需要您审阅（运行: ${state.run_id || 'unknown'}）`);
 lines.push('');
 lines.push('─'.repeat(50));
 lines.push(body !== null ? body : `(确认文件路径: ${mdPath || '未知'})`);
 lines.push('─'.repeat(50));
 lines.push(`👉 审阅后回复"确认"或"OK"；需修改请回复"拒绝:原因"`);
 lines.push(` （AI 助手将代为执行: node scripts/human-confirm.js ${state.type} approve "理由"）`);

 console.log(lines.join('\n'));

 writeJsonAtomic(MARKER_PATH, {
 lastPushedKey: key,
 lastType: state.type,
 pushed_at: new Date().toISOString(),
 lastRemindAt: new Date().toISOString(),
 processAliveAtPush: processAlive
 });

 process.exit(EXIT_FORWARD);
}

try {
 main();
} catch (e) {
 console.error(`[confirm-check] 执行异常: ${e.message}`);
 process.exit(1);
}
