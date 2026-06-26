const { HyperrealitySystem } = require('../index');

// 标准调用 - 完整流程（含确认环节）
const system = new HyperrealitySystem();

async function run() {
  const result = await system.create(
    '示例警官，讲解横纹肌溶解的症状以及实验室检查',
    { title: '横纹肌溶解的症状以及实验室检查', target_duration: 62 },
    {
      skipRequirementConfirmation: false,  // 需要确认
      skipScriptConfirmation: false,         // 需要确认
      skipPromptReview: false,               // 需要确认
      skipRender: true,                      // 预生产：跳过渲染
      skipPostProduction: true               // 预生产：跳过后期
    }
  );
  
  console.log('\n=== 结果 ===');
  console.log('成功:', result.success);
  console.log('总耗时:', result.timing?.total, 'ms');
  console.log('需求清单确认:', result.confirmations?.requirementList);
  console.log('剧本确认:', result.confirmations?.script);
  console.log('提示词审核:', result.confirmations?.promptReview);
}

run().catch(console.error);
