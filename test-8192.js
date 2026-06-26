// 测试8192 maxTokens
const { LLMEngine } = require('../systems/llm-reasoning-engine');

async function test() {
  const engine = new LLMEngine({
    model: 'kimi-k2p6',
    timeoutMs: 120000
  });
  
  const prompt = `你是一位顶级短视频编剧。为"超写实系统宣传片"创作60秒剧本。输出JSON格式，包含title和scenes字段。`;

  console.log('[TEST] 使用maxTokens=8192调用...');
  
  try {
    const start = Date.now();
    const result = await engine.generate(prompt, {
      systemPrompt: '你是一位专业的AI视频编剧。只输出严格格式的JSON。',
      maxTokens: 8192,
      timeoutMs: 120000,
      forceJson: true,
      allowReasoningFallback: false
    });
    console.log('[TEST] 成功！耗时:', (Date.now()-start)/1000, '秒');
    console.log('[TEST] content长度:', result.content?.length || 0);
  } catch (err) {
    console.error('[TEST] 错误:', err.message);
  }
}

test();
