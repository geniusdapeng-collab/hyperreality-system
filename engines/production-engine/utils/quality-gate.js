/**
 * 质量门 (Quality Gate)
 * 
 * 职责：
 * - 检查镜头字段完整性与格式
 * - 检查提示词长度限制
 * - 片头专属检查
 */

class QualityGate {
  constructor(config = { maxPromptLength: 2000 }) {
    this.config = config;
  }

  /**
   * 执行质量检查
   * @param {Array} prompts - 镜头数组
   * @returns {Object} 检查结果
   */
  run(prompts) {
    const checks = [];
    for (const p of prompts) {
      // 【P1-11 修复】改读25字段标准名，兼容camelCase和旧xxxString
      const camStr = String(
        p.camera_movement || p.cameraMovement || p.cameraString
        || (typeof p.camera === 'string' ? p.camera : '') || ''
      );
      const lightStr = String(
        p.lighting || p.lightingString
        || (typeof p.lighting === 'object' ? JSON.stringify(p.lighting) : '') || ''
      );
      const tlStr = String(
        p.timeline || p.timelineString
        || (Array.isArray(p.timeline) ? JSON.stringify(p.timeline) : '') || ''
      );
      const bgStr = String(p.backgroundSoundString || (typeof p.backgroundSound === 'string' ? p.backgroundSound : '') || '');

      const check = {
        shotId: p.shotId,
        promptLength: p.promptCharCount || 0,

        hasScene: !!(p.scene && String(p.scene).trim().length > 8),
        hasMood: !!(p.mood && String(p.mood).trim().length > 1),
        hasCamera: camStr.trim().length > 5,
        hasLighting: lightStr.trim().length > 5,
        hasCharacter: !!(p.character && p.character !== 'NONE'),
        hasAction: !!(p.action && String(p.action).length > 3),
        hasTimeline: tlStr.trim().length > 3 || (Array.isArray(p.timeline) && p.timeline.length > 0),
        hasBackgroundSound: bgStr.trim().length > 3,
        hasPrompt: !!(p.prompt && String(p.prompt).length > 50),

        withinLimit: (p.promptCharCount || 0) <= this.config.maxPromptLength,

        // 【P1-11 修复】复用 isOpeningShot 统一片头判断
        isOpening: p.shotId === 'S00' || p.shotId === 'SC00' || p.shotId?.startsWith('S00-') || p.shotId?.startsWith('SC00-'),
        hasAudioLayer: p.shotId === 'S00' ? (!!p.audioLayerString && p.audioLayerString.length > 5) : true,
        hasTitleOverlay: p.shotId === 'S00' ? (!!p.titleOverlayString && p.titleOverlayString.length > 5) : true
      };

      // 对白/角色可为 NONE(无对白、无人物镜头),不强制;其余为核心必过项
      check.passed =
        check.hasScene && check.hasMood && check.hasCamera && check.hasLighting &&
        check.hasAction && check.hasTimeline && check.hasBackgroundSound &&
        check.hasPrompt && check.withinLimit && check.hasAudioLayer && check.hasTitleOverlay;

      checks.push(check);
    }

    const allPassed = checks.every(c => c.passed);
    return {
      passed: allPassed,
      checks,
      totalPrompts: prompts.length,
      passedCount: checks.filter(c => c.passed).length,
      failedFields: checks.filter(c => !c.passed).map(c => ({
        shotId: c.shotId,
        failed: Object.entries(c).filter(([k, v]) => k.startsWith('has') && !v).map(([k]) => k)
      }))
    };
  }
}

module.exports = { QualityGate };
