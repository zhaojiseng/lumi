# CodexBar 来源、许可与分发审计

审计日期：2026-10-02（Asia/Shanghai）。范围仅为 Lumi 对 CodexBar 的参考、可能复用的源码/资产，以及相应归属如何进入发行包；不代表其他依赖、服务条款或所有法律问题已经审查。工作区版本为 0.4.25。本次使用匿名、只读 GitHub API / raw 文件请求和离线本地核验，未运行应用更新、登录账户、发布流程或修改已有发行包。

现有 CodexBar MIT 正文完整且与固定上游提交一致；本地两个 0.4.25 Windows 应用归档确实随附该正文。原生菜单与上游有明确的短代码模式和交互相似性，应持续保留归属。当前证据没有显示 Lumi 分发 CodexBar 应用、CodexBarCore、订阅读取模块或应用图标；这不是关于独立创作、实质相似性或品牌权利的法律保证。整合后的 Windows 目录包已验证包含修订后的归属说明和完整许可，详见第 7 节；macOS 最终包仍需平台上的实际核验。

## 1. 可复核的上游来源

| 证据 | 结果与来源 |
| --- | --- |
| 仓库与公开许可声明 | [steipete/CodexBar](https://github.com/steipete/CodexBar)；`GET https://api.github.com/repos/steipete/CodexBar` 返回默认分支 `main` 和 SPDX `MIT` |
| 本地完整研究克隆 | `.research/CodexBar/.git` 的 origin 为 `https://github.com/steipete/CodexBar.git`，HEAD 为 [f46a125af227254ac14de591968bce88d9fcc0f5](https://github.com/steipete/CodexBar/commit/f46a125af227254ac14de591968bce88d9fcc0f5)，提交时间 2026-10-01T13:38:58Z；审计时该克隆无工作区改动 |
| 参考摘录目录 | `.research/codexbar-ref` 有 11 个文件，没有自己的 `.git`；其中执行 `git rev-parse HEAD` 会向上找到 Lumi 仓库，不能用其结果证明 CodexBar 来源 |
| 审计时的公开 main | `GET https://api.github.com/repos/steipete/CodexBar/commits/main` 在 2026-10-01T17:45:02Z（北京时间 2026-10-02 01:45:02）返回 [59152732182b4600bb78221da9b6b437d2154608](https://github.com/steipete/CodexBar/commit/59152732182b4600bb78221da9b6b437d2154608)，提交时间 2026-10-01T17:07:47Z。这是核查时点的值，后续 main 可能改变 |
| 完整许可正文 | [固定 main 提交的 LICENSE](https://github.com/steipete/CodexBar/blob/59152732182b4600bb78221da9b6b437d2154608/LICENSE)，通过 `https://raw.githubusercontent.com/steipete/CodexBar/59152732182b4600bb78221da9b6b437d2154608/LICENSE` 读取；`Copyright (c) 2026 Peter Steinberger` |
| 许可摘要 | GitHub `/license` 返回 LICENSE 的 Git blob ID `0ae0cb57d8c6c1417f796b39fc0d6a7f2f7c5c39`。完整文本将 CRLF 转成 LF 后，SHA-256 为 `14293556b79940745123d0160c71d27ed0e9fe9b8a848093f3ed78f4853caafe` |

11 个摘录文件逐个与干净克隆中的对应文件比较，只有 CRLF → LF 标准化，没有删注释、改空白或截取内容，均完全相等。下表的上游路径相对于 [f46a125af227254ac14de591968bce88d9fcc0f5](https://github.com/steipete/CodexBar/tree/f46a125af227254ac14de591968bce88d9fcc0f5)；这固定了可重现的内容来源，但不能反推最初下载时点或原始请求 URL。

| `.research/codexbar-ref` 文件 | 上游路径 | LF 文本 SHA-256 |
| --- | --- | --- |
| `LICENSE` | `LICENSE` | `14293556b79940745123d0160c71d27ed0e9fe9b8a848093f3ed78f4853caafe` |
| `README.md` | `README.md` | `1ba94c88b696c4b3cf54f91d93b399c3db634145feedd1742106ad1b540fc063` |
| `claude.md` | `docs/claude.md` | `aa132df089f5d1adc22f3db0cd7f9f4d4e5edee11fdd431fdb8dce7ee71722d0` |
| `codex.md` | `docs/codex.md` | `026ec6248441aa6042362e09af13f82ff93c876cf7d77116ee534d593e4445c6` |
| `llm-proxy.md` | `docs/llm-proxy.md` | `29a65c4713cb51511a411db7d58c9679bd94647d707cfd7f36a43a9bea70988c` |
| `openai.md` | `docs/openai.md` | `9bf473f237d4c0f59d98dbbbbc0e40ebb008f6caf24c9993085381afb9684808` |
| `openrouter.md` | `docs/openrouter.md` | `b7eaf99bfeb508633f155ff1806838f14bbb2d732236e572596fbf1a05dfff5c` |
| `StatusItemController+Menu.swift` | `Sources/CodexBar/StatusItemController+Menu.swift` | `fa0e0cf6e2a3bf9a438804ec2948de3abab545f9b8faf7de0b9a3f61df2d76a4` |
| `StatusItemController+MenuAppearance.swift` | `Sources/CodexBar/StatusItemController+MenuAppearance.swift` | `92e46a1a42e5af7da573d8c282716c4d82ce8986efc455315b372a0e0264282c` |
| `StatusItemController+MenuCardItems.swift` | `Sources/CodexBar/StatusItemController+MenuCardItems.swift` | `a2c25e7665f4fddc3b819d5ad63df4000d879833b15abb70fc8d5b344d56f22f` |
| `UsageMenuCardLayout.swift` | `Sources/CodexBar/UsageMenuCardLayout.swift` | `159df1ef224b07cfa5f146ab2d63045fdaa04baff3735c75a4646a34bd903773` |

[GitHub compare](https://github.com/steipete/CodexBar/compare/f46a125af227254ac14de591968bce88d9fcc0f5...59152732182b4600bb78221da9b6b437d2154608) 在两提交之间返回 6 个提交；这些摘录文件均不在变更清单内。另直接读取当前固定提交的 LICENSE、MenuCardItems、UsageMenuCardLayout、Package.swift 和 docs/THIRD_PARTY_LICENSES.md，与本地克隆相等。

## 2. MIT 的具体义务与边界

上游许可的条件为：

> The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

因此，当分发上游软件的副本或实质部分时，需随附 Peter Steinberger 的版权和许可声明。项目保留整份 MIT 文本，包括授权条件与免责声明，而不只列项目名或“MIT”。许可证授予复制、修改、分发、再许可及商业使用等权限；该正文没有要求使用相同许可证发布全部 Lumi 源码，也没有要求通过应用更新界面展示归属。源码注释本身不能代替二进制发行包中的随附文本。

MIT 正文不直接解决商标、品牌认可、设计表达或每个第三方资源的权利问题。若以后复制 CodexBar 中的其他 vendored 文件、资源或完整组件，应按那个文件的实际来源重新检查，不能仅凭根目录 LICENSE 推定全部组件只有 Peter Steinberger 的 MIT：

- [docs/THIRD_PARTY_LICENSES.md](https://github.com/steipete/CodexBar/blob/59152732182b4600bb78221da9b6b437d2154608/docs/THIRD_PARTY_LICENSES.md) 单独记录 Sucrase 3.35.1 的 MIT 版权（various contributors）及资源摘要。
- [Sources/CQuickJS/LICENSE](https://github.com/steipete/CodexBar/blob/59152732182b4600bb78221da9b6b437d2154608/Sources/CQuickJS/LICENSE) 另有 Fabrice Bellard、Charlie Gordon、Ben Noordhuis、Saúl Ibarra Corretgé 等版权归属。
- [Package.swift](https://github.com/steipete/CodexBar/blob/59152732182b4600bb78221da9b6b437d2154608/Package.swift) / [Package.resolved](https://github.com/steipete/CodexBar/blob/59152732182b4600bb78221da9b6b437d2154608/Package.resolved) 还列出 Sparkle、Commander、swift-crypto、swift-log、KeyboardShortcuts、Vortex、SweetCookieKit 等；未把这些上游依赖的许可自动套用到 Lumi。

## 3. 实际源码与资产比对

检查的是当前有未提交改动的 `native/macos/UsageMenuBar.swift`，不是仅检查 Git HEAD。核验快照的原始字节 SHA-256 为 `afd66438f44d216063ba5402008232e2d62f70f5bc0aadf53c0b501860021111`；并行工作可能继续改变该文件，后续版本需重新评估。

| 项目 | 具体观察与判断边界 |
| --- | --- |
| 原生菜单容器 | Lumi 使用 `NSMenu`、`NSMenuItem.view = card` 和 AppKit `NSView`。CodexBar 的 `StatusItemController+MenuCardItems.swift` 也把自定义视图放入 NSMenuItem，但以 SwiftUI / hosting payload、缓存高度、回收容器等组织。存在可确认的结构相似性 |
| 禁用原生高亮 | Lumi 的 `CardMenuItem: NSMenuItem { override var isHighlighted: Bool { false } }` 与上游该文件第 6–10 行 `MenuCardMenuItem` 的行为相同，仅类名和格式不同。这是短代码模式，不能因整体没有大段逐字匹配便忽略；保留 CodexBar 归属 |
| 外观与持久卡片 | Lumi 在 `menuWillOpen` 采用 `NSApp.effectiveAppearance`，并保留同一个 `UsageCard`。上游 `StatusItemController+MenuAppearance.swift` / MenuCardItems 也处理外观与视图重用；Lumi 没有该观察器、递归 submenu 处理或同名 hosting 类型 |
| 卡片布局 | 上游 `UsageMenuCardLayout.swift` 使用横向 padding 20、多个 6/10 间距及 SwiftUI 布局；Lumi 采用 380×450 卡片、横向 18、绝对 NSTextField / NSSegmentedControl frame。没有发现复制该布局常量集 |
| 消费图表 | Lumi 的 `SpendChart` 使用 `NSBezierPath`、NSTrackingArea、均分柱宽及本地 Timer 动画；上游 `CostHistoryChartMenuView.swift` 使用 SwiftUI / Charts，`ChartBarHoverSelection.swift` 使用日期区间和柱框命中。消费/Token/请求与悬停详情的产品概念相似，所查绘制实现不同 |
| 数据与依赖 | Lumi helper 从 stdin 解码 `UsageState`，由 Electron New API 服务提供格式化结果；helper 中没有 CodexBarCore 导入、provider fetcher 或网络请求。`scripts/build-native-menu-bar.mjs` 编译单个 Lumi Swift 文件并链接 AppKit / QuartzCore，不运行上游 Swift Package |

辅助文本筛查覆盖干净参考克隆的 2,839 个 `.swift` 文件（含源码和测试）。将每行首尾空白去除后，没有发现“连续至少 3 行且总计至少 90 个非换行字符”的完全相同行块；最长相同行块为 4 行，只含短语法片段。另以保留字符串内容、标识符和标点、跳过注释及空白的词元筛查，最长连续完全相同序列为 18 个词元。这两种筛查能指出逐字相同的片段，不能检测所有改名、改写、非连续复用或法律意义的实质相似性；上述高亮模式经人工比对单独列出。研究摘录本身确实是上游文件副本，`.gitignore` 排除了 `.research/`，审计时 `git ls-files .research` 为空。

资产核验区分了应用标识与第三方品牌 SVG：

- 将 `public/icon.svg`、`public/icon.png`、`public/icon.ico` 与研究克隆内 281 个图片/矢量/字体类资产按原始字节 SHA-256 比较，没有完全相同文件。人工查看 Lumi 512×512 PNG 与 CodexBar `Icon.icon/Assets/codexbar.png`：前者是绿色 L + 圆点，后者是终端箭头与配额条。原生 `lumiIcon()` 也是 L + 圆点路径，没有加载 CodexBar 图标。
- `scripts/icons.mjs` 绘制相同的 L + 圆点设计；拦截其 writeFile、在内存重现输出，生成的 ICO 与 `public/icon.ico` 完全相同。当前脚本输出 256×256 PNG，现存 `public/icon.png` 是 512×512，不能声称该脚本原样生成了现存 PNG。设计和字节比较没有显示 CodexBar 来源，但 PNG 的完整生成步骤仍待资源维护者补足。
- `src/components/BrandIcon.tsx` 的 21 个 SVG 明确从 `@lobehub/icons-static-svg/icons/*.svg?raw` 导入，锁文件固定版本 1.95.1（MIT），不是从研究目录加载。其中 `grok.svg` / `minimax-color.svg` 分别与 CodexBar `ProviderIcon-grok.svg` / `ProviderIcon-minimax.svg` 共享完整 path 字符串，文件字节不同。这是具体的资源相似性；直接依赖和导入链支持 Lumi 的 Lobe Icons 来源，不足以证明品牌权利已获所有授权。Lobe 的随附许可已在原有 notices 中记录，本次未扩展为 Lobe 全面审计。

## 4. 许可如何随应用分发

CodexBar 是参考源码项目，并非 npm 依赖。审计时锁文件有 64 个非开发依赖包，未出现 CodexBar、SweetCookieKit、QuickJS、Sucrase 或 Sparkle 的包条目；依赖许可聚合文件不会自动替代 CodexBar 的单独声明。

| 阶段 | 检查到的路径与行为 |
| --- | --- |
| 源码 | `public/third-party/codexbar-LICENSE.txt` 与 `THIRD_PARTY_NOTICES.md` 均已被 Git 跟踪；现存 LICENSE 1,074 字节（LF），与上游上述摘要一致。审计没有改动它 |
| Renderer 构建 | `npm run build` 先执行 Vite build；默认 publicDir 复制 `public/third-party/codexbar-LICENSE.txt` 到 `dist/third-party/codexbar-LICENSE.txt`。当前 `vite.config.ts` 没有禁用 public 复制 |
| 归属生成 | `scripts/generate-notices.mjs` 收集非开发 npm 依赖 LICENSE/NOTICE 并对缺文档报错，复制 Lumi LICENSE 与根归属说明到 `dist/third-party/`。它没有自己生成 CodexBar 文本，必须同时保留 Vite 的 public 复制步骤 |
| 应用打包 | `scripts/package.mjs` 将 dist / dist-electron / public 复制到暂存区，`package.json` 的 `build.files` 包括 `dist/**/*`，`asar: true`。应用归档中的许可位置为 `dist/third-party/codexbar-LICENSE.txt`，说明为同目录 `THIRD_PARTY_NOTICES.md` |
| macOS helper | helper 在 `Contents/Resources/native/lumi-menu-bar`，共同应用许可在 `Contents/Resources/app.asar/dist/third-party/`；当前不声明 helper 是可独立分发的 CodexBar 派生包。如将它单独打包，需同时携带适用的归属/正文 |
| 发布前核验 | `scripts/verify-release.mjs` 读取 app.asar，校验 dist / dist-electron 全部文件与本地构建逐字相同，并明确检查 CodexBar 许可存在。仅看其 `length > 100` 判据不够，但全量字节比较及本次上游许可摘要检查补充了真实性证据 |
| CI / 发行流程 | `.github/workflows/ci.yml` 会运行 `npm test`；`package.yml` 的 Windows 与 macOS 打包任务均调用 `npm run verify:release` 后上传 artifacts。源码 ZIP 经 `git archive HEAD` 导出，只有后续纳入提交的文件会进入该 ZIP。本次按用户指令不提交，也未触发任何发布任务 |

**直接读取已有包的证据（本次修改前的构建）：**

| 本地 app.asar | 内部版本 | CodexBar 许可 | 归属说明 |
| --- | --- | --- | --- |
| `.cache/release-v0.4.25/win-unpacked/resources/app.asar` | 0.4.25 | 1,074 字节，与 public 文件和上游正文相等 | 3,334 字节，与修改前根说明相等 |
| `.cache/tray-update-validation/win-unpacked/resources/app.asar` | 0.4.25 | 1,074 字节，与 public 文件和上游正文相等 | 3,334 字节，与修改前根说明相等 |
| `release/win-unpacked/resources/app.asar` | 0.4.18 | 无 CodexBar 文件；是 CodexBar 菜单功能之前的旧包 | 不能作为 0.4.25 当前包证据，也不据此推断旧包违规 |

两个 0.4.25 归档的 listing 均不含 `.research`、tests 或 node_modules 树。第一个 app.asar 的 SHA-256 为 `36f80578a2ee988310099d77c093f53daf97736cef394537aef2ba8b3188a856`，第二个为 `ef9ebee98ba052b329c8b142038056cb5e7d1de6f0f6a9040e83c993f7888086`。直接归档读取证明这些本地应用包携带了声明，未检查或重新生成最终 NSIS 安装器/DMG，也不证明远端已发布包的状态。

Windows 提取 app.asar 文件时，`@electron/asar.extractFile` 使用平台分隔符；将 `dist/third-party/codexbar-LICENSE.txt` 用 `path.sep` 转换后读取，避免把正斜杠解析差异误判为许可缺失。

## 5. 本次修正与定向验证

| 文件 | 精确修正 |
| --- | --- |
| `THIRD_PARTY_NOTICES.md` | 只扩充 CodexBar 段落：加入版权人、参考提交和当前上游核查日期；将“独立实现 / 不分发”的绝对表述改为审计观察，承认卡片/高亮模式相似；说明 MIT 保留声明的条件、源码与真实包内路径、无认可/赞助关系；链接此审计及固定上游许可 |
| `docs/OPEN_SOURCE_AUDIT.md` | 新增本审计，保留来源、摘要、相似性、实际包核验、未验证事项及责任边界 |
| `tests/open-source.test.ts` | 新增 2 个离线检查：用固定 SHA-256 防止许可正文被截短/改写；在唯一临时目录实际执行 Vite public 复制和 notice generator，将结果制作成临时 app.asar，逐字核验许可和说明，同时检查生产打包的 dist 包含规则 |
| `public/third-party/codexbar-LICENSE.txt` | 无修改；已经包含正确完整正文，无需新增或替换 |

执行 `node --import tsx --test tests/open-source.test.ts`：2 项通过，0 失败，约 0.54 秒。分发检查只用隔离的 fixture，不构建主应用，不访问网络，不启动 Electron，不创建提交/标签，不覆盖 dist / release / `.cache`；fixture 在完成后清理。测试没有把 `.research` 当作 CI 必需数据。此结果证明修订后的说明能随现有复制/归档链分发，不能取代最终 installer 的实际核验。

## 6. 并行审计时的待处理事项

以下保留审计完成时的证据边界与建议；第 1、3 项后续整合结果见第 7 节，其余平台和资源来源边界仍保留。

1. **最终构建尚未验证本次说明修订。** 两个已有 0.4.25 包携带旧说明，不能称为本次工作区全部改动的最终产物。后续打包后使用适当 `LUMI_RELEASE_DIR` 执行 release verifier，并读取实际 app.asar 中的许可证和新说明；禁止误用默认 `release/` 的 0.4.18 包。本次未改构建脚本或重打已有包。
2. **macOS 包证据不足。** 本机为 Windows，未核对实际 ARM64 DMG 内的 `Contents/Resources/app.asar` 或独立 helper 的分发。当前打包配置与 verifier 设计会覆盖共同 app 归属，但不能把配置推断当作已通过的平台验证。
3. **源码头部归属可进一步明确。** Native 文件目前只有 “Original implementation inspired by CodexBar” 注释，缺少固定上游提交和许可证文件指引。建议 native 维护者在相似的 CardMenuItem 模式旁补链接/归属，或改为有证据边界的说明；同应用包已携带完整许可，不能把该建议误称为 MIT 明文要求每个源文件必须单独写完整头部。本次遵守所有权约束，未编辑 native 源码。
4. **应用图标生成步骤存在可重现性缺口。** `scripts/icons.mjs` 无法原样生成现存 512×512 PNG，建议资源/构建维护者补足对应尺寸的生成步骤与来源记录；目前未见 CodexBar 资产复用证据。本次未编辑该脚本或图标。
5. **新增复用必须重新检查。** 后续移植 provider、Cookie/Keychain 读取、Swift 包、QuickJS/Sucrase 资源或 CodexBar 图标时，应按实际文件/依赖补全归属。产品截图级视觉相似性、非连续改写与商标边界未获完整验证；保留许可和清楚的来源可以处理已识别的分发义务，但不能保证不存在其他争议。

本次写入范围仅为上述两个 Markdown 文件及新增测试；保留全部预先存在的未提交改动，未编辑共享类型、主进程、App、Settings、native 或构建脚本，未提交、推送、打标签或发布。

## 7. 整合后的最终验证

2026-10-02，在全部功能改动整合完成后重新执行 `npm run build`，并通过 `LUMI_RELEASE_DIR=.cache/tray-update-validation` 生成 Windows x64 目录包。直接读取其中的 `win-unpacked/resources/app.asar`，得到以下结果：

| 检查 | 结果 |
| --- | --- |
| 当前 app.asar SHA-256 | `df716a30d1f2803d03f64e5596733967d4fe79bd92e6a5a6aedbaa6027f2af3f` |
| CodexBar LICENSE | 1,074 字节；与源码文件逐字相等，SHA-256 与第 1 节固定上游许可一致 |
| 修订后的 THIRD_PARTY_NOTICES.md | 4,482 字节；与当前根目录说明逐字相等 |
| 当前构建资源 | 38 个归档内 JS、CSS、HTML、TXT、Markdown 和 SVG 资源逐字匹配 dist / dist-electron |
| 打包应用启动 | 隔离启动通过，Windows 托盘布局、等高切换、上下文隔离、动作参数校验通过 |
| 原生源码归属 | `native/macos/UsageMenuBar.swift` 已注明 Peter Steinberger 的版权、固定参考提交以及完整许可路径 |

此处证据对应新的目录包，取代第 4 节该路径的旧构建快照；不将它称为已核验的 NSIS 安装器或 ARM64 DMG。macOS 的 Swift 编译、实际菜单和 DMG 分发未在本机验证。图标 PNG 生成步骤的可重现性缺口仍按第 6 节记录，未据此推断 CodexBar 资产来源。全部改动保持本地未提交，未推送、打标签、触发 CI 或发布。
