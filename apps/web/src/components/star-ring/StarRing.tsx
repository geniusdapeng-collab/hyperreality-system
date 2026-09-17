/**
 * AI 助手 StarRing · 全局 Ask 入口（右侧固定通栏 AskRail 形态；AI 原生工作空间 · 交互层）
 *
 * 交互策略（2026-08-25 定稿）：
 *  - PC 端：右侧固定通栏对话框——贴界面最右、从顶到底的瘦长完整对话模块，任何页面常驻；
 *    可收起为 56px 图标条（收起后随时展开，不是隐藏）
 *  - 移动端 B 端：底部 Tab 首个即对话（生产移动壳落地时按此口径；demo 已镜像）
 *  - 栏内构成：头部（AI 助手 + 待审批数量 + 收起）/ 消息流 / 情境快捷钮 / 输入栏
 *  - 上下文感知：useLocation 读当前路由预置情境 chips（/p22 服务前台、/p13 订单、/p15 口碑等）
 *  - 输入分流：问句走 ask（threads.dispatch 意图路由 → ask 即时应答，P2 同口径）；明确任务走 quest（立项 → P2）
 *  - 待审批数：approvals.list({status:"pending"}) 10s 轮询（D6「其余」口径）
 *  - ⌘K / Ctrl+K 聚焦输入框；调用失败优雅降级（✗ 回执上屏，输入保留可重试 §9.3）
 *  - 布局协作：经 window 自定义事件 askrail-width 通知 Bridge 预留右侧空间（320px / 56px）
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AgentAvatar } from "../AgentAvatar";
import { useLocation, useNavigate } from "react-router";
import { ensureDemoLogin, trpc } from "../../lib/trpc";
import { AgentActionMessage, HumanBubble } from "../hud/messages";
import { AIFeedback } from "../AIFeedback";
import {
  Icon,
  clientChineseText,
  clientIdentifierText,
  isNavigationActive,
  useManagedSurface,
} from "@workloom/ui";
import { NAV_ENTRIES } from "../../shell/NavMenu";
import { COMMON_STATUS_TEXT, dictText, THREAD_MODE_TEXT } from "../../lib/display";
import { sharedLayoutPixels } from "../../lib/useAskRail";

/** 路由 → 情境快捷钮（前缀匹配；越靠上越优先） */
const CONTEXT_CHIPS: Array<[prefix: string, chips: string[]]> = [
  ["/service", ["试试知识库检索", "今天工单有什么超时风险"]],
  ["/p22", ["试试知识库检索", "今天工单有什么超时风险"]],
  ["/approvals", ["这批审批有高危项吗", "汇总今日待审重点"]],
  ["/p4", ["这批审批有高危项吗", "汇总今日待审重点"]],
  ["/tasks/", ["这项任务卡在哪一步", "预估剩余积分消耗"]],
  ["/p2", ["这线程卡在哪一步", "预估剩余积分消耗"]],
  ["/tasks", ["昨夜经营有什么异常", "今天优先级最高的三件事"]],
  ["/p1", ["昨夜经营有什么异常", "今天优先级最高的三件事"]],
];
const DEFAULT_CHIPS = ["汇报当前经营概况", "有哪些待我审批的事项"];

interface RingMsg {
  id: number;
  role: "human" | "agent";
  text: string;
  action?: string;
  refId?: string;
  receipt?: "synced" | "unverified" | "failed";
  linkTo?: string;
  /** ask 应答的原始提问（👎 升级重答入参，v3.0 反馈环） */
  prompt?: string;
}
interface DispatchResult {
  kind?: string;
  question?: string | null;
  mode?: string;
  answer?: string;
  threadId?: string;
  status?: string;
}

function ClapperIcon({ size = 24 }: { size?: number }) {
  return <Icon name="play" size={size} />;
}

/** 布局事件：通知 Bridge 预留右侧空间（同时在 window 落一份当前值，供后挂载的页面初始化读取） */
function emitRailWidth(w: number) {
  (window as unknown as { __askRailW: number }).__askRailW = w;
  document.documentElement.style.setProperty("--workloom-ask-rail-width", `${w}px`);
  window.dispatchEvent(new CustomEvent("askrail-width", { detail: { width: w } }));
}

export function StarRing() {
  const nav = useNavigate();
  const { pathname } = useLocation();
  // 首次提交就必须与当前视口一致；若等 useEffect 再收起，窄屏会先闪现一帧
  // 全宽助手，同时令主区从展开栏预留宽度跳到紧凑栏宽度。
  const [collapsed, setCollapsed] = useState(() => window.matchMedia("(max-width: 820px)").matches);
  const [hidden, setHidden] = useState(false);
  const [compactViewport, setCompactViewport] = useState(() => window.matchMedia("(max-width: 820px)").matches);
  const [pendingCount, setPendingCount] = useState(0);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [msgs, setMsgs] = useState<RingMsg[]>([]);
  const msgSeq = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const collapsedTriggerRef = useRef<HTMLButtonElement | null>(null);
  const railSurface = useManagedSurface<HTMLDivElement>({
    open: !hidden && !collapsed,
    kind: "assistant-rail",
    onDismiss: () => setCollapsed(true),
    modal: compactViewport,
    focusOnOpen: compactViewport,
    restoreFocusOnClose: compactViewport,
    initialFocusRef: inputRef,
    returnFocusRef: collapsedTriggerRef,
  });

  const chips = CONTEXT_CHIPS.find(([p]) => pathname.startsWith(p))?.[1] ?? DEFAULT_CHIPS;
  const pageLabel = NAV_ENTRIES.find((entry) => isNavigationActive(entry, pathname))?.title ?? "当前页面";

  useEffect(() => {
    const query = window.matchMedia("(max-width: 820px)");
    const sync = () => {
      setCompactViewport(query.matches);
      if (query.matches) setCollapsed(true);
    };
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    const reset = () => {
      setHidden(false);
      setCollapsed(window.matchMedia("(max-width: 820px)").matches);
    };
    const setVisibility = (event: Event) => {
      const action = (event as CustomEvent<"show" | "hide" | "toggle">).detail;
      if (action === "show") { setHidden(false); setCollapsed(false); }
      else if (action === "hide") setHidden(true);
      else setHidden((value) => !value);
    };
    window.addEventListener("workloom:reset-layout", reset);
    window.addEventListener("workloom:assistant-visibility", setVisibility);
    return () => {
      window.removeEventListener("workloom:reset-layout", reset);
      window.removeEventListener("workloom:assistant-visibility", setVisibility);
    };
  }, []);

  /* ---------- 布局协作：挂载/收起状态变化时通知 Bridge ---------- */
  useEffect(() => {
    emitRailWidth(hidden ? 0 : sharedLayoutPixels(
      compactViewport || collapsed ? "--wl-assistant-compact" : "--wl-assistant-expanded",
    ));
  }, [collapsed, compactViewport, hidden]);
  useEffect(() => () => emitRailWidth(0), []);

  /* ---------- 待审批 badge（approvals 轮询，D6 口径；失败静默保留上次值） ---------- */
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        await ensureDemoLogin();
        const rows = (await trpc.approvals.list.query({ status: "pending" })) as unknown[];
        if (alive) setPendingCount(rows.length);
      } catch { /* 断线保留上次计数 */ }
    };
    void poll();
    const t = setInterval(() => void poll(), 10000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  /* ---------- ⌘K / Ctrl+K 聚焦输入框 ---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setHidden(false);
        setCollapsed(false);
        setTimeout(() => inputRef.current?.focus(), 60);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* ---------- 新消息滚到底 ---------- */
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [msgs, collapsed]);

  const pushMsg = useCallback((m: Omit<RingMsg, "id">) => {
    msgSeq.current += 1;
    setMsgs((cur) => [...cur, { ...m, id: msgSeq.current }]);
  }, []);

  /* ---------- 发送：问句走 ask，明确任务走 quest；失败优雅降级 ---------- */
  const send = useCallback(async (raw: string) => {
    const text = raw.trim();
    if (!text || sending) return;
    setSending(true);
    pushMsg({ role: "human", text });
    setInput("");
    try {
      await ensureDemoLogin();
      const r = (await trpc.threads.dispatch.mutate({ title: text })) as DispatchResult;
      if (r.kind === "clarify") {
        pushMsg({
          role: "agent", action: "航线待确认", receipt: "unverified", refId: r.threadId,
          text: clientChineseText(r.question, "请补充目标与时间；信息完整前不会创建任务。"),
        });
      } else if (isQuestion(text)) {
        if (r.mode === "ask" && r.answer) {
          pushMsg({
            role: "agent",
            action: "AI 助手 · 应答",
            receipt: "synced",
            refId: r.threadId,
            text: clientChineseText(r.answer, "应答内容暂时无法显示，请稍后再试。"),
            prompt: text,
          });
        } else {
          pushMsg({
            role: "agent", action: "已转立项处理", receipt: "unverified", refId: r.threadId,
            text: `这次请求已转为${dictText(THREAD_MODE_TEXT, r.mode ?? "quest")}，任务${clientIdentifierText(r.threadId)}已建立，可进入任务中心跟进。`,
            linkTo: r.threadId ? `/tasks/${encodeURIComponent(r.threadId)}` : undefined,
          });
        }
      } else {
        pushMsg({
          role: "agent", action: "公司负责人已接单", receipt: "unverified", refId: r.threadId,
          text: `已建立任务${clientIdentifierText(r.threadId)}（${dictText(COMMON_STATUS_TEXT, r.status ?? "queued")}）：「${text}」。可进入任务中心跟进执行。`,
          linkTo: r.threadId ? `/tasks/${encodeURIComponent(r.threadId)}` : undefined,
        });
      }
    } catch (e) {
      console.warn("AI 助手请求失败", e);
      setInput(text);
      pushMsg({
        role: "agent", action: "调用失败", receipt: "failed",
        text: "AI 助手暂时无法连接服务。输入已保留，请稍后重试。",
      });
    } finally {
      setSending(false);
    }
  }, [sending, pushMsg]);

  const inputBar = (
    <div className="flex items-center gap-2">
      <input
        ref={inputRef}
        value={input}
        maxLength={500}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") void send(input); }}
        placeholder="问点什么，或派个任务…（⌘K 唤起）"
        className="min-w-0 flex-1 rounded-lg border border-gline bg-bg800 px-3 py-2 text-body text-ink outline-none placeholder:text-ink3"
      />
      <button
        type="button"
        disabled={!input.trim() || sending}
        onClick={() => void send(input)}
        className="shrink-0 cursor-pointer rounded-lg gold-grad px-3.5 py-2 text-body font-black text-ongold disabled:cursor-not-allowed disabled:opacity-40"
      >
        {sending ? "…" : "发送"}
      </button>
    </div>
  );

  if (hidden) {
    return (
      <button
        type="button"
        onClick={() => { setHidden(false); setCollapsed(false); }}
        className="fixed right-0 top-1/2 flex -translate-y-1/2 items-center rounded-l-xl border border-r-0 border-gline bg-bg900/95 px-2 py-3 text-body font-semibold text-gold shadow-xl"
        style={{ zIndex: "var(--wl-z-assistant)" }}
        aria-label="显示 AI 助手"
        title="显示 AI 助手（⌘/Ctrl+K）"
      >
        AI
      </button>
    );
  }

  /* ---------- 收起态：56px 图标条 ---------- */
  if (collapsed) {
    return (
      <div className="fixed inset-y-0 right-0 flex w-[var(--wl-assistant-compact)] flex-col items-center gap-3 border-l border-line bg-bg900/95 py-3 backdrop-blur-md" style={{ zIndex: "var(--wl-z-assistant)" }}>
        <div className="relative flex h-[calc(var(--wl-assistant-compact)-8px)] w-[calc(var(--wl-assistant-compact)-8px)] shrink-0 items-center justify-center">
          <button
            ref={collapsedTriggerRef}
            type="button"
            onClick={() => setCollapsed(false)}
            title="展开 AI 助手"
            aria-label="展开 AI 助手"
            className="flex h-[calc(var(--wl-assistant-compact)-12px)] w-[calc(var(--wl-assistant-compact)-12px)] cursor-pointer items-center justify-center rounded-full gold-grad shadow-[0_0_24px_rgba(255,160,60,.5)]"
          >
            <ClapperIcon />
          </button>
          {pendingCount > 0 && (
            <span className="pointer-events-none absolute right-0 top-0 flex h-5 min-w-5 items-center justify-center rounded-full border border-alert/70 bg-alert px-1 font-orb text-body font-bold text-ink shadow-[0_0_10px_rgba(255,77,109,.7)]">
              {pendingCount}
            </span>
          )}
        </div>
        <div className="text-body tracking-[.25em] text-gold [writing-mode:vertical-rl]">AI 助手</div>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          className="cursor-pointer rounded border border-line px-1.5 py-1 text-body text-ink3 hover:border-gline hover:text-gold"
          title="展开（⌘K）"
          aria-label="展开 AI 助手"
        >
          <Icon name="chevron" size={16} />
        </button>
      </div>
    );
  }

  /* ---------- 展开态：320px 通栏对话框 ---------- */
  const rail = (
    <div
      {...(!compactViewport ? railSurface : {})}
      role={!compactViewport ? "complementary" : undefined}
      aria-label={!compactViewport ? "AI 助手" : undefined}
      className="fixed inset-y-0 right-0 flex flex-col border-l border-gline/60 bg-bg900/95 shadow-[-20px_0_60px_rgba(0,0,0,.45)] backdrop-blur-md"
      style={{
        zIndex: "var(--wl-z-assistant)",
        width: compactViewport
          ? "min(var(--wl-assistant-expanded), calc(100vw - var(--wl-assistant-compact)))"
          : "var(--wl-assistant-expanded)",
      }}
    >
      {/* 头部 */}
      <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <span className="flex h-8 w-8 items-center justify-center rounded-full gold-grad shadow-[0_0_16px_rgba(255,160,60,.45)]">
          <ClapperIcon size={18} />
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <AgentAvatar kind="Knight" size={22} title="数字负责人" />
            <span className="text-body font-black tracking-wider text-gold">AI 助手</span>
          </div>
          <div className="text-body text-ink3">正在协助：{pageLabel}</div>
        </div>
        {pendingCount > 0 && (
          <span className="ml-1 flex h-5 min-w-5 items-center justify-center rounded-full border border-alert/70 bg-alert px-1 font-orb text-body font-bold text-ink">
            {pendingCount}
          </span>
        )}
        <span className="flex-1" />
        <button type="button" onClick={() => setCollapsed(true)}
          title="收起为图标条"
          aria-label="收起 AI 助手"
          className="cursor-pointer rounded border border-line px-2 py-0.5 text-body text-ink3 hover:bg-card">
          <Icon className="rotate-180" name="chevron" size={16} />
        </button>
      </div>

      {/* 消息流 */}
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {msgs.length === 0 ? (
          <div className="mt-8 space-y-2 text-center text-body text-ink3">
            <div className="text-gold/80">有事随时说——问题会即时回答<br />明确的任务会自动立项</div>
            <div className="text-body">选择下方常用问题，或直接输入内容开始</div>
          </div>
        ) : (
          msgs.map((m) => m.role === "human" ? (
            <HumanBubble key={m.id}>{m.text}</HumanBubble>
          ) : (
            <AgentActionMessage
              key={m.id}
              sender="AI 助手"
              version=""
              action={m.action ?? "应答"}
              eventId={m.refId ?? "—"}
              receipt={m.receipt ?? "unverified"}
            >
              {m.text}
              {m.linkTo && (
                <button type="button" onClick={() => nav(m.linkTo!)} className="ml-1 text-holo underline">→ 任务中心跟进</button>
              )}
              {m.prompt && (
                <AIFeedback
                  scene="ask-synthesize"
                  action="ask-synthesize"
                  prompt={m.prompt}
                  originalText={m.text}
                  fromTier="L2"
                />
              )}
            </AgentActionMessage>
          ))
        )}
      </div>

      {/* 情境快捷钮 */}
      <div className="flex flex-wrap gap-1.5 border-t border-line/60 px-3 pt-2">
        {chips.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => void send(c)}
            className="cursor-pointer rounded-md border border-holo/35 bg-holo/5 px-2 py-0.5 text-body text-holo transition-colors hover:border-gline hover:text-gold"
          >
            <Icon name="lightning" size={13} /> {c}
          </button>
        ))}
      </div>

      {/* 输入栏 */}
      <div className="px-3 py-3">{inputBar}</div>
    </div>
  );

  return compactViewport ? (
    <div
      {...railSurface}
      role="dialog"
      aria-modal="true"
      aria-label="AI 助手"
      className="fixed inset-0"
      style={{ zIndex: "var(--wl-z-assistant)" }}
    >
      <button type="button" aria-label="收起 AI 助手" className="absolute inset-0 cursor-default bg-black/45" onClick={() => setCollapsed(true)} />
      {rail}
    </div>
  ) : rail;
}

function isQuestion(text: string): boolean {
  return /[?？]$/.test(text) || /吗$|呢$|怎么|如何|什么|哪|几|多少|是否|能不能|可不可以/.test(text);
}
