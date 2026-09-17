# Director Review Form
# 导演审片单 / 六问审片 + 五维评分
# v4.1规范

## 镜头信息

- **镜头编号**: {shot_id}
- **所属场次**: {scene_id} ({scene_name})
- **镜头类型**: {shot_type} ({priority})
- **是否Hero Shot**: {is_hero_shot}

---

## 导演审片六问（必须回答）

### 问1：这一镜存在的理由是什么？
**回答**: {q1_existence_reason}
**评分**: {q1_score}/10

> 判断标准：是否有不可替代的叙事功能？是否服务于Scene Card定义的目标？

### 问2：第一眼看哪里？
**回答**: {q2_first_look}
**评分**: {q2_score}/10

> 判断标准：第一视觉重点是否清晰？观众3秒内能否识别主体？

### 问3：如果删掉这镜，故事损失什么？
**回答**: {q3_delete_loss}
**评分**: {q3_score}/10

> 判断标准：是否承载关键叙事信息？删掉后故事是否断裂？

### 问4：这镜的落幅能否自然接下一镜？
**回答**: {q4_next_shot_connect}
**评分**: {q4_score}/10

> 判断标准：EFA是否清晰？转场意图是否可执行？连续性是否合理？

### 问5：是否存在更简单、更准确的拍法？
**回答**: {q5_simpler_method}
**评分**: {q5_score}/10

> 判断标准：当前方案是否过度复杂？是否有更直接表达同一意图的方式？

### 问6：这镜是否"好剪"而不是仅仅"好看"？
**回答**: {q6_editable_check}
**评分**: {q6_score}/10

> 判断标准：是否方便剪辑节奏？是否有利于前后衔接？是否服务于整体叙事流？

---

## 五维成片导向评分

| 维度 | 权重 | 评分 | 加权分 | 评审标准 |
|------|------|------|--------|----------|
| 可读性 | 25% | {readability_score} | {readability_weighted} | 3秒内识别主体和动作 |
| 可控性 | 20% | {controllability_score} | {controllability_weighted} | 历史成功率与风险点 |
| 可剪性 | 20% | {editability_score} | {editability_weighted} | 落幅锚点清晰，转场意图明确 |
| 情绪命中率 | 20% | {emotion_hit_score} | {emotion_hit_weighted} | 与Scene Card情绪目标对比 |
| 记忆点 | 15% | {memorability_score} | {memorability_weighted} | "一眼难忘"元素 |

**总分**: {total_score} / 100
**等级**: {grade}
**处理建议**: {action}

---

## 阻断条件检查（硬阻断）

| 检查项 | 状态 | 说明 |
|--------|------|------|
| 主视觉中心明确 | {check_subject} | {check_subject_note} |
| 单一动作无竞争 | {check_action} | {check_action_note} |
| 运镜与动作无冲突 | {check_camera} | {check_camera_note} |
| 起幅/落幅完整 | {check_anchors} | {check_anchors_note} |
| 多角色不混乱 | {check_characters} | {check_characters_note} |
| 角色绑定完整 | {check_binding} | {check_binding_note} |
| 利于剪辑衔接 | {check_editable} | {check_editable_note} |
| 方向逻辑成立 | {check_direction} | {check_direction_note} |
| 无系统违规 | {check_violation} | {check_violation_note} |

**阻断状态**: {blocked_status}
**阻断原因**: {block_reasons}

---

## 导演最终决策

- **是否通过**: {approved}
- **是否可渲染**: {can_render}
- **导演备注**: {director_notes}
- **修改建议**: {modification_suggestions}
- **优先级调整**: {priority_adjustment}
- **替代方案**: {fallback_plan}

---

## 质量追踪

- **生成时间**: {generation_time}
- **审片时间**: {review_time}
- **审片人**: {reviewer}
- **版本**: {version}
- **状态**: {status}

---

*注：任何一项阻断条件为"不通过"，或总分低于60分，该镜头不得进入渲染阶段。*
