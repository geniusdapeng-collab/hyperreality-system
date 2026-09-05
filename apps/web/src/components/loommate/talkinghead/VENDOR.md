# vendor · TalkingHead 数字人引擎 + 演示头像

| 项 | 值 |
|---|---|
| 引擎 | `talkinghead.mjs` — [met4citizen/TalkingHead](https://github.com/met4citizen/TalkingHead)（1.5k★，活跃维护至 2026-06） |
| 引擎许可 | **MIT**（Copyright (c) 2023-2024 Mika Suominen），入库未做任何源码修改 |
| 选型理由 | 浏览器原生、零服务端依赖、公开 `setValue/setFixedValue` 口型形态控制 + 8 种情绪 mood + 手势 playGesture + 自动眨眼/眼神接触/动态骨骼——数字人"口型/驱动/表情/动作"全要素一站齐 |
| 头像（现行·商务风） | `public/avatars/business.glb`（4.7MB，Ready Player Me 写实商务女性形象，TalkingHead 官方示例头像 brunette.glb，B 端气质） |
| 头像（备用·动漫风） | `public/avatars/vroid.glb`（2.3MB，VRoid Studio 制作，C 端/二次元场景可切） |
| 头像许可 | business.glb 为 **CC BY-NC 4.0**（非商用，上游 README 明示）；vroid.glb 同非商用——当前均作评审/演示形象；**生产上线前必须替换**为 Ready Player Me 定制商务形象或自制授权形象（Mixamo 骨架 + ARKit blendshapes 即兼容，换 `avatarUrl` 配置即可） |
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
