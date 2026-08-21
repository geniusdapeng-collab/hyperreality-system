'use strict';

/**
 * EvidenceLedger — 证据账本
 * ------------------------------------------------------------
 * 珍妮纺织机的反虚构基石。所有 Agent 产出的每一条事实/观点，
 * 都必须先把来源登记进账本，拿到证据编号后才能写进 payload。
 *
 * 账本能力：
 *   1. 登记：来源 URL / 采集日期 / 登记 Agent / 渠道类型
 *   2. 渠道分级：official（官网/旗舰店/官方社媒）> ecommerce（电商详情/评价）
 *      > community（社媒/问答/论坛）> unknown —— 供 A4 置信度裁决
 *   3. 独立性判定：同域名视为同一来源（防止"一个帖子转发十次算十个来源"）
 *   4. 导出：装订时生成档案 provenance 数组
 */

const OFFICIAL_HOST_HINTS = /(官网|official|旗舰店|tmall\.com.*旗舰|jd\.com.*自营|品牌)/i;

class EvidenceLedger {
  constructor() {
    this._entries = [];
    this._seq = 0;
  }

  /**
   * 判定渠道级别
   * @param {string} channel 执行方回填的渠道描述（如"天猫旗舰店商品页"）
   * @param {string} url
   */
  classifyChannel(channel = '', url = '') {
    const text = `${channel} ${url}`;
    if (OFFICIAL_HOST_HINTS.test(text)) return 'official';
    if (/taobao|tmall|jd\.com|pinduoduo|amazon|ebay|suning|电商|评价|评论/i.test(text)) return 'ecommerce';
    if (/xiaohongshu|小红书|zhihu|知乎|weibo|微博|douyin|抖音|tiktok|bilibili|贴吧|论坛|社区|笔记/i.test(text)) return 'community';
    return 'unknown';
  }

  /**
   * 登记一条证据
   * @param {object} e
   * @param {string} e.claimRef 该证据支撑的事实定位（如 "identity.price_band" / "voc.praise:续航"）
   * @param {string} e.sourceUrl 来源 URL（无 URL 的来源须说明 origin，如"用户提供的商品页截图"）
   * @param {string} [e.origin]  无 URL 时的来源说明
   * @param {string} e.agent     登记 Agent
   * @param {string} [e.channel] 渠道描述
   * @param {string} [e.fetchedAt] 采集日期（ISO），缺省取当前时间
   * @returns {string} 证据编号 EV-XXXX
   */
  register(e = {}) {
    if (!e.claimRef) throw new Error('[EvidenceLedger] 登记证据必须提供 claimRef');
    if (!e.sourceUrl && !e.origin) throw new Error('[EvidenceLedger] 证据必须有 sourceUrl 或 origin 说明');
    const id = `EV-${(++this._seq).toString().padStart(4, '0')}`;
    this._entries.push({
      id,
      claim_ref: e.claimRef,
      source_url: e.sourceUrl || null,
      origin: e.origin || null,
      channel: e.channel || '',
      channel_class: this.classifyChannel(e.channel, e.sourceUrl),
      host: this._hostOf(e.sourceUrl),
      agent: e.agent || 'unknown',
      fetched_at: e.fetchedAt || new Date().toISOString()
    });
    return id;
  }

  _hostOf(url) {
    if (!url) return null;
    const m = String(url).match(/^[a-z]+:\/\/([^/?#]+)/i);
    return m ? m[1].toLowerCase() : null;
  }

  /** 某条事实定位下的全部证据 */
  forClaim(claimRef) {
    return this._entries.filter(x => x.claim_ref === claimRef);
  }

  /**
   * 独立来源计数（按 host 去重；无 URL 的 origin 每个算独立）
   */
  independentSourceCount(claimRef) {
    const entries = this.forClaim(claimRef);
    const hosts = new Set();
    let originCount = 0;
    for (const e of entries) {
      if (e.host) hosts.add(e.host); else originCount += 1;
    }
    return hosts.size + originCount;
  }

  /** 是否含官方级来源 */
  hasOfficialSource(claimRef) {
    return this.forClaim(claimRef).some(e => e.channel_class === 'official');
  }

  /** 导出为档案 provenance 数组 */
  export() {
    return this._entries.map(e => ({
      evidence_id: e.id,
      claim_ref: e.claim_ref,
      source_url: e.source_url,
      origin: e.origin,
      channel: e.channel,
      channel_class: e.channel_class,
      agent: e.agent,
      fetched_at: e.fetched_at
    }));
  }

  stats() {
    const byClass = { official: 0, ecommerce: 0, community: 0, unknown: 0 };
    for (const e of this._entries) byClass[e.channel_class] = (byClass[e.channel_class] || 0) + 1;
    return { total: this._entries.length, byClass };
  }
}

module.exports = { EvidenceLedger };
