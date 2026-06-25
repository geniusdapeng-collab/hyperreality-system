/**
 * Field Quality - 字段质量模块入口
 * 导出: FieldCheckAgent, FieldRepairAgent, FieldQualityPipeline, PRD
 */
const { FieldCheckAgent, RuleChecker, LLMChecker, Issue, CheckReport, FIELD_SPECS, SPEC_MAP, Priority, Severity, IssueType, MAX_TOTAL_CHARS } = require('./field-check-agent');
const { FieldRepairAgent, RuleRepairer, LLMRepairer, RepairAction, RepairLog, PRD } = require('./field-repair-agent');
const { FieldQualityPipeline } = require('./field-quality-pipeline');

module.exports = {
  // 检查环节
  FieldCheckAgent,
  RuleChecker,
  LLMChecker,
  Issue,
  CheckReport,
  FIELD_SPECS,
  SPEC_MAP,
  Priority,
  Severity,
  IssueType,
  MAX_TOTAL_CHARS,
  // 修复环节
  FieldRepairAgent,
  RuleRepairer,
  LLMRepairer,
  RepairAction,
  RepairLog,
  PRD,
  // 主管线
  FieldQualityPipeline,
};
