# 额外插件

这里存放独立分发的插件包。`plugins/` 是随 Lumi 编译的内置插件；`extensions/packages/` 下的包不会进入 `dist/`、`app.asar` 或安装 EXE。打包时单独导出到 `release/.../extensions/`，修改这些包无需重新编译 Lumi。

## 制作与运行

复制 `packages/extension.lumi.notes/`，将文件夹及 `plugin.json` 的 ID 改为 `extension.<作者>.<名称>`。每个包至少包含 `plugin.json`、完整 `LICENSE` 和贡献声明的 HTML 入口；普通 JavaScript/CSS/图片/字体可同包发布。React/Vue/TypeScript 也可使用，但作者需将其构建成自包含 web 资源，不能 import Lumi 源码或要求用户安装依赖。

开发桌面应用自动扫描本仓库 `extensions/packages/`。已安装应用：在设置 → 插件 → 额外插件目录，打开目录并复制完整包文件夹，点击“重新扫描”，然后启用。新包默认停用；重新扫描到字节变化时也停用，重新启用代表接受当前清单和权限。启停和扫描保持设置页实例，无需重启或重新编译 EXE。

```sh
npm run check:extensions
npm run check:extensions -- extensions/packages/extension.lumi.notes
```

包限 128 项、单文件 2 MiB、总计 16 MiB，最多 32 个包、总计 64 MiB。禁止符号链接、绝对路径、路径穿越、同 ID 包及不兼容 API 版本。用户目录优先；与仓库/随应用旁置目录重复的包会诊断并跳过。

## 清单与贡献

以示例 `plugin.json` 为起点，`schemaVersion` 和 `hostApiVersion` 均为 1。`switches` 申请功能滑块；`contributions` 可声明多个条目，每项包括 `id`、`slot`、`title`、`entry`，以及可选 `order`、`scope`、`switch`、`section`。

| slot | 放置位置 |
| --- | --- |
| `workbench` | 系统工作台内容卡片 |
| `usage` | 用量分析来源标签 |
| `models` / `tokens` | 模型广场 / 令牌页面中的来源内容 |
| `connection` | 常规设置“连接”选项 |
| `settingsTab` | 设置顶栏和内容 |
| `sidebar` | 自定义侧栏页面，section 可为 workspace/tools/settings |

`scope: site` 跟随当前站点重挂载；`independent`（默认）保留独立界面。`switch` 必须引用本包声明的子开关；父插件关闭时全部贡献撤回。宿主生成 `plugin:<包ID>:<贡献ID>`，包不能覆盖内置页面。外部 UI 是独立隔离 frame，不能直接使用宿主 React context。

## SDK v1

HTML 引入宿主提供的脚本，不能在包里覆盖它：

```html
<script src="lumi-sdk.js" defer></script>
<script src="app.js" defer></script>
```

```js
const sdk = window.lumiExtension;
const {context, view} = await sdk.ready;
const note = await sdk.storage.read('note');
await sdk.storage.write('note', '下一步工作');
const unsubscribe = sdk.onContext(context => {
  document.documentElement.dataset.theme = context.theme;
});
```

SDK 的 context 仅包含主题、语言和当前站点 ID/名称/URL，不提供账户令牌、文件路径或会话正文。工作台卡片收到刷新 epoch；自行刷新内容，避免创建无限后台轮询。

TypeScript 作者可将 `extensions/sdk/lumi-extension.d.ts` 复制到自己的工程，获得独立 SDK 类型提示；它不依赖 Lumi 源码或运行时包。

| 声明权限 | SDK 方法及返回内容 |
| --- | --- |
| `storage` | `storage.read(key)` / `write(key,value)`：包独立的非敏感 JSON 数据，总计 64 KiB |
| `workbench.read` | `workbench.read({force?})`：系统工作台格式化余额/用量快照，无密钥 |
| `usage.read` | `usage.read({force?})`：系统浮窗用量展示快照，无会话正文 |
| `codex.usage.read` | `codex.readUsage({force?})`：Codex 接入的订阅限额快照，依赖该接入启用 |
| `secrets` | `secrets.set(key,value)` / `has(key)`：独立系统加密凭据，传 null 删除，不提供取回明文接口 |
| `network.read` | `network.read({url,headers?,secret?})`：受控 HTTPS GET，返回 `{status,body}` |

自定义来源可在连接界面用 `secrets.set('api',value)` 保存自己的密钥，然后：

```js
const response = await sdk.network.read({
  url: 'https://api.your-service.com/usage',
  secret: {key:'api', header:'Authorization', prefix:'Bearer '},
});
const data = JSON.parse(response.body);
```

清单需声明 `permissions: ["secrets","network.read"]` 及 `networkOrigins: ["https://api.your-service.com"]`。宿主仅允许声明 origin 的公共 HTTPS 地址，DNS 结果固定后连接、保持 TLS 校验，拒绝本机/私有地址和重定向；15 秒超时、响应最多 1 MiB，每包最多 8 个在途请求。权限显示在启用开关下方。请使用最低限度权限。

外部插件没有 Node.js/main 入口、任意 IPC、文件系统、shell、CLI 配置写入或 NewAPI 令牌管理权限。网络只能通过 SDK；隔离 frame 使用专用协议、CSP 和 sandbox，不能访问宿主 DOM/preload。插件停用、扫描、账户变化和退出会拒绝过期结果，网络读取停用时中止。插件文件以本次扫描的固定字节提供。

## 提交到仓库

作者将完整可运行包和可选 README 提交到 `extensions/packages/<插件ID>/`，使用扩展插件 PR 模板。PR 描述需解释数据来源、用途、声明权限、构建方式与许可，附上界面图。禁止把依赖树、凭据、会话、用户数据和构建缓存提交到包中；依赖许可需随包附带。运行上述检查和相关回归后提交，维护者可独立合并/分发扩展，不必改动内置注册表。

目前采用目录包，未实现在线市场、ZIP 自动安装或任意外部主进程代码执行。
