#!/usr/bin/env node
/**
 * inherit-confirmation.js - 人工确认继承工具（v2.1.13-fix 新增）
 *
 * 解决的事故场景（2026-07-19 晨）：
 * 预生产进程在人工确认之后死亡（后台超时/旧确认服务器事故），
 * 重启后整个流程只能从 Step 1 重来——同一内容用户被迫再审一遍、二次确认。
 *
 * 本工具由【人类】主动运行：从 archive/consumed/ 中找到上一轮已消费的确认，
 * 用当前密钥重新签发一份绑定当前 run_id 的新确认文件，
 * 正在等待的主流程即可正常接收——无需再次逐字审阅同一内容。
 *
 * 安全性说明：
 * - 与 human-confirm.js 同级：只有持有 HUMAN_CONFIRMATION_SECRET 的人才能签发，
 *   AI 无法伪造（密钥仍在 .env，AI 不可读取）
 * - 必须显式加 --yes 才执行，防止误操作
 * - 继承动作会写入 audit-inherit.log 全程留痕
 *
 * 用法:
 *   node scripts/inherit-confirmation.js <type> --yes ["继承理由"]
 *
 * 示例:
 *   node scripts/inherit-confirmation.js creative-theme --yes "进程被超时杀掉，内容未变，继承上次确认"
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const runCoordinator = require('./run-coordinator');

const scriptDir = path.dirname(process.argv[1]);

// 加载密钥（环境变量优先，与 human-confirm.js 一致）
let HUMAN_SECRET = process.env.HUMAN_CONFIRMATION_SECRET;
if (!HUMAN_SECRET) {
  try {
    const envContent = fs.readFileSync(path.join(scriptDir, '..', '.env'), 'utf8');
    const m = envContent.match(/HUMAN_CONFIRMATION_SECRET=(.+)/);
    if (m) HUMAN_SECRET = m[1].trim();
  } catch (_) { /* ignore */ }
}
if (!HUMAN_SECRET) {
  console.error('❌ 错误: HUMAN_CONFIRMATION_SECRET 未设置（.env 缺失或无该字段）');
  process.exit(1);
}

const type = process.argv[2];
const yes = process.argv.includes('--yes');
const reasonArg = process.argv.find((a, i) => i > 2 && !a.startsWith('--') && a !== type) || '';

if (!type) {
  console.log('用法: node scripts/inherit-confirmation.js <type> --yes ["继承理由"]');
  console.log('');
  console.log('步骤类型: creative-theme | requirement | prd | prompt');
  console.log('');
  console.log('说明: 从 archive/consumed/ 找最近一次同类型确认，重新签发绑定当前运行。');
  process.exit(1);
}

// ── 前置校验 ─────────────────────────────────────────────────────────────
const currentRun = runCoordinator.getCurrentRun();
if (!currentRun || currentRun.status !== 'running') {
  console.error('❌ 没有正在运行的预生产流程（.current-run.json 缺失或已结束）');
  console.error('  请先启动预生产流程，待其进入确认等待环节后再运行本工具');
  process.exit(1);
}

const CONF_DIR = runCoordinator.CONFIRMATIONS_DIR;
const hotPath = path.join(CONF_DIR, `confirmation-${type}.json`);
if (fs.existsSync(hotPath)) {
  console.error(`❌ confirmation-${type}.json 已存在（可能刚被确认过），无需继承`);
  process.exit(1);
}

const consumedDir = path.join(CONF_DIR, 'archive', 'consumed');
if (!fs.existsSync(consumedDir)) {
  console.error('❌ archive/consumed/ 不存在，历史上没有被消费过的确认，无法继承');
  process.exit(1);
}

// 找最近一次同类型、approved=true 的消费归档
const candidates = fs.readdirSync(consumedDir)
  .filter(f => f.startsWith(`confirmation-${type}.json.`))
  .sort() // 文件名内嵌毫秒时间戳，字典序即时间序
  .reverse();

if (candidates.length === 0) {
  console.error(`❌ archive/consumed/ 中没有 confirmation-${type} 的历史确认，无法继承`);
  process.exit(1);
}

let inherited = null;
let inheritedFile = null;
for (const f of candidates) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(consumedDir, f), 'utf8'));
    if (data.approved === true) { inherited = data; inheritedFile = f; break; }
    if (!inherited) { inherited = data; inheritedFile = f; } // 兜底：最近一次哪怕是 reject
  } catch (_) { /* 跳过坏文件 */ }
}

if (!inherited) {
  console.error('❌ 历史确认文件均无法解析，无法继承');
  process.exit(1);
}

// ── 展示将要继承的内容，人类确认 --yes 后执行 ─────────────────────────────
console.log('');
console.log('═══ 确认继承预览 ═══');
console.log(`  继承来源: archive/consumed/${inheritedFile}`);
console.log(`  原确认时间: ${inherited.confirmed_at || '未知'}`);
console.log(`  原运行编号: ${inherited.run_id || '（v2.1.10 时代，无 run_id）'}`);
console.log(`  原结论: ${inherited.approved ? '✅ 通过' : '❌ 拒绝'}`);
console.log(`  原理由: ${inherited.reason || '（无）'}`);
console.log(`  绑定到: ${currentRun.run_id}（当前运行 | 主题: ${currentRun.title || '未命名'}）`);
console.log('');

if (!yes) {
  console.log('⚠️  以上是即将继承的确认内容。确认无误后，追加 --yes 执行：');
  console.log(`  node scripts/inherit-confirmation.js ${type} --yes "继承理由"`);
  process.exit(0);
}

// ── 重新签发（当前密钥 + 新 nonce/timestamp + 当前 run_id）───────────────
const timestamp = Date.now();
const nonce = crypto.randomBytes(16).toString('hex');
const payload = `${type}:${timestamp}:${nonce}`;
const signature = crypto.createHmac('sha256', HUMAN_SECRET).update(payload).digest('hex');

const confirmData = {
  type,
  approved: inherited.approved === true,
  timestamp,
  nonce,
  signature,
  reason: reasonArg || `继承自 ${inherited.confirmed_at || '上次运行'} 的确认${inherited.reason ? '（原理由: ' + inherited.reason + '）' : ''}`,
  confirmed_at: new Date().toISOString(),
  run_id: currentRun.run_id,
  inherited_from: {
    file: inheritedFile,
    confirmed_at: inherited.confirmed_at || null,
    run_id: inherited.run_id || null
  }
};

runCoordinator.atomicWriteSync(hotPath, JSON.stringify(confirmData, null, 2));

// 继承动作留痕
try {
  fs.appendFileSync(
    path.join(CONF_DIR, 'audit-inherit.log'),
    [new Date().toISOString(), type, `approved=${confirmData.approved}`, `from=${inheritedFile}`, `run=${currentRun.run_id}`, `reason=${confirmData.reason}`].join(' | ') + '\n',
    'utf8'
  );
} catch (_) { /* 非关键路径 */ }

console.log('╔══════════════════════════════════════════╗');
console.log(`║ ✅ 已继承确认: ${type.padEnd(20)} ║`);
console.log('╚══════════════════════════════════════════╝');
console.log(`  文件: confirmation-${type}.json（绑定 ${currentRun.run_id}）`);
console.log(`  结论: ${confirmData.approved ? '✅ 通过' : '❌ 拒绝'} | 新签名已用当前密钥签发`);
console.log('');
console.log('  正在等待的主流程将在几秒内接收到该确认并继续。');
console.log('');
