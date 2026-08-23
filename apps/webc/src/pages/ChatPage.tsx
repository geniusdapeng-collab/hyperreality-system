import { useEffect, useRef, useState } from "react";
import { api, ensureSession } from "../lib/api";
import { demoChatAnswer } from "../lib/demo";
import type { BusinessCard, Citation, MemberInfo, Order } from "../lib/types";
import { CitationCard, CatalogCard, MemberCard, OrderCard, TicketNoticeCard } from "../components/cards";
import { DemoBadge } from "../components/common";

interface Msg {
  id: string;
  role: "user" | "ai";
  text: string;
  shown: number; // 打字机已显示字符数（user 消息直接 = text.length）
  citations?: Citation[];
  cards?: BusinessCard[];
  lowConfidence?: boolean;
  ticketTitle?: string;
  demo?: boolean;
}

let seq = 0;
const nextId = () => `m${++seq}`;

const QUICK_CHIPS = ["查订单", "送物服务", "维修报修", "常见问题"] as const;

export default function ChatPage({
  onGoService,
}: {
  onGoService: (kind: "delivery" | "repair") => void;
}) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [demoMode, setDemoMode] = useState(false);
  const [conversationId, setConversationId] = useState<string | undefined>();
  const scrollRef = useRef<HTMLDivElement>(null);

  // 首进自动建会话
  useEffect(() => {
    void ensureSession().then((s) => {
      if (!s) setDemoMode(true);
    });
    setMsgs([
      {
        id: nextId(),
        role: "ai",
        text: "您好，欢迎来到星芒好物。我是 AI 服务前台小芒，可以帮您查订单、查物流、办售后，也可以解答商品与服务问题。",
        shown: 0,
      },
    ]);
  }, []);

  // 打字机效果：后端非 SSE 时模拟流式
  useEffect(() => {
    const timer = setInterval(() => {
      setMsgs((prev) => {
        const target = prev.find((m) => m.role === "ai" && m.shown < m.text.length);
        if (!target) return prev;
        return prev.map((m) =>
          m.id === target.id ? { ...m, shown: Math.min(m.text.length, m.shown + 3) } : m,
        );
      });
    }, 24);
    return () => clearInterval(timer);
  }, []);

  // 新消息滚到底
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs]);

  const appendAi = (partial: Omit<Msg, "id" | "role" | "shown">) => {
    setMsgs((prev) => [...prev, { ...partial, id: nextId(), role: "ai", shown: 0 }]);
  };

  const send = async (raw?: string) => {
    const text = (raw ?? input).trim();
    if (!text || sending) return;
    setInput("");
    setSending(true);
    setMsgs((prev) => [...prev, { id: nextId(), role: "user", text, shown: text.length }]);
    try {
      const res = await api.chat({ conversationId, text });
      setConversationId(res.conversationId);
      appendAi({
        text: res.answer,
        citations: res.citations,
        cards: res.cards,
        lowConfidence: res.confidence < 0.5 || Boolean(res.ticket),
        ticketTitle: res.ticket
          ? `工单 ${res.ticket.id}「${res.ticket.title}」已受理`
          : res.ticketDraft
            ? `已为您准备工单草稿：${res.ticketDraft.title}（可在下方「转工单」提交）`
            : undefined,
        demo: Boolean(res.mock),
      });
    } catch {
      setDemoMode(true);
      const d = demoChatAnswer(text);
      appendAi({
        text: d.answer,
        citations: d.citations,
        cards: d.cards,
        lowConfidence: d.confidence < 0.5,
        demo: true,
      });
    } finally {
      setSending(false);
    }
  };

  const escalate = async (kind: "other") => {
    const title = "转人工：宾客请求专人跟进";
    try {
      const t = await api.createTicket({ kind, title, payload: { source: "chat" } });
      appendAi({
        text: `已为您创建工单 ${t.id}，服务专员会尽快与您联系。您也可以在「工单」页查看进度。`,
        ticketTitle: `工单 ${t.id} 已受理`,
      });
    } catch {
      setDemoMode(true);
      appendAi({
        text: "已为您转专人处理（演示），服务专员会尽快与您联系。",
        ticketTitle: "工单 TK-DEMO-001 已受理（演示）",
        demo: true,
      });
    }
  };

  const onChip = (chip: (typeof QUICK_CHIPS)[number]) => {
    if (chip === "送物服务") return onGoService("delivery");
    if (chip === "维修报修") return onGoService("repair");
    if (chip === "查订单") return void send("帮我查一下我的订单");
    return void send("早餐几点开始？停车和退房怎么安排？");
  };

  return (
    <div className="flex h-full flex-col">
      {/* 欢迎卡 */}
      <div className="border-b border-line bg-gradient-to-b from-bg700/60 to-bg800 px-4 pb-3 pt-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-[17px] font-semibold text-ink">
              星芒好物 <span className="text-gold">· AI 服务前台</span>
            </h1>
            <p className="mt-1 flex items-center gap-1.5 text-[11px] text-ink2">
              <span className="h-1.5 w-1.5 rounded-full bg-go" />
              小芒在线 · 平均 1 分钟响应 {demoMode && <DemoBadge />}
            </p>
          </div>
          <div className="flex h-10 w-10 items-center justify-center rounded-full border border-gline bg-gold/10 font-orb text-[15px] text-gold">
            栖
          </div>
        </div>
        {/* 快捷入口 */}
        <div className="no-scrollbar mt-3 flex gap-2 overflow-x-auto">
          {QUICK_CHIPS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => onChip(c)}
              className="shrink-0 rounded-full border border-gline bg-card px-3 py-1.5 text-[12px] text-goldhi active:bg-gold/20"
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      {/* 聊天流 */}
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {msgs.map((m) => {
          const shownText = m.text.slice(0, m.shown);
          const done = m.shown >= m.text.length;
          if (m.role === "user") {
            return (
              <div key={m.id} className="flex justify-end">
                <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-gold px-3.5 py-2.5 text-[13.5px] leading-relaxed text-ongold">
                  {m.text}
                </div>
              </div>
            );
          }
          return (
            <div key={m.id} className="flex items-start gap-2">
              <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-gline bg-gold/10 text-[11px] text-gold">
                栖
              </div>
              <div className="max-w-[82%]">
                <div className="rounded-2xl rounded-tl-sm border border-line bg-card px-3.5 py-2.5 text-[13.5px] leading-relaxed text-ink">
                  {shownText}
                  {!done && <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-gold align-middle" />}
                  {m.demo && done && (
                    <span className="ml-2 align-middle">
                      <DemoBadge />
                    </span>
                  )}
                </div>
                {done && m.citations && <CitationCard citations={m.citations} />}
                {done &&
                  m.cards?.map((c, i) =>
                    c.kind === "order" ? (
                      <OrderCard key={`o-${i}`} order={c.data as unknown as Order} />
                    ) : c.kind === "member" ? (
                      <MemberCard key={`m-${i}`} member={c.data as unknown as MemberInfo} />
                    ) : c.kind === "catalog" ? (
                      <CatalogCard
                        key={`c-${i}`}
                        items={((c.data as { items?: Array<{ sku?: string; name: string; priceYuan?: number }> }).items) ?? []}
                      />
                    ) : null,
                  )}
                {done && m.ticketTitle && <TicketNoticeCard title={m.ticketTitle} />}
                {done && m.lowConfidence && !m.ticketTitle && (
                  <TicketNoticeCard title="该问题已记录并转交服务专员跟进。" />
                )}
                {done && (
                  <div className="mt-1.5 flex gap-2 text-[11px]">
                    <button
                      type="button"
                      onClick={() => void escalate("other")}
                      className="rounded-full border border-line px-2.5 py-1 text-ink2 active:bg-bg700"
                    >
                      没解决？转工单
                    </button>
                    <button
                      type="button"
                      onClick={() => void escalate("other")}
                      className="rounded-full border border-line px-2.5 py-1 text-ink2 active:bg-bg700"
                    >
                      转人工
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
        {sending && (
          <div className="flex items-center gap-2 pl-9 text-[11px] text-ink3">
            <span className="flex gap-1">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="h-1.5 w-1.5 animate-typing rounded-full bg-gold"
                  style={{ animationDelay: `${i * 0.2}s` }}
                />
              ))}
            </span>
            小芒正在思考…
          </div>
        )}
      </div>

      {/* 输入栏 */}
      <div className="border-t border-line bg-bg800 px-3 py-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))]">
        <div className="flex items-center gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void send();
            }}
            placeholder="请输入您的需求…"
            className="h-10 flex-1 rounded-full border border-line bg-bg900 px-4 text-[13.5px] text-ink outline-none placeholder:text-ink3 focus:border-gline"
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={sending || !input.trim()}
            className="h-10 shrink-0 rounded-full bg-gold px-4 text-[13px] font-medium text-ongold disabled:opacity-40"
          >
            发送
          </button>
        </div>
      </div>
    </div>
  );
}
