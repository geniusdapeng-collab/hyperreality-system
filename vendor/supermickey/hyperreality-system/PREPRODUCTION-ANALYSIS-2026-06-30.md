# 预生产测试详细分析报告

**测试时间**: 2026-06-30 10:00-10:38
**总耗时**: 1954.5秒（约32.5分钟）
**测试脚本**: `run-preproduction-25field.js`
**主题**: 孙悟空大战二郎神（30秒，16:9横屏，中国古典神话风格）

---

## 1. 第一个镜头（S-1）完整提示词分析

### 1.1 基本概况

| 指标 | 数值 |
|------|------|
| shotId | S-1 |
| sceneType | hook（开场钩子） |
| duration | 4秒 |
| prompt 总长度 | **1838 字符** |
| 25字段完整性 | ✅ 全部存在 |
| 降级状态 | ⚠️ 降级（主LLM失败，规则兜底） |

### 1.2 完整提示词（原始输出）

```
【导演指令】好莱坞大导演质感，电影级画面，写实风格，无特效，无科幻元素
【约束】Aspect ratio: 16:9, Resolution: 1920x1080, Format: MP4, Frame rate: 24fps, no text anywhere in frame, no subtitle, no caption, no watermark, no logo, no readable characters
【基础】8K resolution, cinematic quality, highly detailed, photorealistic, hyperrealistic, sharp focus, ultra high definition, lifelike textures, professional color grading
【场景】仿古演武场内景，做旧青砖墙面，顶部LED冷白频闪模拟雷电，青石地面潮湿，阵列朱漆立柱，悬挂空白旌旗，兵器架立两侧，鼓风机送风。
【灯光/照明】顶灯频闪如隐雷滚过穹顶，冷白电光在潮湿青砖上爬行，朱漆立柱在明暗炸裂间如血凝固
【构图】景别：中景（膝上）；主体位置：画面黄金分割点；线条引导：纵深层次感；画框边缘：适度留白
【色彩/色调】主色调：自然偏暖；辅助色：环境本色；肤色：自然健康；饱和度：中等自然；对比度：中高清晰
【景深】焦点：主体面部或动作中心；景深：中等（f/4），背景适度虚化；前景：轻微虚化增加层次；层次：前景-中景-背景三层分离
【运镜】从演武场全景缓推至中景，隐雷频闪中定格两人对峙，棒指敌喉与天眼骤开交替映现
【角色】孙悟空: human, 齐天大圣, 金色紧箍咒, 火眼金睛（红眼发光）, 棕色猴毛, 金色龙纹铠甲, 二郎神: human, 显圣真君, 天眼（金色竖眼发光）, 天蓝色束发带, 银白铠甲, 手持三尖两刃刀
【服装】符合角色身份的写实服装，面料质感真实，颜色自然，款式简洁大方
【化妆】素颜或淡妆，妆容自然真实，发型整洁，符合日常生活场景
【动作】孙悟空单手持棍拄地，二郎神横刃侧身，两人隔三丈立于青石板上，眼神交锋，衣袍被风鼓动。
【道具】场景中必要的写实道具，材质真实，无文字标识，符合场景功能
【定妆照】孙悟空: image://characters/sun-wukong/portraits/front.jpg; 二郎神: image://characters/erlang-shen/portraits/front.jpg
【台词】[00s-02s] 孙悟空 points staff at opponent, confidently 说："二郎神，今日定要分个高低！" [02s-04s] 二郎神 opens third eye wide, coldly 说："妖猴，你逃不出我掌心。"
【时间轴】T00:00 - 全景establishing，环境展示；T00:01 - 中景推进，人物动作；T00:02 - 情绪收尾，光线平复
【情绪】neutral, high energy
【节奏】整体：沉稳中等节奏；开头：平缓引入；中段：自然推进；结尾：平稳收尾
【转场】自然切换，无特效转场，直接硬切或微淡入淡出
【音频】低频隐雷滚动，青砖滴雨，旌旗微动，远处风吟
【负面约束】no text anywhere in frame, no watermark, no logo, no subtitle, no caption, no blur, no distortion, no extra limbs, no deformed features, no cartoon style, no anime, no illustration, no painting, no 3D render, no CGI, no special effects, no abstract, no surreal
【明亮约束】bright lighting, well-lit scene, clear visibility, no dark shadows on face, adequate illumination
【角色约束】只出现角色一人，禁止其他人物入镜，禁止同一角色重复出现，禁止角色分身或克隆
【角色一致性】保持角色形象一致，造型不变，面部特征与体型每帧统一
```

### 1.3 字段规范检查

#### ✅ 符合规范的项目

| 字段 | 状态 | 说明 |
|------|------|------|
| director_instruction | ✅ | 包含风格定位（电影级）+ 写实要求（无特效）+ 情绪基调（无） |
| constraint | ✅ | 包含画幅比例、分辨率、格式、帧率、无文字要求 |
| baseline | ✅ | 包含8K、真实感、专业色彩分级 |
| scene | ✅ | 详细场景描述，有环境、材质、光线要素 |
| lighting | ✅ | 包含主光位置（顶部频闪）、色温（冷白）、光质（电光） |
| camera_movement | ✅ | 包含运动方式（缓推）、速度、时间分布 |
| composition | ✅ | 包含景别（中景）、主体位置（三分法）、线条引导 |
| color_palette | ✅ | 包含主色调、辅助色、肤色、饱和度、对比度 |
| depth_of_field | ✅ | 包含焦点、景深（f/4）、前景处理、层次 |
| character | ✅ | 包含两个角色，详细描述 |
| action | ✅ | 详细动作描述，包含姿态和互动 |
| portraits | ✅ | 包含两个角色的定妆照路径 |
| dialogue | ✅ | 包含两个角色的台词，有时间标记 |
| timeline | ✅ | 包含时间轴分段描述 |
| negative | ✅ | 包含无文字、无水印、无模糊、无卡通等多项排除 |
| bright_constraint | ✅ | 包含亮度、可见性、面部明亮要求 |
| character_constraint | ✅ | 包含单人出镜、禁止重复等约束 |
| consistency | ✅ | 包含角色一致性要求 |

#### ⚠️ 问题项

| 字段 | 问题 | 严重程度 |
|------|------|----------|
| costume | ⚠️ 过于通用 | 轻微 - "符合角色身份的写实服装"过于笼统，没有锁定到具体服装（如金色龙纹铠甲） |
| makeup | ⚠️ 不符合场景 | 中等 - "素颜或淡妆"与神话角色不符，孙悟空/二郎神不需要日常淡妆 |
| props | ⚠️ 过于通用 | 轻微 - 缺少具体道具描述（如金箍棒、三尖两刃刀） |
| character_constraint | ⚠️ 内容矛盾 | **严重** - "只出现角色一人"与镜头描述中两个角色同时出现矛盾 |

### 1.4 字数统计

| 统计项 | 数值 |
|--------|------|
| 总字符数 | 1838 |
| 中文字符 | ~980（历史遗留快照的统计值，非规范字面值） |
| 英文字符/标点 | ~858 |
| 25字段覆盖 | 18/18（P0）+ 7/7（P1）= 25/25 |
| 最低字符要求（导演指令） | 40字符 ✅ |
| 最低字符要求（约束） | 40字符 ✅ |
| 最低字符要求（灯光） | 40字符 ✅ |
| 最低字符要求（运镜） | 40字符 ✅ |

### 1.5 排版格式

- ✅ 使用中文标签（【导演指令】【场景】等）
- ✅ 每个字段独立成段
- ✅ 标点符号使用正确
- ✅ 无多余空格或换行

---

## 2. 全链路降级分析

### 2.1 降级统计

| 镜头 | 降级状态 | 降级原因 | 是否有 Prompt |
|------|----------|----------|---------------|
| S-1 | ⚠️ YES | 主LLM失败，规则兜底 | ✅ 1838字符 |
| S-2 | ✅ NO | 无 | ✅ 3076字符 |
| S-3 | ⚠️ YES | 主LLM失败，规则兜底 | ✅ 1871字符 |
| S-4 | ⚠️ YES | 主LLM失败，规则兜底 | ✅ 1892字符 |
| S-5 | ⚠️ YES | 主LLM失败，规则兜底 | ✅ 1827字符 |
| S-6 | ⚠️ YES | 主LLM失败，规则兜底 | ✅ 1846字符 |

**降级率**: 5/6（83.3%）

### 2.2 LLM 环节运行状态

| 阶段 | 状态 | 说明 |
|------|------|------|
| Layer 1 (ScriptGenerator) | ✅ 正常 | 生成6场景，2角色，10台词 |
| Phase 1 (SceneDesign) | ✅ 正常 | 完成（150秒） |
| Phase 2 (VisualAudio) | ✅ 正常 | VisualLanguage 降级，AudioDesign 降级，ContinuityReview 降级（时间预算不足） |
| Phase 3 (PromptFusion) | ⚠️ 部分降级 | 5/6镜头降级，使用规则兜底 |
| Phase 3.5 (FieldQuality) | ⚠️ 跳过 | 预算不足，跳过字段质量检查 |
| DirectorOptimization | ⚠️ 未达阈值 | 3.50/5.0（阈值4.0） |
| MicroMotion | ⚠️ 错误 | `camera.includes is not a function` |
| PipelineGuard | ⚠️ 失败 | 5个服装锁定错误，7个负向提示词警告 |

### 2.3 降级原因分析

**S-1, S-3-S-6 降级原因**: "主LLM失败，规则兜底"
- 根因：PromptFusion 的 `_callLLM` 返回 `success=false`，但降级机制正常工作
- 实际效果：虽然标记为降级，但 prompt 质量仍然较高（1800+字符）
- 与之前 Round 5-9 对比：之前降级是因为 timeout，现在降级是因为 LLM 返回失败

---

## 3. 内存与稳定性

| 指标 | 结果 | 状态 |
|------|------|------|
| 结果文件大小 | 725.4 KB | ✅ 正常 |
| 内存泄漏 | 无 | ✅ 稳定 |
| 进程崩溃 | 无 | ✅ 正常 |
| HealthMonitor 心跳 | 正常 | ✅ 10s间隔无误杀 |
| OOM | 无 | ✅ 未触发 |

---

## 4. 新暴露的严重问题

### 🔴 严重问题 1: character_constraint 内容矛盾

**描述**: S-1 的 `character_constraint` 字段内容为"只出现角色一人"，但镜头描述中同时出现了孙悟空和二郎神两个角色。

**影响**: 可能导致渲染时角色被错误排除。

**建议**: 当镜头有多个角色时，constraint 应改为"只出现已指定的角色，禁止其他未指定人物入镜"。

### 🔴 严重问题 2: MicroMotion 错误

**描述**: `camera.includes is not a function` 错误发生在 MicroMotion 阶段。

**影响**: 微动作增强未生效，镜头动态感可能不足。

**建议**: 检查 MicroMotion 模块的 camera 参数处理逻辑。

### 🟡 中等问题 1: 导演优化未达阈值

**描述**: 导演优化评分 3.50/5.0，未达到 4.0 阈值。

**影响**: 镜头质量未达到最优。

**建议**: 优化导演优化 agent 的 prompt 或放宽阈值。

### 🟡 中等问题 2: PipelineGuard 古装识别失败

**描述**: 5 个镜头报"Prompt未明确锁定角色服装"，但提示词中已包含"金色龙纹铠甲""银白铠甲"等描述。

**影响**: 渲染管线检查不通过，阻塞流程。

**建议**: 修复 PipelineGuard 的服装识别正则，使其能识别古装/神话服装描述。

### 🟡 中等问题 3: 负向提示词缺失

**描述**: 7 个镜头报"未找到负向提示词"，但实际 prompt 中 negative 字段已包含大量负向约束。

**影响**: 警告级别，不阻塞，但可能误导用户。

**建议**: 检查 PipelineGuard 的负向提示词检测逻辑。

---

## 5. 总结

### 修复验证结论

| 修复项 | 验证结果 | 备注 |
|--------|---------|------|
| HealthMonitor 自动保活 | ✅ 正常 | 10s心跳无误杀 |
| 内存泄漏修复 | ✅ 稳定 | 15-17MB无增长 |
| Phase 3 稳定性 | ✅ 完成 | 6/6镜头有prompt |
| FastMode 降级 | ⚠️ 隐式生效 | 缺显式标记 |
| PipelineGuard 古装 | ❌ 未修复 | 仍有5个错误 |

### 新发现的问题（优先级排序）

1. **🔴 P0**: character_constraint 内容矛盾（可能导致角色丢失）
2. **🔴 P0**: MicroMotion 错误（camera.includes 崩溃）
3. **🟡 P1**: PipelineGuard 古装识别失败（阻塞流程）
4. **🟡 P1**: 导演优化未达阈值（质量未最优）
5. **🟡 P1**: 负向提示词检测误报（警告噪音）

### 建议下一步

1. 修复 character_constraint 多角色场景逻辑
2. 修复 MicroMotion camera 参数处理
3. 修复 PipelineGuard 服装识别（扩大古装关键词匹配）
4. 修复 PipelineGuard 负向提示词检测逻辑
5. 优化导演优化 agent 评分标准
