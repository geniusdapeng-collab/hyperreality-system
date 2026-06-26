// 检查ScriptGenerator配置
const { ScriptGenerator } = require('./engines/script-engine/core/script-generator');

const sg = new ScriptGenerator();
console.log('ScriptGenerator配置:');
console.log('  timeout:', sg.config.timeout);
console.log('  maxTokens:', sg.config.maxTokens);
console.log('  model:', sg.config.model);
console.log('  llmEngine:', sg.llmEngine ? '已初始化' : '未初始化');
if (sg.llmEngine) {
  console.log('  llmEngine.model:', sg.llmEngine.model);
  console.log('  llmEngine.timeoutMs:', sg.llmEngine.timeoutMs);
}
