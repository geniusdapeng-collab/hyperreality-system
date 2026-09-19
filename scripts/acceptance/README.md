# 真机验收执行器（scripts/acceptance/**）

> 规范：`docs/REAL-DEVICE-ACCEPTANCE-SPEC.md`（RDAS v1）｜检查单：`docs/acceptance/checklist.v1.json`｜模板：`docs/acceptance/report-template.md`
> 本目录随基座 base-sync 分发到各仓（`sync/base-scope.json#include: scripts/**`）；**行业差异只写在本仓 `acceptance/profile.json`**，不要改这里的代码。

## 命令

```bash
pnpm acceptance:profile:check     # 校验本仓 acceptance/profile.json（缺字段直接失败）
pnpm preview:all                  # 起真机（可用 profile.startup.command 覆盖）
pnpm acceptance:matrix            # L0 契约层 + L1 运行层：员工/技能/围栏矩阵
pnpm acceptance:ui                # L3 页面层：路由 + 岗位档案页 + 技能中心 + 控制台
pnpm acceptance:experience        # L4/L5：角色 × 旅程走查 + 术语/对比度/打扰机检
pnpm acceptance:report            # 汇总 → outputs/acceptance/REPORT.md（含四段硬性内容）
```

常用参数：`--out <dir>`（产物目录）、`--profile <path>`（临时 profile）、`--workspace <id>`、`--bundle <slug>`、`--only EXP-02,EXP-09`（只跑指定走查）、`--fail-on-error`（矩阵：有失败即非零退出）。

## 产物

```
outputs/acceptance/
  matrix/{agent-matrix.json,agent-matrix.csv,skill-matrix.json,skill-matrix.csv,matrix-summary.json,matrix-summary.md}
  ui/{ui-probe.json,shots/*.png}
  experience/{experience-report.json,experience-report.md,shots/*.png}
  regression/summary.json          # 可选：由执行者写入套件/门禁/验链结论
  REPORT.md                        # report.mjs 生成
```

`regression/summary.json` 约定：

```json
{ "commands": { "suite": "467/467 通过", "suite:domain": "81/81 通过", "db:verify-chain": "哈希链全绿（seq 空洞 629，已解释）", "typecheck": "通过", "release:gate": "11/11 通过" } }
```

## 环境要求

- Node ≥ 20（基座 package.json 已声明）；`pg`、`yaml`、`playwright` 来自本仓依赖（`pnpm install` 后可用）；
- 数据库：`.env` 里的 `DATABASE_URL` 指向**本次验收用的库**（默认演示库）；矩阵 B 层与 UI 探针都要读它；
- 三端端口：profile.startup.ports（默认 3000/3001/3002/8787）。

## 加一条本仓专属走查

1. 在 `acceptance/profile.json#journeys` 增加一条：`{ "id": "EXP-11", "persona": "manager", "title": "…", "script": "builtin:…" }`（先用内置脚本）；
2. 若确需自定义交互，在**本仓**加 `scripts/acceptance-local/<name>.mjs`，profile 里写 `"script": "custom:<相对路径>"`，报告同样要留截图与实测值；
3. 发现新的通用陷阱 → 写进验收报告「陷阱清单增量」，由舰队维护者合并回 `docs/acceptance/checklist.v1.json`。

## 反面清单（做错了会被判无效）

- 只跑单测就宣称“验收通过”；
- 只检查元素存在，不真实点按、不核对写回；
- 用 mock 结果当真实回执；
- 用本机未声明的裁剪（如跳过 L3/L4）却写在“已完成”里；
- 验收脚本自身污染演示工作区却不披露。
