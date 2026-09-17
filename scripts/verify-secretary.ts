/**
 * scripts/verify-secretary.ts · 织伴（LoomMate）端到端验证
 * 链路：设置保存 → 造事件（开发任务待裁决）→ 扫描落收件箱（幂等）
 *   → 对话五类（记事/定提醒/查状态/找CEO/兜底）→ 记忆面板与删除 → 勿扰判定
 * 用法：pnpm tsx --env-file=.env scripts/verify-secretary.ts
 */
import {
  getSettings, saveSettings, scan, inbox, chat, memoryPanel, forget, inQuietHours,
} from "../apps/server/src/service/secretary.js";
import { registerRepo, createTask, confirmTask, setDevToolAdapters } from "../apps/server/src/service/devtools.js";
import { svcQuery } from "../apps/server/src/service/events.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WS = process.env.VERIFY_WS ?? "ws-aipm-demo";
const MEMBER = "verify-chairman";
const ACTOR = { id: MEMBER, type: "human" as const };

async function main() {
  console.log("== ① 设置保存（甜妹默认 → 自定义人设+柔音色+小尺寸）");
  await saveSettings(WS, MEMBER, {
    display_name: "老板", persona_key: "custom",
    persona_custom: { name: "糖糖", tone: "甜妹，爱撒娇" }, voice_key: "soft", widget_size: "small",
  }, ACTOR);
  const s1 = (await getSettings(WS, MEMBER)).settings;
  if (s1.persona_custom?.name !== "糖糖" || s1.widget_size !== "small") throw new Error("设置未生效");
  await saveSettings(WS, MEMBER, { persona_key: "tianmei", widget_size: "large", voice_key: "sweet" }, ACTOR);
  console.log("   ✓ 自定义人设/音色/尺寸保存与回切正常");

  console.log("== ② 造事件：开发任务一路跑到待裁决（直接置状态——扫描只认状态）");
  const dir = mkdtempSync(join(tmpdir(), "sec-e2e-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "s@s"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "s"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# sec\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
  const { repo } = await registerRepo(WS, { name: "sec-demo", path: dir, baselineBranch: "main" }, ACTOR);
  const { task } = await createTask(WS, {
    repoId: (repo as { id: string }).id, title: "织伴验证任务", prdSummary: "验证事件引擎",
    acceptance: ["有文件产出"],
  }, ACTOR);
  const taskId = (task as { id: string }).id;
  await confirmTask(WS, taskId, ACTOR);
  await svcQuery(WS, `UPDATE dev_tasks SET status='pending_approval' WHERE id=$1`, [taskId]);
  console.log("   ✓ 任务已置待裁决:", taskId);

  console.log("== ③ 扫描：落收件箱 + 幂等（再扫不重复）");
  const a1 = await scan(WS, MEMBER);
  const a2 = await scan(WS, MEMBER);
  if (a1.added < 1) throw new Error("扫描未捕获待裁决事件");
  if (a2.added !== 0) throw new Error(`幂等失败：二次扫描新增 ${a2.added}`);
  const box = await inbox(WS, MEMBER, true);
  const devItem = (box.items as Array<{ source_key: string; kind: string; level: string; title: string }>)
    .find((x) => x.source_key === `dev-pend-${taskId}`);
  if (!devItem) throw new Error("收件箱缺待裁决条目");
  if (devItem.level !== "high" || devItem.kind !== "judge") throw new Error("级别/类别不对");
  console.log(`   ✓ 扫描新增 ${a1.added} 条，二次扫描 0（幂等），级别/类别正确`);

  console.log("== ④ 对话五类");
  const r1 = await chat(WS, MEMBER, "记住：我们 Q4 要上线新系统", ACTOR);
  if (r1.action !== "remembered") throw new Error("记事路由失败");
  console.log("   ✓ 记事:", r1.reply.slice(0, 40));
  const r2 = await chat(WS, MEMBER, "明早八点提醒我过审批", ACTOR);
  if (r2.action !== "reminded") throw new Error("提醒路由失败:" + r2.reply);
  console.log("   ✓ 定提醒:", r2.reply.slice(0, 40));
  const r3 = await chat(WS, MEMBER, "开发任务现在怎么样了", ACTOR);
  if (r3.action !== "status" || !r3.reply.includes("织伴验证任务")) throw new Error("状态路由失败");
  console.log("   ✓ 查状态:", r3.reply.slice(0, 50));
  const r4 = await chat(WS, MEMBER, "叫 CEO 来一下", ACTOR);
  if (r4.action !== "goto") throw new Error("找CEO路由失败");
  console.log("   ✓ 找CEO:", r4.reply.slice(0, 40));
  const r5 = await chat(WS, MEMBER, "今天天气怎么样", ACTOR);
  if (!r5.reply) throw new Error("兜底失败");
  console.log("   ✓ 兜底:", r5.reply.slice(0, 40));

  console.log("== ⑤ 定时提醒到点触发");
  await svcQuery(WS, `UPDATE secretary_reminders SET due_at=now() - interval '1 minute' WHERE member_no=$1`, [MEMBER]);
  const a3 = await scan(WS, MEMBER);
  if (a3.added < 1) throw new Error("提醒未触发");
  const box2 = await inbox(WS, MEMBER, true);
  if (!(box2.items as Array<{ title: string }>).some((x) => x.title.includes("提醒"))) throw new Error("收件箱缺提醒条目");
  console.log("   ✓ 到点提醒已落入收件箱");

  console.log("== ⑥ 记忆面板与删除");
  const panel = await memoryPanel(WS, MEMBER);
  const facts = (panel.memory.facts ?? []) as Array<{ id: string; content: string; source: string }>;
  const fact = facts.find((f) => f.content.includes("Q4"));
  if (!fact) throw new Error("事实层缺 Q4 记忆");
  if (fact.source !== "said") throw new Error("来源标注不对");
  await forget(WS, MEMBER, fact.id, ACTOR);
  const panel2 = await memoryPanel(WS, MEMBER);
  if (((panel2.memory.facts ?? []) as Array<{ id: string }>).some((f) => f.id === fact.id)) throw new Error("删除未生效");
  console.log("   ✓ 事实层写入（来源=您亲口说的）+ 面板可见 + 删除生效");

  console.log("== ⑦ 勿扰判定");
  const quietCfg = { quiet_start: "22:00", quiet_end: "08:00" };
  const night = inQuietHours(quietCfg, new Date("2026-01-01T23:30:00"));
  const noon = inQuietHours(quietCfg, new Date("2026-01-01T12:00:00"));
  if (!night || noon) throw new Error("勿扰判定错误");
  console.log("   ✓ 跨午夜勿扰区间判定正确（23:30 勿扰 / 12:00 不勿扰）");

  console.log("\n🎀 织伴端到端验证全部通过");
  process.exit(0);
}

main().catch((e) => { console.error("验证失败：", e); process.exit(1); });
