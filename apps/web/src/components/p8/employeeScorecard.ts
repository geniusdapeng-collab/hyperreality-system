/**
 * 员工卡 · 成绩单层指标口径（六指标行业口径，按 preset_key 映射）
 *  - 渲染师 / 发布专员 / 评论区运营 / 数据看板官：行业专属三指标
 *  - 其他工种：通用三指标（任务完成率/驳回率/及时率）
 * 数值经 captain 成绩单/决策回测端点取数，缺省显示「本周未出评」（不伪造）。
 */

export interface ScorecardMetric {
  key: string;
  label: string;
  /** 指标口径说明（悬停提示） */
  hint: string;
}

export interface ScorecardSpec {
  /** 成绩单标题（行业口径名） */
  title: string;
  metrics: ScorecardMetric[];
}

/** 通用三指标（默认兜底） */
export const GENERIC_SCORECARD: ScorecardSpec = {
  title: "通用成绩单",
  metrics: [
    { key: "completion_rate", label: "任务完成率", hint: "周期内办结任务 / 派发任务" },
    { key: "reject_rate", label: "驳回率", hint: "被驳回动作 / 进审批动作（越低越好）" },
    { key: "timeliness", label: "及时率", hint: "SLA 窗口内完成动作占比" },
  ],
};

/** 六指标行业口径映射（按 preset_key；命中不到走 GENERIC_SCORECARD） */
export const EMPLOYEE_SCORECARD: Record<string, ScorecardSpec> = {
  "render-operator": {
    title: "渲染师成绩单",
    metrics: [
      { key: "first_pass_rate", label: "一次通过率", hint: "首次提交即过 G8 审的渲染任务占比" },
      { key: "waste_rate", label: "废片率", hint: "渲染产出被判定不可用占比（越低越好）" },
      { key: "cost_deviation", label: "单集成本偏差", hint: "实际烧额度 vs 单集预算的偏差幅度" },
    ],
  },
  "publish-operator": {
    title: "发布专员成绩单",
    metrics: [
      { key: "compliance_rate", label: "发布合规率", hint: "过 G9 发布包校验且零违规的发布占比" },
      { key: "rpa_success_rate", label: "RPA 成功率", hint: "RPA 模拟人工上传成功且有回执占比" },
      { key: "schedule_punctuality", label: "排期准点率", hint: "按排期窗口准点发布占比" },
    ],
  },
  "comment-operator": {
    title: "评论区运营成绩单",
    metrics: [
      { key: "routing_accuracy", label: "分流准确率", hint: "三级分流（auto/review/block）判定正确占比" },
      { key: "negative_sla", label: "负面响应及时率", hint: "负面评论在 SLA 内响应占比" },
      { key: "misjudge_rate", label: "误判率", hint: "人工复核推翻机器分流占比（越低越好）" },
    ],
  },
  "metrics-watcher": {
    title: "数据看板官成绩单",
    metrics: [
      { key: "alert_precision", label: "告警准确率", hint: "阈值告警经复盘确认有效占比" },
      { key: "brief_punctuality", label: "日报准点率", hint: "早八点日报准点投递占比" },
      { key: "anomaly_lead", label: "异常发现提前量", hint: "异常发现早于人工察觉的平均时长" },
    ],
  },
};

export function scorecardOf(presetKey: string): ScorecardSpec {
  return EMPLOYEE_SCORECARD[presetKey] ?? GENERIC_SCORECARD;
}
