/**
 * 质量门 (Quality Gate)
 * 
 * 职责：
 * - 检查镜头字段完整性与格式
 * - 检查提示词长度限制
 * - 片头专属检查
 */

const PromptLengthConfig = require('../../../config/prompt-length.js');

class QualityGate {
  constructor(config = {}) {
    // 【修复 P1-1】未显式传入时回退到唯一真源，不再使用孤立的 2000
    this.config = { maxPromptLength: PromptLengthConfig.HARD_MAX, ...config };
  }

  /**
   * 【审计修复·P0】增强型质量检查，防止空白/占位符通过
   * 【接线3 修复】支持从 PRD deliveryStandard 读取验收阈值
   */
  run(prompts, prd = null) {
    // 【接线3 修复】从 PRD 提取验收阈值
    const prdThresholds = prd?.deliveryStandard?.acceptanceCriteria 
      || prd?.acceptanceCriteria 
      || null;
    const scoreThreshold = prdThresholds ? 
      Math.round(((prdThresholds.visual || 0.75) + (prdThresholds.narrative || 0.75)) / 2 * 100) : 30;
    
    const checks = [];
    for (const p of prompts) {
      // 【P1-11 修复】改读25字段标准名，兼容camelCase和旧xxxString
      const camStr = String(
        p.camera_movement || p.cameraMovement || p.cameraString
        || (typeof p.camera === 'string' ? p.camera : '') || ''
      );
      const lightStr = String(
        (typeof p.lighting === 'string' ? p.lighting : '')
        || p.lightingString
        || (p.lighting && typeof p.lighting === 'object' ? JSON.stringify(p.lighting) : '') || ''
      );
      const tlStr = String(
        (typeof p.timeline === 'string' ? p.timeline : '')
        || p.timelineString
        || (Array.isArray(p.timeline) ? JSON.stringify(p.timeline) : '') || ''
      );
      // 【审计修复】支持对象类型的 backgroundSound
      let bgStr = '';
      if (p.backgroundSoundString) bgStr = String(p.backgroundSoundString);
      else if (typeof p.backgroundSound === 'string') bgStr = p.backgroundSound;
      else if (p.backgroundSound && typeof p.backgroundSound === 'object') {
        bgStr = JSON.stringify(p.backgroundSound);
      }

      // 【审计修复】语义质量评分（0-100）
      const sceneScore = this._scoreField(p.scene, { minLen: 8, requireChinese: true });
      const moodScore = this._scoreField(p.mood, { minLen: 2 });
      const cameraScore = this._scoreField(camStr, { minLen: 5, requireKeywords: ['推', '拉', '摇', '移', '跟', '固定', '推轨', 'pan', 'track', 'static', 'push', 'pull'] });
      const lightingScore = this._scoreField(lightStr, { minLen: 5, requireKeywords: ['光', 'light', '照明', 'illumination'] });
      const actionScore = this._scoreField(p.action, { minLen: 3 });
      const timelineScore = this._scoreField(tlStr, { minLen: 3, requireKeywords: ['T00', '秒', 's', 'start'] });
      const promptScore = this._scoreField(p.prompt, { minLen: 50 });

      const check = {
        shotId: p.shotId,
        promptLength: p.promptCharCount || 0,

        // 【审计修复】使用质量评分替代简单的布尔值
        hasScene: sceneScore.passed,
        sceneQuality: sceneScore.score,
        hasMood: moodScore.passed,
        moodQuality: moodScore.score,
        hasCamera: cameraScore.passed,
        cameraQuality: cameraScore.score,
        hasLighting: lightingScore.passed,
        lightingQuality: lightingScore.score,
        hasCharacter: !!(p.character && p.character !== 'NONE' && String(p.character).trim().length > 0),
        hasAction: actionScore.passed,
        actionQuality: actionScore.score,
        hasTimeline: timelineScore.passed,
        timelineQuality: timelineScore.score,
        hasBackgroundSound: bgStr.trim().length > 3,
        hasPrompt: promptScore.passed,
        promptQuality: promptScore.score,
        withinLimit: (p.promptCharCount || (typeof p.prompt === 'string' ? p.prompt.length : 0)) <= this.config.maxPromptLength,

        // 【P1-11 修复】复用 isOpeningShot 统一片头判断
        isOpening: p.shotId === 'S00' || p.shotId === 'SC00' || p.shotId?.startsWith('S00-') || p.shotId?.startsWith('SC00-'),
        hasAudioLayer: p.shotId === 'S00' ? (!!p.audioLayerString && p.audioLayerString.length > 5) : true,
        hasTitleOverlay: p.shotId === 'S00' ? (!!p.titleOverlayString && p.titleOverlayString.length > 5) : true,

        // 【v2.1.11-P1 修复】占位符红线：兜底占位符永远到不了渲染端
        hasPlaceholder: typeof p.prompt === 'string' && /示例角色|角色[AB]\b|\[角色名\]|\[角色设定服装\]/.test(p.prompt),
        // 【审计修复·2026-07-17】综合质量分数（0-100）— 加权评分：prompt 30% / scene+camera+lighting 各 15% / mood+action 各 10% / timeline 5%
        overallScore: Math.round(
          promptScore.score * 0.30 +
          sceneScore.score * 0.15 +
          cameraScore.score * 0.15 +
          lightingScore.score * 0.15 +
          moodScore.score * 0.10 +
          actionScore.score * 0.10 +
          timelineScore.score * 0.05
        )
      };

      // 【审计修复】综合通过条件：既有基础检查通过，又有质量分数阈值
      // 【接线3 修复】使用 PRD 阈值（如有）替代硬编码 30 分
      check.passed =
        check.hasScene && check.hasMood && check.hasCamera && check.hasLighting &&
        check.hasAction && check.hasTimeline && check.hasBackgroundSound &&
        check.hasPrompt && check.withinLimit && check.hasAudioLayer && check.hasTitleOverlay &&
        !check.hasPlaceholder && // 【v2.1.11-P1】占位符红线：含"示例角色"等占位符直接判 fail
        check.overallScore >= scoreThreshold; // PRD 阈值底线

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
        overallScore: c.overallScore,
        failed: Object.entries(c).filter(([k, v]) => k.startsWith('has') && !v).map(([k]) => k)
      }))
    };
  }

  /**
   * 【审计修复·P0】字段语义质量评分
   * 返回 { passed: boolean, score: number(0-100) }
   */
  _scoreField(value, options = {}) {
    const str = String(value || '').trim();
    let score = 0;

    // 基础长度分（最高40分）
    if (str.length >= (options.minLen || 1)) {
      score += Math.min(40, str.length * 2);
    }

    // 非空白字符分（最高30分）：纯空格的字符串在这里得分低
    const meaningfulChars = str.replace(/\s/g, '').length;
    score += Math.min(30, meaningfulChars * 2);

    // 中文内容分（最高15分）
    const chineseChars = (str.match(/[\u4e00-\u9fff]/g) || []).length;
    if (options.requireChinese) {
      score += Math.min(15, chineseChars * 2);
    } else {
      score += Math.min(15, chineseChars + (meaningfulChars > 0 ? 5 : 0));
    }

    // 关键词分（最高15分）
    if (options.requireKeywords && options.requireKeywords.length > 0) {
      const hasKeyword = options.requireKeywords.some(kw => str.toLowerCase().includes(kw.toLowerCase()));
      score += hasKeyword ? 15 : 0;
    } else {
      score += meaningfulChars > 5 ? 15 : 0;
    }

    // 空白字符占比惩罚：纯空格或空白占比>50%的，分数打折
    const spaceRatio = str.length > 0 ? (str.match(/\s/g) || []).length / str.length : 1;
    if (spaceRatio > 0.5) {
      score = Math.floor(score * 0.3);
    }

    return {
      passed: score >= 20 && str.length >= (options.minLen || 1),
      score: Math.min(100, score)
    };
  }
}

module.exports = { QualityGate };