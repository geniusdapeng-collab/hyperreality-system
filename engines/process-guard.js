'use strict';
/**
 * 全局进程防护 v1.0
 * 作用：捕获 unhandledRejection / uncaughtException，防止 LLM 超时悬空 promise 直接杀死进程
 * 用法：在 index.js / run.js / run-preproduction.js 等入口第一行 require('./engines/process-guard')
 */
let installed = false;
function install() {
  if (installed) return;
  installed = true;

  process.on('unhandledRejection', (reason, promise) => {
    // 只记录，不退出进程。LLM 超时产生的悬空 rejection 会被这里吸收
    const msg = reason instanceof Error ? reason.message : String(reason);
    if (msg.includes('超时') || msg.includes('timeout') || msg.includes('Timeout')) {
      console.warn(`[ProcessGuard] 吸收LLM超时悬空rejection: ${msg}`);
    } else {
      console.error(`[ProcessGuard] 未处理Rejection(已吸收，进程继续): ${msg}`);
    }
  });

  process.on('uncaughtException', (err) => {
    console.error(`[ProcessGuard] 未捕获异常(已吸收，进程继续): ${err.message}`);
    // 不 process.exit，让流程继续；真正致命的错误由各阶段 try/catch 处理
  });
}

install();
module.exports = { install };
