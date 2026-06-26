// 测试systemPrompt是否导致卡住
const { LLMEngine } = require('../systems/llm-reasoning-engine');

async function test() {
  const engine = new LLMEngine({model: 'kimi-k2p6', timeoutMs: 300000});
  
  const prompt = `你是一位顶级短视频编剧。为"超写实系统宣传片"创作60秒剧本。
要求：
1. 从用户痛点出发
2. 创始人李大鹏亲自出镜
3. 片尾反身性彩蛋
4. 输出JSON格式，包含title, acts, scenes
5. 每个场景包含dialogue
6. 总时长=60秒

请直接输出JSON，不要任何其他文字。`;

  console.log('[TEST] Prompt长度:', prompt.length);
  console.log('[TEST] 使用systemPrompt调用...');
  
  try {
    const start = Date.now();
    const result = await engine.generate(prompt, {
      systemPrompt: '你是一位专业的AI视频编剧。只输出严格格式的JSON，不要markdown代码块，不要解释，不要思考过程。使用最紧凑的JSON格式（不要换行和缩进）。',
      maxTokens: 8192,
      timeoutMs: 300000,
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
