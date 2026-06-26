// 直接测试ScriptEngine
const { ScriptEngine } = require('./engines/script-engine');

async function test() {
  console.log('[TEST] 直接测试ScriptEngine...');
  
  const engine = new ScriptEngine({});
  
  const userIntent = {
    raw: {
      description: '制作一个60秒宣传片，介绍AI视频工业创作系统"超写实"。创始人李大鹏亲自出镜。'
    },
    metadata: {
      title: '超写实系统宣传片',
      target_duration: 60,
      protagonist: '李大鹏',
      language: 'zh',
      target_platform: ['官网', '社交媒体'],
      world_setting: 'default'
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
  
  try {
    console.log('[TEST] 调用generate...');
    const start = Date.now();
    const result = await engine.scriptGenerator.generate(userIntent);
    console.log('[TEST] 生成成功，耗时:', (Date.now()-start)/1000, '秒');
    console.log('[TEST] 场景数:', result.structure?.scenes?.length || 0);
  } catch (err) {
    console.error('[TEST] 错误:', err.message);
    console.error('[TEST] 堆栈:', err.stack);
  }
}

test();
