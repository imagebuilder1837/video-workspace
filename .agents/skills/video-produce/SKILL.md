---
name: video-produce
description: 在明确视频项目中按设计制作或修改 HyperFrames 视频，或按请求分析音乐、预览、取得连续音画片段及导出。
---

# 制作与导出

## 按任务读取

上游原文件位于 `../../../vendor/hyperframes/skills/`；按下表读取参考。

| 当前任务 | 读取 |
| --- | --- |
| 项目结构、新项目或结果定位 | [项目约定](references/project-layout.md) |
| 编写／修改画面、时间线 | 上游 `/hyperframes` 的 [format](../../../vendor/hyperframes/skills/hyperframes/references/format.md)、[runtimes](../../../vendor/hyperframes/skills/hyperframes/references/runtimes.md) |
| 共享素材、字体、GSAP | [本地文件](references/local-files.md) |
| 音乐选段、分析、缓存与换曲 | [音乐](references/music.md) |
| 预览、导出与区间参数 | 上游 CLI 的 [preview-render](../../../vendor/hyperframes/skills/hyperframes-cli/references/preview-render.md) |
| 基础排错与取证 | [工具与证据](../video-review/references/evidence.md) |
| 查找现成组件 | 上游 `/hyperframes-registry` 的 [search](../../../vendor/hyperframes/skills/hyperframes-registry/references/search.md)，选用后读对应 wiring 文档 |

## 执行

只执行本次任务适用的步骤。

1. 制作时解析工作台与目标项目的绝对路径，读取现有设计、源码及改动范围；关键取舍不清楚时只澄清缺口。单独分析素材只需明确文件与缓存归属。
2. 工具在工作台根通过 `npm run hf -- <命令>` 调用，项目作为显式目录参数。准备环境或依赖故障时读 [开发指南](../../../docs/development.md)；参数查已安装 CLI 的 `--help`／`docs`。
3. 新项目沿用 [项目约定](references/project-layout.md)，保留用户已有内容与规则。
4. 动画必须能从给定时间恢复状态，保持场景标识易读。视频草稿取自真实项目；问题驱动的原型由 `/video-prototype` 约束。
5. 需要基础排错时按 [工具与证据](../video-review/references/evidence.md) 选择适用检查；工具警告结合设计判断。
6. 日常使用 `preview <项目> --background --no-open`，将实际 URL 交给使用者在 Windows Edge 播放、暂停和定位。停止预览只针对该项目。
7. 需要连续音画证据时，优先原生 `render <项目> --start <秒> --end <秒> --sdr`。区间使用 MP4、24／25／30／60 fps，并指定项目内可辨认的输出文件；记录其全片跨度和帧率。
8. 本次分工要求检查时，对实际结果完成适用检查，依据 [修改后复查](../video-review/SKILL.md#修改后复查) 决定范围；独立产物检查使用 `/video-review`，轮次遵循本次授权流程。

## 反馈返工

按已明确的反馈与授权做最小但足够的调整，保留未受影响的已认可内容。需要解释反馈或改变重要创作选择时转 [`/video-discuss`](../video-discuss/SKILL.md#反馈)。
明确要求执行已采纳的修改时，按 [设计与执行](references/project-layout.md#设计与执行) 的写入责任同步已有设计中受影响的内容；精确实现参数留在源码。按本次分工取得修改后结果，有足以共同判断的结果后返回。

## 返回结果

按 [结果对应](references/project-layout.md#结果对应) 给出文件／URL、版本与时间范围，说明实际检查及失败、跳过和未知。
感知范围与人工补位按 [工具与证据](../video-review/references/evidence.md) 说明。
需要复杂项目协调时，由使用者明确调用 `/video-coordinate`。
