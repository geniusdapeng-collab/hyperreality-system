// 最小化系统链路测试
const path = require('path');
const { LLMEngine } = require('../systems/llm-reasoning-engine');

async function testFullPipeline() {
  console.log('[TEST] 开始最小化系统链路测试...');
  
  // 模拟ScriptGenerator的调用
  const engine = new LLMEngine({
    model: 'kimi-k2p6',
    timeoutMs: 60000,
    maxRetries: 1
  });
  
  // 模拟一个简单的剧本生成prompt
  const prompt = `生成一个60秒宣传片剧本，关于AI视频制作系统。
要求：
1. 从用户痛点出发
2. 包含开场、核心内容、结尾
3. 输出JSON格式

请输出以下格式的JSON：
{
  "title": "标题",
  "scenes": [
    {"id": "SC01", "content": "场景内容", "duration": 10}
  ]
}`;

  try {
    console.log('[TEST] 调用LLM生成剧本...');
    const start = Date.now();
    const result = await engine.generate(prompt, {
      systemPrompt: '你是一位专业的AI视频编剧。只输出严格格式的JSON。',
      maxTokens: 4000,
      timeoutMs: 60000,
      forceJson: true,
      allowReasoningFallback: false
    });
    console.log('[TEST] 调用成功，耗时:', (Date.now()-start)/1000, '秒');
    console.log('[TEST] content长度:', result.content?.length || 0);
    console.log('[TEST] content前200字符:', result.content?.substring(0, 200));
  } catch (err) {
    console.error('[TEST] 错误:', err.message);
  }
}

testFullPipeline();
