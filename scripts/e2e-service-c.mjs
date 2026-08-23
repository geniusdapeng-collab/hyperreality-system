#!/usr/bin/env node
/**
 * e2e-service-c.mjs · AI 服务前台 HTTP 集成冒烟（node 直连，不经 vitest）
 *
 * 用法：node scripts/e2e-service-c.mjs
 * 行为：自拉 8795 服务（SERVER_PORT=8795 tsx --env-file=.env apps/server/src/index.ts），
 *       跑 C 端旅程（session→KB 问答→建单→通知→B 端推进/办结→评价）+ B 端 tRPC 抽查，
 *       全部断言通过后退出码 0，任一失败退出码 1；结束自动 kill 服务。
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const PORT = 8795;
const BASE = `http://localhost:${PORT}`;
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const RUN = `mjs-${Date.now().toString(36)}`;

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failed += 1; console.error(`  ✗ ${name}`); }
}

async function c(path, { method = "GET", body, token, ip = "203.0.113.200" } = {}) {
  const res = await fetch(`${BASE}/c${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": ip,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

async function trpc(proc, { input, token, method = "query" } = {}) {
  const headers = { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  const res = method === "query"
    ? await fetch(`${BASE}/trpc/${proc}${input !== undefined ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ""}`, { headers })
    : await fetch(`${BASE}/trpc/${proc}`, { method: "POST", headers, body: JSON.stringify(input ?? {}) });
  const j = await res.json();
  return { status: res.status, data: j.result?.data ?? null, error: j.error ?? null };
}

async function waitHealth(deadlineMs = 60_000) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch { /* retry */ }
    if (Date.now() > deadline) throw new Error("服务拉起超时");
    await new Promise((r) => setTimeout(r, 500));
  }
}

const server = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "--env-file=.env", "apps/server/src/index.ts"], {
  cwd: ROOT,
  env: { ...process.env, SERVER_PORT: String(PORT), SERVICE_C_DEMO_AUTH: "true" },
  stdio: "ignore",
  detached: true, // 独立进程组：finally 按组杀（tsx 会再派生 node 子进程）
});

try {
  await waitHealth();
  console.log("C 端旅程：");
  // 会话
  const s = await c("/session", { method: "POST", body: { channel: "h5", openid: `${RUN}-u`, nickname: "冒烟" } });
  check("session 签发 token", s.status === 200 && typeof s.json.token === "string");
  const token = s.json.token;
  // KB 问答
  const q1 = await c("/chat", { method: "POST", body: { text: "退房时间是几点？" }, token });
  check("KB 问答命中带引用", q1.json.intent === "kb_qa" && q1.json.citations.length > 0);
  // 未绑定引导
  const q2 = await c("/chat", { method: "POST", body: { text: "查一下我的订单" }, token });
  check("未绑定查订单给绑定引导", String(q2.json.answer).includes("绑定会员") && q2.json.cards.length === 0);
  // 建单 → 确认
  const q3 = await c("/chat", { method: "POST", body: { text: "帮我送两瓶矿泉水" }, token });
  check("送物产 delivery 草稿", q3.json.ticketDraft?.kind === "delivery" && q3.json.ticket === null);
  const q4 = await c("/chat", { method: "POST", body: { text: "帮我送两瓶矿泉水", confirmTicket: true, idempotencyKey: `${RUN}-t` }, token });
  check("确认建单 assigned/客房部", q4.json.ticket?.status === "assigned" && q4.json.ticket?.dept === "客房部");
  const ticketId = q4.json.ticket.id;
  const q5 = await c("/chat", { method: "POST", body: { text: "帮我送两瓶矿泉水", confirmTicket: true, idempotencyKey: `${RUN}-t` }, token });
  check("幂等重放同单", q5.json.deduped === true && q5.json.ticket.id === ticketId);
  // 受理通知
  const n1 = await c("/notifications", { token });
  check("受理通知可达", n1.json.notifications.some((x) => x.kind === "ticket.accepted" && x.payload?.ticketId === ticketId));
  // B 端处理
  const login = await trpc("auth.loginAs", { input: { workspaceSlug: "yunqi-hotel", memberNo: "MEM-001" }, method: "mutation" });
  const bToken = login.data?.token;
  check("B 端 loginAs 签发", typeof bToken === "string");
  const adv = await trpc("service.tickets.advance", { input: { ticketId, action: "start" }, token: bToken, method: "mutation" });
  check("B 端推进 processing", adv.data?.ticket?.status === "processing");
  const done = await trpc("service.tickets.complete", { input: { ticketId, result: "已送达" }, token: bToken, method: "mutation" });
  check("B 端办结 done", done.data?.ticket?.status === "done");
  const n2 = await c("/notifications", { token });
  check("完成通知可达", n2.json.notifications.some((x) => x.kind === "ticket.completed" && x.payload?.ticketId === ticketId));
  // 评价
  const rate = await c(`/tickets/${ticketId}/rate`, { method: "POST", body: { score: 5, comment: "快" }, token });
  check("五星评价成功", rate.status === 200 && rate.json.ticket?.ratingScore === 5);
  const rate2 = await c(`/tickets/${ticketId}/rate`, { method: "POST", body: { score: 4 }, token });
  check("重复评价 409", rate2.status === 409);
  // B 端指标
  const stats = await trpc("service.stats.overview", { token: bToken });
  check("stats.overview 指标齐全", stats.data && ["sessions", "qaCount", "groundedRate", "completionRate"].every((k) => k in stats.data));
  // 安全抽查
  const noAuth = await c("/tickets");
  check("无 token 401", noAuth.status === 401);
  const badKind = await c("/tickets", { method: "POST", body: { kind: "hack", title: "x", payload: {} }, token });
  check("非法 kind 400", badKind.status === 400);
} finally {
  try { process.kill(-server.pid, "SIGKILL"); } catch { server.kill("SIGKILL"); }
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
