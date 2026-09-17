#!/usr/bin/env node
/**
 * Preflight Check — 运行前预检
 * 用法: node scripts/preflight_check.js [repoRoot]
 */
const fs = require('fs');
const path = require('path');

const repo = process.argv[2] || path.join(__dirname, '..');
let failures = 0;

function log(icon, msg) {
  console.log(`${icon}  ${msg}`);
}

// 技能索引新鲜度检查：skills-index.json 必须新于最新技能文件
(function checkSkillIndex() {
  const dir = path.join(repo, 'hyperreality-system', 'skills', '好莱坞工业电影技能工厂', '技能系列', '镜头级专项');
  const idx = path.join(repo, 'hyperreality-system', 'skills', 'hollywood-cinematography', 'skills-index.json');
  if (!fs.existsSync(dir)) {
    log('⚠️', '技能库目录不存在，将运行在无技能模式');
    return;
  }
  const mdFiles = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
  if (mdFiles.length === 0) {
    log('⚠️', '技能库为空');
    return;
  }
  const newestSkill = Math.max(...mdFiles.map(f => fs.statSync(path.join(dir, f)).mtimeMs));
  if (!fs.existsSync(idx) || fs.statSync(idx).mtimeMs < newestSkill) {
    log('❌', '技能索引过期或缺失——运行 node scripts/build-skill-index.js 重建');
    failures++;
  } else {
    const data = JSON.parse(fs.readFileSync(idx, 'utf8'));
    log('✅', `技能索引正常（${data.count} 个技能）`);
  }
})();

if (failures > 0) {
  console.log(`\n❌ Preflight 失败: ${failures} 项未通过`);
  process.exit(1);
} else {
  console.log('\n✅ Preflight 全部通过');
  process.exit(0);
}
