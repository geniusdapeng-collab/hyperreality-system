# 织伴自然女声

织伴（小织）默认使用本机 Kokoro 中文女生声线 `zf_xiaoni`，逻辑档案名为 `loommate-sweet`。欢迎仪式、首日引导、数字人对话和经营播报共用既有 `VoiceEngine` 播放队列、字幕与口型链路。普通岗位员工的声音配置保持各自独立。

## 选型与实测

本次比较了以下路径，实际速度为 2026-10-02 在 M3 / 8 GB 的单机测量，不代表其他硬件的性能。

| 路径 | 能力与限制 | 本机结果 | 决策 |
| --- | --- | --- | --- |
| Qwen3-TTS 1.7B CustomVoice / Serena | 中文自然语言情绪指令，能生成温柔、开心、安抚女声；模型与分词器约 2.3 GB | 三段 5.6–7.68 秒音频分别耗时约 182、380、331 秒 | 可用于离线配音；本次不作为实时织伴默认引擎 |
| Qwen 参考女声 → 现有 OmniVoice 克隆 | 参考音色可追溯，复用现有本机配音工位 | 3.28 秒女声音频耗时约 549 秒 | 本次不作为实时织伴默认路径 |
| Kokoro-82M / 小妮 | 本机轻量中文女生声线，语句本身的韵律；不支持 Qwen 那样的任意情绪指令 | 模型加载约 0.6 秒；初次中文处理与推理约 15.6 秒，热机样句约 2–3 秒 | 本次统一默认女声；真实 HTTP、路由与缓存结果见任务回执 |
| QwenAudio/CosyVoice | 官方支持中文与情绪指令；需另一套推理环境 | 本机没有安装与实测 | 暂不引入新的重型运行时 |

“甜美”“亲和”属于听感判断。当前采用自然语句、标点停顿和固定女生声线；不声称已实现任意情绪控制。Kokoro 官方也提示中文训练数据有限，用户可用同一组欢迎、完成反馈、安抚提示进行试听复核。

官方来源：[Kokoro](https://github.com/hexgrad/kokoro)、[中文声线](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md)、[MLX 权重](https://huggingface.co/mlx-community/Kokoro-82M-bf16)、[Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS)、[OmniVoice](https://github.com/k2-fsa/OmniVoice)、[CosyVoice](https://github.com/FunAudioLLM/CosyVoice)。

## 安装与离线运行

前提是已安装并使用本次实测的 `mlx-audio==0.5.5` 本机语音工位：`~/.workloom/voice-station/venv/bin/python`、仅本人可读的 `bridge-token`，以及现有 MLX 运行时。新包只适用于 Apple Silicon macOS；其他平台继续使用已配置的个人克隆或系统语音，不伪装成已安装 MLX 女声。

在仓库根目录运行（Tiger 在 `governance/` 下运行）：

```sh
python3 scripts/install-loommate-voice.py
python3 scripts/install-loommate-voice.py --check
```

已有完整下载与依赖时可用 `--offline` 安装。首次联网安装约下载 328 MB 的权重及小妮声线，并添加固定的 `misaki[zh]==0.9.4` 中文处理依赖；复用工位 Python 环境，不把模型打入十二个客户端安装包。安装器启动织伴独立回环服务 `127.0.0.1:8100`，Metal 缓存上限为 128 MiB，原来的影视配音/个人克隆服务仍使用原端口。安装器优先使用现有 `uv`，否则使用工位 Python 的 pip；没有安装工具则明确失败。

`apps/server/src/voice/loommate-voice.json` 是模型、声线、许可证、固定修订与 SHA-256 的单一事实源。安装器校验模型和声线权重，建立本机只读资产链接，再原子写入不含令牌的工位清单。固定修订为 `a71e4d38b236d968966a2002c4c895dbd12b1c3c`。运行时只使用本机已安装路径与声线文件，不临时拉取模型或声音。

安装后重启相应项目服务端，刷新已打开的页面以重新执行语音能力探测。确认 `/api/voice/status` 返回 `enabled:true`、`configured:true`、`profile:"loommate-sweet"`；播放响应头 `x-voice-profile` 给出实际使用的声线。

## 默认流程与异常路径

1. 旧客户端发送 `zh-myvoice` 时，默认服务器配置将其映射到 `loommate-sweet`，因此已有前端无需改版即可使用新女声。
2. 同一模型修订、声线、语速和文本命中有效 WAV 缓存时直接播放。缓存位于工位 `deliveries/voice-cache/`，同一台机器的各项目复用。
3. 未命中时调用本机织伴轻量 MLX 服务。长文本按标点及最多 80 个 Unicode 字符分段，按顺序拼接，禁止截断文本后假装合成成功。
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

相关自动化测试覆盖默认与覆盖配置、私有凭据与符号链接、空/超长/特殊字符、合法/损坏缓存、长文本完整性、并发去重、超时取消、HTTP/文件失败、本人克隆回退、授权错误、输出路径校验与 WAV 结构。另需运行本机真实合成、缓存速度、发音、数字人播放、字幕及口型检查。具体本次结果由任务卡与 PR 回执记录，机器单测不能替代主观听感复核。
