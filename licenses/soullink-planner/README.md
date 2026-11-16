# SoulLink 发言编排器

这些 TypeScript 文件对应 `src/speech/planner/soullink-speaking-planner.js`。来源为 SoulLink Emotion SDK 的编排器快照 `3ac61f2b03ee4d8186d7eea7f3295fe7`。版权归 SoulLink Emotion contributors，采用 Apache-2.0 许可。[许可全文](../../live2d-runtime/pack/vendor/soullink/LICENSE)

构建入口为 `SoullinkSpeakingMotionPlanner.ts`，输出为 Node ESM。构建时内联同目录的客户端和类型引入，并将 `@soullink-emotion/engine` 保留为外部导入。归档中的该导入指向 `../../../live2d-runtime/pack/vendor/soullink/index.js`，由此复用同一份引擎。

引擎包的版本与来源见 [SoulLink 引擎说明](../../live2d-runtime/pack/vendor/soullink/README.md)。[上游项目](https://github.com/nanlingyin/soullink-emotion-sdk)
