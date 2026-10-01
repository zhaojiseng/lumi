# Lumi 架构

当前说明对应 0.4.17。Electron 主进程负责网络、凭据和本机文件；React 渲染器通过受限 IPC 调用业务服务。

## 分层

| 位置 | 职责 |
| --- | --- |
| shared/types.ts | 业务 DTO、IPC 契约及不含真实站点的默认配置 |
| shared/catalog.ts / pricing.ts | 可达渠道、最低价与站点表达式的公布单价；使用受限 AST，不执行脚本 |
| shared/range.ts / utils.ts | 日期范围、动态分组、币种换算与 CSV |
| shared/logs.ts / health.ts | 缓存、速度、时间和状态元数据归一化；固定 24 格健康采样 |
| shared/selections.ts | 按站点保存并合并页面选择 |
| electron/services/store.ts | 原子串行写入、safeStorage 密钥库、设置迁移和账户隔离 |
| electron/services/new-api.ts | 登录 / 验证 / 续期、数据接口、专用令牌复用与创建 |
| electron/services/browser-login.ts / login-capture.ts | 隔离站点窗口与认证捕获；重新验证账户后保存 |
| electron/services/config.ts | 脱敏预览、加密备份、应用 / 恢复、冲突检查与回滚 |
| electron/services/codex-direct.ts / codex-sessions.ts | Codex 历史及索引同步、运行状态检查 |
| electron/services/local-usage.ts | 本机 JSONL 用量元数据提取 |
| electron/main.ts / preload.ts | 窗口、托盘、通知及参数校验后的有限 IPC |
| src/components / pages | 账户、请求、模型、工具、令牌与设置界面 |

品牌图标统一在 BrandIcon.tsx，使用本地官方 SVG。主题通过最后加载的 theme.css 覆盖基础样式，使用不透明表面与语义颜色。

## 配置事务

用户选择模型与渠道后，主进程验证站点和本机配置，复用 / 创建专用令牌，构造脱敏预览。应用前再次校验账户、站点、原始文件内容和预览时效，再加密备份并写入；失败尝试回滚。

Codex 修改真实模型 ID、provider、地址、认证与上下文设置，尊重活动 profile 和 CODEX_HOME。不会定义或复制提示词，也不生成模型目录。旧版 Lumi 模型目录引用可迁移，原目录内容保持不变。

同步涉及本程序管理的相关会话最新设置与可用索引字段，保留历史回合和用户指令。运行中的 Codex 持有旧设置，因此应用前要求退出，完成后重开。预览、备份与恢复同时覆盖相关文件和索引行。

Claude Code 合并 CLI settings.json 中的 API 配置，保留无关设置；Claude Desktop 不属于当前集成范围。所有模型的选择依据本站可达渠道，不按目录缺少协议标签禁用。

## 网络与数据

公开状态不携带凭据，账户请求使用作用域快照。切换站点、退出或改变身份会使旧请求和配置预览失效。并发续期 / 配钥分别共享任务，拒绝跳转和 TLS 校验绕过。

默认占位站点没有网络请求。初次配置后的数据来自用户选择的服务器；登录、余额、消费、模型与健康度不使用演示数据。缺失元数据保留“—”或灰色采样条。

远程登录窗口无 Node / preload / Lumi IPC，站点权限请求与任意新窗口被拒绝。凭据和原始配置备份由系统加密存储保护，密码不落盘。浏览器预览只提供公开状态，不处理账户凭据。

## 构建与许可

Vite 构建渲染器，esbuild 构建 Electron 主进程 / preload。generate-notices.mjs 按锁文件收集非开发依赖及其完整许可；额外参考项目许可保存在 public/third-party。

打包仅使用 dist、dist-electron、应用资源及清单，不包含源依赖树、测试、调研或用户数据。verify-release.mjs 检查 app.asar 和生产文件一致，并生成校验文件。
