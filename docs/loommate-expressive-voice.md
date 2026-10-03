# 织伴自然女声

织伴（小织）默认使用本机 Kokoro-82M-v1.1-zh 普通话女生声线 `zf_001`（产品所有者试听选定的 A），逻辑档案名为 `loommate-sweet`。欢迎仪式、首日引导、数字人对话和经营播报共用既有 `VoiceEngine` 播放队列、字幕与口型链路。普通岗位员工的声音配置保持各自独立。

## 选型与实测

本次比较了以下路径，实际速度为 2026-10-02 至 10-03 在 M3 / 8 GB 的单机测量，不代表其他硬件的性能。

| 路径 | 能力与限制 | 本机结果 | 决策 |
| --- | --- | --- | --- |
| Qwen3-TTS 1.7B CustomVoice / Serena | 中文自然语言情绪指令，能生成温柔、开心、安抚女声；模型与分词器约 2.3 GB | 三段 5.6–7.68 秒音频分别耗时约 182、380、331 秒 | 可用于离线配音；本次不作为实时织伴默认引擎 |
| Qwen 参考女声 → 现有 OmniVoice 克隆 | 参考音色可追溯，复用现有本机配音工位 | 3.28 秒女声音频耗时约 549 秒 | 本次不作为实时织伴默认路径 |
| Kokoro-82M / 小妮（MLX） | 本机中文女生声线与自然韵律 | 低负载热机样句约 2–3 秒；本轮高负载时 GPU 求值反复超时 | 不再作为实时默认推理后端 |
| Kokoro-82M v1.0 / 小妮 | 首版中文声线，CPU 后端可运行 | 产品所有者听到明显地域口音，明确否决 | 撤回音色验收，不再作为默认 |
| Kokoro-82M-v1.1-zh / zf_001（ONNX INT8 / CPU） | 专业中文录音训练；匹配 1.1 中文发音前端，英文混读显式保留 | A/B/C 六段同句试听真实生成，约 3.5–5.5 秒/段；最终工位耗时以本轮回执为准 | 产品所有者已选择 A，本次统一默认 |
| QwenAudio/CosyVoice | 官方支持中文与情绪指令；需另一套推理环境 | 本机没有安装与实测 | 暂不引入新的重型运行时 |

“甜美”“亲和”属于听感判断。当前采用自然语句、标点停顿和固定女生声线；不声称已实现任意情绪控制。新版官方模型卡说明中文模型使用 100 位专业中文说话人的录音。旧版“支持中文”的标注不能证明口音合格；本次已通过 A/B/C 同句试听选定 zf_001。口音与亲和程度属于人工听感验收，自动测试只验证链路和文本完整性。

官方来源：[Kokoro](https://github.com/hexgrad/kokoro)、[ONNX 导出与固定资产](https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.1)、[ONNX Runtime](https://github.com/microsoft/onnxruntime/releases/tag/v1.30.0)、[中文模型与声线](https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh)、[MLX 权重](https://huggingface.co/mlx-community/Kokoro-82M-bf16)、[Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS)、[OmniVoice](https://github.com/k2-fsa/OmniVoice)、[CosyVoice](https://github.com/FunAudioLLM/CosyVoice)。

## 安装与离线运行

前提是已安装并使用本次实测的 `mlx-audio==0.5.5` 本机语音工位：`~/.workloom/voice-station/venv/bin/python`、仅本人可读的 `bridge-token`，以及现有 MLX 运行时。当前安装器只在 Apple Silicon macOS 实测；其他平台继续使用已配置的个人克隆或系统语音，不伪装成已安装本机女声。

在仓库根目录运行（Tiger 在 `governance/` 下运行）：

```sh
python3 scripts/install-loommate-voice.py
python3 scripts/install-loommate-voice.py --check
```

已有完整下载与依赖时可用 `--offline` 安装。首次联网安装约下载 168 MB 的 ONNX INT8 模型及声线，并添加固定的 `misaki[zh]==0.9.4` 中文处理依赖、`onnxruntime==1.30.0` CPU 运行时，以及 `phonemizer-fork==3.3.2` / `espeakng-loader==0.2.4` 英文发音依赖；复用工位 Python 环境，不把模型打入十二个客户端安装包。安装器启动织伴独立回环服务 `127.0.0.1:8100`，CPU 推理最多使用两个计算线程；模型在独立子进程主线程串行执行，HTTP 连接与健康检查并发处理。队列最多四个在途请求，满载明确返回 503；模型调用超过 30 秒会终止该模型子进程，下次请求重新加载。运行时在导入前设置 `ORT_DISABLE_TELEMETRY=1`，关闭外部遥测。原来的影视配音/个人克隆服务仍使用原端口。安装器优先使用现有 `uv`，否则使用工位 Python 的 pip；没有安装工具则明确失败。

`apps/server/src/voice/loommate-voice.json` 是模型、声线、许可证、固定修订与 SHA-256 的单一事实源。安装器校验模型和声线权重，建立本机只读资产链接，再原子写入不含令牌的工位清单。固定导出来源为 Kokoro ONNX `model-files-v1.1` 的 `kokoro-v1.1-zh.int8.onnx`；模型 SHA-256 为 `11751c087b4bbeed031e2b687b11dda698bd27ba0509472f960b57f835a999f7`，声线集 SHA-256 同样固定。发布标签可重新上传资产，因此安装器以摘要校验，不把标签名当作不可变证明。词表直接取自该固定图内嵌的配置。运行时只使用本机已安装路径与声线文件，不临时拉取模型或声音。

安装后重启相应项目服务端，刷新已打开的页面以重新执行语音能力探测。确认 `/api/voice/status` 返回 `enabled:true`、`configured:true`、`profile:"loommate-sweet"`；播放响应头 `x-voice-profile` 给出实际使用的声线。

中文发音固定为 `misaki.zh.ZHG2P(version="1.1")`，英文回调采用 Misaki 的 `EspeakFallback`，避免混合英文被忽略；遇到不支持的音素明确报错，不静默漏读。模型、声线和发音前端均进入缓存身份，旧小妮 WAV 即使有效也不会被新默认复用。

可选工位依赖的许可证分别登记：模型与 Misaki 为 Apache-2.0，ONNX Runtime 与 loader 代码为 MIT，phonemizer-fork 与 loader 所带 eSpeak NG 为 GPL-3.0-or-later。这些组件由本机工位安装，不链接或打入客户端基础包。依赖原始许可见 [phonemizer-fork](https://pypi.org/project/phonemizer-fork/3.3.2/)、[espeakng-loader](https://github.com/thewh1teagle/espeakng-loader)、[eSpeak NG](https://github.com/espeak-ng/espeak-ng)。

## 默认流程与异常路径

1. 旧客户端发送 `zh-myvoice` 时，默认服务器配置将其映射到 `loommate-sweet`，因此已有前端无需改版即可使用新女声。
2. 同一模型修订、声线、发音前端、发音依赖、语速和文本命中有效 WAV 缓存时直接播放。缓存位于工位 `deliveries/voice-cache/`，同一台机器的各项目复用。
3. 未命中时调用本机织伴独立 CPU 服务。长文本按标点及最多 80 个 Unicode 字符分段，按顺序拼接，禁止截断文本后假装合成成功。
4. 模型未安装、引擎超时、失败或音频损坏时，优先尝试本机本人档案 `zh-myvoice`；响应头如实返回 `zh-myvoice`。
5. 两条路径都失败时，服务端返回既有 503 结构，客户端继续使用原有系统语音与字幕。

默认单次女声阶段最多等待 60 秒，总合成预算为 90 秒。可用 `WORKLOOM_VOICE_PRIMARY_TIMEOUT_MS`、`WORKLOOM_VOICE_TIMEOUT_MS` 覆盖（1–900000 毫秒）。重试会重新尝试已恢复的引擎；失败不会永久锁死语音服务。当前 HTTP 契约不提供逐块播放，未命中缓存的长文本需等完成后开始播放。

并发相同输入在同一服务进程内合并为一次合成；不同进程共享最终缓存，可能同时生成同一句，但文件用临时路径原子发布，避免互相读到半成品。最多 64 个不同的在途请求，文本最多 2000 字符，音频最多 32 MiB。

## 凭据与个人声音

仅回环工位可以自动读取本机已有 `bridge-token`；要求常规文件、当前用户所有、权限不允许组与其他用户读取。环境变量 `WORKLOOM_VOICE_BRIDGE_TOKEN` 显式优先。服务端不把令牌传给女声引擎、不输出令牌；拒绝远端工位地址与档案路径穿越。缓存中的播报文本对应的是用户自己的本机数据，不上传外部服务。

本人克隆参考音频及授权记录留在本机工位，安装女声不会覆盖 `profiles/zh-myvoice/`。克隆失败保留原工位同意门禁错误，不伪造授权与完成回执。

## 切换与回滚

- 全项目明确选用本人音色：服务端设置 `WORKLOOM_VOICE_PROFILE=zh-myvoice`，重启并刷新页面。
- 关闭神经语音：`WORKLOOM_VOICE_ENABLED=0`。
- 回滚代码：revert 本任务提交。模型权重是可选的本机资产；与电影配音桥的默认模型配置独立。

## 验证

相关自动化测试覆盖默认与覆盖配置、私有凭据与符号链接、空/超长/特殊字符、合法/损坏缓存、长文本完整性、并发去重、超时取消、HTTP/文件失败、本人克隆回退、授权错误、输出路径校验与 WAV 结构。另有真实 TCP 空闲连接、合成期间健康检查、串行模型调用、有界满载、子进程超时终止与重新加载，以及下载校验/离线/部分文件清理、启动重试、重复安装和实际就绪检查回归。另需运行本机真实合成、缓存速度、发音、数字人播放、字幕及口型检查。具体本次结果由任务卡与 PR 回执记录，机器单测不能替代主观听感复核。
