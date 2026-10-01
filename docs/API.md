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

CSV 最多导出 10,000 条，并对公式前缀作处理。导出可能包含请求信息，应保存在仓库外或 exports/ 等已忽略目录。

## 工具调用

Codex 使用站点 /v1 下的 Responses，Claude Code 使用 Anthropic Messages。Lumi 写入站点实际模型名称和专用认证，不为模型协议设人工限制；是否能成功调用取决于服务器实际路由及上游能力。

接口和服务参考：[New API 文档](https://docs.newapi.ai/zh/docs/api)。
