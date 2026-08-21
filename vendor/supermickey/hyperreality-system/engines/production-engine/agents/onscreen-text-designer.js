'use strict';

/**
 * OnscreenTextDesigner（画面文字设计器）
 * ------------------------------------------------------------
 * 【v2.5.0 新增】社媒营销包 SocialPack · P0-3（重点模块）
 *
 * 电影叙事包的纪律是"全画面禁字"；社媒营销片恰恰相反——
 * 文字层是转化武器。本模块为营销镜头设计【画面文字设计】字段，
 * 三层文字体系：
 *
 *   1) 字幕条 subtitle    —— 与台词/旁白同步，安全区底部上方，平台原生样式
 *   2) 卖点花字 flower    —— ≤12字的卖点短句，配合演示节拍弹出，动效入场
 *   3) CTA 收尾字 cta     —— 尾镜强制在场（平台规则要求时），品牌色，≥1.5秒停留
 *
 * 设计约束（守卫可校验的硬规则）：
 *   - 所有文字时间戳不得超出镜头时长
 *   - 必须声明安全区位置（避开平台 UI 遮挡区，见 platform-profiles.safeArea）
 *   - 花字单条 ≤12 字（移动端 1 秒可读上限）
 *   - CTA 文字须在尾镜且停留 ≥1.5 秒
 *   - 字幕语言按平台 Profile（TikTok=en, 抖音/小红书=zh）
 *
 * 产出形态：结构化 layers（供守卫校验）+ 字段文本（供渲染提示词）。
 * 文案本身可由 LLM 润色（fusion 环节），本模块保证骨架与纪律永远合规。
 */

class OnscreenTextDesigner {
  /**
   * @param {object} shot 镜头数据（shotId/duration/dialogueBlocks/isFinal）
   * @param {object} profile 平台 Profile（platform-profiles.resolveProfile 结果）
   * @param {object} brief 营销 Brief（sellingPoints/brand/ctaText，可为空）
   * @returns {{fieldText:string, layers:object}}
   */
  design(shot = {}, profile = {}, brief = {}) {
    const duration = Number(shot.duration) || 5;
    const layers = { subtitle: [], flower: [], cta: [] };

    // ---- 1) 字幕条：跟随台词块 ----
    const dlgBlocks = Array.isArray(shot.dialogueBlocks) ? shot.dialogueBlocks : [];
    for (const b of dlgBlocks) {
      const start = this._secOf(b.start, 0, duration);
      const end = this._secOf(b.end, duration, duration);
      layers.subtitle.push({
        text: b.line || b.text || '',
        start, end,
        position: '安全区内底部上方（避开平台文案遮挡区）',
        style: this._subtitleStyle(profile)
      });
    }

    // ---- 2) 卖点花字：分配到镜头演示节拍 ----
    const points = Array.isArray(brief.sellingPoints) ? brief.sellingPoints.filter(Boolean).slice(0, 3) : [];
    const flowerPoint = shot.sellingPoint || (points.length ? points[this._hash(shot.shotId) % points.length] : null);
    if (flowerPoint) {
      const text = String(flowerPoint).slice(0, 12);
      layers.flower.push({
        text,
        start: Math.min(1, duration - 2),
        end: duration,
        position: '画面上 1/3 安全区内，主体侧方留白处',
        style: this._flowerStyle(profile, brief.brand)
      });
    }

    // ---- 3) CTA 收尾字：尾镜且平台要求时强制 ----
    if (shot.isFinal && profile.cta && profile.cta.required) {
      layers.cta.push({
        text: brief.ctaText || (profile.subtitleLanguage === 'en' ? 'Follow for more · Link in bio' : '点关注，不迷路'),
        start: Math.max(0, duration - 2),
        end: duration,
        position: '画面中央安全区内',
        style: this._ctaStyle(profile, brief.brand),
        minHoldSec: 1.5
      });
    }

    return { fieldText: this._renderField(layers, shot, profile), layers };
  }

  _secOf(v, fallback, duration) {
    const n = Number(v);
    if (!isFinite(n)) return fallback;
    return Math.max(0, Math.min(duration, n));
  }

  _hash(s) {
    return String(s || 'S0').split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  }

  _subtitleStyle(profile) {
    return profile.subtitleLanguage === 'en'
      ? 'TikTok 原生字幕样式：白色粗体无衬线、黑色描边、关键词黄色高亮，逐词卡拉OK式点亮'
      : '平台原生字幕样式：白色粗体、黑色描边、关键词彩色高亮，逐词点亮';
  }

  _flowerStyle(profile, brand = {}) {
    const color = brand.color || (profile.subtitleLanguage === 'en' ? '品牌主色' : '品牌主色');
    return `卖点花字：${color}描边白字，弹跳入场动效（0.2秒回弹），带轻微投影，移动端一屏可读`;
  }

  _ctaStyle(profile, brand = {}) {
    const color = brand.color || '品牌主色';
    return `CTA 收尾字：${color}纯色底块+白色粗体，呼吸灯式微缩放，停留不少于 1.5 秒`;
  }

  _renderField(layers, shot, profile) {
    const parts = [];
    for (const s of layers.subtitle) {
      parts.push(`字幕条[${s.start}s-${s.end}s] "${s.text}"（${s.position}；${s.style}）`);
    }
    for (const f of layers.flower) {
      parts.push(`卖点花字[${f.start}s-${f.end}s] "${f.text}"（${f.position}；${f.style}）`);
    }
    for (const c of layers.cta) {
      parts.push(`CTA收尾字[${c.start}s-${c.end}s] "${c.text}"（${c.position}；${c.style}）`);
    }
    if (parts.length === 0) return '';
    const safe = profile.safeArea ? `；全程遵守安全区：${profile.safeArea.note}` : '';
    return parts.join('；') + safe;
  }
}

module.exports = { OnscreenTextDesigner };
