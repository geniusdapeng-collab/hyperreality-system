# 排雷式交付执行器（scripts/delivery/**）

> 规范：`docs/MINE-CLEAR-DELIVERY-SPEC.md`（mcd/v1.0）｜台账 schema：`docs/mine-clear/ledger.schema.json`｜报告模板：`docs/mine-clear/report-template.md`｜投喂模板：`docs/mine-clear/prompt-pack.md`
> 本目录随基座 base-sync 分发到各仓（`sync/base-scope.json#requiredRootAssets`）；**行业差异不要改这里的代码**。

## 触发

命中以下任一意图即启用本机制（规范 §0）：**排雷 / 排雷式交付 / 系统性排查 / 交付前排查 / 交付体检 / 挖问题 / 问题台账 / 修复排期 / 假修复 / 联动地雷 / MCD / mine-clear**。
"独立验收 / 上线前验收"由 RDAS v3.1（`docs/REAL-DEVICE-ACCEPTANCE-SPEC.md`）承担，本机制负责把验收需要的台账与交接单准备好。

## 命令

```bash
# 1) 记录审计基线 + 建台账（输出 outputs/mine-clear/<任务号>/）
node scripts/delivery/mine-clear.mjs init --repo . --task T-2026-0929-0004 --env local-preview
node scripts/delivery/mine-clear.mjs invariants --ledger outputs/mine-clear/T-2026-0929-0004/ledger.json

# 2) 上账（问题卡 / 修复卡）
node scripts/delivery/mine-clear.mjs card-template --kind problem > card.json   # 填好后：
node scripts/delivery/mine-clear.mjs add --ledger <台账> --card card.json

# 3) 门禁与视图
node scripts/delivery/mine-clear.mjs gate --ledger <台账>              # 断言/回归/自验/P0 硬闸
node scripts/delivery/mine-clear.mjs status --ledger <台账>
node scripts/delivery/mine-clear.mjs plan --ledger <台账>              # 四批计划 + 冲突面
node scripts/delivery/mine-clear.mjs verify-baseline --ledger <台账> --repo .   # 三基线对齐

# 4) M6 交接 RDAS v3.1
node scripts/delivery/mine-clear.mjs handoff --ledger <台账> --env client-runtime
pnpm acceptance:profile:check
node scripts/acceptance/fleet-run.mjs --repo <repo> --env client-runtime
```

## 门禁语义（gate 为什么判红）

| 判红原因 | 出处 |
|---|---|
| 卡片缺实证 / 缺 `@commit` | 纪律 1「无证据不上账」 |
| 断言缺可运行 `command`、含"优化/提升/加强"类措辞 | 纪律 9「验证信号前置」 |
| `last_result=pass` 但没有断言输出路径 | 纪律 1「证据优先于声明」 |
| `state=verified` 但验证人与修复人相同（且无 waiver） | 纪律 7「修复者不自验」 |
| 修复卡缺 `regression` / `rollback` / `conflict_paths` / 联动推演 | M5 修复卡格式 |
| **P0（突破核心不变量/安全）未闭环** | 纪律 5「修缮不修穷」+ 阻断交付 |
| 台账缺系统不变量清单 | M0「不变量是断言设计的骨架」 |

`handoff` 另外要求：**每个未闭环项都有 `regression.command`**（规范 §7），否则拒绝生成交接单。

## 产物

```
outputs/mine-clear/<任务号>/
  baseline.json   # 审计基线：commit / 分支 / 远端 main 对比 / 工作树脏项 / 冒烟位
  ledger.json     # 问题卡 + 修复卡 + 断言 + 证据
  evidence/       # 断言输出原文、日志摘录、响应原文、截图
  report.md       # 按 docs/mine-clear/report-template.md 出（四段硬性内容不可缺）
  handoff.json    # RDAS 验收交接单
```

## 退出码

`0` 通过；`1` 门禁未过 / 存在 stale 基线卡 / 交接被拒；`2` 参数或环境错误。

## 自测

```bash
node --test scripts/delivery/mine-clear.test.mjs
```
