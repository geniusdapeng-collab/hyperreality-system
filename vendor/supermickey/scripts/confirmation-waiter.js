
/**
 * confirmation-waiter.js - 人工确认等待器（确认文件的接收、校验与生命周期管理）
 *
 * 【v2.1.12-fix 多进程竞态修复】新增模块
 * 从 hyperreality-system/index.js 的 _waitForExternalConfirmation 抽离，
 * 使确认等待逻辑可独立测试；index.js 中的同名方法变为薄封装。
 * 【v2.1.13-fix】验签失败时追加"旧确认服务器实例漂移"排查指引。
 * 【v2.1.16-fix 确认未推送】新增两种推送通道：
 *   1. PENDING.json 机器可读状态文件——AI 助手/外部系统轮询单个文件即可获知
 *      "当前有待确认事项"，包含绝对路径、run_id、内容预览，不再靠猜路径
 *   2. 可选 webhook（STORMAXE_CONFIRM_WEBHOOK_URL）——确认文件生成后主动 POST
 *
 * 与旧实现的关键差异：
 * 1. 不再 unlinkSync 消费确认文件 → 验证通过后归档到 archive/consumed/（rename 原子），
 *    多进程场景下另一个进程不会"等到一半文件没了"而无限空转
 * 2. run_id 绑定：确认文件携带的 run_id 必须与本次运行一致（若携带），
 *    跨运行的确认一律归档拒绝 —— 旧确认永不放行新内容
 * 3. 新鲜度绑定：确认文件时间戳必须晚于本次 .md 生成时间（容忍 60s 时钟偏移），
 *    上一轮残留的合法签名确认（如事故中的 confirmation-portraits.json）不再自动放行
 * 4. 等待开始前先归档该 type 的残留 .json → 确定性消除"旧确认自动放行"
 * 5. nonce 重放（另一实例已消费/复制攻击）→ 明确返回 fatal 终止原因，
 *    流程干净退出，不再无限循环等待
 * 6. 所有写入（.md、归档）均为原子操作，轮询不会读到写了一半的文件
 */

const fs = require('fs');
const path = require('path');
const { verifyConfirmationDetailed } = require('./confirmation-crypto');
const runCoordinator = require('./run-coordinator');

// 确认时间戳早于 .md 生成时间超过该值 → 视为上一轮残留（容忍 60s 时钟/文件系统偏移）
const STALE_SKEW_MS = 60 * 1000;

/**
 * 写入待确认内容并轮询等待人工确认
 *
 * @param {Object} opts
 * @param {string} opts.type - 确认类型: creative-theme | requirement | prd | prompt | ...
 * @param {string} opts.content - 待确认的 Markdown 内容
 * @param {string|null} opts.runId - 本次运行的 run_id（null 时降级为仅时间戳绑定）
 * @param {Function} [opts.shouldAbort] - 返回 true 时中断等待（如收到关闭信号）
 * @param {Function} [opts.log] - 日志函数，默认 console.log
 * @returns {Promise<Object>} { approved, reason, suggestions, waitTimeMs, fatal? }
 */
async function waitForExternalConfirmation(opts) {
  const { type, content } = opts;
  const runId = opts.runId || null;
  const shouldAbort = typeof opts.shouldAbort === 'function' ? opts.shouldAbort : () => false;
  const log = typeof opts.log === 'function' ? opts.log : (...a) => console.log(...a);

  // ── 【hyperreality 融合桥】────────────────────────────────────────────
  // 当宿主（packages/video-studio）通过 globalThis.__HR_CONFIRMATION_HANDLER__
  // 注入审批处理器时，确认门改走 WorkLoom review-console 审批原生消息：
  // 处理器签名 async ({ type, content, runId, shouldAbort }) =>
  //   { approved: boolean, reason?: string, suggestions?: string[] }
  // 未注入时保持原始文件轮询行为不变（vendor 可独立运行）。
  const vmHandler = globalThis.__HR_CONFIRMATION_HANDLER__;
  if (typeof vmHandler === 'function') {
    const startedAt = Date.now();
    log(`[hyperreality] 确认门「${type}」已转交 IM 审批卡（run_id=${runId || 'n/a'}）`);
    const result = await vmHandler({ type, content, runId, shouldAbort });
    return {
      approved: result && result.approved === true,
      reason: (result && result.reason) || (result && result.approved ? 'im-approved' : 'im-rejected'),
      suggestions: Array.isArray(result && result.suggestions) ? result.suggestions : [],
      waitTimeMs: Date.now() - startedAt,
      ...(result && result.fatal ? { fatal: result.fatal } : {})
    };
  }
  // ── 【hyperreality 融合桥 完】────────────────────────────────────────

  // 【DXB-fix】onPoll 必须由 opts 解构，否则轮询循环引用裸变量抛 ReferenceError，
  // 导致确认门崩溃、流程绕过人工确认、上游创意主题字段断流（全 undefined）
  const onPoll = typeof opts.onPoll === 'function' ? opts.onPoll : null;

  const outputDir = runCoordinator.CONFIRMATIONS_DIR;
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // ── 写入待确认内容（原子写，附 run_id 与生成时间头部）──────────────────
  const mdWrittenAt = Date.now();
  const header = [
    '<!-- ',
    `run_id: ${runId || 'unknown'}`,
    `generated_at: ${new Date(mdWrittenAt).toISOString()}`,
    `type: ${type}`,
    '⚠️ 本文件由系统生成供人工审阅；确认后系统将归档对应 confirmation-' + type + '.json',
    '-->',
    ''
  ].join('\n');
  const contentPath = path.join(outputDir, `confirmation-${type}.md`);
  runCoordinator.atomicWriteSync(contentPath, header + content);

  // 【v2.1.16-fix 确认未推送】写入机器可读待确认状态（AI 助手轮询单文件即可感知）
  _writePendingState(outputDir, {
    pending: true,
    type,
    md_path: contentPath,
    run_id: runId,
    generated_at: new Date(mdWrittenAt).toISOString(),
    preview: String(content).slice(0, 300),
    pid: process.pid
  });
  // 【v2.1.16-fix】可选 webhook 主动推送（fire-and-forget，不阻塞流程）
  _pushWebhook({ event: 'confirmation.pending', type, md_path: contentPath, run_id: runId, generated_at: new Date(mdWrittenAt).toISOString() }, log);

  const confirmPath = path.join(outputDir, `confirmation-${type}.json`);

  // ── 预清理：该 type 若残留旧确认文件（上一轮遗留），一律归档 ─────────────
  // 这是"旧确认自动放行新内容"的确定性消除：等待开始前，目录里绝不允许存在
  // 早于本次 .md 的确认文件。
  if (fs.existsSync(confirmPath)) {
    const archived = runCoordinator.archiveConfirmation(confirmPath, 'stale', 'pre-wait-clean');
    log(`   🧹 已归档残留确认文件（上一轮遗留，不参与本次确认）: ${path.basename(archived || confirmPath)}`);
  }

  // 【v2.1.8-强制流程】禁止预置确认文件，必须等待真实人工确认（保持原规则）

  // ── 通知块（保持原风格，新增 run_id 展示）──────────────────────────────
  log('');
  log('╔══════════════════════════════════════════════════════════════════════╗');
  log(`║ 🔔 NOTIFICATION: confirmation-${type}.md 已生成 ║`);
  log('╠══════════════════════════════════════════════════════════════════════╣');
  log(`║ 文件路径: ${contentPath.substring(contentPath.length - 50).padStart(50)} ║`);
  log(`║ 查看命令: cat ${contentPath} ║`);
  log(`║ 运行编号: ${String(runId || 'unknown').padEnd(50)} ║`);
  log('║                                                                      ║');
  log('║ 请审阅内容后，运行以下命令确认:                                      ║');
  log(`║   node scripts/human-confirm.js ${type} approve "你的理由"           ║`);
  log('║ 或拒绝:                                                              ║');
  log(`║   node scripts/human-confirm.js ${type} reject "调整原因"           ║`);
  log('║                                                                      ║');
  log('║ ⚠️  AI 不得创建 confirmation-*.json，必须等待人类确认               ║');
  log('║ ⏱️  等待时间不计入流程有效时间                                       ║');
  log('╚══════════════════════════════════════════════════════════════════════╝');
  log('');

  // ── 等待循环（保持"等待不计入流程时间"的既定设计；可选硬上限）─────────
  const maxWait = 2 * 60 * 60 * 1000; // 2小时（仅作为提醒节点，不强制终止）
  // 【v2.1.12】轮询间隔可通过 STORMAXE_CONFIRM_POLL_MS 覆盖（默认 5s，测试/演示可调小）
  const checkInterval = (() => {
    const v = parseInt(process.env.STORMAXE_CONFIRM_POLL_MS || '', 10);
    return Number.isFinite(v) && v >= 200 ? v : 5000;
  })();
  const reminderIntervals = [15, 30, 45, 60, 90, 120];
  // 【v2.1.12】可选硬上限：默认 0 = 无限等待（保持原设计）；设置后超时明确失败，
  // 避免被外部守护（如 30 分钟后台超时）静默杀掉而状态不清
  const hardCapMs = (() => {
    const v = parseInt(process.env.STORMAXE_CONFIRM_MAX_WAIT_MS || '', 10);
    return Number.isFinite(v) && v > 0 ? v : 0;
  })();

  let lastReminderIndex = -1;
  let startTime = Date.now();
  let totalWaitMs = 0;

  const totalWaitSoFar = () => Date.now() - startTime + totalWaitMs;

  while (true) {
    const elapsed = Date.now() - startTime;
    const elapsedMins = Math.floor(elapsed / 60000);
    const totalElapsedMins = Math.floor(totalWaitMs / 60000) + elapsedMins;

    // 阶段提醒（原逻辑保持）
    const currentReminderIndex = reminderIntervals.findIndex(m => totalElapsedMins >= m && totalElapsedMins < m + 5);
    if (currentReminderIndex !== -1 && currentReminderIndex !== lastReminderIndex) {
      lastReminderIndex = currentReminderIndex;
      const reminderMin = reminderIntervals[currentReminderIndex];
      log('');
      log('🔄 '.repeat(15));
      log(`   📢 提醒: 已等待 ${reminderMin} 分钟，确认文件仍在等待中...`);
      log(`      请查看: ${contentPath}`);
      log(`      确认命令: node scripts/human-confirm.js ${type} approve "你的理由"`);
      log('      ⚠️ 等待时间不计入流程有效时间');
      log('🔄 '.repeat(15));
      log('');
    }

    // 2小时节点：提醒并重置计时，继续等待（原逻辑保持）
    if (elapsed >= maxWait) {
      totalWaitMs += elapsed;
      startTime = Date.now();
      log('');
      log('⏰ '.repeat(15));
      log('   ⏰ 等待已超2小时，流程仍继续等待...');
      log('   原因：等待确认的时间不计入流程有效时间');
      log('   如需确认，请运行上述命令');
      log('   如需终止，请发送关闭信号');
      log('⏰ '.repeat(15));
      log('');
    }

    // 【v2.1.12】可选硬上限（默认关闭）
    if (hardCapMs > 0 && totalWaitSoFar() >= hardCapMs) {
      log(`   ⛔ 等待确认超过硬上限 ${Math.round(hardCapMs / 60000)} 分钟（STORMAXE_CONFIRM_MAX_WAIT_MS），流程明确终止`);
      return {
        approved: false,
        reason: `confirm-wait-hard-timeout (${Math.round(hardCapMs / 60000)}min)`,
        suggestions: [],
        waitTimeMs: totalWaitSoFar(),
        fatal: true
      };
    }

    // 收到关闭信号，立即中断轮询（原逻辑保持）
    if (shouldAbort()) {
      log('   ⏰ 收到关闭信号，中断等待');
      return { approved: false, reason: 'shutdown', suggestions: [], waitTimeMs: totalWaitSoFar() };
    }

    // ── 检查确认文件 ─────────────────────────────────────────────────────
    if (fs.existsSync(confirmPath)) {
      let confirmData = null;
      try {
        confirmData = JSON.parse(fs.readFileSync(confirmPath, 'utf8'));
      } catch (e) {
        // 理论上原子写后不会再读到半个文件；兜底保留
        log('   ⚠️ 确认文件解析失败（可能写入中）,继续等待...');
      }

      if (confirmData) {
        // ① run_id 绑定：携带 run_id 且与本次运行不一致 → 跨运行确认，归档拒绝
        if (confirmData.run_id && runId && confirmData.run_id !== runId) {
          log(`   ⛔ 确认文件的 run_id (${confirmData.run_id}) 与本次运行 (${runId}) 不一致`);
          log('   ⛔ 该确认属于其他运行，已归档拒绝，继续等待本次运行的确认');
          runCoordinator.archiveConfirmation(confirmPath, 'rejected', 'run-id-mismatch');
          await new Promise(resolve => setTimeout(resolve, checkInterval));
          continue;
        }

        // ② 新鲜度绑定：确认时间戳早于本次 .md 生成时间 → 上一轮残留，归档拒绝
        if (typeof confirmData.timestamp === 'number' && confirmData.timestamp < mdWrittenAt - STALE_SKEW_MS) {
          log('   ⛔ 确认文件生成时间早于本次待确认内容（上一轮残留），已归档拒绝');
          runCoordinator.archiveConfirmation(confirmPath, 'rejected', 'stale-confirm');
          await new Promise(resolve => setTimeout(resolve, checkInterval));
          continue;
        }

        // ③ 密码学校验（签名 + 时间窗 + nonce 一次性）
        const verdict = verifyConfirmationDetailed(confirmData, type);
        if (!verdict.ok) {
          if (verdict.code === 'nonce-replay') {
            // 【v2.1.12 关键行为变更】nonce 已被消费 = 该确认已被另一实例消费，
            // 或遭遇复制攻击。无论哪种，继续等待都不会再有结果 → 明确终止，
            // 流程干净退出（原实现：删除文件后无限循环等待，即本次事故根因之一）
            log('   ⛔ 该确认已被其他实例消费（nonce 重放），或遭遇复制攻击');
            log('   ⛔ 本流程无法继续，明确终止。请确认只有一个预生产进程在运行后重试');
            runCoordinator.archiveConfirmation(confirmPath, 'replay', 'nonce-replay');
            return {
              approved: false,
              reason: 'confirmation-consumed-by-other-instance (nonce-replay)',
              suggestions: ['确认只有一个预生产进程在运行', '人工重新执行 human-confirm.js 确认'],
              waitTimeMs: totalWaitSoFar(),
              fatal: true
            };
          }
          log(`   ⛔ 拒绝非法确认文件: ${verdict.message}`);
          log('   ⛔ 仅人类可通过 human-confirm.js 工具生成有效签名');
          log('   ⛔ AI 不得擅自创建 confirmation-*.json');
          // 【v2.1.13】签名不匹配且确认由服务端生成时，给出实例漂移排查指引
          if (verdict.code === 'bad-signature') {
            log('   💡 排查提示: 若近期轮换过密钥或更新过确认服务代码，正在运行的确认服务器');
            log('      可能是持有旧密钥/旧代码的残留实例（本次 07-19 事故的成因）。');
            log('      运行 node scripts/ensure-confirmation-server.js 可自动检测并重启确认服务器');
          }
          // 归档（而非删除）非法确认文件：保留审计证据，且避免多进程下"删一半"
          runCoordinator.archiveConfirmation(confirmPath, 'rejected', verdict.code);
          await new Promise(resolve => setTimeout(resolve, checkInterval));
          continue;
        }

        // ④ 验证通过 → 归档消费（rename 原子），不再 unlinkSync
        _writePendingState(outputDir, { pending: false, type, run_id: runId, cleared_at: new Date().toISOString() });
        log(`   ✅ 收到有效人类确认: approved=${confirmData.approved}`);
        const archivedTo = runCoordinator.archiveConfirmation(confirmPath, 'consumed', runId || undefined);
        if (archivedTo) {
          log(`   🗂️ 确认文件已归档: ${path.basename(archivedTo)}`);
        }

        const waitTimeMs = totalWaitSoFar();
        log(`   ⏱️ 本次等待确认耗时: ${Math.round(waitTimeMs / 1000)}秒 (${Math.round(waitTimeMs / 60000)}分钟)`);
        log('   ⏱️ 等待时间不计入流程有效时间');
        return {
          approved: confirmData.approved === true || confirmData.approved === 'true' || confirmData.approved === 1,
          reason: confirmData.reason || '',
          suggestions: confirmData.suggestions || [],
          waitTimeMs
        };
      }
    }

    // 每5分钟打印一次简短状态（原逻辑保持）
    if (elapsed % 300000 < checkInterval) {
      log(`   ⏳ 等待确认中... (${elapsedMins}分钟) — 等待时间不计入流程总时间`);
    }

    // 【fix】确认等待期间保持心跳，防止 HealthMonitor 误判 Agent 死亡
    if (onPoll) { try { onPoll(); } catch (_) { /* 心跳回调失败不影响轮询 */ } }

    await new Promise(resolve => setTimeout(resolve, checkInterval));
  }
}

/**
 * 【v2.1.16-fix】写入待确认状态文件（原子写）
 * AI 助手只需轮询 PENDING.json 即可获知待确认事项，含绝对路径，消除路径不一致
 */
function _writePendingState(outputDir, state) {
  try {
    const pendingPath = path.join(outputDir, 'PENDING.json');
    const tmp = pendingPath + `.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, pendingPath);
  } catch (_) { /* 推送失败不阻断确认流程 */ }
}

/**
 * 【v2.1.16-fix】可选 webhook 推送（STORMAXE_CONFIRM_WEBHOOK_URL）
 * fire-and-forget：短超时、失败静默，绝不影响主流程
 */
function _pushWebhook(payload, log) {
  const url = process.env.STORMAXE_CONFIRM_WEBHOOK_URL;
  if (!url) return;
  try {
    const http = url.startsWith('https') ? require('https') : require('http');
    const body = JSON.stringify(payload);
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 5000
    });
    req.on('error', () => { /* 静默 */ });
    req.on('timeout', () => req.destroy());
    req.write(body);
    req.end();
    log(`   📡 确认通知已推送 webhook: ${u.hostname}`);
  } catch (_) { /* 静默 */ }
}

module.exports = { waitForExternalConfirmation, STALE_SKEW_MS };

