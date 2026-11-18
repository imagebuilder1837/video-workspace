# 开发与环境

## 准备

沿用 WSL Arch Linux 执行工具，Windows Edge 查看本地预览。系统依赖由使用者安装和维护：

```sh
sudo pacman -S --needed ffmpeg chromium
npm ci
npm run hf -- doctor --json
```

按 HyperFrames 包的 engines 选择 Node/npm，核对 doctor 的环境诊断结果。

完整上游 skills 通过 `npx skills` 在工作台根安装及更新，CLI 依赖通过 npm 管理。选择实际使用的 agent；项目安装产生的 `skills-lock.json` 留在工作台，全局来源锁留在原位置。

```sh
npx skills add heygen-com/hyperframes
```

在 VS Code 中打开工作台根目录，照常通过 Pi 插件启动会话；插件配置与全局环境保持原样。日常制作的命令调用约定见 [行为规范](spec.md#视频项目与执行范围)。

## Pi Audio Ask

从工作台根启动 Pi，使其发现 `.pi/extensions/audio-ask/` 和本地 `audio-direction` skill；已有会话用 `/reload` 加载。
将 [示例配置](../.pi/audio-ask.example.json) 复制为 `.pi/audio-ask.local.json`，填写服务信息。密钥直接配置或由 `apiKeyEnv` 引用启动环境，明文文件权限设为 `600`。配置按次读取；环境变量变更后重启 Pi。

`api` 沿用 Pi 的协议名：`openai-completions` 对应 `/chat/completions`，`openai-responses` 对应 `/responses`。两种协议均使用 WAV／MP3 与非流式文本回复。Responses 按[百炼 Qwen 音频契约](https://help.aliyun.com/zh/model-studio/qwen-omni#qwen38-responses)发送扁平 `input_audio` 和完整 Data URI；Chat Completions 使用嵌套 `input_audio`，默认 Base64，按服务要求可选 `"audioDataFormat": "data-url"`。示例使用 Qwen3.8-Omni-Flash；`apiKey` 留空时从 `PI_AUDIO_ASK_API_KEY` 读取。协议参数放在 `requestParams`，例如 Responses 的 `max_output_tokens`。

`maxEncodedAudioBytes` 计量每次请求全部音频的 Base64 字节总量，约为文件字节的 4/3；配置时为 HTTP 请求中的问题、JSON 和来源说明预留容量。`maxItemsPerRequest` 控制每批完整素材组的数量。`timeoutMs` 按远端请求计时，批量处理逐批准备与保存，可随时取消。

完整 MP3／WAV 尽量原样提交，MP3 裁切复制压缩帧，PCM WAV 保留样本精度，其余格式转换为接口接受的音频。时间与档案约定见 [Pi Audio Ask 参考](../.agents/skills/audio-direction/references/pi-audio-ask.md)。

每批先准备一次请求体，远端超时按每次发送及读取响应计时。暂时性故障按配置有限重试，等待时间优先采用服务的 `Retry-After`；本地素材问题按项反馈，远端持续故障或归档失败时保存进度并停止后续提交。

档案位于工作台 `.media/audio-ask/`。完整 JSON 记录支持重建 Markdown 报告与索引；多个调用各自保存记录，共享索引通过文件锁协调更新。异常退出遗留锁时，确认写入进程已结束，再移除错误中列出的 `.index.lock`。

工作台根下的维护命令：

```sh
node .pi/extensions/audio-ask/maintenance.ts rebuild
node .pi/extensions/audio-ask/maintenance.ts migrate
```

`rebuild` 从原始记录重建阅读视图。`migrate` 离线迁移旧配置与 `.cache/audio-understand/` 分析，合并已有引用关系中的批次副本；重复执行沿用已导入记录，旧分析文件原位保留。

`npm run test:audio` 使用合成音频、本地文件和 HTTP 替身验证公共接口行为，沿用 Node 原生 TypeScript 支持。Pi 实际加载、真实模型听音质量及创作中的主动咨询分别验收。

## 升级与排错

更新前检查正式版变更与兼容性；更新后核对实际版本及来源锁，复验技能发现、脚本依赖、共享 CLI、媒体引擎和预览素材列表。

排查共享环境时，用 `bin/workspace-env` 包装诊断命令，确认问题是否也发生在实际制作环境中；媒体路径、脚本依赖、浏览器及外联差异见 [环境调查](external/hyperframes-upstream.md)。

运行 `npm run test:env`、`npm run test:audio` 验证本地行为。实际技能发现、浏览器预览和扩展加载的验收要求见 [行为规范](spec.md#验证与证据)。
