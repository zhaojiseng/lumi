# Lumi 架构

当前说明对应 0.4.23。Electron 主进程负责网络、凭据和本机文件；React 渲染器通过受限 IPC 调用业务服务。

## 分层

| 位置 | 职责 |
| --- | --- |
| shared/types.ts | 业务 DTO、IPC 契约及不含真实站点的默认配置 |
| shared/catalog.ts / pricing.ts | 可达渠道、最低价与站点表达式的公布单价；使用受限 AST，不执行脚本 |
| shared/range.ts / utils.ts | 日期范围、动态分组、币种换算与 CSV |
| shared/trends.ts | 按模型 / 令牌分组、动态时间粒度、空桶补齐与多曲线合计 |
| shared/usage-quality.ts | 模型缓存命中率、按耗时加权的 Token 速率及有效样本覆盖 |
| shared/statistics.ts | 模型多选与真实令牌 ID 多选，维度内 OR、维度间 AND |
| shared/logs.ts / health.ts | 缓存、速度、时间和状态元数据归一化；固定 24 格健康采样 |
| shared/selections.ts | 按站点保存并合并页面选择 |
| electron/services/store.ts | 原子串行写入、safeStorage 密钥库、设置迁移和账户隔离 |
| electron/services/new-api.ts | 登录 / 验证 / 续期、数据接口、专用令牌复用与创建 |
| electron/services/read-cache.ts | 有期限的内存只读缓存、并发合并、副本隔离及写操作失效 |
| electron/services/updates.ts / native-updater.ts | GitHub 正式版检查、NSIS 标准更新、下载校验与重启安装 |
| electron/services/browser-login.ts / login-capture.ts | 隔离站点窗口与认证捕获；重新验证账户后保存 |
| electron/services/config.ts | 脱敏预览、加密备份、应用 / 恢复、冲突检查与回滚 |
| electron/services/codex-direct.ts / codex-sessions.ts | Codex 历史及索引同步、运行状态检查 |
| electron/services/local-usage.ts | 本机 JSONL 用量元数据提取 |
| electron/services/tool-runtime.ts | CLI 路径和版本检测、固定厂商安装命令及安装状态 |
| electron/services/app-logs.ts | 启动以来的脱敏内存日志、只读快照和实时事件 |
| electron/services/mac-updater.ts / window-layout.ts | macOS ARM64 Release 下载与校验、原生窗口布局和系统菜单 |
| electron/startup.ts / scripts/package.mjs | 同窗口矢量启动画面、当前用户安装包与更新元数据 |
| electron/main.ts / preload.ts | 窗口、托盘、通知及参数校验后的有限 IPC |
| src/components / pages | 账户、请求、模型、工具、令牌与设置界面 |

品牌图标统一在 BrandIcon.tsx，使用本地官方 SVG。主题通过 theme.css 覆盖基础样式，最后加载 updates-trends.css 和 filters-tools-motion.css 提供更新栏、分组曲线、筛选、紧凑工具布局及切换动画，使用不透明表面与语义颜色。

## 配置事务

用户选择模型与渠道后，主进程验证站点和本机配置，复用 / 创建专用令牌，构造脱敏预览。应用前再次校验账户、站点、原始文件内容和预览时效，再加密备份并写入；失败尝试回滚。

每个站点 / 工具使用固定名称的专用令牌（默认 `Lumi-Codex` / `Lumi-Claude`），切换渠道更新同一 ID，不轮换密钥；旧渠道名称迁移时记录历史名称，统计同时保留旧记录归属。渠道变更发生在预览配钥阶段，令牌已有额度、有效期、模型限制与 IP 规则保留；不可用令牌不自动启用或绕过限制。应用时拒绝已被后续渠道切换修改的旧预览。

macOS 菜单栏由 Electron 的系统 Tray 与原生 Menu 实现，图标为系统模板图像，适应浅色 / 深色菜单栏。原生 NSMenu 由系统决定材质与液态玻璃外观，无自绘网页弹窗。`menuBarUsage()` 只读账户与今日汇总，不分页读取消费明细或查询模型广场；一分钟内复用内存缓存，与站点请求缓存共享数据，账户身份变更立即清空。菜单立即打开，后台完成查询后更新原生菜单项目。

Codex 修改真实模型 ID、provider、地址、认证与上下文设置，尊重活动 profile 和 CODEX_HOME。不会定义或复制提示词，也不生成模型目录。旧版 Lumi 模型目录引用可迁移，原目录内容保持不变。

同步涉及本程序管理的相关会话最新设置与可用索引字段，保留历史回合和用户指令。运行中的 Codex 持有旧设置，因此应用前要求退出，完成后重开。预览、备份与恢复同时覆盖相关文件和索引行。

Claude Code 合并 CLI settings.json 中的 API 配置，保留无关设置；Claude Desktop 不属于当前集成范围。所有模型的选择依据本站可达渠道，不按目录缺少协议标签禁用。

## 网络与数据

公开状态不携带凭据，账户请求使用作用域快照。切换站点、退出或改变身份会使旧请求和配置预览失效。并发续期 / 配钥分别共享任务，拒绝跳转和 TLS 校验绕过。

主进程的只读缓存由作用域客户端共享，按站点、地址、账户凭据摘要及查询参数隔离。余额 / 令牌缓存 30 秒，日志 15 秒，用量 / 健康度 1 分钟，状态 / 定价 5 分钟；最多 256 项，失败不缓存。手动刷新及站点写操作失效相关缓存，在途旧任务不能写回。缓存不写入账户或浏览器存储，命中后仍校验作用域。

按令牌曲线及效率统计复用完整消费分页，返回纯用量点和汇总指标，超过 10,000 条要求缩小时间范围。效率统计在后台读取并缓存 5 分钟；图表沿用动态粒度，超过 8 个分组将其余合并，保留总量并允许任意单项查看。

HTML 内联启动页在主脚本加载前可显示，React 在本机设置初始化时沿用同一界面。`bootstrap` 只返回本机设置与运行环境，工具配置由 `inspectConfigs` 后台读取；首页动态资源提前加载，账户数据与公开状态并行请求。详细效率统计后加载，初始化失败提供重试，无人为等待时间或伪进度。

Windows 使用当前用户 NSIS 安装包，程序文件只在安装和更新时解压。Electron 在读取设置前创建最终主窗口并载入本地矢量加载画面，随后在同一窗口载入主页面，避免位图缩放和两次窗口交接。electron-updater 延迟初始化，版本检测只在工具页运行。

统计筛选按站点保存范围、模型数组和令牌 ID 数组。起止时间为本地分钟，结束分钟包含 59 秒，今天上限截断到当前时刻。分钟范围或多选条件需要完整日志，缓存按账户和时间范围共享，不因筛选组合重复分页；10,000 条上限、缺失令牌 ID 或分页变化时停止准确统计。默认日期范围继续使用站点小时统计。切换范围保留旧仪表盘，成功后替换；账户变化才清空。

CLI 检测优先继承 PATH 的实际入口，再补充用户 / 系统 PATH 和常用位置，排除 Windows App Execution Aliases。状态缓存 30 秒，工具页与窗口重新获得焦点时检测。安装 IPC 仅接受 codex / claude 枚举，使用固定官方安装器；npm 更新锚定原前缀。安装输出限长并脱敏，下载失败不执行，结束后重新读取实际版本。测试使用注入执行器，不安装用户本机工具。

ChatGPT 桌面版本通过系统安装元数据读取，Windows 兼容已知 OpenAI.Codex / CodexBeta 注册名并核对 ChatGPT.exe，优先正式版。CLI 最新版来自官方 npm 包，Windows ChatGPT 最新版来自 Microsoft Store 正式目录并匹配当前架构；成功缓存 30 分钟、失败缓存 5 分钟，手动重新检测跳过缓存。先发送本机状态，再补充最新版，远程失败不改变安装状态。macOS ChatGPT 最新版暂不可查。

macOS 工具页后台读取登录 Shell 的 PATH，保留原路径优先并补充 Homebrew 与常见版本管理器，Node 所在目录加入执行环境；npm / CLI / 安装器复用同一环境。Shell 检测限时 5 秒，并发任务共享，手动检测会刷新；启动首页不等待 Shell。

macOS 使用隐藏标题栏和原生交通灯按钮，侧栏顶部保留按钮空间，主页面不重复显示 Windows 控件。菜单保留编辑、窗口、显示和退出操作，关闭主窗口时隐藏并通过 Dock 激活重新显示。侧栏导航独立滚动，底部设置 / 更新 / 站点固定。

运行日志从主进程加载时写入内存，记录启动、主进程控制台、界面控制台、IPC 操作耗时、请求状态、工具检测和更新阶段。日志不记录请求体、响应体或认证头，并在写入时脱敏常见密码 / 密钥 / Cookie 字段及 URL 查询；最多 10,000 条，每条 4,000 字符。只读快照与实时订阅均通过受限 preload 提供，界面每 150 ms 合并显示，每页最多 300 条；暂停仅冻结显示，重新进入可读取本次启动的全部保留记录，不写文件。

默认占位站点没有网络请求。初次配置后的数据来自用户选择的服务器；登录、余额、消费、模型与健康度不使用演示数据。缺失元数据保留“—”或灰色采样条。

远程登录窗口无 Node / preload / Lumi IPC，站点权限请求与任意新窗口被拒绝。凭据和原始配置备份由系统加密存储保护，密码不落盘。浏览器预览只提供公开状态，不处理账户凭据。

GitHub 更新服务独立于账户 API，正式安装包使用 electron-updater 的 GitHub / NSIS Provider。启动后及每 4 小时检查，校验正式版本与固定文件名；下载和重启前验证大小及 SHA-512。发布包含 latest.yml 和 blockmap。点击重启更新后调用 quitAndInstall(true, true)，后台安装并重开；autoInstallOnAppQuit=false，正常退出不自动升级。

更新提示和设置页使用同一状态订阅；隐藏版本号作为全局偏好保存，设置页始终保留查看和恢复入口。GitHub 构建在 Windows x64 与 macOS ARM64 本机分别打包；Mac DMG 使用临时签名并核验应用及 Electron 架构，Electron / Chromium 许可另复制入应用 Resources，发布时合并两平台校验清单。

macOS ARM64 更新读取固定 GitHub 仓库的最新正式 Release，仅接受对应 DMG 名称、大小与 GitHub 的 SHA-256 digest。下载到本机更新目录并清理取消的临时文件，校验后才提供打开入口，打开前再次核验。Mac 未配置自动安装：打开 DMG 后由用户退出并替换 Applications 中的应用。

## 构建与许可

Vite 构建渲染器，esbuild 构建 Electron 主进程 / preload。generate-notices.mjs 按锁文件收集非开发依赖及其完整许可；额外参考项目许可保存在 public/third-party。

打包仅使用 dist、dist-electron、应用资源及清单，不包含源依赖树、测试、调研或用户数据。verify-release.mjs 检查 app.asar 和生产文件一致，并生成校验文件。
