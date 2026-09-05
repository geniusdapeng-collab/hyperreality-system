# 织伴数字人 · 渲染后端与资产登记

> 2026-09-05 定稿：主后端 **Live2D**（风格化 2D，绕开写实 3D 恐怖谷）；TalkingHead 3D 后端保留为备选（`MateDigitalHuman.tsx` 不删除、不引用）。

## 主后端：Live2D（pixi-live2d-display）

| 项 | 内容 |
|---|---|
| 渲染插件 | `pixi-live2d-display@0.4.x`（npm，MIT，guansss 生态——Live2D Web 渲染事实标准） |
| 渲染器 | `pixi.js@6.5.x`（npm，MIT） |
| Cubism 2.1 core | `public/live2d/live2d.min.js`（129KB，Live2D 官方 SDK） |
| Cubism 4 core | `public/live2d/live2dcubismcore.min.js`（207KB，Live2D 官方 SDK——插件两个 factory 都检查 runtime，缺一不可，缺则整包报错） |
| 加载纪律 | 插件在模块求值时即检查 `window.Live2D`——**必须动态 import**（静态 import 整包白屏，已踩过） |
| 模型（现行） | `public/live2d/shizuku/`（5.6MB，Cubism 2.1，guansss/pixi-live2d-display 官方示例模型） |
| 模型许可 | **Live2D Free Material License——可商用**（区别于此前 RPM/VRoid 的非商用演示许可） |
| 模型风格说明 | shizuku 为黑发校服少女系（演示期选型）；生产建议按行业定制正装/职业风 Live2D 模型（`modelUrl` 配置即换，管线零改动） |

## 驱动四要素（与 TalkingHead 版同口径）

- **口型**：VoiceEngine.onLipSync（boundary + 原文透传）→ 中文逐字韵母开口度映射 → `PARAM_MOUTH_OPEN_Y` 直写（130ms 闭口包络）；音频文件走 `speakWithAudio`（AnalyserNode RMS 振幅驱动）
- **表情**：mood → Live2D expression（f01 微笑 / f02 羞涩 / f03 认真 / f04 星星眼·紧张）
- **动作**：gesture → motion tap_body（招呼）；idle 循环常态呼吸；自动眨眼/物理摆动内置
- **虚拟时钟契约**（录屏技能路线 B）：`?capture` 模式挂 `window.__loommateStep(dt)`（model.update(dt*1000)+render），`window.__loommateLive2DReady()` 就绪标记，`preserveDrawingBuffer` 截图保真

## 备选后端：TalkingHead（3D，保留不引用）

- `talkinghead/`（MIT，met4citizen）+ `public/avatars/`（business.glb 写实 CC BY-NC / vroid.glb 动漫非商用）
- 写实 3D 在浏览器轻渲染下恐怖谷效应明显（用户评审"惊悚"否决），仅作技术储备
- 生产若回 3D 路线：需定制 Mixamo 骨架 + ARKit blendshapes 风格化模型（非写实）
