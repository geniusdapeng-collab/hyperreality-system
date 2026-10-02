# WorkLoom IM 基座同步

`base-sync` 把 WorkLoom IM 的公共能力安全分发给行业仓，同时保护行业仓自有代码。同步边界的唯一事实源是 `sync/base-scope.json`。

## 三类基座资产

### 根级必备资产

`requiredRootAssets` 无视 `pathPrefix`，始终安装在目标 Git 仓库根目录：

- `WORKLOOM_PRODUCT_CONTEXT.md`：完整覆盖，workloom-im 是唯一受控原文；
- `AGENTS.md`：只替换 `WORKLOOM-CONTEXT:BEGIN/END` 之间的唯一受控区块，标记外的子仓规则原样保留；
- `.github/workflows/base-sync-heartbeat.yml`：从 `sync/heartbeat-template.yml` 逐字节覆盖，模板无仓别占位符，可随 required-only/full 同步自升级；
- `.workloom-base-sync.json`：由引擎生成在 Git 根目录，记录必备资产 SHA-256、真实基座提交与 `pathPrefix`。

因此 Tiger 的公共代码即使位于 `governance/`，上述四个文件仍位于 Tiger 仓库根目录。heartbeat 从根级 state 读取 `pathPrefix`（根仓为 `.`、Tiger 为 `governance`）。引擎兼容读取旧版 `governance/.workloom-base-sync.json`，下一次对齐会把它迁到根目录。

若子仓完全没有 `AGENTS.md`，引擎会生成稳定的通用根级 scaffold：一级标题、共享受控区块和标记外的“本仓专属规则”入口；不会带入 workloom-im 的本仓命令或尾部说明。已知旧版通用 WorkLoom IM 指引只有在完整文件 SHA-256 精确命中 allowlist 时才整文件迁移；未知且无标记的文件保留原文、追加受控区块，并在 report 标记 `manualMigrationRequired`。残缺、重复或乱序标记会 fail closed。

### 公共基座文件

`include` 选中公共包、运行时、`packages/industry-contract` 和共享服务；`exclude`、仓级 `extraExclude`、锚点合并与污染守卫共同保护行业 bundle、种子、页面、迁移链、平台运维代码及行业依赖。

Bundle 装配运行时、组合投影与客群装配加载器属于公共基座，必须随 base-sync 下发；只有依赖基座示例包内容的仓内集成测试保留为基座专属。可分发的组合投影回归测试使用临时 Bundle 夹具，不读取 `ai-pm`、酒店或其他具体行业资产。

`AGENTS.md` 不在普通复制范围内，避免整文件覆盖子仓约定。根级必备资产也不受 `docs/**` 排除或行业 `pathPrefix` 影响。

### 稳定 UI 制品与三端客户端基座

`packages/ui` 是 B 端 PC、B 端移动和 C 端移动三端基础组件、设计令牌、图标与交互原语的唯一源码。`apps/web`、`apps/webb`、`apps/webc` 则是同样属于基座的三端应用基础层，统一承载应用壳、左侧/底部导航、布局、状态接线和客户端 API 契约。两者都不走普通 base-sync：前者以稳定 `@workloom/ui` tarball 上传到同版本 CNB Release，后者由 `sync/client-foundation.mjs` 从同一不可变 `ui-v*` 稳定标签读取。`base-scope.json` 完整排除三个 app 根，防止普通文件同步和客户端基座形成双写通道。

`ui-v*` 只表示共享 UI 与三端客户端基座的稳定版本，不代表任何行业 Bundle 已进入 stable。UI 标签流水线只校验仓内候选 Bundle 的契约、摘要和投影一致性，不读取 Bundle 发布私钥，也不临时生成签名或公钥环。行业 Bundle 的 stable 清单、Ed25519 签名、公钥环和可追溯制品由独立发布生命周期产生；桌面生产构建仍必须消费经过签名的 Bundle。

行业仓的 `.workloom-client-foundation.json` 保存上一稳定版每个受管文件的 SHA-256 与模式。升级先把目标文件和旧来源指纹逐一比较，发现行业仓直接修改、删除或放入非白名单客户端文件即 fail closed，整次计划零写入；不会用“新版看起来更像基座”作为覆盖依据。行业差异只允许放在 Bundle、投影和下列显式扩展路径：

C 端的 `apps/webc/public/service-front.config.json` 是必备受管加载壳，只能指向 `apps/webc/public/industry/service-front.config.json`。后者由当前仓的默认 Bundle 生成，位于行业扩展白名单内，不进入稳定客户端快照；因此新行业自动获得最新版加载能力，但不会继承 WorkLoom IM 的 AI 产品经理品牌、入口或种子文案。

- `apps/*/src/extensions/**`
- `apps/*/src/projections/**`
- `apps/*/src/config/industry/**`
- `apps/*/src/theme/industry/**`
- `apps/*/public/industry/**`

`product.manifest.json` 和 `electron-builder.yml` 是仓根受保护身份资产，永不进入客户端快照；脚手架要求行业仓先显式提供独立 `productId`、非基座 `appId`、端口偏移、仓库名和三个客户端入口，应用前后再逐字节验真。

存量行业仓必须分两阶段迁移：

1. 先补齐独立产品身份；存量仓若已有三端文件，把行业差异迁入 Bundle/投影/配置/extension，再建立可信旧版指纹。缺少任一真实生产入口时，不得声称“三端合规”。
2. 再接收稳定 UI + 三端客户端基座升级 PR。三个客户端必须同时锁定相同精确版本、受管文件指纹零漂移并通过消费门禁，才可进入行业仓验收。

所有行业基座目录还必须固定 `packageManager: pnpm@10.14.0`，在 `pnpm-workspace.yaml` 通过 `onlyBuiltDependencies` 明确允许桌面原生依赖，并提供可直接执行的 `product:verify` 与 `bundle:governance`。治理器只依赖随 base-sync 下发的 `packages/industry-contract`，不得读取未在行业仓保留的 `packages/ui` 源码。

`electron-builder.yml` 与 `product.manifest.json` 是下游部署实例的受保护身份资产。它们显式位于 `exclude`，base-sync 不做整文件复制，也不覆盖 `appId`、`productName`、端口或发布身份。新行业必须从最新版基座模板生成自己的 manifest；存量行业先完成产品身份迁移，再进入第二阶段。

当前 `apps/server/src/industry/**` 明确排除，避免 `apps/server/src/**` 的宽范围把酒店 catalog 等行业语义下发到其他经营体。现有 business registry 适配层仍位于已排除的 `apps/server/src/service/adapters/**`，且实现会引用行业 catalog，因此本版不把它伪装成可自动下发的通用能力。后续须先把“无行业语义的注册接口/运行时”与“各行业 catalog 实现”物理拆分并补兼容测试，再单独扩大同步范围。

## 命令

```bash
# 每次都比较实际文件；即使 state 的 base SHA 相同也会验真
node sync/base-sync.mjs detect --repo /path/to/child

# 对齐并生成一个只含白名单文件与 state 的提交
node sync/base-sync.mjs pull --repo /path/to/child

# 只安装/校验根级上下文，不触碰其他基座或行业代码
node sync/base-sync.mjs pull --repo /path/to/child --required-only

# 特殊接入/稀疏工作树：写文件和 state，但不暂存、不提交、不推送
node sync/base-sync.mjs pull --repo /path/to/child --required-only --no-commit

# 本地测试或固定基座提交，完全绕开远程发现
node sync/base-sync.mjs detect --repo /path/to/child --base-dir /path/to/workloom-im

# 只读生成全部订阅仓计划
node sync/base-sync.mjs push --base . --dry-run

# 只读生成“仅根级必备资产”的全部订阅仓计划
node sync/base-sync.mjs push --base . --dry-run --required-only
```

通用参数：

- `--required-only`：detect/pull/push 只处理根级必备资产与根级 state；
- `--no-commit`：pull 只写不提交，也不会暂存文件；不能与 `--push` 组合；
- `--dry-run`：只计算计划，不写文件/state；
- `--json`：输出机器可读报告；
- `--base-dir`：使用已固定的本地基座 checkout；
- `--extra-exclude a,b`：追加仓级排除规则；
- `--push`：不再允许直接推送 `main`，已拒绝执行（退出 64）；请在任务分支提交并创建 PR。

默认 pull 会自动提交，因此开始前要求目标仓库完全干净；存在任何非本次改动就会在写入前拒绝。必须在有意保留脏工作树时使用 `--no-commit`，随后由操作者人工审查和白名单暂存。引擎只允许显式白名单暂存。`--adopt` 是 `adopt.sh` 的受限内部开关，只能与 `pull --no-commit` 组合：存量治理接入附加 `--required-only`，新行业接入则执行完整公共基座同步。

本地 `--base-dir` 必须是基座 Git 根，且本次会读取的受控源文件必须由当前 HEAD 跟踪并逐字节一致；无关的本地改动不阻塞。远程 clone 固定使用 `main`、`--single-branch`，并验证 `HEAD == refs/heads/main`。来源或目标路径任一段为 symlink（包括 dangling symlink）、越界路径或不规范 `pathPrefix` 都会被拒绝。

## 新行业仓接入

```bash
bash sync/adopt.sh /path/to/new-industry
bash sync/adopt.sh /path/to/workroom-tiger --path-prefix governance/

# 新开行业：先创建独立 product.manifest.json，再一次生成最新版稳定三端
bash sync/adopt.sh /path/to/new-industry --new-industry

# 全流程零写入预演；省略 --version 时只能选择 latestStableVersion
bash sync/adopt.sh /path/to/new-industry --new-industry --dry-run
```

`adopt.sh` 支持普通 clone 和 `.git` 为文件的 linked worktree。执行顺序是：

1. 验证普通 clone/linked worktree、规范化 `pathPrefix`、基座脚本来源、全部路径边界和行业仓预置的产品/工程身份契约；
2. 存量治理接入只安装根级产品上下文、AGENTS 受控块与静态 heartbeat；新行业先对完整同步计划做零写入预检，再安装公共运行时、行业契约与公共服务；两种模式都在写 state 前逐项复验并执行密钥扫描；
3. 若仓库由 workloom-im fork/template 派生，仅在内容与基座逐字节相同时，把父仓专属 `AGENTS.repo.md` 替换为通用待填写 scaffold，并删除父仓专属 `.github/workflows/base-sync-push.yml`；未知或已定制内容绝不覆盖，其他 workflow 不受影响；
4. 写入带 `pathPrefix` 的根级 state，再运行独立 detect 与接入资产密钥扫描；新行业的 state 必须明确证明 `full` 同步，不能用 `required-only` 冒充；
5. `--new-industry` 模式从 `base-capabilities.json.clientFoundation.latestStableVersion` 对应的 `ui-v*` 标签一次安装 PC/B移动/C移动，建立受管文件指纹，锁定同版 `@workloom/ui`，安装生产边界/消费门禁与 CI 工作流，并在结束前复验完整接入契约。候选版、未发布版、版本错位、缺工程依赖和基座默认产品身份全部阻断。

新行业第一次写入前会创建跨阶段事务快照，覆盖 Git index、原有 staged/unstaged/untracked 文件、full/UI/client/governance state、工作流与 lockfile；任一安装或最终 verifier 失败都会恢复接入前状态。多文件治理安装器自身也采用局部事务，所有目标路径拒绝 symlink（含仓外逃逸）。为避免 `pnpm` 改写无法逐字节快照的已有依赖树，`--new-industry` 要求行业基座目录下所有层级均不存在 `node_modules`；这是新仓一次接入的 fail-close 前置条件，存量仓升级流程不受此约束。

脚本不暂存、不提交、不推送，也不把缺少 `apps/webb` 的二端仓登记成三端产品。新行业模式在任何写入前依次完成工程契约、完整基座计划和客户端基座 dry-run；存量治理接入仍只安装根资产。审查公共基座、根级接入资产、三端基座 state 和可选的两项精确派生迁移后，由操作者白名单提交，再把新仓登记进 `sync/child-repos.json`。

## 存量八仓按波次升级

`sync/ui-upgrade-pr.mjs --rollout` 每次都先要求执行提交固定在同版本 `ui-v*` 标签，以 npm 11.6.2 / pnpm 10.14.0 从标签隔离生成本地 `npm pack`，再把本地 tarball 的 sha512、`base-capabilities.json` 对应版本的 SRI 登记、同标签 CNB Release 的真实下载字节做三方比较；只确认版本号、URL 可访问或资产名相同都不授予 rollout 权限。完整性一致后才加载客户端基座，并只在临时 clone 中做指纹升级、lockfile 更新和消费门禁。验证通过才推送 `chore/workloom-ui-v<版本>` 独立分支并创建 PR，永不直推 `main`。W1 → W5 顺序是可执行门禁；更晚波次不能越过未完成前序。dry-run 同样执行制品完整性核验，并在临时 clone 中运行真实迁移和门禁，但不写远端仓、分支或 PR。

pnpm 10.14 对 URL tarball 生成的 lockfile 只登记 `resolution.tarball`，默认不写 `resolution.integrity`；因此仅把 SHA-512 放在 `.workloom-ui.json` 并不能让包管理器校验下载字节。新行业接入和存量 rollout 都必须先执行 `install --lockfile-only`，再由零外部依赖的 `sync/ui-lockfile-integrity.mjs` 校验 stable state、canonical Release URL、根 override、固定三端 importer 与唯一 packages 记录，并原子注入 state 的 SHA-512；随后才执行 `install --frozen-lockfile`。安装完成后的 consumer verifier 使用固定 `yaml-governance=npm:yaml@2.9.0` 再做完整 YAML 语义复验。缺摘要、摘要不一致、同 URL 异字节、重复 UI 记录或任一端未绑定都必须 fail closed。

每个脚手架/升级 PR 还安装 `scripts/verify-client-foundation-consumer.mjs` 与 `workloom-ui-contract` 工作流。后续任何 PR 或 main 推送都会重新计算全部受管摘要、三端入口、UI 同版关系与扩展白名单；不是只在中央 rollout 当时检查一次。

没有 `.workloom-client-foundation.json` 的存量仓不会被猜测覆盖：与目标稳定标签逐字节相同的文件可建立初始指纹；任何不同内容都以 `UNTRACKED_MANAGED_FILE` 阻断，要求人工先把合法行业差异迁入白名单扩展路径。已登记 state 后，`MANAGED_FILE_MODIFIED`、`MANAGED_FILE_DELETED`、非法客户端路径同样阻断整个 PR。

## 自动化与凭据（当前 CNB 通道）

当前有效执行器是 `.cnb.yml`：每 30 分钟调用 `fanout-cnb.mjs` 与 `merge-sync-prs.mjs`，新仓扫描与 OSS 扫描按该文件的 crontab。`.github/workflows/*` 留作历史模板和部分发布策略校验源，文件存在不代表 GitHub 通道仍在运行。

- `@workloom/ui` 以同版本 CNB Release 的不可变 tarball 分发；rollout 对本地 pack、登记 SRI 和下载字节做三方比较。下载失败、同版本异内容或散列不匹配即阻断。
- `fanout-cnb.mjs` 先固定基座 commit，逐仓生成同步分支和 PR；公共机制、行业资产与隔离副本边界由 `base-scope.json` 和 `child-repos.json` 执行。
- `merge-sync-prs.mjs` 在合并前重新回读 source/base HEAD、完整路径、risk 标签、平台 mergeable 状态及非空状态检查。治理文件不进入无人值守合并白名单，必须获得当前任务的明确审查授权；普通 PR 仍受平台评审规则约束。
- 根级 `base-sync.mjs pull --push` 和非 dry-run 的 `push` 模式已 fail-closed；所有远端落地都走任务分支和 PR，门禁全绿后串行合并，合后回读。
- 同步计划、污染检查、只含白名单的暂存、秘密扫描和事务回滚仍由引擎执行；`--no-commit` 只把审查结果留在本地。
- 凭据只进入需要认证的进程环境：限定 `https://cnb.cool/` 的一次性 HTTP header，不写 remote URL、Git config、脚本、日志或 PR。只读公开 GitHub 上游保持匿名。成功、失败及 dry-run 都清理临时 clone。
- 纳管工具必须回读 main 的 PR、状态检查、评审及管理员推送/强推/删除限制，命名为 main 的空壳规则不算保护。缺隔离登记、协议资产或可识别 CI 即拒绝纳管。

个人访问令牌可按 `AGENTS.md` §7 在当前任务授权内一次性使用。平台是否已应用强保护必须以 API 回读为准，源码中的默认 payload 不能替代平台状态。

## 状态与验真语义

根级 `.workloom-base-sync.json` 包含：

- `lastSyncedBaseSha`：最近一次完整基座同步提交；
- `lastRequiredAssetsBaseSha`：最近一次根级必备资产来源提交；
- `requiredRootAssetsSha256`：完整上下文、静态 heartbeat 及 AGENTS 受控区块的独立哈希；
- `pathPrefix`：行业基座在仓内的规范相对路径（根目录记为 `.`）；
- `lastSyncMode`、`lastSyncAt`、`filesTouched` 和仓级排除项。

state 只用于审计和加速理解，不是“已对齐”的证明。`detect` 总会重新读取基座与目标文件；SHA 相同但上下文缺失、被改写或标记异常仍会返回退出码 `2`。反过来，内容已一致但根级 state 缺失或过期也会以独立的 `stateDrift` 返回退出码 `2`，从而触发一次 state-only pull。标记缺失时可安全追加，标记残缺、重复或顺序错误时 fail closed，等待人工修复。

客户端目录另有 `.workloom-client-foundation.json`，记录稳定版本、标签、不可变提交、三端映射、行业扩展白名单和逐文件 SHA-256。该 state 同样不是自我证明：`inspect` 会重新读取每个受管文件并检查额外路径；升级会同时用旧 state 和新稳定标签做双向验真。

## 提交与失败边界

- 同步计划在落盘前完成污染黑名单和单次文件数检查；
- 内容安装后再次计算计划，确认零漂移后才写 state；
- 锚点合并后的 lockfile 只用 `pnpm install --lockfile-only --ignore-scripts` 刷新，失败即关闭；
- 自动提交只暂存计划内文件、新产生的 lockfile 和根级 state，并在 state 落盘前后分别调用基座 HEAD 中受控的密钥扫描器检查 staged 白名单；
- `--no-commit` 也会扫描本次写入资产与待写 state；扫描、lockfile、安装复验或提交前任一环节失败，事务会恢复文件和 index 到同步前状态；
- required assets 无法验证、AGENTS 标记异常、目标工作树不干净或认证失败时立即停止；
- 错误文本会移除已知 token、GitHub token 形态、认证 header 载荷和 URL userinfo。

## 测试

```bash
node --test sync/base-sync.test.mjs sync/client-foundation.test.mjs sync/set-ui-version.test.mjs sync/ui-upgrade-pr.test.mjs
bash -n sync/adopt.sh
node --check sync/base-sync.mjs
node --check sync/client-foundation.mjs
node --check sync/ui-lockfile-integrity.mjs
```

测试覆盖 AGENTS 三态迁移与 report、同 SHA 文件验真、Tiger 根级落点、旧 state 迁移、静态 heartbeat 自升级、来源 HEAD 约束、白名单提交、脏树拒绝、`--required-only --no-commit`、required-only dry-run 与禁止直推 main、lockfile/密钥扫描事务回滚、凭据脱敏、源/目标/dangling/pathPrefix symlink 对抗、相对依赖闭包与子仓依赖缝、临时 clone 全路径清理、linked worktree 跨仓前缀接入、父仓专属文件的精确派生清理，以及最小新行业 full 接入、三端 scaffold、latest-stable-only、稳定标签取源、dry-run、更新/新增/删除、旧摘要冲突关闭、扩展路径白名单和产品身份保护。
