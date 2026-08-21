
/**
 * 规则降级引擎 (Rule Fallback Engine)
 * 
 * 职责：
 * - LLM 禁用时的规则模式生产路径
 * - LLM 失败时的兜底恢复
 * - 极简 Prompt 拼接
 */

const { FALLBACK_SCENES, renderFallbackAction } = require('../../../config/neutral-fallbacks');

class RuleFallbackEngine {
  constructor(options = {}) {
    this.log = options.logFn || console.log;
    this.config = options.config || { maxPromptLength: 2000 };
    this.agents = options.agents || {};
    this.llmModel = options.llmModel || 'kimi-k2p6';
  }

  /**
   * 规则模式完整生产路径(LLM 禁用时)
   */
  async produceViaRules(currentShots, adaptedBlueprint, result, startTime) {
    this.log('RULES', '启用规则引擎模式(LLM 已禁用)');
    
    // 这些需要在 ProductionEngine 中执行，这里返回标记让调用方处理
    return {
      mode: 'rules',
      shots: currentShots,
      needsQualityGate: true,
      needsOpening: this._shouldGenerateOpening(adaptedBlueprint),
      needsContinuity: true
    };
  }

  /**
   * 规则 Prompt 工程兜底(LLM PromptFusion 失败时)
   */
  async engineerPromptsFallback(shots, blueprint) {
    // 【2026-07-17 清理】_engineerPrompts 已删除，直接走极简拼接
    this.log('FALLBACK', `⚠️ _engineerPrompts 已移除，使用极简拼接兜底`);
    return shots.map(s => ({
      ...s,
      prompt: this.assemblePromptSimple(s),
      enhanced_prompt: this.assemblePromptSimple(s),
      negative_prompt: 'blurry, low quality, distorted, watermark, text, deformed, extra limbs'
    }));
  }

  /**
   * 极简 Prompt 拼接(最后兜底)
   * 【v2.1.11-重构】按 visual_register 分级写实校验
   */
  assemblePromptSimple(shot, options = {}) {
    const parts = [];
    
    // 【v2.1.11-重构】写实校验强度分级
    // 【v2.1.16-fix 镜头数0】require 路径修正：本文件位于 engines/production-engine/utils/，
    // ../../ 只能到 engines/（config 不存在），需要 ../../../ 才能到 hyperreality-system/config/
    // 该错误导致预算告急切换纯规则模式时整个生产崩溃、镜头数归零
    const { getRealismForbidden } = require('../../../config/production-profile');
    const visualRegister = options.visualRegister || shot.visual_register || 'realistic';
    const forbiddenWords = getRealismForbidden(visualRegister);
    
    // 场景写实检查（分级）
    let sceneDesc = shot.scene || '';
    if (forbiddenWords.scene.some(w => sceneDesc.includes(w))) {
      // 【修复 P0-3】领域中立兜底场景：从唯一真源读取
      const fallbackScenes = FALLBACK_SCENES;
      const idx = parseInt(shot.shotId?.replace(/\D/g, '') || '0') || 0;
      sceneDesc = fallbackScenes[idx % fallbackScenes.length];
    }
    if (sceneDesc) parts.push(sceneDesc);
    
    if (shot.visual_elements) parts.push(shot.visual_elements);
    if (shot.lighting) parts.push(shot.lighting);
    if (shot.camera_movement) parts.push(shot.camera_movement);
    
    // 动作写实检查（分级）
    let actionDesc = shot.action || '';
    if (forbiddenWords.action.some(w => actionDesc.includes(w))) {
      // 【v2.1.11-P1 修复】兜底动作用真实角色名插值，"示例角色"占位符不得进入生产 prompt
      const charName = (typeof shot.character === 'string' && shot.character !== 'NONE') ? shot.character : '人物';
      const idx = parseInt(shot.shotId?.replace(/\D/g, '') || '0') || 0;
      actionDesc = renderFallbackAction(charName, idx);
    }
    if (actionDesc) parts.push(actionDesc);
    
    if (shot.mood) parts.push(`atmosphere: ${shot.mood}`);
    
    // 【P2-9 修复】动态 require 加 try/catch，缺失时用内联默认值
    // 【修复 P0-3】require 路径修正：指向真实存在的全局负面提示词模块
    let globalNegativePromptInjector = null;
    try { globalNegativePromptInjector = require('../../../systems/global-negative-prompts.js').globalNegativePromptInjector; } catch (_) {
      try { globalNegativePromptInjector = require('../../../systems/global-negative-prompts.js'); } catch (__) {
        globalNegativePromptInjector = { generateForOpeningShot: () => 'no text, no watermark, no logo', generateForContentShot: () => 'no text, no watermark, no logo, no blurry' };
      }
    }
    const isOpeningSimple = shot.type === 'opening' || shot.sceneType === 'opening';
    const negativeSimple = isOpeningSimple
      ? globalNegativePromptInjector.generateForOpeningShot({ maxLength: 200 }).replace('【负面约束】', '')
      : globalNegativePromptInjector.generateForContentShot({ maxLength: 250 }).replace('【负面约束】', '');
    parts.push(negativeSimple);
    
    return parts.filter(Boolean).join(', ').slice(0, this.config.maxPromptLength);
  }

  _shouldGenerateOpening(adaptedBlueprint) {
    const _meta = adaptedBlueprint.config?._metadata || adaptedBlueprint._metadata || {};
    return _meta.isSeries ? (_meta.episodeNumber === 1) : (_meta.hasOpening !== false);
  }
}

module.exports = { RuleFallbackEngine };

