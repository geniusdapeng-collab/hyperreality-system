/**
 * P8 团队成员（F9：通讯录 · 人机混编，Agent 是一等公民 IM.3；PRD P8-①②③④⑤ 逐条对账）
 *  - 人类成员卡（P8E2：圆头像；角色与权限范围展示 经营者/只读/集团；三端权限一致 F5.6；
 *    在线状态=近 24h 事件留痕推导，不伪造 presence）
 *  - Agent 成员卡（P8E1：方头像+版本角标+LV 徽章+段位；围栏绑定 tags；技能包；
 *    30 天工时=动作数/采纳率/积分 · 峰谷占比 G9，全部事件库聚合投影 L6.3；
 *    夜班窗口 22:00–08:00 内 night_shift preset 自动上线·青脉冲（M4）；
 *    只读 preset 标绿无写工具（L9.1）；加载校验失败标红+原因（F2.10 错误态））
 *  - 加装员工（P8E3 → P7 装配中心，§2.3 行业 Bundle 分发；非管理员无入口 E2.6 隐藏非置灰）
 *  - 成员档案 p8_agent（P8E1 点击进档案）：身份与归属（Agent ID/版本 who.version 归因必需/工作区/来源 Bundle）/
 *    航道许可围栏授权（P8E1·F2.10 声明对账，悬空标红）/技能包（→P6）/运行约束/
 *    30 天战绩（动作/采纳率/被驳回/积分·峰谷，驳回原因进偏好模式 F1.7）/
 *    发消息·派遣（P8E4：档案页直接建线程 → P2，生成前读档案+阶段+目标三要素 L3.7）/
 *    最近动作事件流（P8E5：who.id 过滤投影，点击进对应任务线程 → P2，可展开决策链路 F1.12）
 * 状态变体：p8 默认 / p8_agent 档案态；加载=成员卡骨架屏（G10）；空态=仅官方 preset 引导（§2.2）；
 *          权限态=非管理员隐藏「加装/派遣」入口（E2.6）；错误态=preset 校验失败卡片标红（F2.10）
 * 数据：roster.list / roster.profile（PRD P8-⑤：成员+preset 注册表投影 + 工时聚合 + who.id 事件流投影；本页无直接写入）
 * 轮询口径（D6）：名册 10s，档案事件流 15s
 */
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { ensureDemoLogin, trpc } from "../../lib/trpc";
import { displayNameOf, setAliasLocal } from "../../lib/naming";
import { AgentAvatarOf } from "../../components/AgentAvatar";
import { FENCE_LEVEL_TEXT, RULE_RESULT_TEXT, actionText, capabilityText, dictText, shortId, versionText } from "../../lib/display";
import { Bridge } from "../../shell/Bridge";
import { Button, Icon, Overlay, clientChineseText } from "@workloom/ui";
import {
  BannerAlert,
  EmptyState,
  EventIdChip,
  LevelBadge,
  Skeleton,
  XpBar,
} from "../../components/hud";
import { useNavigationAccess } from "../../shell/NavigationAccess";

/* ---------- 类型（与 server roster router 投影对齐） ---------- */
type Rank = "青铜" | "白银" | "黄金" | "铂金" | "星钻";
interface Game { level: number; rank: Rank; xp: number; xpFloor: number; xpNext: number }
interface HumanRow {
  memberNo: string; name: string; role: string; online: boolean;
  stats: { decided30: number; dispatched30: number; settled30: number };
  game: Game;
}
interface AgentRow {
  id: string; presetKey: string; name: string; alias?: string | null; version: string; kind: string;
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
interface Profile {
  agent: {
    id: string; presetKey: string; name: string; alias?: string | null; version: string; kind: string;
    readonly: boolean; status: string; invalidReason: string | null;
    description: string; nightShift: boolean; highRisk: boolean;
    tools: Array<{ name: string; access: string; desc: string }>;
    writeBack: string[]; constraints: string[];
  };
  workspaceName: string; bundle: string;
  nightWindow: { open: boolean; range: string };
  fences: Array<{ ruleId: string; name?: string; level?: string; version?: string; isBaseline?: boolean; declared: boolean }>;
  skills: Array<{ id: string; name: string; level: string; version: string; fence_bindings: string[]; installed: boolean }>;
  stats: AgentRow["stats"];
  game: Game;
  events: Array<{
    eventId: string; sessionId: string | null; time: string;
    action: string; objectType: string; ruleResults: string[]; receiptSynced: boolean;
  }>;
}

/** 角色口径（PRD P8 正文：经营者·审批人 / 只读成员 / 集团 Teams；F5.6 三端一致） */
const ROLE_LABEL: Record<string, string> = {
  owner: "经营者 · 审批人",
  manager: "工作区管理员",
  staff: "工作区成员",
  readonly: "只读成员",
  group: "集团",
  channel: "渠道",
};
const ROLE_SCOPE: Record<string, string> = {
  owner: "紧急制动 · 规则制定 · 成员任免",
  manager: "跨店继承与审计 · 审批",
  readonly: "只读视图 · 无写入口",
  group: "集团视角",
  channel: "渠道接入",
};

const pct = (r: number | null) => (r === null ? "—" : `${Math.round(r * 100)}%`);

/** 围栏绑定标签（P8E1 卡片 tags：声明即许可 F2.10） */
function FenceBindingTag({ label }: { label: string }) {
  return (
    <span className="rounded border border-holo/30 bg-holo/8 px-1.5 py-0.5 font-mono text-body text-holo">
      {label}
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
          <div className="break-words text-body text-ink3">{ROLE_LABEL[h.role] ?? "工作区成员"}</div>
        </div>
        <span
          className={`inline-block h-2 w-2 rounded-full ${h.online ? "bg-go shadow-[0_0_8px_rgba(34,200,138,.7)]" : "bg-ink3"}`}
          title={h.online ? "在线（近 24h 有活动留痕）" : "离线"}
        />
      </div>
      <div className="mt-2.5">
        <LevelBadge level={h.game.level} rank={h.game.rank} captain={h.role === "owner"} name={h.name} />
      </div>
      <div className="mt-2 border-t border-line/60 pt-2 text-body leading-relaxed text-ink3">
        {ROLE_SCOPE[h.role] ?? ""}
        <div className="mt-1 flex gap-3">
          <span>30 天审批 <b className="font-orb text-holo">{h.stats.decided30}</b></span>
          <span>派遣 <b className="font-orb text-holo">{h.stats.dispatched30}</b></span>
          <span>沉淀 <b className="font-orb text-holo">{h.stats.settled30}</b></span>
        </div>
      </div>
    </div>
  );
}

/** Agent 成员卡（P8E1：方头像+版本角标 · LV+段位 · 战绩条 · 工时投影 · 夜班青脉冲） */
function AgentCard({ a, canManage, onOpen }: { a: AgentRow; canManage: boolean; onOpen: (id: string) => void }) {
  const invalid = a.status === "invalid";
  const displayName = displayNameOf({ presetKey: a.presetKey, roleName: a.name });
  const [aliasOpen, setAliasOpen] = useState(false);
  const [alias, setAlias] = useState(displayName === a.name ? "" : displayName);
  const [aliasBusy, setAliasBusy] = useState(false);
  const [aliasError, setAliasError] = useState("");

  const saveAlias = async () => {
    if (!canManage) return;
    setAliasBusy(true);
    setAliasError("");
    try {
      await (trpc.members as unknown as { updateAlias: { mutate: (i: { memberNo: string; presetKey: string; alias: string | null }) => Promise<unknown> } })
        .updateAlias.mutate({ memberNo: a.id, presetKey: a.presetKey, alias: alias.trim() || null });
      setAliasLocal(a.presetKey, alias.trim() || null);
      setAliasOpen(false);
      window.location.reload();
    } catch (error) {
      console.warn("更新数字员工别名失败", error);
      setAliasError("暂时无法保存别名，请稍后重试。");
    } finally {
      setAliasBusy(false);
    }
  };

  return (
    <article
      className={`rounded-msg border p-3.5 text-left transition-colors ${
        invalid
          ? "border-alert/60 bg-alert/6 hover:border-alert"
          : a.online
            ? "border-gline bg-gold/6 hover:border-gold"
            : "border-line bg-card hover:border-gline"
      }`}
    >
      <div className="flex items-start gap-2.5">
        <div className="relative shrink-0">
          {/* 数字人统一形象（与 3D 职场同源角色——认得出"世界里的他"） */}
          <div className={`flex h-10 w-10 items-center justify-center rounded-md border-2 ${
            invalid ? "border-alert/60 bg-alert/10" : "border-line bg-bg700"
          }`}>
            <AgentAvatarOf name={displayName} presetKey={a.presetKey} size={30} ring={false} />
          </div>
          <span className="absolute -right-1.5 -bottom-1 rounded border border-line bg-bg900 px-1 font-mono text-body text-ink3">
            {versionText(a.version)}
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-body font-bold text-ink">
            <span className="min-w-0 break-words">{displayName}</span>
            {canManage && <button
              type="button"
              title="设置显示别名；岗位名称不会改变"
              className="shrink-0 rounded border border-line px-1.5 py-0.5 text-body text-ink3 hover:border-gline hover:text-ink"
              onClick={() => setAliasOpen(true)}
            >修改别名</button>}
            {a.online && (
              <span className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-holo shadow-[0_0_8px_rgba(77,150,255,.8)]" title="夜班窗口内自动上线" />
            )}
          </div>
          <div className="break-words text-body text-ink3">
            {invalid
              ? `校验失败：${clientChineseText(a.invalidReason, "围栏绑定缺失")}`
              : a.readonly
                ? "只读岗位 · 无写入工具"
                : a.fenceBindings.length > 0
                  ? `已关联 ${a.fenceBindings.length} 条围栏`
                  : "未声明围栏 · 写操作已被系统阻断"}
          </div>
        </div>
      </div>
      {!invalid && (
        <>
          <div className="mt-2.5 flex items-center justify-between">
            <div>
              <span className="font-orb text-body font-bold tracking-wider text-goldhi">等级 {a.game.level}</span>
              <span className="ml-2 text-body text-holo">{a.game.rank}</span>
            </div>
            <span className={`text-body ${a.readonly ? "text-go" : "text-ink3"}`}>
              {a.online ? "夜班在线" : a.readonly ? "只读" : "待命"}
            </span>
          </div>
          {/* 战绩条（游戏化展示层，手册 §3 界面叙事；XP=动作×2+积分，确定性推导） */}
          <div className="mt-1.5">
            <XpBar done={a.game.xp - a.game.xpFloor} total={a.game.xpNext - a.game.xpFloor} />
          </div>
          <div className="mt-2 flex items-center gap-1 overflow-hidden">
            {a.fenceBindings.slice(0, 2).map((r, index) => <FenceBindingTag key={r} label={`关联围栏 ${index + 1}`} />)}
            {a.skills.length > 0 && <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-body text-ink3"><Icon name="package" size={13} />{a.skills.length} 技能包</span>}
          </div>
          <div className="mt-2 flex gap-3 border-t border-line/60 pt-2 text-body text-ink3">
            <span><b className="font-orb text-holo">{a.stats.actions30}</b> 动作</span>
            <span>采纳 <b className="font-orb text-go">{pct(a.stats.adoptionRate)}</b></span>
            <span className="ml-auto"><b className="font-orb text-gold">{a.stats.credits30.toLocaleString()}</b> 币</span>
          </div>
        </>
      )}
      {invalid && (
        <div className="mt-2.5 rounded-md border border-alert/40 bg-alert/8 px-2.5 py-1.5 text-body text-alert">
          岗位配置校验失败 → 写操作已被阻断，请修复围栏绑定后重新装配
        </div>
      )}
      <div className="mt-3 flex justify-end">
        <Button variant="quiet" onClick={() => onOpen(a.id)}>查看成员档案</Button>
      </div>
      <Overlay
        open={canManage && aliasOpen}
        title={`修改「${displayName}」的显示别名`}
        description="留空并保存可恢复岗位名称；这不会改变岗位能力和权限。"
        onClose={() => { if (!aliasBusy) { setAliasOpen(false); setAliasError(""); } }}
        dismissOnBackdrop={!aliasBusy}
        dismissOnEscape={!aliasBusy}
        footer={(
          <>
            <Button variant="primary" busy={aliasBusy} onClick={() => void saveAlias()}>保存别名</Button>
            <Button disabled={aliasBusy} onClick={() => setAliasOpen(false)}>取消</Button>
          </>
        )}
      >
        <label className="block text-body text-ink2">
          显示别名
          <input value={alias} onChange={(event) => setAlias(event.target.value)} maxLength={24}
            className="mt-2 w-full rounded-lg border border-line bg-bg900 px-3 py-2 text-body text-ink" />
        </label>
        {aliasError && <p className="mt-2 text-body text-alert" role="alert">{aliasError}</p>}
      </Overlay>
    </article>
  );
}

/* ================= 默认态 p8 ================= */
function RosterHome() {
  const { canAction } = useNavigationAccess();
  const nav = useNavigate();
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [data, setData] = useState<RosterList | null>(null);

  const load = useCallback(async () => {
    try {
      await ensureDemoLogin();
      const list = await trpc.roster.list.query() as RosterList;
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

  const canManage = canAction("agent.manage");
  const humans = data?.humans ?? [];
  const agents = data?.agents ?? [];
  const onlineAgents = agents.filter((a) => a.online).length;

  /* 左栏：名册导航 + 在线概览 */
  const left = (
    <>
      <div className="mb-2 px-1 text-body tracking-[.2em] text-ink3">团队概览</div>
      <div className="mb-1.5 rounded-lg border border-line bg-card px-3 py-2.5">
        <div className="text-body font-bold text-ink">人类成员 · {humans.length}</div>
        <div className="mt-0.5 text-body text-ink3">{humans.filter((h) => h.online).length} 人在线（近 24h 留痕）</div>
      </div>
      <div className="mb-1.5 rounded-lg border border-line bg-card px-3 py-2.5">
        <div className="text-body font-bold text-ink">数字员工 · {agents.length} 个岗位</div>
        <div className="mt-0.5 text-body text-ink3">
          当前行业包装配 · {data?.nightWindow.open ? `夜班窗口内 ${onlineAgents} 名在线` : "夜班窗口外 · 待命"}
        </div>
      </div>
      <div className="rounded-lg border border-line bg-card px-3 py-2.5 text-body leading-relaxed text-ink3">
        夜班岗位会在 {data?.nightWindow.range ?? "22:00–08:00"} 自动上线，窗口外转为待命
      </div>
    </>
  );

  /* 右栏：权限与约束说明（P8-⑤ 权限约束） */
  const right = (
    <>
      <div className="mb-2 px-1 text-body tracking-[.2em] text-ink3">治理约束</div>
      <div className="space-y-2">
        <div className="rounded-lg border border-line bg-card p-3 text-body leading-relaxed text-ink2">
          <b className="text-holo">数字员工是正式组织成员</b>
          <div className="mt-1 text-ink3">每位数字员工都有可追溯身份、版本、技能、围栏授权与工作记录，与人类成员使用同一套协作协议。</div>
        </div>
        <div className="rounded-lg border border-line bg-card p-3 text-body leading-relaxed text-ink2">
          <b className="text-holo">未声明关联围栏时禁止写入</b>
          <div className="mt-1 text-ink3">系统级约束，无后门；加载时强制校验，失败卡片标红。</div>
        </div>
        <div className="rounded-lg border border-line bg-card p-3 text-body leading-relaxed text-ink2">
          <b className="text-holo">三端权限保持一致</b>
          <div className="mt-1 text-ink3">权限变更必须审批并留痕；无权使用的入口不会显示。</div>
        </div>
      </div>
    </>
  );

  return (
    <Bridge left={left} right={right}>
      <div className="flex min-h-full flex-col">
        <div className="mb-3 flex flex-wrap items-baseline gap-3">
          <h2 className="text-h1 font-black tracking-wider">团队成员</h2>
          <span className="text-body tracking-[.2em] text-ink3">人机混编通讯录</span>
        </div>

        {failed && (
          <div className="mb-3">
            <BannerAlert level="warn" actionLabel="重试" onAction={() => void load()}>
              团队成员数据加载失败（连接中断·重连中，不伪造数据）——点击重试
            </BannerAlert>
          </div>
        )}

        {!ready ? (
          <><Skeleton count={2} height={40} label="团队摘要正在加载" /><Skeleton count={6} label="团队列表正在加载" /></>
        ) : humans.length === 0 && agents.length === 0 ? (
          /* 空态（§2.2：新工作区仅行业 Bundle 官方 preset，无其他成员卡片） */
          <EmptyState
            icon={<Icon name="team" size={24} />}
            title="新工作区暂无成员卡片"
            hint="从装配中心启用行业官方员工包后，成员会显示在这里。"
            actionLabel={canManage ? "加装成员岗位" : undefined}
            onAction={canManage ? () => nav("/assembly") : undefined}
          />
        ) : (
          <>
            <div className="mb-2 text-body tracking-[.2em] text-ink3">人类成员 · {humans.length}</div>
            <div className="mb-5 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {humans.map((h) => <HumanCard key={h.memberNo} h={h} />)}
            </div>

            <div className="mb-2 text-body tracking-[.2em] text-ink3">
              数字员工 · {agents.length} 个岗位 · 夜班岗位在 {data?.nightWindow.range} 自动上线
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {agents.map((a) => <AgentCard key={a.id} a={a} canManage={canManage} onOpen={(id) => nav(`/agents/${encodeURIComponent(id)}`)} />)}
            </div>

            {/* P8E3 加装员工（→P7 装配台；E2.6 非管理员隐藏） */}
            {canManage && (
              <div className="wl-action-row mt-4 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => nav("/assembly")}
                  className="cursor-pointer rounded-lg gold-grad px-4 py-2 text-body font-black text-ongold"
                >
                  <span className="inline-flex items-center gap-1"><Icon name="partner" size={15} aria-hidden="true" />加装数字员工岗位</span>
                </button>
                <span className="text-body text-ink3">未声明关联围栏的数字员工，其写操作会被系统阻断。</span>
              </div>
            )}
          </>
        )}
      </div>
    </Bridge>
  );
}

/* ================= 档案态 p8_agent ================= */
function AgentProfilePage({ agentId }: { agentId: string }) {
  const { canAction } = useNavigationAccess();
  const nav = useNavigate();
  const [ready, setReady] = useState(false);
  const [p, setP] = useState<Profile | null>(null);
  const [roster, setRoster] = useState<AgentRow[]>([]);
  const [banner, setBanner] = useState<{ level: "alert" | "warn" | "info"; text: string } | null>(null);
  // P8E4 发消息·派遣
  const [goal, setGoal] = useState("");
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    await ensureDemoLogin();
    const [prof, list] = await Promise.all([
      trpc.roster.profile.query({ agentId }) as Promise<Profile | null>,
      trpc.roster.list.query() as Promise<RosterList>,
    ]);
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
        setBanner({ level: "warn", text: `目标还不够明确，因此没有创建任务：${clientChineseText(r.question, "请补充目标、对象和期望完成时间。")}` });
      } else {
        nav(`/tasks/${encodeURIComponent(r.threadId)}`); // 建单成功 → 任务详情
      }
    } finally {
      setSending(false);
    }
  }, [goal, p, nav]);

  const canDispatch = canAction("task.dispatch");

  /* 左栏：船员列表（点击切换档案） */
  const left = (
    <>
      <div className="mb-2 px-1 text-body tracking-[.2em] text-ink3">数字员工</div>
      {roster.map((a) => (
        <button
          key={a.id}
          type="button"
          onClick={() => nav(`/agents/${encodeURIComponent(a.id)}`)}
          className={`mb-1.5 flex w-full cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors ${
            a.id === agentId ? "border-gline bg-gold/8" : "border-line bg-card hover:border-gline"
          }`}
        >
          <span className="flex h-6 w-6 items-center justify-center rounded border border-line bg-bg700 text-body font-bold text-ink2">
            {displayNameOf({ presetKey: a.presetKey, roleName: a.name }).slice(0, 1)}
          </span>
          <span className="min-w-0 flex-1 break-words text-body text-ink2">{displayNameOf({ presetKey: a.presetKey, roleName: a.name })}</span>
          <span className="text-body text-ink3">{versionText(a.version)}</span>
        </button>
      ))}
      <button
        type="button"
        onClick={() => nav("/agents")}
        className="mt-2 w-full cursor-pointer rounded-lg border border-line bg-bg800/50 px-3 py-1.5 text-body text-ink3 hover:border-gline"
      >
        ← 返回团队成员
      </button>
    </>
  );

  /* 右栏：运行约束 + 写回声明（P8E1 档案字段） */
  const right = p && (
    <>
      <div className="mb-2 px-1 text-body tracking-[.2em] text-ink3">运行约束</div>
      <div className="space-y-2">
        <div className="rounded-lg border border-line bg-card p-3 text-body leading-relaxed text-ink2">
          <div>· {p.agent.nightShift ? `夜班窗口 ${p.nightWindow.range} 自动上线` : "日常岗位"}</div>
          <div>· {p.agent.highRisk ? "高危动作逐次授权" : "常规风险档"}</div>
          <div>· {p.agent.readonly ? "只读岗位 · 无写入工具" : "同一业务对象的写入操作会自动加锁"}</div>
          {p.agent.constraints.map((c) => <div key={c}>· {clientChineseText(c, "由行业包声明的运行约束")}</div>)}
        </div>
        <div className="rounded-lg border border-line bg-card p-3 text-body leading-relaxed text-ink2">
          <b className="text-holo">写回声明</b>
          {p.agent.writeBack.length === 0 ? (
            <div className="mt-1 text-ink3">无写回能力（只读）</div>
          ) : (
            <div className="mt-1 space-y-0.5 font-mono text-ink3">
              {p.agent.writeBack.map((w) => <div key={w}>{capabilityText(w)}</div>)}
            </div>
          )}
          <div className="mt-1.5 text-ink3">未声明关联围栏时，写操作会被系统阻断。</div>
        </div>
      </div>
    </>
  );

  return (
    <Bridge left={left} right={right}>
      <div className="flex min-h-full flex-col">
        {!ready ? (
          <><Skeleton count={2} height={40} label="成员摘要正在加载" /><Skeleton count={8} label="成员详情正在加载" /></>
        ) : !p ? (
          <EmptyState icon={<Icon name="agents" size={24} />} title="成员不存在或已停用" hint="返回团队成员选择其他成员" actionLabel="← 返回团队成员" onAction={() => nav("/agents")} />
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-baseline gap-3">
              <h2 className="text-h1 font-black tracking-wider">
                成员档案 · {displayNameOf({ presetKey: p.agent.presetKey, roleName: p.agent.name })}
                <span className="ml-2 text-body font-normal text-holo">{versionText(p.agent.version)}</span>
              </h2>
              <span className="text-body tracking-[.2em] text-ink3">身份、能力、权限与工作记录</span>
            </div>

            {p.agent.status === "invalid" && (
              <div className="mb-3">
                <BannerAlert level="alert">
                  岗位配置校验失败：{clientChineseText(p.agent.invalidReason, "围栏绑定缺失")}。写操作已被系统阻断，请修复后重新装配。
                </BannerAlert>
              </div>
            )}
            {banner && (
              <div className="mb-3">
                <BannerAlert level={banner.level} actionLabel="知道了" onAction={() => setBanner(null)}>{banner.text}</BannerAlert>
              </div>
            )}

            {/* 上排三卡：身份与归属 / 规则许可 / 技能包 */}
            <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-2 xl:grid-cols-3">
              <div className="rounded-msg border border-line bg-card p-3.5">
                <div className="mb-2 text-body font-bold text-holo">身份与归属</div>
                <div className="space-y-1.5 text-body">
                  <div className="flex justify-between gap-3"><span className="text-ink3">员工编号</span><span className="font-mono text-holo">{shortId(p.agent.id)}</span></div>
                  <div className="flex justify-between gap-3"><span className="text-ink3">运行版本</span><span className="text-ink2">{versionText(p.agent.version)}</span></div>
                  <div className="flex justify-between"><span className="text-ink3">工作区</span><span className="text-ink2">{p.workspaceName}</span></div>
                  <div className="flex justify-between gap-3"><span className="text-ink3">来源行业包</span><span className="text-ink2">{clientChineseText(p.bundle, "当前行业包")}</span></div>
                  <div className="flex justify-between"><span className="text-ink3">战队</span><span className="text-ink2">{p.agent.nightShift ? "夜班中心 · 夜班窗口自动上线" : "日常班组"}</span></div>
                </div>
                <div className="mt-2.5 border-t border-line/60 pt-2">
                  <LevelBadge level={p.game.level} rank={p.game.rank} name={displayNameOf({ presetKey: p.agent.presetKey, roleName: p.agent.name })} version={p.agent.version} />
                </div>
              </div>

              <div className="rounded-msg border border-line bg-card p-3.5">
                <div className="mb-2 text-body font-bold text-holo">规则许可 · 围栏授权</div>
                {p.fences.length === 0 ? (
                  <div className="text-body text-ink3">未声明关联围栏——写操作已被系统阻断，仅允许只读动作。</div>
                ) : (
                  <div className="space-y-1.5">
                    {p.fences.map((f) => (
                      <div key={f.ruleId} className="flex items-center gap-2 text-body">
                        <FenceBindingTag label={clientChineseText(f.name, "关联围栏")} />
                        <span className="min-w-0 flex-1 break-words text-ink2">
                          {f.declared ? `${clientChineseText(f.name, "关联围栏")} ${versionText(f.version)}` : "声明悬空：规则不存在"}
                        </span>
                        <span className={`inline-flex shrink-0 items-center gap-1 text-body ${f.declared ? "text-go" : "text-alert"}`}>
                          {f.declared ? <>{f.isBaseline && <Icon name="lock" size={13} />}已声明 · {dictText(FENCE_LEVEL_TEXT, f.level)}</> : <><Icon name="error" size={13} />标红</>}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="rounded-msg border border-line bg-card p-3.5">
                <div className="mb-2 text-body font-bold text-holo">装备 · 技能包</div>
                {p.skills.length === 0 ? (
                  <div className="text-body text-ink3">暂无技能包，可前往技能中心安装。</div>
                ) : (
                  <div className="space-y-1.5">
                    {p.skills.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => nav("/skills")}
                        title="前往技能中心"
                        className="flex w-full min-w-0 cursor-pointer flex-wrap items-center gap-2 rounded-lg border border-line bg-bg800/40 px-2.5 py-1.5 text-left text-body hover:border-gline"
                      >
                        <span className="flex min-w-0 flex-1 items-center gap-1 break-words text-ink2"><Icon name="package" size={13} className="shrink-0" /> {clientChineseText(s.name, "技能能力")} <span className="text-body text-ink3">{versionText(s.version)}</span></span>
                        <span className={`shrink-0 text-body ${s.installed ? "text-go" : "text-warn"}`}>
                          {s.installed ? `已装备 · ${s.fence_bindings.length} 条关联围栏` : "未安装"}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* 下排：30 天战绩 + 最近事件流 */}
            <div className="mt-3.5 grid grid-cols-1 gap-3.5 xl:grid-cols-[1.2fr_1fr]">
              <div className="rounded-msg border border-line bg-card p-3.5">
                <div className="mb-2 text-body font-bold text-holo">30 天战绩（来自事件账本）</div>
                <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
                  {[
                    ["动作", String(p.stats.actions30), ""],
                    ["采纳率", pct(p.stats.adoptionRate), ""],
                    ["被驳回", String(p.stats.rejected30), ""],
                    ["能量", p.stats.credits30.toLocaleString(), p.stats.offPeakRatio !== null ? `峰谷 ${pct(p.stats.offPeakRatio)}` : ""],
                  ].map(([l, v, d]) => (
                    <div key={l} className="rounded-lg border border-line bg-bg800/40 p-2.5">
                      <div className="text-body text-ink3">{l}</div>
                      <div className="font-orb text-h1 font-bold text-ink">{v}</div>
                      {d && <div className="text-body text-gold">{d}</div>}
                    </div>
                  ))}
                </div>
                <div className="mt-2 text-body text-ink3">
                  驳回原因会用于校准偏好；数据来自事件账本；没有回执的动作会标记为「未核实」。
                </div>
                {/* P8E4 发消息·派遣（E2.6：只读成员隐藏） */}
                {canDispatch && (
                  <div className="mt-3">
                    <textarea
                      value={goal}
                      onChange={(e) => setGoal(e.target.value)}
                      rows={2}
                      placeholder={`向 ${displayNameOf({ presetKey: p.agent.presetKey, roleName: p.agent.name })} 派遣任务；请写明目标、对象和期望完成时间。`}
                      className="w-full rounded-lg border border-line bg-bg800 px-2.5 py-2 text-body text-ink outline-none placeholder:text-ink3 focus:border-gline"
                    />
                    <button
                      type="button"
                      disabled={!goal.trim() || sending}
                      onClick={() => void dispatch()}
                      className="mt-2 cursor-pointer rounded-lg gold-grad px-4 py-2 text-body font-black text-ongold disabled:opacity-40"
                    >
                      <Icon name="send" size={15} className="inline" /> 发消息并派遣任务
                    </button>
                  </div>
                )}
              </div>

              <div className="rounded-msg border border-line bg-card p-3.5">
                <div className="mb-2 text-body font-bold text-holo">最近动作记录（点击查看关联任务的决策链路）</div>
                {p.events.length === 0 ? (
                  <div className="text-body text-ink3">近 30 天无动作留痕</div>
                ) : (
                  <div className="space-y-1.5">
                    {p.events.map((e) => (
                      <button
                        key={e.eventId}
                        type="button"
                        onClick={() => e.sessionId?.startsWith("T-") && nav(`/tasks/${encodeURIComponent(e.sessionId)}`)}
                        title={e.sessionId ? "查看关联任务的决策链路" : "无关联任务"}
                        className="flex w-full min-w-0 cursor-pointer flex-wrap items-center gap-2 rounded-lg border-l-2 border-line bg-bg800/30 px-2.5 py-1.5 text-left hover:border-l-gold"
                      >
                        <EventIdChip id={e.eventId} />
                        <span className="min-w-0 flex-1 break-words text-body text-ink2">
                          {actionText(e.action)}
                          {e.ruleResults.length > 0 && <span className="ml-1 text-body text-warn">{e.ruleResults.map((result) => dictText(RULE_RESULT_TEXT, result)).join("、")}</span>}
                        </span>
                        <span className={`shrink-0 text-body ${e.receiptSynced ? "text-go" : "text-warn"}`}>
                          {e.receiptSynced && <Icon name="check" size={13} className="inline" />} {e.receiptSynced ? "回执" : "未核实"}
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

/** P8 入口：/p8 名册；/p8/agent/:agentId 档案态（p8_agent） */
export default function P8() {
  const { agentId } = useParams<{ agentId: string }>();
  return agentId ? <AgentProfilePage agentId={agentId} /> : <RosterHome />;
}
