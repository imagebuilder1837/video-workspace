# HyperFrames 上游能力与依赖

本文依据官方正式发布 [v0.9.26][release] 的文档与源码，不作为本机制作通路的验证记录；tag 仅用于事实溯源，不是依赖版本要求。

## Skills

Skills 是 agent 指引、参考资料及部分辅助脚本，不是九个必装运行时。初始化可用 `--skip-skills` 避免自动安装技能包。[初始化说明][init]

| Skill | 具体内容 | 复用时需要区分的边界 |
| --- | --- | --- |
| [hyperframes][authoring] | HTML/composition、素材、可定位时间线；故事方案、量化设计、检查、预览与交付 | 技术契约与创作默认分开；默认尺寸、三故事线、审美建议不是引擎硬约束 |
| [hyperframes-cli][cli] | 初始化、timeline、lint/check、抽帧、预览、本地导出、音频，以及 history/发布/云部署 | 本地制作不依赖云部署、账号用量查询或主动反馈 |
| [hyperframes-registry][registry] | 搜索并下载可编辑的场景 block、字幕/图表/转场等 component | 搜索在本地计算，清单和安装文件需下载；语义排名模型可选，另有主动反馈命令 |
| [media-use][media] | 复用/导入/搜索/生成素材，本地处理、调色、混音、转录与抠像；素材台账与缓存 | 本地工具、素材管理约定、远程服务是不同部分；生成或转录的依赖与费用按实际 provider 判断 |
| [figma][figma] | 从 Figma 导出图像/tokens，重建 HTML，转换 motion connector 并比较结果 | 需要可访问的设计文件与 token；渲染成片不再依赖 Figma API |
| [slideshow][slides] | 可交互演示、分支、逐步显示、演讲者 notes、观众/演讲者页面 | 产物是现场演示，不等同于直接导出完整 MP4 |
| [remotion-to-hyperframes][migration] | 原生翻译帧函数，或保留其他 runtime 接 HyperFrames 时钟，或导入已渲染媒体；逐帧比较 | 三条路径保留的编辑粒度不同；只在存在待迁移内容时触发 |
| [reverse-any-video][reverse] | 测量参考视频、重建图形/运动、裁取素材、比较重建结果 | 官方完整入口含 Pro/服务能力；人物重拍可能上传参考与音频，不是纯本地反向编译 |
| [style-sampling][styles] | 五类频道/系列模板，包含脚本、分镜、声音、素材、草稿和交付约定 | 官方模板获取需 Pro 与联网校验；后续生成可能计费，模板内部附加依赖未拉取核验 |

九份正文均含 usage beacon 指令；部分还要求 usage/auth/feedback。它们不是本地渲染的技术前提。是否采用某项内容与是否原样启用整份 skill 是两个问题。

## 核心创作与执行参考

| 参考 | 实际要求或产物 |
| --- | --- |
| [story][story] | 明确观众、核心表达与事实依据；适用的叙事片从多个想法选出三种故事方案，保存 `STORYLINES.md`。已有脚本/分镜、小改和短单点作品有例外 |
| [spec][spec] | 在制作场景前保存 `SPEC.md`，量化尺寸/fps、字体、色值、motion、逐镜帧范围、阅读窗口、声音、禁用套路及 QA 帧 |
| [review][review] | check、场景/切点/手机宽度图集、关键运动抽帧、音频测量；按严重性列问题，写 `REVIEW.md`；明确测过音频不等于听过 |
| [format][format] | root/scene 格式、clip 时间区间、素材与字体、媒体与音频属性、可编辑变量、布局检查豁免 |
| [runtimes][runtimes] | 暂停时间线、按时间恢复状态；其他动画 runtime 的 seek 与异步绘图契约；只在实际使用时增加对应 runtime |
| [motion][motion]、[sound][sound] | 曲线、阅读时间、镜头与转场、音乐/音效和同步建议；不是任意作品必须遵守的审美结论 |

三故事线、完整逐镜规格、额外台账、固定审美默认等属于上游流程选择，不应误称为技术上不能复用。格式、时间线及执行接口也不能因为流程不同就一并舍弃。

## 本地制作依赖

| 项目 | 用途与安装影响 |
| --- | --- |
| Node.js/npm | CLI 运行环境；满足发布包的 engines 要求仍不代表已经验证实际兼容性 |
| `hyperframes` npm 包 | 正式发布包名；包含 CLI 和制作协调能力。不要求安装整个 monorepo，其正常 npm 依赖随包解析 |
| GSAP 浏览器运行时 | CLI 构建会附带 core 和部分插件；普通时间线不因此需要另装动画库。原生 blank 的 CDN 标签仍需按实际加载路径处理，不能据随包文件存在承诺所有预览/导出均离线。[构建复制规则](https://github.com/heygen-com/hyperframes/blob/v0.9.26/packages/cli/scripts/build-copy.mjs#L70-L98) |
| FFmpeg 与 ffprobe | 探测、解码、抽帧、编码和混音；官方支持系统安装或显式二进制路径，不是 npm 自动附带的完整工具对 |
| Chromium 系浏览器 | check/snapshot/render 使用；可复用兼容浏览器，或由 `browser ensure` 下载管理的浏览器缓存 |
| Linux 共享库 | 浏览器的系统依赖，按实际缺失项及发行版处理；上游完整包名映射不等于本机都缺失 |
| 中文字体 | 应明确实际字体文件与字重；本地 `@font-face` 可避免隐式远程字体依赖。字体可见不等于视频项目已正确加载 |

依据：[发布包元数据][npm]、[浏览器与 FFmpeg 文档][doctor]、[Linux 库映射][linux]、[字体约定][format]。

Arch 官方 `chromium` 包提供 `/usr/bin/chromium`，依赖由 pacman 解析；不必手工安装一串浏览器共享库。HyperFrames 允许普通 Chromium 的 screenshot 回退，不要求一定使用优化 headless-shell。[Arch 包与依赖](https://archlinux.org/packages/extra/x86_64/chromium/) · [文件列表](https://archlinux.org/packages/extra/x86_64/chromium/files/) · [浏览器选择与回退](https://github.com/heygen-com/hyperframes/blob/v0.9.26/packages/cli/src/browser/manager.ts#L308-L435)

HyperFrames 自管浏览器默认位于 `~/.cache/hyperframes/chrome`；`HYPERFRAMES_CACHE_DIR` 可改变整个缓存根，并非仅改变浏览器位置。自管缓存可重建，与借用其他项目遗留缓存不同，但仍不是系统包安装。[缓存根实现](https://github.com/heygen-com/hyperframes/blob/v0.9.26/packages/core/src/cacheDir.ts#L1-L11)

普通本地渲染和 signal 音频测量不要求 Python、Beat This、Whisper、TTS、生成模型、Docker 或 HeyGen 账号。媒体初始化的 `--audio/--video` 默认可触发转录；`--skip-transcribe` 可避免这条隐式依赖链。[初始化说明][init]

## 最小项目与共享工具

本地 CLI 显式指定目录执行 preview/check/render 时，默认要求项目目录及有效的 `index.html` composition、实际引用的素材和动画。无需先运行 init，也不要求每项目具有 package.json、meta.json 或 hyperframes.json；缺配置时使用内存默认。各项目可调用同一份已安装 CLI，不需要逐项目安装工具。[目录解析](https://github.com/heygen-com/hyperframes/blob/v0.9.26/packages/cli/src/utils/project.ts#L31-L67) · [配置默认](https://github.com/heygen-com/hyperframes/blob/v0.9.26/packages/cli/src/utils/projectConfig.ts#L214-L236) · [显式预览项目](https://github.com/heygen-com/hyperframes/blob/v0.9.26/packages/cli/src/server/studioServer.ts#L510-L540)

这与自动扫描不同：自动发现要求 index.html 加 hyperframes.json、meta.json、project.json 中任一 marker，不应把该条件推广到显式 CLI 路径。工具运行仍可能生成缓存或产物；最小输入不代表运行后的目录只剩一个文件。[自动发现规则](https://github.com/heygen-com/hyperframes/blob/v0.9.26/packages/core/src/projectRule.ts#L1-L7)

## Windows Edge 与 WSL

Windows Edge 可通过 localhost 访问 WSL 内的预览服务，实际连通性仍取决于网络配置。[Microsoft WSL 网络说明](https://learn.microsoft.com/en-us/windows/wsl/networking#accessing-linux-networking-apps-from-windows-localhost)

这不等于跨系统渲染支持：所引版本的 HyperFrames 将 `HYPERFRAMES_BROWSER_PATH` 作为 executable，使用 `puppeteer.launch` 和 `pipe: true`，未找到正式的远程 CDP 接入入口。不能仅凭 WSL 可执行 Windows 程序，就保证 Linux Node 能驱动 Windows Edge 完成 check/snapshot/render；同系统的兼容浏览器或官方管理浏览器才是已有执行路径。[浏览器选择](https://github.com/heygen-com/hyperframes/blob/v0.9.26/packages/cli/src/browser/manager.ts#L308-L315) · [CLI 启动](https://github.com/heygen-com/hyperframes/blob/v0.9.26/packages/cli/src/browser/launch.ts#L160-L177) · [渲染引擎启动](https://github.com/heygen-com/hyperframes/blob/v0.9.26/packages/engine/src/services/browserManager.ts#L916-L932)

Microsoft Edge 本身支持通过调试端口/WebSocket 远程 CDP 连接；Chrome DevTools MCP 的 `--autoConnect` 也连接已运行浏览器的远程调试服务。因此 MCP 可连接不代表 HyperFrames 的跨系统 launch/pipe 也可用，亦不代表 Edge 不支持自动化。[Edge DevTools Protocol](https://learn.microsoft.com/en-us/microsoft-edge/devtools/protocol/) · [MCP 连接选项](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/configuration.md)

## 音频与外联边界

- `audio --quality fast` 的 provider ladder 只使用 signal 方法；独立 `beats` 命令直接运行本地 signal 算法，不要求专门模型。节拍与段落仍是候选，不代表听感或创作选择。[ladder][ladder] · [beats 实现][beats]
- `audio --read` 有可读 TXT/JSON 与内容哈希缓存，但不自动得到可靠的语义听音能力；缺转录或分离素材时应保留未知。[read 实现][read]
- **不能笼统声称 `audio --read --quality local` 不上传**：`stemsFor()` 先复用缓存 stems，`described()` 仅对 fast 提前返回；local 在相应缓存/服务可用条件下仍可调用远程描述接口。此项为源码控制流证据，不是运行复现。[read 实现][read] · [描述接口][describe]
- best 音频分析、分 stems、媒体生成/转录、云渲染与 publish 是不同的外传路径；权限、费用与服务端数据条款不能由本地源码概括保证。
- registry 的词汇搜索不要求模型；可选 on-device 语义模型需另行下载。安装 component 需要下载源码，主动 feedback 是另一条发送查询的操作。[搜索说明][search]
- `HYPERFRAMES_NO_TELEMETRY=1` 可关闭 CLI 用量遥测；media-use 另尊重 `DO_NOT_TRACK=1`。更新检查有独立开关 `HYPERFRAMES_NO_UPDATE_CHECK=1`。这些开关不关闭字体、浏览器、registry 下载或主动上传。[遥测说明][telemetry]

未穷尽审计传递依赖、所有下载主机或实际网络流量；不据此承诺完全离线。上游参考也有漂移：例如 beats 零结果不应只按退出码判断，画面前后顺序以当前 core 的 CSS z-index 契约为准。

[release]: https://github.com/heygen-com/hyperframes/releases/tag/v0.9.26
[authoring]: https://github.com/heygen-com/hyperframes/blob/v0.9.26/skills/hyperframes/SKILL.md
[cli]: https://github.com/heygen-com/hyperframes/blob/v0.9.26/skills/hyperframes-cli/SKILL.md
[registry]: https://github.com/heygen-com/hyperframes/blob/v0.9.26/skills/hyperframes-registry/SKILL.md
[media]: https://github.com/heygen-com/hyperframes/blob/v0.9.26/skills/media-use/SKILL.md
[figma]: https://github.com/heygen-com/hyperframes/blob/v0.9.26/skills/figma/SKILL.md
[slides]: https://github.com/heygen-com/hyperframes/blob/v0.9.26/skills/slideshow/SKILL.md
[migration]: https://github.com/heygen-com/hyperframes/blob/v0.9.26/skills/remotion-to-hyperframes/SKILL.md
[reverse]: https://github.com/heygen-com/hyperframes/blob/v0.9.26/skills/reverse-any-video/SKILL.md
[styles]: https://github.com/heygen-com/hyperframes/blob/v0.9.26/skills/style-sampling/SKILL.md
[init]: https://github.com/heygen-com/hyperframes/blob/v0.9.26/skills/hyperframes-cli/references/init-and-scaffold.md
[story]: https://github.com/heygen-com/hyperframes/blob/v0.9.26/skills/hyperframes/references/story.md
[spec]: https://github.com/heygen-com/hyperframes/blob/v0.9.26/skills/hyperframes/references/spec.md
[review]: https://github.com/heygen-com/hyperframes/blob/v0.9.26/skills/hyperframes/references/review.md
[format]: https://github.com/heygen-com/hyperframes/blob/v0.9.26/skills/hyperframes/references/format.md
[runtimes]: https://github.com/heygen-com/hyperframes/blob/v0.9.26/skills/hyperframes/references/runtimes.md
[motion]: https://github.com/heygen-com/hyperframes/blob/v0.9.26/skills/hyperframes/references/motion.md
[sound]: https://github.com/heygen-com/hyperframes/blob/v0.9.26/skills/hyperframes/references/sound.md
[npm]: https://registry.npmjs.org/hyperframes/0.9.26
[doctor]: https://github.com/heygen-com/hyperframes/blob/v0.9.26/skills/hyperframes-cli/references/doctor-browser.md
[linux]: https://github.com/heygen-com/hyperframes/blob/v0.9.26/packages/cli/src/browser/linuxDeps.ts
[ladder]: https://github.com/heygen-com/hyperframes/blob/v0.9.26/packages/core/src/audioAnalysisLadder.ts
[beats]: https://github.com/heygen-com/hyperframes/blob/v0.9.26/packages/cli/src/commands/beats.ts
[read]: https://github.com/heygen-com/hyperframes/blob/v0.9.26/packages/cli/src/audio/read/read.ts
[describe]: https://github.com/heygen-com/hyperframes/blob/v0.9.26/packages/cli/src/audio/read/describe.ts
[search]: https://github.com/heygen-com/hyperframes/blob/v0.9.26/skills/hyperframes-registry/references/search.md
[telemetry]: https://github.com/heygen-com/hyperframes/blob/v0.9.26/skills/hyperframes-cli/references/upgrade-info-misc.md
