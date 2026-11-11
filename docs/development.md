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

在 VS Code 中打开工作台根目录，照常通过 Pi 插件启动会话；插件配置与全局环境保持原样。日常制作的命令调用约定见 [行为规范](spec.md#视频项目与执行范围)。

## 音频问答

从工作台根启动 pi，使其发现 `.pi/extensions/audio-understand/`；已有会话用 `/reload` 加载扩展。
将 [示例配置](../.pi/audio-understand.example.json) 复制为 `.pi/audio-understand.local.json`，填写服务信息；密钥可直接配置或由 `apiKeyEnv` 引用启动环境。配置文件每次调用读取，环境变量变更需要重启 pi；明文密钥文件应限制读取权限。

服务须接受非流式 Chat Completions：`input_audio.data` 使用 Base64 Data URL，`format` 为 `wav` 或 `mp3`，返回完整文本答案。模型额外参数放在 `requestParams`；OpenAI-compatible 的声明本身不能保证音频兼容。

请求缓存位于 `.cache/audio-understand/`，含问题、回答和来源记录。命中时的用量属于原请求，本次复用没有远程调用。`cacheMaxAgeMs` 限制复用年龄，设为 `0` 强制重新请求；删除对应报告也可重新请求。缓存过期仅停止复用，磁盘清理由使用者决定。模型 alias 的服务端更新无法仅靠名称识别。

音频测试使用合成声音、本地文件和 HTTP 替身；pi 的实际加载及云端听音质量分别验证。测试沿用 Node 原生 TypeScript 支持，扩展运行由 pi 加载。

## 升级与排错

更新前检查正式版变更与兼容性；更新后核对实际版本及来源锁，复验技能发现、脚本依赖、共享 CLI、媒体引擎和预览素材列表。

排查共享环境时，用 `bin/workspace-env` 包装诊断命令，确认问题是否也发生在实际制作环境中；媒体路径、脚本依赖、浏览器及外联差异见 [环境调查](external/hyperframes-upstream.md)。

运行 `npm run test:env`、`npm run test:audio` 验证本地行为。实际技能发现、浏览器预览和扩展加载的验收要求见 [行为规范](spec.md#验证与证据)。
