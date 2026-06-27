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
   * 保存检查点
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

      const safeData = safeStringify({
        phase,
        shots: shots || [],
        opening: extra.opening || null,
        llmStats: extra.llmStats || {},
        blueprintFingerprint: extra.blueprintFingerprint || null,
        savedAt: new Date().toISOString()
      });

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
      if (logFn) logFn('CHECKPOINT', `保存失败(忽略): ${e.message}`);
      return { success: false, error: e.message };
    }
  }
}

module.exports = { CheckpointManager };
