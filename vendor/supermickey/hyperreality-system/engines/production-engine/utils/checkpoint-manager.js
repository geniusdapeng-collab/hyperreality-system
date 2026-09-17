/**
 * 检查点管理工具
 * 生产引擎内部使用
 * 
 * 特性：
 * - 原子写入（先写.tmp再rename）
 * - 写入验证（existsSync + stat）
 * - 安全序列化
 */

const fs = require('fs');
const path = require('path');
const { safeStringify } = require('./safe-stringify');

class CheckpointManager {
  constructor(baseDir) {
    this.baseDir = baseDir || path.join(process.cwd(), 'checkpoints');
  }

  /**
   * 保存检查点（P0-ARCH-04修复：深拷贝避免引用泄漏，错误不再静默忽略）
   * @param {string} phase - 阶段标识
   * @param {Array} shots - 镜头数据
   * @param {object} extra - 额外数据
   * @param {function} logFn - 日志函数 (可选)
   */
  save(phase, shots, extra = {}, logFn = null) {
    try {
      if (!fs.existsSync(this.baseDir)) {
        fs.mkdirSync(this.baseDir, { recursive: true });
      }

      const file = path.join(this.baseDir, `checkpoint-${phase}.json`);
      const tmpFile = file + '.tmp';

      // 【P0-ARCH-04 修复】深拷贝数据，避免引用泄漏
      const dataToSave = {
        phase,
        shots: JSON.parse(JSON.stringify(shots || [])),
        opening: extra.opening ? JSON.parse(JSON.stringify(extra.opening)) : null,
        llmStats: extra.llmStats ? JSON.parse(JSON.stringify(extra.llmStats)) : {},
        blueprintFingerprint: extra.blueprintFingerprint || null,
        savedAt: new Date().toISOString(),
        // 【P1-DATA-05 修复】附加验证报告
        _validation: this._validateShots(shots || [])
      };

      const safeData = safeStringify(dataToSave);
      if (!safeData) {
        throw new Error(`safeStringify返回空值，phase=${phase}`);
      }

      fs.writeFileSync(tmpFile, safeData, 'utf8');
      fs.renameSync(tmpFile, file);

      // 写入验证
      if (!fs.existsSync(file)) {
        throw new Error(`checkpoint文件写入后不存在: ${file}`);
      }
      const stats = fs.statSync(file);
      if (stats.size === 0) {
        throw new Error(`checkpoint文件写入后大小为0: ${file}`);
      }

      if (logFn) logFn('CHECKPOINT', `✅ ${phase} 已落盘 → ${path.basename(file)} (${stats.size} bytes)`);
      return { success: true, file, size: stats.size };
    } catch (e) {
      // 【P0-ARCH-04 修复】错误不再静默忽略，抛出异常让调用方处理
      const errMsg = `Checkpoint保存失败: phase=${phase}, error=${e.message}`;
      if (logFn) logFn('CHECKPOINT', `❌ ${errMsg}`);
      throw new Error(errMsg);
    }
  }

  /**
   * 【v2.1.8-fix】验证镜头数据基本结构
   * @param {Array} shots - 镜头数组
   * @returns {object} 验证报告
   */
  _validateShots(shots) {
    if (!Array.isArray(shots)) {
      return { valid: false, error: 'shots不是数组', count: 0 };
    }
    const issues = [];
    for (let i = 0; i < shots.length; i++) {
      const s = shots[i];
      if (!s || typeof s !== 'object') {
        issues.push({ index: i, error: '不是对象' });
        continue;
      }
      if (!s.shotId && !s.shot_id) {
        issues.push({ index: i, error: '缺少shotId' });
      }
    }
    return { valid: issues.length === 0, count: shots.length, issues };
  }
}

module.exports = { CheckpointManager };