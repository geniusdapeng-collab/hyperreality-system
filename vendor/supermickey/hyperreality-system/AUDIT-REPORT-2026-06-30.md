# SuperMickey 深度代码审计报告

**审计日期**: 2026-06-30
**审计范围**: hyperreality-system 核心链路
**审计目标**: 字段完整性、链路稳定性、设计对齐

---

## 一、执行摘要

| 类别 | 发现问题 | 严重程度 | 已修复 |
|------|---------|---------|--------|
| 字段流完整性 | 3 处字段丢失风险 | 🔴 高 | 0 |
| 链路稳定性 | 2 处潜在崩溃点 | 🔴 高 | 0 |
| 设计对齐 | 4 处命名不一致 | 🟡 中 | 0 |
| 降级兜底 | 2 处兜底不完整 | 🟡 中 | 0 |
| **总计** | **11 项问题** | - | **5 (HAVS移植)** |

---

## 二、字段流完整性审计

### 🔴 问题 1: Phase 1 → Phase 3 字段丢失

**位置**: `phase-1-scene-design.js` → `prompt-fusion-agent.js`

**现象**:
```javascript
// Phase 1 合并的字段
newShots = this.mergeShots(shots, sdResult.shots, [
  'scene', 'mood', 'action', 'emotional_target'  // ❌ emotional_target 未使用
]);
```

`emotional_target` 在 PromptFusionAgent 中**从未被读取**:
```javascript
// PromptFusionAgent._extractFieldsFromShot()
if (shot.emotionalTarget) {  // 读取的是 emotionalTarget (驼峰)
  result.mood = ...;
}
// 没有读取 emotional_target (snake_case)
```

**影响**: 如果 SceneDesignAgent 输出 `emotional_target`，该字段在后续流程中丢失

**修复建议**:
```javascript
// 在 _extractFieldsFromShot 中添加
if (shot.emotional_target || shot.emotionalTarget) {
  result.mood = ...;
}
```

---

### 🔴 问题 2: Phase 2 字段命名冲突

**位置**: `phase-2-visual-audio.js`

**现象**:
```javascript
// Phase 2 合并的字段（混合命名风格）
newShots = this.mergeShots(newShots, vlResult.shots, [
  'camera', 'cameraString', 'cameraMovement',  // 3 个运镜字段！
  'lighting', 'lightingString',                // 2 个灯光字段
  'timeline',
  'visual_elements', 'color_temperature', 'camera_movement'  // 又出现 camera_movement
]);
```

PromptFusionAgent 期望的字段:
```javascript
// _extractFieldsFromShot() 中读取的字段
if (shot.cameraString) result.camera_movement = shot.cameraString;  // 读取 cameraString
if (shot.lightingString) result.lighting = shot.lightingString;      // 读取 lightingString
// 没有读取 camera, cameraMovement, visual_elements, color_temperature
```

**影响**: `camera`, `cameraMovement`, `visual_elements`, `color_temperature` 等字段被合并但从未使用

**修复建议**: 统一字段命名，或扩展 `_extractFieldsFromShot` 支持多名字段:
```javascript
// 多名字段映射
const fieldMappings = {
  camera_movement: ['camera', 'cameraString', 'cameraMovement'],
  lighting: ['lighting', 'lightingString'],
  color_palette: ['color_temperature', 'colorPalette']
};
```

---

### 🟡 问题 3: dialogue 字段格式不一致

**位置**: `prompt-fusion-agent.js`

**现象**: PromptFusionAgent 同时处理 3 种台词格式:
```javascript
// 格式 1: dialogueBlocks (Seedance 2.0)
if (shot.dialogueBlocks && Array.isArray(shot.dialogueBlocks)) {
  const rendered = this._renderDialogueBlocks(shot.dialogueBlocks, shot.duration);
}

// 格式 2: dialogueText
const pureDialogue = shot.dialogueText || this._extractPureDialogue(shot.dialogue);

// 格式 3: dialogue (PIPE 分隔)
_extractPureDialogue(dialogue) {
  const parts = dialogue.split(/[|;]/);
  if (parts.length >= 5) return parts[3].trim();  // SPEAKER|TYPE|EMOTION|TEXT|LIP_SYNC
}
```

**影响**: 不同阶段的台词格式不同，可能导致台词丢失或渲染错误

**建议**: 在 Adapter 层统一台词格式，或明确各阶段期望的格式

---

## 三、链路稳定性审计

### 🔴 问题 4: checkpoint 保存未 await

**位置**: `production-engine.js` produce()

**现象**:
```javascript
// ❌ 未 await！
this._saveCheckpoint('phase1', newShots, {...});  // 异步但未等待

// 后续立即继续 Phase 2，如果 checkpoint 保存失败...
```

**影响**: 
- checkpoint 可能未完整写入就进入下一阶段
- 断点续跑时可能读取到损坏的 checkpoint

**修复建议**:
```javascript
// 改为 await
await this._saveCheckpoint('phase1', newShots, {...});
```

---

### 🔴 问题 5: Phase 3.5 失败未处理

**位置**: `production-engine.js` produce()

**现象**:
```javascript
const phase35Result = await this.phase35.execute({...});
if (phase35Result.success) {
  currentShots = phase35Result.shots;
}
// ❌ 失败时没有降级处理！没有 else 分支
```

**影响**: Phase 3.5 失败时，`currentShots` 保持原值，可能包含未修复的字段问题

**修复建议**:
```javascript
if (phase35Result.success) {
  currentShots = phase35Result.shots;
} else {
  this.log('PHASE-3.5', '⚠️ 字段质量检查失败，使用原始 shots 继续');
  // 至少运行一次 field-guard 兜底
  const fg = new FieldGuard({ strict: false });
  const check = fg.check(currentShots, 'Phase3.5-fallback');
  if (!check.passed) {
    this.log('PHASE-3.5', `⚠️ ${check.report.errors.length} 个字段问题未修复`);
  }
}
```

---

### 🟡 问题 6: 内存检查频率不足

**位置**: `production-engine.js`

**现象**: `_checkMemory()` 仅在 Phase 结束后调用，Phase 3 串行处理期间**不检查内存**

**影响**: 5-8 分钟的 Phase 3 处理期间，内存可能持续增长到 OOM

**修复建议**: 在 PromptFusionAgent.process() 的循环中添加内存检查:
```javascript
for (let i = 0; i < shots.length; i++) {
  if (i % 3 === 0) this._checkMemory(`Phase3-shot-${i}`);  // 每3个镜头检查一次
  // ...
}
```

---

## 四、设计对齐审计

### 🟡 问题 7: 字段命名风格不统一

| 字段 | 当前命名 | 建议统一为 |
|------|---------|-----------|
| 运镜 | cameraString, cameraMovement, camera_movement | camera_movement |
| 灯光 | lightingString, lighting | lighting |
| 音频 | backgroundSoundString, audio | audio |
| 情绪 | emotional_target, emotionalTarget, mood | mood |
| 角色引用 | characterRef, portraits | portraits |

**影响**: 代码难以维护，容易在字段传递中丢失数据

**修复建议**: 建立字段命名规范文档，使用统一的下划线命名法

---

### 🟡 问题 8: mergeShots 白名单 vs fields 对象

**位置**: `production-engine.js` + `prompt-fusion-agent.js`

**现象**:
```javascript
// Phase 3 mergeShots 白名单（显式列出25个字段）
const newShots = this.mergeShots(shots, pfResult.shots, [
  'prompt', 'enhanced_prompt', 'negative_prompt', 'fields', 'fusionText', ...
]);

// 但 PromptFusionAgent 返回的 shot 包含所有字段展开到顶层
return {
  ...shot,
  ...expandedFields,  // 所有25个字段
  fields,
  prompt: fullPrompt,
  // ...
};
```

**问题**: mergeShots 白名单可能遗漏 PromptFusionAgent 生成的某些字段

**建议**: 改用字段对象合并而非白名单:
```javascript
// 合并所有非空字段
const newShots = this.mergeShots(shots, pfResult.shots, null);  // null = 合并所有
```

---

## 五、降级兜底审计

### 🟡 问题 9: Phase 2 部分失败无降级

**位置**: `phase-2-visual-audio.js`

**现象**:
```javascript
catch (e) {
  this.log('PHASE-2-FAIL', `❌ ${e.message}, Phase2 失败但继续`);
  // ❌ 没有降级处理，直接返回原始 shots
  return { success: false, shots, result, ... };
}
```

**影响**: VisualLanguage 失败后，shots 没有 camera/lighting 字段，PromptFusion 只能依赖规则兜底

**修复建议**: 至少注入基础运镜/灯光:
```javascript
catch (e) {
  // 注入基础字段保底
  shots.forEach(shot => {
    if (!shot.cameraString) shot.cameraString = '固定机位，中景构图';
    if (!shot.lightingString) shot.lightingString = '自然光，5600K，三点布光';
  });
  return { success: false, shots, result, ... };
}
```

---

### 🟡 问题 10: PromptFusion 补全逻辑缺陷

**位置**: `prompt-fusion-agent.js`

**现象**:
```javascript
// _fillMissingFieldsWithRetry 中：
const filled = completeness.fields;
const stillEmpty = REQUIRED_FIELDS.filter(f => !filled[f] || String(filled[f]).trim() === '');
if (stillEmpty.length === 0) {
  return this._buildShotResult(shot, filled);  // ✅ 全满返回
}
// ❌ 如果仍有空缺，没有再次尝试补齐，直接继续循环（但循环次数已耗尽）
```

**影响**: 重试机制不够智能，可能导致不必要的降级

**修复建议**: 在每次重试后更新 `fields`，让下次重试基于最新状态:
```javascript
for (let attempt = 1; attempt <= maxRetries; attempt++) {
  const completeness = await this._ensureFieldCompleteness(shot, fields, ratio, characters);
  Object.assign(fields, completeness.fields);  // 更新 fields 供下次使用
  // ...
}
```

---

## 六、其他发现

### ✅ 优点

1. **断点续跑机制完善**: checkpoint + 指纹校验，防止脏恢复
2. **预算系统健全**: `_globalDeadline` + `_canAfford()` 贯穿全链路
3. **规则兜底多层**: FieldGuard → RuleFallback → _fallbackSingleShot
4. **字段标准化**: 25维标准字段体系，有完整的默认值

### ⚠️ 待观察

1. **dialogueBlocks 新格式**: Seedance 2.0 内联格式刚引入，稳定性待验证
2. **fastMode 效果**: 刚移植的 HAVS 修复，需要实际测试验证
3. **healthMonitor 保活**: 自动保活定时器可能增加 CPU 开销

---

## 七、修复优先级建议

| 优先级 | 问题 | 文件 | 工作量 | 影响 |
|--------|------|------|--------|------|
| P0 | 问题4: checkpoint 未 await | production-engine.js | 小 | 断点续跑不可靠 |
| P0 | 问题2: 字段命名冲突 | phase-2-visual-audio.js | 中 | 字段丢失 |
| P1 | 问题5: Phase3.5 失败未处理 | production-engine.js | 小 | 质量问题漏过 |
| P1 | 问题1: emotional_target 丢失 | prompt-fusion-agent.js | 小 | 情绪信息丢失 |
| P1 | 问题9: Phase2 降级不完整 | phase-2-visual-audio.js | 中 | 运镜/灯光缺失 |
| P2 | 问题6: Phase3 内存检查 | prompt-fusion-agent.js | 小 | OOM 风险 |
| P2 | 问题7: 字段命名规范 | 多个文件 | 大 | 维护性 |
| P2 | 问题8: mergeShots 白名单 | production-engine.js | 中 | 字段遗漏 |
| P2 | 问题10: 补全逻辑优化 | prompt-fusion-agent.js | 中 | 降级率 |

---

## 八、已完成的 HAVS 移植修复

| 修复 | 状态 | 提交 |
|------|------|------|
| P1-5: process-guard 致命错误检测 | ✅ | e9b8690 |
| P0-2: EventBus 内存泄漏 | ✅ | e9b8690 |
| P2-10: field-guard Final-Export | ✅ | e9b8690 |
| P0-4: Phase3 fastMode | ✅ | e9b8690 |
| P0-1: HealthMonitor 自动保活 | ✅ | e9b8690 |

---

**审计结论**: SuperMickey 整体架构健壮，但存在 11 项需要修复的问题。建议按优先级分批实施，先修复 P0 级问题确保链路稳定，再处理 P1/P2 级问题提升质量。
