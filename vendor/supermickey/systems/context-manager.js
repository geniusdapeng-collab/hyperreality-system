/**
 * Context Manager — 上下文膨胀治理系统
 * 
 * 三层防御：
 * 1. Bootstrap文件归档（MEMORY.md/USER.md > 20K时自动归档）
 * 2. 执行日志静默化（Pipeline输出重定向到文件，只发摘要）
 * 3. 执行摘要生成（关键节点聚合，减少消息数量）
 * 
 * @version v1.0
 * @author 小G
 */

const fs = require('fs');
const path = require('path');

class ContextManager {
  constructor(options = {}) {
    this.workspace = options.workspace || '/root/.openclaw/workspace';
    this.archiveDir = path.join(this.workspace, 'memory', 'archive');
    this.threshold = options.threshold || 20480; // 20K bytes
    this.totalThreshold = options.totalThreshold || 61440; // 60K total
    
    // 确保归档目录存在
    if (!fs.existsSync(this.archiveDir)) {
      fs.mkdirSync(this.archiveDir, { recursive: true });
    }
  }

  /**
   * 检查并归档超阈值的bootstrap文件
   */
  checkAndArchive() {
    const files = [
      { path: path.join(this.workspace, 'MEMORY.md'), name: 'MEMORY' },
      { path: path.join(this.workspace, 'USER.md'), name: 'USER' },
      { path: path.join(this.workspace, 'SOUL.md'), name: 'SOUL' },
      { path: path.join(this.workspace, 'AGENTS.md'), name: 'AGENTS' }
    ];

    let totalSize = 0;
    const results = [];

    for (const file of files) {
      if (!fs.existsSync(file.path)) continue;
      const stats = fs.statSync(file.path);
      totalSize += stats.size;
      
      if (stats.size > this.threshold) {
        const archived = this._archiveFile(file.path, file.name);
        results.push({ file: file.name, size: stats.size, archived });
      }
    }

    const needsTrim = totalSize > this.totalThreshold;
    
    return {
      totalSize,
      needsTrim,
      threshold: this.totalThreshold,
      files: results,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * 归档单个文件：保留头部元数据，归档历史内容
   */
  _archiveFile(filePath, name) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archivePath = path.join(this.archiveDir, `${name}-${timestamp}.md`);
    
    // 归档完整内容
    fs.writeFileSync(archivePath, content, 'utf-8');
    
    // 精简原文件：保留最近200行或最近的2个section
    const lines = content.split('\n');
    const keepLines = Math.min(200, Math.max(50, Math.floor(lines.length * 0.3)));
    const trimmed = lines.slice(-keepLines).join('\n');
    
    // 添加归档提示
    const header = `<!-- 历史内容已归档至: ${path.basename(archivePath)} | 保留最近${keepLines}行 -->\n\n`;
    fs.writeFileSync(filePath, header + trimmed, 'utf-8');
    
    console.log(`[ContextManager] 📦 ${name}.md 已归档 | ${(content.length/1024).toFixed(1)}K → ${(trimmed.length/1024).toFixed(1)}K | 归档: ${archivePath}`);
    
    return { archivePath, originalSize: content.length, trimmedSize: trimmed.length };
  }

  /**
   * 为Pipeline执行创建日志重定向包装
   * 返回：{ run: (cmd) => Promise, getLogPath: () => string }
   */
  createLogRedirector(options = {}) {
    const logDir = options.logDir || path.join(this.workspace, 'logs');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    
    const timestamp = Date.now();
    const logPath = path.join(logDir, `run-${timestamp}.log`);
    
    return {
      logPath,
      wrap: (cmd) => {
        // 重定向所有输出到文件，stdout只保留启动确认
        const redirectCmd = `${cmd} > "${logPath}" 2>&1`;
        return {
          cmd: redirectCmd,
          logPath,
          summary: () => this._generateSummary(logPath)
        };
      }
    };
  }

  /**
   * 从日志文件生成执行摘要（只读最后N行关键信息）
   */
  _generateSummary(logPath, maxLines = 50) {
    if (!fs.existsSync(logPath)) return '日志文件未找到';
    
    const content = fs.readFileSync(logPath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    
    // 提取关键行：Stage完成、错误、评分
    const keyPatterns = [
      /STAGE-\d+.*完成/,
      /导演优化.*完成/,
      /编剧优化.*完成/,
      /评分/,
      /ERROR/,
      /失败/,
      /通过/,
      /镜头数/
    ];
    
    const keyLines = lines.filter(line => 
      keyPatterns.some(p => p.test(line))
    );
    
    // 取最后maxLines行
    const summary = keyLines.slice(-maxLines);
    
    return {
      totalLines: lines.length,
      keyLines: summary.length,
      summary: summary.join('\n'),
      logPath
    };
  }

  /**
   * 运行前检查：确保上下文不会膨胀
   */
  preFlightCheck() {
    const result = this.checkAndArchive();
    
    if (result.needsTrim) {
      console.log(`[ContextManager] ⚠️ Bootstrap文件总大小 ${(result.totalSize/1024).toFixed(1)}K > ${this.totalThreshold/1024}K，已触发归档`);
    } else {
      console.log(`[ContextManager] ✅ Bootstrap文件总大小 ${(result.totalSize/1024).toFixed(1)}K，正常`);
    }
    
    return result;
  }
}

module.exports = { ContextManager };

// CLI用法
if (require.main === module) {
  const manager = new ContextManager();
  const result = manager.preFlightCheck();
  console.log(JSON.stringify(result, null, 2));
}
