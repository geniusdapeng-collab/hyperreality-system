/**
 * ContinuityReviewAgent - 连续性审查Agent
 * 负责: 全局审查6维度连续性（新增环节）
 */
const { BaseAgent } = require('./base-agent');
const { CrossEpisodeValidator } = require('./cross-episode-validator');

class ContinuityReviewAgent extends BaseAgent {
  constructor(options = {}) {
    super({ name: 'ContinuityReviewAgent', ...options });
    // 【v2.1.4-fix13-审计修复】把 BaseAgent 的 LLM 引擎传给 CrossEpisodeValidator
    this.crossEpisodeValidator = new CrossEpisodeValidator({
      llmEngine: this._getLLMEngine(),
      model: options.llmModel || 'kimi-k2p6',
      timeout: options.llmTimeout || 120000,
      ...options.crossEpisode
    });
  }

  _getSystemPrompt() {
    return `你是一位资深的电影剪辑师和剧本医生。审查整个视频的镜头连续性，从6个维度发现问题并给出优化建议。

输出JSON格式:
{
  "review": {
    "overallScore": 85,
    "issues": [
      {
        "dimension": "角色一致性",
        "severity": "warning",
        "description": "问题描述",
        "affectedShots": ["SC01", "SC02"],
        "suggestion": "优化建议"
      }
    ],
    "summary": "审查总结"
  }
}

审查维度:
1. 角色一致性: 角色形象、服装、位置是否连续
2. 情绪曲线: 情绪转折是否自然，有无突兀跳变
3. 视觉节奏: 景别切换是否有节奏感，有无单调重复
4. 灯光一致: 同一场景灯光是否保持一致
5. 叙事连贯: 镜头间叙事逻辑是否连贯
6. 时长分配: 重点场景时长是否足够，过渡场景是否过长`;
  }

  setDeadline(deadlineMs) {
    super.setDeadline(deadlineMs);
    if (this.crossEpisodeValidator && typeof this.crossEpisodeValidator.setDeadline === 'function') {
      this.crossEpisodeValidator.setDeadline(deadlineMs);
    }
  }

  // 【P0-1 修复】总体超时包装，确保即使 _callLLM 内部异常挂起，process 也能在固定时间返回
  _totalTimeout(promise, ms, label) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}总体超时(${ms}ms)`)), ms);
      })
    ]).finally(() => clearTimeout(timer));
  }

  async process(shots, blueprint, options = {}) {
    console.log(`[ContinuityReviewAgent] 开始审查 ${shots.length} 个镜头...`);
    const TOTAL_MS = Math.min(240000, this._remainingMs()); // 总体最多4分钟
    try {
      return await this._totalTimeout(this._processCore(shots, blueprint, options), TOTAL_MS, 'ContinuityReview');
    } catch (err) {
      console.warn(`[ContinuityReviewAgent] 总体兜底触发: ${err.message}，返回规则降级`);
      return { review: this._fallback(shots).review, degraded: true, degradeReason: err.message, boundaryReport: null };
    }
  }

  async _processCore(shots, blueprint, options = {}) {
    console.log(`[ContinuityReviewAgent._processCore] 进入核心处理 | shots=${shots.length} | blueprint=${!!blueprint}`);

    const prompt = this._buildPrompt(shots, blueprint);
    console.log(`[ContinuityReviewAgent._processCore] Prompt构建完成 | length=${prompt.length}`);

    const schema = {
      required: ['review']
    };

    console.log(`[ContinuityReviewAgent._processCore] 开始调用LLM...`);
    const llmResult = await this._callLLM(prompt, schema, () => {
      return this._fallback(shots);
    });
    console.log(`[ContinuityReviewAgent._processCore] LLM返回 | degraded=${llmResult.degraded} | degradeReason=${llmResult.degradeReason || 'none'}`);

    if (llmResult.degraded) {
      // 【P1-3 修复】降级对齐非降级结构，避免双层嵌套
      return { review: llmResult.result?.review || llmResult.result || {}, degraded: true, degradeReason: llmResult.degradeReason };
    }

    console.log(`[ContinuityReviewAgent] 连续性审查完成 ✓`);

    // 【v2.1.4】跨集边界校验（仅多集任务）
    let boundaryReport = null;
    const totalEpisodes = options.totalEpisodes || blueprint?.config?._metadata?.series?.totalEpisodes || 1;
    const episodeIndex = options.episodeIndex || blueprint?.config?._metadata?.series?.currentEpisode || 1;

    if (totalEpisodes > 1) {
      console.log(`[ContinuityReviewAgent] 开始跨集边界校验（第${episodeIndex}集/共${totalEpisodes}集）...`);
      
      try {
        const scriptText = CrossEpisodeValidator.extractScriptText(shots);
        const contract = options.episodeContract || this._buildContractFromBlueprint(blueprint);
        
        boundaryReport = await this.crossEpisodeValidator.validate({
          script: scriptText,
          contract,
          episodeIndex,
          totalEpisodes,
          overrideReason: options.boundaryOverrideReason || null
        });

        console.log(`[ContinuityReviewAgent] 跨集边界校验完成: ${boundaryReport.summary}`);
      } catch (err) {
        console.warn(`[ContinuityReviewAgent] 跨集边界校验失败: ${err.message}，跳过`);
      }
    }

    return { 
      review: llmResult.result.review, 
      degraded: false, 
      degradeReason: null,
      boundaryReport // 【v2.1.4】附加边界报告
    };
  }

  _buildPrompt(shots, blueprint) {
    const shotsInfo = shots.map(s => {
      return `镜头 ${s.shotId}: 时长${s.duration || '?'}s, 场景"${(s.scene || '').substring(0, 50)}", 情绪"${s.mood || ''}", 动作"${(s.action || '').substring(0, 50)}"`;
    }).join('\n');

    return `## 镜头列表
${shotsInfo}

## 任务
从6个维度审查镜头连续性:
1. 角色一致性
2. 情绪曲线
3. 视觉节奏
4. 灯光一致
5. 叙事连贯
6. 时长分配

对每个发现的问题:
- severity: critical/warning/info
- description: 问题描述
- affectedShots: 受影响的镜头ID列表
- suggestion: 具体优化建议

最后给出 overallScore (0-100) 和 summary。

直接输出JSON。`;
  }

  _fallback(shots) {
    console.log(`[ContinuityReviewAgent] 使用降级规则...`);
    const issues = [];

    // 【v2.1.4-fix13-审计修复】降级时至少做基础规则检查，不直接给固定分
    // 1. 检测景别重复（连续3个相同 sceneType）
    let prevType = '';
    let repeatCount = 0;
    for (const shot of shots) {
      const st = shot.sceneType || '';
      if (st === prevType) {
        repeatCount++;
        if (repeatCount >= 2) {
          issues.push({
            dimension: '视觉节奏',
            severity: 'warning',
            description: `连续 ${repeatCount + 1} 个 ${st} 镜头，节奏单调`,
            affectedShots: [shot.shotId],
            suggestion: '建议插入不同景别镜头打破单调'
          });
        }
      } else {
        repeatCount = 0;
      }
      prevType = st;
    }

    // 2. 检测时长分配异常
    const durations = shots.map(s => s.duration || 0);
    const total = durations.reduce((a, b) => a + b, 0);
    if (total > 0) {
      const avg = total / shots.length;
      for (let i = 0; i < shots.length; i++) {
        if (durations[i] > avg * 3) {
          issues.push({
            dimension: '时长分配',
            severity: 'warning',
            description: `镜头 ${shots[i].shotId} 时长 ${durations[i]}s 远超平均 ${avg.toFixed(1)}s`,
            affectedShots: [shots[i].shotId],
            suggestion: '考虑拆分或缩短该镜头'
          });
        }
      }
    }

    const score = Math.max(60, 90 - issues.length * 5);
    return {
      review: {
        overallScore: score,
        issues,
        summary: `连续性审查（降级模式）：规则检查发现 ${issues.length} 项问题`
      }
    };
  }

  /**
   * 【v2.1.4】从blueprint构造边界契约
   * blueprint结构: { config: { _metadata: {...} }, scenes: [...] }
   */
  _buildContractFromBlueprint(blueprint) {
    const meta = blueprint?.config?._metadata || {};
    const series = meta.series || {};
    const plan = meta.seriesContentPlan || {};
    
    // 优先从seriesContentPlan提取
    if (plan.episodes && plan.episodes.length > 0) {
      const episodeIndex = meta.series?.currentEpisode || meta.episode || 1;
      const ep = plan.episodes[episodeIndex - 1];
      if (ep) {
        return {
          mustCover: ep.mustCover || ep.coreTopics || [],
          canMention: ep.canMention || [],
          mustNotCover: ep.mustNotCover || [],
          previousSummary: null
        };
      }
    }
    
    return {
      mustCover: series.mustCover || series.episodeThemes || [],
      canMention: series.canMention || [],
      mustNotCover: series.mustNotCover || [],
      previousSummary: series.previousSummary || null
    };
  }
}

module.exports = { ContinuityReviewAgent };
