#!/usr/bin/env node
/**
 * install-skill.js — SuperMickey Agent 技能安装器
 *
 * 把仓库内置的 supermickey-studio 技能复制到当前 Agent 平台的技能目录，
 * 让 Agent 可以通过触发词直接调用本系统的完整执行流程。
 *
 * 设计原则：
 * - 显式调用（npm run skill:install），绝不挂在 postinstall 上：
 *   向项目目录之外写文件必须经开发者明确发起，CI / --ignore-scripts /
 *   全局安装等场景才不会被意外污染或失败。
 * - 只复制，不修改目标目录中的任何其他文件；覆盖前自动备份旧版本。
 * - 找不到已知技能目录时不报错退出，打印手动安装指引。
 *
 * 用法：
 *   node scripts/install-skill.js                # 自动探测已知技能目录
 *   node scripts/install-skill.js --target <dir> # 指定技能父目录
 *   SUPERMICKEY_SKILL_DIR=<dir> node scripts/install-skill.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const SKILL_NAME = 'supermickey-studio';
const SKILL_SRC = path.join(ROOT, 'skill', SKILL_NAME);

function candidateDirs() {
  const dirs = [];
  const argIdx = process.argv.indexOf('--target');
  if (argIdx !== -1 && process.argv[argIdx + 1]) {
    dirs.push(path.resolve(process.argv[argIdx + 1]));
  }
  if (process.env.SUPERMICKEY_SKILL_DIR) {
    dirs.push(path.resolve(process.env.SUPERMICKEY_SKILL_DIR));
  }
  // Kimi Agent 技能目录
  dirs.push('/app/.user/skills');
  // Claude Code 技能目录
  dirs.push(path.join(os.homedir(), '.claude', 'skills'));
  return [...new Set(dirs)];
}

function installTo(skillsDir) {
  const dest = path.join(skillsDir, SKILL_NAME);
  fs.mkdirSync(skillsDir, { recursive: true });

  if (fs.existsSync(dest)) {
    const backup = `${dest}.backup-${Date.now()}`;
    fs.renameSync(dest, backup);
    console.log(`  📦 旧版本已备份: ${backup}`);
  }

  fs.cpSync(SKILL_SRC, dest, { recursive: true });
  console.log(`  ✅ 技能已安装: ${dest}`);
  return dest;
}

function main() {
  console.log('🔧 [SkillInstall] SuperMickey Agent 技能安装\n');

  if (!fs.existsSync(path.join(SKILL_SRC, 'SKILL.md'))) {
    console.error(`⛔ 技能源文件缺失: ${path.join(SKILL_SRC, 'SKILL.md')}`);
    process.exit(1);
  }

  const candidates = candidateDirs();
  const existing = candidates.filter(d => fs.existsSync(d));

  const targets = (process.argv.includes('--target') || process.env.SUPERMICKEY_SKILL_DIR)
    ? [candidates[0]]   // 显式指定：即使目录不存在也创建并安装
    : existing;

  if (targets.length === 0) {
    console.log('  未检测到已知 Agent 技能目录（/app/.user/skills、~/.claude/skills）。');
    console.log('  手动安装：把仓库内 skill/supermickey-studio/ 整个目录复制到你的 Agent 技能目录即可：\n');
    console.log(`    cp -r ${SKILL_SRC} <你的技能目录>/\n`);
    console.log('  或显式指定：node scripts/install-skill.js --target <你的技能目录>');
    process.exit(0);
  }

  const failures = [];
  for (const dir of targets) {
    try {
      installTo(dir);
    } catch (e) {
      // 单个目录失败（如只读文件系统）不应中断其余目标
      failures.push(`${dir}（${e.code || e.message}）`);
      console.warn(`  ⚠️ 安装到 ${dir} 失败: ${e.message}`);
    }
  }

  if (failures.length === targets.length) {
    console.error('\n⛔ 所有目标目录均安装失败（常见原因：目录只读或权限不足）。');
    console.error('   可改用 --target 指定可写目录，或手动复制 skill/supermickey-studio/。');
    process.exit(1);
  }
  if (failures.length > 0) {
    console.log(`\n  部分目录跳过: ${failures.join('；')}`);
  }

  console.log('\n🎉 安装完成。之后对你的 Agent 说"用 SuperMickey 系统生成视频提示词"即可触发。');
  console.log('   技能会克隆本仓库最新代码并以 agent-preflight 规范卡为唯一规范出口执行完整流水线。');
}

main();
