#!/usr/bin/env node
/**
 * skill-lifecycle-report.js — 技能生命周期遥测报表（B4 神经系统）
 *
 * 读取 logs/skill-usage/skill-usage.jsonl（phase-3 遥测落盘），产出：
 *   1. 控制台月报：开火率 / 墙纸率 / 类别分布 / 导演分布 / 路由分布
 *   2. skills-quarantine.json：连续零开火技能进入冷藏区（路由器默认排除）
 *   3. 供给缺口信号：哪类镜头长期墙纸注入，就补哪类技能
 *
 * 冷藏规则（保守）：累计运行 ≥20 次且技能 0 开火 → 冷藏。
 * 运行：node scripts/skill-lifecycle-report.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LOG = path.join(ROOT, 'logs', 'skill-usage', 'skill-usage.jsonl');
const LIB = path.join(ROOT, 'hyperreality-system', 'skills', '好莱坞工业电影技能工厂', '技能系列', '镜头级专项');
const QUAR_OUT = path.join(ROOT, 'hyperreality-system', 'skills', 'hollywood-cinematography', 'skills-quarantine.json');
const MIN_RUNS_FOR_QUARANTINE = 20;

function main() {
  if (!fs.existsSync(LOG)) {
    console.log('📭 尚无遥测数据（logs/skill-usage/skill-usage.jsonl 不存在）。');
    console.log('   跑一次生产任务后本报表即可产出真实数据。');
    // 无数据时清空冷藏，避免旧清单误伤
    if (fs.existsSync(QUAR_OUT)) fs.unlinkSync(QUAR_OUT);
    return;
  }

  const runs = fs.readFileSync(LOG, 'utf-8').trim().split('\n')
    .map(l => { try { return JSON.parse(l); } catch (e) { return null; } })
    .filter(Boolean);

  const fireCount = {};
  let totalShots = 0, wallpaperShots = 0, matchedShots = 0;
  const typeDist = {}, directorDist = {}, routerDist = {}, catFire = {};

  for (const run of runs) {
    totalShots += run.totalShots || 0;
    matchedShots += run.matchedShots || 0;
    wallpaperShots += (run.wallpaperShots || []).length;
    const d = run.filmDirector || '未选定';
    directorDist[d] = (directorDist[d] || 0) + 1;
    for (const shot of (run.perShot || [])) {
      if (shot.type) typeDist[shot.type] = (typeDist[shot.type] || 0) + 1;
      if (shot.router) routerDist[shot.router] = (routerDist[shot.router] || 0) + 1;
      for (const sk of (shot.skills || [])) {
        fireCount[sk.file] = (fireCount[sk.file] || 0) + 1;
        const cat = (sk.file || '').split('_')[0];
        catFire[cat] = (catFire[cat] || 0) + 1;
      }
    }
  }

  const allSkills = fs.existsSync(LIB) ? fs.readdirSync(LIB).filter(f => f.endsWith('.md')) : [];
  const zeroFire = allSkills.filter(f => !fireCount[f]);
  const quarantine = runs.length >= MIN_RUNS_FOR_QUARANTINE ? zeroFire : [];

  // 报表
  console.log('\n📊 技能生命周期报表');
  console.log(`  运行次数: ${runs.length}｜镜头总数: ${totalShots}｜命中率: ${totalShots ? (matchedShots / totalShots * 100).toFixed(1) : 0}%`);
  console.log(`  墙纸率: ${totalShots ? (wallpaperShots / totalShots * 100).toFixed(1) : 0}%（${wallpaperShots}/${totalShots}）`);
  console.log(`  技能开火: ${Object.keys(fireCount).length}/${allSkills.length}（${allSkills.length ? (Object.keys(fireCount).length / allSkills.length * 100).toFixed(1) : 0}%）`);
  console.log(`  类型分布: ${JSON.stringify(typeDist)}`);
  console.log(`  类别开火: ${JSON.stringify(catFire)}`);
  console.log(`  导演分布: ${JSON.stringify(directorDist)}`);
  console.log(`  路由分布: ${JSON.stringify(routerDist)}`);

  const top = Object.entries(fireCount).sort((a, b) => b[1] - a[1]).slice(0, 10);
  console.log('  开火 Top10:');
  top.forEach(([f, c]) => console.log(`    ${c}次  ${f}`));

  if (zeroFire.length > 0) {
    console.log(`  ❄️ 零开火技能: ${zeroFire.length} 个${runs.length < MIN_RUNS_FOR_QUARANTINE ? `（运行次数 <${MIN_RUNS_FOR_QUARANTINE}，暂不冷藏，仅观察）` : '（已冷藏）'}`);
  }

  // 供给缺口信号：墙纸镜头最多的类型 = 最该补技能的赛道
  const wallpaperByType = {};
  for (const run of runs) {
    const wallSet = new Set(run.wallpaperShots || []);
    for (const shot of (run.perShot || [])) {
      if (wallSet.has(shot.shotId) && shot.type) {
        wallpaperByType[shot.type] = (wallpaperByType[shot.type] || 0) + 1;
      }
    }
  }
  if (Object.keys(wallpaperByType).length > 0) {
    console.log(`  🕳️ 供给缺口（墙纸镜头类型分布）: ${JSON.stringify(wallpaperByType)}`);
  }

  // 冷藏清单落盘
  const q = { generated_at: new Date().toISOString(), runs: runs.length, rule: `≥${MIN_RUNS_FOR_QUARANTINE}次运行且零开火`, quarantine };
  fs.writeFileSync(QUAR_OUT, JSON.stringify(q, null, 2));
  console.log(`\n  冷藏清单已更新: ${path.relative(ROOT, QUAR_OUT)}（${quarantine.length} 个）`);
}

main();
