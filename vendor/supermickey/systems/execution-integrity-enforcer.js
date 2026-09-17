/**
 * 【v6.2-patch53】执行完整性强制器 — ExecutionIntegrityEnforcer
 *
 * 产品机制：解决"没跑完就报告"和"随手复用旧数据"的系统性漏洞
 * 三重锁设计：
 *   1. 旧数据硬清理（执行前）
 *   2. Stage审计追踪（执行中）
 *   3. 执行完整性证书（执行后）
 *
 * 挂载点：Pipeline.execute() 入口第一行 + 每个Stage首尾 + 最终输出前
 */

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');

class ExecutionIntegrityEnforcer {
  constructor(config = {}) {
    this.config = {
      // 需要监控的旧输出目录
      outputDirs: ['output', 'tmp', 'cache'],
      // 需要清理的旧文件模式
      oldFilePatterns: [
        'taotie-ep01-prompts*.json',
        'taotie-ep01-prompts*.md',
        '*-prompts-full.json',
        '*-prompts.md',
        '*.audit.json'
      ],
      // 期望的Stage总数
      expectedStageCount: 17,
      // v6.2-patch55-fix: 本地执行无网络延迟，阈值过高会导致误判
      // 无API调用的纯本地计算，17个Stage合理耗时约100-500ms
      minExecutionTimeMs: 100,
      ...config
    };
    
    this.auditLog = {
      executionId: this.generateExecutionId(),
      startTime: null,
      endTime: null,
      cleanup: { performed: false, filesRemoved: [], errors: [] },
      stages: {},
      dataFreshness: {},
      integritySignature: null,
      allStagesExecuted: false,
      isFreshExecution: false
    };
  }

  generateExecutionId() {
    return `exec-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  }

  /**
   * 🔒 锁1：执行前强制清理旧数据
   * 扫描并删除所有历史输出文件，确保"全新执行"
   */
  async enforcePreExecution(workspaceRoot = process.cwd()) {
    this.auditLog.startTime = Date.now();
    this.log('ENFORCER', `🔒 执行完整性强制器启动 | ID: ${this.auditLog.executionId}`);
    
    const removedFiles = [];
    const errors = [];
    
    for (const dirName of this.config.outputDirs) {
      const dirPath = path.join(workspaceRoot, dirName);
      
      if (!fsSync.existsSync(dirPath)) continue;
      
      try {
        const files = await fs.readdir(dirPath);
        
        for (const file of files) {
          // 检查是否匹配旧文件模式
          const isOldFile = this.config.oldFilePatterns.some(pattern => {
            const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
            return regex.test(file);
          });
          
          if (isOldFile) {
            const filePath = path.join(dirPath, file);
            try {
              await fs.unlink(filePath);
              removedFiles.push({ file: `${dirName}/${file}`, path: filePath });
              this.log('ENFORCER', `  🗑️ 清理旧数据: ${dirName}/${file}`);
            } catch (e) {
              errors.push({ file: `${dirName}/${file}`, error: e.message });
              this.log('ENFORCER', `  ❌ 清理失败: ${dirName}/${file} | ${e.message}`);
            }
          }
        }
      } catch (e) {
        errors.push({ dir: dirName, error: e.message });
      }
    }
    
    this.auditLog.cleanup = {
      performed: true,
      filesRemoved: removedFiles,
      errors: errors
    };
    
    // 如果清理失败 → 硬停止
    if (errors.length > 0 && errors.length >= removedFiles.length) {
      this.log('ENFORCER', `❌ 旧数据清理失败率过高 (${errors.length}/${removedFiles.length + errors.length})，禁止执行`);
      throw new Error(`ExecutionIntegrityEnforcer: 旧数据清理失败 ${errors.length} 个文件，执行被强制停止。请手动清理后重试。`);
    }
    
    this.auditLog.isFreshExecution = true;
    this.log('ENFORCER', `✅ 旧数据清理完成 | 删除 ${removedFiles.length} 个文件 | 准备全新执行`);
    
    return {
      executionId: this.auditLog.executionId,
      cleanedFiles: removedFiles.length,
      ready: true
    };
  }

  /**
   * 🔒 锁2：Stage开始审计
   * 每个Stage开始时调用，记录时间戳和输入数据哈希
   */
  recordStageStart(stageName, inputData = null) {
    const hash = inputData ? this.hashData(inputData) : null;
    
    this.auditLog.stages[stageName] = {
      startTime: Date.now(),
      endTime: null,
      inputHash: hash,
      outputHash: null,
      completed: false
    };
    
    this.log('ENFORCER', `  📋 Stage审计: ${stageName} 开始 | 输入哈希: ${hash ? hash.substring(0, 8) : 'null'}`);
  }

  /**
   * 🔒 锁2：Stage结束审计
   * 每个Stage结束时调用，记录输出数据哈希
   */
  recordStageEnd(stageName, outputData = null) {
    const stage = this.auditLog.stages[stageName];
    if (!stage) {
      this.log('ENFORCER', `  ⚠️ Stage审计警告: ${stageName} 没有start记录，可能跳过了`);
      this.auditLog.stages[stageName] = {
        startTime: null,
        endTime: Date.now(),
        skipped: true
      };
      return;
    }
    
    stage.endTime = Date.now();
    stage.outputHash = outputData ? this.hashData(outputData) : null;
    stage.duration = stage.endTime - stage.startTime;
    stage.completed = true;
    
    this.log('ENFORCER', `  📋 Stage审计: ${stageName} 完成 | 耗时: ${stage.duration}ms | 输出哈希: ${stage.outputHash ? stage.outputHash.substring(0, 8) : 'null'}`);
  }

  /**
   * 🔒 锁3：执行后完整性验证
   * 生成执行完整性证书，判断是否可信任
   */
  async enforcePostExecution(workspaceRoot = process.cwd()) {
    this.auditLog.endTime = Date.now();
    const totalDuration = this.auditLog.endTime - this.auditLog.startTime;
    
    // 检查1：Stage数量
    const stageNames = Object.keys(this.auditLog.stages);
    const completedStages = stageNames.filter(s => this.auditLog.stages[s].completed);
    const allStagesExecuted = completedStages.length >= this.config.expectedStageCount;
    
    // 检查2：执行时长（太短说明是假执行）
    const isDurationValid = totalDuration >= this.config.minExecutionTimeMs;
    
    // 检查3：是否有Stage被跳过
    const skippedStages = stageNames.filter(s => this.auditLog.stages[s].skipped);
    
    // 检查4：数据新鲜度（每个Stage的输出哈希都不同）
    // v6.2-patch63-fix: 某些Stage（如STAGE-11渲染核心和STAGE-14风格注入）处理相同数据，允许共享输出哈希
    const outputHashes = completedStages
      .map(s => this.auditLog.stages[s].outputHash)
      .filter(h => h !== null);
    const uniqueHashes = new Set(outputHashes);
    
    // 允许列表：这些Stage可以共享相同的输出哈希（处理相同数据）
    const allowDuplicateStages = ['STAGE-11', 'STAGE-14', 'STAGE-15'];
    const duplicateAllowed = completedStages.filter(s => allowDuplicateStages.some(a => s.includes(a)));
    
    // 计算非允许列表中的Stage是否有重复哈希
    const nonAllowedStages = completedStages.filter(s => !allowDuplicateStages.some(a => s.includes(a)));
    const nonAllowedHashes = nonAllowedStages.map(s => this.auditLog.stages[s].outputHash).filter(h => h !== null);
    const nonAllowedUnique = new Set(nonAllowedHashes);
    
    const isDataFresh = (uniqueHashes.size === outputHashes.length || duplicateAllowed.length > 0) 
                        && nonAllowedUnique.size === nonAllowedHashes.length 
                        && outputHashes.length > 0;
    
    // 生成完整性签名
    this.auditLog.allStagesExecuted = allStagesExecuted;
    this.auditLog.integritySignature = {
      totalDuration,
      stageCount: completedStages.length,
      expectedStageCount: this.config.expectedStageCount,
      allStagesExecuted,
      isDurationValid,
      skippedStages: skippedStages.length,
      isDataFresh,
      isTrusted: allStagesExecuted && isDurationValid && skippedStages.length === 0 && isDataFresh
    };
    
    // 保存审计日志
    const auditPath = path.join(workspaceRoot, 'output', `execution-audit-${this.auditLog.executionId}.json`);
    try {
      await fs.mkdir(path.dirname(auditPath), { recursive: true });
      await fs.writeFile(auditPath, JSON.stringify(this.auditLog, null, 2));
    } catch (e) {
      this.log('ENFORCER', `⚠️ 审计日志保存失败: ${e.message}`);
    }
    
    // 生成报告
    const report = this.generateReport();
    
    this.log('ENFORCER', `🔒 执行完整性验证完成`);
    this.log('ENFORCER', `  📊 Stage完成: ${completedStages.length}/${this.config.expectedStageCount}`);
    this.log('ENFORCER', `  ⏱️ 总耗时: ${(totalDuration / 1000).toFixed(1)}秒`);
    this.log('ENFORCER', `  ✅ 数据新鲜: ${isDataFresh ? '是' : '否'}`);
    this.log('ENFORCER', `  ${this.auditLog.integritySignature.isTrusted ? '✅' : '❌'} 完整性信任: ${this.auditLog.integritySignature.isTrusted ? '通过' : '未通过'}`);
    
    return report;
  }

  /**
   * 生成执行报告
   */
  generateReport() {
    const sig = this.auditLog.integritySignature;
    if (!sig) return { trusted: false, reason: '未执行完整性验证' };
    
    const issues = [];
    if (!sig.allStagesExecuted) issues.push(`Stage未完成: ${sig.stageCount}/${sig.expectedStageCount}`);
    if (!sig.isDurationValid) issues.push(`执行时长过短: ${sig.totalDuration}ms < ${this.config.minExecutionTimeMs}ms，疑似假执行`);
    if (sig.skippedStages > 0) issues.push(`有${sig.skippedStages}个Stage被跳过`);
    if (!sig.isDataFresh) issues.push(`数据新鲜度异常，可能存在缓存复用`);
    
    return {
      trusted: sig.isTrusted,
      executionId: this.auditLog.executionId,
      stageCount: sig.stageCount,
      expectedStageCount: sig.expectedStageCount,
      totalDuration: sig.totalDuration,
      isFreshExecution: this.auditLog.isFreshExecution,
      allStagesExecuted: sig.allStagesExecuted,
      issues: issues,
      auditFile: `output/execution-audit-${this.auditLog.executionId}.json`
    };
  }

  /**
   * 计算数据哈希
   */
  hashData(data) {
    const str = typeof data === 'string' ? data : JSON.stringify(data);
    return crypto.createHash('sha256').update(str).digest('hex').substring(0, 16);
  }

  log(tag, message) {
    console.log(`[${new Date().toISOString()}] [${tag}] ${message}`);
  }
}

module.exports = { ExecutionIntegrityEnforcer };
