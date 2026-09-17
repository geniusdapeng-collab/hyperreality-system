'use strict';

/**
 * MarketingComplianceGuard（营销合规闸机）
 * ------------------------------------------------------------
 * 【v2.5.0 新增】社媒营销包 SocialPack · P1-7（阻断式，非警告）
 *
 * 三级词库：
 *   L1 广告法极限词（中文核心库）：绝对化用语，广告法第九条红线
 *   L2 英文欺骗性宣称（FTC/TikTok 广告政策）：保证式/奇迹式/绝对化表述
 *   L3 平台违禁（TikTok 特别条款）：前后对比医疗暗示、绝对折扣宣称等
 *
 * 检查范围（营销镜头）：【台词】【画面文字设计】【场景】【动作】四个
 * 面向观众的文字/口播载体——产品内部描述字段不查（避免误伤创作过程）。
 *
 * 判定级别：营销场景下命中即阻断（作为 PromptDeliveryGuard 场景链的一环）。
 */

const L1_CN_EXTREME = [
  '国家级', '最高级', '最佳', '最好', '最强', '第一品牌', '第一', '唯一', '顶级', '顶尖',
  '极致', '万能', '绝对', '永久', '永远', '100%', '百分之百', '纯天然', '无副作用',
  '无效退款', '根治', '治愈', '药到病除', '史上最', '全球领先', '世界领先', '销量第一',
  '全网最低', '最低价', '无敌', '必备神器', '神器', '特效', '速效'
];

const L2_EN_DECEPTIVE = [
  /#\s*1\b/i, /\bbest\s+ever\b/i, /\bguaranteed?\b/i, /\bmiracle\b/i, /\bcure[sd]?\b/i,
  /\b100\s*%/i, /\brisk[-\s]?free\b/i, /\bno\s+side\s+effects?\b/i, /\binstant\s+results?\b/i,
  /\bfree\s+money\b/i, /\bguarantee[sd]?\s+results?\b/i, /\bmagic\b/i, /\bsecret\s+trick\b/i
];

const L3_PLATFORM = [
  { pattern: /before\s*(and|&)\s*after/i, reason: '前后对比宣称（TikTok 健康/美妆品类高危）' },
  { pattern: / lowest\s+price\b/i, reason: '绝对低价宣称' },
  { pattern: /全网最低|史上最低/, reason: '绝对低价宣称' },
  { pattern: /点击.*立即购买|不买后悔|错过再等/, reason: '胁迫式促销话术' }
];

class MarketingComplianceGuard {
  /**
   * @param {string} promptText 镜头提示词
   * @param {object} [options] { lang: 'zh'|'en'|'both' }
   * @returns {{pass:boolean, hits:Array<{level:string, word:string, field:string, reason:string}>}}
   */
  check(promptText, options = {}) {
    const lang = options.lang || 'both';
    const hits = [];
    const fields = this._scanFields(promptText);

    for (const { name, body } of fields) {
      if (lang !== 'en') {
        for (const w of L1_CN_EXTREME) {
          if (body.includes(w)) hits.push({ level: 'L1广告法极限词', word: w, field: name, reason: '绝对化用语，广告法红线' });
        }
        for (const { pattern, reason } of L3_PLATFORM.filter(x => x.pattern.source.match(/[\u4e00-\u9fff]/))) {
          if (pattern.test(body)) hits.push({ level: 'L3平台违禁', word: String(pattern), field: name, reason });
        }
      }
      if (lang !== 'zh') {
        for (const re of L2_EN_DECEPTIVE) {
          const m = body.match(re);
          if (m) hits.push({ level: 'L2英文欺骗性宣称', word: m[0], field: name, reason: 'FTC/TikTok 广告政策禁止的保证式/绝对化表述' });
        }
        for (const { pattern, reason } of L3_PLATFORM.filter(x => !x.pattern.source.match(/[\u4e00-\u9fff]/))) {
          if (pattern.test(body)) hits.push({ level: 'L3平台违禁', word: String(pattern), field: name, reason });
        }
      }
    }
    return { pass: hits.length === 0, hits };
  }

  /** 只扫描面向观众的载体字段 */
  _scanFields(text) {
    const wanted = ['台词', '画面文字设计', '场景', '动作'];
    const out = [];
    const re = /【([^【】]{1,12})】([^【]*)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (wanted.includes(m[1])) out.push({ name: m[1], body: m[2] });
    }
    return out;
  }
}

module.exports = { MarketingComplianceGuard, L1_CN_EXTREME, L2_EN_DECEPTIVE, L3_PLATFORM };
