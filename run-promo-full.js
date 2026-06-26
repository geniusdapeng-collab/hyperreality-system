// 完整预生产链路运行脚本 - 用户视角宣传片
const { HyperrealitySystem } = require('./index');

async function main() {
  console.log('[PROMO] 启动超写实系统宣传片完整预生产链路...');
  console.log('[PROMO] 时间:', new Date().toISOString());
  console.log('');

  const system = new HyperrealitySystem({});
  console.log('[PROMO] 系统版本:', system.version);
  console.log('');

  const intent = `制作一个60秒宣传片，介绍我们的AI视频工业创作系统"超写实"。
核心要求：
1. 从用户视角出发，不是讲系统功能，而是讲用户痛点
2. 用户痛点：写Prompt太难、成本太高（10万→500元）、时间太长（3个月→10分钟）、质量不稳定
3. 创始人李大鹏亲自出镜讲解
4. 片尾要有反身性彩蛋：点出本片也由超写实系统生成
5. 风格：科技感、电影级质感、专业可信
6. 情绪：从压抑→希望→震撼→行动号召`;

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

  const startTime = Date.now();
  
  try {
    const result = await system.create(intent, metadata, options);
    
    console.log('');
    console.log('========================================');
    console.log('预生产完成！');
    console.log('========================================');
    console.log('成功:', result.success);
    console.log('总耗时:', ((Date.now() - startTime) / 1000).toFixed(1), '秒');
    console.log('阶段:', Object.keys(result.stages).join(', '));
    
    if (result.shots) {
      console.log('镜头数:', result.shots.length);
    }

    // 输出完整Prompt到文件
    if (result.prompts) {
      const fs = require('fs');
      const promptMd = result.prompts.map((p, i) => {
        const shotId = p.id || p.shotId || 'SC' + String(i).padStart(2, '0');
        return `## 镜头 ${i+1}: ${shotId}\n\n\`\`\`json\n${JSON.stringify(p, null, 2)}\n\`\`\`\n\n---\n`;
      }).join('\n');
      
      fs.writeFileSync('./output/prompts-system-generated.md', `# 超写实系统宣传片 - 系统生成完整Prompt\n\n${promptMd}`);
      console.log('\n✅ 系统生成Prompt已保存到: ./output/prompts-system-generated.md');
    }

    if (result.shots) {
      const fs = require('fs');
      fs.writeFileSync('./output/shots-summary.json', JSON.stringify(result.shots.map(s => ({
        id: s.id || s.shotId,
        duration: s.duration,
        type: s.sceneType || s.type,
        scene: (s.scene || s.content || '').substring(0, 100)
      })), null, 2));
      console.log('✅ 镜头摘要已保存到: ./output/shots-summary.json');
    }

  } catch (error) {
    console.error('[PROMO] 预生产失败:', error.message);
    console.error('[PROMO] 错误堆栈:', error.stack);
    process.exit(1);
  }
}

main().catch(e => {
  console.error('[PROMO] 顶层错误:', e);
  process.exit(1);
});
