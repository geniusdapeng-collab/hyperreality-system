# 手绘白板解说片 · 可移植能力包

> 一份口播稿进来，一条**带配音、带字幕轨的手绘白板解说片**出去。
> 本地确定性 CPU 渲染、零 API 依赖（线稿可选方舟出图）、零模型成本（线稿选自实拍图时）。
> 本能力包**自带引擎与全部依赖**，不要求宿主仓有视频制作子系统。

## 快速开始（任意仓）

```bash
# ① 建隔离渲染环境（幂等；需要 Python >= 3.10，缺失时用 --python 指定）
pnpm exec tsx scripts/whiteboard/engine-install.mts

# ② 出片（口播稿 → 成片）
pnpm exec tsx scripts/whiteboard/film.mts \
  --script docs/examples/whiteboard-sales-script.md \
  --title "获客增长系统 · 销售解说" \
  --lineart seedream --profile chen-zhuo-film

# 产物：var/whiteboard/<filmId>/whiteboard-final.mp4（+ film.srt、evidence.json、逐幕产物）
```

## 八环节

```
口播稿 ──narrate──▶ 配音（本机配音工位，逐句真实时长）──▶ SRT ──plan──▶ 分幕
      ──lineart──▶ 逐幕线稿 ──annotate──▶ 逐幕标注 ──preview──▶ 编号检查图（确认关）
      ──render──▶ 逐幕渲染 + 合并 ──deliver──▶ 两遍 loudnorm 混流 + 软字幕轨 ──▶ 成片
```

| 环节 | 说明 |
|---|---|
| narrate | 逐句合成（本机配音工位 HTTP，支持克隆音色）→ **SRT 与音频构造即一致**；也可 `--srt/--audio` 用外部配音 |
| plan | 分幕确定性（默认每幕 26s / 最短 18s / 最长 34s）；幕长铺满音频，Σ 幕长 == 音频总长 |
| lineart | `seedream`（方舟出图，风格机检三道 + 失败读数写回提示词重出）/ `sketch`（实拍图素描化，零成本）/ `upload`（现成线稿） |
| annotate | 区域由**像素反推**（连通域 + 确定性聚合 + 阅读序），元素↔字幕一一对应，时序由真实时长派生 |
| preview | 出编号检查图（确认关）；`--skip-preview` 显式跳过 |
| render | 逐幕渲染 + 合并；**断点续跑**（已渲完的幕跳过） |
| deliver | 两遍 loudnorm（默认 -16 LUFS）+ `apad` + 软字幕轨 |

## 常用参数

```
--script <md>        口播稿（标题/引用/表格/注释行不进配音；正文按句切分）
--srt <srt>           已有字幕（跳过配音；可与 --audio 组合）
--audio <wav>         已有配音整轨
--lineart seedream|sketch|upload   --source <图片>   （sketch/upload 时的输入图）
--profile <name>      配音工位音色档案（默认 WORKLOOM_VOICE_PROFILE / zh-myvoice）
--target-sec/--min-sec/--max-sec   分幕档位（默认 26/18/34）
--fps/--cap-long-edge 渲染档位（默认 30 / 1280；耗时随二者近似线性）
--film <filmId>       复用既有任务（断点续跑）   --only narrate,plan,...   只跑指定环节
--skip-preview        自动模式跳过确认关（会在证据里留痕）   --force-lineart  重出已有线稿
```

## 环境变量（全部可选）

| 变量 | 作用 |
|---|---|
| `VOLCENGINE_ARK_API_KEY` / `ARK_API_KEY` | `--lineart seedream` 出图所需（缺省则用 sketch/upload） |
| `WHITEBOARD_LINEART_MODEL` / `WHITEBOARD_LINEART_SIZE` | 出图模型与尺寸（默认 `doubao-seedream-5-0-pro-260628` / `2K`） |
| `WORKLOOM_VOICE_BRIDGE_URL` / `WORKLOOM_VOICE_BRIDGE_TOKEN` | 本机配音工位地址与令牌（默认 `http://127.0.0.1:9776`） |
| `WHITEBOARD_NARRATION_PROFILE` / `WHITEBOARD_NARRATION_CONCURRENCY` | 音色档案 / 逐句合成并发（默认 3） |
| `WHITEBOARD_OUT_DIR` | 产物根目录（默认 `<仓库根>/var/whiteboard`） |
| `WHITEBOARD_FFMPEG` / `WHITEBOARD_FFPROBE` | 外部可执行文件覆盖（默认走 PATH） |

## 依赖与许可

- 渲染引擎：上游 [geeklee/srt-whiteboard-animation](https://github.com/geeklee/srt-whiteboard-animation)（**MIT**，可商用），
  pin `696a724` + 4 处本地补丁 —— 见 [`PINNED.md`](./PINNED.md) 与 [`engine/LICENSE`](./engine/LICENSE)；
- Python 依赖闭包：`opencv-python` / `numpy` / `PyAV` / `Pillow`（全部宽松许可）——
  版本事实见 [`engine/requirements.txt`](./engine/requirements.txt)，已在 `oss-components.json` 登记；
- venv 在 `scripts/whiteboard/engine/.venv`（已 gitignore），由 `engine-install.mts` 幂等安装。

## 与深度集成版的关系

`WorkLoom-growth` 另有一份**深度集成版**（`apps/server/src/video/whiteboard/**` + vendor 引擎）：
它把白板渲染接进视频制作子系统，走 Provider 接缝、渲染台账、成本台账、媒资库、制片档案与 G8 围栏，
并暴露 tRPC 接口与媒体库播放链接。

两者的取舍：

| | 本能力包（可移植） | 深度集成版（growth 家族） |
|---|---|---|
| 依赖 | **零**（自带引擎与依赖，不要求视频子系统） | 需要 `render_jobs` / `videolibrary` / gen 接缝 / poller |
| 状态 | 任务目录 `manifest.json` | 数据库 `whiteboard_films` / `whiteboard_scenes` + 事件账本 |
| 适用 | 舰队任意仓（含无视频子系统的仓） | 已有视频制作线的仓 |
| 产物 | `var/whiteboard/<filmId>/` | 同上 + 媒资库 `final_cut` + 签名播放链接 |

同一份口播稿在两边都能出片；本包是"每个仓都能用"的基线，深度集成版是"接进产品链路"的形态。
