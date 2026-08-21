/**
 * 创意主题生成器测试脚本
 * v2.1.7: 验证整合效果
 */

const { CreativeThemeGenerator } = require('../skills/creative-theme-generator');

async function runTests() {
  console.log('🧪 创意主题生成器测试开始\n');
  
  const generator = new CreativeThemeGenerator();
  
  // 测试1: 自然语言描述
  console.log('--- 测试1: 自然语言描述 ---');
  const result1 = await generator.generate('我想拍一个医疗急救的视频，要有紧张感，时长50秒');
  console.log('类型:', result1.tasks[0].type);
  console.log('主题:', result1.tasks[0].theme);
  console.log('时长:', result1.tasks[0].duration_sec);
  console.log('情绪:', result1.tasks[0].tone);
  console.log('质量检查:', result1.quality.passed, '/', result1.quality.total);
  console.log();
  
  // 测试2: 单个关键词
  console.log('--- 测试2: 单个关键词 ---');
  const result2 = await generator.generate('火星沙尘暴');
  console.log('类型:', result2.tasks[0].type);
  console.log('主题:', result2.tasks[0].theme);
  console.log('时长:', result2.tasks[0].duration_sec);
  console.log();
  
  // 测试3: 随机请求
  console.log('--- 测试3: 随机请求 ---');
  const result3 = await generator.generate('随便来一个');
  console.log('类型:', result3.tasks[0].type);
  console.log('主题:', result3.tasks[0].theme);
  console.log('时长:', result3.tasks[0].duration_sec);
  console.log();
  
  // 测试4: 部分字段
  console.log('--- 测试4: 部分字段 ---');
  const result4 = await generator.generate('我想拍武侠片，要热血的，有挑战性的');
  console.log('类型:', result4.tasks[0].type);
  console.log('主题:', result4.tasks[0].theme);
  console.log('情绪:', result4.tasks[0].tone);
  console.log('难度:', result4.tasks[0].difficulty);
  console.log();
  
  // 测试5: 生成确认摘要
  console.log('--- 测试5: 确认摘要 ---');
  const summary = generator.generateConfirmationSummary(result1);
  console.log(summary);
  
  console.log('✅ 所有测试完成');
}

runTests().catch(console.error);
