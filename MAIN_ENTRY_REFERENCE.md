# 系统主入口参考指南
# System Main Entry Point Reference
# 版本: v2.1.4-fix7 | 日期: 2026-06-21
# ⚠️ 严禁调用快捷脚本路径（已归档至 _deprecated_scripts/）

---

## 超现实系统 (Hyperreality System)

**正确入口**: `hyperreality-system/index.js` → `HyperrealitySystem`

**正确调用方式**:
```javascript
const { HyperrealitySystem } = require('./hyperreality-system/index');

const system = new HyperrealitySystem({
  productionEngine: {
    agentConfig: { enableLLMAgents: true, ... },
    charactersDir: path.join(__dirname, 'characters')
  }
});

const result = await system.create(intent, metadata, {
  // 严禁设置 skipRequirementList: true
  // 严禁设置 skipPromptReview: true（调试用例外）
  // 所有环节必须人工确认
});
```

**关键环节**:
1. Layer 0: 需求清单生成 + 人工确认
2. Layer 1: 剧本引擎 (ScriptEngine)
3. Adapter: 适配层转换
4. Layer 2: 制作引擎 (ProductionEngine) - 含 LLM Agents
5. Layer 3: 提示词审核 (PromptReview)
6. Layer 4: 渲染 (Rendering)
7. Layer 5: 后期制作 (PostProduction)

---

## 卓越系统 (Zhuoyue System)

**正确入口**: `zhuoyue-system/core/example-master-pipeline.js` → `ExampleMasterPipeline`

**正确调用方式**:
```javascript
const { ExampleMasterPipeline } = require('./zhuoyue-system/core/example-master-pipeline');

const pipeline = new ExampleMasterPipeline({
  // 配置
});

const result = await pipeline.executeEpisode(episodeConfig, {
  // 严禁设置 skipRequirementList: true
  // 所有环节必须人工确认
});
```

---

## 超短裙系统 (Short Video System)

**正确入口**: `short-video-system/index.js` → `ShortVideoSystem`

**正确调用方式**:
```javascript
const { ShortVideoSystem } = require('./short-video-system/index');

const system = new ShortVideoSystem({
  // 配置
});

const result = await system.create(intent, metadata, {
  // 严禁设置 skipRequirementList: true
  // 所有环节必须人工确认
});
```

---

## 快捷脚本识别与处理

**已归档脚本位置**:
- `hyperreality-system/_deprecated_scripts/` — 超现实系统旧快捷脚本
- `zhuoyue-system/_deprecated_scripts/` — 卓越系统旧快捷脚本（如有）
- `short-video-system/_deprecated_scripts/` — 超短裙系统旧快捷脚本（如有）

**识别特征**（发现即报错）:
- 文件名含 `fast`、`quick`、`temp`、`debug`、`test`
- 继承 `FastXxxSystem` 类
- 覆盖 `_waitForExternalConfirmation` 返回自动 approved
- 设置 `skipRequirementList=true`

**处理流程**:
1. 发现快捷脚本 → 立即停止执行
2. 报告队长："发现快捷脚本，已停止，改用系统主入口"
3. 使用系统主入口重新执行

---

## 预生产完整链路（5步）

1. **清理旧数据** → 清理 output/、checkpoint、临时文件
2. **需求清单确认** → 生成清单 → 等待队长确认 → 锁定需求
3. **定妆照检查** → 检查/生成定妆照 → 队长确认OK
4. **跑完整主链路** → 调用系统主入口，所有环节跑完
5. **输出MD附件** → 完整提示词放入MD → 附件发给队长 → 等待确认

**详见**: `SOUL.md` → "v2.1.4-fix7 预生产完整链路规范"

---

## 提交记录

- 2026-06-21: 归档所有快捷脚本至 `_deprecated_scripts/`
- 2026-06-21: 更新 SOUL.md 增加完整链路规范
- 2026-06-21: 更新 AGENTS.md 增加完整链路规范
- 2026-06-21: 创建本参考指南

**版本**: v2.1.4-fix7
**状态**: 已焊死，不可违反
