// 断点续跑 Phase 3 - 逐个镜头处理，每完成一个保存进度
const fs = require('fs');
const path = require('path');

const CHECKPOINT_V2_PATH = path.join(__dirname, 'checkpoints/checkpoint-phase3-resume.json');
const CHECKPOINT_PHASE2_PATH = path.join(__dirname, 'checkpoints/checkpoint-phase2.json');

async function main() {
  // 加载 phase2 checkpoint
  if (!fs.existsSync(CHECKPOINT_PHASE2_PATH)) {
    console.error('❌ checkpoint-phase2.json 不存在');
    process.exit(1);
  }

  const phase2 = JSON.parse(fs.readFileSync(CHECKPOINT_PHASE2_PATH, 'utf8'));
  const shots = phase2.shots || [];
  console.log(`✅ 加载 checkpoint-phase2: ${shots.length} 镜头`);

  // 加载已有进度
  let completed = [];
  let startIdx = 0;
  if (fs.existsSync(CHECKPOINT_V2_PATH)) {
    const resume = JSON.parse(fs.readFileSync(CHECKPOINT_V2_PATH, 'utf8'));
    completed = resume.completed || [];
    startIdx = completed.length;
    console.log(`💾 发现已有进度: ${completed.length}/${shots.length} 镜头已完成，从第 ${startIdx + 1} 个继续`);
  }

  // 加载 PromptFusionAgent
  const { PromptFusionAgent } = require('./engines/production-engine/agents/prompt-fusion-agent');
  const agent = new PromptFusionAgent({
    llmModel: 'kimi-k2p6',
    maxPromptLength: 12000
  });

  // 逐个处理
  for (let i = startIdx; i < shots.length; i++) {
    const shot = shots[i];
    console.log(`\n🎬 处理镜头 ${i + 1}/${shots.length}: ${shot.shotId}`);
    
    try {
      const result = await agent.process([shot], phase2.adaptedBlueprint || {});
      if (result.shots && result.shots.length > 0) {
        const processed = result.shots[0];
        completed.push(processed);
        console.log(`  ✅ ${shot.shotId} 完成 | Prompt: ${processed.promptCharCount || 0} 字符`);
        
        // 立即保存进度
        fs.writeFileSync(CHECKPOINT_V2_PATH, JSON.stringify({
          phase: 'phase3-resume',
          completed,
          total: shots.length,
          lastShotId: shot.shotId,
          savedAt: new Date().toISOString()
        }, null, 2));
      } else {
        console.error(`  ❌ ${shot.shotId} 未返回结果`);
        // 保存原始 shot 作为占位，避免阻塞
        completed.push(shot);
      }
    } catch (e) {
      console.error(`  ❌ ${shot.shotId} 失败: ${e.message}`);
      // 保存原始 shot 作为占位
      completed.push(shot);
    }
    
    // 短暂休息，避免触发限流
    if (i < shots.length - 1) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  console.log(`\n✅ 全部完成: ${completed.length}/${shots.length} 镜头`);

  // 合并所有结果并保存为最终 checkpoint-phase3
  const finalShots = shots.map((original, idx) => {
    if (idx < completed.length) {
      return { ...original, ...completed[idx] };
    }
    return original;
  });

  fs.writeFileSync(path.join(__dirname, 'checkpoints/checkpoint-phase3.json'), JSON.stringify({
    phase: 'phase3',
    shots: finalShots,
    llmStats: { totalShots: finalShots.length },
    savedAt: new Date().toISOString()
  }, null, 2));
  console.log('💾 checkpoint-phase3.json 已保存');

  // 生成确认报告
  generateReport(finalShots);
}

function generateReport(shots) {
  let md = '# 📝 提示词审核报告\n\n';
  md += `**镜头数**: ${shots.length}\n`;
  md += `**平均长度**: ${Math.round(shots.reduce((s, shot) => s + (shot.promptCharCount || 0), 0) / shots.length)} 字符\n\n`;
  
  md += '## 镜头总览\n\n';
  md += '| 镜头 | 时长 | 字符数 | 场景 |\n';
  md += '|------|------|--------|------|\n';
  shots.forEach(shot => {
    md += `| ${shot.shotId} | ${shot.duration || '?'}s | ${shot.promptCharCount || 0} | ${(shot.scene || '').substring(0, 30)}... |\n`;
  });
  
  md += '\n## 完整提示词\n\n';
  shots.forEach(shot => {
    md += `### ${shot.shotId}\n\n`;
    md += `**Prompt (${shot.promptCharCount || 0}字符):**\n\n`;
    md += '```markdown\n';
    md += shot.prompt || 'N/A';
    md += '\n```\n\n';
    
    if (shot.dialogueBlocks && shot.dialogueBlocks.length > 0) {
      md += '**台词:**\n';
      shot.dialogueBlocks.forEach(b => {
        md += `- [${b.speaker}] ${b.emotion}: "${b.line}"\n`;
      });
      md += '\n';
    }
    
    md += '---\n\n';
  });

  const mdPath = path.join(__dirname, 'output/confirmations/confirmation-prompt.md');
  fs.writeFileSync(mdPath, md);
  console.log(`📄 报告已保存: ${mdPath}`);
}

main().catch(e => {
  console.error('错误:', e);
  process.exit(1);
});
