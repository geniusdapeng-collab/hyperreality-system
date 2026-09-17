// systems/llm-input-packet-builder.js
// v6.3-patch5-expert-fix: 最小输入包机制，减少LLM上下文和内存占用

'use strict';

function safeStr(v) {
  if (v === undefined || v === null) return '';
  return String(v).trim();
}

function safeObj(v) {
  if (v === undefined || v === null) return {};
  if (typeof v === 'object') return v;
  return {};
}

function safeArr(v) {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v;
  return [];
}

/**
 * 构建基础镜头上下文（精简版）
 * 只提取必要字段，避免传递全量对象
 */
function buildBaseShotContext(shot = {}, context = {}) {
  return {
    shotId: safeStr(shot.id || shot.shotId),
    scene: safeStr(shot.scene || shot.sceneName || shot.name),
    type: safeStr(shot.type || shot.beatName || shot.shotType),
    emotionPhase: safeStr(shot.emotionPhase || shot.emotion || shot.mood),
    duration: shot.duration || shot.shotDuration || 0,
    narration: safeStr(shot.narration || shot.narrationText || shot.narrative),
    visualPrompt: safeStr(shot.visualPrompt || shot.prompt || shot.visual),
    characters: safeArr(shot.characters || shot.characterList),
    cameraMovement: safeObj(shot.cameraMovement || shot.camera || shot.movement),
    lighting: safeObj(shot.lighting || shot.lightingPlan),
    constraints: safeObj(context.constraints || {})
  };
}

/**
 * 构建最小输入包
 * 根据Agent类型返回不同字段集，避免上下文过重
 * 
 * @param {string} agentType - director/screenwriter/camera/compositor/reviewer
 * @param {object} shot - 镜头对象
 * @param {object} context - 上下文
 * @returns {object} 最小输入包
 */
function buildLLMInputPacket(agentType, shot = {}, context = {}) {
  const base = buildBaseShotContext(shot, context);

  switch (agentType) {
    case 'director': {
      // 导演Agent：只需要整集统筹信息，不需要逐镜头全量
      return {
        projectName: safeStr(context.projectName),
        theme: safeStr(context.theme || context.prd?.theme || context.prd?.core?.theme),
        storyGoal: safeStr(context.storyGoal || context.prd?.core?.goal),
        sceneSummary: safeStr(base.scene),
        shotSummaries: Array.isArray(context.shotSummaries) ? context.shotSummaries : [],
        constraintsSummary: safeObj(context.constraintsSummary),
        styleGuide: safeObj(context.styleGuide)
      };
    }

    case 'screenwriter': {
      // 编剧Agent：只需要台词和情绪相关信息
      return {
        shotId: base.shotId,
        scene: base.scene,
        type: base.type,
        emotionPhase: base.emotionPhase,
        duration: base.duration,
        characters: base.characters,
        storyGoal: safeStr(context.storyGoal),
        dialogueConstraints: safeObj(context.dialogueConstraints),
        forbidden: context.forbidden || ['camera', 'lighting', 'environment invention']
      };
    }

    case 'camera': {
      // 摄影Agent：只需要运镜相关信息
      return {
        shotId: base.shotId,
        scene: base.scene,
        type: base.type,
        emotionPhase: base.emotionPhase,
        duration: base.duration,
        visualPrompt: base.visualPrompt,
        cameraConstraints: safeObj(context.cameraConstraints),
        forbidden: context.forbidden || []
      };
    }

    case 'compositor': {
      // 合成Agent：只需要融合相关信息
      return {
        shotId: base.shotId,
        scene: base.scene,
        type: base.type,
        duration: base.duration,
        visualCore: safeStr(context.visualCore || base.visualPrompt),
        cameraTimeline: context.cameraTimeline || '',
        lightingPlan: context.lightingPlan || '',
        styleGuide: safeObj(context.styleGuide),
        negativeConstraints: safeArr(context.negativeConstraints)
      };
    }

    case 'reviewer': {
      // 审查Agent：只需要最终Prompt和检查清单
      return {
        shotId: base.shotId,
        scene: base.scene,
        type: base.type,
        emotionPhase: base.emotionPhase,
        duration: base.duration,
        finalPrompt: safeStr(context.finalPrompt || base.visualPrompt),
        checklist: safeArr(context.checklist)
      };
    }

    default:
      // 默认返回精简版基础上下文
      return {
        shotId: base.shotId,
        scene: base.scene,
        type: base.type,
        emotionPhase: base.emotionPhase,
        duration: base.duration
      };
  }
}

/**
 * 计算输入包大小（用于监控）
 */
function estimatePacketSize(packet) {
  return JSON.stringify(packet).length;
}

/**
 * 验证输入包是否包含冗余字段
 */
function validatePacket(packet, agentType) {
  const allowedFields = {
    director: ['projectName', 'theme', 'storyGoal', 'sceneSummary', 'shotSummaries', 'constraintsSummary', 'styleGuide'],
    screenwriter: ['shotId', 'scene', 'type', 'emotionPhase', 'duration', 'characters', 'storyGoal', 'dialogueConstraints', 'forbidden'],
    camera: ['shotId', 'scene', 'type', 'emotionPhase', 'duration', 'visualPrompt', 'cameraConstraints', 'forbidden'],
    compositor: ['shotId', 'scene', 'type', 'duration', 'visualCore', 'cameraTimeline', 'lightingPlan', 'styleGuide', 'negativeConstraints'],
    reviewer: ['shotId', 'scene', 'type', 'emotionPhase', 'duration', 'finalPrompt', 'checklist']
  };

  const allowed = allowedFields[agentType] || [];
  const extra = Object.keys(packet).filter(k => !allowed.includes(k));
  
  return {
    valid: extra.length === 0,
    extraFields: extra,
    size: estimatePacketSize(packet)
  };
}

module.exports = {
  buildLLMInputPacket,
  estimatePacketSize,
  validatePacket,
  safeStr,
  safeObj,
  safeArr
};
