---
name: video-produce
description: 在明确视频项目中按设计制作或修改 HyperFrames 视频，或按请求分析音乐、预览、取得连续音画片段及导出；不重新作全局创作选择。
---

# 制作与导出

## 按任务读取

上游原文件位于 `../../../vendor/hyperframes/skills/`；按下表读取参考，不执行其完整工作流。

| 当前任务 | 读取 |
| --- | --- |
| 编写／修改画面、时间线 | 上游 hyperframes 的 [format](../../../vendor/hyperframes/skills/hyperframes/references/format.md)、[runtimes](../../../vendor/hyperframes/skills/hyperframes/references/runtimes.md) |
| 共享素材、字体、GSAP | [本地文件](references/local-files.md) |
| 音乐选段、分析、缓存与换曲 | [音乐](references/music.md) |
| 预览、导出与区间参数 | 上游 CLI 的 [preview-render](../../../vendor/hyperframes/skills/hyperframes-cli/references/preview-render.md) |
| lint／check／抽帧 | 上游 CLI 的 [lint-validate-inspect](../../../vendor/hyperframes/skills/hyperframes-cli/references/lint-validate-inspect.md) |
| 查找现成组件 | 上游 registry 的 [search](../../../vendor/hyperframes/skills/hyperframes-registry/references/search.md)，选用后读对应 wiring 文档 |

## 执行

只执行本次任务适用的步骤。

1. 制作时解析工作台与目标项目的绝对路径，读取现有设计、源码及改动范围；关键取舍不清楚时只澄清缺口。单独分析素材只需明确文件与缓存归属，不要求先建视频项目。
2. 工具在工作台根通过 `npm run hf -- <命令>` 调用，项目作为显式目录参数。准备环境或依赖故障时读 [开发指南](../../../docs/development.md)；参数查已安装 CLI 的 `--help`／`docs`。
3. 新项目按需要复制 `projects/example/.gitignore`，保留用户已有规则。直接编写该作品的 `index.html` 和所需文件；不强制 init、项目 package.json 或元数据。配置只在改变实际行为时增加。
4. 动画必须能从给定时间恢复状态；保持场景标识易读。局部原型与视频草稿只取自真实项目，按授权取得足以讨论的证据。
5. 用适用的 lint／check 排查基础故障，查看实际 findings、跳过项与样本数；零样本不算通过。工具的审美警告结合设计判断，修复真实错误，不为消除警告悄悄改变表达。
6. 日常使用 `preview <项目> --background --no-open`，将实际 URL 交给使用者在 Windows Edge 播放、暂停和定位。停止预览只针对该项目，不清理别人的服务。
7. 需要连续音画证据时，优先原生 `render <项目> --start <秒> --end <秒> --sdr`。区间使用 MP4、24／25／30／60 fps，并指定项目内可辨认的输出文件；记录其全片跨度和帧率。snapshot 是静帧，不能替代连续片段。
8. 导出后检查实际文件可打开性、尺寸、帧率、时长及适用的画面／音轨证据；问题影响哪里就复查哪里及衔接。预览正常不能替成品背书。

## 返回结果

给出具体文件／URL、版本与时间范围、实际做过的检查及失败、跳过和未知。
使用项目 Git 且需保留制作版本时，说明实际源码提交及未提交变化，不逐次渲染登记。
没有真实连续视频或音频感知能力就明说，请人判断动态和听感；最终由使用者完整观看、试听实际交付文件。
不因一次“继续”自动做到最终成片；独立产物 review 与复杂编排不属于本入口。
