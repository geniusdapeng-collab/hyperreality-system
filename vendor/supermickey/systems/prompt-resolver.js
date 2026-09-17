'use strict';

function resolvePromptText(shot, preproductionData = null) {
  if (!shot || typeof shot !== 'object') return '';

  // v6.5.65-P3-fix: 如果提供了预生产数据，优先从 stages.style 读取完整渲染提示词
  if (preproductionData && shot.shotId) {
    const styleStage = preproductionData.stages?.style?.find(
      s => s.shotId === shot.shotId || s.id === shot.shotId
    );
    if (styleStage && typeof styleStage.prompt === 'string' && styleStage.prompt.trim()) {
      // 验证完整度：检查是否包含关键结构化字段
      const hasDirector = styleStage.prompt.includes('DIRECTOR');
      const hasScene = styleStage.prompt.includes('SCENE');
      const hasSpace = styleStage.prompt.includes('【空间】');
      const hasCamera = styleStage.prompt.includes('CAMERA');
      const hasRender = styleStage.prompt.includes('RENDER');
      const isComplete = hasDirector && hasScene && hasCamera && hasRender;
      
      if (isComplete) {
        return styleStage.prompt.trim();
      }
      // 如果不完整，降级到 shot 自带 prompt
    }
  }

  const candidates = [
    shot.render_prompt,
    shot.renderPrompt,
    shot.prompt,
    shot.visualPrompt,
    shot.finalPrompt
  ];

  for (const item of candidates) {
    if (typeof item === 'string' && item.trim()) {
      return item.trim();
    }
  }

  return '';
}

function loadShotFromPreproduction(preproductionPath, shotId) {
  const fs = require('fs');
  if (!fs.existsSync(preproductionPath)) return null;
  
  try {
    const data = JSON.parse(fs.readFileSync(preproductionPath, 'utf-8'));
    
    // 从 stages.style 查找完整 shot 数据
    const styleShot = data.stages?.style?.find(
      s => s.shotId === shotId || s.id === shotId
    );
    
    if (styleShot) {
      return {
        ...styleShot,
        shotId: shotId,
        // 确保有 duration 字段
        duration: styleShot.duration || 8
      };
    }
    
    // 回退到 script.scenes
    return data.script?.scenes?.find(s => s.id === shotId) || null;
  } catch (e) {
    return null;
  }
}

function resolveNarrationText(shot) {
  if (!shot || typeof shot !== 'object') return '';
  const candidates = [
    shot.narration,
    shot.dialogue,
    shot.line
  ];

  for (const item of candidates) {
    if (typeof item === 'string' && item.trim()) {
      return item.trim();
    }
  }

  return '';
}

module.exports = {
  resolvePromptText,
  resolveNarrationText
};
