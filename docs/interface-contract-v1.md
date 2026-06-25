# 示例世界 Video System v7.0 — 四层架构接口契约 v1.0

> 版本：v1.0 | 日期：2026-06-07 | 状态：设计稿
> 基于：ScriptCraft Engine 融合架构 v2.0（队长设计）+ 当前 v6.5.12 系统现状

---

## 一、设计原则

### 1.1 渐进迁移，不推翻重来
- 当前 v6.5.12 的 `example-world-pipeline.js`（317KB）**不删除**，逐步拆解
- 新模块独立目录，通过适配层对接旧系统
- 每次迭代必须能跑通完整预生产（P0-固化原则）

### 1.2 接口契约先行，实现后置
- 四层之间先定义 JSON Schema，再写代码
- 契约一旦确定，各层可独立开发、独立测试
- 共享内核先定义接口，引擎再按需接入

### 1.3 剧本引擎优先落地
- 剧本引擎是下游三层的"单一真相源"
- 当前系统痛点：剧本硬编码在 LLM Prompt 里，无结构化中间层
- 剧本引擎一旦落地，现有 Pipeline 从"生产者"降级为"消费者"

---

## 二、四层架构总览

```
┌─────────────────────────────────────────────┐
│  Layer 1: 剧本引擎 (Script Engine)            │
│  ├─ 用户意图解析 → 剧本生成 → 结构化输出       │
│  └─ 单一真相源：下游三层只读剧本，不可修改      │
├─────────────────────────────────────────────┤
│  Layer 2: 制作引擎 (Production Engine)        │
│  ├─ 剧本拆解 → 镜头设计 → Prompt工程          │
│  └─ 当前 v6.5.12 的核心能力迁移至此           │
├─────────────────────────────────────────────┤
│  Layer 3: 渲染引擎 (Rendering Engine)        │
│  ├─ 多模型抽象层：Seedance / Kling / Pika...  │
│  └─ 当前强耦合 Seedance，需解耦               │
├─────────────────────────────────────────────┤
│  Layer 4: 后期引擎 (Post-Production Engine)    │
│  ├─ AI剪辑 / 配乐 / 字幕 / 包装 / 统一色调     │
│  └─ 当前空白，从基础剪辑起步                  │
└─────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────┐
│  Shared Kernel: 共享内核                     │
│  ├─ LLM Router / Token Budget / Process Mgr  │
│  ├─ Version Manager / Checkpoint Mgr         │
│  ├─ Compliance Engine / Auto-Repair Loop     │
│  └─ 通用工坊：Scene / Voice / Visual         │
└─────────────────────────────────────────────┘
```

---

## 三、接口契约（四层间数据模型）

### 3.1 契约总览

| 接口 | 上游 | 下游 | 数据模型 | 说明 |
|------|------|------|----------|------|
| **IC-1** | 用户 / 入口层 | 剧本引擎 | `UserIntent` | 用户原始需求 + 元数据 |
| **IC-2** | 剧本引擎 | 制作引擎 | `ScriptBlueprint` | 结构化剧本（单一真相源） |
| **IC-3** | 制作引擎 | 渲染引擎 | `ShotPrompt` | 单镜头提示词 + 参考图 + 渲染参数 |
| **IC-4** | 渲染引擎 | 后期引擎 | `RenderedClip` | 渲染片段 + 元数据 + 质量报告 |
| **IC-5** | 后期引擎 | 输出层 | `FinalVideo` | 最终成品 + 包装信息 |

---

### 3.2 IC-1: UserIntent → 剧本引擎输入

```json
{
  "$schema": "example://schemas/user-intent/v1",
  "intent_id": "uuid",
  "raw_input": "用户原始输入文本",
  "parsed": {
    "narrative_mode": "dramatic | educational | documentary | lifelog | commercial | hybrid",
    "primary_mode": "dramatic",
    "secondary_modes": ["commercial"],
    "hybrid_config": {
      "mode_weights": { "dramatic": 0.6, "commercial": 0.4 },
      "handover_points": ["climax", "resolution"]
    }
  },
  "metadata": {
    "title": "示例项目：神兽 系列",
    "target_duration": 120,
    "target_platform": ["tiktok", "bilibili"],
    "language": "zh-CN",
    "style_tags": ["hyper-realistic", "cinematic", "epic"],
    "world_setting": "示例世界",
    "featured_beast_id": "taotie",
    "protagonist": "示例角色"
  },
  "constraints": {
    "max_prompt_length": 980,
    "reference_image_count": 2,
    "forbidden_elements": ["voiceover", "metal_gloss", "unnatural_eye_color"]
  }
}
```

**关键字段说明**：
- `narrative_mode`: 由意图路由器自动识别（当前系统默认为 `dramatic`）
- `world_setting`: 世界观标识（示例世界 / 地球 / 自定义）
- `featured_beast_id`: 异兽主角 ID（如 `taotie`）
- `constraints`: 系统级约束，直接透传至下游

---

### 3.3 IC-2: ScriptBlueprint → 剧本引擎输出 / 制作引擎输入

**核心设计：这是整个系统的"单一真相源"**

```json
{
  "$schema": "example://schemas/script-blueprint/v1",
  "blueprint_id": "uuid",
  "version": "1.0.0",
  "intent_ref": "引用 IC-1 intent_id",
  
  "meta": {
    "title": "示例项目：神兽 系列",
    "narrative_mode": "dramatic",
    "target_duration": 120,
    "acts_count": 3,
    "scenes_count": 5
  },

  "structure": {
    "acts": [
      {
        "act_id": "ACT-1",
        "act_name": "序幕：示例世界召唤",
        "act_function": "establish",
        "start_time": 0,
        "end_time": 15,
        "beats": [
          {
            "beat_id": "B-1.1",
            "beat_type": "hook",
            "description": "示例角色从银灰传送门降临示例世界",
            "target_emotion": "wonder"
          }
        ]
      }
    ],
    "scenes": [
      {
        "scene_id": "SC00",
        "scene_name": "片头：降临",
        "scene_type": "opening",
        "scene_function": "establish",
        "act_id": "ACT-1",
        "timing": { "start": 0, "duration": 15, "end": 15 },
        "characters": ["示例角色"],
        "setting": "示例世界星球，硅晶草原，双月当空",
        "dialogue": {
          "has_dialogue": true,
          "lines": [
            { "speaker": "示例角色", "text": "原来这就是示例世界...", "emotion": "awe" }
          ]
        },
        "visual_notes": "电影级远景，超写实，双月光晕",
        "emotional_target": { "valence": 0.8, "arousal": 0.6, "dominance": 0.5 },
        "references": { "previous": null, "next": "SC01" }
      }
    ]
  },

  "character_system": {
    "characters": [
      {
        "character_id": "示例角色",
        "name": "示例角色",
        "role": "protagonist",
        "voice_profile": {
          "persona": "示例世界探索者，年轻男性，银灰装甲",
          "tone": "curious_warm",
          "speaking_style": "口语化，略带感叹，适合短视频节奏"
        },
        "visual_anchor": {
          "core_features": ["银灰装甲", "东亚面孔短发", "年轻男性"],
          "reference_images": ["characters/示例角色/front.jpg"]
        }
      },
      {
        "character_id": "taotie",
        "name": "示例神兽",
        "role": "featured_beast",
        "voice_profile": null,
        "visual_anchor": {
          "core_features": ["碳化硅质甲壳", "腋下双眼", "巨口能量涡流"],
          "reference_images": ["characters/tao-tie/front.jpg"]
        }
      }
    ]
  },

  "voice_system": {
    "global_voice_policy": "dialogue_only_no_voiceover",
    "voice_profiles": [
      {
        "voice_id": "V-示例角色",
        "character_id": "示例角色",
        "role": "protagonist",
        "tone": "warm_curious",
        "pace": "moderate",
        "constraints": {
          "forbidden_words": ["旁白", "解说"],
          "max_line_length": 30
        }
      }
    ]
  },

  "world_setting": {
    "world_id": "example",
    "world_name": "示例世界星球",
    "era": "上古纪元",
    "core_rules": [
      "示例世界是地球前身",
      "虚构生命形态共存",
      "《古籍神话》实为示例世界往事"
    ],
    "environment_tags": ["硅晶草原", "双月当空", "等离子河流", "晶体森林"]
  },

  "extensions": {
    "dramatic_extension": {
      "conflict_matrix": {},
      "character_arcs": [],
      "want_need_pairs": []
    },
    "example_extension": {
      "beast_lore": "神兽档案",
      "memory_theme": "记忆即存在"
    }
  },

  "quality_report": {
    "evaluator": "DramaBench",
    "scores": {
      "structural_integrity": 90,
      "emotional_impact": 85,
      "character_consistency": 92
    },
    "passed": true
  }
}
```

**关键设计决策**：
- `dialogue` 字段必须在 `ScriptBlueprint` 中结构化，制作引擎只负责"嵌入"而非"生成"
- `character_system` 包含角色一致性锚点（核心特征 + 定妆照路径），供下游全链路使用
- `world_setting` 定义世界观级约束，制作引擎生成 Prompt 时必须遵守
- `extensions` 保留类型扩展空间，当前默认填充 `dramatic_extension` + `example_extension`

---

### 3.4 IC-3: ShotPrompt → 制作引擎输出 / 渲染引擎输入

```json
{
  "$schema": "example://schemas/shot-prompt/v1",
  "shot_id": "SC01-SH01",
  "scene_id": "SC01",
  "blueprint_ref": "引用 ScriptBlueprint.blueprint_id",

  "prompt": {
    "text": "电影级远景，超写实，示例世界星球硅晶草原...",
    "length": 976,
    "max_length": 980
  },

  "reference_images": [
    {
      "image_id": "ref-1",
      "type": "character_portrait",
      "character_id": "示例角色",
      "path": "characters/示例角色/front.jpg",
      "inject_text": "示例角色正面，银灰装甲，东亚面孔短发，年轻男性，超写实"
    }
  ],

  "rendering_params": {
    "model": "seedance-2.0",
    "endpoint": "ep-20260518004622-jp46s",
    "aspect_ratio": "16:9",
    "duration": 15,
    "negative_prompt": "禁止旁白，禁止金属光泽，禁止人物眼睛非自然色"
  },

  "timing": {
    "start": 15,
    "duration": 15,
    "end": 30
  },

  "dialogue": {
    "has_dialogue": true,
    "speaker": "示例角色",
    "text": "原来这就是示例世界...",
    "injected_in_prompt": true
  },

  "quality_gate": {
    "passed": true,
    "score": 95,
    "checks": {
      "prompt_length": true,
      "no_placeholder": true,
      "has_camera_timeline": true,
      "character_consistency": true
    }
  }
}
```

---

### 3.5 IC-4: RenderedClip → 渲染引擎输出 / 后期引擎输入

```json
{
  "$schema": "example://schemas/rendered-clip/v1",
  "clip_id": "uuid",
  "shot_ref": "引用 ShotPrompt.shot_id",
  "task_id": "seedance-task-id",

  "media": {
    "type": "video",
    "url": "https://...",
    "local_path": "/tmp/...",
    "format": "mp4",
    "resolution": "1080p",
    "duration": 15
  },

  "rendering_meta": {
    "model": "seedance-2.0",
    "render_time": 120,
    "cost_usd": 0.5
  },

  "quality_report": {
    "visual_quality": 85,
    "character_consistency_score": 90,
    "issues": []
  }
}
```

---

### 3.6 IC-5: FinalVideo → 后期引擎输出

```json
{
  "$schema": "example://schemas/final-video/v1",
  "video_id": "uuid",
  "blueprint_ref": "引用 ScriptBlueprint.blueprint_id",
  "clips": ["clip-1", "clip-2", "clip-3"],

  "assembly": {
    "cut_points": [{ "time": 15, "type": "hard_cut" }],
    "transitions": [{ "type": "fade", "duration": 0.5 }],
    "music": { "track_id": "epic-theme-1", "volume": 0.6 },
    "subtitles": [{ "text": "原来这就是示例世界...", "start": 2, "end": 5 }],
    "color_grade": { "lut": "example-warm", "intensity": 0.8 }
  },

  "packaging": {
    "title_card": "示例项目：神兽 EP01",
    "end_card": "关注我，探索更多示例世界异兽",
    "platform_optimized": ["tiktok", "bilibili"]
  }
}
```

---

## 四、共享内核接口（Shared Kernel API）

### 4.1 共享内核模块清单

| 模块 | 接口 | 当前状态 | 迁移策略 |
|------|------|----------|----------|
| **LLM Router** | `route(task_profile, engine_preference) → model` | ❌ 无 | 新建，统一管理所有 LLM 调用 |
| **Token Budget** | `allocate(engine_type, complexity) → quota` | ❌ 无 | 新建，防止单次耗尽 |
| **Process Manager** | `spawn(engine_type) → process_handle` | ❌ 无 | 新建，引擎隔离 |
| **Version Manager** | `snapshot(task_id, content) → version_id` | ⚠️ 部分（git） | 增强，支持创作节点回溯 |
| **Checkpoint Manager** | `save_checkpoint(task_id, state) → checkpoint_id` | ❌ 无 | 新建，长流程断点续传 |
| **Compliance Engine** | `scan(content, engine_type) → compliance_report` | ⚠️ 部分（quality-gate） | 增强，多维度安全扫描 |
| **Auto-Repair Loop** | `trigger_repair(task_id, anomaly) → result` | ❌ 无 | 新建，异常检测+自修复 |

### 4.2 共享内核接口定义（TypeScript 风格）

```typescript
// LLM Router
interface ILLMRouter {
  route(task: TaskProfile, preference?: EnginePreference): Promise<ModelInstance>;
  call(prompt: string, model: string, timeout?: number): Promise<LLMResponse>;
}

// Token Budget
interface ITokenBudget {
  allocate(engine: string, complexity: number): TokenQuota;
  consume(taskId: string, tokens: number): void;
  getRemaining(taskId: string): number;
}

// Version Manager
interface IVersionManager {
  snapshot(taskId: string, content: any, label?: string): string;
  rollback(taskId: string, versionId: string): any;
  diff(v1: string, v2: string): Delta;
}

// Compliance Engine
interface IComplianceEngine {
  scan(content: string, engineType: string): ComplianceReport;
  scanBatch(contents: string[], engineType: string): ComplianceReport[];
}

// 通用工坊
interface ISceneWorkshop {
  selectScene(sceneType: string, narrativeMode: string, context: SceneContext): SceneTemplate;
}

interface IVoiceWorkshop {
  generateVoice(profile: VoiceProfile, content: string, context: SceneContext): string;
}

interface IVisualWorkshop {
  generateVisualStrategy(scene: Scene, blueprint: ScriptBlueprint): VisualDirection;
}
```

---

## 五、剧本引擎 MVP 设计（Phase 2）

### 5.1 剧本引擎定位

**核心职责**：
1. 接收 `UserIntent`（用户意图）
2. 调用 LLM 生成结构化剧本
3. 输出 `ScriptBlueprint`（单一真相源）
4. 下游三层（制作/渲染/后期）只读剧本，不可修改

**与当前系统的区别**：
- 当前：剧本概念在 LLM Prompt 里，没有结构化输出
- 新架构：剧本是显式 JSON 对象，每个字段有 Schema 约束

### 5.2 剧本引擎模块划分

```
engines/script-engine/
├── core/
│   ├── intent-parser.js          # 意图解析（复用 Intent Router 能力）
│   ├── script-generator.js       # 剧本生成（LLM 调用）
│   ├── script-validator.js       # 剧本校验（Schema + 业务规则）
│   └── script-blueprint.js       # Blueprint 数据模型
├── templates/
│   ├── dramatic-template.json    # 戏剧性模板（三幕结构）
│   ├── educational-template.json # 知识性模板
│   ├── documentary-template.json # 纪实性模板
│   ├── lifelog-template.json     # 生活志模板
│   └── commercial-template.json  # 商业性模板
├── prompts/
│   ├── script-generation-prompt.md   # 剧本生成主 Prompt
│   └── intent-classification-prompt.md # 意图分类 Prompt
├── extensions/
│   ├── example-extension.js       # 示例世界 世界观扩展
│   └── dramatic-extension.js     # 戏剧性叙事扩展
└── tests/
    └── script-engine.test.js
```

### 5.3 剧本引擎核心流程

```
UserIntent → [Intent Parser] → [Script Generator] → [Script Validator] → ScriptBlueprint
                │                      │                      │
                ▼                      ▼                      ▼
          分类叙事模式              调用 LLM 生成            Schema 校验
          提取元数据                结构化 JSON 输出          业务规则校验
          识别混合模式              模板填充                  质量评分
```

### 5.4 与现有系统的融合点

```
现有系统 v6.5.12:
  run-taotie-preproduction.js
    → 调用 example-world-pipeline.js
      → 生成剧本（硬编码在 LLM Prompt 中）
      → 生成镜头 Prompt

融合后 v7.0:
  run-taotie-preproduction.js
    → 调用 script-engine/script-generator.js    [NEW]
      → 输出 ScriptBlueprint（结构化 JSON）
    → 调用 production-engine/prompt-builder.js  [现有 Pipeline 改造]
      → 读取 ScriptBlueprint
      → 输出 ShotPrompt（镜头提示词）
    → 调用 rendering-engine/seedance-adapter.js [NEW]
      → 提交 Seedance API
    → 调用 post-production-engine/basic-cut.js  [NEW]
      → 基础剪辑 + 字幕
```

**关键融合策略**：
- `ScriptBlueprint` 的 `scenes` 数组直接对应现有系统的 `SC00`~`SC04` 镜头列表
- `character_system` 中的 `visual_anchor` 直接替代现有系统的 `characters/` 定妆照查找逻辑
- `voice_system` 中的 `dialogue` 直接替代现有系统的台词注入逻辑
- 现有 `example-world-pipeline.js` 中的"剧本生成"部分逐步迁移到 `script-engine/`
- 剩余"镜头拆解 + Prompt 工程"部分迁移到 `production-engine/`

---

## 六、实施路线图（v7.0）

### Phase 1: 接口契约（Week 1）
- [ ] 定义 IC-1 ~ IC-5 的 JSON Schema（本文档）
- [ ] 定义共享内核接口（TypeScript 风格）
- [ ] 创建 `engines/` 目录结构
- [ ] **质量门禁**：Schema 通过校验工具验证

### Phase 2: 剧本引擎 MVP（Week 2-3）
- [ ] 实现 `script-engine/intent-parser.js`（意图解析）
- [ ] 实现 `script-engine/script-generator.js`（LLM 剧本生成）
- [ ] 实现 `script-engine/script-validator.js`（Schema + 业务校验）
- [ ] 实现 `templates/dramatic-template.json`（戏剧性模板）
- [ ] 接入 `example-extension.js`（示例世界 世界观扩展）
- [ ] **适配层**：将 `ScriptBlueprint` 转换为现有 Pipeline 可消费的格式
- [ ] **质量门禁**：用示例项目 首集 完整跑通预生产，验证剧本质量

### Phase 3: 制作引擎瘦身（Week 4-5）
- [ ] 将 `example-world-pipeline.js` 拆解为 `production-engine/` 模块
- [ ] 保留：镜头拆解、Prompt 工程、定妆照绑定、台词注入
- [ ] 剥离：剧本生成（迁移到 `script-engine/`）
- [ ] **质量门禁**：拆解后预生产质量与 v6.5.12 差异 ≤ 5%

### Phase 4: 渲染引擎抽象（Week 6-7）
- [ ] 新建 `rendering-engine/` 目录
- [ ] 实现 `seedance-adapter.js`（封装 Seedance API）
- [ ] 定义通用渲染接口 `IRenderingEngine`
- [ ] **质量门禁**：渲染输出与 v6.5.12 一致

### Phase 5: 后期引擎基础（Week 8-9）
- [ ] 新建 `post-production-engine/` 目录
- [ ] 实现基础剪辑（片段拼接 + 硬切/淡入淡出）
- [ ] 实现字幕生成（基于 `ScriptBlueprint.dialogue`）
- [ ] 实现标题卡/结尾卡
- [ ] **质量门禁**：输出可播放的完整视频

### Phase 6: 共享内核落地（Week 10-12）
- [ ] 实现 `shared-kernel/llm-router.js`
- [ ] 实现 `shared-kernel/token-budget.js`
- [ ] 实现 `shared-kernel/version-manager.js`
- [ ] 实现 `shared-kernel/compliance-engine.js`
- [ ] 将现有 `quality-gate` 整合进 `compliance-engine`
- [ ] **质量门禁**：全链路 Token 消耗降低 20%+

### v7.0 Release（Week 12-13）
- [ ] 全链路端到端测试（示例项目 首集 完整流程）
- [ ] 性能优化（延迟、Token、并发）
- [ ] 文档完善 + 代码打包
- [ ] **版本号**：v7.0.0

---

## 七、风险与缓解

| 风险 | 影响 | 概率 | 缓解策略 |
|------|------|------|----------|
| **剧本引擎质量不达标** | 高 | 中 | 与现有 LLM Prompt 并行跑 3 轮对比，质量差异 > 5% 则回退 |
| **Pipeline 拆解引入 Bug** | 高 | 中 | 每拆解一个模块，跑完整预生产验证，不通过不合并 |
| **渲染抽象层增加延迟** | 中 | 中 | 保留直接调用路径作为 fallback，抽象层只做适配 |
| **后期引擎能力太弱** | 低 | 高 | Phase 5 从基础起步，不强求"AI 剪辑"，先能拼接+字幕即可 |
| **架构文档与实现偏差** | 高 | 高 | 每个 Phase 输出文档 + 代码 + 测试，三者同步更新 |

---

## 八、当前系统迁移 checklist

### 8.1 现有文件迁移映射

| 现有文件 | 迁移目标 | 说明 |
|----------|----------|------|
| `example-world-pipeline.js`（317KB）| `production-engine/` | 拆解为多个模块 |
| `opening-system-v3.js` | `production-engine/opening-builder.js` | 片头系统 |
| `orient-primordial-core-v24.js` | `script-engine/templates/dramatic-template.json` | 剧本生成模板 |
| `beast-prompt-injector.js` | `production-engine/beast-prompt-builder.js` | 异兽 Prompt 注入 |
| `character-prompt-builder.js` | `production-engine/character-prompt-builder.js` | 角色 Prompt 构建 |
| `prompt-standard-v2.js` | `production-engine/prompt-standard.js` | Prompt 标准库 |
| `compliance-checker.js` | `shared-kernel/compliance-engine.js` | 合规检查 |
| `llm-reasoning-engine.js` | `shared-kernel/llm-router.js` | LLM 调用路由 |
| `production-bible.js` | `script-engine/extensions/example-extension.js` | 生产圣经/世界观 |

### 8.2 新创建目录结构

```
/root/.openclaw/workspace/
├── engines/
│   ├── script-engine/          # 剧本引擎（新增）
│   ├── production-engine/      # 制作引擎（从现有系统迁移）
│   ├── rendering-engine/       # 渲染引擎（新增）
│   └── post-production-engine/ # 后期引擎（新增）
├── shared-kernel/              # 共享内核（新增）
│   ├── llm-router.js
│   ├── token-budget.js
│   ├── version-manager.js
│   ├── checkpoint-manager.js
│   ├── compliance-engine.js
│   ├── auto-repair-loop.js
│   └── workshops/
│       ├── scene-workshop.js
│       ├── voice-workshop.js
│       └── visual-workshop.js
├── systems/                    # 现有系统（保留，逐步迁移）
├── characters/                 # 定妆照（保留）
├── config/                     # 配置（保留）
└── stories/                    # 故事脚本（保留）
```

---

## 九、附录

### 9.1 与 ScriptCraft Engine 融合架构的对应关系

| ScriptCraft 设计 | 示例世界 实现 | 状态 |
|------------------|-------------|------|
| 统一入口层（Intent Router） | `script-engine/intent-parser.js` | Phase 2 |
| 共享内核层（Shared Kernel） | `shared-kernel/` | Phase 6 |
| 类型引擎层（Type Engine Layer） | `engines/script-engine/`（戏剧引擎） | Phase 2 |
| 通用工坊（Scene/Voice/Visual） | `shared-kernel/workshops/` | Phase 6 |
| 混合模式（Hybrid Mode） | `script-engine/intent-parser.js` hybrid 分支 | Phase 2+ |
| 统一质量评估（UQAF） | `shared-kernel/compliance-engine.js` | Phase 6 |
| 统一数据模型（UDM） | `ScriptBlueprint` / `ShotPrompt` | Phase 1 |

### 9.2 版本号规则

- v7.0.0 = 架构升级完成，四层全部可用
- v7.0.x = 补丁修复
- v7.1.0 = 场景深化（行业模板、A/B测试）
- v7.2.0 = 生态开放（自定义引擎、混合模式编辑器）

---

> **下一步行动**：队长确认本接口契约后，立即开始 Phase 2（剧本引擎 MVP）代码实现。
