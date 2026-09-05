# vendor · TalkingHead 数字人引擎 + 演示头像

| 项 | 值 |
|---|---|
| 引擎 | `talkinghead.mjs` — [met4citizen/TalkingHead](https://github.com/met4citizen/TalkingHead)（1.5k★，活跃维护至 2026-06） |
| 引擎许可 | **MIT**（Copyright (c) 2023-2024 Mika Suominen），入库未做任何源码修改 |
| 选型理由 | 浏览器原生、零服务端依赖、公开 `setValue/setFixedValue` 口型形态控制 + 8 种情绪 mood + 手势 playGesture + 自动眨眼/眼神接触/动态骨骼——数字人"口型/驱动/表情/动作"全要素一站齐 |
| 头像 | `public/avatars/vroid.glb`（2.3MB，动漫风大眼甜妹，VRoid Studio 制作，TalkingHead 官方示例头像） |
| 头像许可 | **非商用演示许可**（上游 README 明示 "for non-commercial use"）——当前作评审/演示形象；**生产上线前必须替换**为客户自制 VRoid 形象（VRoid Studio 免费自制，许可宽松）或 Ready Player Me 定制形象（Mixamo 骨架 + ARKit blendshapes 即兼容） |
| 升级纪律 | 与 vendor/dsh 同口径：官方新版即评估升级；替换头像只换 `public/avatars/` 文件与 `MateDigitalHuman` 的 url 配置 |

## 数字人驱动架构（织伴）

```
语音层 VoiceEngine（speechSynthesis，boundary 事件带 charIndex）
   → 口型驱动器：charIndex → 视素时间线（viseme_aa/E/I/O/U 元音映射 + 闭口包络）
   → TalkingHead setValue('viseme_*') 逐帧对齐 —— 口型对齐
事件层（inbox level/kind · chat 情绪）
   → 情绪映射：red→fear / done→happy / 甜妹常态→love / neutral
   → 手势映射：招呼→handup / 赞许→thumbup / 倾听→index —— 声情并茂
生命感（TalkingHead 内置）：自动眨眼 · 眼神追随镜头 · 呼吸晃动 · 动态骨骼（头发/衣摆）
降级：WebGL 不可用 → 退回 SVG 甜妹（MateAvatar）
```
