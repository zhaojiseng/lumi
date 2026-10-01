# 第三方组件与参考项目

Lumi 自身源码使用 MIT 许可。依赖、品牌标识及外部服务沿用各自权利人的许可与权利，Lumi 的 LICENSE 不改变这些条款。

## 主要依赖

| 组件 | 用途 | 许可 |
| --- | --- | --- |
| [Electron](https://github.com/electron/electron) | 桌面运行时 | MIT；发行包另含 Chromium / Node 等完整 notices |
| [React](https://github.com/facebook/react) / React DOM | 界面 | MIT |
| [Lucide](https://github.com/lucide-icons/lucide) | 通用图标 | ISC |
| [Lobe Icons](https://github.com/lobehub/lobe-icons) | 模型 / 工具品牌 SVG | MIT |
| [Recharts](https://github.com/recharts/recharts) | 用量图表 | MIT |
| [smol-toml](https://github.com/cyco130/smol-toml) | Codex TOML 处理 | BSD-3-Clause |
| [Zod](https://github.com/colinhacks/zod) | IPC 参数校验 | MIT |
| [Victory vendor](https://github.com/FormidableLabs/victory) | 图表间接依赖 | MIT AND ISC，包括随附 D3 / InternMap 许可 |
| [electron-builder / electron-updater](https://github.com/electron-userland/electron-builder) | Windows 安装包、更新元数据和静默升级 | MIT，正文随附于 public/third-party/electron-builder-LICENSE.txt，运行依赖许可另见 dependencies-LICENSES.txt |
| [lazy-val](https://github.com/develar/lazy-val) | electron-updater 的延迟值依赖 | 上游声明 MIT，未附单独许可文件；按包声明重现标准文本并标明来源，见 public/third-party/lazy-val-LICENSE.txt |

锁定版本与完整依赖关系见 package-lock.json。构建脚本从非开发依赖收集完整 LICENSE / NOTICE 文本到 dist/third-party/dependencies-LICENSES.txt；缺少许可正文会导致构建失败。Lumi 自身许可和本说明同样随包分发。

Lobe Icons 发布的静态包未带 LICENSE 文件，其许可正文保存在 [public/third-party/lobe-icons-LICENSE.txt](public/third-party/lobe-icons-LICENSE.txt)。Victory vendor 的根许可来自版本 v37.3.6，保存在 [public/third-party/victory-vendor-LICENSE.txt](public/third-party/victory-vendor-LICENSE.txt)；其包内嵌的各库许可也会收集。品牌图标不表示品牌方认可或赞助 Lumi。

## 参考与外部服务

[CC Switch](https://github.com/farion1231/cc-switch) 的配置管理和直连流程是本项目的参考来源。上游 MIT 版权及许可正文随附于 [public/third-party/cc-switch-LICENSE.txt](public/third-party/cc-switch-LICENSE.txt)，保留其归属。

[CodexBar](https://github.com/steipete/CodexBar) 的原生菜单卡片、图表与按需刷新交互是 macOS 用量面板的参考来源。Lumi 使用独立实现的 AppKit 菜单和 New API 数据，不分发其应用或订阅读取代码。上游 MIT 版权及许可正文随附于 [public/third-party/codexbar-LICENSE.txt](public/third-party/codexbar-LICENSE.txt)。

[New API](https://github.com/QuantumNous/new-api) 是通过 HTTP API 对接的外部服务器项目，上游采用 AGPL-3.0。Lumi 不分发其服务器源码；部署、修改或分发 New API 时需遵循其自身许可。本项目的接口说明不构成对上游服务器的重新许可。

Codex / Claude Code 为用户自行安装的工具，Lumi 不分发其二进制、模型目录或提示词资产。OpenAI、Anthropic 与其他品牌名称和商标归各自权利人所有。
