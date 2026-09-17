# Shot Card v4.1 Template
# 镜头卡 / 完整版（含v4.1新增字段）
# v4.1规范

## 基本信息

- **所属场次**: {scene_id} ({scene_name})
- **镜头编号**: {shot_id}
- **镜头类型**: {shot_type}
- **镜头优先级**: {priority} (P1-P5)
- **时长**: {duration}秒
- **是否Hero Shot**: {is_hero_shot} (是/否)
- **是否可替代**: {is_replaceable} (是/否)

## 叙事层

- **叙事目的**: {narrative_purpose}
- **主动作**: {primary_action}
- **角色锚点**: {character_anchor}
- **表演目标**: {performance_goal}
- **情绪目标**: {emotion_target}
- **镜内节拍点**: {in_shot_beats}

## 构图层

- **起幅锚点 (OFA)**: {ofa}
- **落幅锚点 (EFA)**: {efa}
- **第一视觉重点**: {primary_poi}
- **景别**: {shot_size}
- **机位**: {camera_position}
- **屏幕方向**: {screen_direction}
- **视线方向**: {gaze_direction}

## 运动层

- **运镜**: {camera_movement}
- **运动强度**: {motion_intensity} (1-5)
- **节奏等级**: {rhythm_level} (静/缓/中/快/爆发)
- **信息密度**: {info_density} (极简/低/中/高/极高)

## 空间环境

- **场景地点**: {location}
- **空间关系**: {spatial_relation}
- **环境特征**: {environment_traits}
- **连续性模式**: {continuity_mode} (strict/soft/none)
- **与前一镜关系**: {prev_shot_relation}
- **与后一镜关系**: {next_shot_relation}

## 光线与材质

- **光线档位**: {light_tier} (A/B/C/D)
- **色温**: {color_temp}
- **对比度**: {contrast_ratio}
- **材质质感**: {material_texture}
- **色彩策略**: {color_strategy}

## 声音与对白

- **对白/台词**: {dialogue}
- **声音事件**: {sound_events}
- **环境音效**: {ambient_sound}
- **音乐提示**: {music_cue}

## 转场与剪辑

- **转场意图**: {transition_intent}
- **剪辑建议**: {editing_suggestion}
- **失败容忍项**: {failure_tolerance}
- **风险点**: {risk_points}

## 质量目标

- **五维目标评分**: {target_scores}
  - 可读性: {target_readability} (权重25%)
  - 可控性: {target_controllability} (权重20%)
  - 可剪性: {target_editability} (权重20%)
  - 情绪命中率: {target_emotion} (权重20%)
  - 记忆点: {target_memorability} (权重15%)
- **目标总分**: {target_total_score}

## 系统约束

- **角色绑定**: {character_bindings}
- **环境约束**: {environment_constraints}
- **禁用元素**: {forbidden_elements}
- **Nirath特征**: {nirath_traits}

## 导演审片

- **存在的理由**: {existence_reason}
- **第一眼看哪里**: {first_look}
- **如果删掉损失什么**: {delete_loss}
- **能否自然接下一镜**: {next_shot_connect}
- **是否有更简单的拍法**: {simpler_method}
- **是否好剪而非仅好看**: {editable_check}

## 导演备注

- **特殊要求**: {special_requirements}
- **参考镜头**: {reference_shots}
- **待确认**: {pending_confirmations}

---

## 下游输出

### 精简渲染Prompt

```
{render_prompt}
```

### 质量评分（实际）

- 实际总分: {actual_total_score}
- 实际评分: {actual_scores}
- 是否通过: {passed}
- 是否可渲染: {can_render}

---

*Shot Card 生成时间: {generation_time}*
*Scene Card确认: {scene_card_approved}*
*状态: {status}*
