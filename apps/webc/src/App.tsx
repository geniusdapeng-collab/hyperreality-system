import { useState, type ReactNode } from "react";
import ChatPage from "./pages/ChatPage";
import ServicePage from "./pages/ServicePage";
import TicketsPage from "./pages/TicketsPage";
import MessagesPage from "./pages/MessagesPage";
import MePage from "./pages/MePage";

type Tab = "chat" | "service" | "tickets" | "messages" | "me";
type ServiceKind = "delivery" | "repair" | "complaint" | "other";

const TABS: { key: Tab; label: string; icon: (active: boolean) => ReactNode }[] = [
  {
    key: "chat",
    label: "对话",
    icon: (a) => (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={a ? 2.2 : 1.6}>
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    ),
  },
  {
    key: "service",
    label: "服务",
    icon: (a) => (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={a ? 2.2 : 1.6}>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    ),
  },
  {
    key: "tickets",
    label: "工单",
    icon: (a) => (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={a ? 2.2 : 1.6}>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <path d="M14 2v6h6M9 13h6M9 17h6" />
      </svg>
    ),
  },
  {
    key: "messages",
    label: "消息",
    icon: (a) => (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={a ? 2.2 : 1.6}>
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.7 21a2 2 0 0 1-3.4 0" />
      </svg>
    ),
  },
  {
    key: "me",
    label: "我的",
    icon: (a) => (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={a ? 2.2 : 1.6}>
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </svg>
    ),
  },
];

export default function App() {
  const [tab, setTab] = useState<Tab>(() => {
    const h = location.hash.replace("#", "");
    return (["chat", "service", "tickets", "messages", "me"] as const).includes(h as Tab)
      ? (h as Tab)
      : "chat";
  });
  const [servicePrefill, setServicePrefill] = useState<ServiceKind | null>(null);
  const [ticketRefresh, setTicketRefresh] = useState(0);

  const goService = (kind: ServiceKind) => {
    setServicePrefill(kind);
    setTab("service");
  };

  return (
    <div className="phone-shell">
      <main className="flex-1 overflow-hidden">
        {tab === "chat" && <ChatPage onGoService={goService} />}
        {tab === "service" && <ServicePage prefill={servicePrefill} />}
        {tab === "tickets" && <TicketsPage refreshKey={ticketRefresh} />}
        {tab === "messages" && <MessagesPage />}
        {tab === "me" && <MePage onGoChat={() => setTab("chat")} />}
      </main>
      <nav className="flex border-t border-line bg-bg900 pb-[max(0.25rem,env(safe-area-inset-bottom))] pt-1.5">
        {TABS.map((t) => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => {
                setTab(t.key);
                if (t.key === "tickets") setTicketRefresh((k) => k + 1);
                if (t.key !== "service") setServicePrefill(null);
              }}
              className={`flex flex-1 flex-col items-center gap-0.5 py-1 ${
                active ? "text-gold" : "text-ink3"
              }`}
            >
              {t.icon(active)}
              <span className="text-[10px]">{t.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
