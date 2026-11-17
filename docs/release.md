# 发布前核对

## 构建与契约

从源目录执行 `pnpm typecheck`、`pnpm test` 和 `pnpm build`。构建会把内容摘要写入面板、网页编辑台和壁纸渲染资源的入口。在匹配宿主的 Cortico 源码目录执行以下检查。

```text
pnpm describe:extension <梦境源码目录>
pnpm check:extension <梦境源码目录>
```

`describe.json` 是市场可读取的工具、事件和环境说明清单。发布版本应有对应的更新日志章节。市场按 `cortico` 的契约版本、展示名、标签和 npm 的平台字段展示包。 [Cortico 扩展文档](https://github.com/Pal-AI-Lab/Cortico/blob/main/docs/extensions.md) · [市场标签](https://github.com/Pal-AI-Lab/cortico-extensions/blob/main/TAGS.md)

## 归档与运行

Git 源码包含运行代码、测试、许可与自有内置形象。构建输出、运行时缓存、用户模型、聊天记录和配对数据放在本机。检查更新后的锁文件，并在准备提交前核对 Git 文件清单。

使用已解包的 Cabin World 1.1.0 Windows 发布版生成运行包，再构建本机归档。 [Cabin World 1.1.0](https://github.com/BabyBus2022/cabin-world/releases/tag/V1.1.0)

```powershell
python scripts/prepare-cabin-runtime.py "<Cabin World Windows 解包目录>"
node scripts/check-cabin-runtime.mjs
npm pack --pack-destination "<本机输出目录>"
```

npm 注册表对单个发布请求有未公开的 200MB 上限，带内置小屋世界的整包会被 `413` 拒收。发布版因此把 `cabin-runtime/` 拆成三个资源包，主包声明它们为依赖，扩展第一次进入小屋世界时拼回 `CabinWorld.exe` 并与 `manifest.json` 的摘要比对。

```powershell
# 1. 生成资源包源码目录并逐个打包，先发资源包
node scripts/split-cabin-runtime.mjs "<本机输出目录>\parts"
npm pack "<本机输出目录>\parts\cortico-world-figure-scape-cabin-1of3" --pack-destination "<本机输出目录>"
# 2. 确认注册表里三个版本都能下载后，再发主包
npm publish "<本机输出目录>\cortico-world-figure-scape-0.1.0-dev.1.tgz"
```

三个资源包和主包使用同一版本号。装好后从 `node_modules` 里删掉任意一个资源包都应导致进入小屋世界报错，重新装回后恢复；拼好的目录在数据目录的 `cabin-runtime/`，删掉它会在下次进入时重新拼。

解包确认扩展入口、前端资源、源码与许可齐全，在解包目录再执行扩展检查。以源目录锁文件安装构建依赖，重建浏览器资源并比对文件名和 SHA-256。随包提供 Figure Pet APK 时，使用 Figure Pet 发布构建生成的安装包，核对其签名、版本、文件摘要和对应源码。检查归档文件清单，排除用户模型、Cubism Core、本机缓存、配置、配对身份和凭据。

运行验收至少覆盖安装加载、原始 Live2D 导入、兼容形象包、网页草稿恢复、应用后的真实首帧和设置恢复。在 Coo 当前窗口确认工作台加载了本次构建，检查 Figure Pet 卡片的 APK 下载、扫码、聊天收发、读取角色与解除配对。验证旧连接器迁移时已有设备可以重连，另外记录 Android 实机结果。Windows 采集策略可读取系统回执。OBS 和系统截图按各自的工具验证。

## 许可

Live2D 组件由本机 SDK 服务下载并校验，仓库随附运行时许可文本。 [运行时许可](../live2d-runtime/pack/sdk/README.md) · [第三方声明](../THIRD_PARTY_NOTICES.md) · [创作者与鸣谢](../CREDITS.md)

Mediabunny 的可执行代码进入壁纸 bundle。对应源码和许可位置列在第三方声明，构建脚本把组件许可带入 `dist`。
