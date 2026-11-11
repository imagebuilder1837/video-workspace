# HyperFrames 环境差异

以下事实核对自官方 [v0.9.26](https://github.com/heygen-com/hyperframes/releases/tag/v0.9.26) 的源码与同版安装包；版本用于溯源，实际安装或更新后需重测。

## 共享执行与浏览器

- CLI 的项目 `.env` 白名单仅覆盖部分变量；媒体 home、浏览器和更新控制需要父进程环境。[dotenv](https://github.com/heygen-com/hyperframes/blob/v0.9.26/packages/cli/src/utils/dotEnv.ts)
- CLI 用 `HYPERFRAMES_BROWSER_PATH` 选择本地浏览器；`bake-basemap.mjs` 辅助脚本用 `CHROME`，且从脚本位置解析 `puppeteer-core`。外置技能的 Node 模块依赖需按实际安装位置验收。[浏览器](https://github.com/heygen-com/hyperframes/blob/v0.9.26/packages/cli/src/browser/manager.ts#L308-L435) · [地图脚本](https://github.com/heygen-com/hyperframes/blob/v0.9.26/skills/hyperframes/scripts/bake-basemap.mjs)
- Windows Edge 经 localhost 查看 WSL 预览，与 CLI 在 Linux 启动 Chromium 是两条路径。CLI 的 `puppeteer.launch` 使用本地 executable 与 pipe。[WSL 网络](https://learn.microsoft.com/en-us/windows/wsl/networking#accessing-linux-networking-apps-from-windows-localhost) · [CLI 启动](https://github.com/heygen-com/hyperframes/blob/v0.9.26/packages/cli/src/browser/launch.ts#L160-L177)
- `plugin-cli.mjs` 普通分支执行 `npx --yes hyperframes@<插件版本>`；独立技能安装缺少插件 manifest 时会报错。该路径可能触发另一份 CLI 的获取。[插件入口](https://github.com/heygen-com/hyperframes/blob/v0.9.26/skills/hyperframes/scripts/plugin-cli.mjs)

## 媒体库覆盖

`HYPERFRAMES_MEDIA_HOME` 是父目录，上游 `globalMediaDir()` 在其下追加 `.media/`。媒体引擎的素材、manifest、偏好和配方使用该范围。[路径](https://github.com/heygen-com/hyperframes/blob/v0.9.26/skills/media-use/scripts/lib/media-home.mjs) · [缓存与提升](https://github.com/heygen-com/hyperframes/blob/v0.9.26/packages/cli/src/media-use/lib/cache.mjs)

同版预览服务器的 `readGlobalAssets(home = homedir())` 及全局素材列表路由直接读取用户 home 下的 `.media/manifest.jsonl`，忽略上述覆盖。预览全局列表与项目内素材预览应分开验收，媒体引擎通过不能证明前者可见。[全局素材路由](https://github.com/heygen-com/hyperframes/blob/v0.9.26/packages/studio-server/src/routes/globalAssets.ts)

媒体引擎的本地导入会尽力提升全局缓存；项目内原地登记及 `--adopt` 仅登记项目素材。CLI 的媒体包装层在启动引擎前可能检查／刷新 OAuth；`--local-only` 下的显式 URL 导入仍可联网。隔离验收应使用合成素材、临时库和直接引擎路径，分别核对登记与跨项目复用结果。[引擎](https://github.com/heygen-com/hyperframes/blob/v0.9.26/skills/media-use/scripts/resolve.mjs) · [接管](https://github.com/heygen-com/hyperframes/blob/v0.9.26/packages/cli/src/media-use/lib/adopt.mjs)

## 音频与外联

- `audio --quality fast` 与独立 `beats` 使用本地 signal 方法；节拍与段落是候选。`audio --read --quality local` 在具备缓存／服务条件时仍可能调用远程描述。[provider ladder](https://github.com/heygen-com/hyperframes/blob/v0.9.26/packages/core/src/audioAnalysisLadder.ts) · [read](https://github.com/heygen-com/hyperframes/blob/v0.9.26/packages/cli/src/audio/read/read.ts) · [描述接口](https://github.com/heygen-com/hyperframes/blob/v0.9.26/packages/cli/src/audio/read/describe.ts)
- 媒体初始化 `--audio/--video` 可触发转录；`--skip-transcribe` 用于跳过该步骤。best 音频分析、分 stems、生成／转录、云渲染及 publish 各有外传路径。[初始化](https://github.com/heygen-com/hyperframes/blob/v0.9.26/skills/hyperframes-cli/references/init-and-scaffold.md)
- `HYPERFRAMES_NO_TELEMETRY=1`、`DO_NOT_TRACK=1` 用于遥测 opt-out，`HYPERFRAMES_NO_UPDATE_CHECK=1` 控制更新检查，`HYPERFRAMES_SKIP_SKILLS=1` 让技能由外部管理。[CLI 说明](https://github.com/heygen-com/hyperframes/blob/v0.9.26/skills/hyperframes-cli/references/upgrade-info-misc.md) · [媒体遥测](https://github.com/heygen-com/hyperframes/blob/v0.9.26/skills/media-use/scripts/lib/telemetry.mjs)
