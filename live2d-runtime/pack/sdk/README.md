# Live2D Cubism 运行组件

扩展安装包在此目录保留 Live2D 许可文本。Core、Framework 和着色器存入扩展的本机 `sdk/` 缓存。

- `live2dcubismcore.min.js` 从 [Live2D 官方托管地址](https://www.live2d.com/en/sdk/download/web/) 下载。
- `framework.js` 和 `shaders.js` 从 [官方 CubismWebFramework 5-r.5 固定提交](https://github.com/Live2D/CubismWebFramework/commit/198a3769c26ca3d7b600e932590433badd392edd) 的源码在本机生成。

两套许可使用同一个确认入口。官方下载和缓存文件均校验 SHA-256。已确认许可的用户会复用已验证的旧文件，缺失时在首次使用前补齐。预览、封面和桌宠渲染使用同一份本机缓存。用户模型的直载数据与 SDK 缓存分别保存。
