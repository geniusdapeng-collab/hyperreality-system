# Prompt 模板（已弃用旧规范，本文档为指引页）

> ⚠️ **弃用警告**：本文档旧版内容（8 步结构、990 字符上限、300-900 字符区间）已失效，
> 与系统现行规范严重脱节。任何 Agent/开发者**禁止**以本文旧内容为执行依据。
> 保留本文件仅为防止外部链接 404，正文已替换为权威指引。

---

## 渲染 Prompt 规范的唯一权威来源

渲染 Prompt 的字段体系、字段顺序、片头扩展字段、长度标准，一律以以下**引擎代码**为准：

| 规范项 | 权威文件 | 说明 |
|--------|----------|------|
| 内容镜头 25 字段组装 | `hyperreality-system/engines/production-engine/agents/prompt-fusion-agent.js` | `_assembleStandardPrompt`：01.【语言约束】→ 25.【角色一致性】 |
| 片头镜头 30 字段 | 同上（`isOpening` 分支） | 25 标准字段 + 5 个片头专属字段：【主标题内容】【副标题内容】【标题动画设计】【标题字体设计】【开场音频设计】 |
| 字段别名与分级校验 | `hyperreality-system/engines/field-standardizer.js` | P0 致命级 12 字段 / P1 核心级 7 字段，导出前 25 字段非空硬检查 |
| 长度标准 | `hyperreality-system/config/prompt-length.js` | TARGET 2470-3000，HARD_MAX 3000，唯一权威入口 |
| 审核报告格式 | `hyperreality-system/index.js`（提示词审核报告生成器） | 镜头总览五列核验 + 序号化完整提示词 + 7 条审核须知 |

## 长度标准（现行）

- **目标区间**：2470-3000 字符
- **硬上限**：3000 字符
- **唯一入口**：`PromptLengthConfig`（`hyperreality-system/config/prompt-length.js`）
- 任何代码/文档中的其他字面数字（如 990、1400-1500）均为历史遗留，一律无效

## 片头判定

- 片头镜头标识：`shot.sceneType === 'opening'` 或 `shotId === 'SC00' / 'S00'`
- 片头镜头必须 30 字段齐全；内容镜头必须 25 字段齐全
- 审核报告字段数显示为 ✅ N/30 或 ✅ N/25

---

*若本文与引擎代码存在任何出入，以引擎代码为准。发现出入请在 Issue 中报告。*
