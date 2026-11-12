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

## 音频问答

从工作台根启动 pi，使其发现 `.pi/extensions/audio-understand/`；已有会话用 `/reload` 加载扩展。
将 [示例配置](../.pi/audio-understand.example.json) 复制为 `.pi/audio-understand.local.json`，填写服务信息；密钥可直接配置或由 `apiKeyEnv` 引用启动环境。配置文件每次调用读取，环境变量变更需要重启 pi；明文密钥文件应限制读取权限。

服务须接受非流式 Chat Completions：`input_audio.data` 使用 Base64 Data URL，`format` 为 `wav` 或 `mp3`，返回完整文本答案。模型额外参数放在 `requestParams`；OpenAI-compatible 的声明本身不能保证音频兼容。

`maxEncodedAudioBytes` 是用户按外部服务约束设置的单次上传预算，计量一次远端请求中全部音频的 Base64 字节总量（约为音频字节的 4/3）；完整 HTTP 请求体还包含 JSON、问题及来源说明，配置时按服务限制预留余量。插件先准备并检查全部来源，再按输入顺序将完整来源／选段分批串行上传。单项超额时整次失败、零上传，可由主代理缩短选段或调整服务额度。`timeoutMs` 覆盖准备及全部批次。

起止时间回退到 `[0, 源时长]`，回退后区间须非空且正序。完整 MP3／WAV 直接使用；MP3 选段复制压缩帧并向外覆盖切点，PCM WAV 裁切保留样本精度；其他格式转换为服务接受的 MP3／WAV。来源记录保留原始请求、有效区间及 `submitted` 实际提交区间，片段零秒对应 `submitted.start` 源秒。插件验证覆盖和映射，无法可靠验证时报告错误。

每批独立回答并保留全局 `source-N` 标识。结果的 `status` 表示全部完成、部分完成或失败，`batches` 列出各批来源、回答、用量、缓存及错误。某批失败后停止后续上传，保留已完成结果；显式重试复用已完成批次。跨批比较由主代理另行判断。

请求缓存及调用报告位于 `.cache/audio-understand/`，含问题、回答和来源记录。命中批次的用量属于原请求，本次直接复用。`cacheMaxAgeMs` 限制复用年龄，设为 `0` 强制重新请求；删除相应批次缓存报告也可重新请求。缓存过期仅停止复用，磁盘清理由使用者决定。模型 alias 的服务端更新无法仅靠名称识别。

音频测试使用合成声音、本地文件和 HTTP 替身；pi 的实际加载及云端听音质量分别验证。测试沿用 Node 原生 TypeScript 支持，扩展运行由 pi 加载。

## 升级与排错

更新前检查正式版变更与兼容性；更新后核对实际版本及来源锁，复验技能发现、脚本依赖、共享 CLI、媒体引擎和预览素材列表。

排查共享环境时，用 `bin/workspace-env` 包装诊断命令，确认问题是否也发生在实际制作环境中；媒体路径、脚本依赖、浏览器及外联差异见 [环境调查](external/hyperframes-upstream.md)。

运行 `npm run test:env`、`npm run test:audio` 验证本地行为。实际技能发现、浏览器预览和扩展加载的验收要求见 [行为规范](spec.md#验证与证据)。
