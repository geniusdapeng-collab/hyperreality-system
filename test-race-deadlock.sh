#!/bin/bash
# 测试ScriptGenerator的Promise.race模式是否导致死锁

cd /root/.openclaw/workspace/hyperreality-system

cat > test-race-deadlock.js << 'EOF'
// 复现ScriptGenerator的Promise.race模式
async function test() {
  const { LLMEngine } = require('../systems/llm-reasoning-engine');
  const engine = new LLMEngine({model: 'kimi-k2p6', timeoutMs: 300000});
  
  const prompt = 'Say hello in JSON format: {"message": "hello"}';
  
  console.log('[TEST] 使用Promise.race模式...');
  
  const timeoutMs = 300000;
  let timer;
  
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('超时')), timeoutMs);
  });
  
  const llmPromise = engine.generate(prompt, {
    systemPrompt: '只输出JSON',
    maxTokens: 100,
    timeoutMs: 300000,
    forceJson: true,
    allowReasoningFallback: false
  });
  
  try {
    const start = Date.now();
    const result = await Promise.race([llmPromise, timeoutPromise]);
    if (timer) clearTimeout(timer);
    console.log('[TEST] 成功！耗时:', (Date.now()-start)/1000, '秒');
    console.log('[TEST] result:', JSON.stringify(result).substring(0, 200));
  } catch (err) {
    if (timer) clearTimeout(timer);
    console.error('[TEST] 错误:', err.message);
  }
}

test();
EOF

node test-race-deadlock.js
