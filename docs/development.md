# 开发与环境

## 准备

沿用 WSL Arch Linux 执行工具，Windows Edge 查看本地预览。系统依赖由使用者安装和维护：

```sh
sudo pacman -S --needed ffmpeg chromium
npm ci
npm run hf -- doctor --json
```

Node/npm 满足 HyperFrames 包的 engines 要求即可；实际依赖以 package.json 和锁文件为准。
Arch 系统与包数据库应保持一致，不做 `pacman -Sy` 后单独安装形成的部分升级。

doctor 的 Node.js、FFmpeg、FFprobe、Chrome 是本路径的核心项；可选模型、Docker 等缺失不要求补装，退出码或顶层 ok 也不能替代逐项判断。

## 使用

从 [工作台入口](../AGENTS.md) 按任务读取制作能力。新增技能使用当前 agent 的资源重载机制发现；上游参考的隔离约定见 [来源说明](../vendor/hyperframes/SOURCES.md)。

## 升级与排错

先检查正式版变更、弃用与兼容性，再更新依赖及 vendor 来源，复查受影响能力；不在一次产物生成与检查之间换版。
`npm run vendor:update` 需要 Git 和网络，将上游参考替换为最新正式版并更新来源；保留既有筛选规则，不升级 npm 依赖。执行后审阅差异，确认参考与已安装工具兼容。
安全审计使用 `npm audit`。当前上游固定依赖存在告警，未用 force 自动降级或覆盖；处理方案需另行核对兼容性。

调查事实见 [HyperFrames 上游能力](external/hyperframes-upstream.md)；文档／源码支持不等于本机制作已验证。
