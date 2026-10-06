# 界面玻璃层级

玻璃材质由界面插件提供，几何位移图由宿主管理。Lumi 0.5.17 起支持为功能容器声明 `--lumi-glass-surface: 1`，宿主仅对匹配的容器、可见滑块及公共浮层分配有上限的本地滤镜。

| 层 | 职责 | 浮梦实现 |
| --- | --- | --- |
| 页面背景 | 图片或主题渐变 | 桌面背景层 |
| 容器背景 | 透明底色、局部虚化、边缘折射 | 容器在 `z-index: 0` 建立普通层叠上下文，独立 `::before` 在 `-1` 采样；父容器不使用 backdrop-filter |
| 内容 | 标题、数字、价格、表格与列表 | 普通内容层，不对正文应用 filter |
| 控件文字 | 每个连续滑块的可交互选项 | 按钮在 `z-index: 1`，选中状态保留 checked／pressed 语义 |
| 选中透镜 | 移动玻璃面与文字放大 | 滑块在 `z-index: 2`，pointer-events 为 none，采样实际文字；不附加文字模糊 |
| 浮层 | 下拉、popover、弹窗、通知 | 宿主公共弹层管理堆叠、焦点和退出生命周期；主题只提供材质 |

插件树行是共享容器内的内容，不分别绘制卡片背景或投影。宿主用弱作用域规则为每个元素重置 `--lumi-glass-filter`，仅为已注册目标设置本地 URL。目标的伪元素仍继承自己的滤镜，子组件不能误用父组件的位移图。临时浮层优先于透镜、侧栏／工作区及普通容器；隐藏、透明度为零、视口外或被滚动容器裁切的节点不占用 96 个滤镜名额。

## 新组件的折射约定

新组件显式声明 `data-lumi-glass="background"`（独立背景伪元素）、`surface`（宽边缘容器）或 `lens`（选择文字透镜），无需假借已有组件类名。该属性仅声明宿主管理的本地几何滤镜，不允许任意 URL；皮肤仍需在相应背景层消费 `var(--lumi-glass-filter, blur(0px))`。旧组件选择器和 `--lumi-glass-surface:1` 保留兼容。

```html
<div data-lumi-glass="background" class="message-preview">
  <div class="message-preview-content">用户消息</div>
</div>
```

```css
.message-preview { position: relative; isolation: isolate; opacity: 1; }
.message-preview::before {
  content: ''; position: absolute; inset: 0; z-index: -1;
  backdrop-filter: var(--theme-popup-blur, blur(0px)) var(--lumi-glass-filter, blur(0px));
}
```

透明度动画必须在背景伪元素和文字层分别执行，过滤层的父容器保持 `opacity:1`，避免产生新的 backdrop root 截断背景采样。关闭扭曲、实色、系统减少透明度／强制颜色时释放位移图；模糊由皮肤的同一选项控制。

主窗口和功能插件 iframe 使用同一份 `src/host/glass-refraction.ts`。`scripts/extension-ui.mjs` 编译算法并与 SDK 合并，构建输出 `dist-electron/lumi-extension-sdk.js` 是实际供给文件；SDK 源文件本身不包含算法。每个文档独立安装、同一根节点重复安装去重，换肤与 `pagehide/pageshow` 管理清理和重建。不要在插件包内复制算法或 SDK。

运行时没有常驻动画循环，更新合并到下一帧；自身滤镜变量写入不会触发重复扫描。几何纹理用最多 32 项的 LRU 缓存复用，强度变化只改位移 scale，退出时恢复原内联样式并释放纹理、观察器和 SVG。

新增组件需覆盖主窗口或 iframe 的真实背景像素、进入／退出中间帧、换肤、尺寸、隐藏、强度与辅助显示模式。纯 CSS 计算属性、注入条纹，或接近零的渐变差异只可证明链路部分工作，不能替代实际消息／控件画面。对应回归为 `glass-refraction-ui.test.ts`、`extension-refraction-ui.test.ts` 和插件 `check-codex-ui.mjs`／`check-dreamy-ui.mjs`。

背景玻璃统一沿用当前模糊选项；选择透镜保留零模糊以呈现文字折射。透明度、扭曲强度分别控制，系统减少透明度和强制颜色优先于插件设置。不透明模式将文字移到滑块上方，禁用背景滤镜。减少动态效果关闭位移动画。

连续滑块支持 pressed 按钮与 checked 单选项。拖动过程只预览，松手后点击目标选项一次；Escape 或 pointercancel 恢复原选择。尺寸、换行、键盘选择和可访问状态由共享组件维护。

Lumi 0.5.18 将组件集中于 `src/components/SegmentedSwitch.tsx`，公共样式集中于 `src/components/segmented-switch.css`，由主入口加载。`ui.tsx` 保留原导出以兼容现有调用。调用方只声明标签、选项、选中语义和回调，不自行绘制滑块或处理拖动；业务状态与保存仍由页面维护。

`size` 支持 `compact`（默认，26px）、`regular`（34px）和 `large`（40px）三种按钮最小高度。模型供应商使用大号；设置、来源与会话导航使用常规尺寸；时间范围和卡片条件使用紧凑尺寸。空间不足时整体换行，透镜同时测量横纵坐标。梦幻材质统一应用于移动透镜，按钮自身保持透明，避免出现两层选中玻璃。
