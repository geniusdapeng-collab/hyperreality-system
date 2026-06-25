# 常见问题

## Q1: 为什么提示词审核时显示某些字段缺失？

**A**: 系统使用 25 字段标准化镜头语言，部分字段（如 `title_content` 等 5 个片头字段）仅在片头镜头（SC00/S00）中出现。内容镜头（SC01+）显示 25/25 为完整，片头镜头显示 30/30 为完整。

若内容镜头出现字段缺失，系统会自动触发 FieldGuard 修复机制，补充默认值并标记 degraded。您可以选择接受或手动修改。

## Q2: 如何接入自定义的视频渲染服务？

**A**: 继承 `RenderingEngine` 基类，实现以下三个方法：

```javascript
class CustomRenderingEngine extends RenderingEngine {
  async submitTask(prompt, options) {
    // 提交渲染任务，返回 taskId
  }
  
  async queryTaskStatus(taskId) {
    // 查询任务状态，返回 { status: 'pending'|'processing'|'completed'|'failed', resultUrl? }
  }
  
  async downloadResult(taskId, outputPath) {
    // 下载渲染结果到本地
  }
}
```

然后在初始化时传入：

```javascript
const system = new HyperrealitySystem({
  renderingEngine: new CustomRenderingEngine({ apiKey: 'your-key' })
});
```

## Q3: 支持哪些 LLM 模型？

**A**: 系统兼容 OpenAI API 格式的 LLM 服务。已验证支持：

- **Kimi** (kimi-k2p6)
- **火山引擎 Ark** (Volcengine Ark)
- **OpenAI** (GPT-4/GPT-4o)
- **任何 OpenAI 兼容接口**（如 Ollama、LocalAI 等）

配置方式：在 `.env` 中设置 `VOLCENGINE_ARK_API_KEY` 或通过 `apiKey` 参数传入。

## Q4: 多集系列如何保持角色一致性？

**A**: 系统提供三层角色一致性保障：

1. **定妆照引用**：为角色上传 reference images，所有镜头自动引用 `image://characters/{role}/portraits/`
2. **角色一致性约束**：每个镜头的提示词中自动注入 `【角色一致性】` 字段，要求面部特征、体型、造型每帧统一
3. **跨集校验**：`CrossEpisodeValidator` 自动检查跨集角色是否一致，发现偏差时报警

## Q5: 预生产失败后如何恢复？

**A**: 系统内置 Checkpoint 机制，每完成一个阶段自动保存状态：

- `checkpoint-phase1.json` — 剧本完成
- `checkpoint-phase2.json` — 制作完成
- `checkpoint-phase3.json` — 渲染完成
- `checkpoint-phase3.5.json` — 后期完成

任务中断后，重新运行会自动加载最新的可用 Checkpoint 继续执行，无需从头开始。

如需手动恢复，可查看 `output/checkpoint-*.json` 文件（如果存在）。

## Q6: 为什么需要人工确认提示词？

**A**: 当前 Seedance 2.0 的渲染成本较高（每镜头约 ¥0.5-2），且渲染失败后修改提示词重新渲染的成本更高。因此系统在渲染前设置了 **提示词审核** 环节，由人工确认质量后再提交渲染，避免浪费。

未来版本将支持自动审核（降低阈值）或批量审核模式。

## Q7: 如何调整创意指数？

**A**: 在创作意图中指定 `创意指数0.X`（如 `创意指数0.8`），范围 0.0-1.0：

- **0.0-0.3**: 保守写实，适合纪录片、新闻、科普
- **0.4-0.6**: 标准商业，适合广告、宣传片
- **0.7-1.0**: 高创意，适合艺术片、概念视频、实验性内容

系统会根据创意指数自动调整提示词中的创意自由度、运镜复杂度、色彩饱和度等参数。

## Q8: 可以商用吗？

**A**: 可以。本项目采用 **Apache License 2.0**，允许：

- ✅ 商业使用
- ✅ 修改和分发
- ✅ 专利授权保护
- ✅ 私有使用

唯一要求：保留版权声明和许可证文本。

## Q9: 运行报 "VOLCENGINE_ARK_API_KEY 未设置"

**A**: 请按以下步骤配置：

1. 复制环境变量模板：`cp .env.example .env`
2. 编辑 `.env`，填入你的火山引擎 API Key：`VOLCENGINE_ARK_API_KEY=your_actual_key`
3. 如果使用其他 LLM 服务，修改对应配置项

获取 API Key：[火山引擎方舟平台](https://console.volcengine.com/ark/)

## Q10: 如何为项目贡献新功能？

**A**: 请参考 [CONTRIBUTING.md](CONTRIBUTING.md)。简而言之：

1. Fork 仓库 → 创建 feature 分支
2. 编写代码 + 文档
3. 提交 PR，描述清楚变更
4. 等待 Code Review

特别欢迎：新渲染后端接入、新字段类型扩展、质量规则优化、性能优化等贡献。

