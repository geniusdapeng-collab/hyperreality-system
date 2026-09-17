# 视频经理 · 行业配置层 v2 一页速查

> 范围：`bundles/ai-video/`（presets/fences/schemas/pipelines）+ `skills/official/` 新增技能。
> v2 变更：经营班组 4 → 12 员；围栏 15 → 21 条；对象 18 → 30 类；管线 3 → 5 条；宪章三变体（账号制默认 + 项目制/合同制模板）。

## 一、33 员编制表（制作 21 + 经营 12）

### 制作班组（21，原有）

| 分组 | preset |
|---|---|
| 情报五站 + 装订 | intel-collector / intel-reviewer / intel-competitor / intel-verifier / intel-binder |
| 创意与需求 | creative-planner / insight-analyst / prd-specialist |
| 预生产 | scriptwriter / scene-designer / opening-designer / visual-director / micromotion-stylist / prompt-fuser / continuity-reviewer / portrait-artist |
| 渲染与后期 | render-operator（G8）/ post-editor / audio-designer |
| 指挥 | director（G1-G9 各确认门 owner） |

### 经营班组（12 = 原有 4 + 新增 8）

| preset | 名称 | 围栏 | 要点 |
|---|---|---|---|
| metrics-watcher | 数据看板官（原有） | — | 阈值告警 / 早八点战报，夜班 |
| comment-operator | 评论区运营（原有） | G10 | 三级分流：夸赞 auto/咨询 review/负面 review+告警/敏感 block |
| publish-operator | 发布专员（原有） | G9 | 公网发布必审 |
| trend-researcher | 趋势研究员（原有） | — | 趋势/竞品/爆款扫描 |
| **deal-manager** | 商单经理 | G15 | 线索捕获→报价带锚定→履约五节点→账期催款→48h 结案报告 |
| **ads-optimizer** | 投放优化师 | G12 | 阈值告警+调价建议；加投必审不可降级；素材淘汰清单 |
| **distribution-operator** | 多平台分发专员 | G9 | 一片多发 platform_variant，内容日历错峰，防关联（G16） |
| **review-analyst** | 复盘分析师 | — | 跨平台口径对齐→Top/Flop 双向归因→可执行结论（只读） |
| **creator-partner** | 达人合作专员 | G15 | 达人筛选/建联/Brief/验收/效果回填 creator_collab |
| **settlement-clerk** | 分账对账员 | G13 | 抓账→合同拆分→差异标红→超 ±10% 告警；比例公开基数不公开 |
| **compliance-officer** | 合规审核员 | G14 | 发布前三级预检；送审规则库；驳回学习回写 |
| **ip-curator** | 版权管理员 | — | 授权台账/到期预警/使用范围校验/侵权巡查 |

## 二、21 条基线围栏（ai-video-baseline/v2，is_baseline 只紧不松）

| 规则 | 级别 | 对象/动作 | 要点 |
|---|---|---|---|
| G1 | review | dossier.confirm | 情报档案确认必审（无源不入库） |
| G2 | review | theme.confirm | 创意主题/Brief 必审 |
| G3 | review | insight.confirm | 对齐清单必审（阈值 0.7 前置） |
| G4 | review | prd.confirm | PRD 必审（时长唯一权威源） |
| G5 | review | portrait.confirm | 定妆照确认（可配 auto） |
| G6 | review | prompt.confirm | 提示词审核（25/30 字段 + 字符口径前置） |
| G7 | review | preproduction.finalize | 预生产最终确认 |
| G8 | review | render.submit | 渲染提交必审（可降 auto） |
| G9 | review | publish.execute | 公网发布必审 |
| G9a | review | publish.execute | 新平台首发必审（与 G9 并集取严） |
| G9b | block | publish.execute | 单账号日发布 ≥5 熔断 |
| G10a-d | auto/review/block | comment.reply | 评论三级分流 + 敏感 block |
| **G11** | review | budget_ledger · render.submit | 单项目算力超预算自动暂停提交（可升 block） |
| **G12** | review | ads_campaign · ads.boost | 投放加投必审，涉预算不可降级 |
| **G13** | auto | settlement_statement · settlement.reconcile | 分账差异超 ±10% 告警不阻断 |
| **G14** | block | review_submission · review.submit | 未过三级预检禁止送审 |
| **G15** | review | deal_order · deal.send_external | 报价/合同/结案报告对外必审 |
| **G16** | block | account_metric · account.login/session_bind | 矩阵账号异常登录与防关联违规阻断 |

## 三、30 对象图谱（schemas/objects.json v2）

- **制作链（14）**：dossier → theme → insight → prd → script_blueprint → scene_card → shot_card → prompt_package → portrait_set → render_script → render_job → video_asset → final_video → video_project
- **发布与经营（4）**：publish_task → account_metric / comment / comment_reply
- **经营扩展 v2（12）**：topic_card · content_calendar · platform_variant · deal_order · deal_milestone · settlement_statement · ads_campaign · ads_creative · creator_collab · ip_asset · review_submission · budget_ledger

## 四、5 条管线

| 管线 | 说明 |
|---|---|
| narrative-film | 叙事片全流程（制作链主干，含 G2-G8 门） |
| marketing-film | 营销片：情报五站前置 + 叙事片后半段同构 + 发布监控 |
| account-ops | 7×24 账号经营：采集/告警/战报 + G10 评论分流 |
| **ads-creative-factory** | 投流素材工厂：成片→二剪钩子变体→预检入库→投放数据绑定→淘汰清单（G12） |
| **settlement-recon** | 分账对账：抓账→合同拆分→差异标红→G13 告警→月结入 budget_ledger |

## 五、宪章三变体（seed-video.ts · profiles.archive）

| 变体 | autonomy | kpi_floor |
|---|---|---|
| 账号制（默认） | publish_per_day_cap 3 / boost_budget_per_post 500 / price_quote_band [0.9,1.2] / reply_auto_scope 夸赞·感谢 | completion_rate 0.25 / follower_growth_7d -0.02 |
| 项目制 | render_budget_per_episode 300 / render_retry_cap 5 | roi_iaa 0.98 / scrap_rate 0.85 |
| 合同制 | publish_per_day_cap 2 / content_reject_rounds_cap 3 / response_time_slo_hours 4 | sla_hit_rate 0.9 |

grant 六步授权结构（披露→条款→影子期→试用→留任/降档）三变体共用不变。

## 六、新增官方技能（skills/official/）

- **deal-flow**：商单全流程 SOP（G15 联动）
- **cross-platform-review**：跨平台统一复盘（周节奏固定产出）
- **ripping-reverse**：拉片反推 v2，18 维拆解→分镜+提示词包，产物受 G2/G6 必审约束
