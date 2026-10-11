# Lumi 内置录制网关核心

此 Rust 核心随主程序构建并放入安装包 `resources/native`。首次设置、路由与密钥管理、监听及 CLI 接管均从独立网关插件界面发起，Lumi 通过固定私有子进程管道调用；用户无需安装运行环境、启动另一程序或准备配对文件。

源码由 Lumi 项目独立编写，MIT 许可。初始实现来自同一工作区独立插件仓库 `sources/gateway-runtime`，主仓库保留可独立构建的源码和锁文件，不依赖相邻 checkout 或开发缓存。更新核心时同时核对两个仓库中的源文件及相应回归。

开发需要 Node.js 24+、npm 11+、Rust 1.85+ 与平台 C 编译工具。`npm test` 的准备阶段与 `npm run build` 自动构建固定核心；Cargo 只使用已锁定的依赖。构建收集所有相关依赖的完整 LICENSE/NOTICE，并保留内嵌 SQLite 的公有领域声明。生成的程序、缓存和测试记录不提交。

`initialize-private` 与 `configure-private` 仅接收受限私有 stdin JSON；管理身份和路由凭据使用 Windows DPAPI / macOS Keychain 保护。录制正文另用随机 AES-GCM 密钥加密。Linux 尚无系统凭据后端，CI 覆盖输入校验及不可用行为，不提供 Linux 安装包。
