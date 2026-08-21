/**
 * MicroMotion System v1.0-Peng — 主入口
 * 编排5路Agent流水线：面部雕塑 → 身体语言 → 眼神指导 → 呼吸引擎 → 融合官
 *
 * 接入点: seedance-adapter之后 → Seedance API之前
 */

const { FaceSculptorAgent } = require('../agents/face-sculptor');
const { BodyLanguageAgent } = require('../agents/body-language');
const { EyeDirectorAgent } = require('../agents/eye-director');
const { BreathEngineAgent } = require('../agents/breath-engine');
const { MergeAgent } = require('../agents/merge');

class MicroMotionSystem {
  constructor(options = {}) {
    this.faceSculptor = new FaceSculptorAgent();
    this.bodyLanguage = new BodyLanguageAgent();
    this.eyeDirector = new EyeDirectorAgent();
    this.breathEngine = new BreathEngineAgent();
    this.mergeAgent = new MergeAgent();

    this.outputDir = options.outputDir || './output/micromotion';
    this.debug = options.debug || false;
  }

  /**
   * 增强单个镜头
   * @param {Object} shot - 镜头对象
   * @param {Object} context - 上下文
   * @returns {Object} 增强结果
   */
  enhance(shot, context = {}) {
    if (this.debug) console.log(`[MicroMotion] 增强镜头: ${shot.shotId}`);

    // ===== Agent流水线 =====
    // Agent 1: 面部雕塑
    const faceEnhancement = this.faceSculptor.enhance(shot, context);
    if (this.debug) console.log(`  [FaceSculptor] 情绪:${faceEnhancement.emotion} 强度:${faceEnhancement.intensity}`);

    // Agent 2: 身体语言
    const bodyEnhancement = this.bodyLanguage.enhance(shot, context);
    if (this.debug) console.log(`  [BodyLanguage] 微动作:${bodyEnhancement.microActions?.length || 0}个`);

    // Agent 3: 眼神指导
    const eyeEnhancement = this.eyeDirector.enhance(shot, context);
    if (this.debug) console.log(`  [EyeDirector] 眼神类型:${eyeEnhancement.eyeType}`);

    // Agent 4: 呼吸引擎
    const breathEnhancement = this.breathEngine.enhance(shot, context);
    if (this.debug) console.log(`  [BreathEngine] 呼吸模式:${breathEnhancement.pattern}`);

    // Agent 5: 融合官
    const enhancements = {
      face: faceEnhancement,
      body: bodyEnhancement,
      eye: eyeEnhancement,
      breath: breathEnhancement
    };

    const merged = this.mergeAgent.merge(shot, enhancements);
    if (this.debug) console.log(`  [Merge] 增强后:${merged.enhanced?.length || 0}字符 特效:${merged.specialEffects?.length || 0}`);

    return {
      shotId: shot.shotId,
      original: shot.originalPrompt || '',
      enhanced: merged.enhanced,
      agents: merged.enhancementSummary,
      specialEffects: merged.specialEffects,
      enhancementMetadata: {
        face: { emotion: faceEnhancement.emotion, intensity: faceEnhancement.intensity },
        body: { stance: bodyEnhancement.stance, microActions: bodyEnhancement.microActions?.length },
        eye: { eyeType: eyeEnhancement.eyeType },
        breath: { pattern: breathEnhancement.pattern, visualCue: !!breathEnhancement.visualCue }
      }
    };
  }

  /**
   * 批量增强
   * @param {Array} shots - 镜头数组
   * @param {Object} context - 全局上下文
   * @returns {Object} { results, stats }
   */
  enhanceBatch(shots, context = {}) {
    const results = [];
    let totalAdded = 0;

    for (const shot of shots) {
      try {
        const result = this.enhance(shot, context);
        results.push(result);
        totalAdded += (result.enhanced?.length || 0) - (result.original?.length || 0);
      } catch (e) {
        console.error(`[MicroMotion] 镜头 ${shot.shotId} 增强失败:`, e.message);
        results.push({
          shotId: shot.shotId,
          original: shot.originalPrompt || '',
          enhanced: shot.originalPrompt || '',
          error: e.message
        });
      }
    }

    const stats = {
      total: results.length,
      enhanced: results.filter(r => r.enhanced && r.enhanced !== r.original).length,
      failed: results.filter(r => r.error).length,
      avgAdded: results.length > 0 ? Math.round(totalAdded / results.length) : 0,
      totalAdded
    };

    return { results, stats };
  }
}

module.exports = { MicroMotionSystem };
