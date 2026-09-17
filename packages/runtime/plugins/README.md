# packages/runtime/plugins · dsh 挂载点（D12）

> 双轨纪律：六插件核心逻辑在 `packages/base/`（自研护城河、纯服务层、可单测）；
> 本目录只放 dsh 插件适配器（Cordis 生命周期薄壳），把自研服务挂进 dsh 的 seam/事件。

| 文件 | dsh 挂载点 | 对接的自研服务 |
|---|---|---|
| `workloom-fence.plugin.js` | `tools/pre-execute` 瀑布 | fence-engine `judge`（B4） |

## 实证路径（B0 已验证的挂载方式）

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- insert:
    - id: workloom-fence
      name: '<本文件绝对路径或 npm 包内路径>'
      config:
        rulesUrl: 'http://localhost:8787/trpc/fence.activeRules'
```

## 后续挂载点（dsh-integration.md §3 映射表）

| 插件适配器（待落） | seam | 自研侧 |
|---|---|---|
| session-persistence-pg | `ctx.sessionPersistence` | workdata 事件桥（五元投影+哈希链 G8） |
| llm-workloom-router | `ctx.llm`（registerAdapter） | model-router（B7 分级/峰谷/降级链/计量） |
| review-console | `ctx.approval` / `ctx.userQuestions` | review-console（B6 三手势域） |
| night-shift | `ctx.jobs` + `ctx.commands` | night-shift（B9 状态机） |
| credentials-pg | `ctx.credentials` | credentials 表（引用 ID 口径 L7.3） |
| G8 不变量 | `ctx.invariants` | 「模型可见即已记录」校验 |
