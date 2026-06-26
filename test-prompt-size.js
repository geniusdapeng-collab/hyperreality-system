// 诊断prompt大小
const { ScriptGenerator } = require('./engines/script-engine/core/script-generator');

const sg = new ScriptGenerator();

const userIntent = {
  metadata: {
    title: '超写实系统宣传片',
    target_duration: 60,
    protagonist: '李大鹏',
    language: 'zh',
    target_platform: ['官网', '社交媒体'],
    world_setting: 'default',
    featured_beast_id: null
  },
  parsed: {
    primary_mode: 'dramatic',
    hybrid_config: null,
    secondary_modes: []
  },
  constraints: {
    no_voiceover: true
  }
};

const prompt = sg._buildGenerationPrompt(userIntent, null);
console.log('Prompt长度:', prompt.length);
console.log('Prompt前1000字符:');
console.log(prompt.substring(0, 1000));
console.log('...');
console.log('Prompt后500字符:');
console.log(prompt.substring(prompt.length - 500));
