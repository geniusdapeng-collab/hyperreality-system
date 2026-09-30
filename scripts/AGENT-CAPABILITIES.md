# WorkLoom Agent 能力入口 v1

此入口供 Codex、DeepSeek Harness 等桌面 Agent 使用。仓库内的能力清单是唯一可发现集合：公共只读能力在
`scripts/agent-capabilities.core.json`，行业能力在
`bundles/<defaultBundle>/agent-capabilities.json`。已有 PC/B/C UI 与 CLI/MCP 调用同一服务端过程；
CLI 和 MCP 不直接写数据库，也不能绕过服务端的成员/住客范围、围栏、审批、事件与回执链。

## 本机使用

要求 Node.js 24（与仓库 `package.json#engines` 一致）。从仓库根执行：

```sh
node scripts/workloom-agent.mjs list
node scripts/workloom-agent.mjs describe core.threads.get
printf '%s\n' '{"threadId":"T-101"}' | node scripts/workloom-agent.mjs invoke core.threads.get --input-file -
node scripts/workloom-agent-mcp.mjs
```

`list` 和 `describe` 无网络调用。默认服务地址从
`product.manifest.json#desktop.portOffset` 计算为本机 `127.0.0.1:8787+offset`；
可通过 `WORKLOOM_BASE_URL` 或 `--base-url` 覆盖。非回环地址必须使用 HTTPS。
开发源码服务若直接运行在 8787，应显式设 `WORKLOOM_BASE_URL=http://127.0.0.1:8787`。
一个 CLI 可以用 `--root <产品仓路径>` 读取另一仓的产品清单；MCP 用
`WORKLOOM_PRODUCT_ROOT` 指定产品仓。公共能力清单始终随 CLI 版本提供，
行业清单由目标仓提供。

本机开发态在未提供 `WORKLOOM_ACCESS_TOKEN` 时，CLI 使用
`product.manifest.json#demoWorkspaceSlug/demoMemberNo` 请求现有 `auth.loginAs`
得到当前工作区成员会话；可用 `WORKLOOM_WORKSPACE_SLUG`、
`WORKLOOM_MEMBER_NO` 指定另一种子成员，用 `WORKLOOM_DEV_AUTO_LOGIN=0` 禁用。
远程地址必须预先提供 `WORKLOOM_ACCESS_TOKEN`。C 端能力单独要求
`WORKLOOM_C_TOKEN`；它与 B 端成员令牌不能互换。令牌只读环境变量，
不得放进命令参数、仓库文件或日志。

## 能力与完成判定

每项清单提供稳定 ID、版本、输入 JSON Schema、操作类别、风险、数据模式和受控传输。
传输只允许服务端 tRPC、同源 `/c/` 路径以及行业目录下的本地只读预览函数。
禁用项会在 CLI 清单中显示原因，不进入 MCP `tools/list`，调用时失败关闭。
执行类能力强制 `idempotencyKey`，但幂等、授权与审批最终由服务端实施。

成功调用返回单行 JSON，格式为
`{schemaVersion, capabilityId, operation, status, dataMode, result, receipt?}`。
`status=pending` 表示动作已提交但交付尚未核实；`receipt.synced` 只从服务端
可验证回执得出。提供的外部快照用 `provided-unverified`，演示工单用
`simulated`，不能被客户端提升为真实外部完成。错误只写 stderr 并返回非零退出码。

MCP 以 stdio JSON-RPC 暴露同一清单，每项能力一个工具；其
`readOnlyHint/destructiveHint/idempotentHint` 是客户端提示，不是授权边界。
Codex 配置本地 STDIO MCP 与 DeepSeek Harness 自定义 STDIO MCP 时，
命令均指向本仓 `node scripts/workloom-agent-mcp.mjs`；具体配置键以各客户端
当前官方文档为准。

## 开发与发布

行业清单留在行业 bundle，不把行业语义写进基座。服务端新增路由必须复用
该仓已验证的权限/租户/围栏/事件路径，并有独立回执查询；不能仅在清单里
登记一个脚本或将 mock 结果标作真实交付。修改后运行：

```sh
node --test scripts/agent-capabilities.test.mjs
node scripts/workloom-agent.mjs list
node scripts/workloom-agent-mcp.mjs
```

然后按仓库 `AGENTS.repo.md` 与 `docs/release-checklist.md` 运行相关类型、
测试、secret scan、发布门禁及真实客户端验收；未全部通过不得发布可执行制品。
