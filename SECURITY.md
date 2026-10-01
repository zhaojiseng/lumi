# 安全问题

Lumi 处理登录凭据、API 令牌和本机工具配置。请只对你有权测试的环境验证问题，使用本机模拟服务和虚拟凭据。

## 私下报告

公开仓库启用 Private vulnerability reporting 后，使用本仓库 **Security → Advisories → Report a vulnerability** 私下提交。若入口尚未启用，可在 Issue 中仅请求一个私下报告渠道，不公开漏洞细节、利用步骤或敏感附件。不要将报告发送到 README 中提及的第三方项目。

建议提供影响版本、操作系统、最小复现、预期与实际行为，以及不含真实数据的样例。账号密码、完整 API 密钥、Cookie、JWT、加密凭据库、会话或账户账单均应删除；需要凭据格式时使用你生成的虚拟值。

## 支持范围

目前接受最新 0.4.x 版本的安全问题。旧版本请先升级并在隔离环境复现。项目没有承诺固定响应时限；发现已泄露密钥时，应先在所属站点撤销或轮换。

## 数据边界

- 渲染器使用 sandbox / contextIsolation，敏感操作经过有限 IPC 与参数校验。
- 站点登录窗口与本地渲染器隔离，不提供 Node、preload 或 Lumi IPC。
- 凭据与备份使用系统加密存储；密码不落盘，公开状态查询不携带凭据。
- HTTPS 校验保持启用；HTTP 登录仅在用户明确开启后允许。
- 导出、截图和提交历史仍需人工检查。仓库扫描规则并非对所有泄露方式的完整保证。

源代码依赖安全由 CI 的 npm audit 和更新工具辅助检查。维护者应在公开仓库设置中启用 Private vulnerability reporting、secret scanning 和 push protection（可用时），并限制发布权限。
