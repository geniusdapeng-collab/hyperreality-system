const { HyperrealitySystem } = require('./index');

async function main() {
  console.log('[FINAL] 启动超写实系统宣传片完整预生产链路...');
  console.log('[FINAL] 时间:', new Date().toISOString());
  
  const system = new HyperrealitySystem({
    version: '2.1.5',
    skipRender: true,
    skipPostProduction: true,
    enablePromptReview: true,
    enableContinuityReview: true,
    creativeIntensity: 0.7
  });

  const input = {
    title: '超写实系统宣传片',
    description: '制作一个60秒宣传片，介绍我们的AI视频工业创作系统"超写实"。\n核心要求：\n1. 从用户视角出发，不是讲系统功能，而是讲用户痛点\n2. 用户痛点：写Prompt太难、成本太高（10万→500元）、时间太长（3个月→10分钟）、质量不稳定\n3. 创始人李大鹏亲自出镜讲解\n4. 片尾要有反身性彩蛋：点出本片也由超写实系统生成\n5. 风格：科技感、电影级质感、专业可信\n6. 情绪：从压抑→希望→震撼→行动号召',
    duration: 60,
    style: 'REAL',
    protagonist: '李大鹏',
    platform: ['官网', '社交媒体'],
    language: 'zh'
  };

  try {
    const result = await system.create(input);
    
    console.log('\n=== 最终结果 ===');
    console.log('状态:', result.status);
    console.log('降级:', result.degraded ? '是' : '否');
    if (result.degraded) {
      console.log('降级原因:', result.degradeReason);
    }
    
    if (result.prompts) {
      console.log('\n镜头数量:', result.prompts.length);
      result.prompts.forEach((p, i) => {
        console.log(`\n镜头 ${i+1}: ${p.shotId}`);
        console.log(`  Prompt长度: ${p.promptCharCount || 'N/A'}`);
        console.log(`  降级: ${p.degraded ? '是' : '否'}`);
      });
    }
    
    // 保存结果
    const fs = require('fs');
    fs.writeFileSync('output/prompts-promo-final.json', JSON.stringify(result, null, 2));
    console.log('\n✅ 结果已保存到 output/prompts-promo-final.json');
    
  } catch (error) {
    console.error('\n❌ 运行失败:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
