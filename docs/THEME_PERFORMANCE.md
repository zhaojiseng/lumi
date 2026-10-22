# 主题运行层优化（2026-10-23）

本次在 Lumi 1.0.4 开发源码上优化界面插件共用的玻璃运行层，基线提交为 `5d25ca2fc9cef6e2bf993752a54f429cdd2959e5`。不修改插件 API、外观选项和 CSS 材质，也不改变公开版本。

## 实现

- 将纯位移图生成拆到 `src/host/glass-displacement.ts`。DOM 可见性、几何缓存、SVG 滤镜和退出清理由 `glass-refraction.ts` 负责，原有导出保留，主窗口、SDK iframe 和外观预览继续共用同一实现。
- 平坦中心及圆角外部的折射权重为零，跳过其四次额外距离采样及法线归一化。边缘法线与选中透镜的焦点公式沿用原算法。
- 默认布局样式表与界面插件样式表分别管理生命周期。默认布局只在宿主挂载时解析，切换、停用或拒绝插件样式时保留同一份默认布局；插件规则仍按原作用域校验并在清理时移除。

## 测量

Windows x64、Node 24.18.0，同一进程交替执行旧版和新版，每项 5 次预热、15 组样本，每组生成 5 次，比较耗时中位数。

| 位移图 | 基线 ms | 优化后 ms | 降低 |
| --- | ---: | ---: | ---: |
| 工作区 1200×800 | 6.542 | 2.982 | 54.4% |
| 模型卡片 300×220 | 5.139 | 3.617 | 29.6% |
| 弹窗 680×520 | 8.637 | 3.370 | 61.0% |
| 选中透镜 160×36 | 0.478 | 0.340 | 28.8% |

256 组参数的宽高与 RGBA 数据逐字节相同，覆盖不同圆角、缩小纹理、透镜、功能表面和小数尺寸。永久回归断言保留 8 组旧实现的 SHA-256，包含小图、圆角夹取和小数尺寸。

这些数字只描述 CPU 位移图生成；正常运行会复用几何与纹理缓存，不能把此比例解释为整机加速、GPU 利用率下降或滚动帧率提升。原始测量保存在相邻插件仓库 `.cache/theme-efficiency-20261023/applied-benchmark.json`。可复现命令见插件仓库 `docs/DREAMY_RENDERING.md`。

## 本次验证

- `npm.cmd run typecheck`：通过。
- `node --import tsx --test tests/glass-refraction.test.ts`：5 项通过。
- `node --import tsx --test --test-concurrency=1 tests/glass-refraction-ui.test.ts tests/interface-plugin-ui.test.ts tests/appearance-preview-ui.test.ts tests/renderer-pipeline-ui.test.ts`：4 项真实 Electron 回归通过；覆盖默认布局对象复用、插件规则释放、无效样式回退、设置草稿保留、折射纹理复用、视口裁切、暂停入场动画、媒体回退及预览资源释放。
- `npm.cmd run build`、构建后的 `npm.cmd run test:desktop`：通过，使用隔离应用数据与 CLI home。完整第三方许可生成保留。
- 独立插件 `npm.cmd run check`：通过。浮梦 `npm.cmd run check:dreamy-ui -- ../main`：完整软件合成回归通过，覆盖浅深主题、真实开关动画像素、减少动态效果、辅助显示模式、原生下拉、多选、窄窗口及选中透镜。硬件合成 `npm.cmd run check:dreamy-ui -- ../main --pixels-only --hardware` 也通过浅深色开启／关闭的 20 个真实画面采样。软件与硬件结果分别保存在插件仓库 `.cache/dreamy-ui/result.json` 和 `result-pixels-gpu.json`。

本轮不代表全量测试或 macOS 验证，也没有打包、提交、推送或发布。
