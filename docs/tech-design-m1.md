# 技术方案 · M1 视听觉醒（懂汇报的狐狸先生 / workroom-fox）

> 对应 PRD：《WorkLoom 3D 人机协作体验升级 PRD V1.0》F1/F3/F4/F5 + hover 状态条
> 范围：M1 全部五个特性 · 目标仓：workroom-fox（hotel 分叉，开源）
> 版本 V1.0 · 2026-09-04

---

## 1. 架构总览

```
事件源（轮询 diff / 本地 UI 事件）
   │
   ├─► CineDirector（镜头导演）──► OrbitControls/Camera（三类运镜 + 日频熔断）
   │
   ├─► AudioEngine（三层混音总线 WebAudio）
   │      ├─ ambience 总线：环境白噪（程序化生成）
   │      ├─ sfx 总线：提示音（振荡器合成，无音频资产）
   │      └─ ritual 总线：仪式音（同上）
   │
   ├─► VoiceEngine（语音播报，speechSynthesis 端侧）
   │      ├─ 角色音色参数（pitch/rate）· 优先级队列 · 打断
   │      └─ SubtitleBar（新闻台字幕条，语音降级兜底）
   │
   └─► GazeSystem（注视感知）
          ├─ 视锥中心射线检测（1.5s 持续）
          ├─ Avatar3D 头部骨骼缓动 + 点头
          └─ HoverBubble（一句话状态条，hover 0.5s 共享触发）
```

设计纪律：
- **纯增强层**：音频/语音/运镜任何一环失败，业务功能不受影响（try/catch 隔离 + 降级）。
- **零资产依赖**：音效全部 WebAudio 程序化合成（oscillator + noise buffer），语音用端侧 speechSynthesis——开源仓库不携带任何版权音频/TTS 密钥。
- **可关闭**：音量三档、导演模式开关、语音档位，全部 localStorage 持久化。

---

## 2. 模块设计

### 2.1 AudioEngine（`apps/web/src/audio/AudioEngine.ts`）

单例。WebAudio `AudioContext` 懒启动（首次用户手势后 resume，满足自动播放策略）。

```
master ─┬─ ambienceGain（-28dB）
        ├─ sfxGain（-18dB）
        └─ ritualGain（-14dB）
```

- **音量三档**：`full / hints / mute`
  - full：三总线全开；hints：仅 sfx+ritual；mute：全部静音（AudioContext suspend）。
  - 持久化 `wl-audio-mode`。
- **环境层**（`ambience.ts`）：程序化循环——
  - `office`：滤噪粉噪（低通 400Hz）+ 随机键盘"嗒"（短脉冲，泊松间隔 3-9s）
  - `rain`：棕噪（带通 800-2000Hz）+ 随机远雷低频轰
  - `morning`：高通风声 + 随机鸟鸣啁啾（FM 合成滑音）
  切换：按 `useNightTime()` 与时段 crossfade 2s。
- **提示音/仪式音**（`sfx.ts`）：18 个合成预设，每个是「振荡器类型 + 包络 + 音高序列」参数表，如：
  - `approve`（盖章）：方波 180Hz 0.06s + 噪声冲击 0.03s
  - `chime`（风铃）：正弦 1320Hz→1760Hz 滑音 0.35s + 2 倍频泛音
  - `fanfare`（号角）：三和弦 C4-E4-G4 锯齿波 0.5s 渐强
  - `alarm`（熔断警报）：三角波 620Hz↔480Hz 往复 ×3
  - `celebrate`（庆典钟）：正弦 880Hz 长衰减 1.8s + 五度叠音

### 2.2 VoiceEngine（`apps/web/src/voice/VoiceEngine.ts`）

端侧 `speechSynthesis`（Electron/Chromium 内置中文语音，零网络零密钥）：

- **音色参数表**（`VOICE_PRESETS`）：每角色 `{ pitch, rate, voiceHint }`，如 CEO `{pitch:0.8, rate:0.85}`、侦察官 `{pitch:1.2, rate:1.1}`；`voiceHint` 用于在 `getVoices()` 中优先匹配（zh-CN 男/女声启发式）。
- **播报队列**：`speak({ role, text, priority })`，优先级 `fuse > ask > ceremony > ambient`；
  - fuse 进来：`speechSynthesis.cancel()` 立即打断当前，插队播报；
  - 用户开始交互（pointerdown/wheel）→ 当前播报告一段落自然停（不再排新句）。
- **降级**：`speechSynthesis` 不可用 / 无中文 voice → `available=false`，仅走 SubtitleBar。
- **字幕同步**：每次 speak 同步发字幕事件（角色名 + 文本 + 时长估算 `字数/4.5 字每秒`）。

### 2.3 SubtitleBar（`apps/web/src/voice/SubtitleBar.tsx`）

- 新闻台样式：底部横条——左侧台标「WL-TV · 云栖晨会」+ 右侧滚动字幕区；
- 字幕队列逐条显示，超时自动消隐；`仅字幕` 模式下所有播报仅走这里；
- zIndex 高于 3D 画布低于弹窗；入场/出场 translateY 动画。

### 2.4 CineDirector（`apps/web/src/components/CineDirector.tsx`）

- **事件摄入**：`useTheaterEvents(theater, queue)`——对 P0 轮询数据做 diff：
  - 新增 asking 成员 → `ask` 事件；
  - theater.events 里 `fence.blocked` → `fuse` 事件；`quest.done`/里程碑 → `cheer` 事件；
  - 22:00 夜班切换 → `nightfall`（每日一次）。
- **镜头状态机**：`idle → moveIn(event) → hold(1.2~2s) → restore → idle`；
  - 运镜实现：事件目标世界坐标 → 计算目标机位（当前方位角不变，距离/极角调整）→ easeInOutCubic 插值 camera.position + controls.target → 保持 → 回到用户之前机位（机位栈）。
- **日频熔断**：`wl-director-count` localStorage `{date, count}`，`ask/cheer` 类合计 ≤6/天；fuse/nightfall 不计。
- **让位**：OrbitControls `onStart` → 立即中断运镜并清空队列。

### 2.5 GazeSystem（`apps/web/src/components/GazeSystem.tsx`）

- 每 100ms：取 camera 视锥中心射线，对每个 Worker 头部世界坐标做「射线-点距离 + 夹角」判定（阈值：夹角 <6° 且最近）；
- 持续命中 ≥1.5s → 触发一次 `onGaze(agent)`：Avatar3D 头部缓动转向镜头（`headBone.lookAt(camera)` 权重 0.6，2.5s 后衰减归零）+ 点头（头部 X 轴 0.12rad 正弦一次）+ 打开 HoverBubble；
- 同一角色 30s 冷却。
- **Avatar3D 扩展**：`forwardRef` 暴露 `headRef`（traverse 找名字含 `head` 的骨骼）；无 head 骨骼则整体转向降级。
- HoverBubble：hover（pointerover 0.5s）与 gaze 共用；内容 = `statusLine(agent)`（从 theater payload 生成"在做 X，还需 Y"）。

### 2.6 设置面板（`P0` 顶部工具区）

齿轮按钮 → 小弹层：音量三档（完整/仅提示音/静音）、导演模式开关、语音档位（仅仪式与熔断/全语音/仅字幕）。全部 localStorage，跨会话记忆。

---

## 3. 数据流与事件源

P0 现行轮询 `captain.theater`（含 floor/agents、events、queue）：
- **diff 检测器**（`useTheaterDiff`）：以上一份 payload 为基准，输出三类事件（新 asking / fuse 关键词 / cheer 关键词 + 夜班切换沿）；
- 晨间仪式开始（ceremony 状态）→ 触发 `ceremony` 播报序列（角色依次 `speak`："{persona}，向您报到" + 字幕）。

---

## 4. 性能与降级

| 项 | 预算/策略 |
|---|---|
| 音频上下文 | 单例；mute 时 suspend（零 CPU） |
| 环境声 | 2 个 buffer source 循环 + 1 个噪声节点，无 per-frame JS |
| GazeSystem | 100ms 间隔（非每帧），11 角色 O(n) 可忽略 |
| TTS 不可用 | `available=false` → 仅字幕，UI 无语音开关置灰说明 |
| 无 WebGL | 现有 SVG 降级路径不变；音频/字幕条照常工作（它们不依赖 3D） |

## 5. 测试计划

- 单测：sfx 预设表完整性、音量档位切换、日频熔断计数、diff 检测器三类事件、字幕时长估算；
- 运行时自测（CDP）：AudioEngine 状态机、synthesize 不抛错、speechSynthesis 可用性探测、熔断后不再运镜；
- 视觉走查：晨会仪式字幕条、请示运镜落点、注视点头、设置弹层。

## 6. 文件清单（新增）

```
apps/web/src/audio/AudioEngine.ts     # 混音总线 + 三档音量
apps/web/src/audio/sfx.ts             # 18 个程序化音效预设
apps/web/src/audio/ambience.ts        # 环境声（办公/雨夜/清晨）
apps/web/src/voice/VoiceEngine.ts     # TTS 队列 + 音色表 + 降级
apps/web/src/voice/SubtitleBar.tsx    # 新闻台字幕条
apps/web/src/components/CineDirector.tsx  # 运镜状态机 + 日频熔断
apps/web/src/components/GazeSystem.tsx    # 注视检测
apps/web/src/components/HoverBubble.tsx   # 一句话状态条
apps/web/src/lib/theaterDiff.ts       # 轮询数据 diff → 导演事件
```

修改：`Avatar3D.tsx`（暴露 headRef + gaze 接口）、`Floor3D.tsx`（接入 Gaze/HoverBubble/Director）、`Stage3D.tsx`（仪式播报接入）、`pages/p0/P0.tsx`（字幕条 + 设置弹层 + diff 事件接线）、`cinematic.tsx`（CineRig 与 Director 共存协议）。

## 7. 回同步策略

workroom-fox 为先行验证仓（开源）。M1 走查通过后，以锚点补丁回同步 workloom-im 基座与 6 个下游仓（保持现行"基座先行"纪律的逆向：fox 先行 → 基座吸收 → 六仓同步）。
