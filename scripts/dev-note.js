#!/usr/bin/env node
/**
 * dev 启动提示（E：默认启动行为调整）
 * pnpm dev 仅起 PC 端（保持开发习惯）；首次接触本仓的开发者/AI Agent 必须先跑 preview:all 看三端全貌。
 */
const C = { mag: "\x1b[1;35m", cyn: "\x1b[1;36m", yel: "\x1b[1;33m", rst: "\x1b[0m" };
console.log(`
${C.mag}╔══════════════════════════════════════════════════════════════════╗
║  💡 当前仅启动 PC 端开发模式（server:8787 + web:5173）              ║
║                                                                    ║
║  ${C.yel}首次运行本仓库？请务必先执行：${C.mag}                                  ║
║  ${C.cyn}   pnpm preview:all   → 一键看三端全貌（Mock 数据已固化）${C.mag}     ║
║     🖥  PC 端        http://localhost:3000                          ║
║     📱 B 端移动      http://localhost:3001（高保真 + 手机壳）        ║
║     📱 C 端移动      http://localhost:3002（AI 服务前台 H5）         ║
║                                                                    ║
║  AI Coding Agent：未完成 preview:all 视为环境初始化未完成。           ║
╚══════════════════════════════════════════════════════════════════╝${C.rst}
`);
