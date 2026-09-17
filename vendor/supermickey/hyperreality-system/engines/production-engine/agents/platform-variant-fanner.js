'use strict';

/**
 * PlatformVariantFanner（平台变体扇出器）
 * ------------------------------------------------------------
 * 【v2.7.0 新增】社媒营销包 SocialPack · M3 · P2-8
 *
 * 一次 Brief → N 个平台变体：共用故事骨架（skeleton shots），
 * 按平台 Profile 重排钩子/画幅/文案/节奏，产出变体矩阵交付。
 *
 * 扇出规则（全部确定性，可测试）：
 *   1) 时长重排：骨架镜头时长钳入平台时长带（shotDuration.min-max）
 *   2) 钩子策略：数据回流优先（HookPerformanceStore.recommend），
 *      无数据回退 Profile 默认钩子序列，证据随行（绝不虚构）
 *   3) 画幅/约束：constraintTemplateOf(profile) 重新派生
 *   4) 字幕/文案语言：profile.subtitleLanguage；台词本地化取自骨架 lines 映射，
 *      缺本地化的平台标"待本地化"（禁止拿英文台词冒充中文平台成品）
 *   5) CTA：brief.ctaTextByPlatform[平台] > 平台默认（按字幕语言）
 *   6) 文案风格：profile.copyStyle 写入变体头
 *
 * 输入骨架镜头：{ shotId, fn('hook'|'demo'|'cta'), duration, sellingPoint?,
 *   dialogueBlocks:[{start,end,action,emo}], lines:{ [platform]: 台词文本 } }
 */

const { PROFILES, resolveProfile, constraintTemplateOf, isSocialCommerce } = require('../../../config/platform-profiles.js');

class PlatformVariantFanner {
  /**
   * @param {object} [options] { feedbackStore: HookPerformanceStore 实例（可选） }
   */
  constructor(options = {}) {
    this._store = options.feedbackStore || null;
  }

  /**
   * 扇出
   * @param {object} brief 规范化 Brief
   * @param {object[]} skeletonShots 故事骨架镜头
   * @param {string[]} platforms 目标平台 key 列表
   * @returns {{matrix:object[], variants:Object<string,object[]>}}
   */
  fanOut(brief = {}, skeletonShots = [], platforms = []) {
    const matrix = [];
    const variants = {};
    for (const key of platforms) {
      const profile = resolveProfile({ platform: key }, {});
      if (!isSocialCommerce(profile)) continue; // 电影叙事不是变体扇出对象
      const hookPick = this._pickHook(key, profile);
      const shots = skeletonShots.map((s, idx) => this._variantShot(s, key, profile, brief, hookPick, idx));
      const totalDuration = shots.reduce((a, s) => a + s.duration, 0);
      variants[key] = shots;
      matrix.push({
        platform: key,
        name: profile.name,
        ratio: profile.ratio,
        shotCount: shots.length,
        totalDuration,
        hookStyle: hookPick.style,
        hookEvidence: hookPick.evidence,
        subtitleLanguage: profile.subtitleLanguage,
        ctaText: this._ctaFor(key, profile, brief),
        copyStyle: profile.copyStyle || ''
      });
    }
    return { matrix, variants };
  }

  /** 钩子策略：数据回流优先，无数据用 Profile 默认序 */
  _pickHook(platform, profile) {
    const fallback = (profile.hook && profile.hook.styles) || [];
    if (this._store) {
      const rec = this._store.recommend(platform, fallback);
      if (rec.length) return rec[0];
    }
    return { style: fallback[0] || 'pattern-interrupt', evidence: null };
  }

  _variantShot(skeleton, platform, profile, brief, hookPick, idx) {
    const band = profile.shotDuration || { min: 2, max: 5 };
    const base = Number(skeleton.duration) || band.max;
    const duration = Math.max(band.min, Math.min(band.max, base));
    const isHook = skeleton.fn === 'hook' || idx === 0;
    const line = (skeleton.lines && skeleton.lines[platform]) || null;
    const dialogueBlocks = (skeleton.dialogueBlocks || []).map(b => ({
      ...b,
      line: line || b.line || '',
      localized: !!line
    }));
    return {
      ...skeleton,
      platform,
      duration: Math.min(duration, band.max),
      isFinal: skeleton.fn === 'cta' ? true : !!skeleton.isFinal,
      blueprint: { platform },
      constraintTemplate: constraintTemplateOf(profile),
      hookStrategy: isHook ? { style: hookPick.style, evidence: hookPick.evidence } : null,
      subtitleLanguage: profile.subtitleLanguage,
      ctaText: skeleton.fn === 'cta' ? this._ctaFor(platform, profile, brief) : null,
      copyStyle: profile.copyStyle || '',
      dialogueBlocks,
      _needsLocalization: dialogueBlocks.some(b => b.localized === false && b.line)
    };
  }

  _ctaFor(platform, profile, brief) {
    if (brief.ctaTextByPlatform && brief.ctaTextByPlatform[platform]) return brief.ctaTextByPlatform[platform];
    if (brief.ctaText && platform === brief.platform) return brief.ctaText;
    return profile.subtitleLanguage === 'en' ? 'Follow for more · Link in bio' : '点关注，不迷路';
  }

  /** 变体矩阵渲染为 Markdown 表（交付物） */
  renderMatrixTable(matrix) {
    const head = '| 平台 | 画幅 | 镜数 | 总时长 | 钩子策略 | 数据证据 | 字幕语言 | CTA | 文案风格 |\n|---|---|---|---|---|---|---|---|---|';
    const rows = matrix.map(m =>
      `| ${m.name} | ${m.ratio} | ${m.shotCount} | ${m.totalDuration}s | ${m.hookStyle} | ${m.hookEvidence || '无数据·默认序'} | ${m.subtitleLanguage} | ${m.ctaText} | ${m.copyStyle} |`
    );
    return [head, ...rows].join('\n');
  }
}

module.exports = { PlatformVariantFanner };
