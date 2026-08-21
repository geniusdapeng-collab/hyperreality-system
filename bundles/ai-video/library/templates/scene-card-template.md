# Scene Card Template
# 场景卡 / 上游控制文档
# v4.1规范

## 基本信息

- **场次编号**: {scene_number}
- **场次名称**: {scene_name}
- **所属剧集**: {episode}
- **场景地点**: {location}
- **时间状态**: {time_state}
- **主要角色**: {main_characters}
- **时长预算**: {duration_budget}秒

## 场次功能

- **功能类型**: {scene_function} (建立/推进/冲突/揭示/回收)
- **场次目标**: 观众必须知道：{audience_must_know}
- **叙事作用**: {narrative_purpose}

## 情绪曲线

- **起始情绪**: {emotion_start}
- **目标情绪**: {emotion_end}
- **情绪转折点**: {emotion_turning_point}
- **情绪强度**: {emotion_intensity} (1-10)

## 光线策略

- **光线档位**: {light_tier} (A/B/C/D)
- **光线变化**: {light_change}
- **色温设定**: {color_temperature}
- **参考场次**: {light_reference}

## 色彩策略

- **主色调**: {primary_palette}
- **强调色**: {accent_color}
- **禁用色**: {forbidden_colors}
- **色彩推进**: {color_progression}

## 轴线设定

- **180度线**: {axis_line}
- **屏幕方向**: {screen_direction}
- **视线方向**: {gaze_direction}
- **空间关系**: {spatial_relationship}

## 连续性规划

- **连续性模式**: {continuity_mode} (strict/soft/none)
- **连续镜头段**: {continuous_shots}
- **转场意图**: {transition_intent}
- **与前后场次关系**: {prev_next_relation}

## 镜头规划

- **镜头数量**: {shot_count}
- **Hero Shots**: {hero_shots}
- **关键镜头**: {key_shots}
- **可删减镜头**: {replaceable_shots}

## 风险评估

- **技术风险**: {technical_risks}
- **内容风险**: {content_risks}
- **失败容忍项**: {failure_tolerance}
- **替代方案**: {fallback_plan}

## 交付重点

- **必须交付**: {must_deliver}
- **质量标杆**: {quality_anchor}
- **时间优先级**: {time_priority}
- **资源预算**: {resource_budget}

## 导演备注

- **创作意图**: {creative_intent}
- **参考作品**: {references}
- **特殊要求**: {special_requirements}
- **待确认事项**: {pending_decisions}

---

## Shot Card 生成控制

**Scene Card确认后，方可生成Shot Card。**

- **Shot Card字段要求**: 使用v4.1完整字段（OFA/EFA/节拍点/屏幕方向/优先级）
- **Prompt长度策略**: 按需精简，不追求填满
- **质量目标**: 五维评分≥75分
- **导演审片**: 必须回答六问

---

*Scene Card 生成时间: {generation_time}*
*导演确认: {director_approval}*
*状态: {status}*
