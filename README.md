# Lumi · AI 工作台

Lumi 是基于 Electron、React 和 TypeScript 的 New API 桌面客户端，集中查看账户、模型定价与用量，并配置 Codex 和 Claude Code CLI。采用扁平化浅色 / 深色界面，模型及工具品牌图标来自 Lobe Icons。

[下载最新版本](https://github.com/zhaojiseng/lumi/releases/latest) · [构建与发布](https://github.com/zhaojiseng/lumi/actions/workflows/package.yml)

## 功能

- 账户密码登录、双重验证与站点登录窗口；支持多个自定义 New API 站点。
- 余额、请求明细、缓存读写、速率、首字延迟和状态码；支持筛选、错误详情与 CSV 导出。
- 工作台提供 1 / 7 / 30 天及自定义日期范围，曲线按范围调整粒度，每分钟刷新。
- 模型广场按名称排序、收藏置顶，默认显示最低价渠道；展示完整单价、条件档位、时间倍率和固定 24 格健康状态。
- Codex / Claude Code 直连配置，自动复用或创建 `Lumi-` 专用令牌；提供脱敏预览、系统加密备份和恢复。
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

Windows 输出 `release/Lumi-<version>-x64.exe`；`npm run dist:dir` 生成目录版。发行包目前未签名，也没有自动更新或支付功能。Electron 安装包需下载相应系统的运行时。

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
