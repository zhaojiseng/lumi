# 紧凑界面

独立界面插件示例。包不编译进 Lumi EXE；复制整个目录到设置中的额外插件目录，重新扫描后在“界面插件”选择“紧凑界面”。切换不重置设置草稿或页面数据。

`plugin.json` 声明 `kind: interface`，`interface.css` 修改现有外壳的侧栏宽度、间距和强调色，不包含脚本或数据权限。`LICENSE` 是完整 MIT 许可。作者可复制本包、修改 ID 和样式，无需改动内置注册表。

格式、区域选择器、CSS 限制及恢复机制见仓库的 [作者指南](../../README.md#界面插件-v1)。检查：`npm run check:extensions -- extensions/packages/extension.lumi.compact`。
