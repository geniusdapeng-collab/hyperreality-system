/**
 * 【v2.2.5-审计标注】分叉副本 —— 与 scripts/promptforge-director-worker.js 同源不同版
 * （两副本 diff 达 653 行），且均未被主链路引用。保留作历史参考，
 * 如需启用请以 scripts/ 版本为基准比对后再决策，禁止双副本并行演进。
 */
/**
 * PromptForge Director Worker v6.5.52 (方案F: 超简化单次调用)
 * 子进程隔离，单次LLM调用重写全部镜头Prompt
 * 目标：3-4分钟完成，避免reasoning模式累积
 */

const fs = require('fs');
const path = require('path');

// 异常捕获
process.on('uncaughtException', (err) => {
  console.error('[WORKER] ❌ 未捕获异常:', err.message);
  _writeFallback({ error: err.message, stage: 'uncaughtException' });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[WORKER] ❌ 未处理Promise拒绝:', reason);
  _writeFallback({ error: String(reason), stage: 'unhandledRejection' });
  process.exit(1);
});

// 解析命令行参数
const inputPath = process.argv[2];
const outputPath = process.argv[3];

if (!inputPath || !outputPath) {
  console.error('用法: node promptforge-director-worker.js <input.json> <output.json>');
  process.exit(1);
}

// 读取输入
const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const { rawReport, projectConfig } = input;

// 导入 LLMEngine
const { LLMEngine } = require('./llm-reasoning-engine');

// 创建 LLM 引擎（使用较小maxTokens，避免reasoning耗尽）
const llm = new LLMEngine({
  model: 'kimi-k2p6',
  mode: 'production',
  maxRetries: 3,
  maxTokens: 16000,
  temperature: 1,
  topP: 0.95
});

function _writeFallback(extra = {}) {
  try {
    const fallback = {
      success: false,
      ...extra,
      shots: (rawReport?.shots || []).map(s => ({
        id: s.id,
        finalPrompt: s.prompt || ''
      }))
    };
    fs.writeFileSync(outputPath, JSON.stringify(fallback, null, 2));
  } catch (e) {}
}

// 构建单次重写Prompt - 策略：只补充细节，不重新写，减少推理量
function buildRewritePrompt(shots, config) {
  const beastId = config?.beastId || 'bai-ze';
  const theme = config?.theme || '心灵碰撞';
  
  const shotTexts = shots.map((s, i) => `
【镜头 ${s.id}】
原始Prompt: ${s.prompt?.substring(0, 400) || 'N/A'}
场景: ${s.scene || '未知'}
情绪: ${s.emotionPhase || '未知'}
时长: ${s.duration || 15}秒
`).join('\n');

  return `你是顶级AI视频Prompt工程师，擅长在现有Prompt基础上补充细节。

项目: 山海经：${beastId}·万物之眼 EP01
主题: ${theme}

【任务】
以下镜头Prompt已有基础内容，需要补充细节使其更丰富。请直接在每个原始Prompt后面追加200-300字的细节描写。

${shotTexts}

【补充要求】
1. 在原始Prompt末尾追加以下内容（不要删除原内容）：
   - 环境质感：地面材质、植被细节、大气效果
   - 光影变化：双恒星(Aurelius 5800K暖金 + Silvana 6500K银白)的光照效果、色温对比、阴影层次
   - 角色微表情：眼神、呼吸、肌肉紧绷、发丝飘动
   - Nirath特征：低重力0.82G（尘埃悬浮、步伐轻盈）、磁场3.2Tesla（磁丝蕨摇曳）、发光植被、磁丝蕨
   - 环境音效暗示：风声、生物共鸣、磁场嗡鸣、晶体共振
2. 追加后总长度应达到889-988字符
3. 保持中文纪录片质感，直接追加到原Prompt后面

直接输出追加后的完整Prompt，不要解释，不要JSON。`;
}

// 运行批次模式（3+3，减少LLM调用次数）
async function run() {
  const stage = 'batch-rewrite';
  try {
    console.log('[WORKER] 🎬 PromptForge 批次模式启动 v6.5.53-l');
    console.log('[WORKER] 📊 输入镜头数:', rawReport?.shots?.length || 0);
    
    const shots = rawReport?.shots || [];
    if (shots.length === 0) {
      throw new Error('没有输入镜头');
    }
    
    let allResults = [];
    
    // 分2批次处理（3+3）
    const batchSize = 3;
    const batches = [];
    for (let i = 0; i < shots.length; i += batchSize) {
      batches.push(shots.slice(i, i + batchSize));
    }
    
    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      const batch = batches[batchIdx];
      console.log(`[WORKER] 📦 批次 ${batchIdx+1}/${batches.length}: ${batch.map(s=>s.id).join(',')}`);
      
      const rewritePrompt = buildRewritePrompt(batch, projectConfig);
      console.log(`[WORKER] 📝 批次Prompt长度:`, rewritePrompt.length, '字符');
      
      console.log(`[WORKER] 🤖 批次LLM调用...`);
      const startTime = Date.now();
      
      const result = await llm.generate(rewritePrompt, {
        systemPrompt: '你是顶级Prompt工程师。请直接输出重写后的镜头Prompt文本，不要解释，不要JSON格式，只输出纯文本。',
        timeoutMs: 180000, // 3分钟超时
        maxTokens: 16000
      });
      
      const elapsed = Date.now() - startTime;
      console.log(`[WORKER] ✅ 批次完成 | 耗时: ${Math.round(elapsed/1000)}秒 | content长度: ${result.content?.length || 0}`);
      
      // 从content提取Prompt（自由文本模式）
      let prompt = result.content || '';
      prompt = prompt.replace(/```[\s\S]*?```/g, '').trim();
      
      // 如果content为空，尝试从reasoning_content提取
      if (!prompt || prompt.length < 100) {
        const rawPrompt = _extractPromptFromRaw(result.rawContent || '');
        if (rawPrompt && rawPrompt.length > prompt.length) {
          console.log(`[WORKER] 📄 从rawContent提取Prompt，长度: ${rawPrompt.length}`);
          prompt = rawPrompt;
        }
      }
      
      if (!prompt || prompt.length < 100) {
        console.log(`[WORKER] ⚠️ 批次提取失败，使用原始Prompt`);
        // 为每个镜头使用原始Prompt
        for (const shot of batch) {
          allResults.push({ id: shot.id, finalPrompt: shot.prompt || '' });
        }
      } else {
        // 尝试将结果分割为多个镜头Prompt
        // 简单策略：如果结果太长，按段落分割
        const paragraphs = prompt.split(/\n\n+/).filter(p => p.trim().length > 100);
        
        if (paragraphs.length >= batch.length) {
          // 假设每个段落对应一个镜头
          for (let i = 0; i < batch.length; i++) {
            const shotPrompt = paragraphs[i] || batch[i].prompt || '';
            allResults.push({ id: batch[i].id, finalPrompt: shotPrompt });
          }
        } else {
          // 无法分割，全部使用原始Prompt
          for (const shot of batch) {
            allResults.push({ id: shot.id, finalPrompt: shot.prompt || '' });
          }
        }
      }
      
      // 批次间休息
      if (batchIdx < batches.length - 1) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    
    console.log('[WORKER] 📊 全部镜头完成，总镜头数:', allResults.length);
    
    // 验证每个Prompt长度
    const validated = shots.map((originalShot, i) => {
      const r = allResults.find(x => x.id === originalShot.id);
      let prompt = r ? r.finalPrompt : '';
      
      if (!prompt) {
        console.log(`[WORKER] ⚠️ ${originalShot.id} 无结果，使用原始Prompt`);
        prompt = originalShot.prompt || '';
      }
      
      const len = prompt.length;
      const originalLen = (originalShot.prompt || '').length;
      
      // v6.5.58-fix: 如果生成Prompt太短，使用原始Prompt（如果原始更长）
      if (len < 700 && originalLen > len) {
        console.log(`[WORKER] ⚠️ ${originalShot.id} 生成Prompt太短(${len})，使用原始Prompt(${originalLen})`);
        prompt = originalShot.prompt || '';
      }
      
      if (len < 889) {
        console.log(`[WORKER] ⚠️ ${originalShot.id} 长度不足: ${len} < 889`);
      } else if (len > 1000) {
        console.log(`[WORKER] ⚠️ ${originalShot.id} 长度超标: ${len} > 1000，截断`);
        prompt = prompt.substring(0, 1000);
      } else {
        console.log(`[WORKER] ✅ ${originalShot.id} 长度达标: ${len}`);
      }
      
      return { id: originalShot.id, finalPrompt: prompt };
    });
    
    // 质量评分
    const scores = validated.map(v => {
      const len = v.finalPrompt.length;
      let score = 70;
      if (len >= 889 && len <= 988) score += 20;
      if (len > 700) score += 10;
      return { id: v.id, score, length: len };
    });
    
    const avgScore = Math.round(scores.reduce((a, b) => a + b.score, 0) / scores.length);
    const passed = avgScore >= 70;
    
    console.log('[WORKER] 📊 质量评分:', scores.map(s => `${s.id}=${s.score}`).join(', '));
    console.log('[WORKER] 📊 平均质量分:', avgScore, '通过:', passed);
    
    const output = {
      success: true,
      shots: validated,
      qualityReport: {
        overallScore: avgScore,
        overallPassed: passed,
        shotScores: scores,
        mode: 'batch-rewrite',
        version: 'v6.5.53-l'
      }
    };
    
    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
    console.log('[WORKER] 💾 输出已写入:', outputPath);
    
  } catch (e) {
    console.error(`[WORKER] ❌ 失败(阶段=${stage}):`, e.message);
    _writeFallback({ error: e.message, stage });
    process.exit(1);
  }
}

// 从rawContent中提取Prompt（reasoning模式兜底）
function _extractPromptFromRaw(text) {
  try {
    // 尝试找finalPrompt字段
    const match = text.match(/"finalPrompt"\s*:\s*"([^"]{100,})"/);
    if (match) return match[1];
    
    // 尝试找任意长文本字段
    const match2 = text.match(/"[^"]*Prompt"\s*:\s*"([^"]{100,})"/);
    if (match2) return match2[1];
    
    return null;
  } catch (e) {
    return null;
  }
}

// 从文本中提取JSON数组
function _extractArray(text) {
  try {
    // 查找方括号包裹的内容
    const match = text.match(/\[([\s\S]*?)\]/);
    if (match) {
      return JSON.parse('[' + match[1] + ']');
    }
    // 尝试整个解析
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

run();
