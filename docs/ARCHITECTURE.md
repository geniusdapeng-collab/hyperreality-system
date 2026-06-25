# 系统架构与模块说明

## 概述

Hyperreal AI Video System (HAVS) 采用**四层解耦架构**，模拟好莱坞电影工业的完整制作流程，将 AI 能力封装为可复用、可扩展的工业级模块。

## 四层架构

### Layer 1: 剧本引擎 (Script Engine)

**职责**: 从用户创意意图到结构化剧本的转换

**核心模块**:
- `RequirementListBuilder` — 解析用户意图，生成《视频需求要点清单》
- `ScriptGenerator` — 基于需求清单生成结构化剧本（场景、角色、情绪曲线）
- `CharacterExtractor` — 从剧本中提取角色信息，生成角色卡片
- `WorldBuilder` — 构建世界观与场景设定

**输入**: 用户创意意图（自然语言描述）
**输出**: 结构化剧本 JSON（含场景列表、角色配置、情绪曲线）

### Layer 2: 制作引擎 (Production Engine)

**职责**: 将剧本转化为可渲染的标准化镜头语言

**核心模块**:
- `ProductionEngine` — 主控器，协调 8 个 Agent 完成制作流程
- `ScriptAdapter` — 剧本适配，将剧本结构转换为镜头数据
- `ShotDesigner` — 分镜设计，为每个镜头规划运镜、构图、灯光
- `PromptFusionAgent` — 提示词融合，将 25 个字段合并为 Seedance 可渲染的提示词
- `OpeningTitleOptimizer` — 片头标题优化，生成营销级主副标题
- `AudioDesignAgent` — 音频设计，为每个镜头规划环境音、音乐、音效
- `ContinuityReviewAgent` — 连续性检查，确保跨镜头一致性
- `CrossEpisodeValidator` — 跨集校验，确保系列内容连贯
- `FieldGuard` — 字段守护，确保每个镜头 25 个字段完整
- `FieldStandardizer` — 字段标准化，统一命名与格式

**输入**: 结构化剧本
**输出**: 25 字段标准化镜头数组 + 渲染提示词

**25 字段标准**:
1. 导演指令
2. 约束
3. 基础
4. 场景
5. 灯光/照明
6. 构图
7. 色彩/色调
8. 景深
9. 运镜
10. 角色
11. 服装
12. 化妆
13. 动作
14. 道具
15. 定妆照
16. 台词
17. 时间轴
18. 情绪
19. 节奏
20. 转场
21. 音频
22. 负面约束
23. 明亮约束
24. 角色约束
25. 角色一致性

（片头镜头额外包含 5 个字段：主标题内容、副标题内容、标题动画设计、标题字体设计、开场音频设计）

### Layer 3: 渲染引擎 (Rendering Engine)

**职责**: 将标准化提示词提交给视频/图片渲染服务

**核心模块**:
- `RenderingEngine` — 主控器，管理渲染任务队列
- 支持 **Seedance 2.0**（视频）和 **Seedream 5.0**（图片）
- 异步任务轮询、状态追踪、结果管理

**输入**: 25 字段提示词 + 定妆照引用
**输出**: 渲染任务 ID + 视频/图片 URL

### Layer 4: 后期引擎 (Post-Production Engine)

**职责**: 渲染后的音频、标题、连续性优化

**核心模块**:
- `PostProductionEngine` — 主控器，组装最终输出
- 音频设计细化
- 标题与字幕优化
- 跨镜头连续性检查
- 输出格式化（JSON / Markdown）

**输入**: 渲染结果 + 制作数据
**输出**: 最终交付物（含完整提示词、渲染链接、审核报告）

## 横向支撑模块

### 进程守护 (ProcessGuard)

- 全局 `unhandledRejection` / `uncaughtException` 捕获
- 防止 LLM 超时悬空 Promise 导致进程崩溃

### Checkpoint 机制

- 每阶段完成后自动保存状态到 `checkpoint-phase*.json`
- 支持断点续传：任务中断后从最近 Checkpoint 恢复
- 安全序列化：自动处理循环引用和不可序列化数据

### 字段质量流水线 (FieldQualityPipeline)

- 双层检查：规则层（80%确定性问题）+ LLM 层（复杂语义问题）
- 支持多轮迭代修复，直至质量达标或达到最大轮数

## 数据流

```
用户意图
  → [剧本引擎] → 结构化剧本
  → [制作引擎] → 25字段镜头 + 提示词
  → [提示词审核] → 人工确认
  → [渲染引擎] → 视频/图片任务
  → [后期引擎] → 最终交付物
```

## 扩展点

| 扩展点 | 说明 |
|--------|------|
| 自定义渲染后端 | 继承 `RenderingEngine` 接口，接入其他视频服务 |
| 自定义 LLM 模型 | 在 `BaseAgent` 中配置模型接入点 |
| 新增字段 | 修改 `FIELD_ALIAS_MAP` 和 `REQUIRED_FIELDS` 即可扩展镜头语言 |
| 自定义质量规则 | 在 `FieldCheckAgent` 中添加自定义校验规则 |

## 技术栈

- **Runtime**: Node.js ≥ 18
- **LLM**: 兼容 OpenAI API 格式（Kimi / Volcengine Ark / 自定义）
- **视频渲染**: 火山引擎 Seedance 2.0
- **图片生成**: 火山引擎 Seedream 5.0
- **架构模式**: Harness 架构、Multi-Agent 协作、Pipeline 流水线
