# 织球 LoomBall · 上游署名与边界声明

本目录包含 **grok-ball**（作者 tycoding，MIT 协议）的代码，用于 WorkLoom 客户端的
「织球 LoomBall」AI 班组状态表情球。上游源码与来源：

- 仓库：https://github.com/tycoding/grok-ball
- 锁定提交：见同目录 `PINNED`
- 许可证：MIT（原文见同目录 `LICENSE`，保留原版权声明）

## 名称与关联声明

产品内名称统一为 **「织球 LoomBall」**（班组状态表情球）。组件名、界面文案、日志与文档不使用
上游项目名；「Grok」是 xAI 的商标，本集成与 xAI / Grok 无任何关联，也不使用其视觉识别
（默认皮肤为 WorkLoom navy/gold 品牌色）。

## 本地改动边界（与上游的差异，逐条）

1. **未改动上游源码**：`grok-ball.js`、`grok-ball.ts`、`LICENSE` 与上游逐字节一致；本仓的集成能力
   全部写在 `apps/web/src/components/loomball/**` 与本目录的 `index.ts`（适配层）里。
2. **全局门面收敛**：上游脚本同时暴露 `window.EmotionBall`（真实引擎）与 `window.GrokBall`
   （兼容门面）。本仓在 `index.ts` 捕获 `window.GrokBall` 后立即 `delete`，只保留引擎真实名，
   避免上游商标名成为产品全局标识。
3. **品牌皮肤与自定义表情**：默认皮肤 `#1B2A4E` + `#C9A227`；新增工作状态表情 `50/51/52`
   通过上游公开 API `config.register()` 注册（不修改上游种子表）。

## 升级纪律

升级上游 = 更新 `grok-ball.js` / `grok-ball.ts` / `PINNED` + 重跑
`apps/web/src/components/loomball/*.test.ts` 与真机巡展走查（见 `docs/loomball.md`）。
禁止只改 `PINNED` 不换源码，或在上游文件里夹带本地补丁。
