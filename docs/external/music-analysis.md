# 已有音乐的节奏与氛围分析能力

查询日期：2026-11-08（UTC，主代理宿主机系统时钟；不是来源发布日期）。对应 [Agent 能怎样可靠利用已有音乐的节奏与氛围？](https://github.com/imagebuilder1837/video-workspace/issues/3)、[厘清 agent 视频制作工作台的首版规格](https://github.com/imagebuilder1837/video-workspace/issues/1)；票正文由主代理通过 gh 读取提供。本报告记录调查事实与限制，不是实施计划或工具选型。

## Summary

Agent 可把已有音乐转换为时长、能量曲线、起音与节拍候选、下拍候选和结构变化候选；这些信号的可靠程度不同，不能将数值时间网格当成实际识别精度。氛围模型和支持音频输入的多模态模型能提供描述性假设，但是否好听、是否符合内容、应同步到什么强度，仍需要人实际试听决定；普通 coding agent 若只有文本和图片，不等于听过音乐。

本次仅阅读一手文档、源码和论文，没有安装依赖、下载权重、调用付费模型、配置凭证、开服务、分析具体音乐或制作视频；没有比较本机速度与准确率。范围只有已有音乐、无配音的代码驱动视频，不涉及配音、作曲、歌曲生成、专业混音、通用扩展框架或博客素材准备。

## Findings

### 1. 必须先区分要得到的时间信息

**Claim：** 起音（onset）是音符/声音事件开始的候选；节拍（beat）是音乐脉冲位置；下拍（downbeat）是小节开始；段落边界是更长尺度的结构变化，彼此不能替代。特别是“起拍”可能指音频开始、首次可听起音、首次完整节拍或小节第一拍，交给 agent 的时间数据不能只写一个无定义的“起拍”。**Sources：** [librosa onset_detect](https://librosa.org/doc/0.11.0/generated/librosa.onset.onset_detect.html)、[beat_track](https://librosa.org/doc/0.11.0/generated/librosa.beat.beat_track.html)、[Beat This! 论文，ISMIR 2024，§1](https://arxiv.org/html/2407.21658v1)、[agglomerative](https://librosa.org/doc/0.11.0/generated/librosa.segment.agglomerative.html)。**Support：** 前三项定义为直接证据；中文“起拍”歧义及数据需明确命名为研究者解释。**Confidence：** 高。

**决策影响（研究者推论）：** 单个 BPM 不含第一拍相位，也不含下拍和段落；不能仅由 BPM 从文件零点机械排出整曲切点。弱起、片头静音、渐入以及中途变速，会让这种假设更危险。下拍也不是“最大音量的一下”，一个段落可能跨很多小节。

### 2. 本地信号分析：librosa 能提供可检查的数值，但不保证音乐理解

**Claim：** librosa 0.11.0 的输入可以是本地文件或解码后的波形与采样率；能返回以下结果。**Sources：** 各行链接为官方文档。**Support：** 直接证据；表中“限制/影响”明确标为解释的部分不是官方精度承诺。**Confidence：** API 行为高；本机可用性与歌曲适用性未知。

| 目的 | 实际输入 → 输出 | 时间尺度与限制、决策影响 |
|---|---|---|
| 时长 | [`get_duration`](https://librosa.org/doc/0.11.0/generated/librosa.get_duration.html)：文件路径，或波形及 sr → 秒数 | 路径模式不必把全部音频载入内存；文档明确波形比频谱输入适合高精度，频谱时长仅精确到帧分辨率。研究者解释：解码波形的样本数/sr 描述该波形时长，不等于“可听音乐有效区间”；静音与尾响仍算时长。对压缩格式的编码延迟/容器与解码差异未实测，不能声称任意格式样本级无误。 |
| 起音 | [`onset_detect`](https://librosa.org/doc/0.11.0/generated/librosa.onset.onset_detect.html)：波形或起音强度包络 → 起音候选帧/样本/秒 | 从 onset strength 中峰值检测；可 backtrack 至能量局部最小值。它不识别小节位置。研究者解释：鼓点、拨弦等瞬态有用，但连奏、缓慢渐入未必有清晰起点；一个节拍内可能有多个起音。 |
| 节拍、速度 | [`beat_track`](https://librosa.org/doc/0.11.0/generated/librosa.beat.beat_track.html)：波形或包络 → tempo 和 beat 位置 | 动态规划：起音强度→相关性估速→选择与速度大致一致的峰；默认输出帧，可选 time。无可检测起音时返回 0 BPM、空列表；默认 trim=True 会裁掉首尾弱起音节拍。可传逐帧变化的 BPM，但这不等于默认模式已可靠识别全部变速；没有 downbeat 输出。 |
| 强弱走势 | [`feature.rms`](https://librosa.org/doc/0.11.0/generated/librosa.feature.rms.html)：波形或频谱 → 逐帧 RMS | 默认 frame_length=2048、hop_length=512；波形 RMS 计算更快。研究者解释：这是幅度能量，不是感知响度、情绪强度或“高潮”标签；压缩母带、频谱分布和编配变化会让听感与 RMS 不一致。不能拿它直接裁决情绪。 |
| 结构变化候选 | [`segment.agglomerative`](https://librosa.org/doc/0.11.0/generated/librosa.segment.agglomerative.html)：如 chroma 等逐帧特征矩阵及指定 k → k 个连续段的左边界帧 | k 是调用者输入，不是模型发现的真实段数；输出包含 0，不提供主歌/副歌等名称。研究者解释：适于提示相似性/变化，不足以断言曲式语义；即使声音无明显段落，也会按给定 k 分段。 |

**时间精度：** [`frames_to_time`](https://librosa.org/doc/0.11.0/generated/librosa.frames_to_time.html) 使用对应采样率与 hop_length 转秒，n_fft 参数还涉及非居中分析的偏移。默认 512/22050 的网格间隔约 **23.2 ms**（研究者计算），不等于节拍误差 ≤23.2 ms；RMS 的 2048/22050 窗口覆盖约 **92.9 ms**（计算），也不等于瞬时强弱。[`load`](https://librosa.org/doc/0.11.0/generated/librosa.load.html) 默认重采样至 22050 Hz、混为单声道，可用 sr=None 保留原采样率。研究者推论：记录解码/裁剪起点、采样率、hop、居中规则与秒数单位是避免整段偏移的条件；裁剪后的秒数不能不加偏移就当作原曲时间。

**已知与推断失败边界：** 空结果、首尾 trim 是文档明示；半速/倍速混淆、切分音使峰与拍不一致、自由速度或弱打击乐不适合固定规则，是基于算法假设的研究者推论，不是本次测得错误率。librosa 文档没有给出本用户曲目上 onset/beat/段落的保证精度或校准置信度。

### 3. 专门节拍模型：Beat This! 明确输出 beat 和 downbeat，但不能当真值

**Claim：** 官方 `File2Beats` 接受音频文件并返回 beats、downbeats；也提供 `Audio2Beats`（波形和采样率）、`Audio2Frames`（逐帧 logits），可导出 `.beats`。模型输入分析采用 22.05 kHz 单声道、441 样本 hop，即 50 fps（20 ms 网格），长音频通过分块推理处理；结果是时间位置，不是自动的视频切点。**Sources：** [官方 README](https://github.com/CPJKU/beat_this)、[推理源码](https://github.com/CPJKU/beat_this/blob/main/beat_this/inference.py)、[论文 §3](https://arxiv.org/html/2407.21658v1)。**Support：** 输入输出与网格为直接证据；不是视频切点为研究者解释。**Confidence：** 高。

**Claim：** 论文明确承认复杂/训练覆盖不足的曲目会失败，continuity 指标较弱，可能产生不周期的拍；即使 rock/electronic，尤其下拍，也不是已解决问题。其 F1 通常采用真值前后 **±70 ms 容差**，评测还默认丢弃前 5 秒；这不是“每次误差不超过 70 ms”，更不能证明开头第一拍可靠。**Sources：** [论文摘要、§3.3、§4、§5](https://arxiv.org/html/2407.21658v1)。**Support：** 直接证据；关于不能推导误差保证和第一拍可靠性的结论为解释。**Confidence：** 高。

**决策影响（研究者推论）：** 输出网格细于视频帧并不保证卡点正确。30 fps 的一帧约 33.3 ms，70 ms 约 2.1 帧（计算，仅说明评测容差与视频尺度差异）；不得用评测 F1 直接宣称帧级同步。模型输出 logits 不是自动校准的“这个节拍正确概率”；本次未验证校准。官方还警告，训练集内歌曲的评估可能不公平地好，不能拿熟悉演示曲证明泛化。

### 4. 氛围：少量专用标签是模型预测，不是美学裁决

**Claim：** Essentia 官方目录提供 mood_happy 等分类头，其中 happy 模型是 `happy / non_happy` 两类；示例先将音频以 **16 kHz 单声道**载入，用 `msd-musicnn-1.pb` 提取 embeddings，再用 `mood_happy-msd-musicnn-1.pb` 输出 softmax predictions。并非“只装一个 mood 模型就有完整音乐理解”。**Sources：** [MTG 官方 models.rst](https://github.com/MTG/essentia/blob/master/doc/sphinxdoc/models.rst)、[官方 Python 示例](https://github.com/MTG/essentia/blob/master/src/examples/python/models/scripts/classification-heads/mood_happy/mood_happy-msd-musicnn-1_predictions.py)。**Support：** 直接证据。**Confidence：** 高。

**解释与未知：** happy 分数不是“听众有多少概率觉得快乐”，non_happy 也不自动等于悲伤；训练标签所表示的类别、模型训练分布和个人/文化语境可能不同（研究者推论）。示例没有给出本用户音乐的准确率、校准分数、逐秒情绪标签，也没有承诺某毫秒出现情绪转折；本次未核验该模型独立 metadata 的准确率、patch 时长与步幅，因此**情绪时间精度未知**，不得用一条全曲分数生成精确高潮点。模型可帮助提出“这里是否更明亮/紧张”的试听问题，不能以标签替人选择配乐。

### 5. 普通 LLM、带音频的多模态服务与人，三者角色不同

**Claim：** Gemini 官方音频文档明确支持真实音频输入，列出描述/问答、音乐与语音情绪检测、按时间段分析；支持文件上传及 inline audio 等输入，输出文本，可以请求时间戳。文档未提供音乐 beat/downbeat/曲式边界的误差保证。**Sources：** [官方 Audio understanding](https://ai.google.dev/gemini-api/docs/audio)。**Support：** 能力列表为直接证据；“没有发现音乐精度保证”为本次对该文档的检查结果，不宣称所有模型均无此能力。**Confidence：** 已列输入能力高；音乐节拍精度未知。

**研究者解释：** 这是“显式接入支持音频的模型/API”，不是给任意普通 coding LLM 一个路径就能听。仅文本模型可读前述分析表、检查单位、比较候选与内容节奏；如果其输入只有文件名、曲名、标签或波形截图，关于音乐听感的文字只能来自这些信息或推测，不能声称实际试听。谱图/波形图能帮助定位事件，不能验证听感、错拍造成的违和、转场是否太密。服务文档允许输出 MM:SS 时间戳，也不意味着它是可直接用于剪辑的准确打点数据。

**研究者推论：** 人实际试听的作用是验证拍感与候选边界是否合理，判断风格、情绪适配、自然呼吸和同步强度；这不是声称人的标注总有唯一正确答案。Beat This! 论文也讨论了标注不精确、演奏不同步和数据质量问题，说明“真值”本身存在边界。当前 coding agent 的音频输入能力、工具链是否保留音轨、用户对同步的容忍度均未核验。

### 6. 部署、费用、许可、外传：需要分别看代码、权重、音频使用权

| 代表方法 | 运行负担及费用事实 | 许可与数据条件 |
|---|---|---|
| librosa 本地信号分析 | Python 库与解码/数值计算依赖，不需音乐模型权重。本次没有安装、测内存或测长曲分析时间，不能承诺“秒出”。 | [官方 LICENSE](https://github.com/librosa/librosa/blob/main/LICENSE.md) 为 ISC，要求保留版权及许可声明。研究者解释：不需向外部音乐推理服务上传音频，但没有做依赖网络流量审计；安装/下载依赖与音频外传不是一回事。 |
| Beat This! 本地模型 | [README](https://github.com/CPJKU/beat_this) 要求 PyTorch ≥2.0 及其他包；非 WAV 可能需 ffmpeg/torchaudio 后端。默认 GPU、无 CUDA 回落 CPU。主模型约 78 MB，小模型约 8.1 MB；首次推理可自动联网下载权重。没有本机实时倍率或 GPU 内存证据。 | 官方明确**代码与发布权重为 MIT**，同时警告部分训练音频有完整版权或受限 CC 条款，用户仍需评估用途。研究者解释：下载权重不等于上传音乐；可本地推理不代表已证实离线默认行为或零网络流量，未审计。 |
| Essentia + mood 模型 | [官方仓库](https://github.com/MTG/essentia) 是 C++ 库并提供 Python 包；上述示例还需含 TensorFlow 算法的构建和两个兼容权重文件。本机/架构支持、CPU 性能、权重大小未核验，不能承诺一条 pip 跨平台即用。 | 库为 **AGPLv3**；[官方模型目录](https://github.com/MTG/essentia/blob/master/doc/sphinxdoc/models.rst) 声明 MTG 模型为 **CC BY-NC-SA 4.0**，可另请求 proprietary license，并要求检查模型 LICENSE。不能把“能下载”当“无限制商用”，商业许可价格未知。可本地处理，但本次没审计所有依赖的网络行为。 |
| Gemini 音频入口（仅代表必要时的外部描述能力） | 需可用地区、账号/API 接入及相应配额；[价格页](https://ai.google.dev/gemini-api/docs/pricing) 按模型区分免费/付费、输入/输出/思考等 token 成本。未选择具体模型、未发请求，所以每曲实际费用未知；不能笼统称永久免费，也不拿语音转录价当音乐分析价。 | 原始音频及提示会发到服务方。按[现行条款](https://ai.google.dev/gemini-api/terms)，一般 Unpaid Services 内容可用于产品改进，可能被人工审阅，不应提交敏感/保密/个人数据；Paid Services 不用于产品改进，但会为安全/合规有限留存且可能跨境暂存，**不是零留存**。EEA/瑞士/英国及活跃 billing/企业账号存在具体适用规则，不能只按调用是否收费判断。 |

**Claim：** 不同软件、权重和音乐资产的许可不能互相替代。**Support：** 前表许可为直接证据；“工具许可不授予原音乐的视频同步/发布权”“本地分析许可不代表可上传云端或公开发布”是研究者解释，不是法律意见。**Confidence：** 高；具体音乐授权未知。

### 7. 对三种创作方式的约束，而非替使用者决策

以下均为基于上述输入/输出边界的**研究者推论**，不是工具文档承诺或本次试听结论：

- **内容优先：** 论点、信息可读时间与叙事次序不由 BPM 决定。已有音乐的时长、能量与段落候选可用来检查是否冲突，不能为了逐拍对齐压缩必要阅读时间或截断表达。
- **音乐优先：** 可把确认过的节拍、下拍、段落作为节奏约束；但必须区别“跟随每拍”“每小节强调”“只跟随大段落”。单一 BPM、首个强峰、模型情绪标签不能独立决定视觉分镜或整曲时间线。
- **混合：** 少量关键事件可参考音乐，其余镜头保留内容所需时长；对齐哪些事件、保留多大提前/滞后感是审美选择，不存在从音频自动推导的唯一正确同步强度。
- **不宜强行卡点：** 自由节奏/持续氛围、弱拍或半倍速候选不稳定、段落标记彼此矛盾、视觉语义尚未完成、每拍转场造成重复与疲劳时，“没有切点”可以是合理结果。节拍是候选锚点，不是命令；低 RMS 不必是空白，高 RMS 不必是高潮。
- **音画联合检查：** 静态截图只能检查画面，不能替代实际播放带音乐的视频来判断同步与听感。何时试听、是否采用某个候选、同步强弱和最终工具均留给人，不由本报告决定。

## Contradictions

1. 未发现一手来源之间对上述 API 的直接矛盾；但 **50 fps/23.2 ms 网格不等于定位准确率**、F1 高不等于连续拍感更好。Beat This! 论文明确报告 F1 与连续性指标的取舍，不能只截取“accurate”标题。
2. “本地开源即可自由商用所有模型”不成立：librosa ISC、Beat This! MIT、Essentia AGPLv3 和 MTG 权重 CC BY-NC-SA 是不同对象的条款，不应混用。
3. 外部服务价格页的简化“免费用于改进/付费不用”不能覆盖全部地区与账号情形；以当前服务条款的适用条件为准。旧版本条款不用于替代现行条款。

## Missing evidence

- 没有用户真实音乐上的拍点/下拍/段落/情绪准确率、完整开头和尾部验证、半倍速错误率；没有模型分数校准、用户容忍的偏移量或同步偏好。
- 没有本机依赖兼容性、CPU/GPU 性能、内存实测；没有网络审计，不能为任何本地组合担保零外传。
- Essentia 模型站点本次发生 DNS `EAI_AGAIN`，其 `models.html` 与 `reference/std_SBic.html` 无法抓取；改以同一官方 MTG 仓库中的模型文档与示例核验可访问的事实，不把不可访问页面当已读。未核验该 happy 模型独立 metadata/LICENSE 文件与情绪时间窗口，商业授权价格未知。`COPYING` 路径返回 404，库许可依据官方仓库 README，不依据该失败链接。
- 外部服务当前所需模型、配额、账户地区、具体价格和音乐上传权限尚未确定；未提供虚构每首费用。普通 coding agent 是否具备音频输入未知。

## Sources

Kept（均为一手，精简为四组；正文已给出具体 API/文件链接）：

- [librosa 0.11.0 文档](https://librosa.org/doc/0.11.0/index.html)及正文中的 get_duration、load、onset_detect、beat_track、RMS、agglomerative、frames_to_time — 核验数值输入输出与时间换算；许可另以[官方 LICENSE](https://github.com/librosa/librosa/blob/main/LICENSE.md)核验。
- [Beat This! 官方仓库](https://github.com/CPJKU/beat_this)与[ISMIR 2024 论文 v1](https://arxiv.org/html/2407.21658v1) — beat/downbeat、依赖、模型大小、权重许可、时间网格与失败边界。论文是 2024 研究，不是本用户音频的当前实测。
- [MTG/essentia 官方仓库](https://github.com/MTG/essentia)、[模型目录源码](https://github.com/MTG/essentia/blob/master/doc/sphinxdoc/models.rst)、[happy 预测示例](https://github.com/MTG/essentia/blob/master/src/examples/python/models/scripts/classification-heads/mood_happy/mood_happy-msd-musicnn-1_predictions.py) — 氛围标签、双模型输入和独立许可对象。
- [Gemini 音频文档](https://ai.google.dev/gemini-api/docs/audio)、[价格](https://ai.google.dev/gemini-api/docs/pricing)、[现行条款](https://ai.google.dev/gemini-api/terms) — 一个显式音频入口的能力与外传、费用边界，都是动态网页，不保证未来不变。

Rejected/deprioritized：搜索摘要（只作定位，不作最终证据）；Sonoria fork 模型文档（非 MTG 原始仓库）；musetric 第三方 notices（官方许可已可读）；Beat This Live（在线实时变体不属本票重点）；过时 librosa 文档（改核对 0.11.0）；Gemini 旧条款及语音转录模型价格（不是当前音乐分析的适用证据）；不可达 Essentia 页面（不补写未核验内容）。没有采用旧 ChatGPT 对话或博客。
