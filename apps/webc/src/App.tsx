import { useEffect, useRef, useState, type ReactNode } from "react";
import ChatPage from "./pages/ChatPage";
import ServicePage from "./pages/ServicePage";
import TicketsPage from "./pages/TicketsPage";
import MessagesPage from "./pages/MessagesPage";
import MePage from "./pages/MePage";
import { getConfig, type TabKey } from "./lib/config";
import { api } from "./lib/api";
import { resetPrefetch, startPrefetch } from "./lib/prefetch";
import { useOnline, useViewportHeight } from "./lib/hooks";

const TAB_ICONS: Record<TabKey, (active: boolean) => ReactNode> = {
  chat: (a) => (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={a ? 2.2 : 1.6}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  ),
  service: (a) => (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={a ? 2.2 : 1.6}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
  tickets: (a) => (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={a ? 2.2 : 1.6}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6M9 13h6M9 17h6" />
    </svg>
  ),
  messages: (a) => (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={a ? 2.2 : 1.6}>
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </svg>
  ),
  me: (a) => (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={a ? 2.2 : 1.6}>
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  ),
};

const TAB_LABELS: Record<TabKey, string> = {
  chat: "对话",
  service: "服务",
  tickets: "工单",
  messages: "消息",
  me: "我的",
};

export default function App() {
  const cfg = getConfig();
  const enabledTabs = cfg.enableTabs;
  useViewportHeight();
  const online = useOnline();
  const wasOffline = useRef(false);
  const [reconnected, setReconnected] = useState(false);

  const [tab, setTab] = useState<TabKey>(() => {
    const h = location.hash.replace("#", "") as TabKey;
    return enabledTabs.includes(h) ? h : (enabledTabs[0] ?? "chat");
  });
  const [servicePrefill, setServicePrefill] = useState<string | null>(null);
  const [ticketRefresh, setTicketRefresh] = useState(0);
  const [unread, setUnread] = useState(0);

  // 首屏并行预取（session+orders+member）
  useEffect(() => {
    void startPrefetch();
  }, []);

  // 未读通知红点：严格按 read 字段统计，30s 轮询
  useEffect(() => {
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
  }, [online]);

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
    setTab("service");
  };

  return (
    <div className="phone-shell">
      {/* 网络状态横幅 */}
      {!online && (
        <div className="flex items-center justify-center gap-1.5 bg-alert/90 py-1.5 text-[11px] font-medium text-white">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <path d="M12 9v4M12 17h.01" />
          </svg>
          网络已断开，恢复后将自动重连
        </div>
      )}
      {online && reconnected && (
        <div className="flex items-center justify-center gap-1.5 bg-go/90 py-1.5 text-[11px] font-medium text-bg900">
          网络已恢复
        </div>
      )}

      <main className="flex-1 overflow-hidden">
        <div key={tab} className="h-full animate-tabin">
          {tab === "chat" && <ChatPage onGoService={goService} />}
          {tab === "service" && <ServicePage prefill={servicePrefill} />}
          {tab === "tickets" && <TicketsPage refreshKey={ticketRefresh} />}
          {tab === "messages" && <MessagesPage />}
          {tab === "me" && <MePage onGoChat={() => setTab("chat")} />}
        </div>
      </main>

      <nav className="flex border-t border-line bg-bg900 pb-[max(0.25rem,env(safe-area-inset-bottom))] pt-1.5">
        {enabledTabs.map((key) => {
          const active = tab === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => {
                setTab(key);
                if (key === "tickets") setTicketRefresh((k) => k + 1);
                if (key !== "service") setServicePrefill(null);
              }}
              className={`pressable relative flex flex-1 flex-col items-center gap-0.5 py-1 ${
                active ? "text-gold" : "text-ink3"
              }`}
            >
              <span className="relative">
                {TAB_ICONS[key](active)}
                {key === "messages" && unread > 0 && (
                  <span className="absolute -right-1.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-alert px-0.5 text-[8.5px] font-semibold leading-none text-white">
                    {unread > 99 ? "99+" : unread}
                  </span>
                )}
              </span>
              <span className="text-[10px]">{TAB_LABELS[key]}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
