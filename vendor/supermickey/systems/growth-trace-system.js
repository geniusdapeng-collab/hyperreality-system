/**
 * 成长痕迹系统 v1.0
 * Growth Trace System
 * 
 * 功能：在角色档案中记录小G从X→Y的转变弧光
 * 核心能力：
 * - 初始状态标记（恐惧/犹豫/不解）
 * - 转变触发点记录（关键镜头/台词/动作）
 * - 最终状态确认（坚定/温柔/信任）
 * - 跨集连续性检查（本集成长→下集起始状态）
 * 
 * 注入点：character-manager-v2.js（增强角色档案）
 */

class GrowthTraceSystem {
  constructor(config = {}) {
    this.config = {
      protagonistId: config.protagonistId || 'xiaoG',
      traceDir: config.traceDir || './growth-traces',
      ...config
    };
    
    this.traces = new Map(); // characterId -> traceData
  }

  /**
   * 创建新的成长轨迹记录
   * @param {string} episodeId - 集数ID（如 "di-jiang-ep01"）
   * @param {Object} initialState - 初始状态
   * @returns {Object} 轨迹对象
   */
  createTrace(episodeId, initialState = {}) {
    const trace = {
      episodeId,
      protagonistId: this.config.protagonistId,
      createdAt: new Date().toISOString(),
      
      // 初始状态（X）
      initialState: {
        emotion: initialState.emotion || 'curious', // curious, fearful, hesitant, excited
        confidence: initialState.confidence || 50, // 0-100
        trustLevel: initialState.trustLevel || 30, // 0-100
        understanding: initialState.understanding || 20, // 对异兽的理解度
        description: initialState.description || '充满好奇但略显谨慎'
      },
      
      // 转变触发点（关键镜头记录）
      turningPoints: [],
      
      // 最终状态（Y）
      finalState: null,
      
      // 连续性标记（与上集/下集的衔接）
      continuity: {
        previousEpisode: initialState.previousEpisode || null,
        previousFinalState: initialState.previousFinalState || null,
        nextEpisode: null,
        carryOver: true // 本集成长是否延续到下集
      },
      
      // 元数据
      meta: {
        beastId: initialState.beastId || null,
        beastName: initialState.beastName || null,
        habitat: initialState.habitat || null,
        totalShots: 0
      }
    };
    
    this.traces.set(episodeId, trace);
    return trace;
  }

  /**
   * 记录转变触发点
   * @param {string} episodeId - 集数ID
   * @param {Object} point - 触发点数据
   */
  recordTurningPoint(episodeId, point) {
    const trace = this.traces.get(episodeId);
    if (!trace) {
      throw new Error(`未找到轨迹: ${episodeId}，请先调用 createTrace`);
    }
    
    const turningPoint = {
      id: `tp-${trace.turningPoints.length + 1}`,
      shotId: point.shotId || 'unknown',
      timestamp: point.timestamp || new Date().toISOString(),
      
      // 触发类型
      type: point.type || 'emotional', // emotional, action, realization, dialogue, visual
      
      // 触发内容
      trigger: {
        prompt: point.prompt || '', // 触发Prompt片段
        action: point.action || '', // 触发动作
        dialogue: point.dialogue || '', // 触发台词
        visual: point.visual || '' // 触发视觉元素
      },
      
      // 状态变化（前后对比）
      stateChange: {
        before: {
          emotion: point.before?.emotion || trace.initialState.emotion,
          confidence: point.before?.confidence || trace.initialState.confidence,
          trustLevel: point.before?.trustLevel || trace.initialState.trustLevel
        },
        after: {
          emotion: point.after?.emotion || point.before?.emotion || 'curious',
          confidence: point.after?.confidence || (point.before?.confidence || 50) + 10,
          trustLevel: point.after?.trustLevel || (point.before?.trustLevel || 30) + 10
        }
      },
      
      // 转变描述
      description: point.description || `${point.before?.emotion || '未知'} → ${point.after?.emotion || '未知'}`,
      
      // 关键程度
      significance: point.significance || 'medium' // critical, high, medium, low
    };
    
    trace.turningPoints.push(turningPoint);
    
    // 如果是关键转变，更新当前累积状态
    if (['critical', 'high'].includes(turningPoint.significance)) {
      trace.currentState = { ...turningPoint.stateChange.after };
    }
    
    return turningPoint;
  }

  /**
   * 从故事板自动提取转变触发点
   * @param {string} episodeId - 集数ID
   * @param {Object} storyboard - 故事板对象
   * @returns {Array} 提取的触发点
   */
  extractFromStoryboard(episodeId, storyboard) {
    const trace = this.traces.get(episodeId);
    if (!trace) {
      throw new Error(`未找到轨迹: ${episodeId}`);
    }
    
    const shots = storyboard.shots || [];
    trace.meta.totalShots = shots.length;
    
    const extracted = [];
    const midPoint = Math.floor(shots.length / 2);
    
    // 转变标记词
    const transformationMarkers = {
      emotional: {
        keywords: ['恐惧', '害怕', '紧张', '不安', '颤抖', '退缩', '警惕', '惊',
                   '坚定', '勇敢', '温柔', '理解', '领悟', '释然', '信任', '接纳'],
        type: 'emotional'
      },
      action: {
        keywords: ['主动', '决定', '选择', '迈出', '走向', '伸手', '触摸', '呼唤',
                   '挑战', '尝试', '探索', '发现', '带领', '引导', '回应'],
        type: 'action'
      },
      realization: {
        keywords: ['明白', '理解', '领悟', '意识到', '发现', '原来', '终于', '原来如此',
                   '眼神变化', '表情转变', '恍然大悟', '心中一动'],
        type: 'realization'
      }
    };
    
    for (let i = 0; i < shots.length; i++) {
      const shot = shots[i];
      const text = (shot.prompt || '') + ' ' + (shot.action || '') + ' ' + (shot.narration || '');
      
      // 检查各类型标记
      for (const [category, config] of Object.entries(transformationMarkers)) {
        for (const kw of config.keywords) {
          if (text.includes(kw)) {
            const isBefore = i < midPoint;
            const isAfter = i >= midPoint;
            
            // 判断重要性
            let significance = 'medium';
            if (shot.type === 'climax' || shot.tension > 80) significance = 'critical';
            else if (shot.type === 'turning' || shot.tension > 60) significance = 'high';
            else if (isAfter && ['坚定', '勇敢', '温柔', '信任', '理解'].includes(kw)) significance = 'high';
            
            // 构建前后状态
            const beforeState = isBefore ? { emotion: 'hesitant', confidence: 40, trustLevel: 20 } 
                                         : { emotion: 'curious', confidence: 60, trustLevel: 50 };
            const afterState = isAfter ? { emotion: this.inferEmotion(kw), confidence: beforeState.confidence + 15, trustLevel: beforeState.trustLevel + 15 }
                                       : beforeState;
            
            const point = this.recordTurningPoint(episodeId, {
              shotId: shot.id || `S${String(i + 1).padStart(2, '0')}`,
              type: config.type,
              trigger: {
                prompt: shot.prompt?.substring(0, 80),
                action: shot.action,
                dialogue: shot.narration,
                visual: shot.visualDescription
              },
              before: beforeState,
              after: afterState,
              description: `${beforeState.emotion} → ${afterState.emotion}（${kw}触发）`,
              significance
            });
            
            extracted.push(point);
            break; // 每镜只记录一个触发点
          }
        }
      }
    }
    
    return extracted;
  }

  /**
   * 推断情感状态
   */
  inferEmotion(keyword) {
    const emotionMap = {
      '恐惧': 'fearful', '害怕': 'fearful', '紧张': 'nervous', '不安': 'anxious',
      '坚定': 'determined', '勇敢': 'brave', '温柔': 'tender', '理解': 'understanding',
      '领悟': 'enlightened', '释然': 'relieved', '信任': 'trusting', '接纳': 'accepting',
      '主动': 'proactive', '探索': 'curious', '发现': 'discovering'
    };
    return emotionMap[keyword] || 'curious';
  }

  /**
   * 设置最终状态
   * @param {string} episodeId - 集数ID
   * @param {Object} finalState - 最终状态
   */
  setFinalState(episodeId, finalState) {
    const trace = this.traces.get(episodeId);
    if (!trace) throw new Error(`未找到轨迹: ${episodeId}`);
    
    trace.finalState = {
      emotion: finalState.emotion || 'determined',
      confidence: finalState.confidence || 70,
      trustLevel: finalState.trustLevel || 60,
      understanding: finalState.understanding || 60,
      description: finalState.description || '完成转变，更加坚定和温柔',
      // 自动计算转变幅度
      growthDelta: {
        confidence: (finalState.confidence || 70) - trace.initialState.confidence,
        trustLevel: (finalState.trustLevel || 60) - trace.initialState.trustLevel,
        understanding: (finalState.understanding || 60) - trace.initialState.understanding
      }
    };
    
    return trace.finalState;
  }

  /**
   * 从故事板自动推断最终状态
   */
  inferFinalState(episodeId, storyboard) {
    const trace = this.traces.get(episodeId);
    if (!trace) throw new Error(`未找到轨迹: ${episodeId}`);
    
    const shots = storyboard.shots || [];
    const endingShots = shots.slice(-3); // 最后3镜
    const endingText = endingShots.map(s => (s.prompt || '') + (s.action || '')).join(' ');
    
    // 分析结尾状态
    let finalEmotion = 'determined';
    let finalConfidence = trace.initialState.confidence + 20;
    let finalTrust = trace.initialState.trustLevel + 20;
    
    // 检查积极关键词
    const positiveMarkers = ['坚定', '勇敢', '温柔', '信任', '理解', '微笑', '释然', '接纳'];
    const negativeMarkers = ['恐惧', '犹豫', '退缩', '不安', '紧张'];
    
    for (const kw of positiveMarkers) {
      if (endingText.includes(kw)) {
        finalConfidence += 10;
        finalTrust += 10;
      }
    }
    for (const kw of negativeMarkers) {
      if (endingText.includes(kw)) {
        finalConfidence -= 5;
        finalTrust -= 5;
      }
    }
    
    // 限制在合理范围
    finalConfidence = Math.min(95, Math.max(20, finalConfidence));
    finalTrust = Math.min(95, Math.max(10, finalTrust));
    
    // 推断情感
    if (endingText.includes('温柔') || endingText.includes('信任') || endingText.includes('微笑')) {
      finalEmotion = 'tender';
    } else if (endingText.includes('坚定') || endingText.includes('勇敢')) {
      finalEmotion = 'determined';
    } else if (endingText.includes('理解') || endingText.includes('领悟')) {
      finalEmotion = 'understanding';
    }
    
    return this.setFinalState(episodeId, {
      emotion: finalEmotion,
      confidence: finalConfidence,
      trustLevel: finalTrust,
      understanding: Math.min(80, trace.initialState.understanding + 40),
      description: `从${trace.initialState.emotion}转变为${finalEmotion}，信心+${finalConfidence - trace.initialState.confidence}，信任+${finalTrust - trace.initialState.trustLevel}`
    });
  }

  /**
   * 设置跨集连续性
   * @param {string} currentEpisode - 当前集ID
   * @param {string} nextEpisode - 下集ID
   */
  setContinuity(currentEpisode, nextEpisode) {
    const trace = this.traces.get(currentEpisode);
    if (!trace) throw new Error(`未找到轨迹: ${currentEpisode}`);
    
    trace.continuity.nextEpisode = nextEpisode;
    
    // 为下集创建初始状态（继承本集最终状态）
    const nextInitial = {
      emotion: trace.finalState?.emotion || trace.initialState.emotion,
      confidence: trace.finalState?.confidence || trace.initialState.confidence,
      trustLevel: trace.finalState?.trustLevel || trace.initialState.trustLevel,
      understanding: trace.finalState?.understanding || trace.initialState.understanding,
      description: `继承EP${currentEpisode}结尾状态: ${trace.finalState?.description || '未知'}`,
      previousEpisode: currentEpisode,
      previousFinalState: trace.finalState
    };
    
    return nextInitial;
  }

  /**
   * 验证跨集连续性
   * @param {string} prevEpisode - 上集ID
   * @param {string} currentEpisode - 当前集ID
   * @returns {Object} 连续性报告
   */
  validateContinuity(prevEpisode, currentEpisode) {
    const prevTrace = this.traces.get(prevEpisode);
    const currTrace = this.traces.get(currentEpisode);
    
    if (!prevTrace || !currTrace) {
      return { valid: false, error: '缺少轨迹数据' };
    }
    
    const prevFinal = prevTrace.finalState;
    const currInitial = currTrace.initialState;
    
    if (!prevFinal) {
      return { valid: false, error: '上集缺少最终状态' };
    }
    
    // 检查状态跳跃是否合理（允许±15的波动）
    const confidenceDiff = Math.abs(currInitial.confidence - prevFinal.confidence);
    const trustDiff = Math.abs(currInitial.trustLevel - prevFinal.trustLevel);
    
    const issues = [];
    if (confidenceDiff > 20) {
      issues.push(`信心值跳跃过大: ${prevFinal.confidence} → ${currInitial.confidence} (差距${confidenceDiff})`);
    }
    if (trustDiff > 20) {
      issues.push(`信任值跳跃过大: ${prevFinal.trustLevel} → ${currInitial.trustLevel} (差距${trustDiff})`);
    }
    
    return {
      valid: issues.length === 0,
      issues,
      prevFinal,
      currInitial,
      deltas: {
        confidence: currInitial.confidence - prevFinal.confidence,
        trust: currInitial.trustLevel - prevFinal.trustLevel
      }
    };
  }

  /**
   * 生成成长弧光报告
   * @param {string} episodeId - 集数ID
   */
  generateArcReport(episodeId) {
    const trace = this.traces.get(episodeId);
    if (!trace) throw new Error(`未找到轨迹: ${episodeId}`);
    
    const initial = trace.initialState;
    const final = trace.finalState;
    
    if (!final) {
      return { error: '尚未设置最终状态' };
    }
    
    const turningPoints = trace.turningPoints;
    const criticalPoints = turningPoints.filter(tp => tp.significance === 'critical');
    const highPoints = turningPoints.filter(tp => tp.significance === 'high');
    
    return {
      episodeId,
      arc: {
        start: `${initial.emotion}(信心${initial.confidence},信任${initial.trustLevel})`,
        end: `${final.emotion}(信心${final.confidence},信任${final.trustLevel})`,
        delta: {
          confidence: final.growthDelta.confidence,
          trust: final.growthDelta.trustLevel,
          understanding: final.growthDelta.understanding
        }
      },
      turningPoints: {
        total: turningPoints.length,
        critical: criticalPoints.length,
        high: highPoints.length,
        list: turningPoints.map(tp => ({
          id: tp.id,
          shot: tp.shotId,
          type: tp.type,
          change: `${tp.stateChange.before.emotion} → ${tp.stateChange.after.emotion}`,
          significance: tp.significance
        }))
      },
      quality: {
        hasArc: final.growthDelta.confidence > 10 || final.growthDelta.trustLevel > 10,
        hasCriticalMoment: criticalPoints.length > 0,
        hasTurningPoint: turningPoints.length > 0,
        continuitySet: !!trace.continuity.nextEpisode
      },
      summary: `本集小G从${initial.description}成长为${final.description}，经历${turningPoints.length}个转变时刻（${criticalPoints.length}个关键），信心+${final.growthDelta.confidence}，信任+${final.growthDelta.trustLevel}`
    };
  }

  /**
   * 序列化保存
   */
  saveTrace(episodeId, filepath) {
    const trace = this.traces.get(episodeId);
    if (!trace) throw new Error(`未找到轨迹: ${episodeId}`);
    
    const fs = require('fs');
    fs.writeFileSync(filepath, JSON.stringify(trace, null, 2), 'utf8');
    return filepath;
  }

  /**
   * 加载轨迹
   */
  loadTrace(filepath) {
    const fs = require('fs');
    const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    this.traces.set(data.episodeId, data);
    return data;
  }

  /**
   * 获取角色成长档案（用于跨集连续性）
   * @param {string} characterId - 角色ID
   */
  getCharacterGrowthProfile(characterId) {
    const episodes = [];
    for (const [episodeId, trace] of this.traces) {
      if (trace.protagonistId === characterId) {
        episodes.push({
          episodeId,
          initialState: trace.initialState,
          finalState: trace.finalState,
          turningPoints: trace.turningPoints.length,
          beastName: trace.meta.beastName
        });
      }
    }
    
    // 按时间排序
    episodes.sort((a, b) => a.episodeId.localeCompare(b.episodeId));
    
    // 计算累积成长曲线
    const growthCurve = episodes.map((ep, index) => ({
      episode: ep.episodeId,
      episodeNum: index + 1,
      confidence: ep.finalState?.confidence || ep.initialState.confidence,
      trust: ep.finalState?.trustLevel || ep.initialState.trustLevel,
      understanding: ep.finalState?.understanding || ep.initialState.understanding,
      beast: ep.beastName
    }));
    
    return {
      characterId,
      totalEpisodes: episodes.length,
      episodes,
      growthCurve,
      currentState: episodes.length > 0 ? episodes[episodes.length - 1].finalState : null
    };
  }
}

module.exports = { GrowthTraceSystem };
