// 隔离测试：去掉systemPrompt
const { LLMEngine } = require('../systems/llm-reasoning-engine');

async function test() {
  const engine = new LLMEngine({model: 'kimi-k2p6', timeoutMs: 120000});
  
  const prompt = `你是一位顶级短视频编剧。为"超写实系统宣传片"创作60秒剧本。
要求：
1. 从用户痛点出发（写Prompt太难、成本太高、时间太长、质量不稳定）
2. 创始人李大鹏亲自出镜
3. 片尾反身性彩蛋
4. 输出JSON格式，包含title, acts, scenes
5. 每个场景包含dialogue（口语化台词，每句不超过30字）
6. 总时长严格等于60秒
7. 场景数量5-7个

请直接输出JSON，不要任何其他文字。`;

  console.log('[TEST] Prompt长度:', prompt.length);
  console.log('[TEST] 无systemPrompt, maxTokens=8192...');
  
  try {
    const start = Date.now();
    const result = await engine.generate(prompt, {
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
