// 直接使用ScriptGenerator的llmEngine测试
const { ScriptGenerator } = require('./engines/script-engine/core/script-generator');

async function test() {
  const sg = new ScriptGenerator();
  
  console.log('llmEngine类型:', typeof sg.llmEngine);
  console.log('llmEngine是否为null:', sg.llmEngine === null);
  
  if (sg.llmEngine) {
    console.log('测试调用llmEngine.generate...');
    try {
      const start = Date.now();
      const result = await sg.llmEngine.generate('Say hello in JSON format: {"message": "hello"}', {
        maxTokens: 100,
        timeoutMs: 30000,
        forceJson: true,
        allowReasoningFallback: false
      });
      console.log('成功！耗时:', (Date.now()-start)/1000, '秒');
      console.log('结果:', JSON.stringify(result).substring(0, 200));
    } catch (err) {
      console.error('错误:', err.message);
    }
  }
}

test();
