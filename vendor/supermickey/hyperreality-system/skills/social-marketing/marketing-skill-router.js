'use strict';

/**
 * MarketingSkillRouter（社媒营销技能路由）
 * ------------------------------------------------------------
 * 【v2.6.0 新增】社媒营销包 SocialPack · P1-5
 *
 * 与好莱坞摄影技能库正交的营销技能域（domain='marketing'，type='marketing'）。
 * 摄影技能按"片种×导演×情绪×运镜"路由；营销技能按"职能×风格×平台×目标"路由：
 *
 *   fn       镜头职能：hook钩子 / demo演示 / ugc伪原生 / seeding种草 / editing剪辑 / cta收尾
 *   style    技法风格：question / data-shock / before-after / beat-cut / follow ...
 *   platform 适用平台：tiktok / douyin / xiaohongshu / instagram-reels
 *   goal     转化目标：seeding / traffic / conversion
 *
 * 匹配纪律（与主库一致）：必须用镜头真实元数据运行匹配，禁止虚构技能命中。
 */

const fs = require('fs');
const path = require('path');

const SKILL_DIR = path.join(__dirname, 'skills');
const INDEX_PATH = path.join(__dirname, 'skills-index.json');

class MarketingSkillRouter {
  constructor() {
    this._index = null;
  }

  _load() {
    if (this._index) return this._index;
    const data = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
    this._index = data.skills;
    return this._index;
  }

  /**
   * 按镜头营销元数据匹配技能
   * @param {object} meta { fn, style?, platform?, goal?, category? }
   * @param {number} [limit=3]
   * @returns {Array<{skill:object, score:number, reasons:string[]}>}
   */
  match(meta = {}, limit = 3) {
    const skills = this._load();
    const scored = [];
    // 【v2.10.0】品类适配：服务/虚拟类 Brief 不命中实物专属技能（如开箱/材质特写）
    const serviceLike = /服务|课程|培训|咨询|旅游|本地生活|到店|家政|维修|金融|保险|医疗|医美|健身|教育|软件|SaaS|APP|App|应用|平台|办公|云/.test(String(meta.category || ''));
    for (const skill of skills) {
      if (serviceLike && Array.isArray(skill.categories) && skill.categories.includes('physical') && !skill.categories.includes('service')) {
        continue; // 实物专属技能对服务/虚拟类出局
      }
      let score = 0;
      const reasons = [];
      if (meta.fn && skill.fn === meta.fn) { score += 10; reasons.push(`fn:${meta.fn}`); }
      else if (meta.fn) { continue; } // 职能不符直接出局（营销镜头职能是硬约束）
      if (meta.style && skill.style === meta.style) { score += 6; reasons.push(`style:${meta.style}`); }
      if (meta.platform && skill.platforms.includes(meta.platform)) { score += 3; reasons.push(`platform:${meta.platform}`); }
      if (meta.goal && skill.goals.includes(meta.goal)) { score += 2; reasons.push(`goal:${meta.goal}`); }
      if (score > 0) scored.push({ skill, score, reasons });
    }
    scored.sort((a, b) => b.score - a.score || a.skill.skill_id.localeCompare(b.skill.skill_id));
    return scored.slice(0, limit);
  }

  /**
   * 读取技能文件的执行要点与禁忌（供注入镜头生成上下文）
   * @param {string} file 技能文件名
   * @returns {{execution:string[], taboo:string[], oneLiner:string}}
   */
  extractEnhancement(file) {
    const full = path.join(SKILL_DIR, file);
    const content = fs.readFileSync(full, 'utf8');
    const grab = (marker, next) => {
      const i = content.indexOf(marker);
      if (i < 0) return '';
      const j = next ? content.indexOf(next, i) : -1;
      return content.slice(i + marker.length, j > 0 ? j : undefined).trim();
    };
    const bullets = s => s.split('\n').map(l => l.replace(/^[-\d.*\s]+/, '').trim()).filter(Boolean);
    return {
      execution: bullets(grab('## 镜头执行要点', '## 禁忌')),
      taboo: bullets(grab('## 禁忌（并入【负面约束】）')),
      oneLiner: (content.match(/\*\*定位\*\*[:：](.+)/) || [])[1] || ''
    };
  }

  /** 全量技能清单（供测试与审计） */
  listAll() {
    return this._load();
  }
}

module.exports = { MarketingSkillRouter, SKILL_DIR, INDEX_PATH };
