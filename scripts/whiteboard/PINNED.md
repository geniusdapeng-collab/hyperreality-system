# PINNED · 白板渲染引擎（随仓分发）

| 项 | 值 |
|---|---|
| 上游仓库 | https://github.com/geeklee/srt-whiteboard-animation |
| 引脚 commit | `696a7243c0e6ffb6827676e539c2ca5ebae2bf6b`（`main`，2026-07-28 "feat: initial release of srt-whiteboard-animation skill"） |
| 拉取日期 | 2026-09-27（Asia/Shanghai） |
| 许可证 | MIT（`engine/LICENSE`，Copyright (c) 2026 江哥是老登啊）——原样保留，未改动 |
| 分发形态 | 引擎脚本随仓分发在 `scripts/whiteboard/engine/`（**不依赖安装期联网**；安装器只建 venv 装 pip 依赖） |
| 本地改动 | 4 处补丁落在 3 个文件上（见下），其余文件与上游逐字节一致 |
| 官方样例 | 上游 `examples/` 素材**未随本包分发**（体积 12MB，且与出片无关）；需要复现官方样例时到上游仓取 |

## 本地补丁清单

| 文件 | 补丁 | 原因 | 证据 |
|---|---|---|---|
| `engine/scripts/render_stream_whiteboard.py` | ① `_reveal_ink_segment`：从"每次调用新建并扫描**整幅** HxW 掩码"改为"只处理线段包围盒 + 笔宽外扩" | **性能缺陷**：每落墨一小段就分配并清空整幅数组（1080×600 ≈ 648KB）再做全幅布尔运算，单次约 6ms；调用次数只与笔迹采样点数相关（**与 fps 无关**），官方样例 8.6s 要调 9319 次 → cProfile 实测 56.5s/62.2s 全耗在这里，单幕渲染 4~7 分钟，"降 fps"完全无效 | 同素材 1080p/60fps：4m02s → **44s**；逐帧比对 **PSNR=∞**（516/516 帧一致）。包围盒外掩码恒为 0 ⇒ AND 必为 False ⇒ 赋值不改任何像素 |
| `engine/scripts/render_stream_whiteboard.py` | ② `render_to()` 中"区域网格路径为空"分支的 `_lay_ink(...)` 去掉多余实参 | **崩溃缺陷**：多传一个 `None`（旧签名残留）→ `TypeError: _lay_ink() takes 6 positional arguments but 7 were given`，**整幕渲染直接崩**。触发条件常见：某元素区域被后续元素完全盖住（允许掩码为空） | 真机 11 幕出片时第 8 幕死在这里；修复后同一标注正常渲出（该段只推进笔尖、不落墨） |
| `engine/scripts/render_annotation_preview.py` | ③ 字体从硬编码 `C:/Windows/Fonts/msyh.ttc` 改为跨平台探测（macOS PingFang/STHeiti、Linux Noto/WQY/DejaVu、Windows msyh/simhei）+ `WHITEBOARD_PREVIEW_FONT` 覆盖 + 位图兜底；标签框夹到画布内 | 上游只在 Windows 可用：macOS/Linux 上 `ImageFont.truetype` 抛 `OSError: cannot open resource`，**确认关直接不可用** | macOS 实测通过（未设 `WHITEBOARD_PREVIEW_FONT` 时自动探测） |
| `engine/scripts/prepare_env.py` | ④ 增加解释器版本闸（>= 3.10）+ `WHITEBOARD_PYPI_INDEX` 支持 + `--check` 报版本 | 上游不判版本：3.9 及以下会先建好 venv、再在 pip 阶段失败，报错与根因不匹配（PyAV / numpy 2.x 无 cp39 macOS arm64 wheel） | 本机 `/usr/bin/python3`（3.9.6）触发时给出明确修复建议 |

## 未改动但必须知道的上游事实

1. **渲染产物没有音轨**：`render_stream_whiteboard.py` 用 `cv2.VideoWriter(mp4v)` 再转 H.264，全程不写音频轨；
   `merge_scenes.py` 也只是视频轨拼接 → 配音必须由本包 `lib/mux.mts` 混流进来。
2. **上游只做"一张图 + 标注 → 一段 MP4"**：分幕、字幕解析、线稿生成、语义标注都交给调用方（本包的 `lib/**` 就是这部分）。
3. **`--pause` 在逐区域画法下几乎无效**（上游注释自述"预留"）。
4. **网格模式要求图像边长是 `grid_edge` 的整数倍**：渲染器已在输出侧对齐，输入图尺寸不受限。
5. **上游 `assets/drawing-hand.png` 笔杆带作者渠道标识**：本包改用自有中性素材 `assets/drawing-hand-workloom.png`
   （由 `lineart_tools.py hand` 可重生成，可审计），上游素材不随包分发。

## 升级流程

1. 取上游新 commit，把 4 处补丁重放一遍（上游若已修，删除对应补丁并更新本文件）；
2. 跑一次全链路出片（`film.mts --script <短稿> --title <标题>`）确认成片与字幕对齐无回归；
3. 更新 `oss-components.json` 的 `current/currentSource` 与本文档；
4. 各仓通过各自任务卡 PR 同步（本包随仓分发，不走安装期联网）。
