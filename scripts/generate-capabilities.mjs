#!/usr/bin/env node
/**
 * generate-capabilities.mjs · 人类版能力导览生成器（单一事实源，防漂移）
 *
 * 从代码事实（package.json scripts / packages / bundles / skills / docs/demo）
 * 自动生成两份人类可读产物：
 *   ① docs/capabilities.auto.md   —— 能力导览（故事化，每能力一句话+怎么体验）
 *   ② docs/capabilities.auto.json —— 结构化数据（供 PPT 生成器等消费）
 *   ③ README.md 中 <!-- CAPABILITIES:BEGIN/END --> 区块 —— GitHub 项目页第一眼
 *
 * 用法：
 *   node scripts/generate-capabilities.mjs          # 生成/更新（README 区块原地替换）
 *   node scripts/generate-capabilities.mjs --check  # 校验产物是否最新（漂移 exit 1，可入 CI/门禁）
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const CHECK = process.argv.includes("--check");
const J = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));
const ls = (p, filter) => { try { return readdirSync(join(ROOT, p)).filter(filter ?? (() => true)); } catch { return []; } };

const pkg = J("package.json");
const scripts = Object.keys(pkg.scripts ?? {});
const has = (s) => scripts.includes(s);
const basePkgs = ls("packages/base", (d) => !d.includes(".") && d !== "node_modules");
const topPkgs = ls("packages", (d) => !d.includes(".") && d !== "node_modules" && d !== "base");
const bundles = ls("bundles", (d) => !d.includes("."));
const skills = ls("skills/official", (d) => !d.includes("."));
const demoPages = ls("docs/demo", (f) => f.endsWith(".html") && !["index.html", "shell.html"].includes(f));
const shots = ls("docs/demo/preview-shots", (f) => f.endsWith(".png"));
const repoName = pkg.name?.split("/").pop() || "workloom";
const desc = pkg.description || "AI 经营系统";

// ---------- 能力分组（按事实探测，出现的才列出） ----------
const groups = [];

groups.push({
  icon: "🖥", title: "三端应用（开箱即看）",
  items: [
    { name: "PC 端 · B 端工作台", how: "`pnpm preview:all` → http://localhost:3000", desc: "经营主页/任务中心/规则中心/装配中心，全模拟运行态" },
    { name: "移动端 · B 端高保真", how: "`pnpm preview:all` → http://localhost:3001", desc: `${demoPages.length} 页高保真演示页 + 手机壳容器` },
    { name: "移动端 · C 端 AI 服务前台", how: "`pnpm preview:all` → http://localhost:3002", desc: "小程序入口 H5 模拟：对话/服务/工单/消息/我的，演示直登" },
  ],
});

if (bundles.length) groups.push({
  icon: "🏨", title: "行业 Bundle（垂直能力包）",
  items: bundles.map((b) => ({ name: `bundles/${b}/`, how: `见 bundles/${b}/ 目录`, desc: "围栏/技能/员工/对象/管线一键装配" })),
});

if (basePkgs.includes("computer-use")) groups.push({
  icon: "🖐", title: "操作电脑能力（本仓自带 · 可装生产工作站）",
  items: [
    { name: "computer-use 三层感知（65 动作）", how: "`pnpm computer:preflight && pnpm computer:smoke`", desc: "L1 浏览器 DOM 零 token / L2 全 GUI 语义树 / L3 像素兜底——克隆即可用，不依赖沙箱" },
    { name: "HTTP 远程驱动 + MCP server", how: "`pnpm computer:serve` / `pnpm computer:mcp`", desc: "大脑/手分离：专用工作站被云端 Agent/CI 远程驱动（docs/computer-use-production.md）" },
  ],
});

const engine = [
  ["fence-engine", "围栏 DSL 引擎", "事前裁决：支持 in/contains_any 列表语义"],
  ["skill-ops", "技能保鲜环（下行分发）", "官方技能一键投放：五道预检 + L0/L1 静默/L2 审批 + 一键回滚 + 全事件留痕"],
  ["captain", "L2 编排（ASK/QUEST）", "一句话目标自动拆解多步骤并派发"],
  ["night-shift", "夜班自动运行", "离线任务推进，次日晨报"],
  ["model-router", "模型路由", "离线确定性模型，无密钥可跑"],
  ["publish-rpa", "全平台 RPA 发布", "抖音/小红书/B站/YouTube，BrowserDriver 注入接真浏览器"],
  ["workdata", "五元事件 + RLS 隔离", "全链路可追溯、可验链"],
  ["im-channels", "IM 渠道", "企微等出入站，审批卡片直达手机"],
  ["service-dialog", "C 端 AI 服务前台", "对话/知识库 385 问/工单/SLA"],
  ["inspection", "自动巡检", "异常发现→派发→处置闭环"],
  ["review-console", "人审台", "必审事项人拍板，AI 不越权"],
  ["asset-cms", "资产管理", "素材/成片全生命周期"],
  ["cost-ledger", "成本台账", "每次模型调用可计量"],
  ["deal-flow", "交易流", "商机到成交全链路"],
  ["social-listening", "社媒监听", "评论/询盘意图雷达"],
].filter(([k]) => basePkgs.includes(k));
if (engine.length) groups.push({
  icon: "🤖", title: "AI 自动化引擎（系统内置能力）",
  items: engine.map(([, n, d]) => ({ name: n, how: "见 docs/capability-map.md L3", desc: d })),
});

const quality = [
  has("setup") && { name: "一键安装（bootstrap）", how: "`pnpm setup`", desc: "克隆后一条命令装好全部能力：环境/依赖/PG/迁移种子/桌面栈，幂等" },
  has("suite") && { name: "主测试套件", how: "`pnpm suite`", desc: "数百条场景用例逐条执行" },
  has("suite:geo") && { name: "GEO 域套件", how: "`pnpm suite:geo`", desc: "GEO 双域专项" },
  has("suite:hotel") && { name: "酒店域套件", how: "`pnpm suite:hotel`", desc: "酒店域专项" },
  has("release:gate") && { name: "发布门禁", how: "`pnpm release:gate`", desc: "未全过禁止发布（硬性）" },
  has("db:verify-chain") && { name: "五元事件验链", how: "`pnpm db:verify-chain`", desc: "事件链完整性校验" },
  has("agent:tour") && { name: "Agent 能力巡游", how: "`pnpm agent:tour`", desc: "AI Agent 一键自检全部能力" },
  has("doctor") && { name: "环境自检", how: "`pnpm doctor`", desc: "一屏排查环境问题" },
].filter(Boolean);
groups.push({ icon: "✅", title: "验证与质量（工程纪律）", items: quality });

const assets = [
  demoPages.length && { name: `高保真演示页 ×${demoPages.length}`, how: "http://localhost:3001", desc: "糖果色，含手机壳容器" },
  existsSync(join(ROOT, "apps/site")) && { name: "官网静态站", how: "apps/site/index.html", desc: "对外产品故事" },
  skills.length && { name: `自带技能 ×${skills.length}`, how: "skills/official/", desc: skills.slice(0, 4).join(" / ") + (skills.length > 4 ? " 等" : "") },
  existsSync(join(ROOT, "docs/capability-tour.pptx")) && { name: "能力导览 PPT", how: "docs/capability-tour.pptx", desc: "路演/汇报直接用" },
  existsSync(join(ROOT, "mock/README.md")) && { name: "Mock 数据体系", how: "mock/README.md", desc: "种子 + 离线模型 + 演示直登，开箱即用" },
].filter(Boolean);
groups.push({ icon: "🎁", title: "演示与交付资产", items: assets });

// ---------- 生成 JSON ----------
const data = { repo: repoName, description: desc, generatedAt: new Date().toISOString(), demoPages, shots, groups };

// ---------- 生成 Markdown（人类版导览） ----------
const shotBlock = shots.length
  ? `\n| PC 端 | B 端移动（手机壳） | C 端移动 |\n|---|---|---|\n| ${shots.includes("pc-3000.png") ? "![PC](demo/preview-shots/pc-3000.png)" : "—"} | ${shots.includes("shell-guest.png") ? "![B移动](demo/preview-shots/shell-guest.png)" : "—"} | ${shots.includes("mobile-c-3002.png") ? "![C移动](demo/preview-shots/mobile-c-3002.png)" : "—"} |\n`
  : "";

const md = `# ${repoName} · 能力导览（人类版）

> ${desc}
> 本文件由 \`node scripts/generate-capabilities.mjs\` 从代码事实**自动生成**（${data.generatedAt.slice(0, 10)}），
> 请勿手改——能力变更后重跑生成器即可。Agent 版机器清单见 docs/capability-map.md。

## 🚀 5 分钟体验路径

\`\`\`bash
pnpm install && pnpm preview:all
\`\`\`

| 端 | 地址 | 看什么 |
|---|---|---|
| 🖥 PC · B 端工作台 | http://localhost:3000 | 经营主页全员就位、晨报、待审批、一句话目标输入 |
| 📱 B 端移动 | http://localhost:3001 | 演示导航页 → 任选高保真页「手机壳」预览 |
| 📱 C 端 AI 服务前台 | http://localhost:3002 | 免登对话：查订单/售后/物流/常见问题 |

无需任何真实后端或密钥：Mock 数据（种子 + 离线确定性模型 + 演示直登）已固化，详见 mock/README.md。
${shotBlock}
## 📦 能力总览（${groups.reduce((n, g) => n + g.items.length, 0)} 项）

${groups.map((g) => `### ${g.icon} ${g.title}\n\n| 能力 | 一句话 | 怎么体验 |\n|---|---|---|\n${g.items.map((i) => `| **${i.name}** | ${i.desc} | ${i.how} |`).join("\n")}`).join("\n\n")}

## 🧭 下一步

- 想二次开发：读 AGENTS.md → 跑 \`pnpm agent:tour\` → 看 docs/capability-map.md（全量机器清单）
- 想改 UI：必须遵守 docs/design-system.md（Candy Design System），改完用浏览器能力截图核对
- 想发布：\`pnpm release:gate\` 全过是硬性门禁，清单见 docs/release-checklist.md
`;

// ---------- README 区块 ----------
const readmeBlock = `<!-- CAPABILITIES:BEGIN -->
<!-- 本区块由 scripts/generate-capabilities.mjs 自动生成（${data.generatedAt.slice(0, 10)}），请勿手改；重跑 pnpm capabilities 更新 -->

## 🧩 系统能力速览（自动生成 · 与代码同步）

${groups.map((g) => `- ${g.icon} **${g.title}**：${g.items.map((i) => i.name.replace(/\*\*/g, "")).slice(0, 6).join(" · ")}${g.items.length > 6 ? ` 等 ${g.items.length} 项` : ""}`).join("\n")}

> 📖 完整能力导览（含截图与体验路径）：[docs/capabilities.auto.md](docs/capabilities.auto.md) ｜ 🤖 AI Agent 入口：[AGENTS.md](AGENTS.md) ｜ 🎯 首启必跑：\`pnpm preview:all\`
<!-- CAPABILITIES:END -->`;

// ---------- 写入 / 校验 ----------
const outs = [
  ["docs/capabilities.auto.md", md],
  ["docs/capabilities.auto.json", JSON.stringify(data, null, 1) + "\n"],
];
let stale = false;

const readmePath = join(ROOT, "README.md");
let readme = readFileSync(readmePath, "utf8");
let newReadme = readme;
if (readme.includes("<!-- CAPABILITIES:BEGIN -->")) {
  newReadme = readme.replace(/<!-- CAPABILITIES:BEGIN -->[\s\S]*?<!-- CAPABILITIES:END -->/, readmeBlock);
} else {
  // 首次：插到第一个 "---" 分隔线之前（标题区之后）
  const i = readme.indexOf("\n---\n");
  newReadme = i >= 0 ? readme.slice(0, i) + "\n\n" + readmeBlock + "\n" + readme.slice(i) : readmeBlock + "\n" + readme;
}
outs.push(["README.md", newReadme]);

// 校验模式下归一化易变字段（生成时间），避免跨时间误报漂移
const normalize = (s) => s
  .replaceAll(data.generatedAt, "<TS>")
  .replaceAll(data.generatedAt.slice(0, 10), "<DATE>")
  .replace(/"generatedAt": "[^"]*"/, '"generatedAt": "<TS>"')
  .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z/g, "<TS>");

for (const [rel, content] of outs) {
  const p = join(ROOT, rel);
  const cur = existsSync(p) ? readFileSync(p, "utf8") : null;
  if (cur === content || (CHECK && cur !== null && normalize(cur) === normalize(content))) { console.log(`  ✓ ${rel}（已最新）`); continue; }
  if (CHECK) { console.log(`  ✗ ${rel} 已漂移`); stale = true; continue; }
  writeFileSync(p, content);
  console.log(`  ✍ ${rel} 已更新`);
}

if (CHECK) {
  if (stale) { console.error("\n能力产物与代码漂移 → 运行 pnpm capabilities 重新生成"); process.exit(1); }
  console.log("能力产物与代码同步 ✓");
} else {
  console.log(`\n能力导览已生成：${groups.reduce((n, g) => n + g.items.length, 0)} 项能力 · ${groups.length} 组 · 演示页 ${demoPages.length} · 截图 ${shots.length}`);
}
