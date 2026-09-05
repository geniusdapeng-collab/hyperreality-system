---
name: dev-dispatch
version: 1.0.0
description: 开发任务派发——选机床、建隔离 worktree、快照、启动受管会话。
---

# 开发任务派发

## 一、何时调用
- 任务单经人类确认（S2 confirmed）后，由开发总指挥触发；返修再派由系统自动接续。

## 二、输入契约
- dev_tasks（confirmed）+ dev_repos 白名单 + dev_tool_installs 在线机床台账。

## 三、执行步骤
1. 选派机床：指派优先，缺省按注册表顺序（Codex 优先，能力匹配）
2. git worktree 建隔离分支 `dev/<task-id>`（主分支零直写）
3. 快照先行：基线 commit + status 指纹（回滚锚点）
4. 凭据 L4 注入环境变量（secret 不进事件明文），启动受管会话
5. 返修第 2 轮起：携带打回原因，支持续跑的机床 resume 原线程

## 四、边界与围栏
- 未登记目录机床一寸都进不去（白名单 + 路径钳制双重强制）
- 会话三重熔断：超时 / 连续围栏拦截 / 进程异常
- 绝不假装：无在线机床时返回安装指引，不模拟开发

## 五、与其他技能的协作
- 会话监督交 session-watch；终点自动接 changeset-harvest 审计；
  失败按返修纪律（≤2 轮）自动再派，再败转人工。
