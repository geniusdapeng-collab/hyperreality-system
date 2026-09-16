import { useEffect, useRef, useState } from "react";
import { ApiError, api, ensureSession } from "../lib/api";
import { getConfig, getConfigState, tpl } from "../lib/config";
import { demoChatAnswer } from "../lib/demo";
import { businessCardsOf } from "../lib/business-display";
import { storageKey } from "../lib/product";
import type { BusinessCard, Citation } from "../lib/types";
import { CitationCard, CatalogCard, MemberCard, OrderCard, TicketNoticeCard } from "../components/cards";
import { DemoBadge, chineseMessage } from "../components/common";
import { Input, clientChineseText, clientIdentifierText } from "@workloom/ui";

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
  ticketState?: "draft" | "accepted";
  demo?: boolean;
  /** 发送失败（可点重发） */
  failed?: boolean;
  failureText?: string;
  /** 服务端写操作的可追溯请求回执 */
  receiptId?: string;
  ledgerEventId?: string;
}

let seq = 0;
const nextId = () => `m${++seq}`;

const CACHE_LIMIT = 20;

function safeAiText(value: unknown): string {
  return clientChineseText(value, "本条答复包含无法安全展示的技术内容，请重新提问或转人工处理。");
}

function safeCitations(value: unknown): Citation[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, 20).map((item) => {
    const citation = item && typeof item === "object" ? item as Partial<Citation> : {};
    return {
      documentTitle: clientChineseText(citation.documentTitle, "参考资料"),
      heading: clientChineseText(citation.heading, "相关章节"),
      content: clientChineseText(citation.content, "引用内容暂无法安全展示"),
    };
  });
}

function cacheKey(): string {
  const config = getConfig();
  return storageKey(`chat.v4:${config.workspaceKey || "安全模式"}:${config.projection.manifestDigest}`);
}

function loadCache(): Msg[] {
  try {
    const raw = sessionStorage.getItem(cacheKey());
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? arr.slice(-CACHE_LIMIT).flatMap((item): Msg[] => {
      if (!item || typeof item !== "object") return [];
      const m = item as Partial<Msg>;
      if ((m.role !== "user" && m.role !== "ai") || typeof m.text !== "string" || typeof m.id !== "string" || typeof m.ts !== "number") return [];
      const safeText = m.role === "ai" ? safeAiText(m.text) : m.text;
      return [{
        ...m,
        id: m.id,
        role: m.role,
        text: safeText,
        ts: m.ts,
        citations: m.role === "ai" ? safeCitations(m.citations) : undefined,
        cards: businessCardsOf(m.cards),
        shown: safeText.length,
        failed: false,
      }];
    }) : [];
  } catch {
    return [];
  }
}

function saveCache(msgs: Msg[]): void {
  try {
    const done = msgs.filter((m) => !m.failed && m.shown >= m.text.length).slice(-CACHE_LIMIT);
    sessionStorage.setItem(cacheKey(), JSON.stringify(done));
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
  const configReady = getConfigState().ready;
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [booting, setBooting] = useState(true);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [escalating, setEscalating] = useState(false);
  const [demoMode, setDemoMode] = useState(false);
  const [sessionState, setSessionState] = useState<"loading" | "ready" | "demo" | "error">("loading");
  const [conversationId, setConversationId] = useState<string | undefined>();
  const scrollRef = useRef<HTMLDivElement>(null);

  // 首进：恢复本地缓存（最近 20 条）+ 建会话；无缓存时展示配置化欢迎语
  useEffect(() => {
    const cached = loadCache();
    if (!configReady) {
      setSessionState("error");
      setBooting(false);
      return;
    }
    void ensureSession().then((s) => {
      if (!s) {
        setSessionState("error");
      } else if (s.user.authMode === "demo") {
        setSessionState("demo");
        setDemoMode(true);
      } else {
        setSessionState("ready");
      }
      if (cached.length > 0) {
        setMsgs(cached);
      } else {
        const history = (cfg.demoHistory ?? []).map((m) => ({
          id: nextId(), role: m.role, text: m.text, shown: m.role === "user" ? m.text.length : 0, ts: Date.now(),
        }));
        setMsgs([
          ...history,
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
        text: safeAiText(res.answer),
        citations: safeCitations(res.citations),
        cards: res.cards,
        lowConfidence: res.confidence < 0.5 || Boolean(res.ticket),
        ticketTitle: res.ticket
          ? `工单${clientIdentifierText(res.ticket.id)}「${res.ticket.title}」已受理`
          : res.ticketDraft
            ? `已为您准备工单草稿：${res.ticketDraft.title}（可在下方「转工单」提交）`
            : undefined,
        ticketState: res.ticket ? "accepted" : res.ticketDraft ? "draft" : undefined,
        receiptId: res.receipt?.requestId,
        ledgerEventId: res.receipt?.eventId,
        demo: Boolean(res.mock),
      });
    } catch (err) {
      // 发送失败：标记用户气泡可重发，并给出演示应答兜底入口
      const requestId = err instanceof ApiError ? err.requestId : undefined;
      const failureText = `${chineseMessage(err instanceof Error ? err.message : null, "发送失败，请稍后重试")}${requestId ? `（请求${clientIdentifierText(requestId)}）` : ""}`;
      setMsgs((prev) => prev.map((m) => (m.id === userMsgId ? { ...m, failed: true, failureText } : m)));
    } finally {
      setSending(false);
    }
  };

  const send = async (raw?: string) => {
    const text = (raw ?? input).trim();
    if (!configReady || !text || sending) return;
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

  /** 用户主动选择的离线界面示例；不生成或伪造任何业务事实。 */
  const demoAnswer = (m: Msg) => {
    setMsgs((prev) => prev.map((x) => (x.id === m.id ? { ...x, failed: false } : x)));
    setDemoMode(true);
    const d = demoChatAnswer();
    appendAi({
      text: d.answer,
      citations: d.citations,
      lowConfidence: d.confidence < 0.5,
      demo: true,
    });
  };

  const escalate = async (route: "ticket" | "human") => {
    if (!configReady || escalating) return;
    const title = route === "human" ? "请求人工服务团队跟进" : "请求服务团队跟进";
    setEscalating(true);
    try {
      const result = await api.createTicket({
        kind: "other",
        title,
        payload: { source: "chat", requestedRoute: route },
      });
      const delivery = result.receipt.delivery?.state;
      const deliveryText = delivery === "demo"
        ? "外部通知通道为演示模式，未向真实渠道发送。"
        : delivery === "pending"
          ? "通知正在等待发送。"
          : delivery === "failed"
            ? "通知发送失败，请在「工单」页查看进度。"
            : "";
      appendAi({
        text: `工单${clientIdentifierText(result.ticket.id)}已真实写入并受理，将由服务团队跟进。${deliveryText}`,
        ticketTitle: `工单${clientIdentifierText(result.ticket.id)}已受理`,
        ticketState: "accepted",
        receiptId: result.receipt.requestId,
        ledgerEventId: result.receipt.eventId,
      });
    } catch (err) {
      const requestId = err instanceof ApiError ? err.requestId : undefined;
      appendAi({
        text: `${chineseMessage(err instanceof Error ? err.message : null, "转接请求提交失败")}。本次没有创建工单，请重试或通过已配置的客服渠道联系服务方。`,
        receiptId: requestId,
      });
    } finally {
      setEscalating(false);
    }
  };

  const onChip = (q: { label: string; sendText?: string; serviceKind?: string }) => {
    if (q.serviceKind) return onGoService(q.serviceKind);
    if (q.sendText) return void send(q.sendText);
  };

  const sessionStatus = sessionState === "ready"
    ? `${cfg.agentName}已连接`
    : sessionState === "demo"
      ? "演示身份已连接"
      : sessionState === "error"
        ? "服务连接失败，可重试发送"
        : "正在连接服务";
  const sessionTone = sessionState === "ready" ? "bg-go" : sessionState === "error" ? "bg-alert" : "bg-warn";

  return (
    <div className="flex h-full flex-col">
      {/* 欢迎卡 */}
      <div className="border-b border-line bg-gradient-to-b from-bg700/60 to-bg800 px-4 pb-3 pt-4">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="break-words text-[1.0625rem] font-semibold leading-snug text-ink">
              {cfg.brandName} <span className="text-gold">· AI 服务前台</span>
            </h1>
            <p className="mt-1 flex flex-wrap items-center gap-1.5 text-body text-ink2">
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${sessionTone}`} />
              <span className="break-words">{configReady ? sessionStatus : "服务配置待恢复"}</span> {demoMode && <DemoBadge />}
            </p>
          </div>
          <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-full border border-gline bg-gold/10 text-center font-orb text-[0.9375rem] text-gold" aria-hidden>
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
              className="pressable shrink-0 rounded-full border border-gline bg-card px-3 py-1.5 text-body text-goldhi active:bg-gold/20"
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
                    <span className="rounded-full bg-bg700/70 px-2.5 py-0.5 text-body text-ink3">
                      {dividerText(m.ts)}
                    </span>
                  </div>
                )}
                {m.role === "user" ? (
                  <div className="flex flex-col items-end">
                    <div className="flex justify-end">
                      <div
                        className={`max-w-[80%] break-words rounded-2xl rounded-br-sm px-3.5 py-2.5 text-body leading-relaxed ${
                          m.failed
                            ? "border border-alert/60 bg-alert/15 text-ink"
                            : "bg-gold text-ongold"
                        }`}
                      >
                        {m.text}
                      </div>
                    </div>
                    {m.failed && (
                      <div className="mt-1 flex flex-wrap items-center justify-end gap-2 text-body">
                        <span className="break-words text-right text-alert">{m.failureText ?? "发送失败"}</span>
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
                          查看离线示例
                        </button>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="flex items-start gap-2">
                    <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-gline bg-gold/10 text-body text-gold">
                      {cfg.logoText}
                    </div>
                    <div className="min-w-0 max-w-[82%]">
                      <div className="break-words rounded-2xl rounded-tl-sm border border-line bg-card px-3.5 py-2.5 text-body leading-relaxed text-ink">
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
                            <OrderCard key={`o-${i}`} order={c.data} />
                          ) : c.kind === "member" ? (
                            <MemberCard key={`m-${i}`} member={c.data} />
                          ) : c.kind === "catalog" ? (
                            <CatalogCard key={`c-${i}`} catalog={c.data} />
                          ) : null,
                        )}
                      {done && m.ticketTitle && <TicketNoticeCard title={m.ticketTitle} state={m.ticketState ?? "draft"} />}
                      {done && m.receiptId && (
                        <p className="mt-1 max-w-full break-words px-1 text-body text-ink3">请求回执：{clientIdentifierText(m.receiptId)}</p>
                      )}
                      {done && m.ledgerEventId && (
                        <p className="mt-1 max-w-full break-words px-1 text-body text-ink3">账本凭证：{clientIdentifierText(m.ledgerEventId)}</p>
                      )}
                      {done && m.lowConfidence && !m.ticketTitle && (
                        <TicketNoticeCard title="本次尚未创建工单；如需跟进，请确认后使用下方操作。" state="draft" />
                      )}
                      {/* 「没解决？」操作条：固定在 AI 答案卡底部 */}
                      {done && (
                        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-body">
                          <span className="text-ink3">没解决？</span>
                          <button
                            type="button"
                            onClick={() => void escalate("ticket")}
                            disabled={escalating || !configReady}
                            className="pressable rounded-full border border-line px-2.5 py-1 text-ink2 active:bg-bg700 disabled:opacity-40"
                          >
                            {escalating ? "提交中…" : "转工单"}
                          </button>
                          <button
                            type="button"
                            onClick={() => void escalate("human")}
                            disabled={escalating || !configReady}
                            className="pressable rounded-full border border-line px-2.5 py-1 text-ink2 active:bg-bg700 disabled:opacity-40"
                          >
                            {escalating ? "提交中…" : "转人工"}
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
          <div className="flex items-center gap-2 pl-9 text-body text-ink3">
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
          <Input
            label="咨询内容"
            hideLabel
            optionalLabel=""
            wrapperClassName="min-w-0 flex-1"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) void send();
            }}
            placeholder={configReady ? "请输入您的需求…" : "服务配置异常，暂不可发送"}
            disabled={!configReady}
            className="min-h-11 min-w-0 flex-1 rounded-full border border-line bg-bg900 px-4 text-body text-ink outline-none placeholder:text-ink3 focus:border-gline"
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={!configReady || sending || !input.trim()}
            className="pressable min-h-11 shrink-0 rounded-full bg-gold px-4 text-body font-medium text-ongold disabled:opacity-40"
          >
            发送
          </button>
        </div>
      </div>
    </div>
  );
}
