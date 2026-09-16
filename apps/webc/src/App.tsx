import { AppShell, BottomTabs, Icon } from "@workloom/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import ChatPage from "./pages/ChatPage";
import ServicePage from "./pages/ServicePage";
import TicketsPage from "./pages/TicketsPage";
import MessagesPage from "./pages/MessagesPage";
import MePage from "./pages/MePage";
import { getConfig, getConfigState, type TabKey } from "./lib/config";
import { api } from "./lib/api";
import { resetPrefetch, startPrefetch } from "./lib/prefetch";
import { useOnline, useViewportHeight } from "./lib/hooks";
import { cBottomTabItems, tabFromHash, tabUrl } from "./lib/navigation";

export default function App() {
  const cfg = getConfig();
  const configState = getConfigState();
  const enabledTabs = cfg.enableTabs;
  useViewportHeight();
  const online = useOnline();
  const wasOffline = useRef(false);
  const [reconnected, setReconnected] = useState(false);

  const [tab, setTab] = useState<TabKey>(() => {
    return tabFromHash(location.hash, enabledTabs);
  });
  const [servicePrefill, setServicePrefill] = useState<string | null>(null);
  const [ticketRefresh, setTicketRefresh] = useState(0);
  const [unread, setUnread] = useState(0);

  const selectTab = useCallback((next: TabKey, replace = false) => {
    if (!enabledTabs.includes(next)) return;
    const nextUrl = tabUrl(location.pathname, location.search, next);
    if (location.hash !== `#${next}`) {
      if (replace) history.replaceState(history.state, "", nextUrl);
      else history.pushState(history.state, "", nextUrl);
    }
    setTab(next);
  }, [enabledTabs]);

  useEffect(() => {
    if (!enabledTabs.includes(location.hash.replace("#", "") as TabKey)) selectTab(tab, true);
    const syncFromHistory = () => {
      setTab(tabFromHash(location.hash, enabledTabs));
    };
    window.addEventListener("hashchange", syncFromHistory);
    window.addEventListener("popstate", syncFromHistory);
    return () => {
      window.removeEventListener("hashchange", syncFromHistory);
      window.removeEventListener("popstate", syncFromHistory);
    };
  }, [enabledTabs, selectTab, tab]);

  // 首屏并行预取（session+orders+member）
  useEffect(() => {
    if (!configState.ready) return;
    void startPrefetch();
  }, [configState.ready]);

  // 未读通知红点：严格按 read 字段统计，30s 轮询
  useEffect(() => {
    if (!configState.ready) return;
    let stop = false;
    const load = () =>
      api
        .notifications()
        .then((r) => {
          if (!stop) setUnread(r.notifications.filter((n) => !n.read).length);
        })
        .catch(() => {});
    load();
    const timer = setInterval(load, 30_000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [configState.ready, online]);

  // 断网恢复：横幅提示 + 自动重连（重建会话 & 重新预取）
  useEffect(() => {
    if (!online) {
      wasOffline.current = true;
      return;
    }
    if (wasOffline.current) {
      wasOffline.current = false;
      resetPrefetch();
      void startPrefetch();
      setReconnected(true);
      const t = setTimeout(() => setReconnected(false), 2500);
      return () => clearTimeout(t);
    }
  }, [online]);

  const goService = (kind: string) => {
    setServicePrefill(kind);
    selectTab("service");
  };

  const shellNotices = !online || reconnected || !configState.ready;

  return (
    <AppShell
      className="phone-shell"
      data-workloom-client="c-mobile"
      navigationMode="bottom"
      mainLabel="AI 服务前台"
      topBar={shellNotices ? <div>
        {!online && (
          <div className="flex items-center justify-center gap-1.5 bg-alert/90 py-1.5 text-body font-medium text-white" role="status">
            <Icon name="warning" size={14} />
            网络已断开，恢复后将自动重连
          </div>
        )}
        {online && reconnected && (
          <div className="flex items-center justify-center gap-1.5 bg-go/90 py-1.5 text-body font-medium text-bg900" role="status">
            网络已恢复
          </div>
        )}
        {!configState.ready && (
          <div role="alert" className="break-words border-b border-warn/40 bg-warn/10 px-3 py-2 text-center text-body leading-relaxed text-warn">
            服务配置异常，当前处于安全模式；新增服务入口已关闭。{configState.message ? ` ${configState.message}` : ""}
          </div>
        )}
      </div> : undefined}
      bottomTabs={<BottomTabs
        className="service-bottom-tabs"
        label="服务前台主导航"
        items={cBottomTabItems(enabledTabs, unread)}
        activeId={tab}
        onSelect={(item) => {
          const next = enabledTabs.find((key) => key === item.id);
          if (!next) return;
          selectTab(next);
          if (next === "tickets") setTicketRefresh((key) => key + 1);
          if (next !== "service") setServicePrefill(null);
        }}
      />}
    >
      <div key={tab} className="h-full min-h-0 animate-tabin">
        {tab === "chat" && <ChatPage onGoService={goService} />}
        {tab === "service" && <ServicePage prefill={servicePrefill} />}
        {tab === "tickets" && <TicketsPage refreshKey={ticketRefresh} />}
        {tab === "messages" && <MessagesPage />}
        {tab === "me" && <MePage onGoChat={() => selectTab("chat")} />}
      </div>
    </AppShell>
  );
}
