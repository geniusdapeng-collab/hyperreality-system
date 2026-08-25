/**
 * AI 服务前台 · 模型链路四维评测（准确率/召回率/耗时/回答质量）
 * 用法：node scripts/eval/service-c-eval.mjs [--port 8796] [--runs 1]
 * 产出：scripts/eval/report/result.json + report.md + samples.md（质量评审样本）
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../..");
const PORT = Number(process.argv.find((a) => a.startsWith("--port"))?.split("=")[1] ?? 8796);
const BASE = `http://127.0.0.1:${PORT}`;

// ---------- 启动真实服务 ----------
function startServer() {
  const child = spawn("./node_modules/.bin/tsx", ["--env-file=.env", "apps/server/src/index.ts"], {
    cwd: ROOT, env: { ...process.env, SERVER_PORT: String(PORT) }, detached: true, stdio: "ignore",
  });
  child.unref();
  return child;
}
async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/health`); if (r.ok) return; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("server 启动超时");
}

async function main() {
  const golden = JSON.parse(readFileSync(join(HERE, "golden-set.json"), "utf-8"));
  const server = startServer();
  const stop = () => { try { process.kill(-server.pid, "SIGKILL"); } catch { /* */ } };
  process.on("exit", stop);
  await waitUp();

  // 评测前重置 KB 到种子基线（防 e2e/手工调试残留文档污染评测口径）
  {
    const pg = (await import("pg")).default;
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres://postgres:workloom@localhost:5432/workloom_im" });
    await pool.query(`DELETE FROM kb_chunks WHERE document_id IN (SELECT id FROM kb_documents WHERE id NOT IN ('kbd-ws-yunqi-notice','kbd-service-catalog','kbd-delivery-catalog','kbd-repair-catalog') AND id NOT LIKE 'kbd-faq-%')`);
    await pool.query(`DELETE FROM kb_documents WHERE id NOT IN ('kbd-ws-yunqi-notice','kbd-service-catalog','kbd-delivery-catalog','kbd-repair-catalog') AND id NOT LIKE 'kbd-faq-%'`);
    await pool.end();
  }

  // C 端会话
  const sess = await (await fetch(`${BASE}/c/session`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel: "h5", openid: `eval-${Date.now()}`, nickname: "评测员" }),
  })).json();
  const token = sess.token;

  const results = [];
  for (const c of golden.cases) {
    const t0 = performance.now();
    const r = await (await fetch(`${BASE}/c/chat`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ text: c.q }),
    })).json();
    const wallMs = Math.round(performance.now() - t0);

    const answered = (r.citations?.length ?? 0) > 0 && !String(r.answer).includes("转专人") && !String(r.answer).includes("不敢随意作答") && r.intent === "kb_qa";
    const refused = !answered && (r.ticketDraft != null || String(r.answer).includes("转") || String(r.answer).includes("不敢"));
    const factsHit = (c.facts ?? []).filter((f) => String(r.answer).replace(/\s/g, "").includes(f.replace(/\s/g, "")));
    // citationOk：引用须命中金标指定文档或其备选（FAQ 预置库多文档命中时按 docAlt 兼容）
    const citationOk = (r.citations ?? []).some((ci) => ci.documentTitle === c.doc || (c.docAlt ?? []).includes(ci.documentTitle));
    const isTicket = r.intent === "service_request" && r.ticketDraft != null;
    const pass = c.expect === "answer"
      ? answered && citationOk && factsHit.length === (c.facts ?? []).length
      : c.expect === "ticket"
        ? isTicket
        : refused;

    results.push({
      id: c.id, q: c.q, expect: c.expect, pass,
      answered, refused, citationOk,
      factsHit: factsHit.length, factsTotal: (c.facts ?? []).length,
      confidence: r.confidence, latencyMs: r.latencyMs, wallMs,
      answer: r.answer, citations: (r.citations ?? []).map((ci) => `${ci.documentTitle}·${ci.heading}`),
      intent: r.intent,
    });
    process.stdout.write(`${pass ? "✓" : "✗"} ${c.id} ${c.q} (${wallMs}ms)\n`);
  }

  // ---------- 指标聚合 ----------
  const ans = results.filter((r) => r.expect === "answer");
  const ref = results.filter((r) => r.expect === "refuse");
  const lat = results.map((r) => r.wallMs).sort((a, b) => a - b);
  const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
  const metrics = {
    总用例: results.length,
    通过率: `${((results.filter((r) => r.pass).length / results.length) * 100).toFixed(1)}%`,
    准确率_可答题全对率: `${((ans.filter((r) => r.pass).length / ans.length) * 100).toFixed(1)}% (${ans.filter((r) => r.pass).length}/${ans.length})`,
    召回率_可答题未拒答率: `${((ans.filter((r) => r.answered).length / ans.length) * 100).toFixed(1)}% (${ans.filter((r) => r.answered).length}/${ans.length})`,
    引用正确率: `${((ans.filter((r) => r.citationOk).length / Math.max(1, ans.filter((r) => r.answered).length)) * 100).toFixed(1)}%`,
    拒答正确率_不可答: `${((ref.filter((r) => r.refused).length / ref.length) * 100).toFixed(1)}% (${ref.filter((r) => r.refused).length}/${ref.length})`,
    耗时_p50: `${pct(lat, 0.5)}ms`, 耗时_p95: `${pct(lat, 0.95)}ms`,
    耗时_均值: `${Math.round(lat.reduce((a, b) => a + b, 0) / lat.length)}ms`,
    引擎内部耗时_p95: `${pct(results.map((r) => r.latencyMs ?? 0).sort((a, b) => a - b), 0.95)}ms`,
  };

  mkdirSync(join(HERE, "report"), { recursive: true });
  writeFileSync(join(HERE, "report", "result.json"), JSON.stringify({ metrics, results }, null, 2));
  const fails = results.filter((r) => !r.pass);
  writeFileSync(join(HERE, "report", "samples.md"),
    results.map((r) => `## ${r.id} ${r.q}\n- 预期：${r.expect}｜结果：${r.pass ? "PASS" : "FAIL"}｜置信度 ${r.confidence}｜${r.wallMs}ms\n- 引用：${r.citations.join("、") || "（无）"}\n- 回答：${r.answer}\n`).join("\n"));
  writeFileSync(join(HERE, "report", "report.md"),
    `# AI 服务前台 · 模型链路评测报告\n\n时间：${new Date().toISOString()}\n\n## 四维指标\n\n| 维度 | 指标 | 结果 |\n|---|---|---|\n` +
    Object.entries(metrics).map(([k, v]) => `| ${k.replace(/_/g, "·")} | | ${v} |`).join("\n") +
    `\n\n## 失败用例\n\n${fails.length === 0 ? "无" : fails.map((f) => `- ${f.id} ${f.q}（预期 ${f.expect}，实际 answered=${f.answered} citations=${f.citations.join("/") || "无"} facts=${f.factsHit}/${f.factsTotal}）`).join("\n")}\n`);

  console.log("\n======== 四维指标 ========");
  for (const [k, v] of Object.entries(metrics)) console.log(`${k}: ${v}`);
  stop();
  process.exit(fails.length === 0 ? 0 : 2);
}

main().catch((e) => { console.error(e); process.exit(1); });
