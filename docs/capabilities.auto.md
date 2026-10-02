# hyperreality · 能力导览（人类版）

> 视频经理 · AI视频制作智能经营系统（SuperMickey 制作能力 × WorkLoom 人机协作底座）
> 本文件由 `node scripts/generate-capabilities.mjs` 从代码事实**自动生成**（2026-10-02），
> 请勿手改——能力变更后重跑生成器即可。Agent 版机器清单见 docs/capability-map.md。
> 目录可发现、实际能调用、结果已验证是三个不同字段。缺少同提交运行证据时，调用与结果一律显示“未验证”；演示入口不代表客户业务可用。

## 🚀 5 分钟体验路径

```bash
pnpm install && pnpm preview:all
```

| 端 | 地址 | 看什么 |
|---|---|---|
| 🖥 PC · B 端工作台 | http://localhost:3000 | 经营主页全员就位、晨报、待审批、一句话目标输入 |
| 📱 B 端移动 | http://localhost:3001 | 演示导航页 → 任选高保真页「手机壳」预览 |
| 📱 C 端 AI 服务前台 | http://localhost:3002 | 免登对话：查订单/售后/物流/常见问题 |

体验路径使用模拟种子与离线模型；依赖和数据库准备见 mock/README.md，连接真实业务前需另做环境与结果验收。

## 📦 能力总览（38 项）

### 🖥 三端应用入口

| 能力 | 一句话 | 怎么体验 | 可发现 | 可调用 | 结果已验证 / 环境 |
|---|---|---|---|---|---|
| **PC 端 · B 端工作台** | 经营主页/任务中心/规则中心/装配中心，目录描述不代表运行通过 | `pnpm preview:all` → http://localhost:3000 | 是 | 未验证 | 未验证 |
| **移动端 · B 端高保真** | 6 页演示资产；运行状态须验收 | `pnpm preview:all` → http://localhost:3001 | 是 | 未验证 | 未验证 |
| **移动端 · C 端 AI 服务前台** | 对话/服务/工单/消息入口；目录存在不代表已验证 | `pnpm preview:all` → http://localhost:3002 | 是 | 未验证 | 未验证 |

### 🏨 行业 Bundle（垂直能力包）

| 能力 | 一句话 | 怎么体验 | 可发现 | 可调用 | 结果已验证 / 环境 |
|---|---|---|---|---|---|
| **bundles/ai-pm/** | 围栏/技能/员工/对象/管线定义；装配结果需按环境验证 | 见 bundles/ai-pm/ 目录 | 是 | 未验证 | 未验证 |
| **bundles/ai-video/** | 围栏/技能/员工/对象/管线定义；装配结果需按环境验证 | 见 bundles/ai-video/ 目录 | 是 | 未验证 | 未验证 |
| **bundles/hotel/** | 围栏/技能/员工/对象/管线定义；装配结果需按环境验证 | 见 bundles/hotel/ 目录 | 是 | 未验证 | 未验证 |

### 🧑‍💼 数字员工与数字人（本仓自带）

| 能力 | 一句话 | 怎么体验 | 可发现 | 可调用 | 结果已验证 / 环境 |
|---|---|---|---|---|---|
| **数字员工中心（`/agents`）** | 人机混编通讯录：员工档案 / 围栏绑定 / 30 天战绩 / 段位 / 派遣 / 夜班 22:00-08:00 自动上线 | `pnpm preview:all` → http://localhost:3000/agents | 是 | 未验证 | 未验证 |
| **织伴数字人（Live2D 常驻浮层）** | 全页面常驻数字人：语音播报 + 口型/表情/动作 + 三态（小角落 / 大形象 / 屏保）+ 记忆透明面板 | 打开任一 PC 页面右下角；`pnpm preview:all` | 是 | 未验证 | 未验证 |
| **语音与口型引擎** | TTS 音色映射 + 中文逐字开口度时间线 + 音频振幅驱动口型；人设/音色可切换 | docs/voice-and-avatar-delivery-contract.md | 是 | 未验证 | 未验证 |
| **Live2D 渲染后端与资产** | pixi-live2d-display + Cubism core（MIT/官方 SDK）；换形象=换模型文件，驱动链路零改动 | apps/web/public/live2d/ | 是 | 未验证 | 未验证 |

### 🖐 操作电脑能力（本仓自带 · 可装生产工作站）

| 能力 | 一句话 | 怎么体验 | 可发现 | 可调用 | 结果已验证 / 环境 |
|---|---|---|---|---|---|
| **computer-use 三层感知入口** | 浏览器 DOM / GUI 语义树 / 像素兜底；安装、权限及运行结果须预检 | `pnpm computer:preflight && pnpm computer:smoke` | 是 | 未验证 | 未验证 |
| **HTTP 远程驱动 + MCP server** | 大脑/手分离：专用工作站被云端 Agent/CI 远程驱动（docs/computer-use-production.md） | `pnpm computer:serve` / `pnpm computer:mcp` | 是 | 未验证 | 未验证 |

### 🤖 AI 自动化引擎（系统内置能力）

| 能力 | 一句话 | 怎么体验 | 可发现 | 可调用 | 结果已验证 / 环境 |
|---|---|---|---|---|---|
| **围栏 DSL 引擎** | 事前裁决：支持 in/contains_any 列表语义 | 见 docs/capability-map.md L3 | 是 | 未验证 | 未验证 |
| **技能保鲜环（下行分发）** | 官方技能一键投放：五道预检 + L0/L1 静默/L2 审批 + 一键回滚 + 全事件留痕 | 见 docs/capability-map.md L3 | 是 | 未验证 | 未验证 |
| **L2 编排（ASK/QUEST）** | 一句话目标自动拆解多步骤并派发 | 见 docs/capability-map.md L3 | 是 | 未验证 | 未验证 |
| **夜班自动运行** | 离线任务推进，次日晨报 | 见 docs/capability-map.md L3 | 是 | 未验证 | 未验证 |
| **模型路由** | 离线确定性模型，无密钥可跑 | 见 docs/capability-map.md L3 | 是 | 未验证 | 未验证 |
| **全平台 RPA 发布** | 抖音/小红书/B站/YouTube，BrowserDriver 注入接真浏览器 | 见 docs/capability-map.md L3 | 是 | 未验证 | 未验证 |
| **五元事件 + RLS 隔离** | 全链路可追溯、可验链 | 见 docs/capability-map.md L3 | 是 | 未验证 | 未验证 |
| **IM 渠道** | 企微等出入站，审批卡片直达手机 | 见 docs/capability-map.md L3 | 是 | 未验证 | 未验证 |
| **C 端 AI 服务前台** | 对话/知识库 385 问/工单/SLA | 见 docs/capability-map.md L3 | 是 | 未验证 | 未验证 |
| **自动巡检** | 异常发现→派发→处置闭环 | 见 docs/capability-map.md L3 | 是 | 未验证 | 未验证 |
| **人审台** | 必审事项人拍板，AI 不越权 | 见 docs/capability-map.md L3 | 是 | 未验证 | 未验证 |
| **资产管理** | 素材/成片全生命周期 | 见 docs/capability-map.md L3 | 是 | 未验证 | 未验证 |
| **成本台账** | 每次模型调用可计量 | 见 docs/capability-map.md L3 | 是 | 未验证 | 未验证 |
| **交易流** | 商机到成交全链路 | 见 docs/capability-map.md L3 | 是 | 未验证 | 未验证 |
| **社媒监听** | 评论/询盘意图雷达 | 见 docs/capability-map.md L3 | 是 | 未验证 | 未验证 |

### ✅ 验证与质量（工程纪律）

| 能力 | 一句话 | 怎么体验 | 可发现 | 可调用 | 结果已验证 / 环境 |
|---|---|---|---|---|---|
| **一键安装（bootstrap）** | 环境/依赖/PG/迁移种子/可选桌面栈初始化入口；结果以预检和执行回执为准 | `pnpm setup` | 是 | 未验证 | 未验证 |
| **主测试套件** | 数百条场景用例逐条执行 | `pnpm suite` | 是 | 未验证 | 未验证 |
| **发布门禁** | 未全过禁止发布（硬性） | `pnpm release:gate` | 是 | 未验证 | 未验证 |
| **五元事件验链** | 事件链完整性校验 | `pnpm db:verify-chain` | 是 | 未验证 | 未验证 |
| **Agent 能力巡游** | 遍历登记能力的检查入口；覆盖与结果看本轮报告 | `pnpm agent:tour` | 是 | 未验证 | 未验证 |
| **环境自检** | 一屏排查环境问题 | `pnpm doctor` | 是 | 未验证 | 未验证 |

### 🎁 演示与交付资产

| 能力 | 一句话 | 怎么体验 | 可发现 | 可调用 | 结果已验证 / 环境 |
|---|---|---|---|---|---|
| **高保真演示页 ×6** | 糖果色，含手机壳容器 | http://localhost:3001 | 是 | 未验证 | 未验证 |
| **官网静态站** | 对外产品故事 | apps/site/index.html | 是 | 未验证 | 未验证 |
| **自带技能 ×8** | client-demo-recorder / component-integration / cross-platform-review / deal-flow 等 | skills/official/ | 是 | 未验证 | 未验证 |
| **能力导览 PPT** | 路演/汇报直接用 | docs/capability-tour.pptx | 是 | 未验证 | 未验证 |
| **Mock 数据体系** | 种子 + 离线模型 + 演示直登；显式模拟环境 | mock/README.md | 是 | 未验证 | 未验证 |

## 🧭 下一步

- 想二次开发：读 AGENTS.md → 跑 `pnpm agent:tour` → 看 docs/capability-map.md（全量机器清单）
- 想改 UI：必须遵守 docs/design-system.md（Candy Design System），改完用浏览器能力截图核对
- 想发布：`pnpm release:gate` 全过是硬性门禁，清单见 docs/release-checklist.md
