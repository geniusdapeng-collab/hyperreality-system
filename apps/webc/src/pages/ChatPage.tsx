import { useEffect, useRef, useState } from "react";
import { api, ensureSession } from "../lib/api";
import { getConfig, tpl } from "../lib/config";
import { demoChatAnswer } from "../lib/demo";
import type { BusinessCard, Citation, MemberInfo, Order } from "../lib/types";
import { CitationCard, CatalogCard, MemberCard, OrderCard, TicketNoticeCard } from "../components/cards";
import { DemoBadge } from "../components/common";

interface Msg {
  id: string;
  role: "user" | "ai";
  text: string;
  shown: number; // 打字机已显示字符数（user 消息直接 = text.length）
  ts: number;
  citations?: Citation[];
  cards?: BusinessCard[];
  lowConfidence?: boolean;
  ticketTitle?: string;
  demo?: boolean;
  /** 发送失败（可点重发） */
  failed?: boolean;
}

let seq = 0;
const nextId = () => `m${++seq}`;

const CACHE_KEY = "webc.chat.msgs";
const CACHE_LIMIT = 20;

function loadCache(): Msg[] {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as Msg[];
    return Array.isArray(arr) ? arr.slice(-CACHE_LIMIT).map((m) => ({ ...m, shown: m.text.length, failed: false })) : [];
  } catch {
    return [];
  }
}

function saveCache(msgs: Msg[]): void {
  try {
    const done = msgs.filter((m) => !m.failed && m.shown >= m.text.length).slice(-CACHE_LIMIT);
    localStorage.setItem(CACHE_KEY, JSON.stringify(done));
  } catch {
    // 存储满等异常静默
  }
}

/** 时间分隔线：相邻消息间隔 > 5 分钟时展示 */
function dividerText(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

export default function ChatPage({
  onGoService,
}: {
  onGoService: (kind: string) => void;
}) {
  const cfg = getConfig();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [booting, setBooting] = useState(true);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [demoMode, setDemoMode] = useState(false);
  const [conversationId, setConversationId] = useState<string | undefined>();
  const scrollRef = useRef<HTMLDivElement>(null);

  // 首进：恢复本地缓存（最近 20 条）+ 建会话；无缓存时展示配置化欢迎语
  useEffect(() => {
    const cached = loadCache();
    void ensureSession().then((s) => {
      if (!s) setDemoMode(true);
      if (cached.length > 0) {
        setMsgs(cached);
      } else {
        setMsgs([
          { id: nextId(), role: "ai", text: tpl(cfg.welcomeText), shown: 0, ts: Date.now() },
        ]);
      }
      setBooting(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // 新消息滚到底 + 持久化缓存
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    if (!booting) saveCache(msgs);
  }, [msgs, booting]);

  const appendAi = (partial: Omit<Msg, "id" | "role" | "shown" | "ts">) => {
    setMsgs((prev) => [...prev, { ...partial, id: nextId(), role: "ai", shown: 0, ts: Date.now() }]);
  };

  /** 请求 AI 应答；userMsgId 对应已入列的用户气泡（失败时标记可重发） */
  const request = async (text: string, userMsgId: string) => {
    setSending(true);
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
      // 发送失败：标记用户气泡可重发，并给出演示应答兜底入口
      setMsgs((prev) => prev.map((m) => (m.id === userMsgId ? { ...m, failed: true } : m)));
    } finally {
      setSending(false);
    }
  };

  const send = async (raw?: string) => {
    const text = (raw ?? input).trim();
    if (!text || sending) return;
    setInput("");
    const id = nextId();
    setMsgs((prev) => [...prev, { id, role: "user", text, shown: text.length, ts: Date.now() }]);
    await request(text, id);
  };

  const resend = async (m: Msg) => {
    if (sending) return;
    setMsgs((prev) => prev.map((x) => (x.id === m.id ? { ...x, failed: false } : x)));
    await request(m.text, m.id);
  };

  /** 失败消息的演示应答兜底 */
  const demoAnswer = (m: Msg) => {
    setMsgs((prev) => prev.map((x) => (x.id === m.id ? { ...x, failed: false } : x)));
    setDemoMode(true);
    const d = demoChatAnswer(m.text);
    appendAi({
      text: d.answer,
      citations: d.citations,
      cards: d.cards,
      lowConfidence: d.confidence < 0.5,
      demo: true,
    });
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

  const onChip = (q: { label: string; sendText?: string; serviceKind?: string }) => {
    if (q.serviceKind) return onGoService(q.serviceKind);
    if (q.sendText) return void send(q.sendText);
  };

  return (
    <div className="flex h-full flex-col">
      {/* 欢迎卡 */}
      <div className="border-b border-line bg-gradient-to-b from-bg700/60 to-bg800 px-4 pb-3 pt-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-[17px] font-semibold text-ink">
              {cfg.brandName} <span className="text-gold">· AI 服务前台</span>
            </h1>
            <p className="mt-1 flex items-center gap-1.5 text-[11px] text-ink2">
              <span className="h-1.5 w-1.5 rounded-full bg-go" />
              {cfg.agentName}在线 · 平均 1 分钟响应 {demoMode && <DemoBadge />}
            </p>
          </div>
          <div className="flex h-10 w-10 items-center justify-center rounded-full border border-gline bg-gold/10 font-orb text-[15px] text-gold">
            {cfg.logoText}
          </div>
        </div>
        {/* 快捷入口（配置驱动，横滑） */}
        <div className="no-scrollbar mt-3 flex gap-2 overflow-x-auto">
          {cfg.quickReplies.map((q) => (
            <button
              key={q.label}
              type="button"
              onClick={() => onChip(q)}
              className="pressable shrink-0 rounded-full border border-gline bg-card px-3 py-1.5 text-[12px] text-goldhi active:bg-gold/20"
            >
              {q.label}
            </button>
          ))}
        </div>
      </div>

      {/* 聊天流 */}
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {booting && (
          <div className="space-y-3" aria-hidden>
            <div className="flex items-start gap-2">
              <div className="skeleton mt-0.5 h-7 w-7 shrink-0 rounded-full" />
              <div className="skeleton h-16 w-3/5 rounded-2xl" />
            </div>
            <div className="flex justify-end">
              <div className="skeleton h-9 w-2/5 rounded-2xl" />
            </div>
            <div className="flex items-start gap-2">
              <div className="skeleton mt-0.5 h-7 w-7 shrink-0 rounded-full" />
              <div className="skeleton h-12 w-1/2 rounded-2xl" />
            </div>
          </div>
        )}

        {!booting &&
          msgs.map((m, idx) => {
            const prev = idx > 0 ? msgs[idx - 1] : undefined;
            const showDivider = !prev || m.ts - prev.ts > 5 * 60_000;
            const shownText = m.text.slice(0, m.shown);
            const done = m.shown >= m.text.length;
            return (
              <div key={m.id}>
                {showDivider && (
                  <div className="flex justify-center py-1">
                    <span className="rounded-full bg-bg700/70 px-2.5 py-0.5 text-[10px] text-ink3">
                      {dividerText(m.ts)}
                    </span>
                  </div>
                )}
                {m.role === "user" ? (
                  <div className="flex flex-col items-end">
                    <div className="flex justify-end">
                      <div
                        className={`max-w-[80%] rounded-2xl rounded-br-sm px-3.5 py-2.5 text-[13.5px] leading-relaxed ${
                          m.failed
                            ? "border border-alert/60 bg-alert/15 text-ink"
                            : "bg-gold text-ongold"
                        }`}
                      >
                        {m.text}
                      </div>
                    </div>
                    {m.failed && (
                      <div className="mt-1 flex items-center gap-2 text-[11px]">
                        <span className="text-alert">发送失败</span>
                        <button
                          type="button"
                          onClick={() => void resend(m)}
                          className="pressable rounded-full border border-gline px-2.5 py-0.5 text-gold"
                        >
                          重发
                        </button>
                        <button
                          type="button"
                          onClick={() => demoAnswer(m)}
                          className="pressable rounded-full border border-line px-2.5 py-0.5 text-ink3"
                        >
                          演示应答
                        </button>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="flex items-start gap-2">
                    <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-gline bg-gold/10 text-[11px] text-gold">
                      {cfg.logoText}
                    </div>
                    <div className="max-w-[82%]">
                      <div className="rounded-2xl rounded-tl-sm border border-line bg-card px-3.5 py-2.5 text-[13.5px] leading-relaxed text-ink">
                        {shownText}
                        {!done && (
                          <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-gold align-middle" />
                        )}
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
                              items={
                                (c.data as { items?: Array<{ sku?: string; name: string; priceYuan?: number }> })
                                  .items ?? []
                              }
                            />
                          ) : null,
                        )}
                      {done && m.ticketTitle && <TicketNoticeCard title={m.ticketTitle} />}
                      {done && m.lowConfidence && !m.ticketTitle && (
                        <TicketNoticeCard title="该问题已记录并转交服务专员跟进。" />
                      )}
                      {/* 「没解决？」操作条：固定在 AI 答案卡底部 */}
                      {done && (
                        <div className="mt-1.5 flex items-center gap-2 text-[11px]">
                          <span className="text-ink3">没解决？</span>
                          <button
                            type="button"
                            onClick={() => void escalate("other")}
                            className="pressable rounded-full border border-line px-2.5 py-1 text-ink2 active:bg-bg700"
                          >
                            转工单
                          </button>
                          <button
                            type="button"
                            onClick={() => void escalate("other")}
                            className="pressable rounded-full border border-line px-2.5 py-1 text-ink2 active:bg-bg700"
                          >
                            转人工
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                )}
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
            {cfg.agentName}正在思考…
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
            className="pressable h-10 shrink-0 rounded-full bg-gold px-4 text-[13px] font-medium text-ongold disabled:opacity-40"
          >
            发送
          </button>
        </div>
      </div>
    </div>
  );
}
