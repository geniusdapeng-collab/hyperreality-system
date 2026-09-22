import { Route, Routes, Navigate, Link, useLocation, useParams } from "react-router";
import { AsyncState } from "@workloom/ui";
import { isGuest } from "./lib/trpc";
import P1 from "./pages/p1/P1";
import P2 from "./pages/p2/P2";
import P9 from "./pages/p9/P9";
import P21 from "./pages/p21/P21";
import P22 from "./pages/p22/P22";
import P0 from "./pages/p0/P0";
import P3 from "./pages/p3/P3";
import P4 from "./pages/p4/P4";
import P5 from "./pages/p5/P5";
import P6 from "./pages/p6/P6";
import P7 from "./pages/p7/P7";
import P8 from "./pages/p8/P8";
import P23 from "./pages/p23/P23";
import P24 from "./pages/p24/P24";
import P26 from "./pages/p26/P26";
import P27 from "./pages/p27/P27";
import P28 from "./pages/p28/P28";
import P29 from "./pages/p29/P29";
import P30 from "./pages/p30/P30";
import P31 from "./pages/p31/P31";
import Login from "./pages/accounts/Login";
import Activate from "./pages/accounts/Activate";
import InviteAccept from "./pages/accounts/InviteAccept";
import DevMatrix from "./pages/dev/DevMatrix";
import Onboarding from "./pages/onboarding/Onboarding";
import { Bridge } from "./shell/Bridge";
import { SideNav } from "./shell/SideNav";
import { StarRing } from "./components/star-ring/StarRing";
import { LoomMate } from "./components/loommate/LoomMate";
import { useEffect, useState } from "react";
import Observability from "./pages/observability/Observability";
import { useAskRailPadding } from "./lib/useAskRail";
import Workspaces from "./pages/accounts/Workspaces";
import {
  NavigationAccessBoundary,
  NavigationAccessProvider,
} from "./shell/NavigationAccess";
import {
  INDUSTRY_ROUTE_REGISTRY,
  IndustryLegacyRedirect,
  IndustryRouteBoundary,
  IndustryRouteLoadFailure,
} from "./shell/IndustryRoutes";

function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4" aria-label="页面不存在">
      <AsyncState
        status="empty"
        title="页面不存在"
        description="这个地址可能已失效、输入有误，或对应能力尚未安装。"
        action={<Link to="/" className="wl-button wl-button--secondary">返回经营首页</Link>}
      />
    </main>
  );
}

function LegacyTaskRedirect() {
  const { threadId = "" } = useParams();
  return <Navigate to={`/tasks/${encodeURIComponent(threadId)}`} replace />;
}

function LegacyAgentRedirect() {
  const { agentId = "" } = useParams();
  return <Navigate to={`/agents/${encodeURIComponent(agentId)}`} replace />;
}

/** 开发组件矩阵只在显式开启的本地开发环境可达，生产构建永远关闭。 */
function UiDiagnosticsRoute() {
  const enabled = import.meta.env.DEV && import.meta.env.VITE_ENABLE_UI_DIAGNOSTICS === "true";
  // 返回出口由 DevMatrix 自身提供（/dev 是 bare 路由，无常驻导航）。
  return enabled ? <Bridge><DevMatrix /></Bridge> : <NotFound />;
}

/** 阶段三路由：页面自包 Bridge（注入真实左右栏）；/dev 矩阵保持壳内平铺 */
function Shell() {
  const { pathname } = useLocation();
  const railW = useAskRailPadding();
  const [welcomeActive, setWelcomeActive] = useState(false);
  useEffect(() => {
    const onWelcome = (event: Event) => setWelcomeActive(Boolean((event as CustomEvent<boolean>).detail));
    window.addEventListener("workloom:welcome", onWelcome);
    return () => window.removeEventListener("workloom:welcome", onWelcome);
  }, []);
  // 非产品路由（开发矩阵/落地向导）不带常驻导航；其余全部页面左侧导航常驻
  const bare = pathname === "/dev" || pathname.startsWith("/onboarding") || pathname === "/login" || pathname === "/activate" || pathname === "/invite";
  return (
    <div data-workloom-client="b-pc" data-wl-theme="dark" className="flex min-h-screen min-w-0 max-w-full overflow-x-clip">
      {/* 无导航壳页面（/dev、/login、/activate、/invite…）必须有明确出口：
          这类页面此前只能靠浏览器后退，客户会“进得去出不来”。 */}
      {bare && pathname !== "/" && (
        <a
          href="/"
          aria-label="返回经营主页"
          className="fixed left-3 top-3 z-50 rounded border border-line bg-panel/90 px-2.5 py-1 text-body text-ink3 no-underline backdrop-blur hover:border-gline hover:text-ink"
        >
          ← 返回经营主页
        </a>
      )}
      {!bare && <SideNav />}
      {/* Live2D 插件的 WebGL 资源与多 canvas 共存不稳定；首装舞台独占唯一数字人实例。 */}
      {!bare && !welcomeActive && <LoomMate />}
      <div
        className="wl-page-host min-w-0 flex-1"
        style={{ paddingRight: bare ? 0 : railW }}
      >
        {!bare && <StarRing />}
        <NavigationAccessBoundary pathname={pathname}>
          <Routes>
      <Route path="/" element={<P0 />} />
      <Route path="/p1" element={<Navigate to="/tasks" replace />} />
      <Route path="/p2/:threadId" element={<LegacyTaskRedirect />} />
      <Route path="/p9" element={<Navigate to="/night" replace />} />
      <Route path="/p21" element={<Navigate to="/executive" replace />} />
      <Route path="/p22" element={<Navigate to="/service" replace />} />
      <Route path="/p3" element={<Navigate to="/reports" replace />} />
      <Route path="/p4" element={<Navigate to="/approvals" replace />} />
      <Route path="/p5" element={<Navigate to="/guardrails" replace />} />
      <Route path="/p6" element={<Navigate to="/skills" replace />} />
      <Route path="/p6/create" element={<Navigate to="/skills/create" replace />} />
      <Route path="/p7" element={<Navigate to="/assembly" replace />} />
      <Route path="/p8" element={<Navigate to="/agents" replace />} />
      <Route path="/p8/agent/:agentId" element={<LegacyAgentRedirect />} />
      <Route path="/p23" element={<Navigate to="/memory" replace />} />
      <Route path="/p24" element={<Navigate to="/exams" replace />} />
      <Route path="/p26" element={<Navigate to="/customize" replace />} />
      <Route path="/p27" element={<Navigate to="/configuration" replace />} />
      <Route path="/p28" element={<Navigate to="/inbox" replace />} />
      <Route path="/p29" element={<Navigate to="/account" replace />} />
      <Route path="/p30" element={<Navigate to="/members" replace />} />
      <Route path="/p31" element={<Navigate to="/partners" replace />} />
      <Route path="/p0" element={<Navigate to="/" replace />} />
      <Route path="/inbox" element={<P28 />} />
      <Route path="/tasks" element={<P1 />} />
      <Route path="/tasks/:threadId" element={<P2 />} />
      <Route path="/approvals" element={<P4 />} />
      <Route path="/reports" element={<P3 />} />
      <Route path="/service" element={<P22 />} />
      <Route path="/executive" element={<P21 />} />
      <Route path="/guardrails" element={<P5 />} />
      <Route path="/exams" element={<P24 />} />
      <Route path="/memory" element={<P23 />} />
      <Route path="/night" element={<P9 />} />
      <Route path="/skills" element={<P6 />} />
      <Route path="/skills/create" element={<P6 />} />
      <Route path="/members" element={<P30 />} />
      <Route path="/partners" element={<P31 />} />
      <Route path="/account" element={<P29 />} />
      <Route path="/workspaces" element={<Workspaces />} />
      <Route path="/customize" element={<P26 />} />
      <Route path="/configuration" element={<P27 />} />
      <Route path="/assembly" element={<P7 />} />
      <Route path="/agents" element={<P8 />} />
      <Route path="/agents/:agentId" element={<P8 />} />
      <Route path="/events" element={<Observability view="events" />} />
      <Route path="/event-ledger" element={<Navigate to="/events" replace />} />
      <Route path="/models" element={<Observability view="models" />} />
      <Route path="/model-routing" element={<Navigate to="/models" replace />} />
      <Route path="/login" element={<Login />} />
      <Route path="/activate" element={<Activate />} />
      <Route path="/invite" element={<InviteAccept />} />
      <Route path="/onboarding" element={
        // F-GUEST1：游客可完整体验系统，进入配置引导（正式开通）才要求登录
        isGuest() ? <Navigate to="/login?next=/onboarding" replace /> : <Onboarding />
      } />
      <Route path="/dev" element={<UiDiagnosticsRoute />} />
            {INDUSTRY_ROUTE_REGISTRY.routes.map((definition) => (
              <Route
                key={definition.path}
                path={definition.path}
                element={
                  <IndustryRouteBoundary definition={definition}>
                    {definition.element}
                  </IndustryRouteBoundary>
                }
              />
            ))}
            {INDUSTRY_ROUTE_REGISTRY.routes.flatMap((definition) => (
              (definition.legacyPaths ?? []).map((legacyPath) => (
                <Route
                  key={legacyPath}
                  path={legacyPath}
                  element={
                    <IndustryRouteBoundary definition={definition}>
                      <IndustryLegacyRedirect definition={definition} />
                    </IndustryRouteBoundary>
                  }
                />
              ))
            ))}
            <Route path="*" element={INDUSTRY_ROUTE_REGISTRY.error ? <IndustryRouteLoadFailure /> : <NotFound />} />
          </Routes>
        </NavigationAccessBoundary>
      </div>
      {/* 游客模式浮标（F-GUEST1：随时可去正式开通/登录） */}
      {!bare && isGuest() && (
        <a
          href="/login"
          className="fixed bottom-5 z-50 rounded-full border border-amber-500/40 bg-neutral-900/95 px-4 py-2 text-sm text-amber-300 shadow-lg hover:border-amber-400"
          style={{ right: "calc(var(--workloom-ask-rail-width, var(--wl-assistant-expanded)) + var(--wl-space-4))" }}
        >
          游客体验中 · <span className="font-semibold underline">正式开通 →</span>
        </a>
      )}
    </div>
  );
}

export default function App() {
  return <NavigationAccessProvider><Shell /></NavigationAccessProvider>;
}
