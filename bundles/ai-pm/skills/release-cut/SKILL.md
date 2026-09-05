---
name: release-cut
version: 1.0.0
description: 发布与版本——合并基线、semver 建议、tag、changelog、版本台账。
---

# 发布与版本

## 一、何时调用
- 人类在审批台批准发布（S5）后触发（S6）。

## 二、输入契约
- pending_approval 任务单 + 最新 changeset（三道关全过）+ 目标仓库基线分支。

## 三、执行步骤
1. 机床未提交改动由系统兜底提交（隔离分支内）
2. 合并回基线分支（--no-ff；冲突自动中止转人工，绝不强合）
3. semver 建议：feat→minor / fix→patch / breaking→major（人类可改）
4. git tag v<x.y.z> + changelog（LLM 生成，缺配置确定性模板兜底）
5. releases 版本台账登记（版本/任务/审计哈希/合并 commit/批准人）
6. worktree 整棵清理；场域反馈：版本时间线 +1 + 语音播报

## 四、边界与围栏
- 推送远端永远走人类审批（默认关，开了也逐次批准）
- releases 属客户资产：一键清空不删（红线同 biz_events）
- 审计哈希随版本落库——每版都可回溯到三道关原始记录

## 五、与其他技能的协作
- changelog 复用 release-notes 技能口径；发布后反馈回流 user-listener 观察口碑。
