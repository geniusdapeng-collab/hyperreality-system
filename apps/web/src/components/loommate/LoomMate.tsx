/**
 * LoomMate 织伴 · 24h 贴身小秘书浮层（基座能力，全页面常驻）
 * 形态：甜妹人设（可换人设/音色）· 可爱大眼睛会眨眼（纯 SVG/CSS 零素材）
 *      大/小两种尺寸手动切换（默认大尺寸）· 气泡提醒 · 对话面板 · 记忆透明面板
 * 铁律：不替人决策 / 不打扰（勿扰+聚合）/ 不装在线
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { ensureDemoLogin, trpc } from "../../lib/trpc";
import { VoiceEngine } from "../../voice/VoiceEngine";
import { MateDigitalHuman, type MateMood, type MateGesture } from "./MateDigitalHuman";

/* ---------------- 类型 ---------------- */
interface Settings {
  member_no: string; display_name: string; persona_key: string;
  persona_custom: { name?: string; tone?: string }; voice_key: string; voice_on: boolean;
  widget_size: "small" | "large" | "fullscreen"; quiet_start: string; quiet_end: string;
  channels: { im?: { provider: string; target: string }; outbox_urls?: string[] };
}
interface InboxItem {
  id: string; kind: "judge" | "done" | "alert" | "daily"; level: "red" | "high" | "mid" | "low";
  title: string; body: string; actions: Array<{ label: string; link: string }>; link: string | null;
  status: string; created_at: string;
}
interface MemRow { id: string; layer: string; mkey: string; content: string; source: string; confidence: string; created_at: string }
interface ChatMsg { from: "me" | "mate"; text: string }

const VOICE_MAP: Record<string, { pitch: number; rate: number; female?: boolean }> = {
  sweet: { pitch: 1.25, rate: 1.02, female: true },
  bright: { pitch: 1.15, rate: 1.1, female: true },
  soft: { pitch: 1.05, rate: 0.92, female: true },
  calm: { pitch: 0.9, rate: 0.95 },
};
const PERSONA_NAME: Record<string, string> = { tianmei: "小织", yuanqi: "小元气", chenwen: "织稳" };
const LAYER_TEXT: Record<string, string> = {
  profile: "身份", facts: "事实", preferences: "偏好", relations: "关系", episodic: "情景", working: "进行中",
};
const SOURCE_TEXT: Record<string, string> = { said: "您亲口说的", observed: "观察所得", inferred: "系统推断" };
const LEVEL_STYLE: Record<string, string> = {
  red: "border-alert/60 bg-alert/10", high: "border-gold/50 bg-gold/10",
  mid: "border-gline bg-bg800", low: "border-line bg-bg850",
};

const svc = () => trpc.service as unknown as {
  secretary: {
    settings: { query: () => Promise<{ settings: Settings }> };
    saveSettings: { mutate: (i: Partial<Settings>) => Promise<{ settings: Settings }> };
    scan: { mutate: () => Promise<{ added: number }> };
    inbox: { query: (i?: { unreadOnly: boolean }) => Promise<{ items: InboxItem[] }> };
    markInbox: { mutate: (i: { ids: string[]; status: "read" | "acted" }) => Promise<unknown> };
    reminders: { query: () => Promise<{ reminders: Array<{ id: string; text: string; due_at: string }> }> };
    memoryPanel: { query: () => Promise<{ memory: Record<string, MemRow[]> }> };
    forget: { mutate: (i: { memoryId: string }) => Promise<unknown> };
    chat: { mutate: (i: { text: string }) => Promise<{ reply: string; action?: string; data?: unknown }> };
  };
};

/* ---------------- 甜妹形象（可爱·大眼睛·会眨眼·纯 SVG） ---------------- */
function MateAvatar({ size, excited }: { size: number; excited: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 120 120" className={excited ? "animate-[matewave_0.9s_ease-in-out_infinite]" : "animate-[matebreath_3.2s_ease-in-out_infinite]"}>
      <style>{`
        @keyframes matebreath { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-2.5px) } }
        @keyframes matewave { 0%,100% { transform: rotate(-3deg) } 50% { transform: rotate(3deg) } }
        @keyframes mateblink { 0%,92%,100% { transform: scaleY(1) } 95%,97% { transform: scaleY(0.06) } }
        .mate-eye { transform-origin: center; transform-box: fill-box; animation: mateblink 4.2s infinite; }
      `}</style>
      {/* 发髻小揪揪 */}
      <circle cx="36" cy="26" r="11" fill="#8b5e83" />
      <circle cx="84" cy="26" r="11" fill="#8b5e83" />
      <circle cx="36" cy="26" r="5.5" fill="#e8a0bf" opacity="0.7" />
      <circle cx="84" cy="26" r="5.5" fill="#e8a0bf" opacity="0.7" />
      {/* 头发 */}
      <ellipse cx="60" cy="62" rx="42" ry="44" fill="#8b5e83" />
      {/* 脸 */}
      <ellipse cx="60" cy="66" rx="34" ry="32" fill="#ffe3d6" />
      {/* 刘海 */}
      <path d="M26 58 Q30 30 60 28 Q90 30 94 58 Q86 44 76 46 Q80 38 74 34 Q68 44 60 44 Q52 44 46 34 Q40 38 44 46 Q34 44 26 58Z" fill="#8b5e83" />
      {/* 大眼睛（会眨） */}
      <g className="mate-eye">
        <ellipse cx="46" cy="66" rx="8.5" ry="10.5" fill="#fff" />
        <ellipse cx="46" cy="68" rx="5.5" ry="7.5" fill="#5b3a56" />
        <circle cx="48" cy="65" r="2.6" fill="#fff" />
        <circle cx="43.5" cy="70.5" r="1.3" fill="#fff" opacity="0.8" />
      </g>
      <g className="mate-eye" style={{ animationDelay: "0.08s" }}>
        <ellipse cx="74" cy="66" rx="8.5" ry="10.5" fill="#fff" />
        <ellipse cx="74" cy="68" rx="5.5" ry="7.5" fill="#5b3a56" />
        <circle cx="76" cy="65" r="2.6" fill="#fff" />
        <circle cx="71.5" cy="70.5" r="1.3" fill="#fff" opacity="0.8" />
      </g>
      {/* 睫毛 */}
      <path d="M37 57 Q46 52 55 57" stroke="#5b3a56" strokeWidth="1.8" fill="none" strokeLinecap="round" />
      <path d="M65 57 Q74 52 83 57" stroke="#5b3a56" strokeWidth="1.8" fill="none" strokeLinecap="round" />
      {/* 腮红 */}
      <ellipse cx="37" cy="78" rx="6" ry="3.6" fill="#f9b4c4" opacity="0.75" />
      <ellipse cx="83" cy="78" rx="6" ry="3.6" fill="#f9b4c4" opacity="0.75" />
      {/* 嘴（开心笑） */}
      <path d="M53 80 Q60 87 67 80" stroke="#c2557a" strokeWidth="2.4" fill="none" strokeLinecap="round" />
      {/* 头顶小星星 */}
      <path d="M60 8l1.8 4.2 4.2 1.8-4.2 1.8L60 20l-1.8-4.2L54 14l4.2-1.8z" fill="#ffd97a">
        <animate attributeName="opacity" values="1;0.3;1" dur="1.8s" repeatCount="indefinite" />
      </path>
    </svg>
  );
}

/* ---------------- 主组件 ---------------- */
export function LoomMate() {
  const navigate = useNavigate();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [items, setItems] = useState<InboxItem[]>([]);
  const [open, setOpen] = useState<"none" | "chat" | "settings" | "memory">("none");
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [memory, setMemory] = useState<Record<string, MemRow[]> | null>(null);
  const seenIds = useRef<Set<string>>(new Set());
  const size = settings?.widget_size ?? "large";
  const webglOk = useMemo(() => {
    try {
      const c = document.createElement("canvas");
      return !!(c.getContext("webgl2") ?? c.getContext("webgl"));
    } catch { return false; }
  }, []);
  // 情绪映射（数字人表情）：红线→fear 高等判→neutral+招呼 完成→happy 常态→甜妹 love
  const topItem = items[0];
  const mood: MateMood = topItem?.level === "red" ? "fear"
    : topItem?.kind === "done" ? "happy"
    : topItem ? "neutral"
    : "love";
  const mateGesture: MateGesture = items.length > 0 ? "handup" : null;
  const personaName = settings?.persona_key === "custom"
    ? (settings?.persona_custom?.name ?? "小织")
    : (PERSONA_NAME[settings?.persona_key ?? "tianmei"] ?? "小织");

  const load = useCallback(async () => {
    await ensureDemoLogin();
    const [s, box] = await Promise.all([
      svc().secretary.settings.query().catch(() => null),
      svc().secretary.inbox.query({ unreadOnly: true }).catch(() => ({ items: [] })),
    ]);
    if (s) setSettings(s.settings);
    const fresh = box.items.filter((it) => !seenIds.current.has(it.id));
    for (const it of box.items) seenIds.current.add(it.id);
    setItems(box.items);
    // 新事件语音播报（红线/高，voice_on 才发声；字幕永远发——VoiceEngine 纪律）
    if (s?.settings.voice_on) {
      for (const it of fresh.filter((x) => x.level === "red" || x.level === "high").slice(0, 2)) {
        VoiceEngine.speak({
          role: "loommate", persona: personaName,
          text: `${it.title}。${it.body}`.slice(0, 120),
          priority: it.level === "red" ? "fuse" : "ambient",
          voiceOverride: VOICE_MAP[s.settings.voice_key] ?? VOICE_MAP.sweet,
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personaName]);

  useEffect(() => { void load(); }, [load]);
  // 20s 心跳：先扫描事件源再拉收件箱
  useEffect(() => {
    const h = setInterval(async () => {
      await ensureDemoLogin();
      await svc().secretary.scan.mutate().catch(() => ({ added: 0 }));
      await load();
    }, 20_000);
    return () => clearInterval(h);
  }, [load]);

  const act = async (it: InboxItem) => {
    await svc().secretary.markInbox.mutate({ ids: [it.id], status: "acted" }).catch(() => undefined);
    setItems((prev) => prev.filter((x) => x.id !== it.id));
    if (it.link) navigate(it.link);
  };
  const later = async (it: InboxItem) => {
    await svc().secretary.markInbox.mutate({ ids: [it.id], status: "read" }).catch(() => undefined);
    setItems((prev) => prev.filter((x) => x.id !== it.id));
  };

  const MODE_NEXT: Record<string, "small" | "large" | "fullscreen"> = { small: "large", large: "fullscreen", fullscreen: "small" };
  const MODE_LABEL: Record<string, string> = { small: "变大", large: "全屏", fullscreen: "变小" };
  const toggleSize = async () => {
    const next = MODE_NEXT[size] ?? "large";
    setSettings((s) => s ? { ...s, widget_size: next } : s);
    await svc().secretary.saveSettings.mutate({ widget_size: next }).catch(() => undefined);
  };

  const send = async (text: string) => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setChat((c) => [...c, { from: "me", text }]);
    setInput("");
    try {
      const r = await svc().secretary.chat.mutate({ text });
      setChat((c) => [...c, { from: "mate", text: r.reply }]);
      if (settings?.voice_on) {
        VoiceEngine.speak({
          role: "loommate", persona: personaName, text: r.reply.slice(0, 150),
          priority: "ambient", voiceOverride: VOICE_MAP[settings.voice_key] ?? VOICE_MAP.sweet,
        });
      }
      const link = (r.data as { link?: string } | undefined)?.link;
      if (r.action === "goto" && link) navigate(link);
    } catch (e) {
      setChat((c) => [...c, { from: "mate", text: `呜……信号不太好：${(e as Error).message.slice(0, 60)}` }]);
    } finally { setBusy(false); }
  };

  const openPanel = async (p: "chat" | "settings" | "memory") => {
    setOpen(open === p ? "none" : p);
    if (p === "memory") {
      const m = await svc().secretary.memoryPanel.query().catch(() => null);
      if (m) setMemory(m.memory);
    }
    if (p === "chat" && chat.length === 0) {
      setChat([{ from: "mate", text: `${settings?.display_name ?? "董事长"}好呀～我是${personaName}，您的贴身小秘书！有事叫我查、叫我记、叫我提醒您，都可以哦～` }]);
    }
  };

  const dim = size === "large" ? 480 : 96;
  const unread = items.length;

  // —— 全屏屏保模式：她守着整个场，有事直接喊你 ——
  if (size === "fullscreen") {
    return (
      <div className="fixed inset-0 z-[70] flex flex-col items-center justify-center bg-bg950/98"
        onKeyDown={(e) => { if (e.key === "Escape") void toggleSize(); }} tabIndex={0}
        ref={(el) => el?.focus()}>
        {/* 环境微光背景 */}
        <div className="pointer-events-none absolute inset-0 opacity-30"
          style={{ background: "radial-gradient(ellipse at 50% 62%, rgba(232,160,191,.25), transparent 60%)" }} />
        <button onClick={() => void toggleSize()}
          className="absolute right-5 top-5 rounded-full border border-line bg-bg900/80 px-3 py-1.5 text-[11px] text-ink2 hover:text-ink">
          退出屏保（Esc）
        </button>
        <button onClick={() => void openPanel("chat")} className="relative cursor-pointer transition-transform hover:scale-[1.02]">
          {webglOk
            ? <MateDigitalHuman size={Math.min(520, Math.round((typeof window !== "undefined" ? window.innerHeight : 900) * 0.55))} mood={mood} gesture={mateGesture} />
            : <MateAvatar size={Math.min(520, Math.round((typeof window !== "undefined" ? window.innerHeight : 900) * 0.55))} excited={unread > 0} />}
          {unread > 0 && (
            <span className="absolute right-4 top-4 flex h-10 min-w-10 items-center justify-center rounded-full bg-alert px-2 text-[16px] font-bold text-white shadow-xl">
              {unread}
            </span>
          )}
        </button>
        <div className="mt-3 text-[18px] font-semibold text-ink">{personaName} · 正在照看团队</div>
        <div className="mt-1 text-[12px] text-ink3">点她聊聊 · 有事她会直接喊你</div>
        {/* 红色/高级别事件：屏保中央强提醒 */}
        {items.filter((it) => it.level === "red" || it.level === "high").slice(0, 1).map((it) => (
          <div key={it.id} className={`mt-5 w-[440px] rounded-2xl border p-4 shadow-2xl ${LEVEL_STYLE[it.level]}`}>
            <div className="text-[14px] font-semibold text-ink">{it.level === "red" ? "🚨 " : "🔔 "}{it.title}</div>
            <div className="mt-1 text-[12.5px] leading-relaxed text-ink2">{it.body}</div>
            <div className="mt-2.5 flex gap-2">
              <button onClick={() => void act(it)}
                className="rounded-lg bg-gradient-to-br from-gold to-gold2 px-4 py-1.5 text-[12px] font-semibold text-ongold">
                {it.actions[0]?.label ?? "看看"}
              </button>
              <button onClick={() => void later(it)} className="rounded-lg border border-line px-3 py-1.5 text-[12px] text-ink2">稍后</button>
            </div>
          </div>
        ))}
        {/* 底部团队运行串话条 */}
        <div className="absolute bottom-0 left-0 right-0 border-t border-line bg-bg900/80 px-6 py-2.5 backdrop-blur">
          <div className="flex items-center gap-6 overflow-hidden whitespace-nowrap text-[11.5px] text-ink2">
            <span className="shrink-0 text-gold">● 团队实况</span>
            {items.length === 0 && <span className="animate-pulse">各部门运行正常，一切井然有序……（有事我喊你）</span>}
            {items.slice(0, 6).map((it) => (
              <span key={it.id} className="shrink-0">{it.title} · {it.body.slice(0, 30)}</span>
            ))}
          </div>
        </div>
        {/* 面板（聊/设置/记忆）在全屏态同样可用 */}
        {open !== "none" && (
          <div className="absolute bottom-16 right-5 top-16 w-[340px]">
            <MatePanel
              open={open} setOpen={setOpen} openPanel={openPanel}
              chat={chat} busy={busy} input={input} setInput={setInput} send={send}
              personaName={personaName} settings={settings} setSettings={setSettings}
              memory={memory} setMemory={setMemory}
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="fixed bottom-4 right-4 z-[70] flex flex-col items-end gap-2" style={{ fontFamily: "inherit" }}>
      {/* 气泡提醒（最多叠 3 条） */}
      {open === "none" && items.slice(0, 3).map((it) => (
        <div key={it.id} className={`w-[300px] rounded-2xl border p-3 shadow-xl backdrop-blur ${LEVEL_STYLE[it.level]}`}>
          <div className="flex items-start justify-between gap-2">
            <div className="text-[12.5px] font-semibold text-ink">{it.level === "red" ? "🚨 " : ""}{it.title}</div>
            <button onClick={() => void later(it)} className="shrink-0 text-[10px] text-ink3 hover:text-ink">稍后</button>
          </div>
          <div className="mt-1 text-[11.5px] leading-relaxed text-ink2">{it.body}</div>
          <div className="mt-2 flex gap-1.5">
            <button onClick={() => void act(it)}
              className="rounded-lg bg-gradient-to-br from-gold to-gold2 px-3 py-1 text-[11px] font-semibold text-ongold">
              {it.actions[0]?.label ?? "看看"}
            </button>
          </div>
        </div>
      ))}

      {open !== "none" && (
        <MatePanel
          open={open} setOpen={setOpen} openPanel={openPanel}
          chat={chat} busy={busy} input={input} setInput={setInput} send={send}
          personaName={personaName} settings={settings} setSettings={setSettings}
          memory={memory} setMemory={setMemory}
        />
      )}

      {/* 本体：形象 + 名字 + 尺寸切换 */}
      <div className="flex flex-col items-center">
        <button onClick={() => void openPanel("chat")} className="relative block cursor-pointer transition-transform hover:scale-105" title={`${personaName}（点击聊聊）`}>
          {webglOk
            ? <MateDigitalHuman size={dim} mood={mood} gesture={mateGesture} />
            : <MateAvatar size={dim} excited={unread > 0} />}
          {unread > 0 && (
            <span className="absolute -right-1 -top-1 flex h-6 min-w-6 items-center justify-center rounded-full bg-alert px-1 text-[11px] font-bold text-white shadow-lg">
              {unread}
            </span>
          )}
        </button>
        <div className="mt-0.5 flex items-center gap-1.5">
          <span className={`rounded-full bg-bg900/90 px-2.5 py-0.5 text-ink shadow ${size === "large" ? "text-[12px]" : "text-[10px]"}`}>
            {personaName}
          </span>
          <button onClick={() => void toggleSize()} title="切换大小"
            className="rounded-full border border-line bg-bg900/90 px-1.5 py-0.5 text-[9px] text-ink2 hover:text-ink shadow">
            {MODE_LABEL[size] ?? "变大"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- 展开面板（聊/设置/记忆——角落态与全屏态复用） ---------------- */
function MatePanel({ open, setOpen, openPanel, chat, busy, input, setInput, send, personaName, settings, setSettings, memory, setMemory }: {
  open: "chat" | "settings" | "memory";
  setOpen: (v: "none" | "chat" | "settings" | "memory") => void;
  openPanel: (p: "chat" | "settings" | "memory") => Promise<void>;
  chat: ChatMsg[]; busy: boolean; input: string; setInput: (v: string) => void;
  send: (text: string) => Promise<void>;
  personaName: string; settings: Settings | null;
  setSettings: React.Dispatch<React.SetStateAction<Settings | null>>;
  memory: Record<string, MemRow[]> | null;
  setMemory: React.Dispatch<React.SetStateAction<Record<string, MemRow[]> | null>>;
}) {
  return (
<div className="flex h-[420px] w-[320px] flex-col rounded-2xl border border-gline bg-bg900/95 shadow-2xl backdrop-blur">
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <div className="flex gap-1">
              {([["chat", "聊聊"], ["settings", "设置"], ["memory", "记忆"]] as const).map(([k, label]) => (
                <button key={k} onClick={() => void openPanel(k)}
                  className={`rounded-full px-3 py-1 text-[11px] ${open === k ? "bg-gold/15 text-gold" : "text-ink2 hover:text-ink"}`}>
                  {label}
                </button>
              ))}
            </div>
            <button onClick={() => setOpen("none")} className="text-ink3 hover:text-ink">✕</button>
          </div>
          {open === "chat" && (
            <>
              <div className="flex-1 space-y-2 overflow-y-auto p-3">
                {chat.map((m, i) => (
                  <div key={i} className={m.from === "me" ? "text-right" : ""}>
                    <span className={`inline-block max-w-[85%] rounded-2xl px-3 py-1.5 text-[12px] leading-relaxed ${
                      m.from === "me" ? "bg-gold/15 text-ink" : "bg-bg800 text-ink"}`}>
                      {m.text}
                    </span>
                  </div>
                ))}
                {busy && <div className="text-[11px] text-ink3">{personaName}想ing…</div>}
              </div>
              <div className="border-t border-line p-2">
                <div className="mb-1.5 flex gap-1">
                  {["任务怎么样了", "明早八点提醒我过审批", "找总经理"].map((chip) => (
                    <button key={chip} onClick={() => void send(chip)}
                      className="rounded-full border border-line px-2 py-0.5 text-[10px] text-ink3 hover:text-ink">{chip}</button>
                  ))}
                </div>
                <div className="flex gap-1.5">
                  <input value={input} onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void send(input); }}
                    placeholder={`跟${personaName}说点什么……`}
                    className="flex-1 rounded-full border border-line bg-bg950 px-3 py-1.5 text-[12px] outline-none focus:border-gline" />
                  <button disabled={busy} onClick={() => void send(input)}
                    className="rounded-full bg-gradient-to-br from-gold to-gold2 px-3.5 py-1.5 text-[12px] font-semibold text-ongold disabled:opacity-50">
                    发
                  </button>
                </div>
              </div>
            </>
          )}
          {open === "settings" && settings && (
            <SettingsPanel settings={settings} personaName={personaName}
              onSave={async (patch) => {
                const r = await svc().secretary.saveSettings.mutate(patch);
                setSettings(r.settings);
              }} />
          )}
          {open === "memory" && (
            <div className="flex-1 overflow-y-auto p-3">
              <div className="mb-2 text-[11px] text-ink2">它记住了您什么，全在这里——逐条可删，绝不偷记。</div>
              {memory && Object.entries(memory).map(([layer, rows]) => rows.length > 0 && (
                <div key={layer} className="mb-3">
                  <div className="mb-1 text-[11px] font-semibold text-gold">{LAYER_TEXT[layer] ?? layer}（{rows.length}）</div>
                  {rows.map((r) => (
                    <div key={r.id} className="mb-1 flex items-start justify-between gap-2 rounded-lg bg-bg850 px-2.5 py-1.5">
                      <div>
                        <div className="text-[11.5px] text-ink">{r.content}</div>
                        <div className="text-[9.5px] text-ink3">{SOURCE_TEXT[r.source] ?? r.source}</div>
                      </div>
                      <button onClick={() => {
                        void svc().secretary.forget.mutate({ memoryId: r.id });
                        setMemory((m) => m ? { ...m, [layer]: m[layer]!.filter((x) => x.id !== r.id) } : m);
                      }} className="shrink-0 text-[10px] text-ink3 hover:text-alert">删</button>
                    </div>
                  ))}
                </div>
              ))}
              {memory && Object.values(memory).every((r) => r.length === 0) && (
                <div className="py-8 text-center text-[11px] text-ink3">还是空的呢。对它说「记住：……」就会记在这里。</div>
              )}
            </div>
          )}
        </div>
  );
}

/* ---------------- 设置面板 ---------------- */
function SettingsPanel({ settings, personaName, onSave }: {
  settings: Settings; personaName: string; onSave: (patch: Partial<Settings>) => Promise<void>;
}) {
  const [s, setS] = useState(settings);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS((x) => ({ ...x, [k]: v }));
  return (
    <div className="flex-1 space-y-2.5 overflow-y-auto p-3 text-[12px]">
      <label className="block">
        <span className="text-ink2">它怎么称呼您</span>
        <input value={s.display_name} onChange={(e) => set("display_name", e.target.value)}
          className="mt-0.5 w-full rounded-lg border border-line bg-bg950 px-2.5 py-1.5 outline-none focus:border-gline" />
      </label>
      <div>
        <span className="text-ink2">人设</span>
        <div className="mt-1 grid grid-cols-2 gap-1.5">
          {([["tianmei", "小织 · 甜妹撒娇"], ["yuanqi", "小元气 · 活力满满"], ["chenwen", "织稳 · 沉稳专业"], ["custom", "自定义"]] as const).map(([k, label]) => (
            <button key={k} onClick={() => set("persona_key", k)}
              className={`rounded-lg border px-2 py-1.5 text-[11px] ${s.persona_key === k ? "border-gold text-gold" : "border-line text-ink2"}`}>
              {label}
            </button>
          ))}
        </div>
        {s.persona_key === "custom" && (
          <div className="mt-1.5 space-y-1.5">
            <input value={s.persona_custom?.name ?? ""} placeholder="她的名字"
              onChange={(e) => set("persona_custom", { ...s.persona_custom, name: e.target.value })}
              className="w-full rounded-lg border border-line bg-bg950 px-2.5 py-1.5 outline-none focus:border-gline" />
            <input value={s.persona_custom?.tone ?? ""} placeholder="性格语气（如：毒舌但靠谱）"
              onChange={(e) => set("persona_custom", { ...s.persona_custom, tone: e.target.value })}
              className="w-full rounded-lg border border-line bg-bg950 px-2.5 py-1.5 outline-none focus:border-gline" />
          </div>
        )}
      </div>
      <div>
        <span className="text-ink2">音色</span>
        <div className="mt-1 grid grid-cols-4 gap-1">
          {([["sweet", "甜"], ["bright", "亮"], ["soft", "柔"], ["calm", "稳"]] as const).map(([k, label]) => (
            <button key={k} onClick={() => set("voice_key", k)}
              className={`rounded-lg border px-2 py-1 text-[11px] ${s.voice_key === k ? "border-gold text-gold" : "border-line text-ink2"}`}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div>
        <span className="text-ink2">形态</span>
        <div className="mt-1 grid grid-cols-3 gap-1">
          {([["small", "小角落"], ["large", "大形象"], ["fullscreen", "屏保"]] as const).map(([k, label]) => (
            <button key={k} onClick={() => set("widget_size", k)}
              className={`rounded-lg border px-2 py-1 text-[11px] ${s.widget_size === k ? "border-gold text-gold" : "border-line text-ink2"}`}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-ink2">语音播报</span>
        <button onClick={() => set("voice_on", !s.voice_on)}
          className={`rounded-full px-3 py-1 text-[11px] ${s.voice_on ? "bg-gold/15 text-gold" : "border border-line text-ink3"}`}>
          {s.voice_on ? "开" : "关"}
        </button>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-ink2">勿扰时段</span>
        <div className="flex items-center gap-1">
          <input value={s.quiet_start} onChange={(e) => set("quiet_start", e.target.value)} className="w-14 rounded border border-line bg-bg950 px-1.5 py-1 text-center outline-none" />
          <span className="text-ink3">–</span>
          <input value={s.quiet_end} onChange={(e) => set("quiet_end", e.target.value)} className="w-14 rounded border border-line bg-bg950 px-1.5 py-1 text-center outline-none" />
        </div>
      </div>
      <label className="block">
        <span className="text-ink2">眼镜/IM 桥 outbox URL（secretary.outbox/v1，最多 3 个，逗号分隔）</span>
        <input defaultValue={(s.channels?.outbox_urls ?? []).join(",")}
          onBlur={(e) => set("channels", { ...s.channels, outbox_urls: e.target.value.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 3) })}
          placeholder="https://…（红线与高级别实时推送）"
          className="mt-0.5 w-full rounded-lg border border-line bg-bg950 px-2.5 py-1.5 text-[11px] outline-none focus:border-gline" />
      </label>
      <button onClick={() => void onSave(s)}
        className="w-full rounded-lg bg-gradient-to-br from-gold to-gold2 py-2 text-[12px] font-semibold text-ongold">
        保存（{personaName}立即生效）
      </button>
    </div>
  );
}
