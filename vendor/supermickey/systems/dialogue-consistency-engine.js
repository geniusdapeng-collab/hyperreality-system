/**
 * 台词一致性引擎 (Dialogue Consistency Engine) v1.0
 * Stage 17 核心模块之一
 * 
 * 职责：检查全片台词/旁白的连贯性、情绪一致性、潜台词统一性
 * - 不修改台词内容，仅产出一致性分析报告
 * - 为编剧优化Agent提供数据支撑
 * 
 * @version v1.0 (v6.2-patch68)
 * @author 小G
 */

class DialogueConsistencyEngine {
  constructor(options = {}) {
    this.mode = options.mode || 'nirath';
    
    // 情绪色彩词库（用于检测情绪突变）
    this.EMOTION_PALETTE = {
      warm: ['温柔', '温暖', '亲切', '柔和', '慈爱', '关怀', '安慰', '希望', '喜悦', '感动'],
      tense: ['恐惧', '紧张', '愤怒', '危急', '压迫', '绝望', '危险', '警示', '紧迫', '危机'],
      awe: ['敬畏', '震撼', '伟大', '神圣', '崇高', '庄严', '浩瀚', '永恒', '不朽', '奇迹'],
      neutral: ['平静', '客观', '陈述', '描述', '记录', '观察', '叙述', '说明']
    };
    
    // 语气标记词
    this.TONE_MARKERS = {
      question: ['吗', '呢', '吧', '么', '如何', '为什么', '难道', '是不是'],
      exclamation: ['啊', '呀', '哇', '哦', '哈', '嘿', '天哪', '竟然', '终于'],
      whisper: ['低语', '轻声', '耳语', '呢喃', '默念', '私语'],
      command: ['必须', '立刻', '马上', '给我', '不准', '不要', '禁止', '务必']
    };
    
    // 跨镜头连贯性检查项
    this.CHECK_ITEMS = [
      '情绪一致性',      // 相邻镜头台词情绪是否突变
      '叙事连贯性',      // 前后台词是否承接
      '潜台词统一性',    // 潜台词是否服务于同一主题
      '角色声音一致性',  // 同角色语气是否统一
      '信息密度曲线'     // 台词密度是否符合情绪节奏
    ];
  }

  /**
   * 主入口：分析全片台词一致性
   * @param {Array} shots - 镜头数组（需包含 narration/beastDialogue/humanDialogue 字段）
   * @returns {Object} 一致性分析报告
   */
  analyze(shots) {
    console.log(`\n[DialogueConsistencyEngine] 🎭 台词一致性引擎启动 | 镜头数: ${shots.length}`);
    
    const result = {
      score: 0,
      maxScore: 100,
      issues: [],
      shotDialogues: [],
      emotionCurve: [],
      summary: {}
    };

    // 提取每镜台词
    const dialogues = this._extractAllDialogues(shots);
    result.shotDialogues = dialogues;

    // 逐镜分析
    for (let i = 0; i < dialogues.length; i++) {
      const curr = dialogues[i];
      
      // 情绪检测
      const emotion = this._detectEmotion(curr.text);
      result.emotionCurve.push({
        shotId: curr.shotId,
        emotion: emotion.primary,
        emotionCategory: emotion.category,
        intensity: emotion.intensity,
        text: curr.text.substring(0, 50) + (curr.text.length > 50 ? '...' : '')
      });
      
      // 相邻镜连贯性检查
      if (i > 0) {
        const prev = dialogues[i - 1];
        const continuity = this._checkPairContinuity(prev, curr);
        if (continuity.issue) {
          result.issues.push(continuity.issue);
        }
      }
      
      // 角色声音一致性检查（仅针对有角色标识的台词）
      if (curr.speaker) {
        const voiceCheck = this._checkVoiceConsistency(curr, dialogues, i);
        if (voiceCheck.issue) {
          result.issues.push(voiceCheck.issue);
        }
      }
    }

    // 全片信息密度曲线
    const densityCurve = this._calculateDensityCurve(dialogues);
    result.densityCurve = densityCurve;
    
    // 检查密度曲线是否匹配情绪节奏
    const densityMismatch = this._checkDensityEmotionAlignment(densityCurve, result.emotionCurve);
    if (densityMismatch.length > 0) {
      result.issues.push(...densityMismatch);
    }

    // 计算总分
    result.score = this._calculateScore(result.issues, dialogues.length);
    result.summary = this._generateSummary(result);

    this._printReport(result);
    return result;
  }

  /**
   * 提取所有台词
   */
  _extractAllDialogues(shots) {
    const dialogues = [];
    
    for (const shot of shots) {
      const shotId = shot.shotId || shot.id || 'unknown';
      
      // 提取旁白/内心独白
      const narration = shot.narration || shot.innerMonologue || '';
      if (narration && narration.trim()) {
        dialogues.push({
          shotId,
          type: 'narration',
          speaker: 'narrator',
          text: narration.trim(),
          isOpening: shot.isOpening || shot.shotId === 'S00'
        });
      }
      
      // 提取异兽台词
      const beastLines = shot.beastLines || shot.beastDialogue || [];
      if (Array.isArray(beastLines)) {
        for (const line of beastLines) {
          if (line && line.trim()) {
            dialogues.push({
              shotId,
              type: 'beast',
              speaker: shot.beastName || 'beast',
              text: line.trim(),
              isOpening: shot.isOpening || shot.shotId === 'S00'
            });
          }
        }
      }
      
      // 提取人类角色台词
      const humanLines = shot.humanDialogue || [];
      if (Array.isArray(humanLines)) {
        for (const line of humanLines) {
          if (line && line.trim()) {
            dialogues.push({
              shotId,
              type: 'human',
              speaker: line.speaker || 'human',
              text: line.text || line,
              isOpening: shot.isOpening || shot.shotId === 'S00'
            });
          }
        }
      }
    }
    
    return dialogues;
  }

  /**
   * 检测文本情绪
   */
  _detectEmotion(text) {
    const result = { primary: 'neutral', category: 'neutral', intensity: 0 };
    if (!text) return result;
    
    let scores = { warm: 0, tense: 0, awe: 0, neutral: 0 };
    
    for (const [category, words] of Object.entries(this.EMOTION_PALETTE)) {
      for (const word of words) {
        if (text.includes(word)) scores[category]++;
      }
    }
    
    const maxCategory = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
    if (maxCategory[1] > 0) {
      result.category = maxCategory[0];
      result.primary = this.EMOTION_PALETTE[maxCategory[0]][0];
      result.intensity = Math.min(10, maxCategory[1] * 2);
    }
    
    return result;
  }

  /**
   * 检查相邻台词对的连贯性
   */
  _checkPairContinuity(prev, curr) {
    // 跳过片头
    if (curr.isOpening) return { issue: null };
    
    const prevEmotion = this._detectEmotion(prev.text);
    const currEmotion = this._detectEmotion(curr.text);
    
    // 情绪突变检测（同类别内细微变化允许，跨类别突变需检查）
    if (prevEmotion.category !== currEmotion.category && prevEmotion.intensity > 3 && currEmotion.intensity > 3) {
      // 检查是否有叙事动机（如"突然"、"转折"等词）
      const hasTransitionMarker = /突然|忽然|瞬间|刹那|转折|逆转|突变/.test(curr.text);
      
      if (!hasTransitionMarker) {
        return {
          issue: {
            severity: 'medium',
            category: 'dialogue',
            subCategory: 'emotion_jump',
            pairId: `${prev.shotId}→${curr.shotId}`,
            message: `台词情绪突变：从${prevEmotion.primary}(${prevEmotion.category})突变为${currEmotion.primary}(${currEmotion.category})，无叙事转折铺垫`,
            fix: '在前一镜添加情绪转折铺垫，或后一镜添加"突然""瞬间"等过渡词',
            prevEmotion: prevEmotion.category,
            currEmotion: currEmotion.category
          }
        };
      }
    }
    
    // 叙事承接检查：后一镜是否回应前一镜的信息
    const prevKeywords = this._extractKeywords(prev.text);
    const currKeywords = this._extractKeywords(curr.text);
    const overlap = prevKeywords.filter(k => currKeywords.includes(k));
    
    if (overlap.length === 0 && prev.text.length > 10 && curr.text.length > 10) {
      // 关键词无重叠 → 可能叙事断裂
      // 但允许完全转向（如从"叙述环境"转向"角色对话"）
      if (prev.type === curr.type) {
        return {
          issue: {
            severity: 'low',
            category: 'dialogue',
            subCategory: 'narrative_gap',
            pairId: `${prev.shotId}→${curr.shotId}`,
            message: `叙事承接薄弱：相邻${prev.type}台词无共享关键词，叙事链条可能断裂`,
            fix: '增加承接词或概念呼应，使前后台词形成叙事链条',
            prevKeywords: prevKeywords.slice(0, 3),
            currKeywords: currKeywords.slice(0, 3)
          }
        };
      }
    }
    
    return { issue: null };
  }

  /**
   * 检查角色声音一致性
   */
  _checkVoiceConsistency(current, allDialogues, currentIndex) {
    const sameSpeaker = allDialogues.filter((d, idx) => 
      idx < currentIndex && d.speaker === current.speaker && d.type === current.type
    );
    
    if (sameSpeaker.length === 0) return { issue: null };
    
    // 取最近3句同角色台词
    const recent = sameSpeaker.slice(-3);
    
    // 检测语气标记
    const currentTone = this._detectTone(current.text);
    const recentTones = recent.map(r => this._detectTone(r.text));
    
    // 语气突变检测（疑问→命令、感叹→低语等）
    const dominantRecentTone = this._getDominantTone(recentTones);
    if (dominantRecentTone && currentTone && dominantRecentTone !== currentTone) {
      // 允许情绪驱动的语气变化（如从平静到激动）
      const hasEmotionalReason = /愤怒|激动|震惊|恐惧|兴奋/.test(current.text);
      
      if (!hasEmotionalReason) {
        return {
          issue: {
            severity: 'low',
            category: 'dialogue',
            subCategory: 'voice_inconsistency',
            shotId: current.shotId,
            message: `角色"${current.speaker}"语气不一致：此前多为${dominantRecentTone}，此处突变为${currentTone}，无情绪动机`,
            fix: '确保角色语气变化有明确情绪驱动，或保持角色声音一致性',
            speaker: current.speaker,
            expectedTone: dominantRecentTone,
            actualTone: currentTone
          }
        };
      }
    }
    
    return { issue: null };
  }

  /**
   * 检测语气类型
   */
  _detectTone(text) {
    for (const [tone, markers] of Object.entries(this.TONE_MARKERS)) {
      if (markers.some(m => text.includes(m))) return tone;
    }
    return 'statement'; // 默认陈述
  }

  /**
   * 获取主导语气
   */
  _getDominantTone(tones) {
    const counts = {};
    for (const t of tones) counts[t] = (counts[t] || 0) + 1;
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    return sorted.length > 0 ? sorted[0][0] : null;
  }

  /**
   * 提取关键词
   */
  _extractKeywords(text) {
    // 简单分词：去除标点，提取2字以上词
    const cleaned = text.replace(/[【】\[\]，。！？、\s]/g, ' ');
    const words = cleaned.split(/\s+/).filter(w => w.length >= 2);
    return [...new Set(words)].slice(0, 10);
  }

  /**
   * 计算台词密度曲线
   */
  _calculateDensityCurve(dialogues) {
    // 按shotId分组
    const byShot = {};
    for (const d of dialogues) {
      if (!byShot[d.shotId]) byShot[d.shotId] = [];
      byShot[d.shotId].push(d);
    }
    
    return Object.entries(byShot).map(([shotId, lines]) => ({
      shotId,
      charCount: lines.reduce((sum, l) => sum + l.text.length, 0),
      lineCount: lines.length,
      avgLineLength: lines.length > 0 ? Math.round(lines.reduce((sum, l) => sum + l.text.length, 0) / lines.length) : 0
    }));
  }

  /**
   * 检查密度曲线是否匹配情绪节奏
   */
  _checkDensityEmotionAlignment(densityCurve, emotionCurve) {
    const issues = [];
    
    for (let i = 0; i < emotionCurve.length; i++) {
      const emotion = emotionCurve[i];
      const density = densityCurve.find(d => d.shotId === emotion.shotId);
      
      if (!density) continue;
      
      // 高潮/紧张情绪应有高密度台词
      if (['tense', 'awe'].includes(emotion.emotionCategory) && emotion.intensity > 6) {
        if (density.charCount < 20) {
          issues.push({
            severity: 'low',
            category: 'dialogue',
            subCategory: 'density_mismatch',
            shotId: emotion.shotId,
            message: `情绪高潮(${emotion.emotionCategory}, 强度${emotion.intensity})但台词密度低(${density.charCount}字符)，信息密度与情绪不匹配`,
            fix: '增加台词密度或内心独白，强化情绪张力'
          });
        }
      }
      
      // 平静/建立情绪应有低密度台词（视觉为主）
      if (['neutral', 'warm'].includes(emotion.emotionCategory) && emotion.intensity < 3) {
        if (density.charCount > 80) {
          issues.push({
            severity: 'low',
            category: 'dialogue',
            subCategory: 'density_mismatch',
            shotId: emotion.shotId,
            message: `情绪平静(${emotion.emotionCategory})但台词密度过高(${density.charCount}字符)，可能干扰视觉沉浸`,
            fix: '精简台词，让画面叙事主导'
          });
        }
      }
    }
    
    return issues;
  }

  /**
   * 计算总分
   */
  _calculateScore(issues, totalDialogues) {
    const deductions = { fatal: 20, severe: 12, medium: 6, low: 2 };
    let totalDeduction = 0;
    
    for (const issue of issues) {
      totalDeduction += deductions[issue.severity] || 5;
    }
    
    // 台词数量加分
    const dialogueBonus = Math.min(20, totalDialogues * 2);
    
    return Math.max(0, 100 - totalDeduction + dialogueBonus);
  }

  /**
   * 生成摘要
   */
  _generateSummary(result) {
    const severityCount = { fatal: 0, severe: 0, medium: 0, low: 0 };
    for (const issue of result.issues) severityCount[issue.severity]++;
    
    return {
      totalDialogues: result.shotDialogues.length,
      emotionTransitions: result.emotionCurve.length,
      issuesBySeverity: severityCount,
      passLine: 75,
      status: result.score >= 75 ? 'PASS' : 'NEEDS_FIX'
    };
  }

  /**
   * 输出报告
   */
  _printReport(result) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🎭 台词一致性报告`);
    console.log(`${'='.repeat(60)}`);
    console.log(`评分: ${result.score}/100`);
    console.log(`状态: ${result.score >= 75 ? '✅ 通过' : '❌ 需修复'} (通过线: 75)`);
    console.log(`台词总数: ${result.shotDialogues.length}`);
    console.log(`\n问题统计:`);
    console.log(`  🔴 致命: ${result.summary.issuesBySeverity?.fatal || 0}`);
    console.log(`  🟠 严重: ${result.summary.issuesBySeverity?.severe || 0}`);
    console.log(`  🟡 中等: ${result.summary.issuesBySeverity?.medium || 0}`);
    console.log(`  🟢 轻微: ${result.summary.issuesBySeverity?.low || 0}`);
    
    if (result.issues.length > 0) {
      console.log(`\n详细问题:`);
      for (const issue of result.issues) {
        const icon = { fatal: '🔴', severe: '🟠', medium: '🟡', low: '🟢' }[issue.severity] || '⚪';
        console.log(`  ${icon} [${issue.subCategory}] ${issue.message}`);
        if (issue.fix) console.log(`     → 建议: ${issue.fix}`);
      }
    }
    console.log(`${'='.repeat(60)}\n`);
  }
}

module.exports = { DialogueConsistencyEngine };
// v6.2-patch68: 台词一致性引擎 — Stage 17 导演-编剧闭环核心模块
