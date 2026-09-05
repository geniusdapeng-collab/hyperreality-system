---
name: session-watch
version: 1.0.0
description: 机床会话监督——事件流归一、围栏判定、熔断、场域直播。
---

# 机床会话监督

## 一、何时调用
- 每次受管会话生命周期内持续生效（dev-dispatch 启动即挂载）。

## 二、输入契约
- 机床 stdout 原始流（Codex JSONL / Claude stream-json / Aider 文本流）。

## 三、执行步骤
1. 事件归一：started / progress / file_edited / command_run / usage / done / error
2. 每条自报命令过围栏：deny 默认拦截、escalate 升审批、连续 3 次触发熔断击杀
3. payload 落库前凭据模式脱敏（sk-/ghp_/AKIA/私钥/Bearer）
4. 里程碑镜像进 biz_events 哈希链（dispatched / session_end）
5. 直播推送 P25：事件流增量轮询 + 织造车间机床亮起 + 关键节点语音播报

## 四、边界与围栏
- 围栏判定针对工具自报命令流；硬约束另有两层：codex --sandbox workspace-write 与 worktree 钳制
- 脱敏失败宁可不落该行事件，也不让凭据进库

## 五、与其他技能的协作
- 围栏拦截留痕进 dev_fences_audit（复盘素材）；异常终态交 dev-dispatch 返修判定。
