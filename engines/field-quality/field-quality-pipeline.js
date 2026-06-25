/**
 * FieldQualityPipeline - 字段质量管线
 * 主管线：串联【字段内容检查环节】和【内容修复环节】，支持多轮迭代
 * 
 * 工作流程：检查 → 修复 → 再检查 → 再修复 → ... → 通过或达到最大轮次
 * 
 * 使用示例:
 *   const pipeline = new FieldQualityPipeline({ llmClient, prd, maxRounds: 2 });
 *   const { finalShots, reports, logs } = await pipeline.runAll(shots);
 */
const { FieldCheckAgent } = require('./field-check-agent');
const { FieldRepairAgent, PRD } = require('./field-repair-agent');

class FieldQualityPipeline {
  constructor(options = {}) {
    this.maxRounds = options.maxRounds ?? 2;
    this.checker = new FieldCheckAgent({
      llmModel: options.llmModel || process.env.STORMAXE_LLM_MODEL || 'kimi-k2p6',
      llmTimeout: options.checkerTimeout || 120000,
    });
    this.repairer = new FieldRepairAgent({
      llmModel: options.llmModel || process.env.STORMAXE_LLM_MODEL || 'kimi-k2p6',
      llmTimeout: options.repairerTimeout || 180000,
    });

    // 设置PRD（从blueprint构建或直接使用）
    if (options.prd) {
      this.repairer.setPRD(options.prd);
    }
  }

  /**
   * 【v2.1.4-fix13-审计修复】下发全局 deadline 到 checker 和 repairer
   */
  setDeadline(deadlineMs) {
    this.checker.setDeadline?.(deadlineMs);
    this.repairer.setDeadline?.(deadlineMs);
  }

  /**
   * 设置PRD（用户需求文档）
   * 可在运行时动态设置，支持从blueprint自动构建
   */
  setPRD(prd) {
    if (prd instanceof PRD) {
      this.repairer.setPRD(prd);
    } else if (typeof prd === 'object') {
      this.repairer.setPRD(new PRD(prd));
    }
  }

  /**
   * 从blueprint自动构建PRD并设置
   */
  setPRDFromBlueprint(blueprint) {
    const prd = PRD.fromBlueprint(blueprint);
    this.repairer.setPRD(prd);
    return prd;
  }

  /**
   * 【审计修复·P0】安全深拷贝单个 shot：过滤循环引用、跳过重型字段
   */
  _safeCloneShot(shot) {
    if (shot === null || typeof shot !== 'object') return shot;
    const seen = new WeakMap();
    const clone = (obj) => {
      if (obj === null || typeof obj !== 'object') return obj;
      if (typeof obj === 'function') return undefined;
      if (seen.has(obj)) return seen.get(obj);
      if (Array.isArray(obj)) {
        const arr = [];
        seen.set(obj, arr);
        for (const item of obj) {
          const c = clone(item);
          if (c !== undefined) arr.push(c);
        }
        return arr;
      }
      const result = {};
      seen.set(obj, result);
      for (const [k, v] of Object.entries(obj)) {
        if (['_blueprint', '_adapter', '_llm', '_engine'].includes(k)) continue;
        const c = clone(v);
        if (c !== undefined) result[k] = c;
      }
      return result;
    };
    return clone(shot);
  }

  /**
   * 运行单镜头完整管线
   * @param {object} shot - 镜头提示词（25字段）
   * @param {string} shotId - 镜头ID
   * @returns {object} { finalShot, reports, logs }
   */
  async run(shot, shotId = 'shot_001') {
    // 【审计修复·P0】shot._blueprint 有循环引用，JSON.stringify 会崩，改用安全克隆
    let currentShot = this._safeCloneShot(shot);
    const reports = [];
    const logs = [];

    // 【v2.1.4-fix13】maxRounds=0 时至少执行 1 轮规则检查（不修复）
    const effectiveRounds = Math.max(1, this.maxRounds);

    for (let roundNum = 1; roundNum <= effectiveRounds; roundNum++) {
      // 检查环节
      const report = await this.checker.check(currentShot, shotId);
      report.shotId = `${shotId}_round${roundNum}`;
      reports.push(report);

      console.log(`\n${'='.repeat(60)}`);
      console.log(`第 ${roundNum} 轮检查：${report.summary()}`);

      // 如果通过，结束
      if (report.passed) {
        console.log(`✅ 检查通过，管线结束`);
        break;
      }

      // 如果是最后一轮，不再修复
      if (roundNum === effectiveRounds) {
        console.log(`⚠️ 达到最大轮次 ${effectiveRounds}，仍有问题需人工介入`);
        break;
      }

      // 【v2.1.4-fix13】maxRounds=0 时只检查不修复
      if (this.maxRounds === 0) {
        console.log(`⚠️ 纯规则检查模式（maxRounds=0），跳过修复`);
        break;
      }

      // 修复环节
      const { repaired, log } = await this.repairer.repair(currentShot, report, shotId);
      log.shotId = `${shotId}_round${roundNum}`;
      logs.push(log);

      console.log(`第 ${roundNum} 轮修复：完成 ${log.actions.length} 项修复动作`);
      for (const action of log.actions) {
        console.log(` [${action.method}] ${action.fieldEn}: ${action.before.slice(0, 30)}... → ${action.after.slice(0, 30)}...`);
      }

      currentShot = repaired;
    }

    return { finalShot: currentShot, reports, logs };
  }

  /**
   * 批量运行多个镜头
   * @param {Array} shots - 镜头数组
   * @returns {object} { finalShots, allReports, allLogs, summary }
   */
  async runAll(shots) {
    const finalShots = [];
    const allReports = [];
    const allLogs = [];
    let totalPassed = 0;
    let totalFailed = 0;

    for (let i = 0; i < shots.length; i++) {
      const shot = shots[i];
      const shotId = shot.shotId || shot.shot_id || `shot_${i}`;
      console.log(`\n${'='.repeat(60)}`);
      console.log(`[FieldQualityPipeline] 处理镜头 ${i + 1}/${shots.length}: ${shotId}`);
      console.log('='.repeat(60));

      const { finalShot, reports, logs } = await this.run(shot, shotId);
      finalShots.push(finalShot);
      allReports.push(...reports);
      allLogs.push(...logs);

      const lastReport = reports[reports.length - 1];
      if (lastReport.passed) {
        totalPassed++;
      } else {
        totalFailed++;
      }
    }

    const summary = {
      totalShots: shots.length,
      passed: totalPassed,
      failed: totalFailed,
      totalRounds: allReports.length,
      totalRepairs: allLogs.reduce((sum, log) => sum + log.actions.length, 0),
    };

    console.log(`\n${'='.repeat(60)}`);
    console.log('字段质量管线总结');
    console.log('='.repeat(60));
    console.log(`镜头总数: ${summary.totalShots}`);
    console.log(`通过: ${summary.passed} | 未通过: ${summary.failed}`);
    console.log(`总检查轮次: ${summary.totalRounds}`);
    console.log(`总修复动作: ${summary.totalRepairs}`);

    return { finalShots, allReports, allLogs, summary };
  }
}

module.exports = { FieldQualityPipeline };
