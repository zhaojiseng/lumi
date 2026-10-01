# 公开发布流程

此仓库的 public 分支为清理后的公开快照。原 main 分支保留本地开发历史，可能带有旧站点地址；公开推送应选择 public 分支。不要镜像推送整个本地仓库，也不要上传 .git、用户数据或私有备份。

## 创建公开仓库

在你自己的 GitHub 账号下创建空仓库，选择合适的名称，不额外生成 README / LICENSE。先查看 public 分支和源码包，再由仓库所有者执行远程发布：

```bash
git switch public
npm run check:history
git remote add origin <你创建的空仓库地址>
git push -u origin public:main
```

远程 main 由 public 分支生成。后续可以直接在此公开分支开发；若从本地开发分支搬运更改，应选择具体提交并先审核内容。重新克隆后启用本地钩子：git config --local core.hooksPath .githooks。

维护者应启用 Actions、Private vulnerability reporting、可用的 secret scanning / push protection，并为远程 main 设置 PR 与 CI 检查要求。当前模板没有维护者私人邮箱，也没有虚构的仓库链接。

## 验证源码与许可证

```bash
npm ci
npm run setup:electron
npm run check:secrets
npm run check:history
npm run typecheck
npm test
npm run build
npm audit
```

CI 只需要 contents: read，不使用真实站点、账号或发布密钥。当前锁定依赖已验证 `npm ci --ignore-scripts` 可完成测试和构建；桌面运行和打包前需额外执行 `npm run setup:electron`。

## Windows 包

在 Windows x64 环境：

```bash
npm run dist
npm run verify:release
```

检查 app.asar 与当前构建一致、版本号一致，以及应用和依赖许可随包附带。SHA256SUMS.txt 只覆盖当前版本的发行文件；确认便携 EXE 已完成写入后再校验。

GitHub 的 Package Windows 工作流支持手动运行并上传构建 artifacts，不自动创建 GitHub Release。GitHub 首次执行、跨平台打包、原生启动、真实站点登录和调用需分别记录结果。当前 Windows 包未签名。

## 源码包与版本

使用完整且经过历史检查的 public 提交创建标签和源码 ZIP：

```bash
git archive --format=zip --prefix=Lumi-<version>/ -o release/Lumi-<version>-source.zip HEAD
```

更新 package.json / package-lock.json、渲染器版本、CHANGELOG 和验证记录。版本文件准备完成后再生成标签；标签推送和 GitHub Release 发布由仓库所有者决定。

公开 artifacts 只应包含源码快照、已核验应用包、许可证和校验文件；不要包含忽略目录、截图、真实日志或整个开发工作区。
