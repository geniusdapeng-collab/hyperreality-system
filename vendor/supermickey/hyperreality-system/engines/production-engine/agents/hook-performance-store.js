'use strict';

/**
 * HookPerformanceStore（钩子表现数据回流存储）
 * ------------------------------------------------------------
 * 【v2.7.0 新增】社媒营销包 SocialPack · M3 数据回流
 *
 * 投放后的完播/点击/转化数据回流，反哺钩子策略：
 * 同一 Brief 的下次生产、平台变体扇出时，优先选用"数据证明过"的钩子风格，
 * 而不是每次从零拍脑袋。
 *
 * 数据结构（本地 JSON，可后续替换为真实数仓）：
 *   { records: { [platform]: { [hookStyle]: { samples, avgCompletion, avgCtr, avgConversion, updatedAt } } } }
 *
 * 综合得分 = 0.6×完播率 + 0.3×点击率 + 0.1×转化率（完播是钩子的第一考核）
 * 无数据平台回退到 Profile 默认钩子序列（绝不虚构数据）。
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_FILE = path.join(__dirname, '../../../data/hook-performance.json');
const W_COMPLETION = 0.6, W_CTR = 0.3, W_CONVERSION = 0.1;

class HookPerformanceStore {
  /**
   * @param {object} [options] { file: 自定义存储路径（测试/多环境注入） }
   */
  constructor(options = {}) {
    this._file = options.file || DEFAULT_FILE;
    this._data = null;
  }

  _load() {
    if (this._data) return this._data;
    try {
      if (fs.existsSync(this._file)) {
        const parsed = JSON.parse(fs.readFileSync(this._file, 'utf8'));
        this._data = parsed && parsed.records ? parsed : { records: {} };
      } else {
        this._data = { records: {} };
      }
    } catch (e) {
      console.warn(`[HookStore] 数据文件读取失败，按空库处理: ${e.message}`);
      this._data = { records: {} };
    }
    return this._data;
  }

  _save() {
    fs.mkdirSync(path.dirname(this._file), { recursive: true });
    fs.writeFileSync(this._file, JSON.stringify(this._data, null, 2), 'utf8');
  }

  /**
   * 记录一次投放表现（滚动平均）
   * @param {string} platform 平台 key
   * @param {string} hookStyle 钩子风格（与 platform-profiles.hook.styles 同枚举）
   * @param {object} metrics { completionRate, ctr, conversionRate }（0-1）
   */
  record(platform, hookStyle, metrics = {}) {
    const data = this._load();
    if (!data.records[platform]) data.records[platform] = {};
    const cur = data.records[platform][hookStyle] || { samples: 0, avgCompletion: 0, avgCtr: 0, avgConversion: 0 };
    const n = cur.samples;
    const roll = (avg, v) => {
      const x = Number(v);
      if (!isFinite(x)) return avg;
      return (avg * n + x) / (n + 1);
    };
    data.records[platform][hookStyle] = {
      samples: n + 1,
      avgCompletion: roll(cur.avgCompletion, metrics.completionRate),
      avgCtr: roll(cur.avgCtr, metrics.ctr),
      avgConversion: roll(cur.avgConversion, metrics.conversionRate),
      updatedAt: new Date().toISOString()
    };
    this._save();
    return data.records[platform][hookStyle];
  }

  /** 平台钩子风格排行（仅有样本的条目，得分降序） */
  rankStyles(platform) {
    const data = this._load();
    const styles = data.records[platform] || {};
    return Object.entries(styles)
      .filter(([, v]) => v.samples > 0)
      .map(([style, v]) => ({
        style,
        samples: v.samples,
        score: +(W_COMPLETION * v.avgCompletion + W_CTR * v.avgCtr + W_CONVERSION * v.avgConversion).toFixed(4),
        avgCompletion: +v.avgCompletion.toFixed(4),
        avgCtr: +v.avgCtr.toFixed(4)
      }))
      .sort((a, b) => b.score - a.score);
  }

  /**
   * 推荐钩子风格序列：有数据的按得分在前，未测过的按 Profile 默认序补后
   * @param {string} platform
   * @param {string[]} fallbackStyles Profile 默认钩子序列
   * @returns {Array<{style:string, evidence:string|null}>}
   */
  recommend(platform, fallbackStyles = []) {
    const ranked = this.rankStyles(platform);
    const out = ranked.map(r => ({
      style: r.style,
      evidence: `完播${(r.avgCompletion * 100).toFixed(0)}%·点击${(r.avgCtr * 100).toFixed(1)}%·样本${r.samples}`
    }));
    for (const s of fallbackStyles) {
      if (!out.some(o => o.style === s)) out.push({ style: s, evidence: null });
    }
    return out;
  }
}

module.exports = { HookPerformanceStore, DEFAULT_FILE };
