# 真机验收执行器（scripts/acceptance/**）

> 规范：`docs/REAL-DEVICE-ACCEPTANCE-SPEC.md`（RDAS v3.1）｜检查单：`docs/acceptance/checklist.v3.json`（276 项）｜模板：`docs/acceptance/report-template.md`
> 本目录随基座 base-sync 分发到各仓（`sync/base-scope.json#include: scripts/**`）；**行业差异只写在本仓 `acceptance/profile.json`**，不要改这里的代码。

## 命令

```bash
pnpm acceptance:profile:check     # 校验本仓 acceptance/profile.json（缺字段直接失败）
pnpm preview:all                  # 起真机（可用 profile.startup.command 覆盖）
pnpm acceptance:matrix            # L0 契约层 + L1 运行层：员工/技能/围栏矩阵
pnpm acceptance:ui                # L3 页面层：路由 + 岗位档案页 + 技能中心 + 控制台
pnpm acceptance:experience        # L4/L5：角色 × 旅程走查 + 术语/对比度/打扰机检
pnpm acceptance:live              # P 域入口；无法证明付费请求总量上界时 blocked，见下文
pnpm acceptance:live:selftest     # P 域自检：本地替身跑通管道（非生产实测证据）
pnpm acceptance:outcome --validate-only  # O 域只读契约与 P0 次数声明校验
pnpm acceptance:outcome --selftest       # 执行器自建 HTTP 夹具，外部目标/DB/模型请求为零
pnpm acceptance:report            # 汇总 → outputs/acceptance/REPORT.md（含四段硬性内容）
```

常用参数：`--out <dir>`（产物目录）、`--profile <path>`（临时 profile）、`--workspace <id>`、`--bundle <slug>`、`--only EXP-02,EXP-09`（只跑指定走查）、`--fail-on-error`（矩阵：有失败即非零退出）。

## 产物

```
outputs/acceptance/
  matrix/{agent-matrix.json,agent-matrix.csv,skill-matrix.json,skill-matrix.csv,matrix-summary.json,matrix-summary.md}
  ui/{ui-probe.json,shots/*.png}
  experience/{experience-report.json,experience-report.md,shots/*.png}
  live/{live-report.json,live-report.md,transcripts/*.json,receipts/*.json,artifacts/*,budget-ledger.jsonl,budget-summary.json}
  regression/{*.observation.json,summary-input.json,summary.json}
  runs/*.json                      # 实际 argv/退出码/信号/时刻/完整提交及输出散列
  evidence-index.json              # 实际阶段运行与产物索引
  coverage.json                    # 固定 276 项；未验证保留在分母内
  report-summary.json              # reportGenerated 与 acceptancePassed 分开
  REPORT.md                        # report-v3.mjs 生成；生成报告不代表验收通过
```

## 生产环境实测（P 域 · v3.1）

本机预览（`preview:all` + `LLM_PROVIDER=mock`）只能证明代码与装配；**要证明「客户端内置模型走通生产链路」必须声明环境档位并跑 P 域**：

```bash
# 客户端运行时（已安装桌面客户端；默认 server 8787 / web 5173）
pnpm acceptance:live --env client-runtime
# 生产部署（profile.environment.target 必须显式声明地址）
pnpm acceptance:live --env deployed
# 只跑 P 域 + 覆盖率 + 报告（生产最小侵入档，不装依赖/不种子/不起本机预览/不关停目标）
node scripts/acceptance/fleet-run.mjs --repo workloom-im --env client-runtime --live-only
# 发布门禁口径：只要出现 blocked/failed 即非零退出
pnpm acceptance:live --env deployed --require-live
```

四种适配链路（报告逐任务标注，不能从配置推定可用）：

| 链路 | 走什么 | 证据 |
|---|---|---|
| `dsh-harness` | 设计目标是内置 Harness + 围栏 + 审计链；当前真实 CLI 无法证明输入、重试与多步调用的总 token 上界，付费 I/O 前 `blocked` | 本地受控子进程替身可验运行时事件与真实 usage 记账；不算生产模型证据 |
| `model-gateway` | 网关适配器能验证 HTTP 与 usage；当前真实 CLI 没有可信请求总量上界，调用前 `blocked` | 本地 HTTP 替身的回执与计量；`expectedTokens` 声明不能解除阻断 |
| `gen-http` | 受生成数量、时长与预算前置预占约束的生图/生视频入口 | 下载到真实文件、散列、实际解码、独立回执；URL 或声明时长不算产物通过 |
| `product-dispatch` | 产品模型路由内部调用没有可证明的总量上界，真实 CLI 在登录/派单前 `blocked` | 低层本地受控替身验证终态、同线程回执、事件与状态断言；不算真实业务完成 |

配额与成本：`live.budgets` 声明图 ≤8 张、视频 ≤3 段且各 10–15s、总 ≤45s、LLM ≤40 次/30 万 token、估算成本 ≤¥120；profile 只能收紧。
执行器先按可证明的请求上界预占，再以实际 usage 结算，累计 token 上限不随单次结算重置，同一 reservation 不能重复结算。
未知实际用量保留预占并冻结后续所有模态的付费调用；无法证明请求上界时根本不发请求。输出 `maxTokens` 或人工 `expectedTokens` 不能证明输入、上下文、重试与工具循环的总上限。
成本仍是估算值，真实账单需另行对账（P1-04）；本地 selftest 和替身测试不能证明供应商真实扣费受控。

O 域同样受这条预算前提约束：默认 `acceptance:outcome` 在登录、派单、连接数据库前返回 `2`，因为公开产品路由缺少可信服务端逐请求预算接口。`dataMode=simulated`、`LLM_PROVIDER=mock`、低 trial 数或环境标签不能解除阻断。`--selftest` 只访问执行器自己创建并关闭的 loopback HTTP 夹具，忽略 profile 的外部目标；SQL/审批任务和生产环境不能用该模式执行。报告标为 `owned-fixture`、`runner-owned-mock`、业务能力未验证，保留 HTTP 拒绝、终态、回执与 P0 重复断言。真实 O 域业务实测须先接入受控服务端预算与授权适配器。

凭据：只从环境变量/秘密存储解析（`DEEPSEEK_API_KEY`、`VOLCENGINE_ARK_API_KEY` / `SEEDREAM_API_KEY` / `SEEDANCE_API_KEY`），
**禁止写进 profile、报告或仓库**；缺凭据时任务状态为 `blocked`，报告只能写“未验证”。

### 真实 key 放哪里（三种投递方式，可混用）

**v3.1.1 起自动发现**（不传任何参数也会按序找）：`--keys-file`（显式）→ `$WORKLOOM_LIVE_ENV` → `~/.workloom/live.env`
→ macOS Keychain（`workloom-live-deepseek` / `workloom-live-ark`）→ 客户端 `runtime/.env`（仅 `--env client-runtime`）。
同名键不覆盖已有值；报告只记录来源与键名，密钥值不落盘、不进日志。`--no-auto-keys` / `--no-keys-from-client` 可分别关闭后两段。

> ⚠ 不要用 `--env-file`：它与 Node 自带参数同名，文件不存在时 Node 会先崩；`--env-file` 仅作历史兼容别名保留。

| 方式 | 怎么做 | 适用 |
|---|---|---|
| ① 进程环境 / Keychain（推荐） | 在「钥匙串访问」中添加对应服务的通用密码，或由受控包装脚本通过 stdin 写入；执行器在进程内读取 `workloom-live-deepseek` / `workloom-live-ark`。真实值不进入命令参数、日志或文件 | macOS 本机、需避免明文持久化 |
| ② 仓库外秘密文件 | 建 `~/.workloom/live.env`（`chmod 600`）写 `DEEPSEEK_API_KEY=…`、`VOLCENGINE_ARK_API_KEY=…`；默认位会被自动发现，指定别处时用 `--keys-file <path>` | 需要一次配好、多次复跑 |
| ③ 客户端运行时 `.env` | 在真实客户端里用落地向导「真实大模型」步骤写入（或直接编辑 `<支持目录>/runtime/.env`），验收器在 `--env client-runtime` 时自动补齐缺失键 | 验“客户端内置模型”本身 |

封存位置固定后**不需要每次传 `--env-file`**：钥匙串用 `-s workloom-live-deepseek` / `-s workloom-live-ark`，文件用 `~/.workloom/live.env`，验收器会自动命中。
自证：`outputs/acceptance/live/live-report.json#credentialSources` 会列出实际来源与键名（只有键名，没有值）；`ready=true` 只代表凭据可用，仍须满足请求上界、环境、写入授权、预算与链路支持前提。

必需的键（按要跑的模型选）：

- LLM：`DEEPSEEK_API_KEY`（+ 可选 `DEEPSEEK_BASE_URL`）；本执行器的 HTTP 路由使用 OpenAI 兼容接口，DSH 路由使用 Anthropic 兼容接口与 `/anthropic` 路径。凭据与端点齐备仍须先通过总请求预算上界门禁，当前正式 LLM 验收链未通过该前置条件。
- 生图：`SEEDREAM_API_KEY` 或共用 `VOLCENGINE_ARK_API_KEY`（+ 可选 `SEEDREAM_ENDPOINT` / `SEEDREAM_MODEL`）
- 生视频：`SEEDANCE_API_KEY` 或共用 `VOLCENGINE_ARK_API_KEY`（+ 可选 `SEEDANCE_ENDPOINT` / `SEEDANCE_MODEL`）

安全纪律：key 只进 Keychain / 仓库外文件 / 客户端运行时 `.env`；**不要**贴到聊天、Issue、PR、`.env.example` 或任何入库文件里。

`regression/summary.json` 使用 `workloom.acceptance-regression/v2`，由 `lib/regression-evidence.mjs` 的实际 Node 子进程生成，不接受手写“通过”字符串。
每条必需命令的 `executions` 必须引用自己的运行记录和 `workloom.command-observation/v1` 文件，包含实际 argv、退出码、信号、起止时刻与完整提交。
聚合进程的 run 同时绑定 `regression/summary-input.json` 和最终 summary；报告重新回读完整 `required` 清单及每条命令，删除失败命令后重算散列仍会被拒绝。
`--skip-regression`、缺必需运行或返回 `2` 都保持未验证；实际非零失败传播为整体失败。文件存在与 `reportGenerated=true` 不能替代 `acceptancePassed=true`。

## 环境要求

- Node ≥ 24（与基座 `package.json#engines.node` 一致）；`pg`、`yaml`、`playwright` 来自本仓依赖（`pnpm install` 后可用）；
- 数据库：`.env` 里的 `DATABASE_URL` 指向**本次验收用的库**（默认演示库）；矩阵 B 层与 UI 探针都要读它；
- 三端端口：profile.startup.ports（默认 3000/3001/3002/8787）。
- 生产入口：`acceptance/profile.json#live`（模型清单/任务矩阵/配额）+ 真实凭据 + 可访问目标 + 可证明的付费请求总量上界。当前没有该上界的链路保持 blocked；本次修复没有验证供应商实际模型或客户安装运行。

## 加一条本仓专属走查

1. 在 `acceptance/profile.json#journeys` 增加一条：`{ "id": "EXP-11", "persona": "manager", "title": "…", "script": "builtin:…" }`（先用内置脚本）；
2. 若确需自定义交互，在**本仓**加 `scripts/acceptance-local/<name>.mjs`，profile 里写 `"script": "custom:<相对路径>"`，报告同样要留截图与实测值；
3. 发现新的通用陷阱 → 写进验收报告「陷阱清单增量」，由舰队维护者评审当前 `docs/acceptance/checklist.v3.json`；修改固定检查单需同时更新执行器及回归。

## 反面清单（做错了会被判无效）

- 只跑单测就宣称“验收通过”；
- 只检查元素存在，不真实点按、不核对写回；
- 用 mock 结果当真实回执；
- 用本机未声明的裁剪（如跳过 L3/L4）却写在“已完成”里；
- 验收脚本自身污染演示工作区却不披露。
- 用本机预览（mock）的结果充当“生产环境验收”或“内置模型已验证”（v3.1 陷阱 T-51/T-52）。
