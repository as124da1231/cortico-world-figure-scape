# 第三方声明

本文件列明安装归档中的第三方组件、通过依赖安装的原生库、以及运行时获取的资源。模型和 Electron 在安装归档之外获取。

## 识别运行库

[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) 的 Node 插件 `sherpa-onnx-node` 1.13.8 与各平台的
预编译包(`sherpa-onnx-win-x64`、`sherpa-onnx-darwin-arm64`、`sherpa-onnx-darwin-x64`、`sherpa-onnx-linux-x64` 等),随 npm 依赖安装。
Apache-2.0;其中的 onnxruntime 为 MIT。

## 模型

FunASR 的 SenseVoiceSmall(FunAudioLLM,通义实验室)与 OpenAI 的 Whisper small,都经 k2-fsa 转成 sherpa-onnx 用的 int8 ONNX,
分别放在 `<模型根>/desktop-live2d-pet/sensevoice-small-int8-2024-07-17/` 与 `<模型根>/desktop-live2d-pet/whisper-small-int8-2024-07-13/`,按固定的 SHA-256 校验。

| 文件 | 来源(按顺序尝试) | 许可 |
|---|---|---|
| `model.int8.onnx`、`tokens.txt` | [ModelScope pengzhendong/sherpa-onnx-sense-voice-zh-en-ja-ko-yue](https://modelscope.cn/models/pengzhendong/sherpa-onnx-sense-voice-zh-en-ja-ko-yue),再 [Hugging Face csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17](https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17) | [FunASR 模型开源协议](https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE) |
| `small-encoder.int8.onnx`、`small-decoder.int8.onnx`、`small-tokens.txt` | [ModelScope pengzhendong/sherpa-onnx-whisper-small](https://modelscope.cn/models/pengzhendong/sherpa-onnx-whisper-small),再 [Hugging Face csukuangfj/sherpa-onnx-whisper-small](https://huggingface.co/csukuangfj/sherpa-onnx-whisper-small) | [MIT](https://github.com/openai/whisper/blob/main/LICENSE) |

## 桌宠窗口

Electron 44.4.4,从 [electron/electron releases](https://github.com/electron/electron/releases/tag/v44.4.4)
取到 `<运行时根>/electron/44.4.4/`,或使用内嵌应用自带的那份。MIT;其中 Chromium 与依赖各随其许可。

## Coopanion 共用源码

桌宠窗口、身体 Kit 和 Coo 面板基础来自 [Coopanion Desktop Pet](https://github.com/Pal-AI-Lab/Coopanion)。`src/webui/coopanion/` 基于 Coopanion 0.2.19 的控制台组件，`src/asr/address.ts` 来自 Coo Provider。派生代码按 AGPL-3.0-or-later 提供。

## 其他运行时依赖

- `ws`:MIT
- `opencc-js`(繁简转换):MIT AND Apache-2.0
- [koffi](https://koffi.dev/) (原生窗口、鼠标位置和采集状态读取): MIT
- [jpeg-js](https://github.com/jpeg-js/jpeg-js) (角色资源与预览转换): BSD-3-Clause

- [rot.js 2.2.1](https://github.com/ondras/rot.js/tree/v2.2.1) 的四向 A* 打包在 `web/vendor/rot-astar.js`。版权和 BSD-3-Clause 许可随 `web/vendor/rot-astar.LICENSE.txt` 提供。
- [pngjs](https://github.com/pngjs/pngjs) 用于缩小取证贴图，MIT 许可。

## Live2D 数据准备与表现代码

`live2d-runtime/direct-tools/` 复用本机 DSH body foundation 的模型快照、元数据、参数映射和数据准备实现，按 AGPL-3.0-or-later 保留；来源文件摘要和本地适配记录见该目录的 `SOURCE.json`。没有引入 DSH 的会话或窗口控制器。`web/framework/touch-geometry.js` 与 `web/framework/touch-overlay.js` 沿用 DSH Superpet 的高度分区与命中圈可视化规则。

`live2d-runtime/pack/backends/` 保留 Figure 表现实现的来源记录，详见 `live2d-runtime/SOURCE.json`。SoulLink 引擎和效果模块分别保留各自的 `LICENSE` 和 `NOTICE.txt`。发言编排器的 TypeScript 原件、来源和构建说明见 [SoulLink 源码说明](licenses/soullink-planner/README.md)，按 Apache-2.0 随包分发。

资源域的封面渲染、动作取证规则和 Cubism 缓存准备、音频域的语音服务与编排服务适配复用本机 Figure 4.1.0 的实现，按 AGPL-3.0-or-later 保留。桌宠通过独立窗口运行，语音通过本 World 的播放时钟接入现有表现规则。

Live2D Cubism Core、Framework 和着色器由本机 SDK 缓存提供。相应的许可文本见 `live2d-runtime/pack/sdk/`。用户模型及贴图遵循各自的作者许可。公开分发时另需核对 Live2D 的 SDK Release License 和可扩展应用规则。 [Live2D 官方说明](https://www.live2d.com/en/sdk/license/)

## 小屋场景

`house-core.js`、`house-geometry.js`、`house.json` 及房间图层来自大肥鱼的小屋。导入快照来自 `71f32f7e70d6ff6ac97e999af60e3b84ab7efb3d`。原文件、素材说明和 AGPL-3.0 许可保留在 `web/vendor/feiyu-house/`。[上游项目](https://github.com/mrdxabing-rgb/cortico-world-feiyu-house)

## 壁纸场景

壁纸运行使用 WebWallGL 3.0.2（MIT）和 Mediabunny 1.66.0（MPL-2.0）。`dist/` 随附两份许可。Mediabunny 的对应源码根据 `v1.66.0` 标签获取，发布构建使用依赖原件。用户添加的 Wallpaper Engine 项目及本机图片、视频遵循各自素材许可。 [WebWallGL 源码](https://github.com/oneincase/webwallgl) · [Mediabunny 对应源码](https://github.com/Vanilagy/mediabunny/tree/v1.66.0)

## 本包的许可

AGPL-3.0-or-later,见 [`LICENSE`](LICENSE)。
并入 Coopanion 之前的版本(独立仓库 `Pal-AI-Lab/cortico-world-desktop-pet` 里的历史)是 MIT。
