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
pnpm acceptance:live              # P 域：生产环境实测（内置模型真实调用 + 配额台账 + 回执）
pnpm acceptance:live:selftest     # P 域自检：本地替身跑通管道（非生产实测证据）
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
  regression/summary.json          # 可选：由执行者写入套件/门禁/验链结论
  REPORT.md                        # report.mjs 生成
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

四条真实链路（报告逐任务标注）：

| 链路 | 走什么 | 证据 |
|---|---|---|
| `dsh-harness` | 客户端内置 DeepSeek Harness headless：真实 provider → 工具调用过围栏瀑布 → session/event 落哈希链账本 | `transcripts/*.json`（`fenceHits` + `audit.chain` 验证） |
| `model-gateway` | OpenAI 兼容网关直连（推理/多模态理解），不含围栏与账本 | `receipts/*.json`（endpoint/model/tokens） |
| `gen-http` | 火山方舟 Ark 生成 API（Seedream 生图同步 / Seedance 生视频任务制） | 产物落盘 + `task_id`/`video_url`/时长 |
| `product-dispatch` | 经产品自身入口（trpc `threads.dispatch`）派单 + 状态断言 | 环境状态断言 + 回执；假成功直接红线候选 |

配额与成本：`live.budgets` 是**硬上限**（基座下限：图 ≤8 张、视频 ≤3 段且各 10–15s、总 ≤45s、LLM ≤40 次/30 万 token/¥120），
超限即中止该任务并写 `budget-ledger.jsonl`；成本是**估算值**，账单需另行对账（P1-04）。

凭据：只从环境变量/秘密存储解析（`DEEPSEEK_API_KEY`、`VOLCENGINE_ARK_API_KEY` / `SEEDREAM_API_KEY` / `SEEDANCE_API_KEY`），
**禁止写进 profile、报告或仓库**；缺凭据时任务状态为 `blocked`，报告只能写“未验证”。

### 真实 key 放哪里（三种投递方式，可混用）

**v3.1.1 起自动发现**（不传任何参数也会按序找）：`--keys-file`（显式）→ `$WORKLOOM_LIVE_ENV` → `~/.workloom/live.env`
→ macOS Keychain（`workloom-live-deepseek` / `workloom-live-ark`）→ 客户端 `runtime/.env`（仅 `--env client-runtime`）。
同名键不覆盖已有值；报告只记录来源与键名，密钥值不落盘、不进日志。`--no-auto-keys` / `--no-keys-from-client` 可分别关闭后两段。

> ⚠ 不要用 `--env-file`：它与 Node 自带参数同名，文件不存在时 Node 会先崩；`--env-file` 仅作历史兼容别名保留。

| 方式 | 怎么做 | 适用 |
|---|---|---|
| ① 进程环境 / Keychain（推荐） | 钥匙串存：`security add-generic-password -a "$USER" -s workloom-live -w '<key>' -U`；跑验收时由包装脚本导出，例如 `DEEPSEEK_API_KEY="$(security find-generic-password -s workloom-live-deepseek -w)" pnpm acceptance:live --env client-runtime` | macOS 本机、不想落任何文件 |
| ② 仓库外秘密文件 | 建 `~/.workloom/live.env`（`chmod 600`）写 `DEEPSEEK_API_KEY=…`、`VOLCENGINE_ARK_API_KEY=…`；默认位会被自动发现，指定别处时用 `--keys-file <path>` | 需要一次配好、多次复跑 |
| ③ 客户端运行时 `.env` | 在真实客户端里用落地向导「真实大模型」步骤写入（或直接编辑 `<支持目录>/runtime/.env`），验收器在 `--env client-runtime` 时自动补齐缺失键 | 验“客户端内置模型”本身 |

封存位置固定后**不需要每次传 `--env-file`**：钥匙串用 `-s workloom-live-deepseek` / `-s workloom-live-ark`，文件用 `~/.workloom/live.env`，验收器会自动命中。
自证：`outputs/acceptance/live/live-report.json#credentialSources` 会列出实际来源与键名（只有键名，没有值）；三个模型 `ready=true` 才允许真实调用。

必需的键（按要跑的模型选）：

- LLM：`DEEPSEEK_API_KEY`（+ 可选 `DEEPSEEK_BASE_URL`，默认 `https://api.deepseek.com`）
- 生图：`SEEDREAM_API_KEY` 或共用 `VOLCENGINE_ARK_API_KEY`（+ 可选 `SEEDREAM_ENDPOINT` / `SEEDREAM_MODEL`）
- 生视频：`SEEDANCE_API_KEY` 或共用 `VOLCENGINE_ARK_API_KEY`（+ 可选 `SEEDANCE_ENDPOINT` / `SEEDANCE_MODEL`）

安全纪律：key 只进 Keychain / 仓库外文件 / 客户端运行时 `.env`；**不要**贴到聊天、Issue、PR、`.env.example` 或任何入库文件里。

`regression/summary.json` 约定：

```json
{ "commands": { "suite": "467/467 通过", "suite:domain": "81/81 通过", "db:verify-chain": "哈希链全绿（seq 空洞 629，已解释）", "typecheck": "通过", "release:gate": "11/11 通过" } }
```

## 环境要求

- Node ≥ 20（基座 package.json 已声明）；`pg`、`yaml`、`playwright` 来自本仓依赖（`pnpm install` 后可用）；
- 数据库：`.env` 里的 `DATABASE_URL` 指向**本次验收用的库**（默认演示库）；矩阵 B 层与 UI 探针都要读它；
- 三端端口：profile.startup.ports（默认 3000/3001/3002/8787）。
- 生产实测：`acceptance/profile.json#live`（模型清单/任务矩阵/配额）+ 真实凭据 + 可访问的目标环境（客户端或部署地址）。

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
- 用本机预览（mock）的结果充当“生产环境验收”或“内置模型已验证”（v3.1 陷阱 T-51/T-52）。
