# WorkLoom Candy Design System v1.1

统一设计资源包。每个项目仓库保留独立副本，拉取即用，**无外部依赖**。

## 文件清单

| 文件 | 作用 |
|---|---|
| `design_spec.md` | 面向 AI 编程 Agent 的设计规范（颜色/字体/布局/组件/交互/断点 + 代码示例） |
| `tokens.web.css` | B 端设计令牌（Tailwind v4 `@theme`，事实源） |
| `tokens.webc.css` | C 端设计令牌（同色系，动效集不同） |
| `components.css` | 可复用组件库（`.wl-*` 类：按钮/输入/卡片/色块/弹窗/AskRail/手机壳…） |

## 接入方式

**Tailwind v4 工程（apps/web、apps/webc）**

```css
@import "tailwindcss";
@import "./tokens.web.css";   /* 或 tokens.webc.css */
@import "./components.css";
```

> 各仓 `apps/*/src/styles/tokens.css` 与本包 `tokens.*.css` 逐值一致；如需改值，先改本包再全仓同步（流程见 design_spec.md §10）。

**纯 HTML 演示页（docs/demo/*.html）**

```html
<link rel="stylesheet" href="../../design-system/components.css">
<!-- 内建 :root 回退变量，无需 tokens 文件即可使用 .wl-* 组件类 -->
```

## 独立修改样式

1. 改颜色/字号/圆角 → 编辑 `tokens.*.css` 中对应 `--*` 变量（组件全部消费变量，会自动跟随）。
2. 改组件外观/交互 → 编辑 `components.css` 中对应 `.wl-*` 类。
3. 改完按 `design_spec.md §10` 同步到其余仓库，保持各仓副本一致。

## 版本

- v1.1（2026-08-26）：新增模块色块五淡色、AskRail 通栏组件、手机壳边框规范、文案命名纪律；初版组件库封装。
- v1.0（2026-08）：糖果色系确立，深空蓝主题终结。
