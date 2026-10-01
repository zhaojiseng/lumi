# New API 对接

Lumi 使用用户填写的站点根地址。请求有超时，拒绝重定向并保留 TLS 校验；公开状态不携带凭据，账户 API 使用认证头及用户 ID。不同版本 / 部署的接口及返回字段可能不同。

## 主要接口

| 接口 | 方法 | 用途 |
| --- | --- | --- |
| /api/status | GET | 公开站点信息、配额单位、币种、公告与登录开关 |
| /api/user/login/encryption-key | GET | 可选登录加密公钥与 kid |
| /api/user/login | POST | 账号密码登录 |
| /api/user/login/verify | POST | 新版双重验证流程 |
| /api/user/login/2fa | POST | 旧版 Cookie 双重验证 |
| /api/user/auth/refresh | POST | 会话续期 |
| /api/user/auth/logout | POST | 服务端注销及本机凭据清理 |
| /api/user/token | GET | 旧版仅 Cookie 登录时取得账户访问令牌 |
| /api/user/self | GET | 身份、余额与用量统计 |
| /api/pricing | GET | 模型、定价、分组及倍率 |
| /api/data/self | GET | 按时间 / 模型的消费、Tokens 与调用数 |
| /api/log/self/stat | GET | 消费、RPM / TPM 与令牌筛选 |
| /api/log/self | GET | 请求明细分页与筛选 |
| /api/token/ | GET / POST / PUT | 令牌列表、创建、修改与启停 |
| /api/token/:id/key | POST | 取得所属令牌的完整密钥 |
| /api/token/:id | GET | key 接口缺失时的旧版密钥回退 |
| /api/perf-metrics/summary | GET | 可选扩展：模型 24h 成功率、延迟与速率 |
| /api/perf-metrics | GET | 可选扩展：模型各渠道健康信息 |

权限错误不会被当作旧接口兼容路径。健康扩展缺失时不阻断其他数据；灰格表示该小时无数据。账户错误和 HTTP 状态只显示服务器实际字段，不由成功记录猜测状态码。

## 登录与凭据

支持明文密码经 HTTPS 发送，或 New API v2 密码信封（AES-256-GCM + RSA-OAEP SHA256，password-v2 标签）。密码仅用于当次请求。JWT、Cookie、会话与工具密钥加密存储，刷新携带站点需要的 Origin / Referer / 会话标识。

Turnstile / 2FA 等交互由用户在独立站点窗口完成。主进程仅观察当前站点的账户认证请求，重新验证身份后保存，取消窗口会阻止后续保存。

令牌列表剥离密钥；查看 / 复制按所属 ID 显式读取，并在返回前重新校验登录状态。工具令牌默认为 Lumi-Codex / Lumi-Claude 加渠道，创建或复用时校验启用状态、可达模型与渠道。

## 价格、范围与缓存

模型单价支持站点倍率、固定价格、条件表达式及插件。受限解析器提取显式公布项，支持中文“或 / 且 / 非”、≥ / ≤ / ≠ 和指定时区的 weekday / hour / minute / month / day。上下文档位与当前时段分别处理，不执行用户脚本或模拟收费请求。

缓存写入期限仅在站点明确公布时显示；不按 GPT / Claude 名称补出 5m / 1h。复杂或无法确认的规则保留原文，不虚构单价。

消费、曲线和日志使用同一起止时间；今日统计单独查询。曲线根据范围从小时细化到多日汇总。账单输入与缓存值不再次合算；本地用量以事件增量和去重结果统计，费用仍以站点为准。

统计筛选器支持模型名称数组及令牌 ID 数组：各数组内取并集，模型与令牌之间取交集，空数组表示不限。起止日期可以带 `startTime` / `endTime`（HH:mm），结束分钟包含该分钟的 59 秒，今日上限截断到当前时间；短窗口可细化到 5 / 15 分钟。

分钟范围或多选条件从固定时间段的完整 `/api/log/self` 分页计算消费、用量、明细与效率；同时间不同筛选组合共用 1 分钟完整日志缓存。缺少用于精确筛选的令牌 ID、分页不一致或超过 10,000 条时返回错误，避免展示错误总量。默认整日范围保留站点聚合接口。账号余额和今日卡片继续显示账号数据。

`/api/data/self` 按不超过 28 天的连续时间段查询，再合并结果，兼容站点的单次跨度限制。按模型曲线使用该统计接口；按令牌曲线仅在选中时分页读取 `/api/log/self` 的消费记录，固定起止时间，按实际令牌 ID 区分同名令牌。若站点未提供 ID，则按名称区分。

按令牌及效率统计最多汇总 10,000 条记录；总量变化、重复 ID、分页不完整或超过上限时要求重试或缩小范围，不展示不完整总量。曲线仅返回时间、模型、令牌标识、消费、调用数及输入加输出 Tokens，不返回请求内容和其他原始元数据。

`usageQuality` 复用同一消费分页计算模型缓存命中率（有效记录的缓存读取 Tokens 合计 ÷ 对应输入 Tokens 合计）及平均 Token 速率（输出 Tokens 合计 ÷ 总耗时合计，含首字等待）。仅采用范围内成功消费记录，忽略缺失、非有限值、缓存读取大于输入、无有效耗时等数据，返回有效样本数，暂无数据返回 null。统计在主界面显示后后台读取，不阻塞余额和图表。

只读请求在主进程使用内存缓存，同键并发请求共享网络任务：

| 数据 | 有效期 |
| --- | --- |
| 公开站点信息、模型定价 | 5 分钟 |
| 模型缓存命中率、平均 Token 速率 | 5 分钟 |
| 用量、统计、健康度、按令牌曲线 | 1 分钟 |
| 账户余额、令牌列表 | 30 秒 |
| 请求明细分页 | 15 秒 |

缓存按站点 ID、地址、账户凭据摘要与查询参数隔离，最近时间的查询按分钟归并缓存键，实际请求范围不变。缓存最多 256 项，不写盘，失败不缓存，返回副本防止页面修改缓存。退出登录及站点写操作会失效相关缓存；手动刷新跳过当前站点缓存。在途旧读取不能恢复已经失效的缓存，缓存命中仍校验站点和登录状态。

CSV 最多导出 10,000 条，并对公式前缀作处理。导出可能包含请求信息，应保存在仓库外或 exports/ 等已忽略目录。

## 工具调用

Codex 使用站点 /v1 下的 Responses，Claude Code 使用 Anthropic Messages。Lumi 写入站点实际模型名称和专用认证，不为模型协议设人工限制；是否能成功调用取决于服务器实际路由及上游能力。

`toolRuntimes`、`installTool`、`onToolRuntime` 为本机受限 IPC；安装参数只能为 codex / claude。检测优先实际 PATH 入口并读取 `--version`，状态短期缓存，不请求站点。未安装时下载固定官方安装器，已有 npm 版本更新保留安装前缀，安装后自动检测实际版本；不会自动执行模型请求。

`toolRuntimes` 另返回 `tool: chatgpt` 的桌面应用状态。Windows 读取当前用户 MSIX 注册、卸载注册及常见位置的文件版本，macOS 读取应用 Info.plist；不会启动 ChatGPT 来检测版本，也不将 Codex CLI 版本当作桌面版本。未安装或检测失败分别显示。最新 CLI 版本来自对应官方 npm 包的 `latest` 标签；Windows ChatGPT 桌面最新版来自 Microsoft Store 的正式版产品目录。网络查询失败时最新版显示为暂不可查，不影响本机版本检测。

接口和服务参考：[New API 文档](https://docs.newapi.ai/zh/docs/api)。

## GitHub 更新

正式 Windows x64 安装包启动后及每 4 小时通过 electron-updater 的公开 GitHub Provider 查询 Lumi 仓库正式 Release，读取 `latest.yml` 与对应 NSIS 安装包。更新请求独立于站点，不携带账户凭据。主进程校验版本、标签、固定附件名、大小和 SHA-512；下载及重启前均复核文件。使用标准差量下载、缓存及取消流程，GitHub Actions 同时发布 `.blockmap` 与 `latest.yml`。

受限 IPC 提供 `updateStatus`、`checkUpdate`、`downloadUpdate`、`cancelUpdate`、`showUpdateFile`、`restartUpdate` 及状态订阅；`restartUpdate` 不接收路径或命令。只对已下载并通过校验的文件调用 `quitAndInstall(true, true)`，静默升级后自动重开。普通退出不触发升级，卸载 / 更新配置保留用户数据。浏览器预览与开发运行不自动检查更新。

`dismissedUpdateVersion` 保存用户隐藏的正式版本号，跨站点和重启生效，只隐藏同一版本的左栏提示。设置中的软件更新仍订阅完整状态并提供操作和恢复入口；隐藏不取消下载，也不关闭自动检查，更新版本号变化后重新提醒。
