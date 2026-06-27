// 从 checkpoint-phase2 续跑 Phase 3 (PromptFusion)
const fs = require('fs');
const path = require('path');

async function main() {
  const checkpointPath = path.join(__dirname, 'checkpoints/checkpoint-phase2.json');
  if (!fs.existsSync(checkpointPath)) {
    console.error('❌ checkpoint-phase2.json 不存在');
    process.exit(1);
  }

  const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
  console.log(`✅ 加载 checkpoint: ${checkpoint.phase}, ${checkpoint.shots?.length || 0} 镜头`);

  // 直接使用 PromptFusionAgent
  const { PromptFusionAgent } = require('./engines/production-engine/agents/prompt-fusion-agent');
  
  const agent = new PromptFusionAgent({
    llmModel: 'kimi-k2p6',
    maxPromptLength: 12000
  });

  console.log('\n🎬 开始 Phase 3: PromptFusion...');
  
  const pfResult = await agent.process(checkpoint.shots, checkpoint.adaptedBlueprint || {});
  
  if (pfResult.shots && pfResult.shots.length > 0) {
    console.log(`✅ Phase 3 完成: ${pfResult.shots.length} 镜头`);
    
    // 保存 checkpoint
    const checkpoint3Path = path.join(__dirname, 'checkpoints/checkpoint-phase3.json');
    fs.writeFileSync(checkpoint3Path, JSON.stringify({
      phase: 'phase3',
      shots: pfResult.shots,
      llmStats: pfResult.timing,
      savedAt: new Date().toISOString()
    }, null, 2));
    console.log(`💾 checkpoint-phase3.json 已保存`);
    
    // 输出 prompts
    console.log('\n📄 生成的 Prompts:');
    pfResult.shots.forEach((shot, i) => {
      console.log(`\n--- ${shot.shotId} ---`);
      console.log(`Prompt: ${shot.prompt?.substring(0, 300)}...`);
      console.log(`字符数: ${shot.promptCharCount || 0}`);
    });
    
    // 保存为 MD 文件
    const mdContent = generateMarkdown(pfResult.shots);
    const mdPath = path.join(__dirname, 'output/confirmations/confirmation-prompt.md');
    fs.writeFileSync(mdPath, mdContent);
    console.log(`\n📄 Prompts 已保存到: ${mdPath}`);
    
  } else {
    console.error('❌ Phase 3 未生成 shots');
  }
}

function generateMarkdown(shots) {
  let md = '# 📝 提示词审核报告\n\n';
  md += `**镜头数**: ${shots.length}\n`;
  md += `**平均长度**: ${Math.round(shots.reduce((s, shot) => s + (shot.promptCharCount || 0), 0) / shots.length)} 字符\n\n`;
  md += '## 镜头总览\n\n';
  md += '| 镜头 | 时长 | 字符数 | 场景 |\n';
  md += '|------|------|--------|------|\n';
  shots.forEach(shot => {
    md += `| ${shot.shotId} | ${shot.duration || '?'}s | ${shot.promptCharCount || 0} | ${shot.scene?.substring(0, 30) || ''}... |\n`;
  });
  md += '\n## 完整提示词\n\n';
  shots.forEach((shot, i) => {
    md += `### ${shot.shotId}\n\n`;
    md += `**Prompt (${shot.promptCharCount || 0}字符):**\n\n`;
    md += '```markdown\n';
    md += shot.prompt || 'N/A';
    md += '\n```\n\n---\n\n';
  });
  return md;
}

main().catch(e => {
  console.error('错误:', e);
  process.exit(1);
});
