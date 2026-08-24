/**
 * P8 船员名册（F9：通讯录 · 人机混编，Agent 是一等公民 IM.3；PRD P8-①②③④⑤ 逐条对账）
 *  - 人类成员卡（P8E2：圆头像；角色与权限范围展示 经营者/只读/集团；三端权限一致 F5.6；
 *    在线状态=近 24h 事件留痕推导，不伪造 presence）
 *  - Agent 成员卡（P8E1：方头像+版本角标+LV 徽章+段位；围栏绑定 tags；技能包；
 *    30 天工时=动作数/采纳率/积分 · 峰谷占比 G9，全部事件库聚合投影 L6.3；
 *    夜班窗口 22:00–08:00 内 night_shift preset 自动上线·青脉冲（M4）；
 *    只读 preset 标绿无写工具（L9.1）；加载校验失败标红+原因（F2.10 错误态））
 *  - 加装 preset（P8E3 → P7 舰船换装坞，§2.3 行业 Bundle 分发；非管理员无入口 E2.6 隐藏非置灰）
 *  - 员工卡（五层活档案 · 侧滑抽屉，components/p8/EmployeeCardDrawer）：
 *    ①人格层（渐变方块+工种 emoji+人设一句话）②专长层（技能清单+围栏 G 系列章）
 *    ③状态层（当前任务/今日动作数/在线·夜班中，缺则兜底「待命」）
 *    ④成绩单层（EMPLOYEE_SCORECARD 六指标行业口径按 preset_key；captain 端点取数，缺省「本周未出评」）
 *    ⑤记忆层（被驳回样本/校准记录下钻 → P2，缺数据显「暂无」）；操作「@派活」「看记忆」
 *  - 深链 /p8/agent/:id（P1 HostAgent 跳入）：读参数自动展开对应员工卡，读不到则忽略
 * 状态变体：p8 默认 / p8_agent 员工卡展开态；加载=成员卡骨架屏（G10）；空态=仅官方 preset 引导（§2.2）；
 *          权限态=非管理员隐藏「加装/派遣」入口（E2.6）；错误态=preset 校验失败卡片标红（F2.10）
 * 数据：roster.list / roster.profile + captain.theater 评议（PRD P8-⑤；本页无直接写入，派遣走 threads.dispatch）
 * 轮询口径（D6）：名册 10s；员工卡档案细节开卡时拉取
 */
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { ensureDemoLogin, trpc } from "../../lib/trpc";
import { FENCE_LEVEL_TEXT, actionText, dictText } from "../../lib/display";
import { Bridge } from "../../shell/Bridge";
import {
  BannerAlert,
  EmptyState,
  LevelBadge,
  SkeletonBlock,
  XpBar,
} from "../../components/hud";
import { EmployeeCardDrawer } from "../../components/p8/EmployeeCardDrawer";

/* ---------- 类型（与 server roster router 投影对齐） ---------- */
type Rank = "青铜" | "白银" | "黄金" | "铂金" | "星钻";
interface Game { level: number; rank: Rank; xp: number; xpFloor: number; xpNext: number }
interface HumanRow {
  memberNo: string; name: string; role: string; online: boolean;
  stats: { decided30: number; dispatched30: number; settled30: number };
  game: Game;
}
interface AgentRow {
  id: string; presetKey: string; name: string; version: string; kind: string;
  readonly: boolean; status: string; invalidReason: string | null;
  fenceBindings: string[]; skills: string[];
  nightShift: boolean; highRisk: boolean; description: string; online: boolean;
  stats: {
    actions30: number; adopted30: number; rejected30: number;
    adoptionRate: number | null; credits30: number; offPeakRatio: number | null;
  };
  game: Game;
}
interface RosterList {
  nightWindow: { open: boolean; range: string };
  humans: HumanRow[];
  agents: AgentRow[];
}


/** 角色口径（PRD P8 正文：经营者·审批人 / 只读成员 / 集团 Teams；F5.6 三端一致） */
const ROLE_LABEL: Record<string, string> = {
  owner: "经营者 · 审批人",
  manager: "集团 Teams",
  readonly: "只读成员",
  group: "集团",
  channel: "渠道",
};
const ROLE_SCOPE: Record<string, string> = {
  owner: "紧急制动 · 航道立法 · 船员任免（规则手册 §3.1 舰长三权）",
  manager: "跨账号/多工作室继承与审计 · 审批",
  readonly: "只读视图 · 无写入口（E2.6）",
  group: "集团视角",
  channel: "渠道接入",
};

const pct = (r: number | null) => (r === null ? "—" : `${Math.round(r * 100)}%`);

/** 围栏绑定标签（P8E1 卡片 tags：声明即许可 F2.10） */
function FenceBindingTag({ ruleId }: { ruleId: string }) {
  return (
    <span className="rounded border border-holo/30 bg-holo/8 px-1.5 py-0.5 font-mono text-micro text-holo">
      {ruleId}
    </span>
  );
}

/** 人类成员卡（P8E2：圆头像 · 角色/权限摘要 · 在线绿点/离线灰点） */
function HumanCard({ h }: { h: HumanRow }) {
  return (
    <div className="rounded-msg border border-line bg-card p-3.5">
      <div className="flex items-center gap-2.5">
        <div className="flex h-10 w-10 items-center justify-center rounded-full border-2 border-gold/60 bg-gold/10 font-bold text-goldhi">
          {h.name.slice(0, 1)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-body font-bold text-ink">{h.name}</div>
          <div className="truncate text-caption text-ink3">{ROLE_LABEL[h.role] ?? h.role}</div>
        </div>
        <span
          className={`inline-block h-2 w-2 rounded-full ${h.online ? "bg-go shadow-[0_0_8px_rgba(61,255,178,.7)]" : "bg-ink3"}`}
          title={h.online ? "在线（近 24h 有活动留痕）" : "离线"}
        />
      </div>
      <div className="mt-2.5">
        <LevelBadge level={h.game.level} rank={h.game.rank} captain={h.role === "owner"} name={h.name} />
      </div>
      <div className="mt-2 border-t border-line/60 pt-2 text-micro leading-relaxed text-ink3">
        {ROLE_SCOPE[h.role] ?? ""}
        <div className="mt-1 flex gap-3">
          <span>30 天决断 <b className="font-orb text-holo">{h.stats.decided30}</b></span>
          <span>派遣 <b className="font-orb text-holo">{h.stats.dispatched30}</b></span>
          <span>沉淀 <b className="font-orb text-holo">{h.stats.settled30}</b></span>
        </div>
      </div>
    </div>
  );
}

/** Agent 成员卡（P8E1：方头像+版本角标 · LV+段位 · 战绩条 · 工时投影 · 夜班青脉冲） */
function AgentCard({ a, onOpen }: { a: AgentRow; onOpen: (id: string) => void }) {
  const invalid = a.status === "invalid";
  return (
    <button
      type="button"
      onClick={() => onOpen(a.id)}
      className={`cursor-pointer rounded-msg border p-3.5 text-left transition-colors ${
        invalid
          ? "border-alert/60 bg-alert/6 hover:border-alert"
          : a.online
            ? "border-gline bg-gold/6 hover:border-gold"
            : "border-line bg-card hover:border-gline"
      }`}
      title="点击进成员档案（p8_agent，P8E1）"
    >
      <div className="flex items-start gap-2.5">
        <div className="relative shrink-0">
          <div className={`flex h-10 w-10 items-center justify-center rounded-md border-2 font-bold ${
            invalid ? "border-alert/60 bg-alert/10 text-alert" : "border-line bg-bg700 text-ink2"
          }`}>
            {a.name.slice(0, 1)}
          </div>
          <span className="absolute -right-1.5 -bottom-1 rounded border border-line bg-bg900 px-1 font-mono text-[9.5px] text-ink3">
            {a.version}
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-body font-bold text-ink">
            <span className="truncate">{a.name}</span>
            {a.online && (
              <span className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-holo shadow-[0_0_8px_rgba(69,224,255,.8)]" title="夜班在线（M4 窗口内自动上线）" />
            )}
          </div>
          <div className="truncate text-caption text-ink3">
            {invalid
              ? `✗ 校验失败：${a.invalidReason ?? "围栏绑定缺失"}（F2.10）`
              : a.readonly
                ? "只读 preset · 无写工具（L9.1）"
                : a.fenceBindings.length > 0
                  ? `绑 ${a.fenceBindings.join("/")}`
                  : "未声明围栏 · 系统级禁写（F2.10）"}
          </div>
        </div>
      </div>
      {!invalid && (
        <>
          <div className="mt-2.5 flex items-center justify-between">
            <div>
              <span className="font-orb text-body font-bold tracking-wider text-goldhi">LV.{a.game.level}</span>
              <span className="ml-2 text-micro text-holo">{a.game.rank}</span>
            </div>
            <span className={`text-micro ${a.readonly ? "text-go" : "text-ink3"}`}>
              {a.online ? "夜班在线" : a.readonly ? "只读" : "待命"}
            </span>
          </div>
          {/* 战绩条（游戏化展示层，手册 §3 界面叙事；XP=动作×2+积分，确定性推导） */}
          <div className="mt-1.5">
            <XpBar done={a.game.xp - a.game.xpFloor} total={a.game.xpNext - a.game.xpFloor} />
          </div>
          <div className="mt-2 flex items-center gap-1 overflow-hidden">
            {a.fenceBindings.map((r) => <FenceBindingTag key={r} ruleId={r} />)}
            {a.skills.length > 0 && <span className="ml-auto shrink-0 text-micro text-ink3">🎒 {a.skills.length} 技能包</span>}
          </div>
          <div className="mt-2 flex gap-3 border-t border-line/60 pt-2 text-micro text-ink3">
            <span><b className="font-orb text-holo">{a.stats.actions30}</b> 动作</span>
            <span>采纳 <b className="font-orb text-go">{pct(a.stats.adoptionRate)}</b></span>
            <span className="ml-auto"><b className="font-orb text-gold">{a.stats.credits30.toLocaleString()}</b> 币</span>
          </div>
        </>
      )}
      {invalid && (
        <div className="mt-2.5 rounded-md border border-alert/40 bg-alert/8 px-2.5 py-1.5 text-micro text-alert">
          preset 加载校验失败 → 禁写并标红，修复围栏绑定后重新装配（F2.10）
        </div>
      )}
    </button>
  );
}

/* ================= 默认态 p8（+ 员工卡抽屉深链 p8_agent） ================= */
function RosterHome({ expandId }: { expandId: string | null }) {
  const nav = useNavigate();
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [role, setRole] = useState("owner");
  const [data, setData] = useState<RosterList | null>(null);

  const load = useCallback(async () => {
    try {
      await ensureDemoLogin();
      const [meR, list] = await Promise.all([
        trpc.members.me.query() as Promise<{ identity: { role: string } }>,
        trpc.roster.list.query() as Promise<RosterList>,
      ]);
      setRole(meR.identity.role);
      setData(list);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 10_000); // 在线状态实时（IM.3；D6 其余 10s 档）
    return () => clearInterval(t);
  }, [load]);

  const canManage = role === "owner" || role === "manager"; // E2.6：非管理员无「加装/编辑」入口（隐藏非置灰）
  const humans = data?.humans ?? [];
  const agents = data?.agents ?? [];
  const onlineAgents = agents.filter((a) => a.online).length;
  // 深链 /p8/agent/:id：自动展开对应员工卡；读不到（不存在/未加载）则忽略
  const expanded = expandId ? (agents.find((a) => a.id === expandId) ?? null) : null;

  /* 左栏：名册导航 + 在线概览 */
  const left = (
    <>
      <div className="mb-2 px-1 text-[11px] tracking-[.2em] text-ink3">名册 · ROSTER</div>
      <div className="mb-1.5 rounded-lg border border-line bg-card px-3 py-2.5">
        <div className="text-caption font-bold text-ink">人类船员 · {humans.length}</div>
        <div className="mt-0.5 text-micro text-ink3">{humans.filter((h) => h.online).length} 人在线（近 24h 留痕）</div>
      </div>
      <div className="mb-1.5 rounded-lg border border-line bg-card px-3 py-2.5">
        <div className="text-caption font-bold text-ink">Agent 船员 · {agents.length} preset</div>
        <div className="mt-0.5 text-micro text-ink3">
          hyperreality-ai-video 装配 · {data?.nightWindow.open ? `夜班窗口内 ${onlineAgents} 名在线` : "夜班窗口外 · 待命"}
        </div>
      </div>
      <div className="rounded-lg border border-line bg-card px-3 py-2.5 text-micro leading-relaxed text-ink3">
        夜班窗口 {data?.nightWindow.range ?? "22:00–08:00"} 内 night_shift preset 自动上线（M4）；窗口外转待命
      </div>
    </>
  );

  /* 右栏：权限与约束说明（P8-⑤ 权限约束） */
  const right = (
    <>
      <div className="mb-2 px-1 text-[11px] tracking-[.2em] text-ink3">约束 · CONSTRAINTS</div>
      <div className="space-y-2">
        <div className="rounded-lg border border-line bg-card p-3 text-micro leading-relaxed text-ink2">
          <b className="text-holo">Agent 是一等公民（IM.3）</b>
          <div className="mt-1 text-ink3">有身份（Agent ID）、版本（who.version 归因必需）、能力包（技能）、行动权限（围栏授权）与工时（事件投影），与人同列、同群、同协议。</div>
        </div>
        <div className="rounded-lg border border-line bg-card p-3 text-micro leading-relaxed text-ink2">
          <b className="text-holo">未声明 fence_bindings 禁写（F2.10）</b>
          <div className="mt-1 text-ink3">系统级约束，无后门；加载时强制校验，失败卡片标红。</div>
        </div>
        <div className="rounded-lg border border-line bg-card p-3 text-micro leading-relaxed text-ink2">
          <b className="text-holo">三端权限一致（F5.6）</b>
          <div className="mt-1 text-ink3">权限变更走审批留痕（E7.5）；越权入口隐藏非置灰（E2.6）。</div>
        </div>
      </div>
    </>
  );

  return (
    <Bridge left={left} right={right}>
      <div className="flex min-h-full flex-col">
        <div className="mb-3 flex items-baseline gap-3">
          <h2 className="text-h1 font-black tracking-wider">船员名册</h2>
          <span className="text-[11px] tracking-[.2em] text-ink3">P8 · CREW · 人机混编通讯录 IM.3</span>
        </div>

        {failed && (
          <div className="mb-3">
            <BannerAlert level="warn" actionLabel="重试" onAction={() => void load()}>
              名册数据加载失败（连接中断·重连中，不伪造数据）——点击重试
            </BannerAlert>
          </div>
        )}

        {!ready ? (
          <><SkeletonBlock lines={2} h={40} /><SkeletonBlock lines={6} /></>
        ) : humans.length === 0 && agents.length === 0 ? (
          /* 空态（§2.2：新工作区仅行业 Bundle 官方 preset，无其他成员卡片） */
          <EmptyState
            icon="👥"
            title="新工作区暂无成员卡片"
            hint="仅行业 Bundle 官方 preset 可用——从 P7 舰船换装坞装配后此处点亮"
            actionLabel={canManage ? "＋ 加装船员 preset" : undefined}
            onAction={canManage ? () => nav("/p7") : undefined}
          />
        ) : (
          <>
            <div className="mb-2 text-[11px] tracking-[.2em] text-ink3">人类船员 · {humans.length}</div>
            <div className="mb-5 grid grid-cols-3 gap-3">
              {humans.map((h) => <HumanCard key={h.memberNo} h={h} />)}
            </div>

            <div className="mb-2 text-[11px] tracking-[.2em] text-ink3">
              Agent 船员 · {agents.length} preset（hyperreality-ai-video 装配）· 夜班窗口 {data?.nightWindow.range} 自动上线
            </div>
            <div className="grid grid-cols-3 gap-3">
              {agents.map((a) => <AgentCard key={a.id} a={a} onOpen={(id) => nav(`/p8/agent/${encodeURIComponent(id)}`)} />)}
            </div>

            {/* P8E3 加装 preset（→P7 装配台；E2.6 非管理员隐藏） */}
            {canManage && (
              <div className="mt-4 flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => nav("/p7")}
                  className="cursor-pointer rounded-lg gold-grad px-4 py-2 text-caption font-black text-ongold"
                >
                  ＋ 加装船员 preset（→P7 舰船换装坞 §2.3）
                </button>
                <span className="text-micro text-ink3">未声明 fence_bindings 的 Agent 系统级禁写（F2.10）</span>
              </div>
            )}
          </>
        )}


/* ================= 档案态 p8_agent ================= */
function AgentProfilePage({ agentId }: { agentId: string }) {
  const nav = useNavigate();
  const [ready, setReady] = useState(false);
  const [role, setRole] = useState("owner");
  const [p, setP] = useState<Profile | null>(null);
  const [roster, setRoster] = useState<AgentRow[]>([]);
  const [banner, setBanner] = useState<{ level: "alert" | "warn" | "info"; text: string } | null>(null);
  // P8E4 发消息·派遣
  const [goal, setGoal] = useState("");
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    await ensureDemoLogin();
    const [meR, prof, list] = await Promise.all([
      trpc.members.me.query() as Promise<{ identity: { role: string } }>,
      trpc.roster.profile.query({ agentId }) as Promise<Profile | null>,
      trpc.roster.list.query() as Promise<RosterList>,
    ]);
    setRole(meR.identity.role);
    setP(prof);
    setRoster(list.agents);
    setReady(true);
  }, [agentId]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15_000); // 档案事件流 15s（D6）
    return () => clearInterval(t);
  }, [load]);

  /** 发消息·派遣（P8E4：档案页直接建线程；生成前读档案+阶段+目标三要素 L3.7；含糊反问不建任务 F3.2） */
  const dispatch = useCallback(async () => {
    const title = goal.trim();
    if (!title || !p) return;
    setSending(true);
    try {
      const r = await trpc.threads.dispatch.mutate({
        title, presetKey: p.agent.presetKey, runImmediately: false,
      }) as
        | { kind: "clarify"; question: string }
        | { kind: "routed"; threadId: string };
      if (r.kind === "clarify") {
        setBanner({ level: "warn", text: `意图含糊，未建任务（F3.2）：${r.question}` });
      } else {
        nav(`/p2/${encodeURIComponent(r.threadId)}`); // 建单成功 → P2 任务舱
      }
    } finally {
      setSending(false);
    }
  }, [goal, p, nav]);

  const canDispatch = role !== "readonly"; // E2.6：只读成员隐藏派遣入口

  /* 左栏：船员列表（点击切换档案） */
  const left = (
    <>
      <div className="mb-2 px-1 text-[11px] tracking-[.2em] text-ink3">Agent 船员 · AGENTS</div>
      {roster.map((a) => (
        <button
          key={a.id}
          type="button"
          onClick={() => nav(`/p8/agent/${encodeURIComponent(a.id)}`)}
          className={`mb-1.5 flex w-full cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors ${
            a.id === agentId ? "border-gline bg-gold/8" : "border-line bg-card hover:border-gline"
          }`}
        >
          <span className="flex h-6 w-6 items-center justify-center rounded border border-line bg-bg700 text-micro font-bold text-ink2">
            {a.name.slice(0, 1)}
          </span>
          <span className="min-w-0 flex-1 truncate text-caption text-ink2">{a.name}</span>
          <span className="font-mono text-[9.5px] text-ink3">{a.version}</span>
        </button>
      ))}
      <button
        type="button"
        onClick={() => nav("/p8")}
        className="mt-2 w-full cursor-pointer rounded-lg border border-line bg-bg800/50 px-3 py-1.5 text-caption text-ink3 hover:border-gline"
      >
        ← 返回名册
      </button>
    </>
  );

  /* 右栏：运行约束 + 写回声明（P8E1 档案字段） */
  const right = p && (
    <>
      <div className="mb-2 px-1 text-[11px] tracking-[.2em] text-ink3">运行约束 · RUNTIME</div>
      <div className="space-y-2">
        <div className="rounded-lg border border-line bg-card p-3 text-micro leading-relaxed text-ink2">
          <div>· {p.agent.nightShift ? `夜班窗口 ${p.nightWindow.range} 自动上线（M4）` : "非夜班 preset"}</div>
          <div>· {p.agent.highRisk ? "高危动作逐次授权" : "常规风险档"}</div>
          <div>· {p.agent.readonly ? "只读 preset · 无写工具（L9.1）" : "对象写锁（F2.7）"}</div>
          {p.agent.constraints.map((c) => <div key={c}>· {c}</div>)}
        </div>
        <div className="rounded-lg border border-line bg-card p-3 text-micro leading-relaxed text-ink2">
          <b className="text-holo">写回声明</b>
          {p.agent.writeBack.length === 0 ? (
            <div className="mt-1 text-ink3">无写回能力（只读）</div>
          ) : (
            <div className="mt-1 space-y-0.5 font-mono text-ink3">
              {p.agent.writeBack.map((w) => <div key={w}>{w}</div>)}
            </div>
          )}
          <div className="mt-1.5 text-ink3">未声明围栏禁写（系统级 F2.10）</div>
        </div>
      </div>
    </>
  );

  return (
    <Bridge left={left} right={right}>
      <div className="flex min-h-full flex-col">
        {!ready ? (
          <><SkeletonBlock lines={2} h={40} /><SkeletonBlock lines={8} /></>
        ) : !p ? (
          <EmptyState icon="🛰" title="船员不存在或已离舰" hint="返回名册选择其他船员" actionLabel="← 返回名册" onAction={() => nav("/p8")} />
        ) : (
          <>
            <div className="mb-3 flex items-baseline gap-3">
              <h2 className="text-h1 font-black tracking-wider">
                船员档案 · {p.agent.name}
                <span className="ml-2 font-mono text-body font-normal text-holo">{p.agent.version}</span>
              </h2>
              <span className="text-[11px] tracking-[.2em] text-ink3">P8E1 · F2.10/F1.7</span>
            </div>

            {p.agent.status === "invalid" && (
              <div className="mb-3">
                <BannerAlert level="alert">
                  preset 加载校验失败：{p.agent.invalidReason ?? "围栏绑定缺失"}——系统级禁写（F2.10），修复后重新装配
                </BannerAlert>
              </div>
            )}
            {banner && (
              <div className="mb-3">
                <BannerAlert level={banner.level} actionLabel="知道了" onAction={() => setBanner(null)}>{banner.text}</BannerAlert>
              </div>
            )}

            {/* 上排三卡：身份与归属 / 航道许可 / 技能包 */}
            <div className="grid grid-cols-3 gap-3.5">
              <div className="rounded-msg border border-line bg-card p-3.5">
                <div className="mb-2 text-caption font-bold text-holo">身份与归属</div>
                <div className="space-y-1.5 text-caption">
                  <div className="flex justify-between"><span className="text-ink3">Agent ID</span><span className="font-mono text-holo">{p.agent.id}</span></div>
                  <div className="flex justify-between"><span className="text-ink3">版本（who.version 归因）</span><span className="font-mono text-ink2">{p.agent.version}</span></div>
                  <div className="flex justify-between"><span className="text-ink3">工作区</span><span className="text-ink2">{p.workspaceName}</span></div>
                  <div className="flex justify-between"><span className="text-ink3">来源 Bundle</span><span className="text-ink2">{p.bundle}</span></div>
                  <div className="flex justify-between"><span className="text-ink3">战队</span><span className="text-ink2">{p.agent.nightShift ? "守夜战队 · 夜班窗口自动上线" : "日常班组"}</span></div>
                </div>
                <div className="mt-2.5 border-t border-line/60 pt-2">
                  <LevelBadge level={p.game.level} rank={p.game.rank} name={p.agent.name} version={p.agent.version} />
                </div>
              </div>

              <div className="rounded-msg border border-line bg-card p-3.5">
                <div className="mb-2 text-caption font-bold text-holo">航道许可 · 围栏授权（F2.10）</div>
                {p.fences.length === 0 ? (
                  <div className="text-caption text-ink3">未声明 fence_bindings——系统级禁写，仅只读动作可达</div>
                ) : (
                  <div className="space-y-1.5">
                    {p.fences.map((f) => (
                      <div key={f.ruleId} className="flex items-center gap-2 text-caption">
                        <FenceBindingTag ruleId={f.ruleId} />
                        <span className="min-w-0 flex-1 truncate text-ink2">
                          {f.declared ? `${f.name} ${f.version}` : "声明悬空：规则不存在"}
                        </span>
                        <span className={`shrink-0 text-micro ${f.declared ? "text-go" : "text-alert"}`}>
                          {f.declared ? `已声明 · ${dictText(FENCE_LEVEL_TEXT, f.level)}${f.isBaseline ? " 🔒" : ""}` : "✗ 标红"}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="rounded-msg border border-line bg-card p-3.5">
                <div className="mb-2 text-caption font-bold text-holo">装备 · 技能包</div>
                {p.skills.length === 0 ? (
                  <div className="text-caption text-ink3">暂无技能包（→P6 装备库安装）</div>
                ) : (
                  <div className="space-y-1.5">
                    {p.skills.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => nav("/p6")}
                        title="技能包行 → P6 装备库"
                        className="flex w-full cursor-pointer items-center gap-2 rounded-lg border border-line bg-bg800/40 px-2.5 py-1.5 text-left text-caption hover:border-gline"
                      >
                        <span className="min-w-0 flex-1 truncate text-ink2">🎒 {s.name} <span className="font-mono text-micro text-ink3">v{s.version}</span></span>
                        <span className={`shrink-0 text-micro ${s.installed ? "text-go" : "text-warn"}`}>
                          {s.installed ? `已装备 · 绑 ${s.fence_bindings.join("/") || "—"}` : "未安装"}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* 下排：30 天战绩 + 最近事件流 */}
            <div className="mt-3.5 grid grid-cols-[1.2fr_1fr] gap-3.5">
              <div className="rounded-msg border border-line bg-card p-3.5">
                <div className="mb-2 text-caption font-bold text-holo">30 天战绩（事件投影 · L6.3）</div>
                <div className="grid grid-cols-4 gap-2.5">
                  {[
                    ["动作", String(p.stats.actions30), ""],
                    ["采纳率", pct(p.stats.adoptionRate), ""],
                    ["被驳回", String(p.stats.rejected30), ""],
                    ["能量", p.stats.credits30.toLocaleString(), p.stats.offPeakRatio !== null ? `峰谷 ${pct(p.stats.offPeakRatio)}` : ""],
                  ].map(([l, v, d]) => (
                    <div key={l} className="rounded-lg border border-line bg-bg800/40 p-2.5">
                      <div className="text-micro text-ink3">{l}</div>
                      <div className="font-orb text-h1 font-bold text-ink">{v}</div>
                      {d && <div className="text-micro text-gold">{d}</div>}
                    </div>
                  ))}
                </div>
                <div className="mt-2 text-micro text-ink3">
                  驳回原因进偏好模式（F1.7）· 账单=事件投影（L6.3）· 无回执动作标「未核实」（E3.7）
                </div>
                {/* P8E4 发消息·派遣（E2.6：只读成员隐藏） */}
                {canDispatch && (
                  <div className="mt-3">
                    <textarea
                      value={goal}
                      onChange={(e) => setGoal(e.target.value)}
                      rows={2}
                      placeholder={`向 ${p.agent.name} 派遣任务（生成前读档案+阶段+目标三要素 L3.7；含糊将反问不建单 F3.2）`}
                      className="w-full rounded-lg border border-line bg-bg800 px-2.5 py-2 text-body text-ink outline-none placeholder:text-ink3 focus:border-gline"
                    />
                    <button
                      type="button"
                      disabled={!goal.trim() || sending}
                      onClick={() => void dispatch()}
                      className="mt-2 cursor-pointer rounded-lg gold-grad px-4 py-2 text-caption font-black text-ongold disabled:opacity-40"
                    >
                      💬 发消息 · 派遣任务（→P2 任务舱 F3.1）
                    </button>
                  </div>
                )}
              </div>

              <div className="rounded-msg border border-line bg-card p-3.5">
                <div className="mb-2 text-caption font-bold text-holo">最近动作事件流（点击进线程 → P2 · F1.12）</div>
                {p.events.length === 0 ? (
                  <div className="text-caption text-ink3">近 30 天无动作留痕</div>
                ) : (
                  <div className="space-y-1.5">
                    {p.events.map((e) => (
                      <button
                        key={e.eventId}
                        type="button"
                        onClick={() => e.sessionId?.startsWith("T-") && nav(`/p2/${encodeURIComponent(e.sessionId)}`)}
                        title={e.sessionId ? `进线程 ${e.sessionId} → P2（决策链路 F1.12）` : "无线程上下文"}
                        className="flex w-full cursor-pointer items-center gap-2 rounded-lg border-l-2 border-line bg-bg800/30 px-2.5 py-1.5 text-left hover:border-l-gold"
                      >
                        <EventIdChip id={e.eventId} />
                        <span className="min-w-0 flex-1 truncate text-caption text-ink2">
                          {actionText(e.action)}
                          {e.ruleResults.length > 0 && <span className="ml-1 text-micro text-warn">{e.ruleResults.join(" ")}</span>}
                        </span>
                        <span className={`shrink-0 text-micro ${e.receiptSynced ? "text-go" : "text-warn"}`}>
                          {e.receiptSynced ? "✓ 回执" : "未核实"}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </Bridge>
  );
}

/** P8 入口：/p8 名册；/p8/agent/:agentId 深链自动展开员工卡（读不到则忽略，留在名册） */
export default function P8() {
  const { agentId } = useParams<{ agentId: string }>();
  return <RosterHome expandId={agentId ?? null} />;
}
