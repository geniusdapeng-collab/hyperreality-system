
/**
 * watch-confirmations.js - 确认通知推送守护（v2.1.16-fix 新增）
 *
 * 解决【问题2】确认文件生成后 AI 助手不主动推送、用户干等几十分钟：
 * 原架构里系统只把 NOTIFICATION 打进日志文件，没有任何通道通知 AI 助手。
 *
 * 用法（AI 助手在启动预生产后，后台运行本脚本）：
 *   node scripts/watch-confirmations.js
 *   node scripts/watch-confirmations.js --interval 5 --max-idle 30
 *
 * 行为：
 * 1. 每 interval 秒轮询 hyperreality-system/output/confirmations/PENDING.json
 * 2. 发现新的待确认事项 → 把确认文件【完整内容】打印到 stdout（AI 助手转发给用户）
 * 3. 待确认被处理 → 打印简短"已确认继续"提示
 * 4. 退出：运行结束(.current-run.json 状态 finished)、或持续 maxIdle 分钟无活动、或 Ctrl+C
 *
 * 环境变量：
 *   STORMAXE_WATCH_INTERVAL_MS  轮询间隔（默认 10000，--interval 秒数可覆盖）
 *   STORMAXE_WATCH_MAX_IDLE_MIN 最大空闲分钟（默认 30，--max-idle 可覆盖）
 */

const fs = require('fs');
const path = require('path');

const runCoordinator = require('./run-coordinator');

// ── 参数 ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function argValue(name) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
}
const intervalMs = (() => {
  const v = parseInt(argValue('interval') || '', 10);
  if (Number.isFinite(v) && v >= 1) return v * 1000;
  const env = parseInt(process.env.STORMAXE_WATCH_INTERVAL_MS || '', 10);
  return Number.isFinite(env) && env >= 1000 ? env : 10000;
})();
const maxIdleMs = (() => {
  const v = parseInt(argValue('max-idle') || '', 10);
  if (Number.isFinite(v) && v >= 1) return v * 60 * 1000;
  const env = parseInt(process.env.STORMAXE_WATCH_MAX_IDLE_MIN || '', 10);
  return Number.isFinite(env) && env >= 1 ? env * 60 * 1000 : 30 * 60 * 1000;
})();

const PENDING_PATH = path.join(runCoordinator.CONFIRMATIONS_DIR, 'PENDING.json');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function out(...a) { console.log(...a); }

let lastPendingKey = null;   // `${type}:${generated_at}` 去重
let lastActivityAt = Date.now();

function printFullConfirmation(state) {
  out('');
  out('🔔'.repeat(20));
  out(`【新待确认事项】步骤: ${state.type} | 运行: ${state.run_id || 'unknown'}`);
  out(`文件: ${state.md_path}`);
  out('─'.repeat(70));
  try {
    const content = fs.readFileSync(state.md_path, 'utf8');
    // 去掉 HTML 注释头（run_id 元信息块），直接给正文
    const body = content.replace(/^<!--[\s\S]*?-->\n?/, '');
    out(body.trim());
  } catch (e) {
    out(`(读取确认文件失败: ${e.message}，请人工 cat 上述路径)`);
  }
  out('─'.repeat(70));
  out(`👉 请用户审阅后回复"确认"或"OK"（拒绝请说"拒绝:原因"）`);
  out(`   或人工执行: node scripts/human-confirm.js ${state.type} approve "理由"`);
  out('🔔'.repeat(20));
  out('');
}

async function tick() {
  const state = readJson(PENDING_PATH);

  // 有运行状态且已结束 → 退出
  const run = runCoordinator.getCurrentRun();
  if (run && run.status === 'finished') {
    out('🏁 预生产运行已结束，推送守护退出');
    process.exit(0);
  }

  if (state && state.pending === true && state.md_path) {
    const key = `${state.type}:${state.generated_at || ''}`;
    if (key !== lastPendingKey) {
      lastPendingKey = key;
      lastActivityAt = Date.now();
      printFullConfirmation(state);
    }
    return;
  }

  // pending 清除（刚被确认）
  if (state && state.pending === false && lastPendingKey) {
    lastPendingKey = null;
    lastActivityAt = Date.now();
    out(`✅ 【${state.type}】已确认，流程继续推进（继续监听下一环节）`);
    return;
  }

  // 空闲超时
  if (Date.now() - lastActivityAt > maxIdleMs) {
    out(`😴 超过 ${Math.round(maxIdleMs / 60000)} 分钟无确认活动，推送守护退出`);
    process.exit(0);
  }
}

out('👀 确认通知推送守护已启动');
out(`   监听: ${PENDING_PATH}`);
out(`   间隔: ${intervalMs / 1000}s | 空闲退出: ${Math.round(maxIdleMs / 60000)}min | Ctrl+C 手动退出`);
out('');

// 启动即检查一次，之后定时轮询
tick().catch(() => {});
const timer = setInterval(() => {
  tick().catch(() => {});
}, intervalMs);

process.on('SIGINT', () => { clearInterval(timer); process.exit(0); });
process.on('SIGTERM', () => { clearInterval(timer); process.exit(0); });

