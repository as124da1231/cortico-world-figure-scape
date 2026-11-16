# 梦境的结构与接口

Figure Scape 的 npm 包名为 `cortico-world-figure-scape`。Coo 使用 `desktop-live2d-pet` 作为 World ID，配置键、数据目录、事件类型、工具名和旧页面链接沿用这一 ID。Coo 拥有对话、记忆与工具调度。梦境负责角色身体、显示与本地操作。

| 责任域 | 主要入口和状态 |
| --- | --- |
| Coo 接入 | `src/definition.ts` 装配依赖，`src/world.ts` 接入事件、工具和面板。`src/chat.ts` 投影会话消息与投递状态。 |
| 运行协调 | `src/framework/model-domain.ts` 负责操作与持久化，`model-application.ts` 关联应用请求。模型与场景的提交共用 `body-transaction.ts`，忙时返回可重试的反馈。 |
| 模型资源与配置 | `src/live2d` 准备原始模型与 SDK 缓存。`src/framework/figure-library.ts` 导入形象包并单独保存用户覆盖。 |
| 身体表现 | `web/body-host.js` 连接身体帧，`web/figure-frame.js` 运行直载模型或形象包。动作词表按身体回报更新。 |
| 音频与同步 | `src/asr` 负责识别，`src/speech` 负责合成和编排。`web/framework/speech.js` 用播放器进度协调气泡、口型和动作。 |
| 场景 | `src/framework/presentation-service.ts` 持有应用状态。`web/desktop-system.js` 装配桌面、小屋、竖屏和壁纸实现。 |
| 呈现与输入 | `web/pet-app.js` 连接交互，`web/framework` 提供操作台、对话、触碰几何和窗口抓手。身体命中坐标和窗口位置各由所属模块维护。 |
| 编辑服务 | `src/framework/editor-backend.ts` 管理网页编辑会话和按来源保存的草稿。编辑与预览使用自己的一帧模型。 |
| 宿主适配 | `src/server.ts` 提供回环页面。`src/window-host.ts` 与 `host/` 管理梦境窗口的启停、穿透、截屏设置及 OBS 输出。 |

## 从来源到当前身体

原始 Live2D 通过本地 SDK 缓存准备资源，形象包通过已验证的 `figure.json` 加载作者入口。两个来源共用模型库、预览入口和运行时。网页使用 `character.open` 读取编辑任务，形象包用 `character.saveFigure` 保存覆盖，失败后可用同一配置版本重试应用。模型、装扮和触碰设置只在相应的来源上保存。

运行端保留当前确认的身体，候选加载成功并报告首帧后才切换。当返回已保存但尚未应用时，配置已落盘，窗口仍等待下一次应用。接口状态要分别看操作结果、模型代次及窗口首帧就绪。渲染帧以受限资源地址访问选中的角色。

## 常用接口

| 入口 | 用途 |
| --- | --- |
| Coo 的 `world:desktop-live2d-pet` 面板 | `runtime.state`、`resources`、`runtime.openEditor`、`presentation.select`、`operation.get`、`operation.cancel`。 |
| 本机 `/api/editor` | 浏览器编辑凭据访问。角色打开、草稿增删、保存及应用，分别返回自己的结果。 |
| 本机 `/api/bodies/:id` 和 `/model-frame` | 角色资源描述与沙箱渲染。 |
| `desktop-live2d-pet.touch` | Coo 触碰事件，支持手势、区域 ID、名称、次数和说明。正式投递受触碰全局设置与角色规则约束。 |
| `live2d_pet_status` 和 `live2d_pet_say` | 查询可用身体和当前场景。发言先存进会话，窗口可用时进入播放。 |
| 本机 `/overlay` | 用户启用 OBS 画面后提供透明浏览器源。 |

## 数据与设备

模型文件、草稿、形象包快照、壁纸与缓存保存在本机 Coo 数据下。服务认证信息由 Coo 的凭据接口保存。语音识别使用用户选中的本机或远端引擎。远端转写会收到该次收音，远端合成会收到该次朗读文本，动作编排服务会收到对应台词和参数信息。

安装归档包括程序源码、前端产物和授权文本。Live2D Core 及 Framework 运行文件在取得许可后进入本机缓存。原始角色、设备录音、会话和服务认证信息按部署保管。
