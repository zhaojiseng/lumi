# 贡献指南

欢迎通过 Issues 和 Pull Requests 改进 Lumi。提交之前请阅读 [行为准则](CODE_OF_CONDUCT.md)；涉及凭据、登录窗口、配置写入或会话同步的问题，优先按 [SECURITY.md](SECURITY.md) 处理。

## 环境

使用 Node.js 24+、npm 11+ 和 Git。安装锁定依赖，再准备 Electron：

```bash
npm ci
npm run setup:electron
git config --local core.hooksPath .githooks
npm run dev
```

`npm run dev:web` 适合界面开发。不要在自动测试中使用真实账号、令牌、用户配置目录或收费模型调用。测试服务只能监听本机，并使用 `.test-data/` 下的隔离配置；目录由 `npm test` 自动创建。

## 修改范围

将一个 Pull Request 聚焦在一个明确问题。功能行为变化应有相关测试；简单排版变更可用浅色 / 深色和窗口尺寸检查。避免为模型名称硬编码计价规则、强制思考强度，或加入工具提示词定义。

配置流程继续使用预览、加密备份、冲突检查和回滚；保留用户无关的工具设置。不要为模型切换加入本地代理或路由服务。

## 提交前

```bash
npm run check:secrets
npm run typecheck
npm test
npm run build
```

发布相关修改还需 `npm run dist` 与 `npm run verify:release`。新增运行时依赖时，确认许可文件可由 `scripts/generate-notices.mjs` 收集；新增图标继续复用品牌组件。

检查 Git diff。密钥、Cookie、加密凭据库、会话日志、真实请求导出、账户截图及个人路径均不能进入提交。钩子只输出匹配位置，不输出秘密内容；失败时处理原因，不通过关闭钩子绕过。

提交信息简洁说明改动，例如 `fix: preserve selected model channel`。PR 描述写清问题、最终行为、验证及实际限制；使用仓库模板即可。源代码贡献沿用本项目 MIT 许可，第三方代码必须保留其许可和来源。
