/**
 * AI 助手 StarRing · 全局 Ask 入口（右侧固定通栏 AskRail 形态；AI 原生工作空间 · 交互层）
 *
 * 交互策略（2026-08-25 定稿）：
 *  - PC 端：右侧固定通栏对话框——贴界面最右、从顶到底的瘦长完整对话模块，任何页面常驻；
 *    可收起为 56px 图标条（收起后随时展开，不是隐藏）
 *  - 移动端 B 端：底部 Tab 首个即对话（生产移动壳落地时按此口径；demo 已镜像）
 *  - 栏内构成：头部（✦ Ask · AI 助手 + 待批 badge + 进经营主页 + 收起）/ 消息流 / 情境快捷钮 / 输入栏
 *  - 上下文感知：useLocation 读当前路由预置情境 chips（/p22 服务前台、/p13 订单、/p15 口碑等）
 *  - 输入分流：问句走 ask（threads.dispatch 意图路由 → ask 即时应答，P2 同口径）；明确任务走 quest（立项 → P2）
 *  - 待审批数：approvals.list({status:"pending"}) 10s 轮询（D6「其余」口径）
 *  - ⌘K / Ctrl+K 聚焦输入框；调用失败优雅降级（✗ 回执上屏，输入保留可重试 §9.3）
 *  - 布局协作：经 window 自定义事件 askrail-width 通知 Bridge 预留右侧空间（320px / 56px）
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { ensureDemoLogin, trpc } from "../../lib/trpc";
import { AgentActionMessage, HumanBubble } from "../hud/messages";
import { AIFeedback } from "../AIFeedback";

/** 路由 → 情境快捷钮（前缀匹配；越靠上越优先） */
const CONTEXT_CHIPS: Array<[prefix: string, chips: string[]]> = [
  ["/p22", ["试试知识库检索", "今天工单有什么超时风险"]],
  ["/p10", ["片库脚本进展如何", "本周哪条内容数据最好"]],

  ["/p4", ["这批审批有高危项吗", "汇总今日待审重点"]],
  ["/p2", ["这线程卡在哪一步", "预估剩余积分消耗"]],
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

const RAIL_W = 320;
const RAIL_W_COLLAPSED = 56;

function ClapperIcon({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <rect x="2" y="7" width="20" height="13" rx="2.5" fill="#2a1500" />
      <path d="M3.2 5.4 20.6 3.2l.5 2.6L3.7 8z" fill="#2a1500" />
      <path d="M6.4 4.9l2 2.2M10.6 4.5l2 2.2M14.8 4l2 2.2" stroke="#ffb545" strokeWidth="1.1" />
      <path d="M10.2 11.4v5.6l4.8-2.8z" fill="#ffb545" />
    </svg>
  );
}

/** 布局事件：通知 Bridge 预留右侧空间（同时在 window 落一份当前值，供后挂载的页面初始化读取） */
function emitRailWidth(w: number) {
  (window as unknown as { __askRailW: number }).__askRailW = w;
  window.dispatchEvent(new CustomEvent("askrail-width", { detail: { width: w } }));
}

export function StarRing() {
  const nav = useNavigate();
  const { pathname } = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [msgs, setMsgs] = useState<RingMsg[]>([]);
  const msgSeq = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const chips = CONTEXT_CHIPS.find(([p]) => pathname.startsWith(p))?.[1] ?? DEFAULT_CHIPS;

  /* ---------- 布局协作：挂载/收起状态变化时通知 Bridge ---------- */
  useEffect(() => {
    emitRailWidth(collapsed ? RAIL_W_COLLAPSED : RAIL_W);
    return () => emitRailWidth(0);
  }, [collapsed]);

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
      const r = (await trpc.threads.dispatch.mutate({ title: text, presetKey: "frontdesk-agent" })) as DispatchResult;
      if (r.kind === "clarify") {
        pushMsg({
          role: "agent", action: "航线待确认", receipt: "unverified", refId: r.threadId,
          text: r.question ?? "请补充目标与时间（含糊指令不建任务 F3.2）",
        });
      } else if (isQuestion(text)) {
        if (r.mode === "ask" && r.answer) {
          pushMsg({ role: "agent", action: "AI 助手 · 应答", receipt: "synced", refId: r.threadId, text: r.answer, prompt: text });
        } else {
          pushMsg({
            role: "agent", action: "已转立项处理", receipt: "unverified", refId: r.threadId,
            text: `该问句被路由为任务（${r.mode ?? "quest"}），线程 ${r.threadId ?? "—"} 已建立，可到 P2 任务中心跟进。`,
            linkTo: r.threadId ? `/p2/${encodeURIComponent(r.threadId)}` : undefined,
          });
        }
      } else {
        pushMsg({
          role: "agent", action: "总导演 已接单", receipt: "unverified", refId: r.threadId,
          text: `已立项 ${r.threadId ?? "—"}（状态 ${r.status ?? "queued"}）：「${text}」。点击跳任务中心跟进执行。`,
          linkTo: r.threadId ? `/p2/${encodeURIComponent(r.threadId)}` : undefined,
        });
      }
    } catch (e) {
      setInput(text);
      pushMsg({
        role: "agent", action: "调用失败", receipt: "failed",
        text: `AI 助手连接中断：${e instanceof Error ? e.message : String(e)}。输入已保留，可重试（E1.1 优雅降级）。`,
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

  /* ---------- 收起态：56px 图标条 ---------- */
  if (collapsed) {
    return (
      <div className="fixed inset-y-0 right-0 z-40 flex w-14 flex-col items-center gap-3 border-l border-line bg-bg900/95 py-3 backdrop-blur-md">
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          title="展开 Ask 对话栏"
          className="relative flex h-11 w-11 cursor-pointer items-center justify-center rounded-full gold-grad shadow-[0_0_24px_rgba(255,160,60,.5)]"
        >
          <ClapperIcon />
          {pendingCount > 0 && (
            <span className="absolute -top-1 -right-1 flex h-5 min-w-5 items-center justify-center rounded-full border border-alert/70 bg-alert px-1 font-orb text-micro font-bold text-ink shadow-[0_0_10px_rgba(255,77,109,.7)]">
              {pendingCount}
            </span>
          )}
        </button>
        <div className="text-[10px] tracking-[.25em] text-gold [writing-mode:vertical-rl]">ASK · AI 助手</div>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          className="cursor-pointer rounded border border-line px-1.5 py-1 text-micro text-ink3 hover:border-gline hover:text-gold"
          title="展开（⌘K）"
        >
          ⇤
        </button>
      </div>
    );
  }

  /* ---------- 展开态：320px 通栏对话框 ---------- */
  return (
    <div className="fixed inset-y-0 right-0 z-40 flex w-80 flex-col border-l border-gline/60 bg-bg900/95 shadow-[-20px_0_60px_rgba(0,0,0,.45)] backdrop-blur-md">
      {/* 头部 */}
      <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <span className="flex h-8 w-8 items-center justify-center rounded-full gold-grad shadow-[0_0_16px_rgba(255,160,60,.45)]">
          <ClapperIcon size={18} />
        </span>
        <div className="min-w-0">
          <div className="text-caption font-black tracking-wider text-gold">Ask · AI 助手</div>
          <div className="font-mono text-[10px] text-ink3">{pathname} · 全局常驻</div>
        </div>
        {pendingCount > 0 && (
          <span className="ml-1 flex h-5 min-w-5 items-center justify-center rounded-full border border-alert/70 bg-alert px-1 font-orb text-micro font-bold text-ink">
            {pendingCount}
          </span>
        )}
        <span className="flex-1" />
        <button type="button" onClick={() => nav("/p0")}
          className="cursor-pointer rounded border border-gline px-2 py-0.5 text-micro text-gold hover:bg-card">
          进经营主页 →
        </button>
        <button type="button" onClick={() => setCollapsed(true)}
          title="收起为图标条"
          className="cursor-pointer rounded border border-line px-2 py-0.5 text-micro text-ink3 hover:bg-card">
          ⇥
        </button>
      </div>

      {/* 消息流 */}
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {msgs.length === 0 ? (
          <div className="mt-8 space-y-2 text-center text-caption text-ink3">
            <div className="text-gold/80">有事随时说——问句即时应答（ask）<br />明确任务自动立项（quest）</div>
            <div className="text-micro">点下方情境钮快速开始，或双击标题进经营主页</div>
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
                <a href={m.linkTo} className="ml-1 text-holo underline">→ 任务中心跟进</a>
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
            className="cursor-pointer rounded-md border border-holo/35 bg-holo/5 px-2 py-0.5 text-caption text-holo transition-colors hover:border-gline hover:text-gold"
          >
            ⚡ {c}
          </button>
        ))}
      </div>

      {/* 输入栏 */}
      <div className="px-3 py-3">{inputBar}</div>
    </div>
  );
}

function isQuestion(text: string): boolean {
  return /[?？]$/.test(text) || /吗$|呢$|怎么|如何|什么|哪|几|多少|是否|能不能|可不可以/.test(text);
}
