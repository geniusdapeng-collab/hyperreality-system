#!/usr/bin/env node
/**
 * setup-version-check.js — 一键配置版本号自动校验
 * 运行后会在 .git/hooks/pre-commit 中注入版本检查
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOOK_PATH = path.join(ROOT, '.git', 'hooks', 'pre-commit');
const CHECK_SCRIPT = 'node scripts/version-check.js --pre-commit';

function main() {
  console.log('🔧 [SetupVersionCheck] 配置 Git Pre-Commit Hook...\n');

  // 检查是否在 git 仓库中
  if (!fs.existsSync(path.join(ROOT, '.git'))) {
    console.error('⛔ 当前目录不是 Git 仓库，无法配置 hook');
    process.exit(1);
  }

  let existing = '';
  if (fs.existsSync(HOOK_PATH)) {
    existing = fs.readFileSync(HOOK_PATH, 'utf-8');
    // 已配置则跳过
    if (existing.includes('version-check.js')) {
      console.log('✅ 版本检查已配置，无需重复');
      process.exit(0);
    }
  }

  // 追加或创建 hook
  const hookContent = existing
    ? `${existing.trim()}\n\n# ⭐ SuperMickey 版本号一致性检查（auto-injected by setup-version-check.js）\n${CHECK_SCRIPT}\n`
    : `#!/bin/sh\n# ⭐ SuperMickey 版本号一致性检查\n${CHECK_SCRIPT}\n`;

  fs.writeFileSync(HOOK_PATH, hookContent);
  fs.chmodSync(HOOK_PATH, 0o755);

  console.log('✅ 已配置 pre-commit hook');
  console.log(`   路径: ${HOOK_PATH}`);
  console.log(`   命令: ${CHECK_SCRIPT}`);
  console.log('\n📋 效果：每次 git commit 前自动检查版本号一致性');
  console.log('   不一致时会阻止提交，运行 `node scripts/version-check.js --fix` 可自动修复');
}

main();
