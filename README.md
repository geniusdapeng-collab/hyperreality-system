<div align="center">

# 视频经理 · VideoManager

**AI视频制作智能经营系统 —— 人与 AI 协作的视频内容经营 Workspace**

SuperMickey 制片能力 × WorkLoom 企业级 Agent IM 底座

[![License](https://img.shields.io/badge/license-Apache--2.0-9A7B2D)](LICENSE)

</div>

---

## 这是什么

「视频经理」把 [SuperMickey](https://github.com/geniusdapeng-collab/super-mickey)（生产级 AI 视频生成系统）的完整制作能力，拆解为 **25 个数码员工 + 230+ 技能 + 10 道审批门**，融合进 [WorkLoom](https://github.com/geniusdapeng-collab/workloom-im) 的人机协作 IM 底座，覆盖视频内容经营的完整链路：

```
【前期】市场调研/数据挖掘 →【制作】情报→策划→PRD→剧本→分镜→提示词→定妆照→渲染→后期
      →【经营】素材/成片 CMS → 全平台发布 → 数据监控 → 评论回复 → 经营战报
```

人只做三件事：**供给**（目标/素材/预算）、**裁决**（审批点拍板）、**沉淀**（SOP 固化为技能）。

## 核心概念

| 概念 | 说明 |
|---|---|
| **25 个数码员工** | 制作班组 21（总导演/情报五站/创意策划/策略分析/制片/剧本/场景/片头/视觉/音频/导演评审/提示词/质检/定妆照/微动作/渲染/剪辑）+ 经营班组 4（调研员/发布专员/数据看板官/评论区运营），与人类员工同通讯录（`bundles/ai-video/presets/`） |
| **10 道审批门（G1-G10）** | 情报档案/创意主题/需求清单/PRD/定妆照/提示词/预生产终验/渲染提交/公网发布/评论回复——全部是 IM 原生审批卡，批准手势落事件库（`bundles/ai-video/fences/`） |
| **渲染脚本 CMS** | 镜头提示词 → 逐镜渲染脚本（MD）：版本链管理、工作台 MD 展示与本地编辑、手动单镜渲染 / 批量提交 Seedance / 全自动连锁（渲染→后期→发布→监控）（`packages/base/asset-cms`） |
| **全平台 RPA 发布** | 电脑模拟人工上传：抖音/小红书/B站/YouTube 参考适配器 + TikTok/视频号接口预留；人工节奏、单账号日上限、失败转人工（`packages/base/publish-rpa`） |
| **7×24 经营值守** | 每 2h 数据采集、早八点战报、每 30min 评论采集与三级分流（夸赞自动回/咨询审批/危机告警）（`packages/base/social-listening` + night-shift） |
| **五元事件留痕** | 每个镜头、每次审批、每次发布、每条回复都是 append-only + 哈希链事件，可追责可验链（workdata） |

## 仓库结构

```
apps/            舰桥 Web / server（含 video/ 视频域路由）/ site / desktop
packages/
  base/          底座 14 包（原 11 + asset-cms / publish-rpa / social-listening）
  video-studio/  ★ SuperMickey 引擎 ↔ 底座适配层（确认门桥/LLM 适配/渲染脚本生成）
  shared db runtime
bundles/
  ai-video/      ★ 视频行业 Bundle：25 preset + 围栏 + 3 管线 + 8 技能 + 235 文件技能库
  hotel/         底座原演示 Bundle（保留作模板）
vendor/
  dsh dsh-im     Agent 运行时（底座原样）
  supermickey/   ★ SuperMickey 活体制作引擎（hyperreality-system 全量入驻）
docs/            拆解台账 / 融合设计 / 原底座文档
scripts/         seed-video（视频版种子）等
```

## 快速开始

```bash
corepack enable && pnpm install && cp .env.example .env
# 准备 PostgreSQL 17 + pgvector 后：
pnpm db:migrate && pnpm db:seed        # 底座演示（酒店 Bundle）
pnpm db:seed:video                     # 视频经理演示种子（25 员工 + G1-G10 围栏 + 演示项目）
pnpm typecheck && pnpm test
pnpm dev                               # server(:8787) + web(:5173)
```

制作链路运行需配置 LLM（`LLM_BASE_URL/LLM_API_KEY/LLM_MODEL`，任意 OpenAI 兼容端点）；渲染需 `VOLCENGINE_ARK_API_KEY`（缺省时 render.submit 走 mock 并明确标注）。

## 关键文档

- [SuperMickey 全量拆解台账](docs/supermickey-decomposition-map.md) —— 884 文件逐区登记、21 员工映射、闸机/规范/废弃清单
- [融合设计](docs/fusion-design.md) —— 25 员工编制、10 审批门、Quest 管线、数据模型、渲染脚本 CMS、RPA 发布
- [原底座文档（WorkLoom）](docs/workloom-base-README.md)

## 许可证

Apache-2.0（继承 WorkLoom 底座；vendor/dsh 与 vendor/dsh-im 为 MIT）。SuperMickey 制作能力经作者授权融合。
