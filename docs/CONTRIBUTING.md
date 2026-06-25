# 贡献规范

感谢您对 Hyperreal AI Video System 的兴趣！以下是贡献指南。

## 如何贡献

### 1. 报告 Bug

- 使用 [Issue 模板](https://github.com/yourusername/hyperreality-system/issues/new/choose)
- 提供复现步骤、环境信息（Node.js 版本、操作系统）
- 如可能，提供最小复现代码

### 2. 提交功能建议

- 先在 Discussions 中发起话题，讨论可行性
- 获得维护者认可后，再创建 Issue 追踪

### 3. 提交代码（PR）

#### 分支命名规范

| 类型 | 前缀 | 示例 |
|------|------|------|
| 功能 | `feat/` | `feat/prompt-fusion-optimization` |
| 修复 | `fix/` | `fix/field-guard-memory-leak` |
| 文档 | `docs/` | `docs/readme-typos` |
| 重构 | `refactor/` | `refactor/engine-decoupling` |
| 性能 | `perf/` | `perf/parallel-rendering` |

#### PR 流程

1. Fork 仓库并创建 feature 分支
2. 编写代码 + 测试（如有）
3. 确保 `npm test` 通过（如有测试）
4. 更新相关文档（README、CHANGELOG、ARCHITECTURE）
5. 提交 PR，描述清楚变更内容和动机
6. 等待 Code Review，根据反馈修改

#### Commit Message 规范

```
<type>(<scope>): <subject>

<body>

<footer>
```

- `type`: feat, fix, docs, refactor, perf, test, chore
- `scope`: 模块名（如 script-engine, production-engine, field-guard）
- `subject`: 简短描述（50字符内）

示例：
```
feat(production-engine): 添加 Checkpoint 断点续传机制

- 支持 phase1/phase2/phase3 自动保存
- 支持从最近 checkpoint 恢复
- 添加安全序列化处理循环引用

Closes #123
```

## 代码规范

- 使用 JavaScript Standard Style
- 核心模块需补充 JSDoc 注释
- 所有 Agent 必须继承 `BaseAgent`
- 新字段需同步更新 `FIELD_ALIAS_MAP` 和 `REQUIRED_FIELDS`

## 模块开发指南

### 新增一个 Agent

```javascript
const { BaseAgent } = require('./agents/base-agent');

class MyNewAgent extends BaseAgent {
  constructor(options) {
    super({ ...options, agentName: 'MyNewAgent' });
  }

  async process(input) {
    // 1. 构建 prompt
    const prompt = this.buildPrompt(input);
    
    // 2. 调用 LLM
    const result = await this._callLLM(prompt);
    
    // 3. 解析结果
    return this.parseResult(result);
  }
}
```

### 新增渲染后端

继承 `RenderingEngine` 基类，实现 `submitTask`、`queryTaskStatus`、`downloadResult` 方法。

## 社区准则

- 尊重他人，保持友善和建设性
- 讨论技术，不人身攻击
- 遵循 Apache-2.0 许可证要求

## 联系方式

- 技术讨论：GitHub Discussions
- 紧急问题：63904380@qq.com

