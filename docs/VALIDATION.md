# Lumi 0.4.17 验证记录

日期：2026-10-01（Asia/Shanghai）。本轮目标为准备公开源码与 Windows 便携包。

## 环境与结果

本机 Windows x64，Node.js 24.18.0、npm 11.16.0、Electron 44.5.0。另建独立源码目录，仅从 Git 暂存区导出公开文件，未复制现有依赖、构建缓存或用户数据。

| 检查 | 结果 |
| --- | --- |
| 独立源码 `npm ci --ignore-scripts` | 安装成功，无需原工作区缓存 |
| 独立源码 `npm test` | 112 / 112 通过；首次测试自动创建隔离数据目录 |
| 独立源码 `npm run build` | TypeScript、Vite、Electron main / preload 构建通过 |
| 独立源码 `npm audit` | 0 个已知漏洞 |
| 公开文件及提交历史检查 | 暂存区与 public 可达历史不含扫描规则匹配的凭据、个人路径、非示例数字站点地址或本机生成数据 |
| GitHub 文件静态检查 | 6 个 YAML 文件可解析，Actions 固定提交 SHA，工作流仅有 contents: read 权限；Markdown 相对链接有效 |
| Windows `npm run dist` | 0.4.17 x64 便携包生成成功 |
| `npm run verify:release` | 29 个包内构建文件逐字节一致，应用及依赖完整许可齐全，无本机数据 / 测试 / 依赖源码目录 |

仓库扫描回归覆盖暂存内容与工作区不一致、历史中已删除的凭据、不打印匹配值、危险文件名、非示例站点地址、未经审核的二进制及符号链接。扫描只是辅助检查，不保证检测全部泄露方式。

## 默认行为与界面

首次启动使用 New API 示例站点 `https://api.example.com`。隔离测试验证占位地址不会发起网络请求、登录提示先填写真实地址、无伪账户或账单；已保存站点的标识、名称和地址保持不变。

生产浏览器预览在新本机端口检查：首页与设置均显示示例站点和 v0.4.17，等待登录状态清晰，浏览器 error 日志为空。仅浏览页面，未登录真实账户。检查截图保留在 Git 忽略目录，源码 ZIP 不包含截图。

## 公开源码与发行文件

公开源码采用独立 public 根提交，不包含原 main 的开发历史；原 main 留在本地。公开包从 public 的 HEAD 使用 git archive 导出，不含 .git、依赖目录、测试生成数据、缓存或发行目录。推送钩子检查将推送提交的全部可达历史。

Windows 包包含 Lumi MIT 许可、48 个非开发依赖的完整 LICENSE / NOTICE，以及 Lobe Icons、CC Switch、Victory vendor 和 Electron / Chromium 的随附许可。

`Lumi-0.4.17-x64.exe` 的 SHA-256：

```text
57fd4b978da26d54efd1df9dddb1deb7fb2d3722c69250bdeccbabd663d85581
```

源码 ZIP 与便携包的校验值另见 release/SHA256SUMS.txt。发行文件不加入 Git。

## 尚未执行

尚未上传 GitHub，因此 Actions 未远程运行。Linux / macOS 构建、原生 Electron GUI、代码签名、真实站点登录与收费模型调用未执行。本轮测试仅使用隔离配置、虚拟凭据和本机模拟服务，未读取或修改真实工具配置、账号、密钥或会话。
