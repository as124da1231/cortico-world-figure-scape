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

## 梦境主包

梦境主包在 `src/framework/cabin-resources.json` 固定小屋组件的 GitHub Release 地址、版本、归档大小和校验摘要。用户从「引擎 → 小屋世界」下载并安装组件。已有兼容安装可直接使用，完整的旧 npm 三包仍可在本机离线装配。

```powershell
npm pack --pack-destination "<本机输出目录>"
```

`npm pack` 检查下载清单和固定版本。扩展先校验 ZIP 的大小和 SHA-256，再安全解包并校验 `CabinWorld.exe`。替换中断后，启动时会找回带有兼容安装标记的旧目录。进入小屋前校验托管组件，发现运行文件损坏时在引擎页提供「修复安装」。住户和游戏存档保存在独立的数据目录。

## 小屋资源更新

更换小屋运行时、桥接文件或素材时，更新准备脚本里的组件标签和附件名，再生成 ZIP。若安装内容与此前的运行目录不兼容，更新 `src/definition.ts` 的 `CABIN_BUNDLE_VERSION`。更换上游导出时，同步更新准备脚本的上游版本和摘要。 [当前上游版本](https://github.com/BabyBus2022/cabin-world/releases/tag/V1.1.0)

```powershell
python scripts/prepare-cabin-runtime.py "<Cabin World Windows 解包目录>"
node scripts/check-cabin-runtime.mjs
python scripts/prepare-cabin-runtime.py --archive "<本机输出目录>"
```

将实际附件地址、版本、字节数和 SHA-256 写入下载清单。先在 Figure Scape 的 GitHub Releases 发布组件，验证公开下载、摘要和安装后，再发布梦境主包。保留已发布的资源供已有版本使用。用隔离数据验证下载、取消、重试和校验，用升级前的安装验证存档保留。

## 归档验收

解包确认扩展入口、前端资源、源码与许可齐全，在解包目录再执行扩展检查。以源目录锁文件安装构建依赖，重建浏览器资源并比对文件名和 SHA-256。随包提供 Figure Pet APK 时，使用 Figure Pet 发布构建生成的安装包，核对其签名、版本、文件摘要和对应源码。检查归档文件清单，排除用户模型、Cubism Core、本机缓存、配置、配对身份和凭据。

运行验收至少覆盖安装加载、原始 Live2D 导入、兼容形象包、网页草稿恢复、应用后的真实首帧和设置恢复。在 Coo 当前窗口确认工作台加载了本次构建，检查 Figure Pet 卡片的 APK 下载、扫码、聊天收发、读取角色与解除配对。验证旧连接器迁移时已有设备可以重连，另外记录 Android 实机结果。Windows 采集策略可读取系统回执。OBS 和系统截图按各自的工具验证。

用隔离数据分别结束小屋世界的游戏进程、角色渲染器和桥接进程。验证原场景恢复、已保存的回复只出现一次、播报从最近进度接续，以及已明确关闭的窗口保持关闭。桥接退出后检查关闭了本次启动的子进程、清理了临时目录，并用原存档重新进入。若扩展与桥接同时退出，下次启动小屋世界时应回收已确认失去归属的临时目录。另测待恢复的桌面窗口也已退出时，重新打开后恢复到最近上报的站位。

分别进入梦境住户和小屋世界原生住户，核对场景页的动作控制、Coo 读取的身体能力和命令回执。用清单中有、实际渲染器未提供的动作验证拒绝路径。再次进入同一角色时检查身体代次更新，旧代次的指令应无法进入当前动作队列。

用 `live2d_pet_act` 返回的编号查询 `live2d_pet_status`，检查各场景的动作实际接受与拒绝。小屋世界另测身体结束回执、仅有预计时长、退出中断和渲染器异常。景内切换后查同一编号，在新身体代次核对独立动作的记录与发言续播各自的状态。

### 梦境场景对话

分别从梦境的桌面、内置小屋、竖屏、壁纸和小屋世界发送消息，核对当前场景的反馈、梦境对话记录，以及 Coo 运行记录中的输入投递和 `live2d_pet_say` 回执。检查重开梦境对话后正文仍能读取，验证纯文字、带动作和多段发言。

## 许可

Live2D 组件由本机 SDK 服务下载并校验，仓库随附运行时许可文本。 [运行时许可](../live2d-runtime/pack/sdk/README.md) · [第三方声明](../THIRD_PARTY_NOTICES.md) · [创作者与鸣谢](../CREDITS.md)

Mediabunny 的可执行代码进入壁纸 bundle。对应源码和许可位置列在第三方声明，构建脚本把组件许可带入 `dist`。
