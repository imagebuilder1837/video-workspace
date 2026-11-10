# 开发与环境

## 准备

沿用 WSL Arch Linux 执行工具，Windows Edge 查看本地预览。系统依赖由使用者安装和维护：

```sh
sudo pacman -S --needed ffmpeg chromium
npm ci
npm run hf -- doctor --json
```

Node/npm 满足 HyperFrames 包的 engines 要求即可；实际依赖以 package.json 和锁文件为准。
Arch 系统与包数据库应保持一致。

逐项核对 doctor 中 Node.js、FFmpeg、FFprobe、Chrome 四个核心项的结果。

## 使用

从 [工作台入口](../AGENTS.md) 按任务读取制作能力。新增技能使用当前 agent 的资源重载机制发现；上游参考的隔离约定见 [来源说明](../vendor/hyperframes/SOURCES.md)。

## 音频问答

从工作台根启动 pi，使其发现 `.pi/extensions/audio-understand/`；已有会话用 `/reload` 加载扩展。
将 [示例配置](../.pi/audio-understand.example.json) 复制为 `.pi/audio-understand.local.json`，填写模型与 base URL。密钥可直接填入 `apiKey`，或在启动 pi 的环境中设置 `apiKeyEnv` 指定的变量；非空 `apiKey` 优先。配置每次调用读取；环境变量变更需要重启 pi。本地配置已被 Git 忽略，含明文密钥时应限制文件读取权限。

服务须接受非流式 Chat Completions：`input_audio.data` 使用 Base64 Data URL，`format` 为 `wav` 或 `mp3`，返回完整文本答案。模型额外参数放在 `requestParams`；OpenAI-compatible 的声明本身不能保证音频兼容。

请求缓存位于 `.cache/audio-understand/`，含问题、回答和来源记录。命中时的用量属于原请求，本次复用没有远程调用。`cacheMaxAgeMs` 限制复用年龄，设为 `0` 强制重新请求；删除对应报告也可重新请求。缓存过期仅停止复用，磁盘清理由使用者决定。模型 alias 的服务端更新无法仅靠名称识别。

音频测试使用合成声音、本地文件和 HTTP 替身；pi 的实际加载及云端听音质量分别验证。测试沿用 Node 原生 TypeScript 支持，扩展运行由 pi 加载。

## 升级与排错

先检查正式版变更、弃用与兼容性，再更新依赖及 vendor 来源，复查受影响能力。
`npm run vendor:update` 需要 Git 和网络，将上游参考替换为最新正式版并更新来源；保留既有筛选规则。执行后审阅差异，确认参考与已安装工具兼容。
安全审计使用 `npm audit`。当前上游固定依赖存在告警；处理方案需另行核对兼容性。

调查事实见 [HyperFrames 上游能力](external/hyperframes-upstream.md)。
