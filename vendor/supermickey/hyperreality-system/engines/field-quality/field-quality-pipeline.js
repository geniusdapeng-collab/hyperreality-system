/**
 * FieldQualityPipeline - 字段质量管线（v2.1.14-fix）
 * 主管线：串联【字段内容检查环节】和【内容修复环节】，支持多轮迭代
 *
 * 【v2.1.14-fix 改动】
 * - 最大轮次后新增分级降级策略：致命问题兜底填充 + _qualityDegraded 标记 + pending-review 留档
 * - 修复日志打印时 before/after 强转字符串（避免数组类型崩溃）
 *
 * 工作流程：检查 → 修复 → 再检查 → 再修复 → ... → 通过或达到最大轮次
 *
 * 使用示例:
 *   const pipeline = new FieldQualityPipeline({ llmClient, prd, maxRounds: 2 });
 *   const { finalShots, reports, logs } = await pipeline.runAll(shots);
 */
const fs = require('fs');
const path = require('path');
const { FieldCheckAgent } = require('./field-check-agent');
const { FieldRepairAgent, RuleRepairer, PRD, RepairAction } = require('./field-repair-agent');

// 【v2.1.14-fix】降级留档目录
const DEGRADED_DIR = path.join(__dirname, '..', '..', 'output', 'field-quality');

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
        // 【v2.1.14-fix】分级降级策略：
        // 致命问题 → 自动填充兜底值（不再裸奔进入渲染链路）+ 降级标记 + 留档待人工复核
        // 严重/轻微问题 → 降级继续，留档记录
        currentShot = this._handleMaxRoundsDegraded(currentShot, report, shotId, logs);
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
        // 【v2.1.14-fix】before/after 可能是数组（如 dialogue 默认值），统一强转字符串
        const beforeStr = String(action.before ?? '');
        const afterStr = String(typeof action.after === 'string' ? action.after : JSON.stringify(action.after));
        console.log(` [${action.method}] ${action.fieldEn}: ${beforeStr.slice(0, 30)}... → ${afterStr.slice(0, 30)}...`);
      }

      currentShot = repaired;
    }

    return { finalShot: currentShot, reports, logs };
  }

  /**
   * 【v2.1.14-fix】最大轮次后的分级降级处理
   * 旧行为：打印"需人工介入"后流程自动继续，致命问题裸奔进入渲染链路
   * 新行为：
   * 1. 致命问题（P0 字段缺失/损坏）→ 用规则层兜底值自动填充，绝不让空字段进渲染
   * 2. shot 打上 _qualityDegraded 标记（含未解决严重/轻微问题清单），下游可感知
   * 3. 留档 pending-review-<shotId>-<ts>.json，供人工事后复核
   * @returns {object} 处理后的 shot
   */
  _handleMaxRoundsDegraded(shot, report, shotId, logs) {
    const fatalIssues = report.issues.filter(i => i.severity === 'fatal');
    const majorIssues = report.issues.filter(i => i.severity === 'major');
    const minorIssues = report.issues.filter(i => i.severity === 'minor');

    const patched = shot;
    const autofilled = [];

    // 致命问题兜底填充
    if (fatalIssues.length) {
      const ruleRepairer = new RuleRepairer();
      const prd = this.repairer?.prd || null;
      for (const issue of fatalIssues) {
        const fieldEn = issue.fieldEn;
        if (fieldEn === '_total') continue;
        const current = patched[fieldEn];
        const empty = !current
          || (typeof current === 'string' && !current.trim())
          || (Array.isArray(current) && current.length === 0);
        if (empty) {
          const fallback = ruleRepairer._generateDefault(fieldEn, prd, patched);
          if (fallback && String(fallback).trim()) {
            patched[fieldEn] = fallback;
            // 同步 camelCase 与 fields 嵌套
            const camel = fieldEn.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
            if (camel !== fieldEn) patched[camel] = fallback;
            if (patched.fields && typeof patched.fields === 'object') patched.fields[fieldEn] = fallback;
            autofilled.push(fieldEn);
          }
        }
      }
      if (autofilled.length) {
        console.log(` 🛟 致命问题兜底填充 ${autofilled.length} 项: ${autofilled.join(', ')}`);
        // 兜底也记入修复日志，保持审计完整
        const lastLog = logs[logs.length - 1];
        if (lastLog) {
          for (const f of autofilled) {
            lastLog.add(new RepairAction({
              fieldEn: f, method: 'rule', before: '(空)',
              after: patched[f],
              reason: '降级兜底：达到最大轮次后致命字段自动填充'
            }));
          }
        }
      }
    }

    // 降级标记（下游可感知）
    patched._qualityDegraded = {
      at: new Date().toISOString(),
      fatalAutofilled: autofilled,
      remainingMajor: majorIssues.map(i => `${i.fieldEn}: ${i.description}`),
      remainingMinor: minorIssues.map(i => `${i.fieldEn}: ${i.description}`),
    };

    // 留档待人工复核
    try {
      if (!fs.existsSync(DEGRADED_DIR)) fs.mkdirSync(DEGRADED_DIR, { recursive: true });
      const file = path.join(DEGRADED_DIR, `pending-review-${shotId}-${Date.now()}.json`);
      fs.writeFileSync(file, JSON.stringify({
        shotId,
        at: new Date().toISOString(),
        fatalAutofilled: autofilled,
        remainingMajor: majorIssues,
        remainingMinor: minorIssues,
        suggestion: '请人工复核该镜头的未解决问题，必要时重新生成或手工修复',
      }, null, 2), 'utf8');
      console.log(` 📋 降级留档: ${file}（致命兜底 ${autofilled.length} 项 / 严重待审 ${majorIssues.length} 项 / 轻微 ${minorIssues.length} 项）`);
    } catch (e) {
      console.warn(` ⚠️ 降级留档失败: ${e.message}`);
    }

    return patched;
  }

  /**
   * 批量运行多个镜头
   * @param {Array} shots - 镜头数组
   * @returns {object} { finalShots, allReports, allLogs, summary }
   */
  async runAll(shots) {
    const { SafePromise } = require('../../utils/safe-promise');

    const results = await SafePromise.mapBatch(
      shots,
      (shot, i) => {
        const shotId = shot.shotId || shot.shot_id || `shot_${i}`;
        console.log(`\n${'='.repeat(60)}`);
        console.log(`[FieldQualityPipeline] 处理镜头 ${i + 1}/${shots.length}: ${shotId}`);
        console.log('='.repeat(60));
        return this.run(shot, shotId).then((res) => ({ ...res, shotId, index: i }));
      },
      3 // 质量检查谨慎一点，3个并发
    );

    const finalShots = [];
    const allReports = [];
    const allLogs = [];
    let totalPassed = 0;
    let totalFailed = 0;

    for (const result of results) {
      finalShots.push(result.finalShot);
      allReports.push(...result.reports);
      allLogs.push(...result.logs);

      const lastReport = result.reports[result.reports.length - 1];
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
