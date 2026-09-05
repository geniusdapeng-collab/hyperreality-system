---
name: changeset-harvest
version: 1.0.0
description: 变更回收与三道关审计——diff 收集、硬门禁、LLM 评审、上线考。
---

# 变更回收与三道关

## 一、何时调用
- 机床会话以 done 终态结束时自动触发（S4）。

## 二、输入契约
- 会话 worktree（含机床未提交的工作区改动）+ 任务单验收标准 + 基线分支。

## 三、执行步骤
1. 回收：git diff --stat/--numstat（相对基线三点比较）+ 未跟踪文件逐文件展开 + 机床自总结
2. 第一关·硬门禁：探测仓库自带 typecheck/lint/test 逐个真跑 + 变更文件凭据泄露扫描；一门不过即短路
3. 第二关·LLM 评审：任务书 vs 变更统计对照（PASS/FAIL 首行结论）；模型缺配置降级放行并标 mock，由人工把关
4. 第三关·上线考：eval-core 变更即考（perStructure=1），verdict=fail 才拦
5. 三道关结果落 dev_changesets；全过 → pending_approval；不过 → 原因回灌返修（≤2 轮）

## 四、边界与围栏
- 硬门禁在 worktree 内执行，超时 180s 逐关熔断
- 评审报告与 diff 原文可互相印证，绝不只给结论不给依据

## 五、与其他技能的协作
- 全过产出发布卡素材（P25 审批视图）；未过原因交 dev-dispatch 组织返修。
