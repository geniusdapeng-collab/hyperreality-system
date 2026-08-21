#!/usr/bin/env node
/**
 * 人类确认工具 - v2.1.12-fix
 *
 * 这是唯一允许创建 confirmation-*.json 的工具。
 * 生成的确认文件包含 HMAC-SHA256 签名，AI 无法伪造。
 *
 * 【v2.1.12-fix 变更】
 * 1. 确认文件新增 run_id 字段（从 .current-run.json 读取）：
 * 预生产流程只接受与本次运行 run_id 一致的确认，跨运行确认一律拒绝
 * 2. 确认文件补齐 type 字段（与 confirmation-server.js 输出对齐）
 * 3. 写文件改为原子写（临时文件 + rename），轮询方不会读到写了一半的文件
 * 4. 无活动运行 / 运行已结束时给出醒目警告（确认将不会被任何流程接受）
 *
 * 用法:
 * node scripts/human-confirm.js <type> [approve|reject] [reason]
 *
 * 示例:
 * node scripts/human-confirm.js creative-theme approve "主题很好"
 * node scripts/human-confirm.js requirement reject "需要调整场景"
 * node scripts/human-confirm.js preproduction approve "可以提交渲染"
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const runCoordinator = require('./run-coordinator');

// 使用 process.argv[1] 获取脚本实际路径（兼容 exec 环境）
const scriptDir = path.dirname(process.argv[1]);

// 加载 .env 文件中的密钥（环境变量优先，确保主入口和 human-confirm.js 密钥一致）
let HUMAN_SECRET = process.env.HUMAN_CONFIRMATION_SECRET;

if (!HUMAN_SECRET) {
 try {
 const envPath = path.join(scriptDir, '..', '.env');
 const envContent = fs.readFileSync(envPath, 'utf8');
 const secretMatch = envContent.match(/HUMAN_CONFIRMATION_SECRET=(.+)/);
 if (secretMatch) {
 HUMAN_SECRET = secretMatch[1].trim();
 process.env.HUMAN_CONFIRMATION_SECRET = HUMAN_SECRET; // 同步到环境变量
 }
 } catch (e) {
 // .env 不存在，尝试从环境变量读取（上面已读取）
 }
}

if (!HUMAN_SECRET) {
 console.error('❌ 错误: HUMAN_CONFIRMATION_SECRET 未设置');
 console.error(' 示例: export HUMAN_CONFIRMATION_SECRET=$(openssl rand -hex 32)');
 console.error(' 或确保 .env 文件中包含 HUMAN_CONFIRMATION_SECRET');
 process.exit(1);
}

const type = process.argv[2];
const approved = process.argv[3] !== 'reject'; // 默认 approve
const reason = process.argv[4] || '';

if (!type) {
 console.log('用法: node scripts/human-confirm.js <type> [approve|reject] [reason]');
 console.log('');
 console.log('步骤类型:');
 console.log(' creative-theme - 创意主题确认 (Step 2)');
 console.log(' requirement - 需求清单确认 (Step 3)');
 console.log(' prd - PRD 确认 (Step 4)');
 console.log(' prompt - 提示词审核确认 (Step 5)');
 console.log(' preproduction - 预生产结果最终确认 (Step 6)');
 console.log('');
 console.log('示例:');
 console.log(' node scripts/human-confirm.js creative-theme approve "主题很好"');
 console.log(' node scripts/human-confirm.js requirement reject "需要调整场景"');
 console.log(' node scripts/human-confirm.js preproduction approve "可以提交渲染"');
 process.exit(1);
}

// 【v2.1.12】读取当前运行，绑定 run_id
const currentRun = runCoordinator.getCurrentRun();
if (!currentRun) {
 console.warn('⚠️ 警告: 未检测到任何预生产运行（.current-run.json 不存在）');
 console.warn(' 本次确认将不携带 run_id，仅能被未启用 run 绑定的旧流程接受');
} else if (currentRun.status !== 'running') {
 console.warn(`⚠️ 警告: 最近一次运行 (${currentRun.run_id}) 已结束（status=${currentRun.status}）`);
 console.warn(' 如果没有正在等待确认的流程，本次确认不会被接受');
} else {
 console.log(`🔗 绑定运行: ${currentRun.run_id} | 主题: ${currentRun.title || '未命名'}`);
}

// 【v2.1.12】对应 .md 不存在时提示（可能在确认一个尚未生成的环节）
const mdPath = path.join(scriptDir, '..', 'hyperreality-system', 'output', 'confirmations', `confirmation-${type}.md`);
if (!fs.existsSync(mdPath)) {
 console.warn(`⚠️ 警告: confirmation-${type}.md 尚不存在（该环节可能还未生成待确认内容）`);
}

// 生成密码学安全的确认文件
const timestamp = Date.now();
const nonce = crypto.randomBytes(16).toString('hex');
const payload = `${type}:${timestamp}:${nonce}`;
const signature = crypto.createHmac('sha256', HUMAN_SECRET).update(payload).digest('hex');

const confirmData = {
 type, // 【v2.1.12】补齐 type 字段（与 confirmation-server.js 对齐）
 approved,
 timestamp,
 nonce,
 signature,
 reason,
 confirmed_at: new Date().toISOString(),
 run_id: currentRun && currentRun.status === 'running' ? currentRun.run_id : null // 【v2.1.12】绑定运行
 // 注意: 没有 confirmed_by_human 字段——签名本身就证明了人类身份
};

const confirmPath = path.join(scriptDir, '..', 'hyperreality-system', 'output', 'confirmations', `confirmation-${type}.json`);

// 【v2.1.12】原子写（临时文件 + rename）
runCoordinator.atomicWriteSync(confirmPath, JSON.stringify(confirmData, null, 2));

// 【v2.1.20-fix 确认后仍推送】确认动作的源头即清 PENDING.json——
// 不再依赖 waiter 消费或检查器自愈（主流程死亡时那两条路都断），
// cron 下一轮检查时立即静默
try {
 const pendingPath = path.join(scriptDir, '..', 'hyperreality-system', 'output', 'confirmations', 'PENDING.json');
 const pend = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
 if (pend && pend.pending === true && pend.type === type) {
 runCoordinator.atomicWriteSync(pendingPath, JSON.stringify({
 pending: false,
 type,
 run_id: pend.run_id || confirmData.run_id,
 cleared_at: new Date().toISOString(),
 cleared_by: 'human-confirm'
 }, null, 2));
 console.log(`🧹 PENDING.json 已同步清除（type=${type}）`);
 }
} catch (_) { /* 非关键路径：PENDING 不存在或无权限时静默 */ }

console.log('');
console.log('╔══════════════════════════════════════════╗');
console.log(`║ ✅ 已确认: ${type.padEnd(24)} ║`);
console.log('╠══════════════════════════════════════════╣');
console.log(`║ 文件: ${confirmPath.substring(confirmPath.length - 36).padEnd(34)} ║`);
console.log(`║ 签名: ${signature.substring(0, 24).padEnd(34)}... ║`);
console.log(`║ 状态: ${(approved ? '✅ 通过' : '❌ 拒绝').padEnd(31)} ║`);
if (reason) {
 console.log(`║ 理由: ${reason.substring(0, 30).padEnd(30)} ║`);
}
if (confirmData.run_id) {
 console.log(`║ 运行: ${confirmData.run_id.substring(0, 30).padEnd(30)} ║`);
}
console.log('╚══════════════════════════════════════════╝');
console.log('');
console.log('⚠️ 确认文件已生成，预生产流程将继续。');
console.log(' AI 无法伪造此签名，因为密钥仅人类知晓。');
console.log('');
