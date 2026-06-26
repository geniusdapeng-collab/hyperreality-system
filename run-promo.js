// 运行超写实系统宣传片预生产（调试版）
const { HyperrealitySystem } = require('./index');

async function main() {
  console.log('[DEBUG] 开始初始化系统...');
  const system = new HyperrealitySystem({});
  console.log('[DEBUG] 系统初始化完成, 版本:', system.version);

  const intent = `制作一个60秒宣传片，介绍我们的AI视频工业创作系统"超写实"。
  创始人李大鹏亲自出镜讲解，展现系统的核心能力：
  - 剧本引擎（AI驱动叙事结构生成）
  - 制作引擎（导演级镜头语言）
  - 渲染引擎（4K电影级质感输出）
  - 三层稳定性护盾（基线热启动、LLM网关、健康监控）
  
  风格：科技感、电影级质感、专业可信。
  情绪：从期待到震撼，最后到行动号召。
  片尾要有反身性彩蛋——点出"本片也由超写实系统生成"。`;

  const metadata = {
    title: '超写实系统宣传片',
    characters: [
      {
        id: 'li-dapeng',
        name: '李大鹏',
        description: '超写实系统创始人，38岁，千问AI产品经理，Coding之神追求者。专业、热情、有感染力的科技创业者形象。',
        role: 'protagonist',
        portraitPaths: ['./character-photo/dapeng-reference.jpg']
      }
    ],
    style: {
      primary: '科技感',
      secondary: '电影级质感'
    },
    targetDuration: 60,
    platform: '官网/社交媒体',
    audience: '潜在客户、技术决策者、内容创作者',
    creativeIntensity: 0.7
  };

  const options = {
    skipRender: true,
    skipPostProduction: true
  };

  console.log('[DEBUG] 调用 system.create()...');
  
  try {
    const result = await system.create(intent, metadata, options);
    
    console.log('\n========================================');
    console.log('预生产完成！');
    console.log('========================================');
    console.log('成功:', result.success);
    console.log('阶段:', Object.keys(result.stages));
    
    if (result.shots) {
      console.log('\n镜头数:', result.shots.length);
    }

    // 输出完整Prompt到文件
    if (result.prompts) {
      const fs = require('fs');
      const promptMd = result.prompts.map((p, i) => {
        return `## 镜头 ${i+1}: ${p.id || 'SC' + String(i).padStart(2, '0')}\n\n${p.fusionText || p.content || JSON.stringify(p, null, 2)}\n\n---\n`;
      }).join('\n');
      
      fs.writeFileSync('./output/prompts-promo.md', `# 超写实系统宣传片 - 完整Prompt\n\n${promptMd}`);
      console.log('\n✅ Prompt已保存到: ./output/prompts-promo.md');
    }

  } catch (error) {
    console.error('[DEBUG] 预生产失败:', error);
    console.error('[DEBUG] 错误堆栈:', error.stack);
    process.exit(1);
  }
}

main().catch(e => {
  console.error('[DEBUG] 顶层错误:', e);
  process.exit(1);
});
