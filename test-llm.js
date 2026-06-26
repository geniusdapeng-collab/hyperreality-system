// 诊断脚本 - 测试LLM调用
const path = require('path');
const { LLMEngine } = require('../systems/llm-reasoning-engine');

async function test() {
  console.log('[TEST] 开始LLM调用诊断...');
  
  const engine = new LLMEngine({
    model: 'kimi-k2p6',
    timeoutMs: 120000,
    maxRetries: 1
  });
  
  console.log('[TEST] LLMEngine创建成功');
  
  try {
    console.log('[TEST] 调用generate...');
    const start = Date.now();
    const result = await engine.generate('Say "hello" in 3 words', {
      maxTokens: 100,
      timeoutMs: 60000
    });
    console.log('[TEST] 调用成功，耗时:', (Date.now()-start)/1000, '秒');
    console.log('[TEST] 结果类型:', typeof result);
    console.log('[TEST] 结果:', JSON.stringify(result).substring(0, 200));
  } catch (err) {
    console.error('[TEST] 错误:', err.message);
  }
}

test();
