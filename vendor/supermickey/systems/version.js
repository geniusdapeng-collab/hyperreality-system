// systems/version.js
// SHANHAISTORY FORGE 系统版本标识
// 每次综合发布时更新此文件

const VERSION = {
  // 主版本号（综合发布版本）
  major: 'v7.0',
  // 子版本
  subVersions: {
    promptForge: 'v6.2-patch118',
    videoSpec: 'v4.1'
  },
  // 发布日期
  releaseDate: '2026-06-04',
  // 发布人
  releaseBy: '小G',
  // 包含的主要模块
  modules: [
    'PromptForge 技术修复（9项）',
    'v4.1 系统常量层（5模块）',
    'v4.1 Scene Card上游控制',
    'v4.1 Shot Card增强（完整字段）',
    'v4.1 Prompt模板升级（8步结构）',
    'v4.1 导演审片模块（六问+五维+阻断）'
  ],
  // 系统状态
  status: 'stable',
  // 向后兼容
  backwardCompatible: true
};

function printVersion() {
  console.log(`
╔══════════════════════════════════════════╗
║  SHANHAISTORY FORGE                      ║
║  ${VERSION.major}                              ║
╚══════════════════════════════════════════╝
  PromptForge: ${VERSION.subVersions.promptForge}
  VideoSpec:   ${VERSION.subVersions.videoSpec}
  Released:    ${VERSION.releaseDate}
  Status:      ${VERSION.status}
  `);
}

module.exports = { VERSION, printVersion };

if (require.main === module) {
  printVersion();
}
