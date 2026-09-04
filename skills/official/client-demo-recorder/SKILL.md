---
name: client-demo-recorder
description: 客户端实拍录屏技能（带声音）——把 WorkLoom 系桌面客户端跑起来，用 CDP 驱动真实用户操作，ffmpeg 录屏 + 神经语音/程序音效配音，产出可用于评审/汇报/宣传的高保真演示视频。触发场景：录屏、录视频、实拍演示、demo 视频、操作演示、给客户看效果、录制客户端、带声音的视频。
---

# 客户端实拍录屏（带声音）

> 定位：交付级演示视频生产线。不是"截个屏"，而是**真实客户端运行态 + 真实鼠标键盘操作 + 可听的声音**三件套。

## 触发即执行

当用户表达「录个视频 / 实拍演示 / 录屏给我看 / 做个 demo 视频 / 带声音」意图，且目标是 WorkLoom 系仓库（含 `apps/desktop/electron/main.cjs`）时，按本技能执行。

## 全流程四幕

### 第一幕 · 起栈（真实客户端，不是浏览器）

```bash
# 1. 虚拟显示（无头环境必备）
nohup Xvfb :86 -screen 0 1600x1000x24 &

# 2. 后端 + 前端预览（独立端口，避开 8787/4173 既有实例）
SERVER_PORT=<PORT1> pnpm -C apps/server start &
WEB_PORT=<PORT2> SERVER_PORT=<PORT1> vite preview --port <PORT2> &

# 3. Electron 客户端（CDP 模式，可编程驱动）
DISPLAY=:86 \
WORKLOOM_SERVER_URL=http://localhost:<PORT1> \
WORKLOOM_MANAGE_SERVER=0 \
WORKLOOM_WEB_URL=http://localhost:<PORT2> \
./node_modules/.bin/electron --no-sandbox --in-process-gpu \
  --remote-debugging-port=9333 \
  --user-data-dir=/tmp/elec-rec \
  apps/desktop/electron/main.cjs &
```

纪律：
- **必须走 Electron 客户端实拍**（产品本体形态），禁止用浏览器截网页冒充；
- WebGL 校验：CDP 执行 `canvas.getContext('webgl2')`，headless Chromium 拿不到 WebGL 会触发产品降级渲染（2D 兜底），录出来是"老版本"——这是常见翻车点；
- 沙箱休眠后进程全灭，起栈前先查端口：`fuser -k 9333/tcp <PORT1>/tcp <PORT2>/tcp`。

### 第二幕 · 驱动（CDP 模拟真实用户）

用 CDP（`http://127.0.0.1:9333/json` → WebSocket）编排脚本：

| 操作 | CDP 方法 |
|---|---|
| 导航/刷状态 | `Page.navigate` + `Runtime.evaluate`（localStorage 状态控制，如清仪式标记 `theater-ceremony-*`） |
| 拖转视角 | `Input.dispatchMouseEvent`（mousePressed → 分段 mouseMoved → mouseReleased，每步 40-50ms） |
| 滚轮缩放 | `Input.dispatchMouseEvent` type=mouseWheel（deltaY ±240，间隔 150ms） |
| 右键平移 | 同拖转，button=right |
| 悬停触发 | mouseMoved 到位后停留（hover 0.5s 起气泡、注视 1.5s 起点头） |
| 截图验证 | `Page.captureScreenshot`（每幕结束留证） |

运镜节奏（观众友好）：入场运镜落定 ≥8s 再操作；每个动作之间留 2-3s"呼吸"；总时长 60-100s 为宜。

### 第三幕 · 录屏

```bash
ffmpeg -y -f x11grab -video_size 1600x1000 -framerate 24 -i :86 \
  -c:v libopenh264 -b:v 2500k -pix_fmt yuv420p out.mp4
```

- 编码器纪律：本沙箱 ffmpeg 无 libx264，用 **libopenh264**（兼容性最好）或 libsvtav1；
- 录完用 `ffprobe` 校验时长，抽帧目检（`select=eq(n,...)` tile 拼图）；
- 剪片头黑屏：`ffmpeg -ss <N> -i in.mp4 -c:v libopenh264 -movflags +faststart out.mp4`。

### 第四幕 · 配音（两条路线）

**路线 A · 实时捕获（首选，真声音）**
- 前提：系统有 PulseAudio + 中文 TTS 语音包（speech-dispatcher + espeak-ng）且 Chromium `speechSynthesis.getVoices().length > 0`；
- `ffmpeg -f pulse -i auto_null.monitor` 与画面同步录制。

**路线 B · 后期配音（本沙箱实测路线，推荐）**
Linux 无头环境 Chromium 基本拿不到 TTS 语音包（`getVoices()=0`），直接后期：

1. 神经语音逐句生成（edge-tts）：
   ```python
   import edge_tts
   await edge_tts.Communicate(text, voice, rate="-5%", pitch="+0Hz").save(f"line{i}.mp3")
   ```
   - 已验证可用的中文音色：`zh-CN-XiaoxiaoNeural / XiaoyiNeural / YunjianNeural / YunxiNeural / YunxiaNeural / YunyangNeural`（**先 `--list-voices` 核实，不在列表的音色必失败**）；
   - 限流对策：句间 sleep 1.5s + 失败重试 5 次退避；
   - 角色音色映射用产品 VoiceEngine 的 7+1 预设（音色即人格，同一角色全片统一）。
2. 程序音效（ffmpeg sine 合成号角/风铃）；
3. 时间轴混音 + 合成：
   ```bash
   # 每句 adelay 对齐画面时间轴 → amix 混音 → 与视频合成
   ffmpeg -i video.mp4 -i dub.aac -filter_complex "[1:a]apad[a]" \
     -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 160k \
     -t <视频时长> -movflags +faststart final.mp4
   ```
   - **大坑：`-shortest` 会把视频裁到配音长度，必须用 `apad` 补静音 + `-t` 显式时长**；
   - 抽验波形：`astats` 看 Peak/RMS（防静音轨、防削波）。

## 验收清单

- [ ] 画面是 Electron 客户端（非浏览器），WebGL 3D 场景正常（非 2D 降级）
- [ ] 有真实交互轨迹（拖转/缩放/平移/点击），不是静态展示
- [ ] 时长 60-100s，无片头黑屏，faststart 可流式播放
- [ ] 有声版：人声可懂、音色与角色对应、峰值不削波、视频未被 `-shortest` 截断
- [ ] 抽帧目检至少 3 帧（开头/中段/结尾）

## 常见翻车点（踩过的坑）

| 坑 | 解法 |
|---|---|
| headless Chromium 无 WebGL → 录到 2D 降级画面 | 用 Electron 实拍（SwiftShader 就绪） |
| Electron 二进缺失（postinstall 下载失败） | 从同机其它仓 `node_modules/.pnpm/electron@*/dist` 复制 |
| 单实例锁冲突 / 端口占用 | 独立 `--user-data-dir` + `fuser -k` 清端口 |
| `getVoices()=0`（Linux 无头） | 走路线 B 后期配音，不要硬磕 |
| edge-tts 音色名不在列表 → NoAudioReceived | 先 `--list-voices`，音色+音高微调区分角色 |
| 视频被 `-shortest` 截断 | `apad` + `-t` 显式时长 |
| 沙箱休眠进程全灭 | 重起栈；Xvfb/server/preview/electron 四层都要查 |
