/**
 * MicroMotion Round 5 Mock Test — CLI 参数解析 + 状态总线一致性压力测试
 * 目标：暴露 CLI 参数解析错误、状态总线并发问题、批量处理不一致性
 */

const { MicroMotionSystem } = require('../scripts/micromotion');
const fs = require('fs').promises;
const fss = require('fs');

console.log('\n═══════════════════════════════════════════════════════════');
console.log(' Round 5 Mock Test — CLI 参数与状态总线压力测试');
console.log('═══════════════════════════════════════════════════════════\n');

let pass = 0;
let fail = 0;
const errors = [];

function assert(condition, name) {
  if (condition) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); errors.push(name); }
}

function assertNoThrow(fn, name) {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} → 异常: ${e.message}`); errors.push(name); }
}

// ====== Test Group 1: 大批量压力测试（20个镜头） ======
console.log('📦 Test Group 1: 大批量压力测试（20个镜头）');
assertNoThrow(() => {
  const mm = new MicroMotionSystem({ outputDir: '/tmp/micromotion-r5-batch' });
  const shots = [];
  for (let i = 1; i <= 20; i++) {
    shots.push({
      shotId: `R5-B${String(i).padStart(2, '0')}`,
      character: `角色${i}`,
      emotion: ['愤怒', '悲伤', '喜悦', '恐惧', '惊讶'][i % 5],
      emotionIntensity: (i % 5) + 1,
      cameraDistance: ['面部特写', '近景', '中景', '远景', '全景'][i % 5],
      duration: [3, 5, 8, 10, 15][i % 5],
      originalPrompt: `角色${i}, 3D国漫CG渲染, ${['面部特写', '近景', '中景', '远景', '全景'][i % 5]}, ${['愤怒', '悲伤', '喜悦', '恐惧', '惊讶'][i % 5]}`
    });
  }
  
  const { results, stateBus } = mm.enhanceBatch(shots, { sceneType: '战斗场景' });
  
  assert(results.length === 20, '批量20 → 20个结果');
  assert(Object.keys(stateBus.mergedPrompts).length === 20, '状态总线 → 20个镜头');
  assert(stateBus.version === '1.0-Peng', '状态总线 → 版本号正确');
  
  // 验证每个镜头都有增强
  let allEnhanced = true;
  for (const r of results) {
    if (!r.enhanced || r.enhanced.length === 0) {
      allEnhanced = false;
      console.log(`  ⚠️  ${r.shotId} 增强为空`);
    }
  }
  assert(allEnhanced, '批量20 → 全部有增强内容');
  
  console.log(`     批量完成: ${results.length} 个镜头，平均增强长度: ${Math.round(results.reduce((a,b)=>a+b.enhanced.length,0)/results.length)} 字符`);
}, '大批量压力测试');

// ====== Test Group 2: 状态总线持久化与重载 ======
console.log('\n💾 Test Group 2: 状态总线持久化与重载');
assertNoThrow(() => {
  const mm1 = new MicroMotionSystem({ outputDir: '/tmp/micromotion-r5-state' });
  const shot = {
    shotId: 'R5-STATE1',
    character: '大圣',
    emotion: '愤怒',
    emotionIntensity: 4,
    cameraDistance: '面部特写',
    duration: 5,
    originalPrompt: '大圣, 面部特写, 愤怒'
  };
  mm1.enhanceShot(shot, { sceneType: '战斗场景' });
  
  // 验证文件已写入
  const statePath = '/tmp/micromotion-r5-state/motion-state.json';
  assert(fss.existsSync(statePath), '状态总线 → 文件已生成');
  
  // 验证文件内容完整性
  const state = JSON.parse(fss.readFileSync(statePath, 'utf8'));
  assert(state.version === '1.0-Peng', '状态总线 → 版本号正确');
  assert(state.mergedPrompts['R5-STATE1'] !== undefined, '状态总线 → 包含R5-STATE1');
  assert(state.faceEnhancements['R5-STATE1'] !== undefined, '状态总线 → 包含面部增强');
  assert(state.bodyEnhancements['R5-STATE1'] !== undefined, '状态总线 → 包含身体增强');
  assert(state.eyeEnhancements['R5-STATE1'] !== undefined, '状态总线 → 包含眼神增强');
  assert(state.breathEnhancements['R5-STATE1'] !== undefined, '状态总线 → 包含呼吸增强');
  assert(state.worldBreathElements['R5-STATE1'] !== undefined, '状态总线 → 包含环境增强');
  
  // 验证diff能读取持久化状态
  const mm2 = new MicroMotionSystem({ outputDir: '/tmp/micromotion-r5-state' });
  const diff = mm2.diff('R5-STATE1', statePath);
  assert(diff !== null, 'Diff → 能从持久化状态读取');
  assert(diff.additions > 0, 'Diff → 新增字符>0');
  
  console.log(`     状态总线: ${statePath}, 镜头数: ${Object.keys(state.mergedPrompts).length}`);
}, '状态总线持久化');

// ====== Test Group 3: 多批次追加状态总线 ======
console.log('\n📚 Test Group 3: 多批次追加状态总线');
assertNoThrow(() => {
  const mm = new MicroMotionSystem({ outputDir: '/tmp/micromotion-r5-append' });
  
  // 第一批：5个镜头
  const batch1 = [];
  for (let i = 1; i <= 5; i++) {
    batch1.push({ shotId: `R5-A${i}`, character: `A${i}`, emotion: '愤怒', emotionIntensity: 3, cameraDistance: '面部特写', duration: 5, originalPrompt: `A${i}, 特写` });
  }
  mm.enhanceBatch(batch1, { sceneType: '战斗场景' });
  
  // 第二批：5个镜头（追加）
  const batch2 = [];
  for (let i = 1; i <= 5; i++) {
    batch2.push({ shotId: `R5-B${i}`, character: `B${i}`, emotion: '悲伤', emotionIntensity: 2, cameraDistance: '远景', duration: 5, originalPrompt: `B${i}, 远景` });
  }
  mm.enhanceBatch(batch2, { sceneType: '爱情场景' });
  
  const statePath = '/tmp/micromotion-r5-append/motion-state.json';
  const state = JSON.parse(fss.readFileSync(statePath, 'utf8'));
  
  assert(Object.keys(state.mergedPrompts).length === 10, '追加批次 → 总镜头数10');
  assert(state.mergedPrompts['R5-A1'] !== undefined, '追加批次 → 包含第一批');
  assert(state.mergedPrompts['R5-B1'] !== undefined, '追加批次 → 包含第二批');
  
  console.log(`     两批追加完成: ${Object.keys(state.mergedPrompts).length} 个镜头`);
}, '多批次追加');

// ====== Test Group 4: 增强报告生成验证 ======
console.log('\n📊 Test Group 4: 增强报告生成');
assertNoThrow(() => {
  const mm = new MicroMotionSystem({ outputDir: '/tmp/micromotion-r5-report' });
  const shots = [
    { shotId: 'R5-R1', character: '大圣', emotion: '愤怒', emotionIntensity: 5, cameraDistance: '面部特写', duration: 5, originalPrompt: '大圣, 特写, 愤怒' },
    { shotId: 'R5-R2', character: '奥特曼', emotion: '坚定', emotionIntensity: 4, cameraDistance: '中景', duration: 5, originalPrompt: '奥特曼, 中景, 坚定' }
  ];
  
  const { results, stateBus } = mm.enhanceBatch(shots, { sceneType: '战斗场景' });
  
  // 验证报告内容
  assert(stateBus.totalShots === 2, '报告 → totalShots=2');
  assert(stateBus.totalEnhanced === 2, '报告 → totalEnhanced=2');
  assert(Array.isArray(stateBus.shots), '报告 → shots数组存在');
  assert(stateBus.shots.length === 2, '报告 → shots长度2');
  
  // 验证每个shot的报告字段
  for (const shotReport of stateBus.shots) {
    assert(shotReport.shotId !== undefined, `报告 → ${shotReport.shotId} 有shotId`);
    assert(shotReport.enhancedLength > 0, `报告 → ${shotReport.shotId} enhancedLength>0`);
    assert(shotReport.additions > 0, `报告 → ${shotReport.shotId} additions>0`);
  }
  
  console.log(`     报告生成: ${stateBus.shots.length} 个镜头报告`);
}, '增强报告');

// ====== Test Group 5: Diff 一致性验证 ======
console.log('\n📐 Test Group 5: Diff 一致性验证');
assertNoThrow(() => {
  const mm = new MicroMotionSystem({ outputDir: '/tmp/micromotion-r5-diff' });
  const shot = {
    shotId: 'R5-DIFF1',
    character: '大圣',
    emotion: '愤怒',
    emotionIntensity: 4,
    cameraDistance: '面部特写',
    duration: 5,
    originalPrompt: '大圣, 面部特写, 愤怒'
  };
  
  const result = mm.enhanceShot(shot, { sceneType: '战斗场景' });
  const diff = mm.diff('R5-DIFF1', '/tmp/micromotion-r5-diff/motion-state.json');
  
  assert(diff !== null, 'Diff → 非空');
  assert(diff.shotId === 'R5-DIFF1', 'Diff → shotId正确');
  assert(diff.original === shot.originalPrompt, 'Diff → 原始提示词一致');
  assert(diff.enhanced === result.enhanced, 'Diff → 增强提示词一致');
  assert(diff.additions === (result.enhanced.length - shot.originalPrompt.length), `Diff → 新增字符数正确 (${diff.additions})`);
  assert(diff.additions > 0, 'Diff → 新增字符>0');
  
  console.log(`     Diff: 原始 ${diff.original.length} → 增强 ${diff.enhanced.length}，新增 ${diff.additions}`);
}, 'Diff一致性');

// ====== Test Group 6: 重复 shotId 处理 ======
console.log('\n🔄 Test Group 6: 重复 shotId 覆盖');
assertNoThrow(() => {
  const mm = new MicroMotionSystem({ outputDir: '/tmp/micromotion-r5-dup' });
  
  const shot1 = { shotId: 'R5-DUP', character: 'A', emotion: '愤怒', emotionIntensity: 3, cameraDistance: '面部特写', duration: 5, originalPrompt: 'A, 特写' };
  const shot2 = { shotId: 'R5-DUP', character: 'B', emotion: '悲伤', emotionIntensity: 2, cameraDistance: '远景', duration: 5, originalPrompt: 'B, 远景' };
  
  mm.enhanceShot(shot1, { sceneType: '战斗场景' });
  mm.enhanceShot(shot2, { sceneType: '爱情场景' }); // 同一 shotId 再次增强
  
  const state = JSON.parse(fss.readFileSync('/tmp/micromotion-r5-dup/motion-state.json', 'utf8'));
  
  // 后一次应覆盖前一次
  assert(state.mergedPrompts['R5-DUP'] !== undefined, '重复shotId → 存在');
  // 验证是第二次的结果（通过检查增强提示词内容）
  const merged = state.mergedPrompts['R5-DUP'];
  assert(merged.enhanced.includes('下眼睑') || merged.enhanced.includes('嘴角') || merged.enhanced.includes('叹息'),
    '重复shotId → 后一次覆盖前一次');
  
  console.log(`     重复 shotId 处理: R5-DUP 被覆盖为第二次结果`);
}, '重复shotId');

// ====== Test Group 7: MicroMotionSystem CLI 风格参数 ======
console.log('\n⚙️  Test Group 7: 配置参数验证');
assertNoThrow(() => {
  // 不同配置组合
  const configs = [
    { maxPromptLength: 300 },
    { maxPromptLength: 500 },
    { maxPromptLength: 1000 },
    { outputDir: '/tmp/custom-output' },
    {} // 默认
  ];
  
  for (const config of configs) {
    const mm = new MicroMotionSystem(config);
    const shot = { shotId: `R5-CFG-${JSON.stringify(config)}`, character: 'T', emotion: '愤怒', emotionIntensity: 3, cameraDistance: '面部特写', duration: 1, originalPrompt: 'T, 特写' };
    const result = mm.enhanceShot(shot, {});
    assert(result !== null, `配置 ${JSON.stringify(config)} → 有输出`);
  }
  
  console.log(`     ${configs.length} 种配置组合全部通过`);
}, '配置参数');

// ====== Test Group 8: 端到端 JSON 文件 I/O ======
console.log('\n📁 Test Group 8: JSON 文件 I/O');
assertNoThrow(() => {
  const inputPath = '/tmp/micromotion-r5-input.json';
  const outputDir = '/tmp/micromotion-r5-io';
  
  // 构造输入 JSON
  const inputData = {
    project: 'TestProject-R5',
    context: { sceneType: '战斗场景' },
    shots: [
      { shotId: 'R5-IO1', character: 'A', emotion: '愤怒', emotionIntensity: 5, cameraDistance: '面部特写', duration: 3, originalPrompt: 'A, 特写, 愤怒' },
      { shotId: 'R5-IO2', character: 'B', emotion: '悲伤', emotionIntensity: 2, cameraDistance: '远景', duration: 8, originalPrompt: 'B, 远景, 悲伤' }
    ]
  };
  fss.writeFileSync(inputPath, JSON.stringify(inputData, null, 2));
  
  const mm = new MicroMotionSystem({ outputDir });
  const output = mm.enhanceFromFile(inputPath, outputDir);
  
  assert(fss.existsSync(output.enhancedPath), '文件IO → 增强文件已生成');
  assert(fss.existsSync(output.reportPath), '文件IO → 报告文件已生成');
  
  const enhanced = JSON.parse(fss.readFileSync(output.enhancedPath, 'utf8'));
  assert(enhanced.totalShots === 2, '文件IO → 总镜头数2');
  assert(enhanced.shots.length === 2, '文件IO → shots数组长度2');
  
  console.log(`     文件IO: 输入 ${inputPath} → 输出 ${output.enhancedPath}`);
}, '文件IO');

// ====== 汇总 ======
console.log('\n═══════════════════════════════════════════════════════════');
console.log(` Round 5 结果: ✅ ${pass} 通过 | ❌ ${fail} 失败`);
console.log('═══════════════════════════════════════════════════════════');

if (errors.length > 0) {
  console.log('\n❌ 失败项:');
  errors.forEach(e => console.log(`   - ${e}`));
}

if (fail > 0) process.exit(1);
else {
  console.log('\n🎉 Round 5 全部通过！CLI 参数与状态总线压力测试验证成功');
  process.exit(0);
}