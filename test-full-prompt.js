// 测试ScriptGenerator完整prompt
const { LLMEngine } = require('../systems/llm-reasoning-engine');

async function test() {
  const engine = new LLMEngine({model: 'kimi-k2p6', timeoutMs: 600000});
  
  // 读取ScriptGenerator的实际prompt
  const fs = require('fs');
  const prompt = fs.readFileSync('./test-long-prompt.js', 'utf8')
    .match(/const prompt = \`([\s\S]*?)\`;/)?.[1] || '';
  
  console.log('[TEST] Prompt长度:', prompt.length);
  console.log('[TEST] 完整prompt测试（timeout=10分钟）...');
  
  try {
    const start = Date.now();
    const result = await engine.generate(prompt, {
      maxTokens: 8192,
      timeoutMs: 600000,
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
