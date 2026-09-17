#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const errors = [];
const requireText = (path, text, message) => {
  if (!read(path).includes(text)) errors.push(message);
};
const forbid = (path, pattern, message) => {
  if (pattern.test(read(path))) errors.push(message);
};

const sideNav = "apps/web/src/shell/SideNav.tsx";
const navAssembly = "apps/web/src/shell/NavMenu.tsx";
const app = "apps/web/src/App.tsx";
const bridge = "apps/web/src/shell/Bridge.tsx";
const access = "apps/web/src/shell/NavigationAccess.tsx";
const desktop = "apps/desktop/electron/main.cjs";

requireText(sideNav, 'from "@workloom/ui"', "PC 左栏必须消费共享 UI 导航与图标契约");
requireText(sideNav, 'type NavMode = "expanded" | "collapsed" | "hidden"', "PC 左栏缺少展开/折叠/隐藏三态");
requireText(sideNav, 'workloom:reset-layout', "PC 左栏缺少恢复默认布局协议");
requireText(sideNav, "MOBILE_QUERY", "PC 左栏缺少窄屏抽屉适配");
requireText(navAssembly, "composeNavigation", "PC 导航必须通过共享 composeNavigation 组装");
forbid(navAssembly, /bundle:ai-pm|TASK_CARDS_BY_BUNDLE|hotel/i, "PC 导航不得硬编码示例或行业包入口");
requireText(navAssembly, "navigationPermissions", "PC 导航缺少服务端身份/版本能力到入口权限的映射");
requireText(navAssembly, "canonicalNavigationPath", "PC 动态卡片缺少旧深链到语义地址的兼容映射");
requireText(sideNav, "useNavigationAccess", "PC 左栏未消费统一权限过滤结果");
requireText(sideNav, 'placeholder="搜索页面"', "PC 左栏缺少导航搜索");
requireText(sideNav, "FAVORITES_KEY", "PC 左栏缺少按身份隔离的收藏入口");
requireText(sideNav, "RECENT_KEY", "PC 左栏缺少按身份隔离的最近使用入口");
requireText(sideNav, "<LayoutControls", "PC 左栏缺少统一视图与布局控制");
requireText(access, "trpc.members.me.query", "PC 导航权限未读取服务端成员身份与版本能力");
requireText(access, "trpc.bundles.currentUi.query", "PC 行业导航未读取服务端校验后的当前行业包投影");
requireText(access, "NavigationAccessBoundary", "PC 深链缺少与导航同源的权限守卫");
forbid(navAssembly, /route:\s*"\/p(?:0|1|3|4|5|6|7|8|9|21|22|23|24|26|27|28|29|30|31)"/, "PC 导航不得复制共享基座的旧版页面路径");

for (const route of [
  "/", "/inbox", "/tasks", "/approvals", "/reports", "/service", "/executive",
  "/guardrails", "/events", "/exams", "/memory", "/night", "/models", "/skills",
  "/workspaces", "/customize", "/configuration", "/assembly", "/agents", "/members",
  "/partners", "/account",
]) {
  requireText(app, `path="${route}"`, `缺少可发现的语义路由：${route}`);
}
requireText(app, 'path="*" element={<NotFound />}', "未知 URL 未进入明确的页面不存在状态");
requireText(app, "paddingRight: bare ? 0 : railW", "页面宿主未统一为 AI 助手栏预留空间");
requireText(app, "!bare && <StarRing />", "登录/落地等独占流程不应被 AI 助手浮层遮挡");
if (existsSync(resolve(root, "apps/web/src/shell/NavBar.tsx"))) errors.push("旧顶部页面导航 NavBar 仍存在，可能形成双导航");

forbid(bridge, /<a\s+[^>]*href=/, "工作台顶栏仍含页面级导航链接");
forbid(bridge, /THREADS|CONTEXT/, "工作台壳仍向用户显示英文底层分区名");
requireText(bridge, 'role="separator"', "工作区左右面板缺少可键盘操作的缩放分隔条");
requireText(bridge, 'kind="drawer"', "工作区辅助面板在窄屏未降级为统一抽屉");
requireText(bridge, "workloom:workspace-panels", "工作区面板未接入显示、隐藏与恢复协议");
requireText(desktop, "响应式工作区", "桌面客户端仍缺少真实响应式工作区声明");
forbid(desktop, /setAspectRatio|applyFixedZoom/, "桌面客户端仍在锁定宽高比或强制整页缩放");

for (const path of [
  "apps/web/src/pages/p2/P2.tsx",
  "apps/web/src/pages/p3/P3.tsx",
  "apps/web/src/pages/p21/P21.tsx",
  "apps/web/src/pages/p22/P22.tsx",
]) {
  forbid(path, /JSON\.stringify\(/, `${path} 仍直接向业务界面输出 JSON`);
}
forbid("apps/web/src/pages/p4/P4.tsx", /\{r\.result\}/, "审批中心仍直接显示围栏判定底层值");
forbid("apps/web/src/pages/p7/P7.tsx", /\{a\.presetKey\}/, "装配中心仍直接显示岗位内部键");
forbid("apps/web/src/components/CommandCard.tsx", /\{target\.presetKey\}/, "指挥卡仍直接显示岗位内部键");
forbid("apps/web/src/components/star-ring/StarRing.tsx", /ASK\s*·|Ask\s*·|\{pathname\}/, "AI 助手仍显示英文产品标签或内部路由");
requireText("apps/web/src/components/RejectDialog.tsx", "<Overlay", "审批拒绝对话框未使用共享无障碍浮层");
requireText("apps/web/src/pages/p22/P22.tsx", "<Overlay", "服务前台详情抽屉未使用共享无障碍浮层");
forbid("apps/web/src/pages/p22/P22.tsx", /["`](?:[^"`]*(?:SERVICE DESK|GOVERNANCE|同一 COMMIT|approvals 审批台|registerSite \/ crawlNow \/ diffScan)[^"`]*)["`]/, "服务前台仍显示英文或底层实现字段");

if (errors.length > 0) {
  console.error(`❌ PC 壳层门禁失败（${errors.length} 项）`);
  for (const error of errors) console.error(`  · ${error}`);
  process.exit(1);
}

console.log("✅ PC 壳层门禁通过：左侧单一主导航、语义入口、响应式让位与中文显示边界均已接入");
