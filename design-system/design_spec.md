# WorkLoom 设计规范（面向 AI 编程 Agent）· Candy Design System v1.1

> **读者**：AI 编程 Agent 与人类开发者。生成任何 WorkLoom 系前端代码前必读。
> **事实源**：本包 `tokens.web.css`（B 端 PC / 管理端）与 `tokens.webc.css`（C 端）。一切颜色、字号、圆角以令牌为准，**禁止在组件内硬编码品牌色**。
> **包结构**：
> ```
> design-system/
> ├── design_spec.md    ← 本文件（规范 + 代码示例）
> ├── tokens.web.css    ← B 端令牌（Tailwind v4 @theme）
> ├── tokens.webc.css   ← C 端令牌（同色系，动效集不同）
> ├── components.css    ← 可复用组件库（.wl-* 类，框架无关）
> └── README.md         ← 接入说明
> ```

---

## 1. 快速接入（Agent 操作步骤）

| 场景 | 做法 |
|---|---|
| Tailwind v4 工程（apps/web） | 样式入口 `@import "tailwindcss";` 后引入 tokens；组件类用 Tailwind 令牌类（`bg-bg950` `text-ink` `border-gline`…） |
| C 端（apps/webc） | 同上，改用 `tokens.webc.css` |
| 纯 HTML 演示页（docs/demo/*.html） | `<link rel="stylesheet" href="components.css">`（内建 :root 回退变量，开箱即用），或内联同值 CSS 变量 |
| React 组件 | 优先消费 Tailwind 令牌类；复杂交互参照 §5 的 class 组合 |

```css
/* Tailwind v4 工程接入示例 */
@import "tailwindcss";
@import "./tokens.web.css";      /* @theme 令牌，自动生成 bg-* text-* border-* 工具类 */
@import "./components.css";      /* .wl-* 组件类 */
```

---

## 2. 颜色系统

### 2.1 背景四阶

| 令牌 / Tailwind 类 | 值 | 用途 |
|---|---|---|
| `--color-bg950` / `bg-bg950` | `#fff5f7` | 页面底（奶莓） |
| `--color-bg900` / `bg-bg900` | `#ffffff` | 卡片（云白） |
| `--color-bg800` / `bg-bg800` | `#fff0f4` | 浮层/次级面板（蜜桃雾） |
| `--color-bg700` / `bg-bg700` | `#ffe4ec` | 悬停/选中（樱花粉） |

### 2.2 品牌色（一色一职，禁止混用）

| 令牌 / 类 | 值 | 职责 |
|---|---|---|
| `--color-gold` / `text-gold` | `#ff2442` | 主行动色：按钮/品牌/强调（珊瑚红） |
| `--color-gold2` | `#ff7a9e` | 渐变副色（糖果粉），仅与 gold 组 135° 渐变 |
| `--color-goldhi` / `text-goldhi` | `#d4002a` | 深珊瑚：浅底上的强调文字/数字 |
| `--color-ongold` | `#ffffff` | 主色上的文字 |
| `--color-holo` / `text-holo` | `#4d96ff` | 信息/证据/链接（蓝莓蓝） |
| `--color-holo2` | `#6ec6ff` | 次级信息（天空蓝） |

```html
<!-- ✅ 正确：行动用珊瑚渐变，信息用蓝莓 -->
<button class="wl-btn wl-btn-primary">立即生成</button>
<a class="text-holo" href="#">查看证据链</a>
<!-- ❌ 错误：信息链接用珊瑚红 = 混用职责 -->
```

### 2.3 语义四色（全局唯一，禁止另立）

| 令牌 | 值 | 语义 |
|---|---|---|
| `--color-go` | `#22c88a` | 薄荷绿：auto/已完成/通过 |
| `--color-warn` | `#ffaa33` | 蜜桃橙：review/待审/警告 |
| `--color-alert` | `#ff4d6d` | 草莓红：block/熔断/失败 |
| `--color-need` | `#b678ff` | 葡萄紫：需人工介入 |

### 2.4 文字三级与描线

| 令牌 | 值 | 用途 |
|---|---|---|
| `--color-ink` | `#33262b` | 正文（深可可，对比 ≥4.5:1） |
| `--color-ink2` | `#8a757d` | 辅助说明（≥3:1） |
| `--color-ink3` | `#b9a9b0` | 图例/占位；**禁止用于 12px 以下功能性文字** |
| `--color-line` | `rgb(255 36 66 / .14)` | 卡片描边 |
| `--color-gline` | `rgb(255 36 66 / .32)` | 强调描边/focus |
| `--color-card` | `rgb(255 255 255 / .88)` | 卡片底（微透） |

### 2.5 模块色块（页面分区淡底，v1.1 新增）

同页多业务模块时用淡底色块分区，代替生硬分割线；**圆角统一 16px，描边用配套浅灰，禁用白色/无色描边**。

| 类 | 底 / 描边 | 适用模块 |
|---|---|---|
| `.wl-tint-peach` | `#fff0f4` / `#ebdde0` | 核心经营区 |
| `.wl-tint-blue` | `#f0f7ff` / `#dce3ea` | 信息/数据区 |
| `.wl-tint-mint` | `#f0fbf6` / `#dce7e2` | 自动化/已完成区 |
| `.wl-tint-amber` | `#fff6ec` / `#ebe2d8` | 待办/审批区 |
| `.wl-tint-grape` | `#f7f2ff` / `#e3deea` | 需介入/AI 区 |

### 2.6 渐变

仅一处合法品牌渐变：`linear-gradient(135deg, var(--color-gold), var(--color-gold2))`（`.gold-grad` / `.wl-btn-primary`）。其余渐变一律禁止自创。

---

## 3. 字体体系

### 3.1 字族三级

| 令牌 | 字族 | 用途 |
|---|---|---|
| `--font-sans` | PingFang SC / 微软雅黑 / 思源黑体 | 正文（默认） |
| `--font-mono` | JetBrains Mono | 编号/代码，**禁止换行**（`white-space:nowrap`） |
| `--font-orb` | Orbitron | HUD 大数字（KPI/LV/能量） |

### 3.2 字号阶梯（桌面基准）

| 令牌 | 值 | 用途 |
|---|---|---|
| `--text-display` | 44px | 封面/战役级标题（仅营销物料） |
| `--text-h1` | 22px | 页面标题 |
| `--text-h2` | 16px | 卡片/面板标题 |
| `--text-body` | 13.5px | 正文（行高 1.7–1.9） |
| `--text-caption` | 11px | 辅助说明/时间/标签 |
| `--text-micro` | 10px | 图例/角标（**不低于 9.5px**） |
| `--text-kpi` | 28px | KPI 大数（配 `--font-orb`） |

```html
<h1 class="font-sans" style="font-size:var(--text-h1);color:var(--color-ink)">经营主页</h1>
<div class="font-orb" style="font-size:var(--text-kpi);color:var(--color-goldhi)">¥ 128,600</div>
```

---

## 4. 间距与布局网格

- **间距一律 8 的倍数**（4 仅用于图标内距）：8 / 16 / 24 / 32 / 40。
- **舰桥框架**：最大宽 `--spacing-bridge: 1180px` 居中；≤1240px 贴边（`width: calc(100vw - 16px)`）。
- **三栏**：左 236px（会话列表）· 弹性主区 · 右 264px（上下文）；≤860px 左右栏隐藏、主区全宽。
- **AI 助手 AskRail**：右侧通栏 **展开 320px / 收起 56px**，主区用 `padding-right` 让位（`.wl-askrail-main-pad`），≤860px 不渲染通栏（移动端走首 tab 对话页）。
- **圆角分级**：卡片 16px · 气泡 14px（对方消息左上直角 4px）· 弹层 18px · 舰桥 20px · 按钮/标签全圆角 999px。

```html
<!-- 标准页面骨架 -->
<body class="bg-bg950 text-ink font-sans">
  <div class="mx-auto" style="max-width:var(--spacing-bridge)">
    <main class="wl-askrail-main-pad"><!-- 内容 --></main>
    <aside class="wl-askrail"><!-- AI 助手对话 --></aside>
  </div>
</body>
```

---

## 5. 组件变体（含代码示例）

### 5.1 按钮（四变体）

| 变体 | 类 | 用途 |
|---|---|---|
| 主按钮 | `.wl-btn-primary` | 每屏最多 1–2 个主动作（自带 sheen 流光） |
| 次按钮 | `.wl-btn-secondary` | 次级动作 |
| 幽灵按钮 | `.wl-btn-ghost` | 辅助动作 |
| 危险按钮 | `.wl-btn-danger` | 驳回/制动（描边红，**不用实底红**） |

```html
<button class="wl-btn wl-btn-primary">发布</button>
<button class="wl-btn wl-btn-secondary">存草稿</button>
<button class="wl-btn wl-btn-ghost">取消</button>
<button class="wl-btn wl-btn-danger">驳回</button>
<button class="wl-btn wl-btn-primary is-loading">生成中…</button>
<button class="wl-btn wl-btn-secondary" disabled>不可点</button>
```

```tsx
// React + Tailwind 等价写法
<button className="rounded-full px-[18px] py-2 gold-grad text-ongold font-semibold
  transition hover:-translate-y-px active:scale-95 disabled:opacity-45">发布</button>
```

### 5.2 输入框

```html
<input class="wl-input" placeholder="搜索技能…">
<input class="wl-input is-error" value="非法值">
<p class="wl-input-error-msg">格式不正确</p>   <!-- 错误用文字提示，不用红底 -->
```

### 5.3 卡片

```html
<div class="wl-card">基础卡片</div>
<div class="wl-card wl-card--accent">强调卡片（gline 描边）</div>
<div class="wl-card wl-card--lv-a">A 级：左 3px 草莓红色条</div>
<div class="wl-card wl-card--lv-b">B 级：左 3px 珊瑚色条</div>
```

### 5.4 标签

```html
<span class="wl-tag wl-tag--hot">爆款</span>
<span class="wl-tag wl-tag--gold">主推</span>
<span class="wl-tag wl-tag--teal">自动</span>
```

### 5.5 弹窗

```html
<div class="wl-modal-mask">
  <div class="wl-modal">
    <h2 style="font-size:var(--text-h2)">确认审批</h2>
    <!-- 底部双按钮：批准=go 实底 / 驳回=alert 描边 -->
  </div>
</div>
```

### 5.6 横幅与空态与骨架

```html
<div class="wl-banner">演示模式：数据为模拟样例</div>  <!-- 浅琥珀底+深字，禁浅黄字配浅黄底 -->
<div class="wl-empty"><div class="wl-empty-icon">🍬</div>
  <div class="wl-empty-title">还没有技能</div>
  <div class="wl-empty-hint">加装一个员工即可开工</div></div>
<div class="wl-skeleton" style="height:14px;width:60%"></div>
```

---

## 6. 交互反馈规范

| 场景 | 规则 |
|---|---|
| 悬停 | 按钮 `translateY(-1px)` + 阴影加深；列表行底色 `bg-bg700` |
| 点击 | `scale(.97)`，时长 ≤.16s |
| focus | `:focus-visible` 2px `--color-holo` 外描边；输入框 `border-gline` + 3px 光晕 |
| 加载 | 按钮 `.is-loading` 前置旋转圈；区块用 `.wl-skeleton` 骨架，**禁止白屏** |
| 禁用 | `opacity:.45` + `cursor:not-allowed`，禁只改颜色 |
| 动效时长 | 功能反馈 ≤1.2s；氛围类（drift/sheen/pulse）须登记 `prefers-reduced-motion` 降级 |
| 浅底纪律 | 辉光类动效透明度减半（防白雾）；深色系元素在浅底一律加深一档 |

---

## 7. 响应式断点

| 断点 | 行为 |
|---|---|
| >1240px | 标准三栏 + 舰桥 1180 居中 |
| ≤1240px | 舰桥贴边（`calc(100vw - 16px)`） |
| ≤860px | 左右栏隐藏、主区全宽；**AskRail 通栏不渲染**，AI 助手走首 tab 对话页 |
| 移动端演示页 | 手机壳 `.wl-phone`：390px 宽、左右 1px 浅灰边框（`#e5dce0`）、底 tab 栏 `rgb(255 255 255 / .96)`、选中项珊瑚色 |

---

## 8. 文案与命名纪律（客户视角，v1.1 固化）

界面文案一律用业务词，禁止内部黑话与跨项目串词：

| ✅ 用 | ❌ 禁 |
|---|---|
| 技能 | 套件、装备 |
| 前厅 Agent（酒店）/ 各自行业 Agent 名 | 总导演（视频项目专属，禁串台） |
| 经营主页 | 剧场、甲板 |
| 日报 | 战报 |
| 审批 / CEO 决策 | 决断、裁决 |
| 任务中心 / 规则中心 / 技能中心 / 团队成员 | 任务舱 / 航道管制 / 装备库 / 名册 |
| 全景档案 | （旧称一律替换） |

---

## 9. 历史踩坑纪律（改版前必读）

| 编号 | 规则 |
|---|---|
| D33-1 | 浅底主题「高光」= 深阶（goldhi 是深珊瑚不是浅金） |
| D33-2 | Canvas 精灵色系随主题复审；纯色验证法（先打纯红看渲染路径） |
| D33-3 | 浅底名牌 = 白底深字，禁深底浅字泡 |
| D33-4 | 语义横幅 = 浅底深字（amber-100 底 + amber-800 字） |
| D33-5 | 视觉验收截图等动画终态（virtual-time-budget ≥ 动画时长 ×2） |
| D33-6 | 产品文案禁隐喻黑话 |
| D34-1（新） | 模块色块必须「淡底 + 配套浅灰描边 + 16px 圆角」三件套齐用，禁只铺底色 |
| D34-2（新） | 手机壳左右 1px 边框不可丢不可加深，值固定 `#e5dce0` |
| D34-3（新） | AskRail 收起态 56px 必须有视觉锚点（图标条），禁直接隐藏 |

---

## 10. 变更与同步流程（每次视觉/交互调整后执行）

1. 改值只改 `tokens.web.css` / `tokens.webc.css`；组件行为只改 `components.css`；本文件同步补示例。
2. 三件套一并复制到各仓库 `/design-system/`（每仓独立副本，无外部依赖）。
3. 各仓 `docs/design-system.md` 的版本号与本包保持一致。
4. 验收：每仓跑「纯色验证」——主色按钮、语义四色、文字三级各截一屏比对。
