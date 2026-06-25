// ============================================================
// 超现实系统 - 标准调用示例
// 用法：直接调用 HyperrealitySystem.create()
// 不需要额外的包装脚本
// ============================================================

const { HyperrealitySystem } = require('./index');
const fs = require('fs');
const path = require('path');

// 加载配置（从标准配置文件读取）
function loadConfig() {
  const configPath = path.join(process.env.HOME || '/root', '.openclaw/config/volcengine.json');
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return {
      apiKey: process.env.VOLCENGINE_ARK_API_KEY || "YOUR_API_KEY_HERE",
      baseUrl: config.baseUrl
    };
  } catch (e) {
    console.warn('⚠️ 无法读取配置文件:', e.message);
    return { apiKey: null, baseUrl: null };
  }
}

const config = loadConfig();

// 创建系统实例（传入正确配置）
const system = new HyperrealitySystem({
  scriptEngine: {
    scriptGenerator: {
      apiKey: process.env.VOLCENGINE_ARK_API_KEY || "YOUR_API_KEY_HERE"
    }
  }
});

// 示例：健康科普视频
const intent = '示例警官，讲解横纹肌溶解的症状以及实验室检查';
const metadata = {
  title: '横纹肌溶解的症状以及实验室检查',
  target_duration: 62
};

// 选项说明：
// - skipRequirementConfirmation: false = 需要队长确认需求清单
// - skipScriptConfirmation: false = 需要队长确认剧本
// - skipPromptReview: false = 需要队长确认提示词
// - skipRender: true = 跳过渲染（预生产模式）
// - skipPostProduction: true = 跳过后期（预生产模式）
const options = {
  skipRequirementConfirmation: false,  // 需求清单确认 - 不跳过
  skipScriptConfirmation: false,       // 剧本确认 - 不跳过
  skipPromptReview: false,             // 提示词审核 - 不跳过
  skipRender: true,                    // 渲染 - 跳过（预生产）
  skipPostProduction: true             // 后期 - 跳过（预生产）
};

async function run() {
  try {
    const result = await system.create(intent, metadata, options);
    
    if (result.success) {
      console.log('\n✅ 预生产完成！');
      console.log('总耗时:', result.timing?.total, 'ms');
      console.log('需求清单:', result.stages.requirementList ? '已生成' : '未生成');
      console.log('剧本:', result.stages.scriptEngine ? '已生成' : '未生成');
      console.log('镜头:', result.stages.productionEngine ? '已生成' : '未生成');
    } else {
      console.log('\n❌ 预生产失败:', result.errors?.join(', '));
    }
  } catch (err) {
    console.error('❌ 执行错误:', err.message);
  }
}

run();
