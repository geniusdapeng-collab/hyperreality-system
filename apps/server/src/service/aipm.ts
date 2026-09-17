/**
 * service/aipm · AI 产品经理技能真实执行面（方案 V4 P1）
 * 真实接线纪律：github-pulse 真实调 GitHub API；industry-radar 真实拉 RSS；
 * competitor-scan 真实抓取竞品页面；prd-forge 真实 LLM 生成可导出 MD。
 * 凭据走 credentials 表（L4 Patch 注入纪律：secret_enc 不进事件明文、不回传给前端）。
 * LLM 缺配置时返回 mock:true 的确定性兜底（D4 离线可跑），绝不假装真实。
 */
import { createHash } from "node:crypto";
import { svcQuery, serviceTx } from "./events.js";
import { llmCall } from "./llm.js";

const UA = { "User-Agent": "WorkLoom-AIPM/1.0 (+https://github.com/geniusdapeng-collab/workloom-im)" };

/* ---------------- 凭据读取（仅服务端；secret 不出进程） ---------------- */
async function readCredential(workspaceId: string, provider: string): Promise<string | null> {
  const rows = await svcQuery<{ secret_enc: string }>(workspaceId,
    `SELECT secret_enc FROM credentials WHERE provider=$1 AND health != 'revoked' LIMIT 1`, [provider]);
  // 注意：当前 credentials 为开发态明文占位（正式环境接 KMS 解密层）；绝不写入事件/日志/响应体外
  return rows[0]?.secret_enc ?? process.env[`AIPM_${provider.toUpperCase().replace(/-/g, "_")}_TOKEN`] ?? null;
}

/* ---------------- github-pulse：仓库脉搏（真实 GitHub API） ---------------- */
/**
 * API base 回退链：直连 api.github.com 优先；不可达时走公共镜像（gh-proxy.com）。
 * 可用 GITHUB_API_BASE 环境变量覆盖整条链（逗号分隔多个 base 按序尝试）。
 * 纪律：无论走哪个 base 都是真实 GitHub 数据；全部失败才落 mock（D4 绝不假装真实）。
 */
const GITHUB_API_BASES = (process.env.GITHUB_API_BASE ??
  "https://api.github.com,https://gh-proxy.com/https://api.github.com"
).split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);

async function ghFetch(path: string, headers: Record<string, string>): Promise<unknown> {
  let lastErr: unknown = null;
  for (const base of GITHUB_API_BASES) {
    try {
      const res = await fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(12_000) });
      if (res.ok) return await res.json();
      lastErr = new Error(`${base} -> HTTP ${res.status}`);
    } catch (e) { lastErr = e; }
  }
  throw lastErr ?? new Error("all GitHub API bases failed");
}

export interface RepoPulse {
  repo: string;
  commits7d: number;
  openIssues: number;
  openPrs: number;
  analysis: string;
  mock: boolean;
}

export async function githubPulse(workspaceId: string, repos: string[]): Promise<{ pulses: RepoPulse[]; mock: boolean }> {
  const token = await readCredential(workspaceId, "github");
  const headers: Record<string, string> = { ...UA, Accept: "application/vnd.github+json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const pulses: RepoPulse[] = [];
  let anyMock = false;
  for (const repo of repos.slice(0, 8)) {
    try {
      const since = new Date(Date.now() - 7 * 86400_000).toISOString();
      const [commits, issues, prs] = await Promise.all([
        ghFetch(`/repos/${repo}/commits?since=${since}&per_page=100`, headers),
        ghFetch(`/repos/${repo}/issues?state=open&per_page=100`, headers),
        ghFetch(`/repos/${repo}/pulls?state=open&per_page=100`, headers),
      ]);
      const issueCount = (issues as unknown[]).filter((i) => !(i as { pull_request?: unknown }).pull_request).length;
      pulses.push({
        repo,
        commits7d: (commits as unknown[]).length,
        openIssues: issueCount,
        openPrs: (prs as unknown[]).length,
        analysis: "",
        mock: false,
      });
    } catch {
      anyMock = true;
      pulses.push({ repo, commits7d: 0, openIssues: 0, openPrs: 0, analysis: "（仓库读取失败——检查 token 与仓库名）", mock: true });
    }
  }

  // LLM 分析（缺配置走确定性模板兜底）
  const llm = llmCall("aipm-github-pulse");
  const facts = pulses.map((p) => `${p.repo}: 7天提交${p.commits7d}/开放issue${p.openIssues}/开放PR${p.openPrs}`).join("；");
  if (llm && !anyMock) {
    try {
      const analysis = await llm(
        `你是发布护航官。基于以下 GitHub 仓库近 7 天脉搏数据，给出 120 字内的产品健康度分析（活跃度/阻塞点/下一步建议），直接给结论：${facts}`);
      for (const p of pulses) p.analysis = analysis;
    } catch {
      for (const p of pulses) p.analysis = `近 7 天提交 ${p.commits7d} 次，开放 issue ${p.openIssues}、PR ${p.openPrs}。`;
    }
  } else {
    for (const p of pulses) if (!p.analysis) p.analysis = `近 7 天提交 ${p.commits7d} 次，开放 issue ${p.openIssues}、PR ${p.openPrs}。`;
  }
  return { pulses, mock: anyMock || !llm };
}

/* ---------------- industry-radar：行业情报聚合（真实 RSS） ---------------- */
const DEFAULT_FEEDS = [
  "https://openai.com/news/rss.xml",
  "https://www.anthropic.com/news/rss.xml",
  "https://qbitai.com/feed",
];

export interface IntelItem {
  title: string;
  link: string;
  source: string;
  published: string;
  summary?: string;
}

export async function industryRadar(workspaceId: string, feeds?: string[]): Promise<{ items: IntelItem[]; mock: boolean }> {
  const sources = feeds ?? DEFAULT_FEEDS;
  const items: IntelItem[] = [];
  for (const url of sources) {
    try {
      const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) continue;
      const xml = await res.text();
      const host = new URL(url).hostname;
      // RSS/Atom 轻解析（<item>/<entry> 标题+链接+日期）
      const entries = [...xml.matchAll(/<item[\s>]([\s\S]*?)<\/item>|<entry[\s>]([\s\S]*?)<\/entry>/g)].slice(0, 8);
      for (const e of entries) {
        const body = e[1] ?? e[2] ?? "";
        const title = /<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/.exec(body)?.[1]?.trim();
        const link = /<link[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/.exec(body)?.[1]?.trim()
          ?? /<link[^>]*href="([^"]+)"/.exec(body)?.[1];
        const published = /<pubDate>([\s\S]*?)<\/pubDate>|<published[^>]*>([\s\S]*?)<\/published>|<updated[^>]*>([\s\S]*?)<\/updated>/.exec(body)?.slice(1).find(Boolean)?.trim() ?? "";
        if (title && link) items.push({ title, link, source: host, published });
      }
    } catch { /* 单源失败不阻塞其他源 */ }
  }
  // 去重（标题哈希）
  const seen = new Set<string>();
  const deduped = items.filter((it) => {
    const h = createHash("sha1").update(it.title).digest("hex");
    if (seen.has(h)) return false;
    seen.add(h);
    return true;
  }).slice(0, 12);

  // LLM 摘要 Top3（缺配置只附原始条目，标 mock）
  const llm = llmCall("aipm-industry-radar");
  if (llm && deduped.length > 0) {
    try {
      const brief = await llm(
        `你是行业瞭望官。从以下 AI 行业新闻标题中精选最重要的 3 条，每条一句话说清"发生了什么+对产品人意味着什么"，附序号：\n${deduped.map((i, n) => `${n + 1}. ${i.title}（${i.source}）`).join("\n")}`);
      for (const it of deduped) it.summary = brief;
    } catch { /* 摘要失败保留原条目 */ }
  }
  // 落库留痕（情报集）
  await serviceTx(workspaceId, async (client) => {
    for (const it of deduped) {
      await client.query(
        `INSERT INTO kb_documents (id, workspace_id, collection_id, title, source_kind, source_url, version, status, content_md, hash, created_at)
         VALUES ($1,$2,$3,$4,'official_site',$5,1,'active',$6,$7,now())
         ON CONFLICT (id) DO NOTHING`,
        [`kd-intel-${createHash("sha1").update(it.link).digest("hex").slice(0, 12)}`, workspaceId,
         `kc-${workspaceId}-行业情报`, it.title.slice(0, 120), it.link, it.summary ?? it.title,
         createHash("sha1").update(it.link).digest("hex")],
      ).catch(() => undefined);   // 集合不存在时静默（不影响返回）
    }
  });
  return { items: deduped, mock: !llm };
}

/* ---------------- competitor-scan：竞品页面抓取对比（真实 fetch） ---------------- */
export async function competitorScan(workspaceId: string, targets: Array<{ name: string; url: string }>): Promise<{ reports: Array<{ name: string; url: string; changed: boolean; snippet: string; mock: boolean }> }> {
  const reports = [];
  for (const t of targets.slice(0, 6)) {
    try {
      const res = await fetch(t.url, { headers: UA, signal: AbortSignal.timeout(12_000) });
      const html = res.ok ? await res.text() : "";
      const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 4000);
      const hash = createHash("sha1").update(text).digest("hex");
      // 与上次快照比对（org_memory 存快照哈希）
      const prev = await svcQuery<{ content: string }>(workspaceId,
        `SELECT content FROM org_memory WHERE kind='competitor-snapshot' AND content LIKE $1 LIMIT 1`, [`%${t.url}%`]);
      const changed = prev.length > 0 && !prev[0]!.content.includes(hash);
      await svcQuery(workspaceId,
        `INSERT INTO org_memory (memory_id, tenant_id, workspace_id, scope, kind, content, source_events)
         VALUES ($1, 'demo', current_setting('app.workspace_id', true), 'workspace', 'competitor-snapshot', $2, '{}')
         ON CONFLICT (memory_id) DO UPDATE SET content=EXCLUDED.content`,
        [`mem-comp-${createHash("sha1").update(t.url).digest("hex").slice(0, 10)}`, `${t.name}（${t.url}）页面快照哈希：${hash}`]).catch(() => undefined);
      reports.push({ name: t.name, url: t.url, changed, snippet: text.slice(0, 300), mock: false });
    } catch {
      reports.push({ name: t.name, url: t.url, changed: false, snippet: "（抓取失败——网络或反爬）", mock: true });
    }
  }
  return { reports };
}

/* ---------------- prd-forge：PRD 起草与导出（真实 LLM） ---------------- */
export async function prdForge(workspaceId: string, requirement: { title: string; context?: string }): Promise<{ markdown: string; mock: boolean }> {
  const llm = llmCall("aipm-prd-forge");
  let markdown: string;
  let mock = false;
  if (llm) {
    try {
      markdown = await llm(
        `你是文档主笔官。为以下需求起草一份 PRD 初稿（Markdown，含五章：背景与问题/目标（可量化）/方案（含取舍）/边界（明确不做什么）/验收标准（可测））。需求标题：「${requirement.title}」。${requirement.context ? `背景补充：${requirement.context}` : ""}直接输出 Markdown 正文。`);
    } catch (e) {
      mock = true;
      markdown = fallbackPrd(requirement.title, (e as Error).message);
    }
  } else {
    mock = true;
    markdown = fallbackPrd(requirement.title, "模型未配置");
  }
  return { markdown, mock };
}

function fallbackPrd(title: string, note: string): string {
  return `# PRD：${title}\n\n> 本初稿由确定性骨架生成（${note}），接入真实模型后自动升级为完整初稿。\n\n## 一、背景与问题\n（待补充：用户痛点与现状数据）\n\n## 二、目标\n- 北极星指标：（待量化）\n- 里程碑：（待排期）\n\n## 三、方案\n（待补充：方案描述与关键取舍）\n\n## 四、边界（不做什么）\n- （待明确）\n\n## 五、验收标准\n- [ ] （可测量的验收项）\n`;
}
