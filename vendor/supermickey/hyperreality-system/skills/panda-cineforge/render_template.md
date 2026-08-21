{% set _body = body if body is defined else {} %}
{% set _ctx = _body.context_analysis if _body.context_analysis is defined else (context_analysis if context_analysis is defined else {}) %}
{% set _dec = _body.decision_summary if _body.decision_summary is defined else (decision_summary if decision_summary is defined else {}) %}
{% set _orch = _body.orchestration_integration if _body.orchestration_integration is defined else (orchestration_integration if orchestration_integration is defined else {}) %}
{% set _recall = _body.recall_optimization if _body.recall_optimization is defined else (recall_optimization if recall_optimization is defined else {}) %}
{% set _exp = _body.expert_recommendation if _body.expert_recommendation is defined else (expert_recommendation if expert_recommendation is defined else {}) %}
{% set _tool = _body.tool_plan if _body.tool_plan is defined else (tool_plan if tool_plan is defined else {}) %}
{% set _agent = _body.agent_logic if _body.agent_logic is defined else (agent_logic if agent_logic is defined else {}) %}
{% set _qa = _body.qa_report if _body.qa_report is defined else (qa_report if qa_report is defined else {}) %}
{% set _tldr = _body.tl_dr if _body.tl_dr is defined else (tl_dr if tl_dr is defined else '') %}
---
name: "{{ name }}"
skill_id: "{{ skill_id }}"
version: "{{ version }}"
last_updated: "{{ last_updated }}"

domain: "{{ domain }}"
sub_domain: "{{ sub_domain }}"
vertical: "{{ vertical }}"
type: "{{ type }}"
priority: "{{ priority }}"

cinematic_role: "{{ cinematic_role }}"
module_target: {{ module_target }}
deliverable_type: "{{ deliverable_type }}"
project_stage: "{{ project_stage }}"

execution_layer: "{{ execution_layer }}"
execution_mode: "{{ execution_mode }}"

module_compatibility:
  {% for k, v in module_compatibility.items() %}{{ k }}: {{ v }}
  {% endfor %}
fallback_strategy:
  level1_tool: "{{ fallback_strategy.level1_tool }}"
  level2_data: "{{ fallback_strategy.level2_data }}"
  level3_output: "{{ fallback_strategy.level3_output }}"

persona_adaptation:
  user_profile: {{ persona_adaptation.user_profile }}
  modes: {{ persona_adaptation.modes | tojson }}
  constraints:
    safety_first: {{ persona_adaptation.constraints.safety_first }}
    location_aware: {{ persona_adaptation.constraints.location_aware }}
    time_sensitive: {{ persona_adaptation.constraints.time_sensitive }}

capabilities:
  tools: {{ capabilities.tools | tojson }}
  data_sources: {{ capabilities.data_sources | tojson }}
  output_formats: {{ capabilities.output_formats | tojson }}

retrieval_profile:
  logical_topics: {{ retrieval_profile.logical_topics | tojson }}
  aliases: {{ retrieval_profile.aliases | tojson }}
  sample_queries: {{ retrieval_profile.sample_queries | tojson }}
  problem_patterns: {{ retrieval_profile.problem_patterns | tojson }}
  entities:
    who: {{ retrieval_profile.entities.who | tojson }}
    actions: {{ retrieval_profile.entities.actions | tojson }}
    objects: {{ retrieval_profile.entities.objects | tojson }}
  scenarios: {{ retrieval_profile.scenarios | tojson }}
  project_stages: {{ retrieval_profile.project_stages | tojson }}
  urgency: "{{ retrieval_profile.urgency }}"
  negative_queries: {{ retrieval_profile.negative_queries | tojson }}
  summary: "{{ retrieval_profile.summary }}"

index_optimization:
  weighted_recall_text: |
    {{ index_optimization.weighted_recall_text }}
  neighbors: {{ index_optimization.neighbors | tojson }}
  channel_weights: {{ index_optimization.channel_weights | tojson }}

quality_thresholds: {{ quality_thresholds | tojson }}
dependencies: {{ dependencies | tojson }}

maturity: "{{ maturity | default('v0') }}"
forge_mode: "{{ forge_mode | default('cold') }}"

knowledge_provenance: {{ knowledge_provenance | tojson }}

author: "{{ author }}"
tags: {{ tags | tojson }}
status: "{{ status }}"
license: "{{ license }}"

generation_spec: {{ generation_spec | tojson }}
runtime_contract: {{ runtime_contract | tojson }}
execution_contract: {{ execution_contract | tojson }}
qa_contract: {{ qa_contract | tojson }}
domain_pack: {{ domain_pack | tojson }}
---

## TL;DR

{{ _tldr }}

## 1. 场景分析

### 请求摘要
{{ _ctx.request_summary if _ctx.request_summary is defined else "" }}

### 显性需求
{% if _ctx.explicit_needs is defined and _ctx.explicit_needs %}{% for item in _ctx.explicit_needs %}- {{ item }}
{% endfor %}{% else %}- 暂无{% endif %}

### 隐性需求
{% if _ctx.implicit_needs is defined and _ctx.implicit_needs %}{% for item in _ctx.implicit_needs %}- {{ item }}
{% endfor %}{% else %}- 暂无{% endif %}

### 场景分类
- `scenario_classification`: {{ _ctx.scenario_classification if _ctx.scenario_classification is defined else "" }}
- `urgency`: {{ _ctx.urgency if _ctx.urgency is defined else "" }}

### 上下文快照
- 时间：{{ _ctx.context_snapshot.time if _ctx.context_snapshot is defined and _ctx.context_snapshot.time is defined else "" }}
- 相关角色：{{ _ctx.context_snapshot.actors | tojson if _ctx.context_snapshot is defined and _ctx.context_snapshot.actors is defined else "[]" }}

### 约束（影视六类）
#### 时间约束（交片期/排期/Deadline）
{% if _ctx.constraints is defined and _ctx.constraints.time is defined and _ctx.constraints.time %}{% for item in _ctx.constraints.time %}- {{ item }}
{% endfor %}{% else %}- 暂无{% endif %}
#### 预算约束（制作预算/渲染成本）
{% if _ctx.constraints is defined and _ctx.constraints.budget is defined and _ctx.constraints.budget %}{% for item in _ctx.constraints.budget %}- {{ item }}
{% endfor %}{% else %}- 暂无{% endif %}
#### 设备/权限约束（渲染农场/软件许可/AI模型配额）
{% if _ctx.constraints is defined and _ctx.constraints.device is defined and _ctx.constraints.device %}{% for item in _ctx.constraints.device %}- {{ item }}
{% endfor %}{% else %}- 暂无{% endif %}
#### 合规约束（版权/平台审核/敏感内容）
{% if _ctx.constraints is defined and _ctx.constraints.compliance is defined and _ctx.constraints.compliance %}{% for item in _ctx.constraints.compliance %}- {{ item }}
{% endfor %}{% else %}- 暂无{% endif %}
#### 创意约束（导演意图/风格一致性/品牌调性）
{% if _ctx.constraints is defined and _ctx.constraints.creative is defined and _ctx.constraints.creative %}{% for item in _ctx.constraints.creative %}- {{ item }}
{% endfor %}{% else %}- 暂无{% endif %}
#### 技术约束（色彩空间/帧率/分辨率/画幅）
{% if _ctx.constraints is defined and _ctx.constraints.technical is defined and _ctx.constraints.technical %}{% for item in _ctx.constraints.technical %}- {{ item }}
{% endfor %}{% else %}- 暂无{% endif %}

### 假设
{% if _ctx.assumptions is defined and _ctx.assumptions %}{% for item in _ctx.assumptions %}- {{ item }}
{% endfor %}{% else %}- 无{% endif %}

### 缺失信息
{% if _ctx.missing_information is defined and _ctx.missing_information %}{% for item in _ctx.missing_information %}- {{ item }}
{% endfor %}{% else %}- 无{% endif %}

## 2. 决策摘要

### 主策略
{{ _dec.chosen_strategy if _dec.chosen_strategy is defined else "" }}

### 备选方案
{% if _dec.alternatives_considered is defined and _dec.alternatives_considered %}{% for item in _dec.alternatives_considered %}- {{ item }}
{% endfor %}{% else %}- 暂无{% endif %}

### 被排除方案
{% if _dec.rejected_options is defined and _dec.rejected_options %}{% for item in _dec.rejected_options %}- {{ item }}
{% endfor %}{% else %}- 暂无{% endif %}

### 风险权衡
{% if _dec.risk_rationale is defined and _dec.risk_rationale %}{% for item in _dec.risk_rationale %}- {{ item }}
{% endfor %}{% else %}- 暂无{% endif %}

## 3. 编排集成
{% if _orch.query_understanding is defined and _orch.query_understanding %}{% for item in _orch.query_understanding %}- {{ item }}
{% endfor %}{% else %}- 暂无{% endif %}

## 4. 召回优化
### 索引文本预览
```text
{{ _recall.index_text_preview if _recall.index_text_preview is defined else index_optimization.weighted_recall_text }}
```

## 5. 专业建议

### 主推荐
{{ _exp.recommended_option if _exp.recommended_option is defined else "" }}

### A. 立即执行
{% if _exp.immediate_actions is defined and _exp.immediate_actions %}{% for item in _exp.immediate_actions %}{{ loop.index }}. **步骤**：{{ item.step }}
   - 原因：{{ item.why }}
   - 预期结果：{{ item.expected_result }}
{% endfor %}{% else %}- 暂无{% endif %}

### B. 深度方案
#### 主方案
{% if _exp.deep_solution is defined and _exp.deep_solution.main_plan is defined and _exp.deep_solution.main_plan %}{% for item in _exp.deep_solution.main_plan %}- {{ item }}
{% endfor %}{% else %}- 暂无{% endif %}
#### 备选方案
{% if _exp.deep_solution is defined and _exp.deep_solution.alternatives is defined and _exp.deep_solution.alternatives %}{% for item in _exp.deep_solution.alternatives %}- {{ item }}
{% endfor %}{% else %}- 暂无{% endif %}
#### 失败回退
{% if _exp.deep_solution is defined and _exp.deep_solution.fallback_plan is defined and _exp.deep_solution.fallback_plan %}{% for item in _exp.deep_solution.fallback_plan %}- {{ item }}
{% endfor %}{% else %}- 暂无{% endif %}

### C. 长期资产
{% if _exp.long_term_assets is defined and _exp.long_term_assets %}{% for item in _exp.long_term_assets %}- **{{ item.asset_type }}** / `{{ item.asset_name }}`：{{ item.description }}
{% endfor %}{% else %}- 暂无{% endif %}

### 领域知识
{% if _exp.domain_knowledge is defined and _exp.domain_knowledge %}{% for item in _exp.domain_knowledge %}- {{ item }}
{% endfor %}{% else %}- 暂无{% endif %}

### 风险提示
{% if _exp.risk_warnings is defined and _exp.risk_warnings %}{% for item in _exp.risk_warnings %}- {{ item }}
{% endfor %}{% else %}- 暂无{% endif %}

### 升级规则
{% if _exp.escalation_rules is defined and _exp.escalation_rules %}{% for item in _exp.escalation_rules %}- {{ item }}
{% endfor %}{% else %}- 暂无{% endif %}

## 6. 工具调用计划

### 计划调用链
{% if _tool.planned_tool_chain is defined and _tool.planned_tool_chain %}{% for item in _tool.planned_tool_chain %}{{ loop.index }}. **工具**：`{{ item.tool }}`
   - 目的：{{ item.purpose }}
   - 输入映射：{{ item.input_mapping }}
   - 预期输出：{{ item.expected_output }}
   - 失败降级：{{ item.fallback }}
   - 时效要求：{{ item.freshness_requirement }}
   - 安全限制：{{ item.safety_guard }}
{% endfor %}{% else %}- 当前无需调用工具，或未提供工具链。{% endif %}

## 7. Agent执行逻辑

### 自动化等级
`{{ _agent.automation_level if _agent.automation_level is defined else generation_spec.automation_level }}`

### 输入校验
{% if _agent.input_validation is defined and _agent.input_validation %}{% for item in _agent.input_validation %}- {{ item }}
{% endfor %}{% else %}- 暂无{% endif %}

### 分支逻辑
{% if _agent.branching_logic is defined and _agent.branching_logic %}{% for item in _agent.branching_logic %}- {{ item }}
{% endfor %}{% else %}- 暂无{% endif %}

### 写操作
{% if _agent.write_actions is defined and _agent.write_actions %}{% for item in _agent.write_actions %}- {{ item }}
{% endfor %}{% else %}- 暂无{% endif %}

### 回滚策略
{% if _agent.rollback_strategy is defined and _agent.rollback_strategy %}{% for item in _agent.rollback_strategy %}- {{ item }}
{% endfor %}{% else %}- 暂无{% endif %}

### 伪代码 / 代码
```python
{{ _agent.pseudocode if _agent.pseudocode is defined else "" }}
```

## 8. 质量检查

- `structural_check`: {{ _qa.structural_check if _qa.structural_check is defined else "" }}
- `risk_check`: {{ _qa.risk_check if _qa.risk_check is defined else "" }}
- `execution_safety_check`: {{ _qa.execution_safety_check if _qa.execution_safety_check is defined else "" }}
- `personalization_check`: {{ _qa.personalization_check if _qa.personalization_check is defined else "" }}
- `source_check`: {{ _qa.source_check if _qa.source_check is defined else "" }}

### 总分
**{{ _qa.overall_score if _qa.overall_score is defined else "" }}**

### 问题列表
{% if _qa.issues is defined and _qa.issues %}{% for item in _qa.issues %}- {{ item }}
{% endfor %}{% else %}- 无{% endif %}

### 最终状态
**{{ _qa.final_status if _qa.final_status is defined else "" }}**