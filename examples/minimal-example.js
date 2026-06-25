/**
 * Hyperreal AI Video System (HAVS) — 最小可运行示例
 * 
 * 本示例展示如何使用 HAVS 创建一个简单的 AI 视频预生产任务。
 * 请将 .env.example 复制为 .env 并填入你的 API Key。
 */

const { HyperrealitySystem } = require('./index');

async function main() {
  // 1. 初始化系统
  const system = new HyperrealitySystem({
    version: 'v1.0.0'
  });

  // 2. 准备角色配置（示例角色，非真实人物）
  const characters = [{
    name: '主讲人A',
    description: '专业的健康科普讲师，穿正装，形象亲和',
    referencePhotos: []
  }];

  // 3. 定义创作意图
  const intent = '创作一集健康科普短视频，主题：常见运动损伤的预防与处理。' +
    '创意指数0.6，视频时长45-60秒，全写实风格，好莱坞纪录片质感。' +
    '主讲人一人完成讲解，讲解过程生动形象，带有自然的肢体语言。';

  // 4. 定义元数据
  const metadata = {
    title: '运动损伤预防科普',
    target_duration: 55,
    series: '健康生活系列',
    episode: 1,
    characters: characters
  };

  // 5. 执行预生产（含需求确认 → 提示词审核 → 渲染 → 后期）
  try {
    const result = await system.create(intent, metadata, {
      skipPromptReview: false,  // 开启提示词审核
      skipRender: false,        // 开启渲染
      skipPostProduction: false // 开启后期制作
    });

    console.log('\n✅ 预生产完成！');
    console.log('结果:', JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('❌ 预生产失败:', error.message);
    process.exit(1);
  }
}

// 运行示例
if (require.main === module) {
  main();
}

module.exports = { main };
