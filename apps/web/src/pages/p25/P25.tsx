/**
 * P25 · 开发场域（DevFabric）
 * AI Coding 工具接入与开发闭环：设备台账（织造车间）/ 仓库白名单 /
 * 任务单（S2→S5 操作流 + 会话直播 + 三道关审计视图）/ 版本时间线
 * 数据：trpc.service.devtools.*；机床=本机安装的 Codex/Claude Code/Aider（客户本地工具）
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ensureDemoLogin, trpc } from "../../lib/trpc";
import { VoiceEngine } from "../../voice/VoiceEngine";

/* ---------------- 类型（与服务端对齐） ---------------- */
interface ToolCaps { headless: boolean; streamEvents: string; sessionResume: boolean; sandboxFlag: boolean }
interface ToolInstall { tool_key: string; bin_path: string; version: string; credential_health: string; status: string; detected_at: string }
interface ToolEntry { toolKey: string; displayName: string; capabilities: ToolCaps; install: ToolInstall | null; installHint?: string | null; custom?: boolean }
interface RepoRow { id: string; name: string; path: string; baseline_branch: string; status: string; created_at: string }
interface TaskRow {
  id: string; repo_id: string; repo_name: string; title: string; status: string;
  change_kind: string; assigned_tool: string | null; repair_round: number;
  review_note: string | null; created_at: string; acceptance: string[];
}
interface SessionRow { id: string; tool_key: string; branch: string; exit_reason: string | null; last_message: string | null; started_at: string; ended_at: string | null; usage: { inputTokens?: number; outputTokens?: number } | null }
interface GateHard { name: string; ok: boolean; log: string }
interface GateResults { hardGates: GateHard[]; llmReview: { ok: boolean; report: string; mock: boolean }; exam: { examId: string; score: number | null; verdict: string | null; mock: boolean } }
interface ChangesetRow { id: string; diff_stat: string; files: Array<{ path: string; added: number; deleted: number }>; untracked: string[]; self_summary: string; gate_results: GateResults; gates_passed: boolean; created_at: string }
interface FenceRow { id: number; cmd: string; verdict: string; rule_id: string | null; note: string | null; created_at: string }
interface DevEventRow { seq: number; type: string; payload: Record<string, unknown>; created_at: string }
interface ReleaseRow { id: string; version: string; repo_name: string; changelog: string; released_by: string; released_at: string; merge_commit: string | null }
interface TaskDetail { task: TaskRow | null; sessions: SessionRow[]; changesets: ChangesetRow[]; fences: FenceRow[]; live: boolean }

const TASK_STATUS: Record<string, { text: string; cls: string }> = {
  draft: { text: "待确认", cls: "text-ink2" },
  confirmed: { text: "已确认", cls: "text-steel" },
  running: { text: "开发中", cls: "text-go" },
  auditing: { text: "审计中", cls: "text-warn" },
  pending_approval: { text: "待您裁决", cls: "text-gold" },
  released: { text: "已发布", cls: "text-go" },
  rejected: { text: "已打回", cls: "text-alert" },
  failed: { text: "转人工", cls: "text-alert" },
  canceled: { text: "已取消", cls: "text-ink3" },
};
const KIND_TEXT: Record<string, string> = { feat: "新特性", fix: "修复", breaking: "不兼容", chore: "杂项" };
const TOOL_GUIDE: Record<string, string> = {
  codex: "npm i -g @openai/codex（装后 codex login 登录）",
  "claude-code": "npm i -g @anthropic-ai/claude-code（装后 claude 登录）",
  aider: "pip install aider-chat（配 OPENAI/ANTHROPIC key）",
};
const guideOf = (t: ToolEntry) => t.installHint ?? TOOL_GUIDE[t.toolKey] ?? "安装后点「刷新设备探测」";

type Tab = "tasks" | "tools" | "repos" | "releases";

/* tRPC 弱类型通道（与 P24 同一模式） */
const svc = () => trpc.service as unknown as {
  devtools: {
    tools: { query: () => Promise<{ tools: ToolEntry[]; customToolErrors?: Array<{ file: string; reason: string }>; customToolDir?: string }> };
    refreshTools: { mutate: () => Promise<{ tools: ToolEntry[] }> };
    addCustomTool: { mutate: (i: Record<string, unknown>) => Promise<{ ok: boolean; file: string }> };
    repos: { query: () => Promise<{ repos: RepoRow[] }> };
    registerRepo: { mutate: (i: { name: string; path: string; baselineBranch?: string }) => Promise<{ repo: RepoRow }> };
    setRepoStatus: { mutate: (i: { repoId: string; status: "active" | "disabled" }) => Promise<unknown> };
    tasks: { query: () => Promise<{ tasks: TaskRow[] }> };
    createTask: { mutate: (i: { repoId: string; title: string; prdSummary: string; acceptance: string[]; changeKind?: string; assignedTool?: string }) => Promise<{ task: TaskRow }> };
    confirmTask: { mutate: (i: { taskId: string }) => Promise<unknown> };
    dispatchTask: { mutate: (i: { taskId: string }) => Promise<{ sessionId: string }> };
    rejectTask: { mutate: (i: { taskId: string; note: string }) => Promise<unknown> };
    cancelTask: { mutate: (i: { taskId: string }) => Promise<unknown> };
    approveRelease: { mutate: (i: { taskId: string; version?: string }) => Promise<{ release: ReleaseRow }> };
    taskDetail: { query: (i: { taskId: string }) => Promise<TaskDetail> };
    sessionEvents: { query: (i: { sessionId: string; afterSeq: number }) => Promise<{ events: DevEventRow[] }> };
    releases: { query: () => Promise<{ releases: ReleaseRow[] }> };
  };
};

/* ---------------- 织造车间（机床状态可视化·CSS 齿轮） ---------------- */
function DevMachines({ tools, tasks }: { tools: ToolEntry[]; tasks: TaskRow[] }) {
  const runningTools = new Set(
    tasks.filter((t) => t.status === "running").map((t) => t.assigned_tool ?? "codex"),
  );
  return (
    <div className="mb-4 grid grid-cols-3 gap-3">
      {tools.map((t) => {
        const online = !!t.install && t.install.status === "active";
        const busy = online && runningTools.has(t.toolKey);
        return (
          <div key={t.toolKey} className={`rounded-xl border p-3 ${online ? "border-gline bg-bg800" : "border-line bg-bg850 opacity-70"}`}>
            <div className="flex items-center gap-2.5">
              {/* 齿轮：运转时机床亮起 */}
              <svg width="34" height="34" viewBox="0 0 24 24" className={busy ? "animate-[spin_2.5s_linear_infinite]" : ""}>
                <path fill={busy ? "var(--gold)" : online ? "var(--steel)" : "var(--ink3)"}
                  d="M12 8.5A3.5 3.5 0 1 0 12 15.5 3.5 3.5 0 0 0 12 8.5zm0 5.2a1.7 1.7 0 1 1 0-3.4 1.7 1.7 0 0 1 0 3.4zM21 13.4v-2.8l-2.3-.5a7 7 0 0 0-.6-1.5l1.3-2-2-2-2 1.3a7 7 0 0 0-1.5-.6L13.5 3h-2.8l-.5 2.3a7 7 0 0 0-1.5.6l-2-1.3-2 2 1.3 2a7 7 0 0 0-.6 1.5l-2.3.5v2.8l2.3.5c.14.53.34 1.03.6 1.5l-1.3 2 2 2 2-1.3c.47.26.97.46 1.5.6l.5 2.3h2.8l.5-2.3a7 7 0 0 0 1.5-.6l2 1.3 2-2-1.3-2c.26-.47.46-.97.6-1.5l2.3-.5z"/>
              </svg>
              <div className="min-w-0">
                <div className="truncate text-[13px] font-semibold text-ink">{t.displayName}</div>
                <div className="text-[11px] text-ink2">
                  {busy ? "⚙ 运转中——正在开发" : online ? `待机 · ${t.install!.version}` : "未安装"}
                </div>
              </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {t.capabilities.streamEvents === "jsonl" && <Badge>结构化事件流</Badge>}
              {t.capabilities.sessionResume && <Badge>可续跑返修</Badge>}
              {t.capabilities.sandboxFlag && <Badge>自带沙箱</Badge>}
              {t.custom && <Badge>自定义接入</Badge>}
            </div>
            {!online && (
              <div className="mt-2 rounded-lg bg-bg900 px-2 py-1.5 text-[11px] leading-relaxed text-ink2">
                安装指引：<code className="text-steel">{guideOf(t)}</code>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
function Badge({ children }: { children: React.ReactNode }) {
  return <span className="rounded-full border border-line px-2 py-0.5 text-[10px] text-ink2">{children}</span>;
}

/* ---------------- 主页面 ---------------- */
export default function P25() {
  const [tab, setTab] = useState<Tab>("tasks");
  const [tools, setTools] = useState<ToolEntry[]>([]);
  const [repos, setRepos] = useState<RepoRow[]>([]);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [releases, setReleases] = useState<ReleaseRow[]>([]);
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState(false);

  const prevStatus = useRef<Map<string, string>>(new Map());

  const load = useCallback(async () => {
    await ensureDemoLogin();
    const [t, r, k, rel] = await Promise.all([
      svc().devtools.tools.query().catch(() => ({ tools: [] })),
      svc().devtools.repos.query().catch(() => ({ repos: [] })),
      svc().devtools.tasks.query().catch(() => ({ tasks: [] })),
      svc().devtools.releases.query().catch(() => ({ releases: [] })),
    ]);
    setTools(t.tools); setRepos(r.repos); setTasks(k.tasks); setReleases(rel.releases);
    // 状态跃迁播报（自动经营的听觉语言：审计过等裁决 / 发布成功）
    for (const task of k.tasks) {
      const prev = prevStatus.current.get(task.id);
      if (prev && prev !== task.status) {
        if (task.status === "pending_approval") {
          VoiceEngine.speak({ role: "release-guardian", persona: "发布守护",
            text: `任务「${task.title}」三道关全过，等您裁决`, priority: "ambient" });
        }
        if (task.status === "released") {
          const v = rel.releases[0]?.version;
          VoiceEngine.speak({ role: "release-guardian", persona: "发布守护",
            text: `任务「${task.title}」已发布${v ? `，版本 ${v}` : ""}`, priority: "ambient" });
        }
      }
      prevStatus.current.set(task.id, task.status);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // 有活动任务时 4s 轮询（直播态）
  const hasLive = tasks.some((t) => ["running", "auditing"].includes(t.status));
  useEffect(() => {
    if (!hasLive) return;
    const h = setInterval(() => void load(), 4000);
    return () => clearInterval(h);
  }, [hasLive, load]);

  const act = async (fn: () => Promise<unknown>, okMsg: string) => {
    setBusy(true); setToast("");
    try { await fn(); setToast(okMsg); await load(); }
    catch (e) { setToast(`操作失败：${e instanceof Error ? e.message : String(e)}`); }
    finally { setBusy(false); }
  };

  return (
    <div className="mx-auto max-w-[1180px] px-6 py-5 text-ink">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold">开发场域</h1>
          <p className="mt-0.5 text-xs text-ink2">
            需求 → PRD → 机床开发（本机 Codex / Claude Code / Aider）→ 三道关审计 → 您裁决 → 发布与版本 · 闭环不依赖人类开发
          </p>
        </div>
        <button
          onClick={() => void act(() => svc().devtools.refreshTools.mutate().then((r) => setTools(r.tools)), "设备探测已刷新")}
          disabled={busy}
          className="rounded-lg border border-gline bg-bg800 px-4 py-2 text-[13px] font-semibold text-ink hover:bg-bg750 disabled:opacity-50"
        >
          刷新设备探测
        </button>
      </div>
      {toast && <div className="mb-3 rounded-lg border border-gline bg-bg800 px-3 py-2 text-xs">{toast}</div>}

      {/* 页签 */}
      <div className="mb-4 flex gap-1 border-b border-line">
        {([["tasks", "任务单"], ["tools", "织造车间 · 设备"], ["repos", "仓库白名单"], ["releases", "版本时间线"]] as Array<[Tab, string]>).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-4 py-2 text-[13px] font-medium ${tab === k ? "border-b-2 border-gold text-ink" : "text-ink2 hover:text-ink"}`}>
            {label}
          </button>
        ))}
      </div>

      {tab === "tools" && (
        <>
          <DevMachines tools={tools} tasks={tasks} />
          <CustomToolCard act={act} busy={busy} />
        </>
      )}
      {tab === "repos" && <ReposTab repos={repos} act={act} busy={busy} />}
      {tab === "tasks" && <TasksTab tasks={tasks} repos={repos} tools={tools} act={act} busy={busy} reload={load} />}
      {tab === "releases" && <ReleasesTab releases={releases} />}
    </div>
  );
}

/* ---------------- 自定义机床接入（声明式标准协议） ---------------- */
const CUSTOM_YAML_EXAMPLE = `tool_key: my-code-cli
display_name: 我的编程工具
bin: mycli
args: ["-p", "{{prompt}}", "--output-format", "stream-json"]
output:
  protocol: claude-stream-json   # claude-stream-json / codex-jsonl / json-result / text
install_hint: npm i -g my-code-cli`;

function CustomToolCard({ act, busy }: { act: (f: () => Promise<unknown>, m: string) => Promise<void>; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const [yaml, setYaml] = useState(CUSTOM_YAML_EXAMPLE);
  const submit = () => {
    void act(async () => {
      // 前端轻解析（YAML 子集：逐行 key: value + args 行内数组 + protocol 行）
      const spec = parseSimpleToolYaml(yaml);
      await svc().devtools.addCustomTool.mutate(spec as unknown as Record<string, unknown>);
    }, "自定义机床已接入——刷新探测即可选派");
  };
  return (
    <div className="rounded-xl border border-line bg-bg850 p-4">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center justify-between text-left">
        <div>
          <div className="text-[13px] font-semibold">＋ 接入新机床（客户自定义 · 标准协议）</div>
          <div className="mt-0.5 text-[11px] text-ink2">
            新工具出现时不等厂商适配——只要它电脑上装着、满足三条协议（非交互执行 / 输出可解析 / 指定目录工作），贴一份 YAML 即可受管调用
          </div>
        </div>
        <span className="text-xs text-ink2">{open ? "收起" : "展开"}</span>
      </button>
      {open && (
        <div className="mt-3">
          <textarea value={yaml} onChange={(e) => setYaml(e.target.value)} rows={9}
            className="w-full rounded-lg border border-line bg-bg950 px-3 py-2 font-mono text-[11px] leading-relaxed outline-none focus:border-steel" />
          <div className="mt-2 flex items-center gap-2">
            <button disabled={busy} onClick={submit}
              className="rounded-lg bg-gradient-to-br from-gold to-gold2 px-4 py-2 text-xs font-semibold text-ongold disabled:opacity-50">
              校验并接入
            </button>
            <span className="text-[10px] text-ink3">契约不合规会被拒收并说明原因；也可直接放文件到 ~/.workloom/devtools/*.yml 后刷新探测</span>
          </div>
        </div>
      )}
    </div>
  );
}

/** YAML 子集轻解析（与服务端契约同构；复杂写法请直接放文件） */
function parseSimpleToolYaml(text: string): Record<string, unknown> {
  const spec: Record<string, unknown> = { capabilities: { headless: true } };
  let inOutput = false;
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (/^output:/.test(line)) { inOutput = true; spec.output = {}; continue; }
    const m = /^([a-z_]+):\s*(.*)$/.exec(line.trim());
    if (!m || m[1] === undefined || m[2] === undefined) continue;
    const k = m[1];
    const v = m[2];
    if (inOutput && (k === "protocol")) { (spec.output as Record<string, unknown>).protocol = v; inOutput = false; continue; }
    if (k === "args") {
      try { spec.args = JSON.parse(v.replace(/'/g, '"')); } catch { throw new Error("args 须为 JSON 数组写法"); }
      continue;
    }
    (spec as Record<string, unknown>)[k === "display_name" ? "display_name" : k] = v;
  }
  if (!spec.tool_key || !spec.bin || !spec.args || !spec.output) {
    throw new Error("契约不全：tool_key / bin / args / output.protocol 均必填");
  }
  return spec;
}

/* ---------------- 仓库白名单 ---------------- */
function ReposTab({ repos, act, busy }: { repos: RepoRow[]; act: (f: () => Promise<unknown>, m: string) => Promise<void>; busy: boolean }) {
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [branch, setBranch] = useState("main");
  return (
    <div>
      <div className="mb-4 rounded-xl border border-line bg-bg850 p-4">
        <div className="mb-2 text-[13px] font-semibold">登记仓库（白名单唯一入口——未登记的目录机床进不去）</div>
        <div className="flex gap-2">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="仓库名（如 官网前端）"
            className="w-44 rounded-lg border border-line bg-bg900 px-3 py-2 text-xs outline-none focus:border-steel" />
          <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="本机绝对路径（须为 git 仓库）"
            className="flex-1 rounded-lg border border-line bg-bg900 px-3 py-2 text-xs outline-none focus:border-steel" />
          <input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="基线分支"
            className="w-24 rounded-lg border border-line bg-bg900 px-3 py-2 text-xs outline-none focus:border-steel" />
          <button disabled={busy || !name || !path}
            onClick={() => void act(() => svc().devtools.registerRepo.mutate({ name, path, baselineBranch: branch }), "仓库已登记")}
            className="rounded-lg bg-gradient-to-br from-gold to-gold2 px-4 py-2 text-xs font-semibold text-ongold disabled:opacity-50">
            登记
          </button>
        </div>
      </div>
      {repos.length === 0 && <Empty text="还没有登记仓库。机床只能进您登记的目录。" />}
      <div className="space-y-2">
        {repos.map((r) => (
          <div key={r.id} className="flex items-center justify-between rounded-xl border border-line bg-bg850 px-4 py-3">
            <div>
              <div className="text-[13px] font-semibold">{r.name} <span className="ml-1 text-[11px] font-normal text-ink2">基线 {r.baseline_branch}</span></div>
              <div className="mt-0.5 font-mono text-[11px] text-ink2">{r.path}</div>
            </div>
            <button disabled={busy}
              onClick={() => void act(() => svc().devtools.setRepoStatus.mutate({ repoId: r.id, status: r.status === "active" ? "disabled" : "active" }), "状态已更新")}
              className={`rounded-lg px-3 py-1.5 text-xs ${r.status === "active" ? "border border-line text-ink2" : "border border-gline bg-bg800 text-ink"}`}>
              {r.status === "active" ? "停用" : "启用"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------------- 任务单 ---------------- */
function TasksTab({ tasks, repos, tools, act, busy, reload }: {
  tasks: TaskRow[]; repos: RepoRow[]; tools: ToolEntry[];
  act: (f: () => Promise<unknown>, m: string) => Promise<void>; busy: boolean; reload: () => Promise<void>;
}) {
  const [showForm, setShowForm] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  return (
    <div>
      <div className="mb-3 flex justify-between">
        <div className="text-xs text-ink2">流水线：确认拆解 → 派发机床 → 三道关审计 → 您裁决 → 发布</div>
        <button onClick={() => setShowForm(!showForm)}
          className="rounded-lg bg-gradient-to-br from-gold to-gold2 px-3.5 py-1.5 text-xs font-semibold text-ongold">
          {showForm ? "收起" : "＋ 新建开发任务"}
        </button>
      </div>
      {showForm && <TaskForm repos={repos} tools={tools} act={act} busy={busy} done={() => setShowForm(false)} />}
      {tasks.length === 0 && !showForm && <Empty text="还没有开发任务。从一份 PRD 出发建第一张任务单。" />}
      <div className="space-y-2">
        {tasks.map((t) => (
          <TaskCard key={t.id} task={t} act={act} busy={busy}
            expanded={detailId === t.id} onToggle={() => setDetailId(detailId === t.id ? null : t.id)} reload={reload} />
        ))}
      </div>
    </div>
  );
}

function TaskForm({ repos, tools, act, busy, done }: {
  repos: RepoRow[]; tools: ToolEntry[]; act: (f: () => Promise<unknown>, m: string) => Promise<void>; busy: boolean; done: () => void;
}) {
  const active = repos.filter((r) => r.status === "active");
  const online = tools.filter((t) => t.install?.status === "active");
  const [repoId, setRepoId] = useState("");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [acceptance, setAcceptance] = useState<string[]>([""]);
  const [kind, setKind] = useState("feat");
  const [tool, setTool] = useState("");
  const valid = repoId && title && summary && acceptance.some((a) => a.trim());
  return (
    <div className="mb-4 rounded-xl border border-gline bg-bg850 p-4">
      <div className="mb-3 text-[13px] font-semibold">新建开发任务（S2 拆解——提交后先经您确认才派发给机床）</div>
      <div className="grid grid-cols-2 gap-2">
        <select value={repoId} onChange={(e) => setRepoId(e.target.value)}
          className="rounded-lg border border-line bg-bg900 px-3 py-2 text-xs outline-none">
          <option value="">选择目标仓库 *</option>
          {active.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        <select value={tool} onChange={(e) => setTool(e.target.value)}
          className="rounded-lg border border-line bg-bg900 px-3 py-2 text-xs outline-none">
          <option value="">自动选派机床（Codex 优先）</option>
          {online.map((t) => <option key={t.toolKey} value={t.toolKey}>{t.displayName}</option>)}
        </select>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="任务标题 *"
          className="rounded-lg border border-line bg-bg900 px-3 py-2 text-xs outline-none focus:border-steel" />
        <select value={kind} onChange={(e) => setKind(e.target.value)}
          className="rounded-lg border border-line bg-bg900 px-3 py-2 text-xs outline-none">
          {Object.entries(KIND_TEXT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      <textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={3}
        placeholder="需求摘要（PRD 方案章节原文即可）*"
        className="mt-2 w-full rounded-lg border border-line bg-bg900 px-3 py-2 text-xs outline-none focus:border-steel" />
      <div className="mt-2">
        <div className="mb-1 text-[11px] text-ink2">验收标准（逐条可测，至少一条）*</div>
        {acceptance.map((a, i) => (
          <div key={i} className="mb-1 flex gap-1">
            <input value={a} onChange={(e) => setAcceptance(acceptance.map((x, j) => j === i ? e.target.value : x))}
              placeholder={`验收标准 ${i + 1}`}
              className="flex-1 rounded-lg border border-line bg-bg900 px-3 py-1.5 text-xs outline-none focus:border-steel" />
            {i === acceptance.length - 1 && (
              <button onClick={() => setAcceptance([...acceptance, ""])} className="rounded-lg border border-line px-2 text-xs text-ink2">＋</button>
            )}
          </div>
        ))}
      </div>
      <button disabled={busy || !valid}
        onClick={() => void act(async () => {
          await svc().devtools.createTask.mutate({
            repoId, title, prdSummary: summary,
            acceptance: acceptance.filter((a) => a.trim()),
            changeKind: kind, ...(tool ? { assignedTool: tool } : {}),
          });
          done();
        }, "任务单已创建——请确认拆解后派发")}
        className="mt-3 rounded-lg bg-gradient-to-br from-gold to-gold2 px-4 py-2 text-xs font-semibold text-ongold disabled:opacity-50">
        创建任务单
      </button>
    </div>
  );
}

function TaskCard({ task, act, busy, expanded, onToggle, reload }: {
  task: TaskRow; act: (f: () => Promise<unknown>, m: string) => Promise<void>; busy: boolean;
  expanded: boolean; onToggle: () => void; reload: () => Promise<void>;
}) {
  const st = TASK_STATUS[task.status] ?? { text: task.status, cls: "text-ink2" };
  return (
    <div className="rounded-xl border border-line bg-bg850">
      <div className="flex items-center justify-between px-4 py-3">
        <button onClick={onToggle} className="min-w-0 flex-1 text-left">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-semibold">{task.title}</span>
            <span className={`text-[11px] font-medium ${st.cls}`}>{st.text}</span>
            {task.repair_round > 0 && <span className="text-[10px] text-warn">返修 ×{task.repair_round}</span>}
          </div>
          <div className="mt-0.5 text-[11px] text-ink2">
            {task.repo_name} · {KIND_TEXT[task.change_kind]} · {task.assigned_tool ?? "自动选派"} · {new Date(task.created_at).toLocaleString("zh-CN")}
          </div>
          {task.review_note && <div className="mt-1 text-[11px] text-alert">打回/失败备注:{task.review_note.slice(0, 120)}</div>}
        </button>
        <div className="ml-3 flex shrink-0 gap-1.5">
          {task.status === "draft" && (
            <ActBtn disabled={busy} onClick={() => void act(() => svc().devtools.confirmTask.mutate({ taskId: task.id }), "拆解已确认——可派发")}>确认拆解</ActBtn>
          )}
          {task.status === "confirmed" && (
            <ActBtn gold disabled={busy} onClick={() => void act(() => svc().devtools.dispatchTask.mutate({ taskId: task.id }), "已派发给机床——隔离分支开发中")}>派发机床</ActBtn>
          )}
          {task.status === "pending_approval" && (
            <>
              <ActBtn gold disabled={busy} onClick={() => void act(async () => {
                const r = await svc().devtools.approveRelease.mutate({ taskId: task.id });
                return r;
              }, "已批准发布——版本台账 +1")}>批准发布</ActBtn>
              <ActBtn disabled={busy} onClick={() => {
                const note = window.prompt("打回意见（将回灌给开发总指挥重排）：");
                if (note) void act(() => svc().devtools.rejectTask.mutate({ taskId: task.id, note }), "已打回");
              }}>打回</ActBtn>
            </>
          )}
          {["draft", "confirmed", "running", "auditing", "rejected", "failed"].includes(task.status) && (
            <ActBtn disabled={busy} onClick={() => void act(() => svc().devtools.cancelTask.mutate({ taskId: task.id }), "已取消（隔离区已清理）")}>取消</ActBtn>
          )}
        </div>
      </div>
      {expanded && <TaskDetailView taskId={task.id} live={["running", "auditing"].includes(task.status)} reload={reload} />}
    </div>
  );
}

function ActBtn({ children, onClick, disabled, gold }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; gold?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled}
      className={gold
        ? "rounded-lg bg-gradient-to-br from-gold to-gold2 px-3 py-1.5 text-xs font-semibold text-ongold disabled:opacity-50"
        : "rounded-lg border border-line px-3 py-1.5 text-xs text-ink2 hover:text-ink disabled:opacity-50"}>
      {children}
    </button>
  );
}

/* ---------------- 任务详情：会话直播 + 三道关 + 围栏留痕 ---------------- */
function TaskDetailView({ taskId, live, reload: _reload }: { taskId: string; live: boolean; reload: () => Promise<void> }) {
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [events, setEvents] = useState<DevEventRow[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const afterSeq = useRef(0);
  const streamRef = useRef<HTMLDivElement | null>(null);

  const loadDetail = useCallback(async () => {
    const d = await svc().devtools.taskDetail.query({ taskId }).catch(() => null);
    if (!d) return;
    setDetail(d);
    const latest = d.sessions[0]?.id ?? null;
    setSessionId((cur) => cur ?? latest);
  }, [taskId]);

  useEffect(() => { void loadDetail(); }, [loadDetail]);

  // 事件流增量轮询（live 时 2s，否则一次性）
  useEffect(() => {
    if (!sessionId) return;
    let stop = false;
    const pull = async () => {
      const r = await svc().devtools.sessionEvents.query({ sessionId, afterSeq: afterSeq.current }).catch(() => ({ events: [] }));
      if (stop || r.events.length === 0) return;
      afterSeq.current = r.events[r.events.length - 1]!.seq;
      setEvents((prev) => [...prev, ...r.events].slice(-300));
      requestAnimationFrame(() => { streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight }); });
    };
    void pull();
    if (!live) return;
    const h = setInterval(() => { void pull(); void loadDetail(); }, 2000);
    return () => { stop = true; clearInterval(h); };
  }, [sessionId, live, loadDetail]);

  if (!detail) return <div className="border-t border-line px-4 py-3 text-xs text-ink2">加载中……</div>;
  const cs = detail.changesets[0];

  return (
    <div className="border-t border-line px-4 py-3">
      {/* 会话选择 */}
      {detail.sessions.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-ink2">
          <span>会话：</span>
          {detail.sessions.map((s) => (
            <button key={s.id} onClick={() => { setSessionId(s.id); setEvents([]); afterSeq.current = 0; }}
              className={`rounded-full border px-2 py-0.5 ${sessionId === s.id ? "border-gold text-gold" : "border-line"}`}>
              {s.tool_key} · {s.exit_reason ?? (live ? "进行中" : "—")}
              {s.usage?.inputTokens ? ` · ${s.usage.inputTokens}/${s.usage.outputTokens ?? 0}tok` : ""}
            </button>
          ))}
        </div>
      )}
      {/* 直播流 */}
      <div ref={streamRef} className="mb-3 max-h-56 overflow-y-auto rounded-lg bg-bg950 p-3 font-mono text-[11px] leading-relaxed">
        {events.length === 0 && <div className="text-ink3">{live ? "等待机床事件……" : "（本会话无事件记录）"}</div>}
        {events.map((e) => <EventLine key={e.seq} ev={e} />)}
        {live && <div className="animate-pulse text-gold">▍机床运转中</div>}
      </div>
      {/* 三道关 */}
      {cs && (
        <div className="mb-3 rounded-lg border border-line bg-bg900 p-3">
          <div className="mb-2 text-[12px] font-semibold">
            三道关审计 {cs.gates_passed ? <span className="text-go">✓ 全过</span> : <span className="text-alert">✗ 未全过</span>}
            <span className="ml-2 font-normal text-ink2">{new Date(cs.created_at).toLocaleString("zh-CN")}</span>
          </div>
          <div className="grid grid-cols-3 gap-2 text-[11px]">
            <div>
              <div className="mb-1 font-medium text-ink2">① 硬门禁</div>
              {cs.gate_results.hardGates.map((g, i) => (
                <div key={i} className={g.ok ? "text-go" : "text-alert"} title={g.log}>
                  {g.ok ? "✓" : "✗"} {g.name}
                </div>
              ))}
            </div>
            <div>
              <div className="mb-1 font-medium text-ink2">② LLM 评审{cs.gate_results.llmReview.mock && <span className="text-warn">（降级）</span>}</div>
              <div className={cs.gate_results.llmReview.ok ? "text-go" : "text-alert"}>{cs.gate_results.llmReview.ok ? "✓ 通过" : "✗ 未过"}</div>
              <div className="mt-1 whitespace-pre-wrap text-ink2">{cs.gate_results.llmReview.report.slice(0, 300)}</div>
            </div>
            <div>
              <div className="mb-1 font-medium text-ink2">③ 上线考{cs.gate_results.exam.mock && <span className="text-warn">（降级）</span>}</div>
              <div className={cs.gate_results.exam.verdict === "fail" ? "text-alert" : "text-go"}>
                {cs.gate_results.exam.verdict ? `${cs.gate_results.exam.verdict} · ${cs.gate_results.exam.score ?? "—"} 分` : "未执行"}
              </div>
            </div>
          </div>
          {cs.diff_stat && (
            <details className="mt-2">
              <summary className="cursor-pointer text-[11px] text-steel">变更统计（{cs.files.length} 文件{cs.untracked.length > 0 ? ` + ${cs.untracked.length} 新文件` : ""}）</summary>
              <pre className="mt-1 max-h-40 overflow-y-auto rounded bg-bg950 p-2 text-[10px] text-ink2">{cs.diff_stat}</pre>
              {cs.self_summary && <div className="mt-1 text-[11px] text-ink2">机床自总结:{cs.self_summary.slice(0, 400)}</div>}
            </details>
          )}
        </div>
      )}
      {/* 围栏留痕 */}
      {detail.fences.length > 0 && (
        <div className="rounded-lg border border-alert/40 bg-bg900 p-3">
          <div className="mb-1 text-[12px] font-semibold text-alert">⚠ 围栏拦截留痕（{detail.fences.length}）</div>
          {detail.fences.slice(0, 5).map((f) => (
            <div key={f.id} className="font-mono text-[10px] text-ink2">
              [{f.verdict}] {f.cmd.slice(0, 100)} — {f.note ?? f.rule_id}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function EventLine({ ev }: { ev: DevEventRow }) {
  const p = ev.payload as Record<string, unknown>;
  switch (ev.type) {
    case "started": return <div className="text-steel">▶ 会话启动 {p.threadId ? `(线程 ${String(p.threadId).slice(0, 12)}…)` : ""}</div>;
    case "command_run": return <div className="text-ink2">$ {String(p.cmd ?? "").slice(0, 140)} {p.status === "done" ? <span className="text-go">✓</span> : ""}</div>;
    case "file_edited": return <div className="text-gold">✎ {String(p.path ?? "")}</div>;
    case "progress": return <div className="text-ink">{String(p.text ?? "").slice(0, 200)}</div>;
    case "usage": return <div className="text-ink3">… tokens {String(p.inputTokens ?? "—")}/{String(p.outputTokens ?? "—")}</div>;
    case "fence_verdict": return <div className="text-alert">⛔ 围栏[{String(p.verdict)}] {String(p.cmd ?? "").slice(0, 80)} — {String(p.note ?? "")}</div>;
    case "done": return <div className="text-go">■ 完成:{String(p.summary ?? "").slice(0, 160)}</div>;
    case "error": return <div className="text-alert">✗ {String(p.message ?? "").slice(0, 160)}</div>;
    default: return null;
  }
}

/* ---------------- 版本时间线 ---------------- */
function ReleasesTab({ releases }: { releases: ReleaseRow[] }) {
  if (releases.length === 0) return <Empty text="还没有发布记录。第一张任务单通过裁决后，版本会出现在这里。" />;
  return (
    <div className="relative ml-3 border-l-2 border-gline pl-6">
      {releases.map((r) => (
        <div key={r.id} className="relative mb-5">
          <div className="absolute -left-[31px] top-1 h-3 w-3 rounded-full border-2 border-gold bg-bg900" />
          <div className="flex items-center gap-2">
            <span className="font-mono text-[14px] font-bold text-gold">{r.version}</span>
            <span className="text-xs text-ink2">{r.repo_name}</span>
            <span className="text-[11px] text-ink3">{new Date(r.released_at).toLocaleString("zh-CN")}</span>
          </div>
          <div className="mt-1 whitespace-pre-wrap rounded-lg border border-line bg-bg850 p-3 text-xs text-ink2">{r.changelog}</div>
          <div className="mt-1 text-[10px] text-ink3">批准人 {r.released_by}{r.merge_commit ? ` · 合并 ${r.merge_commit.slice(0, 8)}` : ""}</div>
        </div>
      ))}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="rounded-xl border border-dashed border-line bg-bg850 px-4 py-8 text-center text-xs text-ink2">{text}</div>;
}
