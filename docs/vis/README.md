# docs/vis —— 无浏览器验收 UI 版式

改 canvas 图表（尤其记账 Audit 的柱状图）时，跑这个就能把**真实绘制指令**渲成 PNG 看一眼，
不需要浏览器 / Playwright（本机 chromium 缺 `libnspr4`，起不来）。

```bash
# 在仓库根目录
node docs/vis/render-bar.mjs                 # 默认 DS=two
DS=past node docs/vis/render-bar.mjs         # 历史整月（31 天稠密）
DS=all  node docs/vis/render-bar.mjs         # 「全部月份」按月轴
W=330 H=150 DS=past node docs/vis/render-bar.mjs   # 手机宽度
OUT=/tmp/x.png DS=one node docs/vis/render-bar.mjs
```

数据集：`two`（月初两天，最容易暴露「巨型色块」）、`one`、`spread`、`full`、`all`、`past`（整月稠密）、`pastsparse`（整月稀疏）。

产物默认写到 `docs/vis/out/`。

原理：`raster.mjs` 是一个 ~200 行的迷你 canvas2D 光栅器（只实现 `moveTo/lineTo/quadraticCurveTo/
fill/stroke/arc/clearRect/fillText/createLinearGradient` + 2× 超采样），PNG 用 `zlib` 手写；
`render-bar.mjs` 从 `index.html` 里抽出 Audit 那一段脚本（含真实的 `fillRoundBar`），
用假 DOM 喂数据和 canvas，所以画出来的就是真代码的效果（字体是 3×5 点阵近似，只影响字形、不影响版式）。
