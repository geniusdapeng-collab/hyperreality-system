---
name: render-ops
description: 渲染提交纪律官方套件（随 bundles/ai-video 分发，F8.1 官方套件级）：渲染脚本 CMS 版本链管理、三档提交（手动/批量/自动化连锁）、binding-manifest 强制、RenderPipelineGuard 渲染前检查、失败诊断与回填。安装后被渲染师调用；绑定围栏 G8，卸载即撤销（F8.2/L8.3）。
---

# 渲染提交纪律

## 适用场景
- 渲染脚本生成入 CMS 与版本管理
- Seedance 提交（手动单镜/整片批量/自动化连锁三档，G8 审批）

## 方法
1. 脚本入 CMS：MD 正文 + 25/30 字段 JSON + 字符数校验快照；每次修改产生新版本（parent_version 链），禁原地覆盖。
2. 三档提交：手动（点「渲染」单镜提交）/批量（整片提交 + render.poll 轮询回填）/自动化连锁（triggers：render.done → post.compose → publish_task → watch，默认全链 review，信任后逐环降 auto）。
3. 提交前：binding-manifest 强制绑定定妆照清单；过 RenderPipelineGuard；确认 G8 审批通过。
4. 提交后：验证并回填 render_jobs（task_id/script_version/cost/result_url）；失败先诊断再决定重提或转人工，不盲目重试。

## 输出契约
- 每次提交输出：脚本版本号 + 审批卡引用 + task_id + 成本 + 结果回执。
- 版本 diff 可见，任何回滚有迹可循。
- 无工具回执的关键数字标「未核实」，不得宣称完成（L3.6/E3.7）。
