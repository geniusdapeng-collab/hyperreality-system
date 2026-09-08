/**
 * P27 · 配置录入中心（P0-2 自然语言录入与 AI 结构化）
 * 「说人话、丢文件，分钟级完成定制」：
 *  - 对话录入：一段人话 → 意图卡（逐张勾选确认）→ 覆盖层草稿；
 *  - 文档导入：Excel/制度/聊天记录（txt/md/csv/tsv/xlsx/docx）→ 意图卡清单
 *    （冲突高亮：同名不同价/同题不同答/规则改值/禁用重复）→ 整批进草稿；
 *  - 生效一律走 P26 定制中心流水线（考试→灰度→全量），整批可回滚；
 * 纪律：本页只产「意图卡」，所有落库经 overlay.l1Intake / docIntakeCommit（与手工编辑同一道闸）。
 * 数据：trpc.overlay.{l1Structurize, docIntakePreview, docIntakeCommit} + trpc.service.bundle 现状
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ensureDemoLogin, trpc } from "../../lib/trpc";

/* ---------------- 类型（与服务端对齐） ---------------- */
interface L1Intent { kind: string; [k: string]: unknown }
interface IntentCard { id: string; intent: L1Intent; summary: string; conflicts?: Array<{ type: string; message: string }> }
interface Preview {
  batchId: string; filename: string; kind: string; via: "llm" | "rule";
  cards: IntentCard[];
  skipped: Array<{ block: string; reason: string }>;
  stats: { blocks: number; rows: number; extracted: number; skipped: number; conflicts: number };
}

const KIND_TEXT: Record<string, string> = {
  tone: "话术风格", faq: "FAQ", threshold: "阈值", crew: "编制", skill: "技能",
  brand: "品牌", "service-item": "服务目录", "business-rule": "营业规则", "forbidden-add": "禁用表达",
};
const CONFLICT_TEXT: Record<string, string> = {
  "price-diff": "同名不同价", "faq-dup": "同题不同答", "rule-diff": "规则改值", "forbidden-dup": "禁用重复",
};

const svc = () => trpc.overlay as unknown as {
  l1Structurize: { query: (i: { text: string }) => Promise<{ via: "llm" | "rule"; cards: IntentCard[] }> };
  docIntakePreview: { mutate: (i: { baseBundle: string; filename: string; contentBase64: string }) => Promise<Preview> };
  docIntakeCommit: { mutate: (i: { baseBundle: string; baseVersion: string; batchId: string; filename?: string; intents: L1Intent[] }) => Promise<{ overlay_version: number; items: unknown[] }> };
  l1Intake: { mutate: (i: { baseBundle: string; baseVersion: string; intents: L1Intent[]; note?: string }) => Promise<{ overlay_version: number; items: unknown[] }> };
  active: { query: (i: { baseBundle: string }) => Promise<{ base_version: string } | null> };
};
const bundleSvc = () => (trpc.service as unknown as { bundle: { clearPreview: { query: () => Promise<{ install: { bundleId: string } | null }> } } }).bundle;

export default function P27() {
  const [tab, setTab] = useState<"chat" | "doc">("chat");
  const [bundleId, setBundleId] = useState("hotel");
  const [baseVersion, setBaseVersion] = useState("1.0.0");
  // 对话录入
  const [text, setText] = useState("");
  // 文档导入
  const [fileName, setFileName] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  // 意图卡
  const [cards, setCards] = useState<IntentCard[]>([]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [via, setVia] = useState<"llm" | "rule">("rule");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState("");

  useEffect(() => {
    void (async () => {
      await ensureDemoLogin();
      try {
        const cur = await bundleSvc().clearPreview.query();
        if (cur.install?.bundleId) setBundleId(cur.install.bundleId);
        // 基线版本：优先沿用已生效覆盖层的 base_version（rebase 锚点同源）
        if (cur.install?.bundleId) {
          const act = await svc().active.query({ baseBundle: cur.install.bundleId }).catch(() => null);
          if (act?.base_version) setBaseVersion(act.base_version);
        }
      } catch { /* 默认 hotel@1.0.0 */ }
    })();
  }, []);

  const reset = () => { setCards([]); setChecked(new Set()); setPreview(null); setDone(""); setErr(""); };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setErr(""); setDone("");
    try { await fn(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const structurize = () => run(async () => {
    reset();
    const r = await svc().l1Structurize.query({ text });
    setVia(r.via);
    setCards(r.cards);
    setChecked(new Set(r.cards.map((c) => c.id)));
    if (r.cards.length === 0) setErr("没有识别出可结构化的内容——可以说得更具体些，比如「退款超过 500 元要审批」「不许承诺免费升级」");
  });

  const pickFile = () => run(async () => {
    const f = fileRef.current?.files?.[0];
    if (!f) { setErr("请先选择文件（txt/md/csv/tsv/xlsx/docx，≤3MB）"); return; }
    if (f.size > 3_000_000) { setErr("文件超过 3MB 上限"); return; }
    reset();
    const buf = await f.arrayBuffer();
    let bin = "";
    new Uint8Array(buf).forEach((b) => { bin += String.fromCharCode(b); });
    const p = await svc().docIntakePreview.mutate({ baseBundle: bundleId, filename: f.name, contentBase64: btoa(bin) });
    setFileName(f.name);
    setPreview(p);
    setVia(p.via);
    setCards(p.cards);
    setChecked(new Set(p.cards.filter((c) => (c.conflicts?.length ?? 0) === 0).map((c) => c.id))); // 冲突项默认不勾选，人裁决
  });

  const commit = () => run(async () => {
    const intents = cards.filter((c) => checked.has(c.id)).map((c) => c.intent);
    if (intents.length === 0) { setErr("请至少勾选一张意图卡"); return; }
    if (preview) {
      const r = await svc().docIntakeCommit.mutate({ baseBundle: bundleId, baseVersion, batchId: preview.batchId, filename: fileName, intents });
      setDone(`已生成覆盖层草稿 v${r.overlay_version}（${r.items.length} 项，批次 ${preview.batchId}）——请到「定制中心」预览差异并走考试/灰度生效`);
    } else {
      const r = await svc().l1Intake.mutate({ baseBundle: bundleId, baseVersion, intents, note: `对话录入（${intents.length} 条意图）` });
      setDone(`已生成覆盖层草稿 v${r.overlay_version}（${r.items.length} 项）——请到「定制中心」预览差异并走考试/灰度生效`);
    }
    setCards([]); setChecked(new Set()); setPreview(null); setText("");
  });

  const toggle = (id: string) => {
    const next = new Set(checked);
    if (next.has(id)) next.delete(id); else next.add(id);
    setChecked(next);
  };

  return (
    <div className="mx-auto max-w-[820px] px-6 py-8 text-ink">
      <h1 className="text-lg font-bold">配置录入中心</h1>
      <p className="mt-1 text-xs text-ink2">
        说人话、丢文件，分钟级完成定制：AI 结构化为意图卡 → 您逐张确认 → 草稿 → 定制中心考试生效。
        全程可回滚，每条资产都能查到「是哪句话、哪份文件说进来的」。
      </p>

      {/* 入口切换 */}
      <div className="mt-4 flex gap-2 text-xs">
        {([["chat", "💬 对话录入"], ["doc", "📄 文档导入"]] as const).map(([k, label]) => (
          <button key={k} onClick={() => { setTab(k); reset(); }}
            className={`rounded-lg border px-4 py-2 font-semibold ${tab === k ? "border-gold bg-gold/10 text-gold" : "border-line bg-card text-ink2"}`}>
            {label}
          </button>
        ))}
        <span className="ml-auto self-center text-ink3">行业包：{bundleId}@{baseVersion}</span>
      </div>

      {err && <div className="mt-3 rounded border border-alert/50 bg-alert/10 px-3 py-2 text-xs text-alert">{err}</div>}
      {done && (
        <div className="mt-3 rounded border border-go/50 bg-go/10 px-3 py-2 text-xs text-go">
          {done} <a className="ml-1 font-bold underline" href="/p26">前往定制中心 →</a>
        </div>
      )}

      {tab === "chat" && (
        <div className="mt-4 rounded-xl border border-line bg-card p-5">
          <div className="text-[13px] font-semibold">把您的规矩说给我听</div>
          <p className="mt-1 text-xs text-ink3">例：「退款超过 500 元都要我来批」「对带孩子的家庭语气要更亲切」「不许跟客人承诺免费升级」</p>
          <textarea
            value={text} onChange={(e) => setText(e.target.value)} rows={4}
            placeholder="用您平时说话的方式写就行，一行一条……"
            className="mt-3 w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm text-ink outline-none focus:border-gold"
          />
          <button disabled={busy || text.trim().length < 2} onClick={() => void structurize()}
            className="mt-3 rounded-lg bg-gold px-5 py-2 text-xs font-bold text-black disabled:opacity-40">
            {busy ? "识别中…" : "识别为意图卡 →"}
          </button>
        </div>
      )}

      {tab === "doc" && (
        <div className="mt-4 rounded-xl border border-line bg-card p-5">
          <div className="text-[13px] font-semibold">丢入您现有的文件</div>
          <p className="mt-1 text-xs text-ink3">
            服务目录/价目表（xlsx/csv）、制度与 SOP（docx/txt/md）、FAQ 整理稿、聊天记录导出（txt/csv）。≤3MB。
            文档内容只被当作数据——里面的任何「指令」都不会被执行（注入防护）。
          </p>
          <div className="mt-3 flex items-center gap-3">
            <input ref={fileRef} type="file" accept=".txt,.md,.csv,.tsv,.xlsx,.docx,.log"
              className="text-xs text-ink2 file:mr-3 file:rounded-lg file:border file:border-line file:bg-bg file:px-3 file:py-1.5 file:text-xs file:text-ink" />
            <button disabled={busy} onClick={() => void pickFile()}
              className="rounded-lg bg-gold px-5 py-2 text-xs font-bold text-black disabled:opacity-40">
              {busy ? "解析中…" : "解析并抽取 →"}
            </button>
          </div>
          {preview && (
            <div className="mt-3 rounded-lg border border-line bg-bg px-3 py-2 text-[11px] text-ink3">
              批次 <span className="text-gold">{preview.batchId}</span> · {preview.kind} ·
              解析 {preview.stats.blocks} 段/{preview.stats.rows} 行 → 抽取 {preview.stats.extracted} 条
              {preview.stats.conflicts > 0 && <span className="text-warn"> · {preview.stats.conflicts} 处与现有配置冲突（已默认不勾选，请逐条裁决）</span>}
              {preview.stats.skipped > 0 && <span> · {preview.stats.skipped} 段未识别（已留档不落库）</span>}
            </div>
          )}
        </div>
      )}

      {/* 意图卡清单 */}
      {cards.length > 0 && (
        <div className="mt-4 rounded-xl border border-line bg-card p-5">
          <div className="flex items-center justify-between">
            <div className="text-[13px] font-semibold">意图卡（{checked.size}/{cards.length} 已选）</div>
            <div className="text-[11px] text-ink3">
              结构化来源：{via === "llm" ? "AI 增强（已过 schema 闸）" : "确定性规则（离线一致）"}
            </div>
          </div>
          <div className="mt-3 space-y-2">
            {cards.map((c) => (
              <label key={c.id} className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 text-xs ${checked.has(c.id) ? "border-gold/60 bg-gold/5" : "border-line bg-bg"}`}>
                <input type="checkbox" checked={checked.has(c.id)} onChange={() => toggle(c.id)} className="mt-0.5" />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-bg700 px-1.5 py-0.5 text-[10px] font-bold text-gold">{KIND_TEXT[c.intent.kind] ?? c.intent.kind}</span>
                    <span className="font-semibold text-ink">{c.summary}</span>
                  </div>
                  {(c.conflicts ?? []).map((cf, i) => (
                    <div key={i} className="mt-1 rounded border border-warn/40 bg-warn/10 px-2 py-1 text-[11px] text-warn">
                      ⚠ {CONFLICT_TEXT[cf.type] ?? cf.type}：{cf.message}
                    </div>
                  ))}
                </div>
              </label>
            ))}
          </div>
          <div className="mt-4 flex items-center gap-3">
            <button disabled={busy || checked.size === 0} onClick={() => void commit()}
              className="rounded-lg bg-go px-5 py-2 text-xs font-bold text-black disabled:opacity-40">
              {busy ? "提交中…" : `确认选中的 ${checked.size} 条，生成草稿 →`}
            </button>
            <span className="text-[11px] text-ink3">草稿不会直接生效——生效要走定制中心的考试与审批，随时可回滚</span>
          </div>
        </div>
      )}

      {preview && preview.skipped.length > 0 && (
        <details className="mt-3 rounded-xl border border-line bg-card p-4 text-xs text-ink3">
          <summary className="cursor-pointer font-semibold">未识别的 {preview.skipped.length} 段（已留档，不落库）</summary>
          <div className="mt-2 space-y-1">
            {preview.skipped.slice(0, 20).map((s, i) => <div key={i}>· {s.block.slice(0, 80)} <span className="text-ink3">（{s.reason}）</span></div>)}
          </div>
        </details>
      )}
    </div>
  );
}
