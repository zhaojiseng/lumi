# 插件架构

开发教程、完整示例和 SDK 说明见 [插件开发指南](PLUGIN_DEVELOPMENT.md)。本文说明宿主与各插件的职责及生命周期。

Lumi 的插件可以向系统内置界面提供内容，也可以声明自己的显示界面、设置选项和侧栏入口。`plugins/` 是静态构建的内置插件；`extensions/packages/` 是独立分发的额外插件，不编译进 EXE。设置以可折叠分组和插件列表展示“内置插件 / 工具配置 / 额外插件”，点击插件打开说明与设置弹窗；额外包在运行时扫描并经隔离 web 界面和 SDK 接入，无需修改内置注册表。作者格式、权限、开发/安装和贡献流程见 [extensions/README.md](../extensions/README.md)。

## 产品插件与统一系统

设置页展示以下六个可独立启停的插件：

| 插件 | 设置分组 | 向系统贡献的内容 |
| --- | --- | --- |
| `provider.newapi` | NewAPI：工作台、用量分析、模型广场、API令牌 | 账户/消费卡片、账单/请求明细、模型目录/价格、令牌管理；另提供在线配钥能力 |
| `provider.codex` | Codex：工作台 | ChatGPT 订阅限额、周窗口、重置时间及剩余积分 |
| `surface.widget` | 浮窗 | 从用量展示服务读取内容，在独立受限窗口显示 |
| `surface.tray` | 托盘 | 从工作台展示服务读取内容，在 Windows 托盘或 macOS 菜单栏显示 |
| `adapter.tool.codex` | 工具配置 → Codex 工具配置 | Codex CLI 专属字段与配置格式 |
| `adapter.tool.claude` | 工具配置 → Claude Code 工具配置 | Claude Code CLI 专属字段与配置格式 |

`feature.workbench`、`feature.usage`、`feature.models`、`feature.tokens` 和 `feature.tool-config` 是固定的统一系统模块，负责页面壳、插槽和操作编排。它们不作为设置页的大项开关。New API 拥有实际协议、账户、缓存、令牌服务/编辑器和专用令牌复用策略；工具配置通过 `toolCredential.provision` 消费能力，不引用令牌页面。

`source.local-sessions` 和默认主题保持固定基础模块。两个工具适配器默认启用，系统工具页通过可选依赖消费它们；停用一个只撤回该工具，不重挂载另一个工具的表单。事务、加密备份、冲突检查、原子写入和回滚由 ConfigService 协调。适配器停用会使所属预览失效，安装及配置提交/恢复不可用，不再发起其版本检测，已写入配置与加密备份保留。ChatGPT 桌面版本随 Codex 工具检测；两工具全关闭时跳过查询。正在配钥、安装或写入时拒绝停用。停用 NewAPI 后，已启用工具的本地检测、安装、配置检查和备份恢复仍可使用，在线配钥/预览/应用不可用。

## 独立界面插件

`interface.default` 是固定内置界面插件，拥有标题栏、悬浮侧栏、内容滚动容器、状态栏、搜索、弹窗及通知的 JSX 与外壳布局。`App.tsx` 保留账户、数据请求、导航和偏好状态，通过 `InterfaceShellProps` 提供展示数据与受控动作；界面不创建服务或请求账户数据。

`src/host/interface.tsx` 保持默认 React 外壳及页面节点稳定，外部 `kind: "interface"` 包经独立 CSS 接口覆盖布局和皮肤。界面包只有清单、CSS 和许可，不获得功能插件的 SDK/权限；一次选中一个，启用新界面会原子停用旧界面。功能插件仍通过自己的系统插槽或隔离 frame 显示内容。

样式经 CSSOM 检查后放入以插件 ID 限定的 `@scope`，限制大小、规则类型、资源引用、拖动区域和 z-index。恢复默认使用设置中的“默认界面”；非法样式、缺包或摘要变化回退到默认。切换和扫描不重挂载设置、功能页或修改其草稿。外部接口 v1 支持 CSS 布局/皮肤，尚不提供任意外部 React/JavaScript 替换整套界面的接口。包格式和选择器见 [作者指南](../extensions/README.md#界面插件-v1)。

## 插件贡献接口

`plugins/manifests.ts` 仅导出元数据，禁止引入 main 实现。`shared/contracts/plugins.ts` 的 `PluginManifest` 声明依赖、提供能力及 `settings`。可配置插件通过顶层 `defaultEnabled` 声明初始启用状态，未声明时默认启用；`provider.codex` 默认关闭。桌面和浏览器共用同一解析规则，显式保存的 `pluginEnabled` 优先，浮窗继续兼容旧 `widgetEnabled`。插件通过元数据申请设置组和子开关，宿主自动展示、校验与持久化，无需修改设置页。例如：

```ts
settings: {
  title: 'Custom', description: '扩展来源', order: 50,
  views: [{id: 'history', title: '历史记录', defaultEnabled: false}]
}
```

子开关 ID 必须是限长的小写字母、数字、点或短横线，不得重复；只接受当前插件明确声明的选项。配置记录在非敏感的 `pluginViews[pluginId][viewId]`。未保存值使用 `defaultEnabled`，未声明默认值则启用。`settings.group: 'tools'` 指定工具配置分组。分组可折叠，插件末级是独立列表行；点击行或开关右侧的设置按钮打开详情弹窗，包含介绍、启用状态、自身设置及显示子项。关闭保留列表分组、滚动及已访问插件的设置草稿，并恢复触发按钮焦点；失活时撤回插件组件，错误状态仍可见。

`src/host/renderer-registry.ts` 的 `RendererContribution` 提供以下贡献点：

| 接口 | 功能 |
| --- | --- |
| `workbench` | 注册系统工作台卡片 |
| `usage` | 注册系统用量分析标签 |
| `models`、`tokens` | 注册模型广场/令牌管理的来源内容 |
| `toolConfigs` | 注册 CLI 专属选项、验证和运行时扩展 |
| `sidebar` | 注册自定义懒加载页面、导航分组及入口 |
| `settings.component` | 兼容原有自定义 React 设置内容，在所属插件详情弹窗显示 |
| `settings.sections` | 注册插件自身的具名设置项，支持懒加载组件及显示子项关联 |
| `connections` | 在常规设置的“连接”区域注册插件自己的连接选项 |
| `settingsTabs` | 注册设置页顶栏标签及懒加载内容，例如浮窗、托盘 |

贡献可带 `view`，关联该插件声明的子开关。未指定时，系统卡片/标签默认跟随 `workbench`/`usage`/`models`/`tokens` 对应子项。额外侧栏页面 ID 为 `plugin:<manifest.id>:<name>`；入口与页面 ID 必须一致，禁止重复、覆盖设置页或引用未声明的开关。没有内置内容的系统页面隐藏；独立本地分析和工具配置仍保留。

连接选项和设置标签采用同一命名空间，声明 `id`、`label`、`order`、懒加载 `component`，以及可选的 `view`。宿主拒绝重复 ID 和未声明的子开关，仅挂载活动贡献。NewAPI 注册站点及专用令牌连接设置，Codex 注册本机 CLI 连接检测；浮窗、托盘分别注册自己的设置标签。停用插件立即移除连接、顶栏标签及内容，当前标签被撤回时回到常规设置，退出动画也不保留撤回内容。常规设置和实时日志属于固定宿主标签。插件状态更新保留设置页实例及仍可用组件的编辑状态。

`settings.sections` 的每项声明 `id`、`title`、可选 `description` / `view` 和 React `component`。ID 在所属插件内唯一，关联的显示子项必须由 manifest 声明；组件通过既有受限 bridge 和偏好补丁读写，不提供通用字段写入器。宿主首次打开详情弹窗才加载组件，关闭再打开保留活动组件草稿。六个可配置内置插件均注册自身设置；工具适配器复用自己已有的上下文等选项，保存后用于下一次配置预览。外部包现有 `settingsTab` 同时映射到所属插件的详情弹窗，仍在隔离 frame 中运行。

内置插件自己的 renderer 组件也只能经现有受限 bridge 访问数据。声明设置或页面不会授予文件、网络或通用 IPC 权限；新增特权操作必须同时增加窄 DTO、固定 preload 方法和校验过的 main handler。外部插件不能复用可信 main/React 模块接口；以 JSON 清单声明贡献和权限，通过 sandbox frame、固定 SDK broker 获取受控数据与网络/独立存储。外部 JS 不进入宿主界面或主进程执行。

## 主进程能力与生命周期

`shared/plugin-host.ts` 按 `{sourceId, capability}` 注册类型化能力。sourceId 是插件 ID，区别于站点/账户。宿主校验重复注册、缺失依赖和循环，串行启停、失败回收并逆序清理。必需依赖自动激活，可选依赖按需获取。每个能力引用带激活代次检查，停用后的迟到成功/失败不会进入新生命周期。

`electron/host/plugins.ts` 装配 main 实现、操作锁及设置持久化。`port()` 是可信主进程门面，每次调用重新获取当前活动能力，防止插件重启后复用旧服务。NewAPI 停用关闭客户端、中止请求/清空缓存、撤回内容并清除配置预览；不删除凭据、收藏、配置、备份或子项选择。写令牌、登录、配钥及配置提交期间拒绝停用提供者；关闭令牌子项也不能中断正在执行的令牌操作。

父开关改变 `pluginEnabled` 和实际运行状态；子开关只控制贡献显示，不关闭供工具或桌面投影使用的底层能力。原先五个系统页面标志中的工作台/用量/模型/令牌开关迁移到 NewAPI 子项，旧 Tools 标志不再使统一工具界面不可用。失败恢复内存与运行状态；浮窗兼容 `widgetEnabled`，主开关与旧入口共用生命周期。

浮窗和托盘的 `runtime.ts` 独立拥有受限窗口/IPC、缓存策略、刷新调度和主题订阅；托盘还拥有系统图标与 macOS native helper。`electron/main.ts` 只注入 `DesktopSurfaceEnvironment` 中的平台设施、偏好和操作接口，宿主通过 `surface.control` 通知活动表面，不创建面板或安排其定时刷新。显示内容分别来自 `usage.present` / `workbench.present` 系统能力，插件不直接访问提供者、凭据库或 React 页面。

停用浮窗释放窗口、移除专属 IPC 并停止调度；停用托盘关闭面板/native helper、销毁图标并取消定时刷新及主题订阅。重新启用创建新的受限面板；旧 helper 的迟到失败不能复活已停用的托盘。桌面缓存身份包含提供者和表面插件代次，不能显示停用前的账户数据。显示服务独立于主窗口 React 挂载；当前投影仍使用 NewAPI 的在线余额/报价，Codex 订阅卡片尚未接入桌面来源选择。

## 界面状态和来源

设置页保持稳定挂载；父子滑块更新不调用 bootstrap 重载，保留草稿、焦点、滚动、二级菜单与弹窗。插件撤回的页面立即移除，包括退出动画保留的旧页面。NewAPI 的 Dashboard/目录同时校验账户和提供者生命周期；同账户刷新保留旧数据，账户/插件代次变化立即隔离旧快照。

卡片和标签声明 `site` 或 `independent` 范围。站点切换只重置 NewAPI 内容，Codex 和本地会话保持独立。本地筛选保存在 `sourceSelections`，不继承在线令牌 ID；关闭详情/视图释放有限快照和句柄。会话正文只读、不上传、不进入应用日志。

## 插件市场

市场是宿主的插件管理入口，通过固定的 `extensionMarket`、`installExtension`、`removeExtension` IPC 浏览官方 `zhaojiseng/lumi-extensions` 仓库及管理用户目录包。renderer 不提供下载地址或文件路径；安装只接受已读取目录中的插件 ID 和提交 SHA。主进程固定 HTTPS 来源、不带账户凭据、不跟随重定向，限制响应大小和超时，并核对所有下载文件的 Git blob 摘要。

下载到内存后，ExtensionHost 在同盘临时目录写入并复用目录包校验，原子替换用户插件目录；设置持久化失败恢复原目录和活动代次。安装/更新仅撤回目标插件，保持其它插件的固定字节和生命周期；更新后的目标停用，接受新清单后再启用。卸载保留独立设置、存储、凭据和外观选择，只有用户目录副本可删除。用户目录优先于随程序分发的同 ID 包，同一根目录中的重复 ID 仍是错误。

目录缓存限时五分钟，可手动刷新；不可用或不兼容的清单显示诊断，不作为可安装条目。市场界面复用受限外观预览，安装/更新/卸载通过 PluginResource 更新贡献和清单，不调用 bootstrap 或重载设置。开发指南包括无需主程序源码的接入和发布步骤。

## 外观贡献

界面插件的 `interface` 可声明 `preview` 静态 HTML 片段和 `appearanceGroups`。宿主将受限 CSS、系统颜色模式、平台类和插件外观选择应用到独立 sandbox 预览文档；缺省使用系统示例模板。预览没有脚本、网络、SDK 或主窗口 bridge，非法模板回退到系统预览。

外观组按插件声明生成选项，选择以 `interfaceSelections` 保存，经固定 preferences IPC 校验活动插件和合法选项。宿主在外壳设置 `data-appearance-<组ID>`，语义配色继续同步到浮窗/托盘；数值快照包含选择键，迟到配色不能覆盖新选择。插件撤回后隐藏外观组，保存值保留；已移除的选项按新清单默认值解析。完整独立开发契约及可运行模板见 [插件开发指南](PLUGIN_DEVELOPMENT.md#7-界面插件布局与皮肤)。

## Codex 订阅用量

`provider.codex/subscriptionUsage.read` 经固定 `readCodexUsage` IPC 读取。发现 CLI 后，以 `-s read-only -a never app-server` 启动隐藏 stdio 子进程，发送初始化、`account/read`、`account/rateLimits/read` 和账户复核。不发送 turn/thread、登录、退出、购买或积分兑换命令。

需要已安装 CLI 并由用户完成 `codex login`；认证由 CLI 自身管理，API Key 认证不支持订阅限额。尊重 `CODEX_HOME`；Lumi 不复制或持久化 OAuth token，登录文件只限量读取生成进程内摘要，原始 stderr/错误不记录到应用日志。CLI 自身可能刷新其认证缓存。

使用服务返回的窗口长度和 Unix 重置时间，多模型桶分别显示；积分来自 `credits.balance`，缺失值保持未知，不由本地 Tokens 或 NewAPI 余额推算。缓存按认证摘要隔离并限时 60 秒，读取超时/大小有上限；停用终止子进程并撤销迟到结果。NewAPI 未连接或停用时，Codex 工作台内容仍可独立显示。

依据：[官方 app-server 文档](https://developers.openai.com/codex/app-server/) 与 [CodexBar CLI 读取路径](https://github.com/steipete/CodexBar/blob/main/Sources/CodexBarCore/UsageFetcher.swift)。不抓浏览器 cookie 或使用未公开的 HTTP 路径。

## 验证与保留边界

运行 `npm run pretest` 后，可针对 `plugin-host`、`plugin-catalog`、`plugin-integration`、`renderer-plugins`、`codex-subscription`、`workbench-sources-ui`、`plugin-layout-ui`、`plugin-settings-tree-ui`、`tools-plugin-lifecycle-ui`、`desktop-plugin-lifecycle` 测试文件检查生命周期、设置迁移、持久化回滚、内容/侧栏/连接/设置标签贡献、实际配置预览撤销、浏览器权限及构建边界。隐藏 Chromium 用真实设置组件验证六个父开关、五个子开关、树状折叠及编辑状态保留；真实 App/CSS 在 1280/1100 宽度检查页面间距、溢出及标题栏下方的悬浮圆角侧栏。构建后的 `npm run test:desktop` 验证固定 IPC、提供者重启、设置持久化、受限浮窗/托盘的关闭重建及本地详情。

`extensions` 与 `interface-plugin-ui` 回归验证界面清单、独占选择、原子持久化、更新/缺包回退、受限 CSS、真实 App 布局及设置草稿/焦点/滚动保留；桌面 smoke 验证实际 IPC、启停、扫描及恢复。测试使用隔离目录、模拟 CLI/服务和假凭据。现有 AppContext/Dashboard 仍有兼容数据路径；子项隐藏不代表停止所有目录/用量请求。默认主题继续提供语义 token；外部界面样式在其上覆盖。Codex 历史同步和工具事务继续由 ConfigService 管理，不能把只读统计与显式 apply/restore 写入混淆。
