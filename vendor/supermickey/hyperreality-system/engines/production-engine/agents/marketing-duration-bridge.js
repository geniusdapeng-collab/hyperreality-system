'use strict';

/**
 * MarketingDurationBridge（营销镜头时长分配桥）
 * ------------------------------------------------------------
 * 【v2.9.0 新增】社媒营销包 · 时长分配接入
 *
 * 营销镜头的时长不得手写均分——必须经 ShotDurationAllocatorV2 按
 * "职能→角色基线+重要性系数+节奏曲线"分配，再用平台蓝图时长带收敛。
 * 手写均分会让 hook 拿不到爆发时长、demo 讲不完过程、cta 没有留白，
 * 节奏曲线（起承转合）完全失效。
 *
 * 职能→分配器角色映射：
 *   hook    → discovery     钩子，要短促爆发
 *   demo    → demonstration 演示，要最长时间带
 *   ugc     → interaction   伪原生互动
 *   seeding → explanation   种草讲解
 *   editing → highlight     剪辑高光
 *   cta     → closing       收尾留白
 */

const { ShotDurationAllocator } = require('../../../../systems/shot-duration-allocator.js');
const { resolveProfile } = require('../../../config/platform-profiles.js');

// 职能 → 分配器 typeMapping 键（type 经 typeMapping 译为角色基线）
const FN_TO_TYPE = {
  hook: 'hook',             // → discovery 钩子，短促爆发
  demo: 'demonstration',    // → 演示，最长时间带
  ugc: 'interaction',       // → 伪原生互动
  seeding: 'explanation',   // → 种草讲解
  editing: 'highlight',     // → 剪辑高光
  cta: 'summary',           // → closing 收尾留白
  opening: 'host'           // → opening 片头
};

// 【v2.10.1 修复】职能 → _priority 角色键
// _priority 表键是分配器规范角色名（demonstration/explanation/discovery/closing/opening），
// 与 FN_TO_TYPE 的值域（hook/summary/host）是两套别名；回退与归一路径必须先经此映射，
// 禁止直接拿营销职能原名查 _priority（否则 demo 与 cta 同权、片头独大，节奏倒挂）。
const FN_TO_ROLE = {
  hook: 'discovery',
  demo: 'demonstration',
  ugc: 'interaction',
  seeding: 'explanation',
  editing: 'highlight',
  cta: 'closing',
  opening: 'opening'
};

class MarketingDurationBridge {
  /**
   * 为营销镜头骨架分配时长（长短不一，节奏曲线驱动）
   * @param {object} input
   * @param {Array}  input.shots         镜头骨架 [{shotId, fn, lineChars?}]（fn=镜头职能；opening 镜 fn=opening）
   * @param {number} input.totalDuration 目标总时长（brief.duration）
   * @param {string} input.platform      平台（蓝图时长带来源）
   * @param {string} [input.rhythmCurve] 节奏曲线（默认 classic 起承转合）
   * @returns {{shots:Array, total:number, profile:object, warnings:string[]}}
   */
  allocate(input = {}) {
    const { shots = [], totalDuration = 30, platform = 'xiaohongshu', rhythmCurve = 'classic' } = input;
    const profile = resolveProfile({ platform });
    const band = profile.shotDuration || { min: 3, max: 12 };
    const warnings = [];
    // 【v2.10.1】蓝图未覆盖平台的回退警告透传，禁止静默降级
    if (profile.fallbackWarning) warnings.push(profile.fallbackWarning);

    // 1) 组装分配器输入：职能映射 type，台词字数驱动语音基线；mustAlone 强制一镜一句不合并
    const narrations = shots.map(s => ({
      id: s.shotId,
      type: FN_TO_TYPE[s.fn] || 'explanation',
      text: '字'.repeat(Math.max(0, Number(s.lineChars) || 0)),
      mustAlone: true
    }));

    const allocator = new ShotDurationAllocator();
    const result = allocator.allocate({ totalDuration, narrations, rhythmCurve });

    // 2) 分配结果回映 shotId；分配器 L2/L3 报错时回退到带内加权分配（桥接器保证必有产出）
    let allocated;
    if (result && Array.isArray(result.shots) && result.shots.length > 0) {
      allocated = result.shots.map(g => {
        const id = (g.narrationIds && g.narrationIds[0]) || g.id;
        const src = shots.find(s => s.shotId === id) || {};
        return { shotId: id, fn: src.fn, duration: this._clamp(g.duration, band) };
      }).filter(s => s.shotId);
      // 分组丢失兜底（理论上 mustAlone 不会触发）
      if (allocated.length !== shots.length) {
        warnings.push('分配器输出镜头数与骨架不一致，回退带内加权分配');
        allocated = this._fallbackAllocate(shots, totalDuration, band);
      }
    } else {
      // 【v2.10.1 修复】L2 超载时优先复用分配器压缩态时长做带内等比收缩——
      // 压缩态已编码重要性/语速语义，比职能权重盲分更贴近节奏曲线；
      // 仅在无压缩态数据时才回退职能权重分配。
      const compressed = result && Array.isArray(result.narrations) ? result.narrations : null;
      if (compressed && compressed.length === shots.length) {
        warnings.push('分配器L2超载：采用压缩态时长带内等比收缩（保留重要性语义）。提示：镜头数>10时L2压缩为预期行为，单镜落蓝图时长带且作品级校验通过即可放行；如需更宽时长带请在平台蓝图层调整');
        allocated = this._bandFitAllocate(shots, compressed, totalDuration, band);
      } else {
        warnings.push('分配器未产出（预算过紧），回退带内加权分配');
        allocated = this._fallbackAllocate(shots, totalDuration, band);
      }
    }
    allocated = this._normalizeTotal(allocated, totalDuration, band);

    // 3) 纪律校验：禁止全部同长（单镜作品除外）
    const durations = allocated.map(s => s.duration);
    if (allocated.length > 2 && new Set(durations).size === 1) {
      warnings.push('时长全部相同：分配未生效，检查输入差异性');
    }
    const outOfBand = allocated.filter(s => s.duration < band.min || s.duration > band.max);
    if (outOfBand.length > 0) {
      warnings.push(`存在越出蓝图时长带[${band.min}-${band.max}]的镜头：${outOfBand.map(s => s.shotId).join('/')}`);
    }

    return {
      shots: allocated,
      total: allocated.reduce((a, s) => a + s.duration, 0),
      profile: { platformKey: profile.platformKey, shotDuration: band },
      warnings
    };
  }

  _clamp(v, band) {
    return Math.max(band.min, Math.min(band.max, Math.round(v)));
  }

  /** 带内等比收缩：以分配器压缩态时长为底，等比缩至预算内并收敛蓝图时长带 */
  _bandFitAllocate(shots, compressed, total, band) {
    const byId = {};
    compressed.forEach(n => { byId[n.id] = n; });
    const sumC = compressed.reduce((a, n) => a + (Number(n.compressedDuration) || 0), 0) || 1;
    return shots.map(s => {
      const c = Number(byId[s.shotId] && byId[s.shotId].compressedDuration) || band.min;
      return { shotId: s.shotId, fn: s.fn, duration: this._clamp((c * total) / sumC, band) };
    });
  }

  /** 回退分配：按职能重要性加权，在蓝图时长带内拉开长短 */
  _fallbackAllocate(shots, total, band) {
    const weights = shots.map(s => this._priorityOf(s.fn));
    const sumW = weights.reduce((a, b) => a + b, 0) || 1;
    return shots.map((s, i) => ({
      shotId: s.shotId,
      fn: s.fn,
      duration: this._clamp((total * weights[i]) / sumW, band)
    }));
  }

  /** 总和归一：迭代微调，保持镜头间差异（优先拉长 demonstration/opening，压缩 transition 感短镜） */
  _normalizeTotal(allocated, total, band) {
    let diff = total - allocated.reduce((a, s) => a + s.duration, 0);
    let guard = 0;
    // 先加后减：按 fn 优先级排序轮流调整，保持长短结构
    const order = [...allocated].sort((a, b) => this._priorityOf(b.fn) - this._priorityOf(a.fn));
    while (diff !== 0 && guard < 40) {
      guard++;
      for (const s of order) {
        if (diff === 0) break;
        if (diff > 0 && s.duration < band.max) { s.duration++; diff--; }
        else if (diff < 0 && s.duration > band.min) { s.duration--; diff++; }
      }
      if (order.every(s => s.duration >= band.max) && diff > 0) break;
      if (order.every(s => s.duration <= band.min) && diff < 0) break;
    }
    return allocated;
  }

  /** 职能 → 角色 → 优先级（统一入口，禁止直接拿 fn 查 _priority） */
  _priorityOf(fn) {
    return this._priority(FN_TO_ROLE[fn] || fn);
  }

  _priority(role) {
    return { demonstration: 3, opening: 2, explanation: 2, discovery: 1, highlight: 1, interaction: 1, closing: 1 }[role] || 1;
  }
}

module.exports = { MarketingDurationBridge, FN_TO_TYPE, FN_TO_ROLE };
