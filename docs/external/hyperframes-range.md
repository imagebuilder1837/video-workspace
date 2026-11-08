# HyperFrames 正式版任意区间渲染核验

## 结论

**支持，但有格式与帧率限制。** 本轮官方 `releases/latest` 返回正式版 **v0.9.23**；对应 tag 的 CLI、区间执行源码和第一方周报共同证明：`hyperframes render --start <秒> --end <秒>` 能直接输出所选全局时间跨度的连续 MP4，输出从 0 开始并携带该跨度的音频，**不要求先渲染整部视频再外部截片**。不是只有 snapshot 采样或 composition 单独渲染。（直接证据，高信心；未运行验证。）

示例仅用于说明参数，本轮没有执行：

```text
npx hyperframes render ./my-video --start 5 --end 12 --fps 30 --format mp4 --sdr --output clip.mp4
```

该例选择项目入口时间轴 5–12 秒；不是把 `5`、`12` 当帧号。版本/提交标识仅为本次事实溯源，不是要求项目锁死依赖版本。

## 1. 正式发布身份与证据绑定

- [官方 latest API](https://api.github.com/repos/heygen-com/hyperframes/releases/latest) 本轮读取：`"tag_name":"v0.9.23"`、`"draft":false`、`"prerelease":false`，`published_at` 为 **2026-11-08T07:05:54Z**。这是 API 的发布时间，不冒充本轮精确抓取时间。[正式 release](https://github.com/heygen-com/hyperframes/releases/tag/v0.9.23)
- [tag ref API](https://api.github.com/repos/heygen-com/hyperframes/git/ref/tags/v0.9.23) 指向 commit **`7ad2be96ea1cdf6c1c5d3da7f3be20584c3a9f25`**，对象类型为 `commit`。下文正文来源均取该 tag，不把 main 上可能尚未发布的功能算入正式版。
- [该 tag 第一方周报的 Render controls](https://github.com/heygen-com/hyperframes/blob/v0.9.23/docs/weekly-updates.mdx) 明说： “`renders only that span of the film, with its audio, as an MP4 that starts at 0`”，并追溯实现提交 **[`5a164fb3693d522ef163570bde82b10af47d2322`](https://github.com/heygen-com/hyperframes/commit/5a164fb3693d522ef163570bde82b10af47d2322)**。本轮不另推断最早包含它的 release。

## 2. 确切参数、单位与帧边界

**直接证据，高信心：**[CLI render 命令源码](https://github.com/heygen-com/hyperframes/blob/v0.9.23/packages/cli/src/commands/render.ts) 已注册 `start`、`end`：

> `Render from this second of the film (MP4). The clip starts at 0 and carries the audio of the span.`

> `Render up to this second of the film (default: the end).`

[同 tag CLI 文档 render 节](https://github.com/heygen-com/hyperframes/blob/v0.9.23/docs/packages/cli.mdx#render) 也列出 `--start`, `--end`，说明 “`MP4 at 24, 25, 30 or 60 fps, SDR only.`”

[参数解析 plan.ts](https://github.com/heygen-com/hyperframes/blob/v0.9.23/packages/cli/src/commands/render/plan.ts) 与 [renderSpan.ts](https://github.com/heygen-com/hyperframes/blob/v0.9.23/packages/producer/src/services/distributed/renderSpan.ts) 进一步明确：

| 项目 | 已核实语义 |
| --- | --- |
| 输入单位 | 非负有限数字秒，可含小数；不是帧编号或 `hh:mm:ss` 字符串解析接口。 |
| 省略参数 | 只给 `--end` 时 start 为 0；只给 `--start` 时 end 为全片末尾；两者均省略走整片渲染。 |
| 区间要求 | end 必须大于 start；换算后必须至少有一帧，否则报错。 |
| 帧换算 | `startFrame = Math.round(startSeconds * fps)`；end 同样四舍五入，并以总帧数为上限。 |
| 包含关系 | 源码定义 `[startFrame, endFrame)`，即起点包含、终点不包含；不是任意亚帧精度切口。 |
| 输出限制 | MP4、SDR，整数 24/25/30/60 fps；不支持此区间接口配 WebM/MOV/GIF/PNG sequence/HLS 或其他/分数帧率，拒绝 `--hdr`。renderSpan 还拒绝内部 `config.cfr === true` 的重编码组合。 |

**研究推导：**如要表达固定帧率下的帧区间 `[a,b)`，可把 a/fps、b/fps 换算成数字秒传入，并按上述取整规则理解；本轮所查 CLI 没有专用 `--frames` 区间参数。对于含 HDR 素材的项目，示例显式用 `--sdr`，不承诺自动模式一定适用。

## 3. 为什么不是“整片视频渲完再截”及音频边界

**直接证据，高信心：**[render.ts](https://github.com/heygen-com/hyperframes/blob/v0.9.23/packages/cli/src/commands/render.ts) 检测 `options.range` 后进入 `renderRange()`，调用 producer 的 `renderSpan(...)`。

[renderSpan.ts](https://github.com/heygen-com/hyperframes/blob/v0.9.23/packages/producer/src/services/distributed/renderSpan.ts) 先做 plan，然后把每个 chunk 与选定区间取交集：

> `startFrame: Math.max(slice.startFrame, startFrame)`
>
> `endFrame: Math.min(slice.endFrame, endFrame)`
>
> `await renderChunk(planDir, slice.index, part, { frameRange: range });`

空交集直接跳过，最后 `writeStitchedMp4(parts, outputPath)`。这证明捕获/编码调用面向区间子范围，而不是先产生整片视频再截。**不等于所有准备工作也只处理区间**：它仍先对项目做 plan，源码还明确使用 `chunksCarryAudio: true`；不能据此推断速度、内存或全片准备成本。

**直接证据／音频实现：**[chunkAudio.ts](https://github.com/heygen-com/hyperframes/blob/v0.9.23/packages/producer/src/services/distributed/chunkAudio.ts) 注释描述 “`AAC packets of the one plan-wide encode that start inside the chunk's frame range`”；`chunksWithSubRange()` 将子范围作为 chunk 处理，mux 使用 `-c copy` 及按包选择的 seek/时长。它不是“完全不用 FFmpeg”，而是 CLI 内部已有音频封装流程，无需使用者先渲整片视频后外部截取。

**研究判断／音频精度边界：**随片段携带音频有明确一手证据；但该实现按 AAC 包归属切音频，不能提升为“任意起止点音频样本级精确无偏差”的保证。实际片头/片尾听感、包边界与音画对齐未实测。

## 4. 三类能力不可混用；文档差异

| 能力 | 本轮判定与来源 |
| --- | --- |
| `snapshot --at` / `snapshot --range` | 时间点/范围内的静帧采样，非带音频连续视频。[同 tag snapshot 文档](https://github.com/heygen-com/hyperframes/blob/v0.9.23/docs/packages/cli.mdx#snapshot) |
| `render -c compositions/intro.html` | 选择 composition 文件作为渲染入口，不等于从项目全局时间轴任意截区间。[同 tag render 源码](https://github.com/heygen-com/hyperframes/blob/v0.9.23/packages/cli/src/commands/render.ts) |
| `render --start … --end …` | 本题所问连续区间视频，已在正式 tag 核实；默认入口为项目 index.html，无需先拆独立场景。上述 render 文档及 renderSpan 源码直接支持。 |

**实际文档不齐：**[同 tag skill 的 preview-render.md 参数表](https://github.com/heygen-com/hyperframes/blob/v0.9.23/skills/hyperframes-cli/references/preview-render.md) 没有列 `--start` / `--end`，但同 tag 完整 CLI 文档、命令注册与执行代码均有。不能用简表遗漏否定能力；本次仅核验该正式发布版已包含此能力，不推断最早引入它的 release。未发现这些已核实来源对能力本身的直接矛盾。

## 未实测与核验范围

- 本轮只读本地技能/既有调查及官方 API、对应 tag 文档与源码；没有安装依赖、运行 HyperFrames/FFmpeg、克隆代码、执行 git/gh、上传素材或写 issue；只写本指定临时报告，未修改仓库及 GLOSSARY.md。
- `source_check` 已调用，返回 `unclear`，理由是自动语义评估不可用；其检索命中 main 周报。本报告不把其自动结果或 main 摘要当正式版证明，而人工核对已抓取的 v0.9.23 原文及执行源码。来源读取未遇到中断。
- 未验证 npm 分发包与 tag 的逐文件一致性、本机可运行性、渲染成品、各类素材/音频特殊情形、Docker 组合或性能。latest 是动态端点，日后需重查；这里没有把当前 main 的状态纳入承诺。
- 如需求超出已证范围（例如区间直接输出非 MP4、分数帧率、HDR），不能把这个“支持”结论外推。既有可用替代仍是整片导出后截片，或在需求本来就是独立场景时渲染指定 composition；本轮不另研究替代工具或决定路线。

**唯一有用的后续实测：**获得运行授权后，用一个跨场景、带持续音乐的短区间核对输出首末帧与音频边界；本轮不执行。
