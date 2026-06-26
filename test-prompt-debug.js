// 诊断prompt大小和内容
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

// 先加载模板
sg._loadTemplate(userIntent).then(template => {
  console.log('模板类型:', typeof template);
  console.log('模板结构:', template ? '有' : '无');
  
  const prompt = sg._buildGenerationPrompt(userIntent, template);
  console.log('Prompt长度:', prompt.length);
  console.log('Prompt前500字符:');
  console.log(prompt.substring(0, 500));
}).catch(err => {
  console.error('错误:', err.message);
});
