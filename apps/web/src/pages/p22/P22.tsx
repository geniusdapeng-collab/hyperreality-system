/**
 * P22 服务前台 · 知识中台与工单台（B 端管理界面；消费 serviceRouter 全部端点）
 *  - 顶部「C 端入口」卡：部署环境真实地址 + 可扫描二维码 + 分渠道事实状态。
 *  - 知识库：集合列表（新建集合）→ 文档表（标题/来源/版本/状态 chip/切块数）→ 详情抽屉
 *    （检索索引内容预览 + active/disabled 状态切换）→ 待审区（pendingReviews + approveDocument
 *    批准，三写同一 COMMIT 联动 approvals 审批台 D16）→ 官网源卡（registerSite/crawlNow/diffScan）
 *    → 试检索框（search hits + score）
 *  - 工单台：tickets.list（状态/部门过滤 chip）→ 行内分派（assign）/ 开始处理（advance start）
 *    / 办结（complete 填结果，结果 pushMessage 通知 C 端）→ 详情抽屉（tickets.timeline 时间线）
 *  - 服务报表：stats.overview 指标卡组（会话/问答/置信度/有据率/延迟/工单/完结率/SLA/满意度）+ 解读
 * 数据全部走 trpc.service.*；写操作落五元事件；轮询口径 15s 静默刷新（D6）
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { ensureDemoLogin, trpc } from "../../lib/trpc";
import {
  DOC_STATUS_TEXT,
  SOURCE_KIND_TEXT,
  TICKET_ACTOR_TEXT,
  TICKET_KIND_TEXT,
  TICKET_PRIORITY_TEXT,
  TICKET_STATUS_TEXT,
  actionText,
  confidenceText,
  dictText,
  latencyText,
  payloadText,
  shortId,
  versionText,
} from "../../lib/display";
import { Bridge } from "../../shell/Bridge";
import { BannerAlert, EmptyState, Skeleton } from "../../components/hud";
import { ConfirmDialog, Icon, Overlay, clientChineseText } from "@workloom/ui";
import { UrlQrCode } from "../../components/UrlQrCode";
import { publicationSystemText } from "../onboarding/systemText";

/* ---------- 数据契约（与 apps/server/src/service 对齐） ---------- */
interface KbCollection { id: string; name: string; description: string; createdAt: string }
interface KbDocument {
  id: string; collectionId: string; title: string; sourceKind: string;
  sourceUrl: string | null; version: number; status: string; createdAt: string;
}
interface PendingDoc { id: string; title: string; source_kind: string; source_url: string | null; version: number; created_at: string }
interface KbHit { content: string; heading: string; documentTitle: string; documentId: string; score: number }
interface Ticket {
  id: string; cUserId: string | null; kind: string; title: string; status: string; priority: string;
  dept: string | null; assignee: string | null; slaDeadline: string | null;
  ratingScore: number | null; createdAt: string;
}
interface TicketEvent { id: string; action: string; actorType: string; actorId: string; detail: Record<string, unknown>; createdAt: string }
interface Overview {
  date: string; sessions: number; qaCount: number; avgConfidence: number | null;
  groundedRate: number | null; avgLatencyMs: number | null; ticketsToday: number;
  completionRate: number | null; slaBreached: number; avgRating: number | null;
}
interface ServiceFrontPublication {
  url: string | null;
  qrAvailable: boolean;
  overall: "published" | "preview" | "blocked";
  channels: Array<{ key: "h5" | "wechat-mini" | "alipay"; label: string; status: "ready" | "preview" | "partial" | "blocked" | "unavailable"; detail: string }>;
}

type Tab = "kb" | "tickets" | "stats";

function tabFromSearch(search: string): Tab {
  const value = new URLSearchParams(search).get("tab");
  return value === "tickets" || value === "stats" ? value : "kb";
}

const TICKET_STATUS: Array<{ key: string; label: string }> = [
  { key: "", label: "全部" },
  ...["created", "assigned", "processing", "done", "closed"].map((key) => ({ key, label: TICKET_STATUS_TEXT[key] ?? key })),
];
const PUBLICATION_STATUS: Record<ServiceFrontPublication["channels"][number]["status"], string> = {
  ready: "已就绪", preview: "仅预览", partial: "部分接入", blocked: "未满足发布条件", unavailable: "未配置",
};
const PUBLICATION_TONE: Record<ServiceFrontPublication["channels"][number]["status"], string> = {
  ready: "border-go/40 text-go", preview: "border-holo/40 text-holo", partial: "border-warn/40 text-warn",
  blocked: "border-alert/40 text-alert", unavailable: "border-line text-ink3",
};

function docStatusChip(s: string) {
  const label = dictText(DOC_STATUS_TEXT, s);
  if (s === "active") return <span className="rounded border border-go/40 px-1.5 py-0.5 text-body text-go">{label}</span>;
  if (s === "pending_review") return <span className="rounded border border-warn/40 px-1.5 py-0.5 text-body text-warn">{label}</span>;
  return <span className="rounded border border-line px-1.5 py-0.5 text-body text-ink3">{label}</span>;
}
function ticketStatusChip(s: string) {
  const cls =
    s === "done" ? "border-go/40 text-go" :
    s === "processing" ? "border-holo/40 text-holo" :
    s === "assigned" ? "border-gline text-goldhi" :
    "border-line text-ink3";
  return <span className={`rounded border px-1.5 py-0.5 text-body ${cls}`}>{dictText(TICKET_STATUS_TEXT, s)}</span>;
}
function pct(x: number | null): string { return x === null ? "—" : `${Math.round(x * 100)}%`; }

export default function P22() {
  const nav = useNavigate();
  const location = useLocation();
  const [tab, setTab] = useState<Tab>(() => tabFromSearch(location.search));

  useEffect(() => setTab(tabFromSearch(location.search)), [location.search]);
  const selectTab = useCallback((next: Tab) => {
    const search = new URLSearchParams(location.search);
    if (next === "kb") search.delete("tab");
    else search.set("tab", next);
    setTab(next);
    void nav({ pathname: location.pathname, search: search.toString() }, { replace: false });
  }, [location.pathname, location.search, nav]);

  const [ready, setReady] = useState(false);
  const [banner, setBanner] = useState<{ level: "alert" | "warn" | "info"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  /* 知识库 */
  const [collections, setCollections] = useState<KbCollection[]>([]);
  const [activeCol, setActiveCol] = useState<string>(""); // "" = 全部
  const [documents, setDocuments] = useState<KbDocument[]>([]);
  const [chunkCounts, setChunkCounts] = useState<Record<string, number>>({});
  const [pending, setPending] = useState<PendingDoc[]>([]);
  const [newColName, setNewColName] = useState("");
  const [newColDesc, setNewColDesc] = useState("");
  const [docDrawer, setDocDrawer] = useState<KbDocument | null>(null);
  const [docPreview, setDocPreview] = useState<KbHit[] | null>(null);
  const [docStatusConfirm, setDocStatusConfirm] = useState<{ document: KbDocument; status: "active" | "disabled" } | null>(null);
  /* 官网源 */
  const [siteUrl, setSiteUrl] = useState("");
  const [siteId, setSiteId] = useState("");
  const [siteResult, setSiteResult] = useState<string>("");
  /* 试检索 */
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<KbHit[] | null>(null);

  /* 工单台 */
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [fStatus, setFStatus] = useState("");
  const [fDept, setFDept] = useState("");
  const [knownDepts, setKnownDepts] = useState<string[]>(["客户服务"]);
  const [assignFor, setAssignFor] = useState<string | null>(null);
  const [assignDept, setAssignDept] = useState("客户服务");
  const [assignee, setAssignee] = useState("");
  const [completeFor, setCompleteFor] = useState<string | null>(null);
  const [completeResult, setCompleteResult] = useState("");
  const [timelineFor, setTimelineFor] = useState<Ticket | null>(null);
  const [timeline, setTimeline] = useState<TicketEvent[] | null>(null);

  /* 报表 */
  const [overview, setOverview] = useState<Overview | null>(null);
  const [publication, setPublication] = useState<ServiceFrontPublication | null>(null);

  const fail = useCallback((e: unknown) => {
    console.error("服务前台操作失败", e);
    setBanner({ level: "alert", text: "操作未完成，请稍后重试；若持续失败，请联系管理员查看事件账本。" });
  }, []);

  const copyPublicationUrl = async () => {
    if (!publication?.url) return;
    try {
      await navigator.clipboard.writeText(publication.url);
      setBanner({ level: "info", text: "客户服务地址已复制。" });
    } catch {
      setBanner({ level: "warn", text: "自动复制失败，请选中完整地址后手动复制。" });
    }
  };

  const load = useCallback(async (silent = false) => {
    if (!silent) setReady(false);
    try {
      await ensureDemoLogin();
      const [cols, pend, ov, front] = await Promise.all([
        trpc.service.kb.listCollections.query() as Promise<{ collections: KbCollection[] }>,
        trpc.service.kb.pendingReviews.query() as unknown as Promise<{ documents: PendingDoc[] }>,
        trpc.service.stats.overview.query() as Promise<Overview>,
        (trpc.onboarding.serviceFrontPublication.query() as Promise<ServiceFrontPublication>).catch(() => null),
      ]);
      setCollections(cols.collections);
      setPending(pend.documents);
      setOverview(ov);
      setPublication(front ? publicationSystemText(front) : null);
    } catch (e) {
      if (!silent) fail(e);
    } finally {
      setReady(true);
    }
  }, [fail]);

  const loadDocs = useCallback(async (collectionId: string) => {
    try {
      await ensureDemoLogin();
      const r = await trpc.service.kb.listDocuments.query(collectionId ? { collectionId } : undefined) as { documents: KbDocument[] };
      setDocuments(r.documents);
    } catch (e) { fail(e); }
  }, [fail]);

  const loadTickets = useCallback(async (status: string, dept: string) => {
    try {
      await ensureDemoLogin();
      const input = { ...(status ? { status } : {}), ...(dept ? { dept } : {}) };
      const r = await trpc.service.tickets.list.query(Object.keys(input).length > 0 ? input : undefined) as { tickets: Ticket[] };
      setTickets(r.tickets);
      setKnownDepts((current) => Array.from(new Set([
        ...current,
        ...r.tickets.map((ticket) => ticket.dept).filter((value): value is string => Boolean(value?.trim())),
      ])));
    } catch (e) { fail(e); }
  }, [fail]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadDocs(activeCol); }, [activeCol, loadDocs]);
  useEffect(() => { void loadTickets(fStatus, fDept); }, [fStatus, fDept, loadTickets]);
  // 轮询口径（D6）：15s 静默刷新集合/待审/报表与当前工单过滤
  useEffect(() => {
    const t = setInterval(() => { void load(true); void loadTickets(fStatus, fDept); }, 15_000);
    return () => clearInterval(t);
  }, [load, loadTickets, fStatus, fDept]);

  /* 文档表「切块数」列：以标题试检索命中块数投影（仅 active 文档入检索索引） */
  useEffect(() => {
    if (documents.length === 0) { setChunkCounts({}); return; }
    let cancelled = false;
    void (async () => {
      const m: Record<string, number> = {};
      for (const d of documents) {
        if (d.status !== "active") continue;
        try {
          const r = await trpc.service.kb.search.query({ query: d.title, limit: 20 }) as { hits: KbHit[] };
          m[d.id] = r.hits.filter((h) => h.documentId === d.id).length;
        } catch { /* 单篇失败不阻塞整表 */ }
      }
      if (!cancelled) setChunkCounts(m);
    })();
    return () => { cancelled = true; };
  }, [documents]);

  /* 文档详情抽屉：检索索引内容预览 */
  useEffect(() => {
    if (!docDrawer) { setDocPreview(null); return; }
    let cancelled = false;
    void (async () => {
      try {
        const r = await trpc.service.kb.search.query({ query: docDrawer.title, limit: 8 }) as { hits: KbHit[] };
        if (!cancelled) setDocPreview(r.hits.filter((h) => h.documentId === docDrawer.id));
      } catch { if (!cancelled) setDocPreview([]); }
    })();
    return () => { cancelled = true; };
  }, [docDrawer]);

  /* 工单时间线抽屉 */
  useEffect(() => {
    if (!timelineFor) { setTimeline(null); return; }
    let cancelled = false;
    void (async () => {
      try {
        const r = await trpc.service.tickets.timeline.query({ ticketId: timelineFor.id }) as { timeline: TicketEvent[] };
        if (!cancelled) setTimeline(r.timeline);
      } catch (e) { if (!cancelled) { setTimeline([]); fail(e); } }
    })();
    return () => { cancelled = true; };
  }, [timelineFor, fail]);

  /* ---------- 知识库动作 ---------- */
  const doCreateCol = useCallback(async () => {
    if (!newColName.trim()) return;
    setBusy("col");
    try {
      await trpc.service.kb.createCollection.mutate({ name: newColName.trim(), description: newColDesc.trim() || undefined });
      setBanner({ level: "info", text: `已新建集合「${newColName.trim()}」（事件已留痕）` });
      setNewColName(""); setNewColDesc("");
      await load(true);
    } catch (e) { fail(e); } finally { setBusy(null); }
  }, [newColName, newColDesc, load, fail]);

  const doSetDocStatus = useCallback(async (d: KbDocument, status: "active" | "disabled") => {
    setBusy(`doc-${d.id}`);
    try {
      await trpc.service.kb.setStatus.mutate({ documentId: d.id, status });
      setBanner({ level: status === "active" ? "info" : "warn", text: `「${d.title}」已置为${dictText(DOC_STATUS_TEXT, status)}${status === "disabled" ? "（即时退出检索索引）" : "（重新进入检索索引）"}` });
      setDocDrawer(null);
      setDocStatusConfirm(null);
      await loadDocs(activeCol);
      await load(true);
    } catch (e) { fail(e); } finally { setBusy(null); }
  }, [activeCol, loadDocs, load, fail]);

  const doApprove = useCallback(async (d: PendingDoc) => {
    setBusy(`apr-${d.id}`);
    try {
      const r = await trpc.service.kb.approveDocument.mutate({ documentId: d.id }) as { ok: boolean; eventId: string };
      setBanner({
        level: "info",
        text: `「${d.title}」第 ${d.version} 版已批准生效，审批中心与事件账本已同步。事件编号：${shortId(r.eventId)}。`,
      });
      await load(true);
      await loadDocs(activeCol);
    } catch (e) { fail(e); } finally { setBusy(null); }
  }, [activeCol, load, loadDocs, fail]);

  const doRegisterSite = useCallback(async () => {
    if (!siteUrl.trim()) return;
    setBusy("site");
    try {
      const r = await trpc.service.kb.registerSite.mutate({ url: siteUrl.trim() }) as { sourceId: string };
      setSiteId(r.sourceId);
      setSiteResult(`已登记抓取源 ${shortId(r.sourceId)}——可「立即抓取」入库`);
    } catch (e) { fail(e); } finally { setBusy(null); }
  }, [siteUrl, fail]);

  const doCrawl = useCallback(async () => {
    if (!siteId) return;
    setBusy("crawl");
    try {
      const r = await trpc.service.kb.crawlNow.mutate({ sourceId: siteId }) as { documentId: string; entryCount: number; degraded?: boolean };
      setSiteResult(`抓取完成：结构化 ${r.entryCount} 条入知识库（文档 ${shortId(r.documentId)}${r.degraded ? "；智能结构化不可用，已安全降级直存" : "；智能结构化正常"}）`);
      await load(true);
      await loadDocs(activeCol);
    } catch (e) { fail(e); } finally { setBusy(null); }
  }, [siteId, activeCol, load, loadDocs, fail]);

  const doDiff = useCallback(async () => {
    if (!siteId) return;
    setBusy("diff");
    try {
      const r = await trpc.service.kb.diffScan.mutate({ sourceId: siteId }) as { changed: boolean; newDocumentId?: string };
      setSiteResult(r.changed ? `检测到官网更新——已生成新版本文档 ${shortId(r.newDocumentId)}` : "指纹比对：官网暂无更新");
      await loadDocs(activeCol);
    } catch (e) { fail(e); } finally { setBusy(null); }
  }, [siteId, activeCol, loadDocs, fail]);

  const doSearch = useCallback(async () => {
    if (!query.trim()) return;
    setBusy("search");
    try {
      const r = await trpc.service.kb.search.query({ query: query.trim(), limit: 5 }) as { hits: KbHit[] };
      setHits(r.hits);
    } catch (e) { fail(e); } finally { setBusy(null); }
  }, [query, fail]);

  /* ---------- 工单动作 ---------- */
  const doAssign = useCallback(async () => {
    if (!assignFor) return;
    setBusy(`tk-${assignFor}`);
    try {
      await trpc.service.tickets.assign.mutate({ ticketId: assignFor, dept: assignDept, assignee: assignee.trim() || undefined });
      setBanner({ level: "info", text: `工单 ${shortId(assignFor)} 已分派 ${assignDept}${assignee.trim() ? ` / ${assignee.trim()}` : ""}` });
      setAssignFor(null); setAssignee("");
      await loadTickets(fStatus, fDept);
    } catch (e) { fail(e); } finally { setBusy(null); }
  }, [assignFor, assignDept, assignee, fStatus, fDept, loadTickets, fail]);

  const doAdvance = useCallback(async (t: Ticket) => {
    setBusy(`tk-${t.id}`);
    try {
      await trpc.service.tickets.advance.mutate({ ticketId: t.id, action: "start" });
      setBanner({ level: "info", text: `工单 ${shortId(t.id)} 开始处理（已分派 → 处理中 状态机断言）` });
      await loadTickets(fStatus, fDept);
    } catch (e) { fail(e); } finally { setBusy(null); }
  }, [fStatus, fDept, loadTickets, fail]);

  const doComplete = useCallback(async () => {
    if (!completeFor || !completeResult.trim()) return;
    setBusy(`tk-${completeFor}`);
    try {
      await trpc.service.tickets.complete.mutate({ ticketId: completeFor, result: completeResult.trim() });
      setBanner({ level: "info", text: `工单 ${shortId(completeFor)} 已办结——结果已推送通知 C 端（无真实通道，模拟发送）` });
      setCompleteFor(null); setCompleteResult("");
      await loadTickets(fStatus, fDept);
      await load(true);
    } catch (e) { fail(e); } finally { setBusy(null); }
  }, [completeFor, completeResult, fStatus, fDept, loadTickets, load, fail]);

  /* ---------- 报表解读 ---------- */
  const insights = useMemo(() => {
    if (!overview) return [] as Array<{ level: "go" | "warn" | "alert" | "info"; text: string }>;
    const xs: Array<{ level: "go" | "warn" | "alert" | "info"; text: string }> = [];
    if (overview.groundedRate !== null) {
      xs.push(overview.groundedRate >= 0.8
        ? { level: "go", text: `有据率 ${pct(overview.groundedRate)} 达标——回答基本带知识引用，不臆造。` }
        : { level: "warn", text: `有据率仅 ${pct(overview.groundedRate)}——建议补充知识库文档并复核低置信问答。` });
    }
    if (overview.avgConfidence !== null && overview.avgConfidence < 0.6) {
      xs.push({ level: "warn", text: `平均置信度 ${Math.round(overview.avgConfidence * 100)}% 偏低——低置信问题应优先转工单。` });
    }
    if (overview.slaBreached > 0) {
      xs.push({ level: "alert", text: `服务时限超时 ${overview.slaBreached} 单——请到工单台优先处理超时工单。` });
    } else if (overview.ticketsToday > 0) {
      xs.push({ level: "go", text: "服务时限无超时——工单流转在时限内。" });
    }
    if (overview.completionRate !== null) {
      xs.push({ level: "info", text: `今日工单 ${overview.ticketsToday} 单，完结率 ${pct(overview.completionRate)}${overview.avgRating !== null ? `，满意度均分 ${overview.avgRating}` : "（尚无满意度评价）"}。` });
    }
    if (overview.avgLatencyMs !== null) {
      xs.push({ level: "info", text: `平均首答延迟 ${latencyText(overview.avgLatencyMs)}（会话消息投影）。` });
    }
    return xs;
  }, [overview]);

  const overdue = useCallback((t: Ticket) =>
    t.slaDeadline !== null && new Date(t.slaDeadline).getTime() < Date.now() && t.status !== "done" && t.status !== "closed", []);

  /* ---------- 左栏 ---------- */
  const left = (
    <>
      <div className="mb-2 px-1 text-body tracking-[.2em] text-ink3">服务前台</div>
      {([
        ["kb", "知识中台", `集合 ${collections.length} · 待审 ${pending.length}`],
        ["tickets", "工单台", `在列 ${tickets.length}`],
        ["stats", "服务报表", overview ? `会话 ${overview.sessions} · 问答 ${overview.qaCount}` : "—"],
      ] as Array<[Tab, string, string]>).map(([key, label, meta]) => (
        <button
          key={key}
          type="button"
          onClick={() => selectTab(key)}
          className={`mb-1.5 block w-full cursor-pointer rounded-lg border px-3 py-2.5 text-left ${
            tab === key ? "border-gline bg-gold/6" : "border-line bg-card hover:border-gline"
          }`}
        >
          <div className={`text-body ${tab === key ? "text-gold" : "text-ink2"}`}>{label}</div>
          <div className="mt-0.5 text-body text-ink3">{meta}</div>
        </button>
      ))}
      <button
        type="button"
        onClick={() => nav("/")}
        className="mt-2 w-full cursor-pointer rounded-lg border border-line px-3 py-2 text-body text-ink3 hover:border-holo/40 hover:text-ink2"
      >
        ← 返回工作台
      </button>
    </>
  );

  /* ---------- 右栏 ---------- */
  const right = (
    <>
      <div className="mb-2 px-1 text-body tracking-[.2em] text-ink3">数据与治理口径</div>
      <div className="rounded-lg border border-line bg-card p-3 text-body leading-relaxed text-ink2">
        页面只显示当前公司和工作区的数据；改动都会留痕，知识发布会先到审批中心等你确认。
      </div>
      <div className="mt-2.5 rounded-lg border border-line bg-card p-3 text-body text-ink3">
        <div className="mb-1 text-body font-bold text-ink2">待审知识</div>
        <b className="font-orb text-[16px] text-warn">{pending.length}</b> 篇（{DOC_STATUS_TEXT.pending_review}）
      </div>
      <div className="mt-2.5 rounded-lg border border-line bg-card p-3 text-body text-ink3">
        <div className="mb-1 text-body font-bold text-ink2">服务时限超时</div>
        <b className={`font-orb text-[16px] ${overview && overview.slaBreached > 0 ? "text-alert" : "text-go"}`}>{overview?.slaBreached ?? "—"}</b> 单
      </div>
      <div className="mt-2.5 rounded-lg border border-line bg-card p-3 text-body leading-relaxed text-ink3">
        <div className="mb-1 text-body font-bold text-ink2">工单状态机</div>
        新建 → 已分派 → 处理中 → 已办结/已关闭；不符合规则的状态变更会被拒绝并说明原因。
      </div>
    </>
  );

  /* ---------- 知识库区块 ---------- */
  const kbSection = (
    <>
      {/* 集合列表 + 新建集合 */}
      <div className="mb-2 text-body font-bold tracking-wider text-ink2">知识集合（{collections.length}）</div>
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => setActiveCol("")}
          className={`cursor-pointer rounded border px-2.5 py-1 text-body ${activeCol === "" ? "border-holo/60 bg-holo/10 text-holo" : "border-line text-ink3 hover:border-holo/40"}`}
        >
          全部
        </button>
        {collections.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => setActiveCol(c.id)}
            title={c.description}
            className={`cursor-pointer rounded border px-2.5 py-1 text-body ${activeCol === c.id ? "border-holo/60 bg-holo/10 text-holo" : "border-line text-ink2 hover:border-holo/40"}`}
          >
            {c.name}
          </button>
        ))}
      </div>
      <div className="mb-5 flex gap-2">
        <input
          value={newColName}
          onChange={(e) => setNewColName(e.target.value)}
          placeholder="新集合名称（如：餐饮服务）"
          className="w-56 rounded-md border border-line bg-bg900 px-2.5 py-1.5 text-body text-ink outline-none focus:border-holo/50"
        />
        <input
          value={newColDesc}
          onChange={(e) => setNewColDesc(e.target.value)}
          placeholder="描述（可选）"
          className="flex-1 rounded-md border border-line bg-bg900 px-2.5 py-1.5 text-body text-ink outline-none focus:border-holo/50"
        />
        <button
          type="button"
          disabled={!newColName.trim() || busy === "col"}
          onClick={() => void doCreateCol()}
          className="cursor-pointer rounded-md gold-grad px-3.5 py-1.5 text-body font-bold text-ongold disabled:opacity-40"
        >
          <span className="inline-flex items-center gap-1"><Icon name="partner" size={15} aria-hidden="true" />新建集合</span>
        </button>
      </div>

      {/* 文档表 */}
      <div className="mb-2 text-body font-bold tracking-wider text-ink2">
        文档{activeCol ? ` · ${collections.find((c) => c.id === activeCol)?.name ?? ""}` : "（全部集合）"}（{documents.length}）
      </div>
      {documents.length === 0 ? (
        <div className="mb-5"><EmptyState icon={<Icon name="document" size={24} />} title="该集合暂无文档" hint="用「官网源」抓取或落地向导录入；文档切块后进入检索索引" /></div>
      ) : (
        <div className="mb-5 overflow-hidden rounded-lg border border-line">
          <table className="w-full text-body">
            <thead>
              <tr className="border-b border-line bg-bg800/60 text-left text-body text-ink3">
                <th className="px-3 py-2 font-normal">标题</th>
                <th className="px-3 py-2 font-normal">来源</th>
                <th className="px-3 py-2 font-normal">版本</th>
                <th className="px-3 py-2 font-normal">状态</th>
                <th className="px-3 py-2 font-normal">切块数</th>
                <th className="px-3 py-2 font-normal" />
              </tr>
            </thead>
            <tbody>
              {documents.map((d) => (
                <tr key={d.id} className="border-b border-line/60 last:border-0 hover:bg-bg800/40">
                  <td className="px-3 py-2 text-ink2">{d.title}</td>
                  <td className="px-3 py-2 text-ink3">
                    {dictText(SOURCE_KIND_TEXT, d.sourceKind)}
                    {d.sourceUrl && <span className="ml-1 inline-flex text-holo" title={d.sourceUrl}><Icon name="chevron" size={13} aria-hidden="true" /></span>}
                  </td>
                  <td className="px-3 py-2 text-ink3">{versionText(String(d.version))}</td>
                  <td className="px-3 py-2">{docStatusChip(d.status)}</td>
                  <td className="px-3 py-2 font-orb text-holo">{d.status === "active" ? (chunkCounts[d.id] ?? "…") : "—"}</td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => setDocDrawer(d)}
                      className="cursor-pointer rounded border border-line px-2 py-0.5 text-body text-ink2 hover:border-holo/50"
                    >
                      详情
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 待审区 */}
      <div className="mb-2 text-body font-bold tracking-wider text-ink2">待审区（{DOC_STATUS_TEXT.pending_review} · {pending.length}）</div>
      {pending.length === 0 ? (
        <div className="mb-5 rounded-lg border border-dashed border-line p-4 text-center text-body text-ink3">
          暂无待审文档——抓取/录入的文档经批准生效后才进入检索索引
        </div>
      ) : (
        <div className="mb-5 space-y-2">
          {pending.map((d) => (
            <div key={d.id} className="flex items-center gap-3 rounded-lg border border-warn/35 bg-card px-3.5 py-2.5">
              <Icon name="edit" size={16} />
              <div className="flex-1">
                <div className="text-body text-ink">{d.title} <span className="text-body text-ink3">{versionText(String(d.version))}</span></div>
                <div className="text-body text-ink3">
                  {dictText(SOURCE_KIND_TEXT, d.source_kind)}{d.source_url ? ` · ${d.source_url}` : ""} · 提交于 {new Date(d.created_at).toLocaleString("zh-CN", { hour12: false })}
                </div>
              </div>
              <button
                type="button"
                disabled={busy === `apr-${d.id}`}
                onClick={() => void doApprove(d)}
                title="批准后发布文档，并同步审批中心与事件账本"
                className="cursor-pointer rounded-md border border-go/50 px-3 py-1 text-body font-bold text-go hover:bg-go/10 disabled:opacity-40"
              >
                <Icon name="check" size={14} className="inline" /> 批准生效
              </button>
            </div>
          ))}
          <div className="text-body text-ink3">批准即发布：审批记录和发布事件会同步留痕，可在审批中心与事件账本复核。</div>
        </div>
      )}

      {/* 官网源 + 试检索 */}
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg border border-line bg-card p-3.5">
          <div className="mb-1.5 text-body font-bold text-holo">官网内容源</div>
          <div className="flex gap-2">
            <input
              value={siteUrl}
              onChange={(e) => setSiteUrl(e.target.value)}
              placeholder="https://www.example.com"
              className="flex-1 rounded-md border border-line bg-bg900 px-2.5 py-1.5 text-body text-ink outline-none focus:border-holo/50"
            />
            <button
              type="button"
              disabled={!siteUrl.trim() || busy === "site"}
              onClick={() => void doRegisterSite()}
              className="cursor-pointer rounded-md border border-gline px-2.5 py-1.5 text-body font-bold text-goldhi hover:border-gold/60 disabled:opacity-40"
            >
              登记
            </button>
          </div>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={!siteId || busy === "crawl"}
              onClick={() => void doCrawl()}
              title={siteId ? "" : "先登记抓取源"}
              className="cursor-pointer rounded border border-holo/40 px-2.5 py-1 text-body text-holo hover:bg-holo/10 disabled:opacity-40"
            >
              <Icon name="lightning" size={14} className="inline" /> 立即抓取
            </button>
            <button
              type="button"
              disabled={!siteId || busy === "diff"}
              onClick={() => void doDiff()}
              title={siteId ? "" : "先登记抓取源"}
              className="cursor-pointer rounded border border-line px-2.5 py-1 text-body text-ink2 hover:border-holo/40 disabled:opacity-40"
            >
              <Icon name="search" size={14} className="inline" /> 检查更新
            </button>
          </div>
          {siteId && <div className="mt-1.5 font-mono text-body text-ink3">抓取源编号 {shortId(siteId)}</div>}
          {siteResult && <div className="mt-1.5 rounded border border-line bg-bg800/60 px-2 py-1 text-body leading-relaxed text-ink2">{siteResult}</div>}
        </div>

        <div className="rounded-lg border border-line bg-card p-3.5">
          <div className="mb-1.5 flex items-center gap-1 text-body font-bold text-holo"><Icon name="search" size={14} />试检索（混合检索）</div>
          <div className="flex gap-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void doSearch(); }}
              placeholder="如：如何查询服务进度？"
              className="flex-1 rounded-md border border-line bg-bg900 px-2.5 py-1.5 text-body text-ink outline-none focus:border-holo/50"
            />
            <button
              type="button"
              disabled={!query.trim() || busy === "search"}
              onClick={() => void doSearch()}
              className="cursor-pointer rounded-md gold-grad px-3 py-1.5 text-body font-bold text-ongold disabled:opacity-40"
            >
              检索
            </button>
          </div>
          <div className="mt-2 space-y-1.5">
            {hits === null ? (
              <div className="text-body text-ink3">输入问题试检——命中块带相关度评分（0..1 归一化）</div>
            ) : hits.length === 0 ? (
              <div className="text-body text-warn">无命中——可考虑补充知识文档</div>
            ) : hits.map((h, i) => (
              <div key={i} className="rounded border border-line bg-bg800/60 px-2 py-1.5">
                <div className="flex items-center justify-between text-body">
                  <span className="text-ink2">{h.documentTitle}{h.heading ? ` · ${h.heading}` : ""}</span>
                  <span className="font-orb text-holo">{h.score.toFixed(2)}</span>
                </div>
                <div className="mt-0.5 line-clamp-2 text-body leading-relaxed text-ink3">{h.content}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );

  /* ---------- 工单台区块 ---------- */
  const ticketsSection = (
    <>
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-body font-bold text-ink2">状态</span>
        {TICKET_STATUS.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => setFStatus(s.key)}
            className={`cursor-pointer rounded border px-2 py-0.5 text-body ${fStatus === s.key ? "border-holo/60 bg-holo/10 text-holo" : "border-line text-ink3 hover:border-holo/40"}`}
          >
            {s.label}
          </button>
        ))}
        <span className="mx-2 text-line">|</span>
        <span className="mr-1 text-body font-bold text-ink2">部门</span>
        {["", ...knownDepts].map((d) => (
          <button
            key={d || "all"}
            type="button"
            onClick={() => setFDept(d)}
            className={`cursor-pointer rounded border px-2 py-0.5 text-body ${fDept === d ? "border-holo/60 bg-holo/10 text-holo" : "border-line text-ink3 hover:border-holo/40"}`}
          >
            {d || "全部"}
          </button>
        ))}
      </div>

      {tickets.length === 0 ? (
        <EmptyState icon={<Icon name="ticket" size={24} />} title="当前过滤下暂无工单" hint="C 端低置信/投诉类会话会自动转工单；调整状态或部门过滤试试" />
      ) : (
        <div className="space-y-2">
          {tickets.map((t) => (
            <div key={t.id} className={`rounded-lg border bg-card p-3 ${overdue(t) ? "border-alert/50" : "border-line"}`}>
              <div className="flex items-center gap-2.5">
                <span className="font-mono text-body text-ink3">{shortId(t.id)}</span>
                {ticketStatusChip(t.status)}
                <span className="rounded border border-line px-1.5 py-0.5 text-body text-ink3">{dictText(TICKET_KIND_TEXT, t.kind)}</span>
                {t.priority !== "normal" && <span className="rounded border border-alert/40 px-1.5 py-0.5 text-body text-alert">{dictText(TICKET_PRIORITY_TEXT, t.priority)}</span>}
                {overdue(t) && <span className="rounded border border-alert/50 bg-alert/8 px-1.5 py-0.5 text-body text-alert">服务时限超时</span>}
                <span className="flex-1" />
                <button
                  type="button"
                  onClick={() => setTimelineFor(t)}
                  className="cursor-pointer rounded border border-line px-2 py-0.5 text-body text-ink2 hover:border-holo/50"
                >
                  时间线
                </button>
                {t.status === "created" && (
                  <button
                    type="button"
                    onClick={() => { setAssignFor(t.id); setCompleteFor(null); }}
                    className="cursor-pointer rounded border border-gline px-2 py-0.5 text-body font-bold text-goldhi hover:border-gold/60"
                  >
                    分派
                  </button>
                )}
                {t.status === "assigned" && (
                  <button
                    type="button"
                    disabled={!assignDept.trim() || busy === `tk-${t.id}`}
                    onClick={() => void doAdvance(t)}
                    className="cursor-pointer rounded border border-holo/40 px-2 py-0.5 text-body font-bold text-holo hover:bg-holo/10 disabled:opacity-40"
                  >
                    <Icon name="play" size={13} className="inline" /> 开始处理
                  </button>
                )}
                {(t.status === "processing" || t.status === "assigned") && (
                  <button
                    type="button"
                    onClick={() => { setCompleteFor(t.id); setAssignFor(null); }}
                    className="cursor-pointer rounded border border-go/50 px-2 py-0.5 text-body font-bold text-go hover:bg-go/10"
                  >
                    <Icon name="check" size={13} className="inline" /> 办结
                  </button>
                )}
              </div>
              <div className="mt-1.5 text-body text-ink">{t.title}</div>
              <div className="mt-1 text-body text-ink3">
                {t.dept ? `部门 ${t.dept}` : "未分派"}{t.assignee ? ` · 处理人 ${t.assignee}` : ""}
                {t.slaDeadline && ` · 服务时限 ${new Date(t.slaDeadline).toLocaleString("zh-CN", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`}
                {t.ratingScore !== null && ` · 满意度 ${t.ratingScore} 分`}
                {" · 创建于 "}{new Date(t.createdAt).toLocaleString("zh-CN", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
              </div>

              {/* 行内分派 */}
              {assignFor === t.id && (
                <div className="mt-2 flex items-center gap-2 rounded-md border border-gline bg-bg800/60 px-2.5 py-2">
                  <span className="text-body text-goldhi">分派到</span>
                  <input
                    list="workloom-ticket-departments"
                    value={assignDept}
                    onChange={(e) => setAssignDept(e.target.value)}
                    placeholder="输入负责团队"
                    className="rounded border border-line bg-bg900 px-2 py-1 text-body text-ink outline-none"
                  />
                  <datalist id="workloom-ticket-departments">
                    {knownDepts.map((d) => <option key={d} value={d} />)}
                  </datalist>
                  <input
                    value={assignee}
                    onChange={(e) => setAssignee(e.target.value)}
                    placeholder="处理人（可选）"
                    className="w-36 rounded border border-line bg-bg900 px-2 py-1 text-body text-ink outline-none focus:border-holo/50"
                  />
                  <button
                    type="button"
                    disabled={busy === `tk-${t.id}`}
                    onClick={() => void doAssign()}
                    className="cursor-pointer rounded gold-grad px-2.5 py-1 text-body font-bold text-ongold disabled:opacity-40"
                  >
                    确认分派
                  </button>
                  <button type="button" onClick={() => setAssignFor(null)} className="cursor-pointer text-body text-ink3 hover:text-ink2">取消</button>
                </div>
              )}

              {/* 行内办结 */}
              {completeFor === t.id && (
                <div className="mt-2 flex items-center gap-2 rounded-md border border-go/40 bg-bg800/60 px-2.5 py-2">
                  <span className="text-body text-go">处理结果</span>
                  <input
                    value={completeResult}
                    onChange={(e) => setCompleteResult(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void doComplete(); }}
                    placeholder="如：已上门更换灯泡并确认恢复正常"
                    className="flex-1 rounded border border-line bg-bg900 px-2 py-1 text-body text-ink outline-none focus:border-go/50"
                  />
                  <button
                    type="button"
                    disabled={!completeResult.trim() || busy === `tk-${t.id}`}
                    onClick={() => void doComplete()}
                    title="办结后将结果通知客户移动端"
                    className="cursor-pointer rounded border border-go/50 bg-go/10 px-2.5 py-1 text-body font-bold text-go disabled:opacity-40"
                  >
                    确认办结
                  </button>
                  <button type="button" onClick={() => setCompleteFor(null)} className="cursor-pointer text-body text-ink3 hover:text-ink2">取消</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );

  /* ---------- 报表区块 ---------- */
  const metric = (label: string, value: string, opts?: { tone?: "go" | "warn" | "alert" | "holo"; hint?: string }) => (
    <div className="rounded-lg border border-line bg-card p-3">
      <div className="text-body text-ink3">{label}</div>
      <div className={`mt-1 font-orb text-h2 font-bold ${opts?.tone === "alert" ? "text-alert" : opts?.tone === "warn" ? "text-warn" : opts?.tone === "go" ? "text-go" : opts?.tone === "holo" ? "text-holo" : "text-ink"}`}>
        {value}
      </div>
      {opts?.hint && <div className="mt-0.5 text-body text-ink3">{opts.hint}</div>}
    </div>
  );
  const statsSection = overview === null ? (
    <EmptyState icon={<Icon name="report" size={24} />} title="暂无运营数据" hint="住客的对话和工单产生后，今天的处理情况会汇总在这里" />
  ) : (
    <>
      <div className="mb-2 text-body font-bold tracking-wider text-ink2">今日运营总览（{overview.date} · 会话与工单聚合）</div>
      <div className="mb-4 grid grid-cols-3 gap-3">
        {metric("今日会话", String(overview.sessions), { tone: "holo" })}
        {metric("问答量", String(overview.qaCount), { tone: "holo" })}
        {metric("平均置信度", overview.avgConfidence === null ? "—" : `${Math.round(overview.avgConfidence * 100)}%`, { tone: overview.avgConfidence !== null && overview.avgConfidence < 0.6 ? "warn" : undefined, hint: confidenceText(overview.avgConfidence) })}
        {metric("有据率（带引用回答）", pct(overview.groundedRate), { tone: overview.groundedRate !== null && overview.groundedRate >= 0.8 ? "go" : "warn" })}
        {metric("平均首答延迟", latencyText(overview.avgLatencyMs))}
        {metric("今日工单", String(overview.ticketsToday))}
        {metric("工单完结率", pct(overview.completionRate), { tone: "go" })}
        {metric("服务时限超时", String(overview.slaBreached), { tone: overview.slaBreached > 0 ? "alert" : "go", hint: overview.slaBreached > 0 ? "需立即介入" : "在时限内" })}
        {metric("满意度均分", overview.avgRating === null ? "—" : String(overview.avgRating), { hint: "C 端办结评价" })}
      </div>
      <div className="rounded-lg border border-line bg-card p-3.5">
        <div className="mb-1.5 text-body font-bold text-holo">解读</div>
        {insights.length === 0 ? (
          <div className="text-body text-ink3">数据积累中——产生更多会话/工单后给出运营建议。</div>
        ) : (
          <ul className="space-y-1 text-body leading-relaxed">
            {insights.map((x, i) => (
              <li key={i} className={x.level === "alert" ? "text-alert" : x.level === "warn" ? "text-warn" : x.level === "go" ? "text-go" : "text-ink2"}>
                · {x.text}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );

  return (
    <Bridge left={left} right={right}>
      <div className="px-1">
        <div className="mb-4 flex items-baseline gap-3">
          <h2 className="text-[20px] font-black text-ink">服务前台</h2>
          <span className="text-body text-ink3">知识中台与工单台 · B 端管理</span>
        </div>

        {banner && (
          <div className="mb-3">
            <BannerAlert level={banner.level} actionLabel="知道了" onAction={() => setBanner(null)}>{banner.text}</BannerAlert>
          </div>
        )}

        {/* 顶部 C 端入口卡 */}
        <div className="mb-4 flex min-w-0 flex-wrap items-center gap-4 rounded-lg border border-gline bg-card p-3.5">
          {publication?.qrAvailable && publication.url ? <UrlQrCode value={publication.url} size={100} /> : (
            <div className="flex h-[100px] w-[100px] shrink-0 items-center justify-center rounded border border-dashed border-line p-2 text-center text-body leading-relaxed text-ink3">
              {publication?.url ? "该地址当前不满足手机扫码访问条件" : "尚未配置客户可访问地址"}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-body font-bold text-ink"><Icon name="service" size={15} />C 端服务前台入口</div>
            <div className="mt-0.5 break-words text-body leading-relaxed text-ink2">
              {publication?.overall === "published" ? "已正式发布" : publication?.overall === "preview" ? "当前仅可预览，尚未正式发布" : "尚未满足发布条件"}
              ——知识问答、业务查询、工单流转与结果通知。
            </div>
            {publication?.url && <div className="mt-1 break-all text-body text-holo">{publication.url}</div>}
            <div className="mt-2 grid min-w-0 grid-cols-1 gap-1.5 sm:grid-cols-3">
              {(publication?.channels ?? []).map((channel) => {
                const label = clientChineseText(channel.label, "服务渠道");
                const detail = clientChineseText(channel.detail, "渠道状态说明待确认");
                return (
                  <div key={channel.key} className={`min-w-0 rounded border px-2 py-1 text-body ${PUBLICATION_TONE[channel.status]}`} title={detail}>
                    <div className="break-words font-semibold">{label} · {PUBLICATION_STATUS[channel.status]}</div>
                    <div className="mt-0.5 break-words leading-relaxed opacity-80">{detail}</div>
                  </div>
                );
              })}
              {!publication && <span className="text-body text-warn">发布状态暂时无法读取，不会显示为已发布。</span>}
            </div>
          </div>
          {publication?.url && (
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => void copyPublicationUrl()} className="cursor-pointer rounded-md border border-line px-3.5 py-2 text-body text-ink2">复制链接</button>
              <a href={publication.url} target="_blank" rel="noreferrer" className="inline-flex cursor-pointer max-w-full items-center gap-1 whitespace-normal break-words rounded-md gold-grad px-3.5 py-2 text-body font-bold text-ongold no-underline">打开地址检查 <Icon name="chevron" size={13} aria-hidden="true" /></a>
            </div>
          )}
        </div>

        {!ready ? (
          <Skeleton count={5} height={72} label="服务数据正在加载" />
        ) : tab === "kb" ? kbSection : tab === "tickets" ? ticketsSection : statsSection}
      </div>

      {/* 文档详情抽屉 */}
      {docDrawer && (
        <Overlay
          open
          kind="drawer"
          title="文档详情"
          description={docDrawer.title}
          onClose={() => setDocDrawer(null)}
        >
            <h3 className="text-body font-bold text-ink">{docDrawer.title}</h3>
            <div className="mt-1.5 flex items-center gap-2 text-body text-ink3">
              {docStatusChip(docDrawer.status)}
              <span>{versionText(String(docDrawer.version))}</span>
              <span>{dictText(SOURCE_KIND_TEXT, docDrawer.sourceKind)}</span>
              <span className="font-mono">{shortId(docDrawer.id)}</span>
            </div>
            {docDrawer.sourceUrl && (
              <div className="mt-1 break-all font-mono text-body text-holo">{docDrawer.sourceUrl}</div>
            )}
            <div className="mt-3 rounded-lg border border-line bg-card p-3">
              <div className="mb-1.5 text-body font-bold text-ink2">内容预览</div>
              {docDrawer.status !== "active" ? (
                <div className="text-body text-ink3">
                  {docDrawer.status === "pending_review" ? "待审文档未入检索索引——待审区批准生效后可检索" : "已停用文档不在检索索引中"}
                </div>
              ) : docPreview === null ? (
                <Skeleton count={3} height={40} label="详情正在加载" />
              ) : docPreview.length === 0 ? (
                <div className="text-body text-warn">索引中无命中块（可能切块为空或未命中标题词）</div>
              ) : (
                <div className="space-y-1.5">
                  {docPreview.map((h, i) => (
                    <div key={i} className="rounded border border-line bg-bg800/60 px-2 py-1.5">
                      {h.heading && <div className="text-body font-bold text-ink2">{h.heading}</div>}
                      <div className="mt-0.5 line-clamp-3 text-body leading-relaxed text-ink3">{h.content}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="mt-3 flex gap-2">
              {docDrawer.status !== "active" && (
                <button
                  type="button"
                  disabled={busy === `doc-${docDrawer.id}`}
                  onClick={() => setDocStatusConfirm({ document: docDrawer, status: "active" })}
                  title={docDrawer.status === "pending_review" ? "待审文档建议走待审区批准（联动审批台）" : ""}
                  className="cursor-pointer rounded-md border border-go/50 px-3 py-1.5 text-body font-bold text-go hover:bg-go/10 disabled:opacity-40"
                >
                  <Icon name="play" size={13} className="inline" /> 置为{DOC_STATUS_TEXT.active}
                </button>
              )}
              {docDrawer.status !== "disabled" && (
                <button
                  type="button"
                  disabled={busy === `doc-${docDrawer.id}`}
                  onClick={() => setDocStatusConfirm({ document: docDrawer, status: "disabled" })}
                  className="cursor-pointer rounded-md border border-line px-3 py-1.5 text-body text-ink3 hover:border-alert/40 hover:text-alert disabled:opacity-40"
                >
                  <Icon name="brake" size={13} className="inline" /> 停用
                </button>
              )}
            </div>
            {docDrawer.status === "pending_review" && (
              <div className="mt-2 text-body text-warn">提示：待审文档建议到「待审区」批准生效，审批记录会同步进入审批中心和事件账本。</div>
            )}
        </Overlay>
      )}

      {/* 文档状态会改变客户问答的检索范围；确认层叠在详情抽屉之上，Esc 只关闭最上层。 */}
      <ConfirmDialog
        open={docStatusConfirm !== null}
        title={docStatusConfirm?.status === "disabled" ? "确认停用知识文档" : "确认启用知识文档"}
        description={docStatusConfirm?.document.title}
        confirmLabel={docStatusConfirm?.status === "disabled" ? "确认停用" : "确认启用"}
        confirmVariant={docStatusConfirm?.status === "disabled" ? "danger" : "primary"}
        confirming={docStatusConfirm !== null && busy === `doc-${docStatusConfirm.document.id}`}
        onClose={() => setDocStatusConfirm(null)}
        onConfirm={() => {
          if (docStatusConfirm) void doSetDocStatus(docStatusConfirm.document, docStatusConfirm.status);
        }}
      >
        <p className="m-0 text-body leading-relaxed text-ink2">
          {docStatusConfirm?.status === "disabled"
            ? "停用后该文档会立即退出客户问答的检索范围；历史事件仍可在事件账本中追溯。"
            : "启用后该文档会重新进入客户问答的检索范围，操作会写入事件账本。"}
        </p>
      </ConfirmDialog>

      {/* 工单时间线抽屉 */}
      {timelineFor && (
        <Overlay
          open
          kind="drawer"
          title="工单时间线"
          description={timelineFor.title}
          onClose={() => setTimelineFor(null)}
        >
            <h3 className="text-body font-bold text-ink">{timelineFor.title}</h3>
            <div className="mt-1.5 flex items-center gap-2 text-body text-ink3">
              {ticketStatusChip(timelineFor.status)}
              <span className="font-mono">{shortId(timelineFor.id)}</span>
              <span>{dictText(TICKET_KIND_TEXT, timelineFor.kind)}</span>
            </div>
            <div className="mt-3">
              {timeline === null ? (
                <Skeleton count={4} height={40} label="发布状态正在加载" />
              ) : timeline.length === 0 ? (
                <div className="text-body text-ink3">暂无流转事件</div>
              ) : (
                <div className="space-y-0">
                  {timeline.map((ev, i) => (
                    <div key={ev.id} className="relative border-l border-line pb-3 pl-3.5">
                      <span className={`absolute -left-[5px] top-1 h-2 w-2 rounded-full ${i === timeline.length - 1 ? "bg-holo animate-pulse-hud" : "bg-ink3"}`} />
                      <div className="text-body text-ink2">
                        <b className="text-body text-holo">{actionText(ev.action)}</b>
                        <span className="ml-1.5 text-body text-ink3">{dictText(TICKET_ACTOR_TEXT, ev.actorType)}</span>
                      </div>
                      {Object.keys(ev.detail).length > 0 && (
                        <div className="mt-0.5 break-words text-body leading-relaxed text-ink3">{payloadText(ev.detail, 220)}</div>
                      )}
                      <div className="mt-0.5 text-body text-ink3">{new Date(ev.createdAt).toLocaleString("zh-CN", { hour12: false })}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
        </Overlay>
      )}
    </Bridge>
  );
}
