# vendor/dsh · DeepSeek Harness fork 锁定信息（D12 / B0）

| 项 | 值 |
|---|---|
| 包 | `@deepseek-ai/dsh`（CLI 聚合包；运行时依赖 `@deepseek-ai/dsh-*` / `cordis-plugin-*` 全家桶） |
| 锁定版本 | `0.1.1-rc.1`（npm 发布时间 2026-08-21T06:49:18Z；rc.6→rc.8→rc.1 两次升级） |
| 来源 | `https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.1.1-rc.1.tgz` |
| integrity（入库时实测） | `sha512-HVauMT0F7MWUctkxzBcu5PMFc8j0lm0kX+4IbcUsA7Oh+/xv7xhigEDP0SaSOM/kR48U/BldHbZru116DcZz0w==`（与 registry 元数据逐字符一致 ✅） |
| License | MIT |
| 上游仓库 | `github.com/deepseek-ai/deepseek-harness`（`apps/cli` 目录） |
| 入库日期 | 2026-08-16（rc.6）；2026-08-20 升级 rc.8；2026-08-21 升级 0.1.1-rc.1 |
| 入库方式 | npm tarball 解压至本目录（`--strip-components=1`），未做任何源码修改 |

## 纪律

- 本目录**只读**：任何修改必须先复制出去再改，保持与上游 0.1.1-rc.1 字节一致，可审计。
- 运行时依赖解析仍走 pnpm（`pnpm add @deepseek-ai/dsh@0.1.1-rc.1` 于使用方包）；本目录是**审计基线 + 文档事实源**，升级前对照 diff。
- **升级触发条件（2026-08-20 项目所有者新决策，取代原「稳定 1.x 才升级」旧口径）**：官方仓库任何新版本（**包括 rc/beta/alpha 预发布**）即触发升级，不得等待稳定版、不得以任何理由跳过；升级前跑契约测试/门禁全绿。
- 0.1.1-rc.1 变更面（rc.8→rc.1 实测 diff）：CLI 聚合包 `lib/*.js` 与 config/presets 字节一致，README 仅链接修正（.md→.zh.md 锚点）；**变更集中在全家桶子包统一 bump 0.1.1-rc.1**（语义化小版本线，latest/next 双 dist-tag 均指向 rc.1）
- rc.8 变更面（rc.6→rc.8 实测 diff）：CLI 聚合包 `lib/*.js` 字节一致，仅 agent-presets 配置与 package.json 依赖 bump；**rc.8 新能力在全家桶子包**：Codex / Claude Code 作为按需安装的 subagent Profile Bundle（`@deepseek-ai/dsh-subagent-claude-code` / `@deepseek-ai/dsh-subagent-codex`）、模型适配器原生图片请求、/goal /plan 图文混合、@ 引用文件与历史 Session、SQLite 后端新存储格式（**不向下兼容**，升级前备份数据目录）。
- 已知原生依赖坑（B0 实测）：`node-pty` 需 pnpm 侧批准构建脚本（`pnpm.onlyBuiltDependencies: ["node-pty"]` + `pnpm rebuild node-pty`），否则 `dsh web` 启动即报 `pty.node` 缺失。已在 `.dsh profile` 与本仓库根 `package.json` 双处声明。

## 参考文档（上游 repo `docs/`，2026-08-16 核验）

- `docs/architecture.zh.md` — 总体架构
- `docs/capability-seams.zh.md` — 全部能力 seam 与核心服务清单（D12 seam 表的官方依据）
- `docs/cookbook/extension-cookbook.zh.md` — 钩子插件 / 工具插件 / UI 插件 / 协议驱动形态
- `docs/cordis-tutorial/01-first-plugin.zh.md` — Cordis 插件最小范式（`export apply(ctx)`）
- `docs/subsystems/{session,persistence,approval,jobs,skills,invariants,credentials}.zh.md`
- `docs/user/develop/practice/llm-adapter.zh.md` — 自研 LLM adapter 指南
