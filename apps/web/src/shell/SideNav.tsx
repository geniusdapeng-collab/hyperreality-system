/** WorkLoom PC 左侧主导航：共享基座壳承载全部页面入口，本地仅编排状态与路由。 */
import {
  Icon,
  LayoutControls,
  NAVIGATION_GROUP_LABELS,
  SideNavigation as SharedSideNavigation,
  isNavigationActive,
  useManagedSurface,
  clientChineseText,
  type NavigationEntry,
  type TextScale,
} from "@workloom/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { sharedLayoutPixels } from "../lib/useAskRail";
import { useNavigationAccess } from "./NavigationAccess";

type NavMode = "expanded" | "collapsed" | "hidden";
const STORAGE_KEY = "workloom.pc.sidenav.mode";
const TEXT_SCALE_KEY = "workloom.pc.text-scale";
const FAVORITES_KEY = "workloom.pc.navigation.favorites";
const RECENT_KEY = "workloom.pc.navigation.recent";
const MOBILE_QUERY = "(max-width: 820px)";

function initialMode(): NavMode {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === "collapsed" || saved === "hidden" ? saved : "expanded";
  } catch {
    return "expanded";
  }
}

function rememberMode(mode: NavMode) {
  try { localStorage.setItem(STORAGE_KEY, mode); } catch { /* 本机偏好不可写时仍可使用 */ }
}

function initialTextScale(): TextScale {
  try {
    const value = Number(localStorage.getItem(TEXT_SCALE_KEY));
    return value === 125 || value === 150 || value === 175 || value === 200 ? value : 100;
  } catch {
    return 100;
  }
}

function emitWidth(width: number) {
  (window as unknown as { __sideNavW: number }).__sideNavW = width;
  document.documentElement.style.setProperty("--workloom-side-nav-width", `${width}px`);
  window.dispatchEvent(new CustomEvent("sidenav-width", { detail: { width } }));
}

function readIdList(key: string): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 20) : [];
  } catch {
    return [];
  }
}

function writeIdList(key: string, value: readonly string[]) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 当前会话仍可使用 */ }
}

export function SideNav({ entries: providedEntries }: { entries?: readonly NavigationEntry[] }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { entries: permittedEntries, identityKey } = useNavigationAccess();
  const entries = providedEntries ?? permittedEntries;
  const [mode, setMode] = useState<NavMode>(initialMode);
  const [mobile, setMobile] = useState(() => window.matchMedia(MOBILE_QUERY).matches);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [layoutOpen, setLayoutOpen] = useState(false);
  const [textScale, setTextScale] = useState<TextScale>(initialTextScale);
  const [fullscreen, setFullscreen] = useState(Boolean(document.fullscreenElement));
  const [query, setQuery] = useState("");
  const [favoriteIds, setFavoriteIds] = useState<string[]>([]);
  const [recentIds, setRecentIds] = useState<string[]>([]);
  const mobileTriggerRef = useRef<HTMLButtonElement | null>(null);
  const mobileSearchRef = useRef<HTMLInputElement | null>(null);
  const favoriteStorageKey = `${FAVORITES_KEY}:${identityKey}`;
  const recentStorageKey = `${RECENT_KEY}:${identityKey}`;
  const mobileSurface = useManagedSurface<HTMLDivElement>({
    open: mobile && mobileOpen,
    kind: "navigation-drawer",
    onDismiss: () => setMobileOpen(false),
    modal: true,
    initialFocusRef: mobileSearchRef,
    returnFocusRef: mobileTriggerRef,
  });

  const updateMode = (next: NavMode) => {
    setMode(next);
    rememberMode(next);
  };

  useEffect(() => {
    const media = window.matchMedia(MOBILE_QUERY);
    const onChange = () => {
      setMobile(media.matches);
      if (!media.matches) setMobileOpen(false);
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => { setMobileOpen(false); }, [pathname]);

  useEffect(() => {
    setFavoriteIds(readIdList(favoriteStorageKey));
    setRecentIds(readIdList(recentStorageKey));
  }, [favoriteStorageKey, recentStorageKey]);

  useEffect(() => {
    document.documentElement.style.fontSize = textScale === 100 ? "" : `${textScale}%`;
    try { localStorage.setItem(TEXT_SCALE_KEY, String(textScale)); } catch { /* 当前会话仍可放大 */ }
  }, [textScale]);

  useEffect(() => {
    const sync = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  useEffect(() => {
    const width = mobile || mode === "hidden"
      ? 0
      : sharedLayoutPixels(mode === "expanded" ? "--wl-sidebar-expanded" : "--wl-sidebar-compact");
    emitWidth(width);
  }, [mobile, mode]);

  useEffect(() => () => emitWidth(0), []);

  useEffect(() => {
    const reset = () => {
      setMode("expanded");
      rememberMode("expanded");
      setMobileOpen(false);
      setTextScale(100);
      setLayoutOpen(false);
      setQuery("");
      document.documentElement.style.fontSize = "";
      try { localStorage.removeItem(TEXT_SCALE_KEY); } catch { /* 当前会话已恢复 */ }
    };
    window.addEventListener("workloom:reset-layout", reset);
    return () => window.removeEventListener("workloom:reset-layout", reset);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable='true']")) return;
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.code === "Digit0") {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent("workloom:reset-layout"));
        return;
      }
      if (event.key === "F11") {
        event.preventDefault();
        if (document.fullscreenElement) void document.exitFullscreen();
        else void document.documentElement.requestFullscreen();
        return;
      }
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "b") return;
      event.preventDefault();
      if (mobile) {
        setMobileOpen((open) => !open);
      } else if (event.shiftKey) {
        updateMode(mode === "hidden" ? "expanded" : "hidden");
      } else {
        updateMode(mode === "collapsed" ? "expanded" : "collapsed");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mobile, mode]);

  const collapsed = !mobile && mode === "collapsed";
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const visibleEntries = useMemo(() => normalizedQuery
    ? entries.filter((entry) => `${entry.title} ${NAVIGATION_GROUP_LABELS[entry.group]}`.toLocaleLowerCase("zh-CN").includes(normalizedQuery))
    : entries, [entries, normalizedQuery]);
  const favorites = useMemo(() => favoriteIds
    .map((id) => entries.find((entry) => entry.capabilityId === id))
    .filter((entry): entry is NavigationEntry => Boolean(entry)), [entries, favoriteIds]);
  const recent = useMemo(() => recentIds
    .map((id) => entries.find((entry) => entry.capabilityId === id))
    .filter((entry): entry is NavigationEntry => entry !== undefined && !favoriteIds.includes(entry.capabilityId))
    .slice(0, 5), [entries, favoriteIds, recentIds]);

  const markRecent = (entry: NavigationEntry) => {
    setRecentIds((current) => {
      const next = [entry.capabilityId, ...current.filter((id) => id !== entry.capabilityId)].slice(0, 8);
      writeIdList(recentStorageKey, next);
      return next;
    });
  };
  const toggleFavorite = (entry: NavigationEntry) => {
    setFavoriteIds((current) => {
      const next = current.includes(entry.capabilityId)
        ? current.filter((id) => id !== entry.capabilityId)
        : [...current, entry.capabilityId];
      writeIdList(favoriteStorageKey, next);
      return next;
    });
  };
  const openEntry = (entry: NavigationEntry) => {
    markRecent(entry);
    navigate(entry.route);
    if (mobile) setMobileOpen(false);
  };

  const showAllPanels = () => {
    updateMode("expanded");
    setMobileOpen(false);
    window.dispatchEvent(new CustomEvent("workloom:assistant-visibility", { detail: "show" }));
    window.dispatchEvent(new CustomEvent("workloom:loommate-visibility", { detail: "show" }));
    window.dispatchEvent(new CustomEvent("workloom:workspace-panels", { detail: "show" }));
  };
  const focusLayout = () => {
    updateMode("collapsed");
    window.dispatchEvent(new CustomEvent("workloom:assistant-visibility", { detail: "hide" }));
    window.dispatchEvent(new CustomEvent("workloom:loommate-visibility", { detail: "hide" }));
    window.dispatchEvent(new CustomEvent("workloom:workspace-panels", { detail: "hide" }));
  };
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen();
  };

  const renderShortcut = (entry: NavigationEntry) => {
    const active = isNavigationActive(entry, pathname);
    const title = clientChineseText(entry.title, "未命名页面");
    return (
      <button
        key={entry.capabilityId}
        type="button"
        onClick={() => openEntry(entry)}
        aria-current={active ? "page" : undefined}
        className={`flex min-h-9 min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 text-left text-body ${active ? "bg-card font-semibold text-gold" : "text-ink2 hover:bg-card/60 hover:text-ink"}`}
      >
        <Icon name={entry.icon} size={15} className="shrink-0" />
        <span className="min-w-0 break-words">{title}</span>
      </button>
    );
  };

  if ((mobile && !mobileOpen) || (!mobile && mode === "hidden")) {
    return (
      <button
        ref={mobile ? mobileTriggerRef : undefined}
        type="button"
        onClick={() => mobile ? setMobileOpen(true) : updateMode("expanded")}
        className="fixed left-0 top-1/2 flex -translate-y-1/2 items-center gap-1 rounded-r-xl border border-l-0 border-gline bg-bg900/95 px-2 py-3 text-body font-semibold text-gold shadow-xl backdrop-blur-md"
        style={{ zIndex: "var(--wl-z-nav)" }}
        aria-label="展开主导航"
        title="展开主导航"
      >
        <Icon name="menu" size={16} />
        <span className="[writing-mode:vertical-rl]">主导航</span>
      </button>
    );
  }

  const nav = (
    <SharedSideNavigation
      entries={visibleEntries}
      activeRoute={pathname}
      onNavigate={openEntry}
      collapsed={collapsed}
      expandAllGroups={normalizedQuery.length > 0}
      onCollapsedChange={mobile ? undefined : (next) => updateMode(next ? "collapsed" : "expanded")}
      className={`${mobile ? "relative h-dvh shadow-2xl" : "sticky top-0 h-screen shrink-0"} bg-bg950/97 backdrop-blur-md`}
      header={(
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="inline-block h-4 w-4 shrink-0 rotate-45 rounded gold-grad shadow-[0_0_14px_rgba(255,160,60,.6)]" />
          <div className="min-w-0 flex-1 leading-tight">
            <div className="bg-gradient-to-r from-gold to-gold2 bg-clip-text text-[14px] font-black tracking-wider text-transparent">WorkLoom</div>
            <div className="break-words text-body text-ink3">企业数字员工即时协作</div>
          </div>
          {mobile && (
            <button type="button" onClick={() => setMobileOpen(false)} className="min-h-9 min-w-9 rounded p-1 text-ink2 hover:bg-card" aria-label="关闭主导航" title="关闭主导航">
              <Icon name="close" size={16} />
            </button>
          )}
        </div>
      )}
      beforeGroups={(
        <>
          <label className="relative block min-w-0">
            <span className="sr-only">搜索主导航</span>
            <Icon name="search" size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink3" />
            <input
              ref={mobile ? mobileSearchRef : undefined}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索页面"
              className="min-h-9 w-full rounded-lg border border-line bg-bg900 py-2 pl-8 pr-2 text-body text-ink placeholder:text-ink3"
            />
          </label>
          {!normalizedQuery && favorites.length > 0 && (
            <section className="grid min-w-0 gap-1" aria-label="收藏页面">
              <div className="flex items-center gap-1.5 px-2 text-body font-semibold text-ink3"><Icon name="star" size={13} />收藏</div>
              {favorites.map(renderShortcut)}
            </section>
          )}
          {!normalizedQuery && recent.length > 0 && (
            <section className="grid min-w-0 gap-1" aria-label="最近使用页面">
              <div className="flex items-center gap-1.5 px-2 text-body font-semibold text-ink3"><Icon name="history" size={13} />最近使用</div>
              {recent.map(renderShortcut)}
            </section>
          )}
          {normalizedQuery && visibleEntries.length === 0 && <p className="px-2 py-6 text-center text-body text-ink3">没有找到匹配页面</p>}
        </>
      )}
      renderItemAction={(entry) => {
        const favorite = favoriteIds.includes(entry.capabilityId);
        const title = clientChineseText(entry.title, "未命名页面");
        return (
          <button
            type="button"
            onClick={() => toggleFavorite(entry)}
            className={`flex min-h-9 min-w-9 items-center justify-center rounded-md ${favorite ? "text-gold" : "text-ink3 hover:text-gold"}`}
            aria-label={favorite ? `取消收藏${title}` : `收藏${title}`}
            aria-pressed={favorite}
            title={favorite ? "取消收藏" : "收藏"}
          >
            <Icon name="star" size={14} />
          </button>
        );
      }}
      footer={(
        <div className={`${collapsed ? "flex flex-col" : "grid grid-cols-2"} gap-1.5`}>
          {!mobile && (
            <button type="button" onClick={() => updateMode("hidden")} className="min-h-9 rounded border border-line px-2 py-1 text-body text-ink2 hover:border-gline hover:text-gold" aria-label="隐藏主导航" title="隐藏主导航（⌘/Ctrl+Shift+B）">
              {collapsed ? "×" : "隐藏"}
            </button>
          )}
          <button type="button" onClick={() => window.dispatchEvent(new CustomEvent("workloom:reset-layout"))} className="flex min-h-9 items-center justify-center gap-1 rounded border border-line px-2 py-1 text-body text-ink2 hover:border-gline hover:text-gold" aria-label="恢复默认布局" title="恢复默认布局">
            <Icon name="reset" size={13} />{!collapsed && "恢复默认"}
          </button>
          <button type="button" onClick={() => setLayoutOpen(true)} className="flex min-h-9 items-center justify-center gap-1 rounded border border-line px-2 py-1 text-body text-ink2 hover:border-gline hover:text-gold" aria-label="打开视图与布局" title="视图与布局">
            <Icon name="configuration" size={13} />{!collapsed && "视图"}
          </button>
        </div>
      )}
    />
  );

  return (
    <>
      {mobile ? (
        <div
          {...mobileSurface}
          role="dialog"
          aria-modal="true"
          aria-label="主导航"
          className="fixed inset-0"
          style={{ zIndex: "var(--wl-z-drawer)" }}
        >
          <button type="button" tabIndex={-1} aria-label="关闭主导航" className="absolute inset-0 cursor-default bg-black/55" onClick={() => setMobileOpen(false)} />
          <div className="relative h-full w-fit max-w-full">{nav}</div>
        </div>
      ) : nav}
      <LayoutControls
        open={layoutOpen}
        onClose={() => setLayoutOpen(false)}
        textScale={textScale}
        onTextScale={setTextScale}
        fullscreen={fullscreen}
        onToggleFullscreen={toggleFullscreen}
        onShowAll={showAllPanels}
        onFocusMode={focusLayout}
        onReset={() => window.dispatchEvent(new CustomEvent("workloom:reset-layout"))}
      />
    </>
  );
}
