# 发布前核对

## 构建与契约

从源目录执行 `pnpm typecheck`、`pnpm test` 和 `pnpm build`。构建会把内容摘要写入面板、网页编辑台和壁纸渲染资源的入口。在匹配宿主的 Cortico 源码目录执行以下检查。

```text
pnpm describe:extension <梦境源码目录>
pnpm check:extension <梦境源码目录>
```

`describe.json` 是市场可读取的工具、事件和环境说明清单。发布版本应有对应的更新日志章节。市场按 `cortico` 的契约版本、展示名、标签和 npm 的平台字段展示包。 [Cortico 扩展文档](https://github.com/Pal-AI-Lab/Cortico/blob/main/docs/extensions.md) · [市场标签](https://github.com/Pal-AI-Lab/cortico-extensions/blob/main/TAGS.md)

## 归档与运行

使用 `npm pack --ignore-scripts` 生成本机归档。解包核对入口、面板资源和编辑器资源，确认源码和许可文件齐备，并在归档内容上执行扩展检查。使用源目录锁文件解析构建依赖，重建解包目录中的浏览器资源并比较文件名和 SHA-256。重点查看归档的文件清单是否携带模型、Cubism 运行文件、缓存、本机配置或凭据。

运行验收至少覆盖安装加载、原始 Live2D 导入、兼容形象包、网页草稿恢复、应用后的真实首帧和设置恢复。Windows 采集策略可读取系统回执。OBS 浏览器源与系统截图是两条独立的画面路径，实际工具兼容性需按工具验证。

## 许可

参阅 [第三方声明](../THIRD_PARTY_NOTICES.md) 与 [创作者与鸣谢](../CREDITS.md)。Live2D 官方对应用公开分发有独立的 SDK Release License 规则，并对可扩展应用单独说明。梦境的 SDK 下载在本机完成。发布方应按实际产品形态确认适用规则。 [Live2D SDK 发布许可](https://www.live2d.com/en/sdk/license/)

Mediabunny 的可执行代码进入壁纸 bundle。对应源码和许可位置列在第三方声明，构建脚本把组件许可带入 `dist`。
