# 硬编码排查报告（hyperreality-system / WorkLoom 社媒营销版）

> 排查日期：2026-08-29 · 方法：六类维度自动扫描（`scripts/hardcode-scan.mjs`）→ 白名单过滤 → 逐条语义复核
> 范围：apps/（server+web+webc）、packages/（base/runtime/shared/db/audit-engine/video-studio）、scripts/、bundles/、.github/
> 结果：候选 976 条 → 白名单豁免 783 条 → 疑似 193 条逐条复核 → **真问题 24 项（已全部修复）+ 测试魔法数 2 处（已按 CAP 模式治理）**
> 本仓特性：由酒店版改造而来，bundles/ 下 ai-video（本行业）与 hotel（合法保留的回归域）并存——
> bundles/hotel 及酒店 C 端回归域（apps/server/src/service、apps/webc、scripts/demo.ts、seed.ts）内酒店词合法；
> 底座包（packages/base、runtime、shared）与 B 端社媒工作台（apps/web）内酒店词=改造残留，全部清除。

## 一、复核结论总表

| 类别 | 疑似数 | 真问题 | 判定 |
|---|---|---|---|
| A 环境配置 | 98 | 0 | 全部为 CI 连接串、本地开发脚本默认值（有 env 兜底）、第三方官方端点（微信/LLM 预设/发布平台上传端点）、dsh-gate 本机配置、oss-components 来源清单——标准实践，豁免 |
| B 身份演示 | 11 | **3** | trpc.ts 演示登录 env 命名对齐电商仓 VITE_DEMO_*（P1）、P7 草稿写死 MEM-V01（P1）、P1 页写死演示身份号码（P1）；demo.ts/release-gate.ts 为演示/门禁脚本豁免 |
| C 密钥凭据 | 0 | 0 | 全仓无明文密钥 |
| D 行业泄漏 | 24 | **16** | 底座 15 项（charter 保底价/occ、inspection 酒店四检命名、night-shift 酒店模板、service-dialog/kb/ticket 酒店词表与部门路由、runtime 云栖竞对卡、注释类）+ apps/web 4 项（Onboarding/P22/P1 注释）——去重后见修复清单 |
| E 规则外溢 | 6 | **2** | charter 自治额度默认值 5000/2000 为酒店时代量级（P1，社媒化）；P21 授权向导同款默认值（P1）；E8.3 校准系数×2 为有注释依据的产品逻辑常量（豁免） |
| F 文案展示 | 54 | **1** | suite.ts NLU 句式夹具残留酒店句式（P1，社媒化）；其余为枚举 key/display.ts 字典本体/「API Key」通用术语（豁免） |

## 二、修复清单（24 项，全部完成）

### 底座包行业词泄漏（D 类，P0/P1）

| # | 级别 | 位置 | 问题 | 修法 |
|---|---|---|---|---|
| 1 | P1 | `packages/base/captain/charter.ts` | 自治默认值酒店口径：`price_band [0.85,1.15]`、`procurement_cap 5000 / campaign_cap 2000`（酒店时代量级）、escalate「修改保底价」、kpi_floor `{ occ: 0.7 }` | 社媒语境重定：报价带 `[0.9,1.2]`（与 seed-video `price_quote_band` 对齐）、`procurement_cap 1000`（素材/渲染采购量级）、`campaign_cap 500`（与 seed-video `boost_budget_per_post` 同源）、escalate「低于底价报价/安全禁区相关」、kpi_floor `{ completion_rate: 0.25 }`（与 seed-video 账号制对齐） |
| 2 | P1 | `packages/base/captain/loop.ts:222` | 决策日记 ExpectedOutcome 写死 `metric: "occ_hold", target: 0.7`（酒店 OCC） | metric 改 `kpi_hold`，target 动态取 `charter.circuit_breaker.kpi_floor` 首项（不新增魔法数） |
| 3 | P2 | `packages/base/captain/decision.ts:181` | 注释「标准带（±15%）」「1.3 倍宽限」与新默认带不符 | 注释精确化（-10%/+20%；下限≈0.77、上限≈1.38） |
| 4 | P1 | `packages/base/inspection/checks.ts` `scan.ts` | `HOTEL_CHECKS` 导出名与「酒店巡检项/默认酒店探针/酒店四检」注释——底座默认检项不应绑行业 | 重命名 `DEFAULT_CHECKS`（同步 scan.ts/inspection.test.ts），注释中性化；检项结构保留（酒店回归域功能依赖，行业包可经 checks 参数覆盖） |
| 5 | P1 | `packages/base/night-shift/candidates.ts` | 夜班例行模板为酒店版（调价复核/差评跟进/夜间对账，R1 涨幅/R2 保底价熔断，preset=reconcile/review/pricing-agent） | 改社媒模板：夜间结算对账（settlement-clerk）/负面评论跟进（metrics-watcher）/次日发布准备（G9 公网发布必审·G9a 新平台首发必审），presetKey 与 bundles/ai-video 夜班型 preset 对齐 |
| 6 | P1 | `packages/base/service-dialog/intents.ts` | M8 规则表内置酒店词（biz_query 房费/房价/房型/大床房/订房，service_request 换床单/续住，kb_qa 早餐/停车/泳池/退房/入住） | 底座表行业中性化；新增 `IntentRuleExtension` 注入参数（ruleBasedIntent/routeIntent 取并集），酒店词移至 apps server 层酒店示例域 `HOTEL_INTENT_EXT` 注入——M8 单表口径不漂移、酒店回归行为逐字节一致 |
| 7 | P1 | `packages/base/service-dialog/dialog.ts` | mock 兜底应答写死「云栖酒店智能客服…住店问题」；bizToolFor 正则含「房费」 | mock 应答中性化（「智能客服…可继续咨询」）；正则去「房费」（「账单」已覆盖该用例） |
| 8 | P1 | `packages/base/service-kb/search.ts` | WEAK_TOKENS 内置酒店弱词（房间/酒店/客房/住客/客人/前台） | 底座弱词表中性化；`scoreChunkFallback` 增第三参 `extraWeakTokens`（取并集），酒店弱词由 apps server 层 kb.ts 注入——酒店域检索打分行为不变 |
| 9 | P1 | `packages/base/service-ticket/constants.ts` | 默认部门路由表酒店口径（delivery→客房部 / other→前台） | 中性化：delivery→配送组 / other→服务台（base 测试原即动态引用 DEFAULT_DEPT_ROUTES；酒店域 apps 层有独立 DEPT_ROUTE 不受影响） |
| 10 | P2 | `packages/base/model-router/router.ts:71` | 注释「酒店演示口径」 | 中性化「演示口径」 |
| 11 | P1 | `packages/base/workdata/recall.ts` | 注释「酒店枚举」×2；MockNlTranslator 正则含「房价」 | 注释中性化；正则「房价→报价」（room_price 对象类型保留，酒店回归域功能依赖） |
| 12 | P2 | `packages/shared/src/enums.ts:86` | 注释「酒店版 7 个 Agent 职业」+ 导出名 `HOTEL_AGENT_KINDS`/`HotelAgentKind`（全仓无消费方） | 重命名 `AGENT_KINDS`/`AgentKind`，注释中性化 |
| 13 | P2 | `packages/shared/src/event-schema.ts:22,33` | 注释「酒店：store/channel/stage」「酒店=房型/房价/渠道/客人」 | 中性化为「行业包定义」示例 |
| 14 | P1 | `packages/runtime/src/tools.ts` | 确定性剧本注释「云栖酒店演示口径」；`competitor.fetch` 返回「西湖云舍酒店」卡；`content.draft` 默认标题「秋日云栖套餐」 | 注释中性化；竞对卡改「竞对A（演示数据卡）」；默认标题「秋日上新套餐」（无任何消费方断言原值） |
| 15 | P2 | `packages/runtime/src/ask.ts:10` | 注释「如酒店的渠道收入/夜班决策包」 | 中性化「如行业包注册的渠道收入/夜班决策包」 |
| 16 | P2 | `packages/base/audit-core/*` | 注释列举具体行业名（D18 纪律） | 已由仓库负责人中性化（本提交一并带上） |

### B 端社媒工作台（apps/web，B/D/E 类）

| # | 级别 | 位置 | 问题 | 修法 |
|---|---|---|---|---|
| 17 | P1 | `apps/web/src/lib/trpc.ts` | 演示登录 env 命名（VITE_WS_SLUG/VITE_MEMBER_NO）与电商仓同款纪律不一致 | 改 `VITE_DEMO_WORKSPACE` / `VITE_DEMO_MEMBER`（保留 video-studio / MEM-V01 默认值兜底） |
| 18 | P1 | `apps/web/src/pages/p7/P7.tsx` | 技能发布草稿 `ownerMemberNo: "MEM-V01"` 写死 ×2 | 默认空，加载时以当前登录身份 `members.me.identity.memberNo` 填充；提交后重置保留当前身份 |
| 19 | P1 | `apps/web/src/pages/p1/P1.tsx` | 上线横幅写死「演示身份 MEM-V01 陈主理」；头注释「F3.5 酒店 6 条」 | 横幅动态显示实际身份 memberNo/name；注释中性化 |
| 20 | P1 | `apps/web/src/pages/onboarding/Onboarding.tsx` | 经营主体 placeholders 酒店口径（如：云栖酒店 / 酒店民宿 / 门店位置、房型规模） | 社媒化（如：星芒好物 / 短视频 MCN·内容工作室·品牌自播 / 主营平台、账号矩阵） |
| 21 | P1 | `apps/web/src/pages/p22/P22.tsx` | 部门过滤/分派写死 `["客服部","工程部","客房部","前厅部"]`；官网源 placeholder `https://hotel.example.com` | 部门集合数据驱动（从工单实际部门聚合）；placeholder 改 `https://www.example.com` |
| 22 | P1 | `apps/web/src/pages/p21/P21.tsx` | 授权向导默认值 `[0.85,1.15]/5000/2000`（酒店时代量级） | 与 charter 新默认对齐：`[0.9,1.2]/1000/500` |

### 测试治理（CAP 模式 + NLU 夹具）

| # | 级别 | 位置 | 问题 | 修法 |
|---|---|---|---|---|
| 23 | 治理 | `packages/base/captain/captain.test.ts` `captain-v2.test.ts` `service-ticket/scenarios.test.ts` | 断言绑死默认值魔法数（5000/2500/3000/2000/4000、occ 0.7、部门名写死）——默认值调整即破 | 引入 `CAP = defaultCharter().autonomy` / `BREAKER = kpi_floor 首项` / `routes = TICKET_KINDS.map(k => DEFAULT_DEPT_ROUTES[k])`，断言全部动态化 |
| 24 | P1 | `scripts/suite.ts`（6 处） | NLU 意图路由夹具残留酒店句式（OCC/入住率/保底价/房价/满房/大床房调价/关房） | 替换为社媒句式（涨粉/播放量/底价报价/流量/过审/种草片报价/视频下架），路由语义不变；另 `SUITE_PORT` 可配（多仓并跑避开 8787 占用） |

## 三、豁免判定摘录（代表性）

- **酒店 C 端回归域**（apps/server/src/service/*、apps/webc、scripts/demo.ts、scripts/seed.ts、e2e 测试）：bundles/hotel 合法保留，release-gate 与 e2e 以云栖酒店工作区为回归域，酒店词为有意设计
- **bundles/ai-video/library** 库布里克《闪灵》系列技能稿中的「酒店」：影视创作素材内容，非改造残留
- **CI 连接串 / 本地开发脚本 / dsh-gate 127.0.0.1:8799**：CI service 与 local-first 架构本机地址，有意设计
- **第三方官方端点**（api.weixin.qq.com、LLM 预设、抖音/B站/小红书/视频号/TikTok/YouTube 发布端点）：产品预设
- **E8.3 校准系数 ×2**：驳回降权的产品逻辑常量，有注释依据
- **F2 枚举 key**（owner/manager/readonly/stable/launch/growth）：代码标识符与 display 字典本体（字典值均已中文化）
- **「API Key」**：行业通用术语（中文化口径中明确保留）
- **scripts/eval/service-c-eval.mjs、release-gate.ts**：评测/门禁脚本，工作区 slug 为幂等键
- **suite.ts 非 NLU 段酒店夹具**（R2 保底价熔断、C 端会话 emoji 等）：酒店回归域功能用例，不动

## 四、验证

- `pnpm -C packages/base typecheck`：绿
- `pnpm -C packages/base test`：**444/444 全绿**（含 captain CAP 动态化断言）
- `pnpm typecheck`：9 包全绿（server/web/webc/shared/base/runtime/db/audit-engine/video-studio）
- `pnpm suite`：**452/452 全绿**（独立 PG 库 `workloom_hyper` 避免共享库冲突；`SUITE_PORT=8899` 避开本机 8787 被其他仓 server 占用——首跑 10 条 H 段失败即该串扰所致，与本次修复无关，独立端口后全绿）

## 五、后续纪律

- `scripts/hardcode-scan.mjs` 已入仓——六类维度一键复扫，可作为 CI 防回归门禁（`node scripts/hardcode-scan.mjs .`）
- 默认值调整时**禁止**在测试中写死具体数值——一律动态引用（CAP 模式）
- 底座新增行业适配一律走注入位（IntentRuleExtension / extraWeakTokens / checks / routes 参数），行业词不得进 packages/base·runtime·shared
- 酒店专属夜班模板/巡检检项的行业包化注入为 D2 后续项（当前酒店回归域走 backlog 动态候选与默认检项，功能不退化）
