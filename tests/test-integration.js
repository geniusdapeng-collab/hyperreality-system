// hyperreality-system/tests/test-integration.js
// 深度融合测试 - 从意图到完整镜头
// 运行: node hyperreality-system/tests/test-integration.js

const { HyperrealitySystem } = require('../index');

console.log('========================================');
console.log('  超现实系统 - 深度融合测试 v1.0');
console.log('========================================\n');

const results = {
  passed: 0,
  failed: 0
};

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ ${message}`);
    results.passed++;
  } else {
    console.log(`  ❌ ${message}`);
    results.failed++;
  }
}

async function runTest() {
  // 初始化系统
  const system = new HyperrealitySystem({
    scriptEngine: {
      // 不提供 API Key，使用模板模式
    }
  });

  console.log('🔥 [测试] 完整创作流程');
  console.log('----------------------------------------\n');

  // 执行创作（跳过确认环节，便于测试）
  const result = await system.create(
    '创作示例系列第一集，主角示例神兽，120秒，示例世界星球，示例角色探索',
    {
      title: '神话项目：异兽志 EP01 示例神兽',
      target_duration: 120,
      world_setting: '示例世界',
      featured_beast_id: 'taotie',
      protagonist: '示例角色'
    },
    {
      skipScriptConfirmation: true,  // 跳过剧本确认（测试模式）
      skipPromptReview: true,         // 跳过提示词审核（测试模式）
      skipRender: true                // 跳过渲染（测试模式）
    }
  );

  console.log('\n----------------------------------------');
  console.log('📊 结果验证');
  console.log('----------------------------------------');

  // 1. 整体成功
  assert(result.success, '整体流程成功');

  // 2. 剧本引擎阶段
  assert(result.stages.scriptEngine, '剧本引擎阶段存在');
  assert(result.stages.scriptEngine.blueprint, '剧本蓝图已生成');
  assert(result.stages.scriptEngine.validation, '剧本校验已执行');
  assert(result.stages.scriptEngine.timing > 0, '剧本引擎有耗时');

  // 3. 制作引擎阶段
  assert(result.stages.productionEngine, '制作引擎阶段存在');
  assert(result.stages.productionEngine.shots, '镜头已生成');
  assert(result.stages.productionEngine.prompts, 'Prompts 已生成');
  assert(result.stages.productionEngine.timing > 0, '制作引擎有耗时');

  // 4. 确认环节
  assert(result.confirmations.script, '剧本确认环节已执行');
  assert(result.confirmations.script.approved, '剧本已确认通过');
  assert(result.confirmations.prompts, '提示词审核环节已执行');
  assert(result.confirmations.prompts.approved, '提示词已确认通过');

  // 5. 渲染引擎（已跳过）
  assert(result.stages.renderingEngine, '渲染阶段存在');
  assert(result.stages.renderingEngine.skipped, '渲染已跳过（测试模式）');

  // 6. 镜头数量
  const shots = result.stages.productionEngine.shots;
  assert(shots.length > 0, `有 ${shots.length} 个镜头`);
  assert(shots.length >= 5, `至少 5 个镜头（实际: ${shots.length}）`);

  // 5. Prompts 数量
  const prompts = result.stages.productionEngine.prompts;
  assert(prompts.length === shots.length, 'Prompts 数量等于镜头数量');

  // 6. 每个镜头验证
  for (let i = 0; i < shots.length; i++) {
    const shot = shots[i];
    const prompt = prompts[i];

    assert(shot, `镜头 ${i} 存在`);
    assert(shot.shotId, `镜头 ${i} 有 ID: ${shot.shotId}`);
    assert(shot.sceneType, `镜头 ${i} 有类型: ${shot.sceneType}`);
    assert(shot.timing, `镜头 ${i} 有 timing 对象`);
    assert(shot.timing.duration > 0, `镜头 ${i} 时长 > 0: ${shot.timing?.duration}s`);
    assert(prompt, `镜头 ${i} 有对应的 Prompt 对象`);
    assert(prompt.prompt, `镜头 ${i} 有 Prompt 文本`);
    assert(prompt.length > 0, `镜头 ${i} Prompt 长度 > 0: ${prompt.length}`);
  }

  // 7. 总时长
  const totalDuration = shots.reduce((sum, s) => sum + s.timing.duration, 0);
  assert(totalDuration > 0, `总时长 > 0: ${totalDuration}s`);

  // 8. 质量门
  const quality = result.stages.productionEngine.quality;
  if (quality) {
    assert(quality.totalPrompts > 0, `质量门检查 ${quality.totalPrompts} 个 Prompt`);
  }

  // 9. 最终报告
  assert(result.finalReport, '最终报告已生成');
  assert(result.finalReport.includes('超现实工业创作系统'), '报告包含系统名称');
  assert(result.finalReport.includes('镜头总览'), '报告包含镜头总览');
  assert(result.finalReport.includes('完整 Prompts'), '报告包含完整 Prompts');

  // 10. 耗时
  assert(result.timing.total > 0, `总耗时 > 0: ${result.timing.total}ms`);

  // 打印详细信息
  console.log('\n----------------------------------------');
  console.log('📋 详细数据');
  console.log('----------------------------------------');
  console.log(`  镜头数: ${shots.length}`);
  console.log(`  总时长: ${totalDuration}s`);
  console.log(`  剧本耗时: ${result.stages.scriptEngine.timing}ms`);
  console.log(`  制作耗时: ${result.stages.productionEngine.timing}ms`);
  console.log(`  总耗时: ${result.timing.total}ms`);
  console.log(`  平均Prompt长度: ${Math.round(prompts.reduce((s, p) => s + p.length, 0) / prompts.length)} 字符`);

  // 打印前2个镜头
  console.log('\n  前2个镜头预览:');
  for (let i = 0; i < Math.min(2, shots.length); i++) {
    console.log(`\n  [${shots[i].shotId}] ${shots[i].sceneType} (${shots[i].timing.duration}s)`);
    console.log(`  Prompt: ${prompts[i].prompt.substring(0, 100)}...`);
    console.log(`  长度: ${prompts[i].length} 字符`);
  }

  // 保存结果
  try {
    const fs = require('fs');
    const path = require('path');
    const outputDir = process.env.TEST_OUTPUT_DIR || './output/tests/hyperreality-test';
    
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    
    const resultPath = path.join(outputDir, `test-result-${timestamp}.json`);
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
    
    // v2.1.5-fix: 写入验证
    if (!fs.existsSync(resultPath)) {
      console.error(`❌ 结果文件写入后不存在: ${resultPath}`);
    } else {
      const stats = fs.statSync(resultPath);
      if (stats.size === 0) {
        console.error(`❌ 结果文件写入后大小为0: ${resultPath}`);
      }
    }
    
    if (result.finalReport) {
      const reportPath = path.join(outputDir, `test-report-${timestamp}.md`);
      fs.writeFileSync(reportPath, result.finalReport);
      
      // v2.1.5-fix: 写入验证
      if (!fs.existsSync(reportPath)) {
        console.error(`❌ 报告文件写入后不存在: ${reportPath}`);
      } else {
        const stats = fs.statSync(reportPath);
        if (stats.size === 0) {
          console.error(`❌ 报告文件写入后大小为0: ${reportPath}`);
        }
      }
    }
    
    console.log(`\n💾 测试结果已保存到: ${outputDir}`);
  } catch (e) {
    console.log(`\n⚠️ 保存失败: ${e.message}`);
  }

  // 汇总
  console.log('\n========================================');
  console.log('  测试完成');
  console.log('========================================');
  console.log(`  ✅ 通过: ${results.passed}`);
  console.log(`  ❌ 失败: ${results.failed}`);
  console.log(`  📊 总计: ${results.passed + results.failed}`);
  console.log(`  🎯 成功率: ${Math.round((results.passed / (results.passed + results.failed)) * 100)}%`);
  console.log('========================================');

  if (results.failed > 0) {
    process.exit(1);
  } else {
    console.log('\n🎉 深度融合测试全部通过！双链路协同工作正常。\n');
    process.exit(0);
  }
}

runTest().catch(err => {
  console.error('\n❌ 测试异常:', err.message);
  console.error(err.stack);
  process.exit(1);
});
