# P 域执行器：预算、真实回执与本地产物

本目录由 `scripts/acceptance/live.mjs` 调用。它将模型响应、产品线程状态、媒体落盘与任务断言分别核验；任何一项缺失都不能成为 `status: "ok"`。本机预览和 `--selftest` 的任务可以完成管道检查，但 18 项 P 域检查均为 `unverified`，不能充作生产模型或客户业务通过证据。

当前正式 CLI 的 `gen-http` 图片/视频可在配额内执行；所有非 `--selftest` 的 LLM 路由（DSH、模型网关及未知 fallback chain）在外部调用前 `blocked`，因为尚无可信的输入、输出及重试总 token 上界。产品派单也在可信服务端逐请求预算接口接通前 `blocked`。四个适配器的代码和受控回归存在，不代表四条正式付费/业务链均已可执行。

## 运行与退出码

```sh
node scripts/acceptance/live.mjs --selftest --out outputs/acceptance/live
node scripts/acceptance/live.mjs --tasks LLM-R1 --no-auto-keys --no-keys-from-client
node scripts/acceptance/live.mjs --profile acceptance/profile.json --require-live
```

- `0`：真实环境报告满足通过条件；或没有 `--require-live` 的完整本地 selftest 管道完成。
- `1`：任务失败、假成功、脱敏/输出完整性失败，或 CLI/配置错误。
- `2`：未验证，包括未开启 live、零任务、未知请求任务、缺凭据、目标不可达、本机预览、脏 commit、预算阻断；`--require-live` 下 selftest 也为 `2`。

指定 `--out` 时，目录必须处在 `--evidence-root` 下；默认 evidence root 是输出目录的父目录。一次执行有独立 run ID，并用 `<out>.run-lock` 防止并发覆盖。重复任务 ID、含路径的任务 ID、重复有值参数、无值参数、未知 CLI 参数与非法超时会在模型占额前拒绝。崩溃后遗留的运行锁不会自动删除；确认原进程已退出且保存证据后，才能人工处置。

凭据只在进程内存中使用。可用显式进程环境或仓外 `--keys-file`；自动发现规则见执行器文件头。报告只记来源和键名。本轮输出还对继承凭据做精确值扫描；这不替代完整仓库秘密扫描。测试使用合成凭据，不能将测试中的 `synthetic` 或 `stub` key 配到真实端点。

## profile 与任务

```json
{
  "live": {
    "enabled": true,
    "budgets": { "maxLlmCalls": 2, "maxLlmTokens": 16000 },
    "models": [{
      "id": "reasoning-model", "kind": "llm", "adapter": "model-gateway",
      "model": "your-declared-model",
      "apiKeyEnv": "LIVE_API_KEY", "baseUrlEnv": "LIVE_BASE_URL"
    }],
    "tasks": [{
      "id": "LLM-R1", "kind": "llm", "chain": "model-gateway",
      "model": "reasoning-model", "purpose": "reasoning",
      "expectedTokens": 8000, "prompt": "your declared fixture",
      "expectAll": ["TASK_COMPLETE"]
    }]
  }
}
```

`environment`、三端与 server 地址、写入授权和夹具/残留声明由 profile/target 控制器统一处理。声明值与 CLI/父执行器档位冲突会拒绝。端点必须是无用户名、口令、查询或片段的 HTTP(S) 根。OpenAI 兼容根与 DSH Messages 根分别解析；模型和实际返回路由必须留档，换模仅认预声明的 `allowedModels`。

图片任务声明 `images`（正整数）、`prompt` 与可选 `minArtifacts`；视频声明 `durationSeconds`（10–15 秒）、`prompt` 与可选 `durationRange`。`params` 不得覆盖模型、输入、数量或时长，不能用参数绕过已经预占的额度。组图模型逐轮或一次生成的返回数量都按实际计量；超量返回不能变成成功。

## 预算日志

`budget.mjs` 使用 `workloom.live-budget/v2`。同一个 `outDir/runId` 的所有 writer 在独占事务锁内回放 `budget-ledger.jsonl`，先 fsync 占额日志，才返回放行。预算、环境、开始时间和冻结单价不可在同一次运行中重置。

- `reserve({ taskId, reservationId, kind, tokens, units })`：LLM 每次物理请求独立占用调用和 token 额度；图片按张，视频按段和秒计量。
- `commit({ taskId, reservationId, kind, tokens, units, calls, measured, status })`：回填供应商实际量；`measured` 默认 `false`，取得完整计量后必须显式传 `true`。相同结算幂等，冲突结算拒绝。
- `freeze({ taskId, reason })`：计量或事件证据不完整时阻断后续全部付费模态。
- `summary()` / `persist()`：返回并保存 `used`、`pending`、`actual`、`unmeasured`、`measurementComplete`、`frozenBy`、`exceeded` 与逐项 reservations。

`used` 对每项预占与实际量取较大者后累计，实际较少不退回额度；`actual` 只含已取得供应商计量的结算。异常/中断的请求保留在 `unmeasured`，不能写成实际零 token、零图片或零视频秒数。没有放行外部 I/O 的请求可据 `called: false` 记录真实调用数/生成量为零。缺计量或实际超限后，后续全部付费模态在外部 I/O 前被拒绝。单价仅是冻结估算，`costBasis.invoiced` 为 `null`，不能宣称供应商实付账单或实际成本绝不会超过估算。

`expectedTokens` 的预占和供应商响应后的实际结算不能证明一次外部 LLM 请求在计费前必然满足剩余总 token 上限。DSH 的 `maxTokens` 只限制输出，输入、历史上下文及重试仍可能发生费用；网关调用也没有可信总量约束。因此正式 CLI 在任何多模态夹具、DSH 登录/围栏读取、子进程、预算预占或供应商请求之前阻断该任务，记录 `called: false`，LLM 调用数/token/预占为零。配置很小或很大的 `expectedTokens`、修改 chain 或手写预算声明均不能绕过。将来放行需先接通可验证的每次请求总量约束，覆盖所有输入、输出、重试及子调用；调用后发现超量并冻结不能代替这一前置条件。

上限以 `LIVE_BUDGET_CAPS` 为准，profile 只能收紧。调用前预占是预算控制，供应商实际量仍需事后回读；若实际量大于预占，必须全额记录并失败/阻断，不掩去超量部分。完整账本必须归档，不能仅保留汇总。

## DSH 与网关计量

以下描述的是低层适配机制及受控 fixture 回归。正式 CLI 当前不会进入外部 DSH/网关请求；只有内部启动本地替身的 `--selftest` 可以验证管道。直接低层适配器要求调用方控制无费用 transport，不能把函数存在、合成运行时测试或计量事后完整当作正式生产 LLM 已通过或具有先验总量保证。

`runDshTask` 只支持锁定的 `0.2.0-rc.2` 事件协议，并回读已安装 package 版本。模型凭据通过 `@deepseek-ai/dsh-llm-deepseek-api-key` 的 `apiKeyEnv` 传给子进程；显式 Messages 端点进 patch，密钥和 `rulesToken` 不得落盘。临时 HOME 必须处在本次输出目录；子进程只接收运行所需环境和显式模型变量。

`audit.plugin.mjs` 监听上游双参数 `session/event(Session, SessionEvent)`，按会话 ID 与 seq 哈希、fsync 落盘。事件重放幂等；身份复用、缺号、损坏、尾部截断、凭据脱敏、未知 required event 都不能作为完成证据。`llm/stream` 每次请求/重试分别走共享预算，再取得真实 usage；缺失或不安全 usage、异常 stream 和未结算请求都保守持额并冻结。

`usage.mjs` 按 durable `turn/start`、`step/start`、请求路由、assistant message/attempt、retry、step/end 和 turn/end 汇总完整生命周期，包含 cache buckets。成功同时需要进程退出 `0`、未截断、真实非空答案、completed turn、每次预算结算与事件累计相同、实际 provider/model 路由在允许范围、哈希链有效。终端文字 `TASK_COMPLETE` 本身不证明这些条件。

`runChatTask` 要求 HTTP 成功、真实调用 ID/模型、非空答案及有效供应商 usage。缺 usage、畸形计量或无法确认请求是否产生用量时，返回 `tokens: null` 和 `usage.complete: false`；CLI 保留预占并冻结下一项任务。已获取计量与任务完成分开：error 终态仍然可计量，但不能通过任务。

固定协议来源：[官方 release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.2)、[SessionEvent 类型](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/core/session/src/types.ts)、[token meter](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/llm/token-meter/src/turn-usage.ts)。协议升级必须先适配并通过实际回归，不能只改版本检查。

## 产品入口的当前预算边界

当前 `threads.dispatch` 在派单前可能隐式调用意图分类，之后规划和 ASK 也可能调用模型。产品 `llmCall` 返回 `Promise<string>`；验收器没有可信的服务端逐请求预占/结算接口，不能在调用前证明整条链路受本次预算约束。`requireModel: false` 只是任务声明，不关闭分类器。

因此真实 CLI 的全部 product 任务在登录/派单前 `blocked`；生产写入还需先满足显式授权、夹具标记和残留披露。不能先请求一次真实派单，再把未知 usage 写成零或在费用发生后才宣告冻结。后续接通必须提供服务端可信预算 seam，约束分类、规划、回答、重试及子任务的每次请求，并绑定同一次验收 run。

`runProductDispatchTask` 保留给调用方控制的确定性、无模型 transport，验证业务结果的测试也使用该受控 transport；`requireModel: true` 在任何 dispatch I/O 前阻断。此低层函数不能单靠配置为真实服务证明无模型费用，不能作为绕过 CLI 预算闸的路径。

受控 transport 的完成要求是：返回真实 threadId，轮询参数为 `threadId`，目标线程为 `completed`，原始事件含当前、同线程的真实执行 receipt，进度一致，并且所有预声明断言实际执行通过。failed、paused、pending_review、超时和澄清均不算完成。ASK 没有工具执行 receipt 时，必须回读同线程最新 `ask.answer` 和具体事件结果断言，健康页不可替代。

事件断言示例：

```json
{
  "event": {
    "action": "ask.answer", "field": "decision.after.text",
    "contains": "预声明的业务结果", "minLength": 10
  }
}
```

支持 `equals`、非空 `contains`、正整数 `minLength`；字段路径禁止原型键。最终验证器重新从原始最新事件计算 type/target/actual/ok，拒绝手写通过声明或事件内容篡改。HTTP 与允许的单条 SELECT 断言必须有明确结果，SQL 不可用、未知断言与空断言集均失败。

## 媒体落盘与解码

图片和视频适配器及回执均显式记录 `measurementComplete`。图片逐轮校验供应商 `usage.generated_images`（非负安全整数，与返回图片 URL 数一致）后累加；缺失、强制转换、矛盾用量、HTTP 错误、网络中断或逐轮生成中途失败时，完整 `produced` 为 `null`，已有输出/用量下界留在 `observedProduced`/`knownProduced`，立即停止后续轮次。CLI 以 `measured: false` 结算，继续持有整项预占，并冻结后续 LLM、图片和视频。真实返回 `generated_images: 0` 与未知用量不同，计量可以完整，但任务仍然失败。

`model`/`receipt.model` 只来自供应商实际返回的模型名，`requestedModel` 单独保存请求配置。图片各轮必须返回一致、非空的模型；视频只接受同一任务身份的成功轮询元数据。缺模型、模型不一致或未预声明的实际换模不能完成任务，不能用请求配置补齐真实路由；已完整取得的图片/视频用量仍保留实际结算。CLI 以解析后的模型声明作为 `expectedModel`，换模仅接受 `allowedModels` 数组中精确的模型名，字符串或部分匹配无效。未实际调用的 P1 模型/路由观察保持 `unverified`。

视频提交或轮询失败、轮询超时、任务身份不一致、失败/取消/过期终态、缺 URL、下载或解码失败时，实际 `durationSeconds` 为 `null` 且计量不完整。请求时长和供应商 `reportedDurationSeconds` 均不可替代真实媒体时长；只有可解码落盘文件的实际秒数才显式 `measurementComplete: true`。供应商已完整返回的图片用量与下载交付结果分开：下载失败仍保留已测量的生成张数，不能把已发生用量降为零。

计量字段来源：[方舟图片生成 API 的 usage.generated_images](https://docs.volcengine.com/docs/ark/image-generation-api?lang=zh&redirect=1)、[视频 duration 为总帧数除以 24 后向下取整](https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh)。实际计量和交付完成分别核验，成功回执不能掩盖计量不完整。

URL 只是来源。下载必须 HTTP 成功、非零字节且在大小界限内（图片 64 MiB，视频 256 MiB），通过格式、PNG CRC/完整结束块或 MP4 容器/视频轨道校验，再用隔离浏览器解码本地字节。浏览器服务 worker 与外部请求都阻断。图片需真实像素；视频必须播放到结束并观察到解码帧，真实时长回填，声明时长不能替代。

产物目录、文件、真实路径必须在声明根内；符号链接、硬链接、不可读文件、校验中替换、超界路径、重复路径均拒绝。临时文件完成核验后原子改名，回执记本地 path/bytes/SHA-256/格式/解码信息。最终验证器重新读文件、解码并核对两份产物清单及视频时长，删除/篡改/403、URL-only 或假 MP4 不能通过。

可用 Playwright 已安装 Chromium，或独立临时 profile 的系统 Chrome。Chromium 支持的 codec 与 Chrome 有差异；仓内 selftest 视频是无外部模型调用生成、实际验证的 VP9 MP4，避免只在系统 Chrome 支持 H.264 的机器上可跑。解码器缺失返回 `blocked`，不跳过测试或伪造 decoded。

来源：[Playwright 浏览器支持](https://playwright.dev/docs/browsers)、[Chromium Audio/Video](https://www.chromium.org/audio-video/)。

## 证据输出与测试

执行器写 `budget-ledger.jsonl`、`budget-summary.json`、`live-report.json/md`、每项 receipts/transcripts、媒体和 DSH audit/patch。18 项 P0–P3 检查逐项记录 expected/actual/status/evidencePaths；一个任务通过不能扩散为其它领域通过。通过 `scripts/delivery/evidence.mjs` 绑定实际 command/argv/退出码、角色、完整 commit、时间与输出散列，再进入 acceptance evidence index。脏 commit、缺域/缺任务与 selftest 保持未验证。

无浏览器、无需真实凭据的回归：

```sh
node --test scripts/acceptance/lib/live/budget.test.mjs \
  scripts/acceptance/lib/live/live-truth.test.mjs \
  scripts/acceptance/lib/live/providers.test.mjs \
  scripts/acceptance/lib/live/providers-http.test.mjs \
  scripts/acceptance/lib/live/product.test.mjs \
  scripts/acceptance/lib/live/media-negative.test.mjs \
  scripts/acceptance/lib/live/usage.test.mjs \
  scripts/acceptance/lib/live/audit.test.mjs \
  scripts/acceptance/lib/live/dsh-process.test.mjs \
  scripts/acceptance/lib/live/live-cli.test.mjs \
  scripts/acceptance/lib/live/live-cli-wire.test.mjs
```

浏览器解码及完整 selftest CLI 回归，需现有 Playwright 和可启动浏览器：

```sh
node --test scripts/acceptance/lib/live/media-decoder.test.mjs \
  scripts/acceptance/lib/live/live-cli-browser.test.mjs
```

`dsh-process.test.mjs` 启动真实子进程并加载实际 audit/budget/usage 代码，但子进程的 DSH runtime metadata 和 provider 都是合成 fixture；它证明适配机制的物理请求计量与错误路径，不能证明官方完整 CLI 或真实供应商已通过。`live-cli-wire.test.mjs` 使用真实 CLI 和 loopback HTTP，验证非 selftest LLM 在供应商/DSH 登录前零调用、`expectedTokens` 不可绕过、内部 selftest 计量、媒体错误后持额并禁止后续全部模态、完整图片用量与交付失败分开、以及自定义凭据变量的错误体在写预算日志前即脱敏；`providers-http.test.mjs` 还通过真实 loopback HTTP 检查图片/视频的实际 fetch 超时。正式 LLM 仍然未验证；接通可信前置总量约束之前，不得以“补凭据重跑”宣称其已可执行。官方完整 runtime/真实客户端/真实付费模型的独立验收须单独披露，禁止用本目录测试替代。
