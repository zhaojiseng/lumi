# Lumi · AI 工作台

Lumi 是基于 Electron、React 和 TypeScript 的 New API 桌面客户端，集中查看账户、模型定价与用量，并配置 Codex 和 Claude Code CLI。采用扁平化浅色 / 深色界面，模型及工具品牌图标来自 Lobe Icons。

[下载最新版本](https://github.com/zhaojiseng/lumi/releases/latest) · [构建与发布](https://github.com/zhaojiseng/lumi/actions/workflows/package.yml)

## 功能

- 账户密码登录、双重验证与站点登录窗口；支持多个自定义 New API 站点。
- 余额、请求明细、缓存读写、速率、首字延迟和状态码；支持筛选、错误详情与 CSV 导出。
- 工作台与用量分析提供 1 / 7 / 30 天及精确到分钟的时间范围；模型、令牌均可多选，两类条件取交集，每分钟刷新。
- 工作台与站点消费曲线按实际时间范围等分为约 30 段，支持消费、Tokens、请求与缓存命中率；指标、模型 / 令牌分组及单项选择统一放在右上角，选择按站点保存。短期只读缓存与并发请求合并减少站点压力。
- 当前范围的模型缓存命中率、平均 Token 速率与有效样本数量；Windows 安装后直接启动，同一窗口显示清晰的矢量加载画面。
- Windows 安装版自动检查 GitHub 最新正式 Release，左栏使用柔和绿色显示新版本和下载进度，可隐藏当前版本提示；设置中仍可查看及恢复，下载校验通过后点击“重启更新”完成后台升级。
- 模型广场按名称排序、收藏置顶，默认显示最低价渠道；展示完整单价、条件档位、时间倍率和固定 24 格健康状态。
- Codex / Claude Code 直连配置，自动复用或创建 `Lumi-` 专用令牌；提供脱敏预览、系统加密备份和恢复。
- 分别展示 Codex CLI、ChatGPT 桌面应用和 Claude Code CLI 的当前版本与最新版本，最新版查询失败不影响本机检测；CLI 支持官方自动安装和更新，工具定价默认收起，专用密钥说明点击感叹号查看。
- Codex 上下文提供 272K / 1M，切换时同步本程序管理的旧对话；提示词与默认模型行为交由工具自身管理。
- API 令牌查看 / 复制、启停、额度、有效期、渠道、模型限制与 IP 白名单控制。
- 本机 Codex / Claude Code 用量统计；列表列选择、渠道、档位及时间范围按站点保存。
- macOS 原生窗口按钮、菜单栏和 ⌘ 快捷键，兼容 Homebrew / NVM 等 Node 安装环境；侧栏更新入口在小窗口中保持可见。
- macOS 菜单栏提供参考 CodexBar 的原生用量卡片，切换全部 / Codex / Claude 与今日 / 7 天 / 30 天，查看余额、消费、Tokens、曲线、模型排行、缓存命中率和 Token 速率。系统绘制菜单材质与液态玻璃外观，当前只接入 New API 用量。
- 设置中的“实时日志”二级页面显示本次启动的运行记录，可筛选、搜索与暂停；敏感字段脱敏，日志仅在内存中保留，退出清空。
- Windows / macOS 置顶浮窗采用 244×64 横条，只显示余额、最近消费与最新请求模型；用数字“输入 / 输出”展示 Tokens，输入下方用较小淡色数字展示缓存读取，缓存写入保留在悬停详情；无消耗时回溯最近消费分钟，时间与补充信息放在悬停提示中。拖动位置与开关跨启动保存。
- 数据刷新动画可在设置选择向上 / 向下滚动、模糊后清晰、淡入、轻微缩放或关闭；旧内容退出后再换入新数据，支持预览、相同数据去重及系统减少动态效果。

Claude 集成面向 Claude Code CLI。价格、渠道及健康度以站点返回的数据为准；部分 New API 版本或部署可能未提供健康统计等扩展接口。

## 开始使用

需要 Node.js 24 或更新版本、npm 11 或更新版本、Git，以及你有权访问的 New API 站点。发行包提供 Windows x64 安装包和 macOS Apple Silicon ARM64 DMG；Linux 暂不提供安装包。

```bash
npm ci
npm run setup:electron
npm run dev
```

自动检查使用 `npm ci --ignore-scripts`；当前锁定依赖在该模式下可完成测试和构建，桌面运行前仍需执行 `npm run setup:electron`。也可只查看浏览器界面：

```bash
npm run dev:web
```

首次运行在设置中编辑示例站点，填写实际地址，然后登录。示例地址 `https://api.example.com` 为占位值，程序不会向它请求数据。已有本机站点与账户设置继续保留。浏览器模式只预览界面和已配置站点的公开信息；登录、密钥及工具配置操作需要 Electron。

在“设置 → 浮窗挂件”选择 API 或本地会话数据源并开启挂件，也可从 Windows 托盘菜单切换。统计范围从最近一次模型调用、1 分钟逐步增加到 30 天，两种数据源共用并自动保存。API 模式按完整分钟同步；默认一分钟无消费时回溯最近消费分钟，历史回溯最多检查 2,000 条记录，明确选择更长范围时按区间汇总。超过 10,000 条接口安全上限会保留上次结果并提示失败。

本地模式每秒以只读方式续读 Codex / Claude 会话追加数据，保存文件字节偏移及最近 30 天分钟聚合，切换范围无需重读历史。最近消费按线上公布的模型公式、调用时间和配置渠道倍率估算，余额来自在线账户；缺少模型价格或必要计价字段时显示未知值，以站点账单为准。输入显示可选“包含缓存读取”（默认）或“仅未命中输入”，API 与本地一致，均不含缓存写入，切换口径不改变费用。悬停查看时间与补充信息，关闭挂件停止自动读取。

“用量分析 → 本机会话”提供真实扫描进度，解析会话标题、首条用户问题、项目与分支等辨识信息。曲线按实际范围等分最多 30 段；会话列表每次展开 20 条。打开详情后一次完整读取调用索引，每页 50 条浏览全部匹配调用，支持页码跳转；完整会话和调用相关的用户消息、回复、思考、工具及错误每页 20 条显示。原始记录每块最多 64 KiB，较大记录也可分块查看。

调用列表遵循当前筛选，完整会话内容展示整个文件快照。Codex 日志无法精确区分请求时标注同轮上下文；Claude 按消息标识关联。临时索引仅保存用量与字节位置，正文从原文件只读获取，关闭详情释放索引；会话内容只在本机显示，不上传。

进入工具配置页，先选模型，再选渠道，预览后应用。应用 Codex 配置前需退出 Codex，再重新打开以载入配置和同步后的会话；Claude Code 同样需重启。上下文大小应符合你使用的模型实际能力。

未安装 CLI 时可点击“自动安装”，程序使用 [Codex 官方安装方式](https://developers.openai.com/codex/cli/) 和 [Claude Code 官方安装方式](https://code.claude.com/docs/en/setup)。更新已有 npm 安装时保留原安装前缀。版本检测不会启动模型请求或修改工具配置。

分钟范围及模型 / 令牌多选的消费统计由完整请求日志计算，最多 10,000 条；超出时缩小时间范围，不会用最近一页推算总量。本机会话不包含站点令牌 ID，选择令牌后会提示无法进行本地令牌筛选。

## 开发与打包

```bash
git config --local core.hooksPath .githooks
npm run check:secrets
npm run typecheck
npm test
npm run build
npm run dist
npm run verify:release
```

Windows 输出 `release/Lumi-<version>-x64.exe` 安装包及软件内更新所需的 `latest.yml`、`.blockmap`；`npm run dist:dir` 生成目录版。发行包目前未签名。构建需下载相应系统的 Electron 运行时。

在 Apple Silicon Mac 上执行同样命令，生成 `release/Lumi-<version>-arm64.dmg`。打开 DMG 后将 Lumi 拖入 Applications。Mac 版会自动检查 GitHub 正式 Release，可在软件内下载并校验新版 DMG；点击“打开安装包”后退出 Lumi，将新应用拖入 Applications 替换。Mac 包使用临时签名，尚未进行 Apple 公证，首次打开可能需要通过系统“隐私与安全性”允许。

安装默认针对当前 Windows 用户，支持选择安装目录；程序文件只在安装和更新时解压。旧便携用户首次迁移需运行新安装包一次，账号与配置继续使用原 Electron 用户数据目录，旧程序缓存不主动删除。软件内更新面向安装版。

Windows x64 安装版在启动后及每 4 小时检查 GitHub 正式 Release。左栏点击“下载更新”，显示进度、支持取消 / 重试；通过文件大小与 SHA-512 校验后，点击“重启更新”由 electron-updater 静默安装并自动重新打开，无需再次操作安装向导。普通退出不会自动安装，账号与本机设置保留。开发 / 浏览器模式不自动检查更新。

GitHub Actions 在推送 main 后自动执行 Windows / Linux / macOS 检查，并生成 Windows x64 安装包和 macOS ARM64 DMG；推送与版本号一致的 v 标签后，检查和打包通过才会发布 Release，附带两个安装包、源码 ZIP、Windows 更新元数据及统一 SHA-256 校验文件。也可手动运行工作流；详见 [发布流程](docs/RELEASING.md)，验证记录见 [docs/VALIDATION.md](docs/VALIDATION.md)。

## 数据与本机文件

账号密码仅用于当次登录，访问凭据、Cookie 和配置备份通过 Electron `safeStorage` 加密保存。系统加密存储不可用时，软件拒绝保存凭据。HTTP 站点登录需要明确开启明文传输选项，建议优先使用 HTTPS。

| 对象 | 读取 / 修改范围 |
| --- | --- |
| Codex | `CODEX_HOME` 或 `~/.codex` 下的 config.toml / auth.json；相关 Lumi 会话及其索引有预览、加密备份和冲突检查 |
| Claude Code | `~/.claude/settings.json` |
| 本地用量 | Codex / Claude 会话用量、可读标题与项目信息，详情可在本机查看消息和工具记录 |
| Lumi | 操作系统应用数据目录中的加密设置与备份；不在源代码目录保存真实凭据 |

本地用量扫描不上传会话内容。模型调用直连你选择的 New API 站点；消费以站点账单为准。Lumi 仅展示公布单价和条件，不提供模拟请求计费。

站点只读数据使用进程内缓存，按站点及登录账户隔离，不写入磁盘。价格与公开信息缓存 5 分钟、趋势 / 统计 / 健康度 1 分钟、账户 / 令牌 30 秒、请求明细 15 秒；手动点击刷新重新获取。令牌修改和退出登录使缓存失效，失败响应不缓存。

工作台与站点消费曲线及模型使用效率复用完整消费日志查询，最多 10,000 条；超过时提示缩小范围，避免展示不完整汇总。Tokens 为站点公布的输入加输出，不重复累加缓存分类。曲线保留原始请求时间后按当前范围分段，无法用小时汇总还原更细的采样。缓存曲线每段以有效缓存读取总量 ÷ 对应输入总量计算；缺失数据留空，其它模型 / 令牌合并后仍按输入量加权。

模型缓存命中率为有效记录的缓存读取 Tokens 合计 ÷ 对应输入 Tokens 合计；平均 Token 速率为输出 Tokens 合计 ÷ 总耗时合计（含首字等待）。仅统计成功消费记录，缺失 / 无效字段不当作零，显示有效样本覆盖数。两项指标在后台统计，缓存 5 分钟，手动刷新立即失效。

Git 忽略凭据、配置备份、会话、日志、数据库、测试生成文件、截图和发行包。提交 / 推送钩子检查暂存内容与将推送的历史；规则不能代替人工检查。

## 参与项目

- [贡献指南](CONTRIBUTING.md)
- [插件开发指南](docs/PLUGIN_DEVELOPMENT.md)：无需程序源码，按完整示例、清单、SDK/数据类型及已安装程序即可开发功能/界面插件。
- [额外插件安装与速查](extensions/README.md)：独立文件包的安装、贡献与权限；插件包不编译进 EXE。
- [行为准则](CODE_OF_CONDUCT.md)
- [安全问题报告](SECURITY.md)
- [更新记录](CHANGELOG.md)
- [接口说明](docs/API.md)、[架构](docs/ARCHITECTURE.md)
- [公开发布流程](docs/RELEASING.md)

问题和反馈请使用本仓库 Issues，避免提交账号、API 密钥、Cookie、会话内容或原始配置。

## 许可与致谢

Lumi 使用 [MIT License](LICENSE)。第三方组件和图标遵循各自许可，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)；构建会生成随安装包分发的完整依赖许可文本。

配置管理流程参考 [CC Switch](https://github.com/farion1231/cc-switch)，通过 HTTP API 对接 [New API](https://github.com/QuantumNous/new-api)；图标采用 [Lobe Icons](https://github.com/lobehub/lobe-icons)。Lumi 是社区项目，与 OpenAI、Anthropic 及上述项目无官方隶属关系。品牌标识归各自权利人所有。
