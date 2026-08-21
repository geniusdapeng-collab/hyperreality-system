/**
 * 字段丢失根因日志器
 * 文件: systems/field-loss-rootcause-logger.js
 * 作用：
 * 1. 记录每个字段从 Stage X → Stage Y 的变化
 * 2. 精确判断：是未生成、被覆盖、还是格式不兼容
 * 3. 生成可读的根因报告
 */

const fs = require('fs').promises;
const path = require('path');

class FieldLossRootCauseLogger {
  constructor(outputDir = './logs/field-loss') {
    this.outputDir = outputDir;
    this.records = [];
  }

  // 记录字段快照
  snapshot(stage, shotIndex, data, meta = {}) {
    const entry = {
      timestamp: Date.now(),
      stage,
      shotIndex,
      shotId: data.id || data.shotId || `shot-${shotIndex}`,
      fields: this._extractFields(data),
      meta
    };
    this.records.push(entry);
  }

  // 对比两个阶段的字段变化
  diff(fromStage, toStage, shotIndex) {
    const from = this.records.find(r => r.stage === fromStage && r.shotIndex === shotIndex);
    const to = this.records.find(r => r.stage === toStage && r.shotIndex === shotIndex);

    if (!from || !to) return { error: 'missing snapshot' };

    const lost = [];
    const changed = [];
    const added = [];

    for (const [key, val] of Object.entries(from.fields)) {
      if (!(key in to.fields)) {
        lost.push({ field: key, lastValue: val, reason: '字段消失' });
      } else if (String(to.fields[key] || '').length < String(val || '').length * 0.5) {
        changed.push({
          field: key,
          from: val,
          to: to.fields[key],
          reason: '内容被截断或覆盖',
          fromLen: String(val || '').length,
          toLen: String(to.fields[key] || '').length
        });
      }
    }

    for (const key of Object.keys(to.fields)) {
      if (!(key in from.fields)) {
        added.push({ field: key, value: to.fields[key], reason: '新增字段' });
      }
    }

    return { lost, changed, added, fromStage, toStage, shotIndex };
  }

  // 全链路对比
  fullDiff() {
    const stages = [...new Set(this.records.map(r => r.stage))];
    const report = [];

    for (let i = 0; i < stages.length - 1; i++) {
      const from = stages[i];
      const to = stages[i + 1];
      const shotIndices = [...new Set(this.records.filter(r => r.stage === from).map(r => r.shotIndex))];

      for (const idx of shotIndices) {
        const d = this.diff(from, to, idx);
        if (d.error) continue;
        if (d.lost.length > 0 || d.changed.length > 0) {
          report.push(d);
        }
      }
    }

    return report;
  }

  // 写入日志文件
  async writeReport(outputPath) {
    const report = this.fullDiff();
    const out = path.resolve(this.outputDir, outputPath || `field-loss-${Date.now()}.json`);
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, JSON.stringify({
      summary: {
        totalStages: [...new Set(this.records.map(r => r.stage))].length,
        totalShots: [...new Set(this.records.map(r => r.shotIndex))].length,
        totalIssues: report.reduce((a, r) => a + r.lost.length + r.changed.length, 0)
      },
      records: this.records,
      issues: report
    }, null, 2));
    return out;
  }

  _extractFields(data) {
    const out = {};
    const extract = (obj, prefix = '') => {
      if (!obj || typeof obj !== 'object') return;
      for (const [k, v] of Object.entries(obj)) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (v === null || v === undefined) {
          out[key] = '<null>';
        } else if (typeof v === 'string') {
          out[key] = v.length > 200 ? v.slice(0, 200) + `...[${v.length}chars]` : v;
        } else if (typeof v === 'number' || typeof v === 'boolean') {
          out[key] = String(v);
        } else if (Array.isArray(v)) {
          out[key] = `<array[${v.length}]>`;
        } else if (typeof v === 'object') {
          extract(v, key);
        }
      }
    };
    extract(data);
    return out;
  }
}

module.exports = { FieldLossRootCauseLogger };
