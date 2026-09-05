---
name: github-pulse
version: 1.0.0
description: gh API 读取 issue/PR/提交节奏，LLM 分析产品健康度。
---

# GitHub 仓库脉搏

## 一、何时调用
- 由对应数字员工按岗位任务触发；夜班任务按编排窗口执行。

## 二、输入契约
- 行业包种子数据/运行时事件流；外部信息必须带来源回执。

## 三、执行步骤
1. 凭据走 L4 Patch 注入（只读 token，不进事件明文）
2. 拉取近 7 天 issue/PR/commit 节奏
3. LLM 生成仓库脉搏分析（活跃度/阻塞点/建议）

## 四、边界与围栏
- 权限面：联网只读。
- 写入级动作严格走 preset 的 fence_bindings；引用外部信息必须标注来源。
- 绝不编造：无工具回执的事实标「未核实」。

## 五、与其他技能的协作
- 产出进晨报素材池；异常与高威胁项挂审批台（review-console）。

## 六、运行配置
- API base 回退链：默认 `https://api.github.com` 直连优先，不可达自动切 `https://gh-proxy.com/https://api.github.com` 镜像（两条链都是真实 GitHub 数据）。
- 可用环境变量 `GITHUB_API_BASE` 覆盖整条链（逗号分隔多个 base 按序尝试）；全部失败才落 `mock:true` 兜底（D4 纪律：绝不假装真实）。
