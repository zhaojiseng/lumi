# Lumi · AI 工作台

Lumi 是基于 Electron、React 和 TypeScript 的 New API 桌面客户端，集中查看账户、模型定价与用量，并配置 Codex 和 Claude Code CLI。采用扁平化浅色 / 深色界面，模型及工具品牌图标来自 Lobe Icons。

[下载最新版本](https://github.com/zhaojiseng/lumi/releases/latest) · [构建与发布](https://github.com/zhaojiseng/lumi/actions/workflows/package.yml)

## 功能

- 账户密码登录、双重验证与站点登录窗口；支持多个自定义 New API 站点。
- 余额、请求明细、缓存读写、速率、首字延迟和状态码；支持筛选、错误详情与 CSV 导出。
- 工作台与用量分析提供 1 / 7 / 30 天及精确到分钟的时间范围；模型、令牌均可多选，两类条件取交集，每分钟刷新。
- 工作台与站点消费曲线可按模型 / 令牌分色对比或选择单项；只缓存短期只读数据，合并并发请求以减少站点压力。
- 当前范围的模型缓存命中率、平均 Token 速率与有效样本数量；Windows 便携包解压时即显示加载提示，缓存解压结果以加快再次打开。
- 自动检查 GitHub 最新正式 Release，左栏显示版本提示、下载进度与完成入口，下载文件核对 SHA-256。
- 模型广场按名称排序、收藏置顶，默认显示最低价渠道；展示完整单价、条件档位、时间倍率和固定 24 格健康状态。
- Codex / Claude Code 直连配置，自动复用或创建 `Lumi-` 专用令牌；提供脱敏预览、系统加密备份和恢复。
- 检测 Codex / Claude Code CLI 的安装路径与版本，支持官方自动安装和更新；工具定价默认收起，专用密钥说明点击感叹号查看。
- Codex 上下文提供 272K / 1M，切换时同步本程序管理的旧对话；提示词与默认模型行为交由工具自身管理。
- API 令牌查看 / 复制、启停、额度、有效期、渠道、模型限制与 IP 白名单控制。
- 本机 Codex / Claude Code 用量统计；列表列选择、渠道、档位及时间范围按站点保存。

Claude 集成面向 Claude Code CLI。价格、渠道及健康度以站点返回的数据为准；部分 New API 版本或部署可能未提供健康统计等扩展接口。

## 开始使用

需要 Node.js 24 或更新版本、npm 11 或更新版本、Git，以及你有权访问的 New API 站点。Windows x64 是当前验证的打包平台；macOS / Linux 的安装包需在对应系统构建验证。

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

Windows 输出 `release/Lumi-<version>-x64.exe`；`npm run dist:dir` 生成目录版。发行包目前未签名。Electron 安装包需下载相应系统的运行时。

便携版首次运行将程序文件缓存到 `%LOCALAPPDATA%/Lumi/portable/`，后续打开复用同一构建缓存；新构建使用独立目录。此目录只存程序文件，账户与配置仍位于 Electron 的用户数据目录。

Windows x64 发行版在启动后及每 4 小时检查 GitHub 正式 Release。左栏点击新版本提示下载，显示进度、支持取消 / 重试；通过文件大小与 SHA-256 校验后，可打开文件夹。退出当前 Lumi，再运行新版便携 EXE；账号和本机设置保留。开发 / 浏览器模式不自动下载更新。

GitHub Actions 在推送 main 后自动执行 Windows / Linux 检查并生成 Windows x64 构建包；推送与版本号一致的 v 标签后，检查和打包通过才会发布 Release，附带便携 EXE、源码 ZIP 和 SHA-256 校验文件。也可手动运行工作流；详见 [发布流程](docs/RELEASING.md)，验证记录见 [docs/VALIDATION.md](docs/VALIDATION.md)。

## 数据与本机文件

账号密码仅用于当次登录，访问凭据、Cookie 和配置备份通过 Electron `safeStorage` 加密保存。系统加密存储不可用时，软件拒绝保存凭据。HTTP 站点登录需要明确开启明文传输选项，建议优先使用 HTTPS。

| 对象 | 读取 / 修改范围 |
| --- | --- |
| Codex | `CODEX_HOME` 或 `~/.codex` 下的 config.toml / auth.json；相关 Lumi 会话及其索引有预览、加密备份和冲突检查 |
| Claude Code | `~/.claude/settings.json` |
| 本地用量 | Codex sessions / archived_sessions、Claude projects 中的用量元数据 |
| Lumi | 操作系统应用数据目录中的加密设置与备份；不在源代码目录保存真实凭据 |

本地用量扫描不上传会话内容。模型调用直连你选择的 New API 站点；消费以站点账单为准。Lumi 仅展示公布单价和条件，不提供模拟请求计费。

站点只读数据使用进程内缓存，按站点及登录账户隔离，不写入磁盘。价格与公开信息缓存 5 分钟、趋势 / 统计 / 健康度 1 分钟、账户 / 令牌 30 秒、请求明细 15 秒；手动点击刷新重新获取。令牌修改和退出登录使缓存失效，失败响应不缓存。

按令牌曲线及模型使用效率复用完整消费日志查询，最多 10,000 条；超过时提示缩小范围，避免展示不完整汇总。Tokens 为站点公布的输入加输出，不重复累加缓存分类。模型曲线使用站点完整汇总数据。

模型缓存命中率为有效记录的缓存读取 Tokens 合计 ÷ 对应输入 Tokens 合计；平均 Token 速率为输出 Tokens 合计 ÷ 总耗时合计（含首字等待）。仅统计成功消费记录，缺失 / 无效字段不当作零，显示有效样本覆盖数。两项指标在后台统计，缓存 5 分钟，手动刷新立即失效。

Git 忽略凭据、配置备份、会话、日志、数据库、测试生成文件、截图和发行包。提交 / 推送钩子检查暂存内容与将推送的历史；规则不能代替人工检查。

## 参与项目

- [贡献指南](CONTRIBUTING.md)
- [行为准则](CODE_OF_CONDUCT.md)
- [安全问题报告](SECURITY.md)
- [更新记录](CHANGELOG.md)
- [接口说明](docs/API.md)、[架构](docs/ARCHITECTURE.md)
- [公开发布流程](docs/RELEASING.md)

问题和反馈请使用本仓库 Issues，避免提交账号、API 密钥、Cookie、会话内容或原始配置。

## 许可与致谢

Lumi 使用 [MIT License](LICENSE)。第三方组件和图标遵循各自许可，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)；构建会生成随安装包分发的完整依赖许可文本。

配置管理流程参考 [CC Switch](https://github.com/farion1231/cc-switch)，通过 HTTP API 对接 [New API](https://github.com/QuantumNous/new-api)；图标采用 [Lobe Icons](https://github.com/lobehub/lobe-icons)。Lumi 是社区项目，与 OpenAI、Anthropic 及上述项目无官方隶属关系。品牌标识归各自权利人所有。
