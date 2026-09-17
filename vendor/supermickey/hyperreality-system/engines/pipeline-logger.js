/**
 * Pipeline Logger — 全链路日志留档系统 (SuperMickey 适配版)
 * 
 * 来源: 暴风战斧 StormaxeAIVideoSystem/skills/shanhaijing-director/scripts/pipeline-logger.js
 * 适配: SuperMickey 四层架构
 * 
 * 核心能力：
 * - 每次预生产输出独立目录（时间戳命名）
 * - 完整输入输出JSON存档
 * - Markdown报告生成
 * - 版本号自动记录
 */

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');

class PipelineLogger {
  constructor(options = {}) {
    this.outputDir = options.outputDir || './output';
    this.format = options.format || 'markdown'; // 'markdown' | 'json' | 'both'
    this.includePrompts = options.includePrompts !== false;
    this.includeShots = options.includeShots !== false;
    this.includeReports = options.includeReports !== false;
    this.enabled = options.enabled !== false;
    // 【P1-PERF-03 修复】批量写入队列，避免阻塞事件循环
    this._writeQueue = [];
    this._flushTimer = null;
    this._batchSize = options.batchSize || 10;
    this._flushInterval = options.flushInterval || 100; // ms
  }

  // 【P1-PERF-03 修复】异步批量写入：加入队列，定时刷新
  async _queueWrite(filePath, data, isJSON = false) {
    this._writeQueue.push({ filePath, data, isJSON });
    if (this._writeQueue.length >= this._batchSize) {
      await this._flushQueue();
    } else if (!this._flushTimer) {
      this._flushTimer = setTimeout(() => this._flushQueue(), this._flushInterval);
    }
  }

  async _flushQueue() {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    if (this._writeQueue.length === 0) return;
    const batch = this._writeQueue.splice(0, this._batchSize);
    await Promise.all(batch.map(item => {
      if (item.isJSON) {
        return this._writeJSON(item.filePath, item.data);
      } else {
        return fs.writeFile(item.filePath, item.data, 'utf8');
      }
    }));
  }

  /**
   * 保存完整结果
   * @param {Object} result - HyperrealitySystem.create() 的返回结果
   * @param {Object} meta - 元数据 { title, version, intent, metadata }
   */
  async save(result, meta = {}) {
    if (!this.enabled) return null;

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const title = meta.title || 'untitled';
    const version = meta.version || 'unknown';
    
    // 创建独立目录
    const sessionDir = path.join(this.outputDir, `${timestamp}_${title}`);
    await fs.mkdir(sessionDir, { recursive: true });

    console.log(`\n💾 [PipelineLogger] 保存结果到: ${sessionDir}`);

    const saved = [];

    // 1. 保存完整结果 JSON
    if (this.includeReports) {
      const resultPath = path.join(sessionDir, 'result.json');
      await this._queueWrite(resultPath, this._sanitizeResult(result), true);
      saved.push('result.json');
    }

    // 2. 保存 Markdown 报告
    if (this.format === 'markdown' || this.format === 'both') {
      const reportPath = path.join(sessionDir, 'report.md');
      const report = this._generateReport(result, meta);
      await this._queueWrite(reportPath, report, false);
      saved.push('report.md');
    }

    // 3. 保存 Prompts
    if (this.includePrompts && result.prompts) {
      const promptsPath = path.join(sessionDir, 'prompts.md');
      const promptsContent = this._generatePromptsMD(result.prompts);
      await this._queueWrite(promptsPath, promptsContent, false);
      saved.push('prompts.md');
    }

    // 4. 保存 Shots
    if (this.includeShots && result.shots) {
      const shotsPath = path.join(sessionDir, 'shots.json');
      await this._queueWrite(shotsPath, result.shots, true);
      saved.push('shots.json');
    }

    // 5. 保存元数据
    const metaPath = path.join(sessionDir, 'meta.json');
    await this._queueWrite(metaPath, {
      title,
      version,
      intent: meta.intent,
      timestamp,
      savedFiles: saved
    }, true);

    // 确保所有队列数据写入完成
    await this._flushQueue();

    console.log(`✅ [PipelineLogger] 已保存 ${saved.length} 个文件`);

    return sessionDir;
  }

  /**
   * 生成 Markdown 报告
   */
  _generateReport(result, meta) {
    const lines = [];
    
    lines.push(`# SuperMickey 预生产报告`);
    lines.push('');
    lines.push(`**项目**: ${meta.title || '未命名'}`);
    lines.push(`**版本**: ${meta.version || 'unknown'}`);
    lines.push(`**时间**: ${new Date().toISOString()}`);
    lines.push(`**状态**: ${result.success ? '✅ 成功' : '❌ 失败'}`);
    lines.push('');

    // 执行摘要
    lines.push('## 执行摘要');
    lines.push('');
    lines.push(`| 指标 | 数值 |`);
    lines.push(`|------|------|`);
    lines.push(`| 总耗时 | ${result.timing?.total || 'N/A'}ms |`);
    lines.push(`| 镜头数 | ${result.shots?.length || 0} |`);
    lines.push(`| Prompts | ${result.prompts?.length || 0} |`);
    lines.push(`| 错误数 | ${result.errors?.length || 0} |`);
    lines.push('');

    // 各阶段耗时
    if (result.stages) {
      lines.push('## 各阶段耗时');
      lines.push('');
      lines.push(`| 阶段 | 耗时 | 状态 |`);
      lines.push(`|------|------|------|`);
      
      for (const [stageName, stageData] of Object.entries(result.stages)) {
        const timing = stageData?.timing || 'N/A';
        const status = stageData?.error ? '❌ 失败' : '✅ 完成';
        lines.push(`| ${stageName} | ${timing}ms | ${status} |`);
      }
      lines.push('');
    }

    // 错误列表
    if (result.errors && result.errors.length > 0) {
      lines.push('## 错误列表');
      lines.push('');
      for (const error of result.errors) {
        lines.push(`- **${error.stage || error.layer || 'Unknown'}**: ${error.message || error.error}`);
      }
      lines.push('');
    }

    // Prompts 预览
    if (result.prompts && result.prompts.length > 0) {
      lines.push('## Prompts 预览');
      lines.push('');
      for (let i = 0; i < Math.min(3, result.prompts.length); i++) {
        const p = result.prompts[i];
        lines.push(`### ${p.shotId || `Prompt ${i+1}`}`);
        lines.push('');
        lines.push('```');
        lines.push(p.prompt?.substring(0, 200) + '...' || 'N/A');
        lines.push('```');
        lines.push('');
      }
      lines.push(`*共 ${result.prompts.length} 个 prompts，详见 prompts.md*`);
      lines.push('');
    }

    lines.push('---');
    lines.push(`*Generated by SuperMickey PipelineLogger*`);

    return lines.join('\n');
  }

  /**
   * 生成 Prompts Markdown
   */
  _generatePromptsMD(prompts) {
    const lines = [];
    lines.push('# Prompts 清单');
    lines.push('');

    for (const p of prompts) {
      lines.push(`## ${p.shotId || 'Unknown'}`);
      lines.push('');
      lines.push(p.prompt || 'N/A');
      lines.push('');
      lines.push('---');
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * 清理结果对象（移除循环引用和大对象）
   */
  _sanitizeResult(result) {
    const { safeStringify } = require('../utils/safe-clone');
    return JSON.parse(safeStringify(result)); // 【v2.1.6-fix-bug45】安全序列化，处理循环引用
  }

  async _writeJSON(filePath, data) {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
  }
}

module.exports = { PipelineLogger };
