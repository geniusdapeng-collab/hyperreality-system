/**
 * 优雅关闭工具
 * 解决 HealthMonitor SIGKILL：预生产完成后主动停止心跳检查，避免误判死亡→重启→与退出竞争
 *
 * 用法（在 run-promo.js 或 index.js 主流程末尾调用）：
 *   const { gracefulShutdown } = require('./utils/graceful-shutdown');
 *   await gracefulShutdown({
 *     healthMonitor: system.healthMonitor,
 *     llmEngine: system.llmEngine,
 *     agents: [system.productionEngine, system.scriptEngine],
 *     timeoutMs: 15000
 *   });
 */

'use strict';

async function gracefulShutdown({ healthMonitor, llmEngine, agents = [], timeoutMs = 15000 } = {}) {
  console.log('[Shutdown] 开始优雅关闭...');

  const guard = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('gracefulShutdown 总超时')), timeoutMs)
  );

  const work = (async () => {
    // 1. 停止 HealthMonitor 心跳检查
    if (healthMonitor) {
      try {
        if (typeof healthMonitor.stop === 'function') {
          healthMonitor.stop();
          console.log('[Shutdown] HealthMonitor 已停止');
        } else if (typeof healthMonitor.shutdown === 'function') {
          healthMonitor.shutdown();
          console.log('[Shutdown] HealthMonitor 已关闭');
        }
      } catch (e) {
        console.warn('[Shutdown] HealthMonitor.stop 异常:', e.message);
      }
    }

    // 2. 主动结束各 Agent
    for (const a of agents) {
      try {
        if (typeof a.finish === 'function') a.finish();
        else if (typeof a.stop === 'function') a.stop();
        else if (typeof a.shutdown === 'function') a.shutdown();
      } catch (_) {}
    }

    // 3. 关闭 LLMEngine 底层连接（如有）
    if (llmEngine && typeof llmEngine.close === 'function') {
      try { await llmEngine.close(); console.log('[Shutdown] LLMEngine 已关闭'); } catch (_) {}
    }

    // 4. flush 后退出
    await new Promise(r => setTimeout(r, 500));
    console.log('[Shutdown] 优雅关闭完成，退出进程');
    process.exit(0);
  })();

  try {
    await Promise.race([work, guard]);
  } catch (e) {
    console.warn('[Shutdown] 优雅关闭异常，强制退出:', e.message);
    process.exit(0);
  }
}

module.exports = { gracefulShutdown };