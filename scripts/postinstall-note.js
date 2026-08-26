#!/usr/bin/env node
/**
 * postinstall 欢迎横幅（人类感知 L2 层）
 * pnpm install 是开发者克隆后的第一个必然动作——这就是"克隆后自动呈现"的正确 hook 点。
 * 仅在交互终端显示；CI 环境（CI=true）静默跳过。
 */
if (process.env.CI || !process.stdout.isTTY) process.exit(0);
const C = { mag: "\x1b[1;35m", cyn: "\x1b[1;36m", yel: "\x1b[1;33m", rst: "\x1b[0m" };
console.log(`
${C.mag}╔══════════════════════════════════════════════════════════════════╗
║        🎉 欢迎使用 WorkLoom —— 依赖安装完成，还差最后一步          ║
╠══════════════════════════════════════════════════════════════════╣
║                                                                    ║
║  ${C.yel}▶ 首次运行，一键看三端全貌（Mock 数据已固化，无需密钥）：${C.mag}    ║
║  ${C.cyn}   pnpm preview:all${C.mag}                                              ║
║     🖥  PC 端 B 端工作台     http://localhost:3000                  ║
║     📱 B 端移动（手机壳）     http://localhost:3001                  ║
║     📱 C 端 AI 服务前台      http://localhost:3002                  ║
║                                                                    ║
║  📖 能力导览（人类版）：docs/capabilities.auto.md                   ║
║  🎞  能力导览 PPT：docs/capability-tour.pptx                        ║
║  🤖 AI Coding Agent：请先读 AGENTS.md 与 .ai-prompt                 ║
╚══════════════════════════════════════════════════════════════════╝${C.rst}
`);
