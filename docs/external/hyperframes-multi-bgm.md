# HyperFrames 同一视频中的多首 BGM 与淡化切换

## 能力事实与限制摘要

**正式版已有多源排布、源片段截取、逐曲音量和线性淡入/淡出；重叠两个音频片段可组合交叉淡化，不必先建外部混音系统。** 这不是仅由 HTML 能放多个 `<audio>` 推出：下文核对了声明解析、预览 runtime、FFmpeg 混音和 MP4 封装。**未运行、渲染或试听**，不宣称听感自然、实际导出成功或所有预览路径完全等价。[声明文档][schema]、[混音执行源码][mixer]

本轮官方 latest 仍返回 **v0.9.23**（非 draft、非 prerelease，发布时间 `2026-11-08T07:05:54Z`）；tag ref 指向 **`7ad2be96ea1cdf6c1c5d3da7f3be20584c3a9f25`**。以下 HyperFrames 链接均固定到此正式 tag，不以 main 代替已发布能力；版本只作溯源，不是项目依赖要求。[release API][latest]、[tag ref][tag]

复用既有[工具调查](https://github.com/imagebuilder1837/video-workspace/blob/6d7d3d64c188929b7f8b3f3ce3b0787995b8b451/docs/external/video-toolchain.md)和[区间渲染核验](https://github.com/imagebuilder1837/video-workspace/blob/6d7d3d64c188929b7f8b3f3ce3b0787995b8b451/docs/external/hyperframes-range.md)，只补多曲切换事实；不改变“单首连续片段为首版必备、多曲不是必备”的既有约定，也不替使用者裁定首版范围。

## 1. 声明能表达什么

**文档明确支持＋执行源码确认，信心高：**

| 每个本地音频元素 | 已核实语义 |
| --- | --- |
| `src` | 各自指向项目音频文件；混音器解析源路径并检查文件存在，不只处理一首音乐。 |
| `data-media-start` | 源文件的入点，单位秒；不是视频摆放时间。 |
| `data-start`、`data-duration` | composition 内的摆放起点及播放长度，秒；默认速度下，源片段为入点起的这段长度。显式写 duration 最清楚，素材必须足够长，不把超出源尾当作自动补曲承诺。 |
| `data-volume` | 每个 clip 的线性增益，1 为 0 dB；文档上限 3.98（+12 dB），不是百分数。 |
| `data-fade-in`、`data-fade-out` | clip 开始后的淡入秒数、结束前的淡出秒数；线性增益，与基础音量/音量 automation 相乘。缺省无淡化；两段淡化时长之和超过 clip 长度时按比例缩短。 |

依据：[固定版 schema][schema]、[format 时间约定][format]、`parseAudioElements` / `extractAudioSegment` / `processCompositionAudio` [执行源码][mixer]、共享的 [audioFade.ts][fade]。后者直接实现 `elapsed / fadeIn`、`(duration - elapsed) / fadeOut` 及超长缩放，不是对任意淡化曲线或响度的保证。

**两种切换不能混称（源码组合推论，信心高；非实测）：**

- **顺序淡出后淡入：**A 在 10 秒结束，B 在 10 秒开始；A 的最后 2 秒淡出，B 的最初 2 秒淡入。两曲不同时发声，连接处降至静音。
- **重叠 crossfade：**A 在 10 秒结束，B 在 8 秒开始，二者的 2 秒淡出/淡入重合；混音器将同时有效的两路相加。这是已有 clip 参数的组合，不需要假定另有专用 crossfade 参数。线性增益交叉不等于等功率、恒定响度或自动对齐乐句；曲目内容和音量仍影响结果。[fade][fade]、`buildTrackInputFilter` 与 `amix` [混音源码][mixer]

## 2. 浏览器预览与 MP4 的真实路径

1. **普通 runtime 预览（执行源码确认，信心高）：**[media.ts][media] 收集每个媒体 clip 的起止、源入点、音量与 fades；同步时按活动窗口播放/暂停、计算源时间，并将 `fadeGain(timeSeconds - origin, …)` 乘到该元素音量上。源码还区分 Web Audio 所有权和 HTMLMedia fallback；不是浏览器默认 autoplay 自己决定时间。
2. **预览例外（源码解释，信心中）：**Player 在 `media-autoplay-blocked` 后可转交 [parent-media.ts][proxy] 的代理播放。该路径明确维护窗口、源入点和播放器总音量，但本轮检查的代理创建/更新/同步代码未见逐 clip `data-volume` 与 fades 的转发。**不能承诺这个回退路径与普通 runtime/导出同样淡化**；这是代码覆盖边界，不是已复现缺陷，也不外推为所有 Studio 预览失效。
3. **导出（执行源码确认，信心高）：**[renderMediaCollector.ts][collector] 从完整内联文档收集所有音频，转换为全局起止；[audioStage.ts][stage] 将 `composition.audios` 传给 `processCompositionAudio`。后者逐源按 `mediaStart` 和播放时长解码为 PCM，应用音量，生成 `afade`、`adelay` 和 `amix` 过滤图；淡化在片段本地时间做，延迟将它放回全片时间。最终经共享音频阶段产生 `audio.m4a`，全片 [assembleStage.ts][assemble] 调整音频长度并调用 `muxVideoWithAudio` 封装，非录制浏览器扬声器输出。
4. **不保证增益逐数值原样交付（源码确认）：**音频阶段有交付峰值保护/true-peak 检查，必要时降低交付电平；有源丢失、解码或混音失败时还有 `audioError` / `audioFailures`。不能把“视频文件生成了”当作所有 BGM 均已成功混入。[audioStage.ts][stage]

## 3. 局部时间、场景边界与区间导出

- **局部转全局（文档＋源码，高信心）：**媒体 `data-start` 局部于 composition，场景时钟在宿主 `data-start` 从 0 开始；collector 累加宿主 origin，并受宿主 slot 末端裁切，带场景入点时还会推进媒体源入点。因此“场景内 8 秒”不一定是全片 8 秒。场景宿主裁短 clip 会影响其最终结束边缘，不能把边缘淡出理解为永远锚在原始音频文件末尾。[format][format]、[collector][collector]
- **研究推论：**若音乐要跨段落重叠，声明在覆盖整个切换区间的共同上层 composition（例如根）更容易明确表达；分放在两个互不重叠、会裁切后代的场景 slot 内，不能仅把子 clip 写长就期待跨边界混合。这是时间窗口的推导，不是要求改变项目组织方式。[collector][collector]
- **跨切换点的区间 MP4（源码确认＋推论）：**[renderSpan.ts][span] 先建全项目 plan，再只渲染与所选区间相交的视频帧；[plan.ts][plan] 的 `mixPlanAudio` 使用同一全片音频阶段，之后 [chunkAudio.ts][chunk] 从 plan-wide AAC 按区间取包、封装。因此截取 9–11 秒时，应保留原全局切换进度，而不是在输出 0 秒重新启动每首曲的淡入。此“不会重置”的判断来自路径组合，仍待成品验证。接口限 MP4、SDR、24/25/30/60 fps，秒数四舍五入为帧，输出从 0 起；AAC 按包截取，不承诺音频样本级切口。详见既有[区间报告](https://github.com/imagebuilder1837/video-workspace/blob/6d7d3d64c188929b7f8b3f3ce3b0787995b8b451/docs/external/hyperframes-range.md)。

## 4. 最小声明示例（未执行）

放在项目根 composition 内；需已有可读取、长度足够的本地文件。A 使用源 20–30 秒，放全片 0–10 秒；B 使用源 5–15 秒，放全片 8–18 秒；8–10 秒交叉淡化。不同 track index 避免同一 Studio lane 的重叠约束；它不是混音总线编号。[core 格式文档][core]、[mixer][mixer]

```html
<audio id="bgm-a" src="assets/music-a.mp3"
  data-start="0" data-duration="10" data-media-start="20"
  data-track-index="0" data-volume="0.35" data-fade-out="2"></audio>
<audio id="bgm-b" src="assets/music-b.mp3"
  data-start="8" data-duration="10" data-media-start="5"
  data-track-index="1" data-volume="0.35" data-fade-in="2"></audio>
```

若只要顺序切换，把 B 的 `data-start` 改为 `10`，并让 composition 总时长覆盖到 20 秒即可。示例只说明属性组合，不是已跑通的完整视频项目。

**必要的 FFmpeg 补充成本（研究判断）：**上述基本两类切换没有查到必须外接混音的缺口。若真实需求另要求可选淡化曲线，FFmpeg 原生 [`acrossfade`][ffmpeg] 已有时长、是否重叠及两侧曲线选项；补充会增加一份音频时间/源截取说明、一次音频过滤编码与最终封装/校验，而非必须开发多轨编辑器。本轮不设计这条额外流程，不把它定为必需。

## 实际项目待验证项与证据边界

- 获准运行后，用真实本地曲目核对全片及跨切换点区间：源入点、淡化进度、重叠处电平、首尾 AAC 边界和音画位置；由人试听决定衔接是否合适。
- 同时核对普通预览和自动播放受阻后的代理回退；跨 composition 裁切、场景入点及不足长度素材尤其需要针对性验证。简单示例未使用 loop，不外推循环相位正确性。
- 未核对 npm 包与 tag 的逐文件一致性、宿主机依赖和浏览器兼容性；没有安装工具、播放、渲染、调用媒体云服务或性能测试。
- 依据为官方 release/API、正式 tag 的文档与执行源码，以及 FFmpeg 官方过滤器文档；动态 main 搜索摘要仅用于定位，不作为正式发布能力的证明。预览回退覆盖、实际导出及听感仍待实测。

[latest]: https://api.github.com/repos/heygen-com/hyperframes/releases/latest
[tag]: https://api.github.com/repos/heygen-com/hyperframes/git/ref/tags/v0.9.23
[schema]: https://github.com/heygen-com/hyperframes/blob/v0.9.23/docs/reference/html-schema.mdx
[format]: https://github.com/heygen-com/hyperframes/blob/v0.9.23/skills/hyperframes/references/format.md
[core]: https://github.com/heygen-com/hyperframes/blob/v0.9.23/packages/core/docs/core.md
[fade]: https://github.com/heygen-com/hyperframes/blob/v0.9.23/packages/core/src/audioFade.ts
[media]: https://github.com/heygen-com/hyperframes/blob/v0.9.23/packages/core/src/runtime/media.ts
[proxy]: https://github.com/heygen-com/hyperframes/blob/v0.9.23/packages/player/src/parent-media.ts
[mixer]: https://github.com/heygen-com/hyperframes/blob/v0.9.23/packages/engine/src/services/audioMixer.ts
[collector]: https://github.com/heygen-com/hyperframes/blob/v0.9.23/packages/producer/src/services/renderMediaCollector.ts
[stage]: https://github.com/heygen-com/hyperframes/blob/v0.9.23/packages/producer/src/services/render/stages/audioStage.ts
[assemble]: https://github.com/heygen-com/hyperframes/blob/v0.9.23/packages/producer/src/services/render/stages/assembleStage.ts
[plan]: https://github.com/heygen-com/hyperframes/blob/v0.9.23/packages/producer/src/services/distributed/plan.ts
[span]: https://github.com/heygen-com/hyperframes/blob/v0.9.23/packages/producer/src/services/distributed/renderSpan.ts
[chunk]: https://github.com/heygen-com/hyperframes/blob/v0.9.23/packages/producer/src/services/distributed/chunkAudio.ts
[ffmpeg]: https://ffmpeg.org/ffmpeg-filters.html#acrossfade
