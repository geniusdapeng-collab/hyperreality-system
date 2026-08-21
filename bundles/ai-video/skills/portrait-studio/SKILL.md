---
name: portrait-studio
description: 定妆照纪律官方套件（随 bundles/ai-video 分发，F8.1 官方套件级）：lead 8 角度/supporting 4/prop 三档、studio/uploaded/text 三模式、真实参考图纪律、PortraitGuard 无定妆照禁渲染。安装后被打定妆照美术指导调用；绑定围栏 G5，卸载即撤销（F8.2/L8.3）。
---

# 定妆照纪律

## 适用场景
- 角色/商品定妆照制作与确认（G5 确认门）
- 渲染脚本定妆照绑定（binding-manifest）前置

## 方法
1. 三档覆盖：主角 8 角度 / 配角 4 角度 / 道具定妆照，角度清单先行（portrait.plan）。
2. 三模式解析：studio（棚拍生成）/uploaded（用户上传）/text（文本描述），逐张 refimage.verify 核验。
3. 真实参考图纪律：商品定妆照必须基于档案评分过线的真实商品图，禁止虚构外观；与档案 confirmed 外观字段矛盾即打回重制。
4. PortraitGuard 硬闸：无定妆照绑定禁止提交渲染。

## 输出契约
- 输出：定妆照集（角度清单 + 逐张来源模式 + 核验结果 + 入库版本）。
- 定妆照集入库即触发 G5 确认，未确认不得绑定渲染脚本。
- 无工具回执的关键数字标「未核实」，不得宣称完成（L3.6/E3.7）。
