/**
 * 星环 StarRing（全局 Ask 入口；AI 原生工作空间 · 交互层）
 *  - PC 右下 56px 悬浮球：场记板 SVG 造型 + 金色呼吸光圈；待审批红点 badge（有待批时呼吸加速 0.8s）
 *  - 三级展开：L1 单击 → 底部输入条 + 情境快捷钮；L2 上滑/点扩展 → 半屏对话面板（不离开当前页，
 *    消息流复用 hud/messages 的 HumanBubble / AgentActionMessage）；L3 双击 → /p0 经营剧场
 *  - ⌘K / Ctrl+K 唤起；Esc 逐层收起
 *  - 上下文感知：useLocation 读当前路由预置情境 chips（/p10 镜级问题、/p4 审批风险等）
 *  - 输入分流：问句走 ask（threads.dispatch 意图路由 → ask 即时应答，P2 同口径）；明确任务走 quest（立项 → P2）
 *  - 待审批数：approvals.list({status:"pending"}) 10s 轮询（D6「其余」口径）
 *  - 调用失败优雅降级：失败消息以 ✗ 回执上屏，输入保留可重试（§9.3 不隐藏失败）
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { ensureDemoLogin, trpc } from "../../lib/trpc";
import { AgentActionMessage, HumanBubble } from "../hud/messages";

/** 路由 → 情境快捷钮（前缀匹配；越靠上越优先） */
const CONTEXT_CHIPS: Array<[prefix: string, chips: string[]]> = [
  ["/p10", ["这镜台词再口语化", "查这镜渲染成本"]],
  ["/p4", ["这批审批有高危项吗", "汇总今日待审重点"]],
  ["/p2", ["这线程卡在哪一步", "预估剩余积分消耗"]],
  ["/p1", ["昨夜经营有什么异常", "今天优先级最高的三件事"]],
];
const DEFAULT_CHIPS = ["汇报当前经营概况", "有哪些待我决断的事项"];

interface RingMsg {
  id: number;
  role: "human" | "agent";
  text: string;
  /** agent 消息附加：动作短语 / 事件或线程号 / 回执三态 / 跳转链接 */
  action?: string;
  refId?: string;
  receipt?: "synced" | "unverified" | "failed";
  linkTo?: string;
}

/** dispatch 返回（ask 应答 / quest 立项 / 反问澄清；服务端 union，页面侧窄化口径同 P1/P2） */
interface DispatchResult {
  kind: "clarify" | "routed";
  question?: string;
  mode?: string;
  threadId?: string;
  status?: string;
  answer?: string;
}

/** 问句判定（?/？结尾或含疑问词 → ask；否则 quest 立项） */
function isQuestion(text: string): boolean {
  return /[?？]\s*$/.test(text) || /(吗|呢|什么|怎么|为什么|如何|多少|哪些|哪个|查一下|汇报)/.test(text);
}

/** 场记板造型（Bridge 顶栏 logo 同稿，悬浮球内反色深底） */
function ClapperIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="2.5" y="8" width="19" height="12.5" rx="2.2" fill="#2a1500" />
      <path d="M3.2 5.4 20.6 3.2l.5 2.6L3.7 8z" fill="#2a1500" />
      <path d="M6.4 4.9l2 2.2M10.6 4.5l2 2.2M14.8 4l2 2.2" stroke="#ffb545" strokeWidth="1.1" />
      <path d="M10.2 11.4v5.6l4.8-2.8z" fill="#ffb545" />
    </svg>
  );
}

export function StarRing() {
  const nav = useNavigate();
  const { pathname } = useLocation();
  // 0=收起 1=输入条 2=半屏对话面板（L3=双击跳剧场，非稳态）
  const [level, setLevel] = useState<0 | 1 | 2>(0);
  const [pendingCount, setPendingCount] = useState(0);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [msgs, setMsgs] = useState<RingMsg[]>([]);
  const msgSeq = useRef(0);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchY = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const chips = CONTEXT_CHIPS.find(([p]) => pathname.startsWith(p))?.[1] ?? DEFAULT_CHIPS;

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

  /* ---------- ⌘K / Ctrl+K 唤起；Esc 逐层收起 ---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setLevel((l) => (l === 0 ? 1 : 0));
      } else if (e.key === "Escape") {
        setLevel((l) => (l === 2 ? 1 : 0));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* ---------- 面板新消息滚到底 ---------- */
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [msgs, level]);

  const pushMsg = useCallback((m: Omit<RingMsg, "id">) => {
    msgSeq.current += 1;
    setMsgs((cur) => [...cur, { ...m, id: msgSeq.current }]);
  }, []);

  /* ---------- 单击（L1 开关）与双击（L3 跳剧场）消歧 ---------- */
  const onBallClick = useCallback(() => {
    if (clickTimer.current) clearTimeout(clickTimer.current);
    clickTimer.current = setTimeout(() => {
      clickTimer.current = null;
      setLevel((l) => (l === 0 ? 1 : 0));
    }, 260);
  }, []);
  const onBallDoubleClick = useCallback(() => {
    if (clickTimer.current) { clearTimeout(clickTimer.current); clickTimer.current = null; }
    nav("/p0"); // L3：经营剧场
  }, [nav]);

  /* ---------- 发送：问句走 ask，明确任务走 quest；失败优雅降级 ---------- */
  const send = useCallback(async (raw: string) => {
    const text = raw.trim();
    if (!text || sending) return;
    setSending(true);
    pushMsg({ role: "human", text });
    setInput("");
    try {
      await ensureDemoLogin();
      const r = (await trpc.threads.dispatch.mutate({ title: text, presetKey: "director" })) as DispatchResult;
      if (r.kind === "clarify") {
        pushMsg({
          role: "agent", action: "航线待确认", receipt: "unverified", refId: r.threadId,
          text: r.question ?? "请补充目标与时间（含糊指令不建任务 F3.2）",
        });
      } else if (isQuestion(text)) {
        // ask 问询：即时应答上屏（B8；意图路由 misclassify 时按实际 mode 降级提示）
        if (r.mode === "ask" && r.answer) {
          pushMsg({ role: "agent", action: "星环参谋 · 应答", receipt: "synced", refId: r.threadId, text: r.answer });
        } else {
          pushMsg({
            role: "agent", action: "已转立项处理", receipt: "unverified", refId: r.threadId,
            text: `该问句被路由为任务（${r.mode ?? "quest"}），线程 ${r.threadId ?? "—"} 已建立，可到 P2 任务舱跟进。`,
            linkTo: r.threadId ? `/p2/${encodeURIComponent(r.threadId)}` : undefined,
          });
        }
      } else {
        // quest 立项：不离开当前页，给 P2 下钻口
        pushMsg({
          role: "agent", action: "总导演已接单", receipt: "unverified", refId: r.threadId,
          text: `已立项 ${r.threadId ?? "—"}（状态 ${r.status ?? "queued"}）：「${text}」。点击跳任务舱跟进执行。`,
          linkTo: r.threadId ? `/p2/${encodeURIComponent(r.threadId)}` : undefined,
        });
      }
    } catch (e) {
      setInput(text); // 输入保留可重试
      pushMsg({
        role: "agent", action: "调用失败", receipt: "failed",
        text: `星环连接中断：${e instanceof Error ? e.message : String(e)}。输入已保留，可重试（E1.1 优雅降级）。`,
      });
    } finally {
      setSending(false);
    }
  }, [sending, pushMsg]);

  /* ---------- L1 上滑 → L2（触摸；桌面点扩展钮） ---------- */
  const onTouchStart = (e: React.TouchEvent) => { touchY.current = e.touches[0]?.clientY ?? null; };
  const onTouchEnd = (e: React.TouchEvent) => {
    const start = touchY.current;
    const end = e.changedTouches[0]?.clientY;
    touchY.current = null;
    if (start !== null && end !== undefined && start - end > 32) setLevel(2);
  };

  const inputBar = (
    <>
      <div className="flex items-center gap-2">
        <input
          value={input}
          maxLength={500}
          autoFocus
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void send(input); }}
          placeholder={pathname.startsWith("/p10") ? "问这镜/派任务…（≤500 字）" : "问点什么，或派个任务…（≤500 字）"}
          className="min-w-0 flex-1 rounded-lg border border-gline bg-bg800 px-3 py-2 text-body text-ink outline-none placeholder:text-ink3"
        />
        <button
          type="button"
          disabled={!input.trim() || sending}
          onClick={() => void send(input)}
          className="shrink-0 cursor-pointer rounded-lg gold-grad px-3.5 py-2 text-body font-black text-ongold disabled:cursor-not-allowed disabled:opacity-40"
        >
          {sending ? "发送中…" : "发送"}
        </button>
        {level === 1 && (
          <button
            type="button"
            onClick={() => setLevel(2)}
            title="展开对话面板（L2）"
            className="shrink-0 cursor-pointer rounded-lg border border-holo/40 bg-holo/8 px-2.5 py-2 text-caption font-bold text-holo"
          >
            ⤢ 扩展
          </button>
        )}
      </div>
      {/* 情境快捷钮（读当前路由预置） */}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {chips.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => void send(c)}
            className="cursor-pointer rounded-md border border-holo/35 bg-holo/5 px-2 py-0.5 text-caption text-holo transition-colors hover:border-gline hover:text-gold"
          >
            ⚡ {c}
          </button>
        ))}
      </div>
    </>
  );

  return (
    <>
      {/* L2 半屏对话面板（不离开当前页） */}
      {level === 2 && (
        <div className="fixed inset-y-0 right-0 z-40 flex w-[min(560px,94vw)] flex-col border-l border-line bg-bg900/95 shadow-[-20px_0_60px_rgba(0,0,0,.5)] backdrop-blur-md">
          <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
            <span className="text-h2 font-black tracking-wider text-gold">星环 · 对话</span>
            <span className="font-mono text-micro text-ink3">{pathname}</span>
            <span className="flex-1" />
            <button type="button" onClick={() => nav("/p0")}
              className="cursor-pointer rounded border border-gline px-2 py-0.5 text-micro text-gold hover:bg-card">
              进剧场 →
            </button>
            <button type="button" onClick={() => setLevel(1)}
              className="cursor-pointer rounded border border-line px-2 py-0.5 text-micro text-ink3 hover:bg-card">
              收起 ▾
            </button>
          </div>
          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
            {msgs.length === 0 ? (
              <div className="mt-10 text-center text-caption text-ink3">
                问句即时应答（ask）· 明确任务自动立项（quest）<br />点下方情境钮快速开始
              </div>
            ) : (
              msgs.map((m) => m.role === "human" ? (
                <HumanBubble key={m.id}>{m.text}</HumanBubble>
              ) : (
                <AgentActionMessage
                  key={m.id}
                  sender="星环参谋"
                  version=""
                  action={m.action ?? "应答"}
                  eventId={m.refId ?? "—"}
                  receipt={m.receipt ?? "unverified"}
                >
                  {m.text}
                  {m.linkTo && (
                    <a href={m.linkTo} className="ml-1 text-holo underline">→ 任务舱跟进</a>
                  )}
                </AgentActionMessage>
              ))
            )}
          </div>
          <div className="border-t border-line px-4 py-3">{inputBar}</div>
        </div>
      )}

      {/* L1 底部输入条 + 情境快捷钮（上滑展开 L2） */}
      {level === 1 && (
        <div
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
          className="fixed bottom-24 right-6 z-40 w-[min(520px,calc(100vw-3rem))] rounded-msg border border-gline bg-card p-3 shadow-[0_0_30px_rgba(255,160,60,.12)]"
        >
          {inputBar}
        </div>
      )}

      {/* 悬浮球（56px；金色呼吸光圈；有待批时呼吸加速 + 红点 badge） */}
      <button
        type="button"
        onClick={onBallClick}
        onDoubleClick={onBallDoubleClick}
        title="星环 · 全局 Ask（⌘K 唤起 · 双击进剧场）"
        className="fixed bottom-6 right-6 z-50 flex h-14 w-14 cursor-pointer items-center justify-center rounded-full gold-grad shadow-[0_0_24px_rgba(255,160,60,.5)]"
      >
        <span
          aria-hidden
          className={`pointer-events-none absolute -inset-1.5 rounded-full border-2 border-gold/60 ${
            pendingCount > 0 ? "animate-pulse-alert" : "animate-pulse-hud"
          }`}
        />
        <ClapperIcon />
        {pendingCount > 0 && (
          <span className="absolute -top-1 -right-1 flex h-5 min-w-5 items-center justify-center rounded-full border border-alert/70 bg-alert px-1 font-orb text-micro font-bold text-ink shadow-[0_0_10px_rgba(255,84,112,.7)]">
            {pendingCount}
          </span>
        )}
      </button>
    </>
  );
}
