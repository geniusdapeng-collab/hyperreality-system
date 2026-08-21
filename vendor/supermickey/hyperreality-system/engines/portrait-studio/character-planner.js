'use strict';

/**
 * CharacterPortraitPlanner — 角色定妆照规划器
 * ------------------------------------------------------------
 * 职责：从剧本角色系统 + 镜头提示词中识别主要角色，
 * 按戏份重要性分级（lead/supporting/cameo），
 * 为每个角色分配角度包，并逐角度构建完整生成 prompt。
 *
 * prompt 构建三层锚定（与镜头提示词视觉系统强制对齐）：
 *   1) 角色档案层  —— 外观/材质/服饰/标志性特征，来自角色卡与剧本描述
 *   2) 视觉系统层  —— PRD 的色调/光影/氛围/渲染风格锚点
 *   3) 一致性锁层  —— 解剖锁/形态锁/面部锁，保证多角度间零漂移
 */

const { getCharacterAnglePackage } = require('./angle-catalog');

// 一致性锁（与 character-portrait-generator v3.0 体系同源，蒸馏为通用版）
const CONSISTENCY_LOCKS = {
  anatomical: 'STRICT anatomical consistency across all views: identical body structure, same limbs count, same proportions, no morphological drift between angles',
  morphology: 'uniform body contour locked to description, consistent volume and silhouette across all angles, proportions permanently fixed',
  face: 'SAME face across all angles, identical facial features in every shot, same eyes same nose same mouth, face locked to reference, no ethnicity drift'
};

class CharacterPortraitPlanner {
  /**
   * @param {Object} options
   * @param {number} options.leadShotRatio      自动升主角判定：戏份占比 >= 该值（默认 0.5，主角档位保持稀缺）
   * @param {number} options.supportingShotRatio 配角判定：戏份占比 >= 该值（默认 0.08）
   * @param {number} options.maxCameo           客串角色最多纳入数量（默认 3，防止长尾爆炸）
   */
  constructor(options = {}) {
    this.leadShotRatio = options.leadShotRatio || 0.5;
    this.supportingShotRatio = options.supportingShotRatio || 0.08;
    this.maxCameo = options.maxCameo || 3;
  }

  /**
   * 规划全部角色的定妆照任务
   * @param {Object} context
   * @param {Array}  context.characters  角色定义数组（PRD/剧本角色系统）
   * @param {Array}  context.prompts     镜头提示词数组（用于戏份统计）
   * @param {Object} context.visualStyle 视觉系统锚点 { tone, lighting, atmosphere, renderStyle, colorScript }
   * @returns {Array} 角色定妆照任务数组
   */
  plan(context = {}) {
    const characters = this._normalizeCharacters(context.characters || []);
    if (characters.length === 0) return [];

    const prompts = context.prompts || [];
    const visualStyle = context.visualStyle || {};

    // 1) 戏份统计
    const scored = characters.map(c => ({
      ...c,
      _shotCount: this._countAppearances(c, prompts),
      _hasDialogue: this._hasDialogue(c, prompts)
    }));
    const totalShots = Math.max(prompts.length, 1);

    // 2) 重要性分级
    const tiered = scored.map(c => ({
      ...c,
      _tier: this._assignTier(c, totalShots)
    }));

    // 3) 客串限量（按戏份从高到低截断）
    const leads = tiered.filter(c => c._tier === 'lead');
    const supportings = tiered.filter(c => c._tier === 'supporting');
    const cameos = tiered.filter(c => c._tier === 'cameo')
      .sort((a, b) => b._shotCount - a._shotCount)
      .slice(0, this.maxCameo);
    const selected = [...leads, ...supportings, ...cameos];

    // 4) 逐角色逐角度构建任务
    return selected.map(c => this._buildCharacterTask(c, visualStyle));
  }

  // ========== 内部方法 ==========

  _normalizeCharacters(characters) {
    return characters
      .map(c => {
        if (typeof c === 'string') return { id: c, name: c, role: 'unknown', description: '' };
        return {
          id: c.id || c.characterId || c.name || '',
          name: c.name || c.id || c.characterId || '',
          role: c.role || c.characterType || (c.isProtagonist ? 'protagonist' : 'unknown'),
          description: c.visual_anchor || c.appearance || c.description || c.profile || '',
          isProtagonist: c.isProtagonist === true || c.role === 'protagonist' || c.role === '主角',
          species: c.species || c.type || ''
        };
      })
      .filter(c => c.name);
  }

  _countAppearances(character, prompts) {
    let count = 0;
    for (const p of prompts) {
      const text = `${p.prompt || ''} ${p.characterRef || ''} ${p.subject || ''} ${p.description || ''}`;
      if (text.includes(character.name) || (character.id && text.includes(character.id))) count++;
    }
    return count;
  }

  _hasDialogue(character, prompts) {
    return prompts.some(p => {
      const dialogue = p.dialogue || p.台词 || '';
      return typeof dialogue === 'string' && dialogue.includes(character.name);
    });
  }

  _assignTier(character, totalShots) {
    // 显式主角标记优先
    if (character.isProtagonist) return 'lead';
    const ratio = character._shotCount / totalShots;
    if (ratio >= this.leadShotRatio) return 'lead';
    // 配角：至少 2 次出场且占比达标，或多次出场且有台词
    if ((character._shotCount >= 2 && ratio >= this.supportingShotRatio) ||
        (character._shotCount >= 2 && character._hasDialogue)) return 'supporting';
    return 'cameo';
  }

  _buildCharacterTask(character, visualStyle) {
    const angles = getCharacterAnglePackage(character._tier);
    const styleBlock = this._buildStyleBlock(visualStyle);

    return {
      taskType: 'character',
      characterId: character.id,
      characterName: character.name,
      tier: character._tier,
      shotCount: character._shotCount,
      angleCount: angles.length,
      portraits: angles.map(angle => ({
        portraitId: `${character.id || character.name}-${angle.id}`,
        angle: angle.id,
        angleName: angle.name,
        purpose: angle.purpose,
        priority: angle.priority,
        prompt: this._buildPortraitPrompt(character, angle, styleBlock),
        consistencyLocks: { ...CONSISTENCY_LOCKS },
        status: 'pending',
        outputFile: null
      }))
    };
  }

  _buildStyleBlock(visualStyle) {
    const parts = [];
    if (visualStyle.renderStyle) parts.push(visualStyle.renderStyle);
    if (visualStyle.tone) parts.push(`色调：${visualStyle.tone}`);
    if (visualStyle.lighting) parts.push(`光影：${visualStyle.lighting}`);
    if (visualStyle.atmosphere) parts.push(`氛围：${visualStyle.atmosphere}`);
    if (visualStyle.colorScript) parts.push(`色彩脚本：${visualStyle.colorScript}`);
    return parts.join('，');
  }

  _buildPortraitPrompt(character, angle, styleBlock) {
    const desc = character.description || `${character.name}，${character.species || '角色'}`;
    const sections = [
      `【定妆照】${character.name} — ${angle.name}`,
      `角色档案：${desc}`,
      `构图：${angle.framing}`,
      styleBlock ? `视觉系统：${styleBlock}` : null,
      `一致性：${CONSISTENCY_LOCKS.anatomical}; ${CONSISTENCY_LOCKS.face}`,
      '规范：角色定妆照，纯色或极简环境背景，主体完整入画，无文字无水印，商业级形象照品质'
    ].filter(Boolean);
    return sections.join('\n');
  }
}

module.exports = { CharacterPortraitPlanner, CONSISTENCY_LOCKS };
