// 超写实系统反身性宣传片 - 完整预生产
// 用超写实系统制作一个宣传超写实系统的短片
// 版本: v2.1.5

const { HyperrealitySystem } = require('./index');
const fs = require('fs');
const path = require('path');

async function main() {
  console.log('========================================');
  console.log('🎬 超写实系统反身性宣传片预生产');
  console.log('   用超写实系统 → 制作 → 宣传超写实系统');
  console.log('========================================\n');

  const system = new HyperrealitySystem({
    scriptEngine: {
      charactersDir: path.join(__dirname, '../characters')
    },
    productionEngine: {
      charactersDir: path.join(__dirname, '../characters')
    },
    renderingEngine: {
      charactersDir: path.join(__dirname, '../characters')
    }
  });

  console.log(`[系统版本] v${system.version}\n`);

  // 用户意图（一句话描述）
  const intent = `制作一个60秒宣传片，宣传我们的AI视频工业创作系统"超写实"。
创始人李大鹏亲自出镜，从用户痛点出发：写Prompt像写天书、10万预算打水漂、3个月不出片。
展现超写实系统如何用一句话创意生成专业级视频。
片尾要有反身性彩蛋——点出"本片也由超写实系统生成"。`;

  // 元数据
  const metadata = {
    title: '超写实系统宣传片（反身性）',
    narrativeMode: 'commercial',  // 【v2.1.5-fix-C】显式指定商业模式，绕过自动分类
    characters: [
      {
        id: 'dapeng',
        name: '李大鹏',
        description: '超写实系统创始人，38岁，千问AI产品经理。戴眼镜，白色高领毛衣，知识分子气质，专业、热情、有感染力的科技创业者形象。',
        role: 'protagonist',
        portraitPaths: ['../characters/dapeng/portraits/dapeng-front.jpg']
      }
    ],
    style: {
      primary: 'REAL',
      secondary: 'cinematic'
    },
    targetDuration: 60,
    platform: 'website/social',
    audience: '内容创作者、企业决策者、营销团队',
    creativeIntensity: 0.72,
    series: {
      totalEpisodes: 1,
      currentEpisode: 1
    }
  };

  // 选项 - 队长已确认需求清单，跳过确认环节
  const options = {
    skipRequirementList: true,  // 队长已在对话中确认
    skipRender: true,           // 预生产阶段不渲染
    skipPostProduction: true    // 预生产阶段不后期
  };

  console.log('[预生产] 清理旧checkpoint...');
  const checkpointDir = path.join(__dirname, 'checkpoints');
  if (fs.existsSync(checkpointDir)) {
    fs.readdirSync(checkpointDir).forEach(f => {
      if (f.startsWith('checkpoint-')) {
        fs.unlinkSync(path.join(checkpointDir, f));
        console.log(`  删除: ${f}`);
      }
    });
  }
  
  console.log('[预生产] 启动完整主链路...\n');
  const startTime = Date.now();

  try {
    const result = await system.create(intent, metadata, options);
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log('\n========================================');
    console.log(`✅ 预生产完成 (${duration}s)`);
    console.log('========================================');
    console.log('成功:', result.success);
    console.log('阶段:', Object.keys(result.stages).join(', '));

    // 输出镜头信息
    if (result.shots && result.shots.length > 0) {
      console.log('\n📽️ 镜头详情:');
      result.shots.forEach((shot, i) => {
        const sid = shot.id || `S${String(i).padStart(2, '0')}`;
        const promptLen = shot.prompt ? shot.prompt.length : 0;
        console.log(`  ${sid}: ${promptLen}字符`);
      });
    }

    // 保存完整结果为JSON
    const outputDir = path.join(__dirname, 'output');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const jsonPath = path.join(outputDir, `promo-havs-preproduction-${timestamp}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2));
    console.log(`\n📁 JSON结果: ${jsonPath}`);

    // 保存Prompt为Markdown附件
    if (result.shots) {
      const mdContent = generatePromptMarkdown(result);
      const mdPath = path.join(outputDir, `promo-havs-prompts-${timestamp}.md`);
      fs.writeFileSync(mdPath, mdContent);
      console.log(`📄 Prompt附件: ${mdPath}`);
    }

    return result;

  } catch (error) {
    console.error('\n❌ 预生产失败:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

function generatePromptMarkdown(result) {
  const shots = result.shots || [];
  const stages = result.stages || {};

  let md = `# 超写实系统宣传片 - 完整Prompt\n\n`;
  md += `> 生成时间: ${new Date().toISOString()}\n`;
  md += `> 系统版本: v${result.version || '2.1.5'}\n`;
  md += `> 预生产状态: ${result.success ? '✅ 成功' : '❌ 失败'}\n\n`;

  // 需求清单
  if (stages.requirementList) {
    const rl = stages.requirementList.data || {};
    md += `## 需求清单\n\n`;
    md += `- 类型: ${rl.videoTypeName || 'N/A'}\n`;
    md += `- 时长: ${rl.targetDuration || 60}s\n`;
    md += `- 风格: ${rl.style?.primary || 'N/A'}\n`;
    md += `- 角色: ${rl.characters?.length || 0}个\n\n`;
  }

  // 镜头Prompt
  md += `## 镜头Prompt (${shots.length}镜)\n\n`;

  shots.forEach((shot, i) => {
    const sid = shot.id || `S${String(i).padStart(2, '0')}`;
    md += `### ${sid}\n\n`;
    md += `**Prompt (${shot.prompt?.length || 0}字符):**\n\n`;
    md += `\`\`\`\n${shot.prompt || 'N/A'}\n\`\`\`\n\n`;

    if (shot.dialogue) {
      md += `**台词:** ${shot.dialogue}\n\n`;
    }
    if (shot.duration) {
      md += `**时长:** ${shot.duration}s\n\n`;
    }
    if (shot.characters && shot.characters.length > 0) {
      md += `**角色:** ${shot.characters.join(', ')}\n\n`;
    }
    md += `---\n\n`;
  });

  return md;
}

main().catch(e => {
  console.error('顶层错误:', e);
  process.exit(1);
});
