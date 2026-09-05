/**
 * service/secretary · 织伴（LoomMate）执行面
 * 权责铁律：不替人决策（只传达/提醒/记事）、不打扰为第一体验纪律、不装在线。
 * 事件引擎：scan() 幂等扫描六大事件源（审批/裁决/转人工/发布/考试/晨报/定时提醒），
 *   source_key 去重落收件箱；红线/高级别触发 outbox webhook（眼镜/IM 桥协议）。
 * 对话：规则路由先行（查状态/派任务/找人/定提醒/记事/转 CEO），LLM 兜底带人设与记忆上下文；
 *   记忆写入纪律：明示"记住"才写事实层（带来源标注），透明可查可删。
 */
import { randomUUID } from "node:crypto";
import { svcQuery, serviceTx, appendEventOn } from "./events.js";
import { llmCall } from "./llm.js";

const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
type Actor = { id: string; type: "human" | "agent" };

/* ================= 人设与音色 ================= */

export interface Persona {
  key: string; name: string; tone: string;
  wrap: (text: string, displayName: string) => string;
}
export const PERSONAS: Record<string, Persona> = {
  tianmei: {
    key: "tianmei", name: "小织",
    tone: "甜妹，软糯可爱，带一点点撒娇（语气词：呀/呢/哦/啦），关心人，但不腻歪",
    wrap: (t, dn) => t,
  },
  yuanqi: {
    key: "yuanqi", name: "小元气",
    tone: "元气满满，干脆利落，积极向上，感叹号偏多但不吵",
    wrap: (t, dn) => t,
  },
  chenwen: {
    key: "chenwen", name: "织稳",
    tone: "沉稳专业，言简意赅，不用语气词",
    wrap: (t, dn) => t,
  },
};
export const VOICE_KEYS: Record<string, { pitch: number; rate: number; female?: boolean }> = {
  sweet: { pitch: 1.25, rate: 1.02, female: true },
  bright: { pitch: 1.15, rate: 1.1, female: true },
  soft: { pitch: 1.05, rate: 0.92, female: true },
  calm: { pitch: 0.9, rate: 0.95 },
};

export interface Settings {
  member_no: string; display_name: string; persona_key: string;
  persona_custom: { name?: string; tone?: string }; voice_key: string; voice_on: boolean;
  widget_size: "large" | "small"; quiet_start: string; quiet_end: string;
  channels: { im?: { provider: string; target: string }; outbox_urls?: string[] };
  [key: string]: unknown;
}

export async function getSettings(workspaceId: string, memberNo: string): Promise<{ settings: Settings }> {
  const rows = await svcQuery<Settings>(workspaceId,
    `SELECT * FROM secretary_settings WHERE member_no=$1`, [memberNo]);
  if (rows[0]) return { settings: rows[0] };
  // 缺省设置（不落库，首次保存才落）
  return {
    settings: {
      member_no: memberNo, display_name: "董事长", persona_key: "tianmei",
      persona_custom: {}, voice_key: "sweet", voice_on: true, widget_size: "large",
      quiet_start: "22:00", quiet_end: "08:00", channels: {},
    },
  };
}

export async function saveSettings(workspaceId: string, memberNo: string, patch: Partial<Settings>, actor: Actor) {
  const cur = (await getSettings(workspaceId, memberNo)).settings;
  const next = { ...cur, ...patch, member_no: memberNo };
  await serviceTx(workspaceId, async (client, sc) => {
    await client.query(
      `INSERT INTO secretary_settings (id, workspace_id, member_no, display_name, persona_key, persona_custom, voice_key, voice_on, widget_size, quiet_start, quiet_end, channels)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (workspace_id, member_no) DO UPDATE SET
         display_name=EXCLUDED.display_name, persona_key=EXCLUDED.persona_key, persona_custom=EXCLUDED.persona_custom,
         voice_key=EXCLUDED.voice_key, voice_on=EXCLUDED.voice_on, widget_size=EXCLUDED.widget_size,
         quiet_start=EXCLUDED.quiet_start, quiet_end=EXCLUDED.quiet_end, channels=EXCLUDED.channels, updated_at=now()`,
      [`ss-${memberNo}`, workspaceId, memberNo, next.display_name, next.persona_key,
       JSON.stringify(next.persona_custom ?? {}), next.voice_key, next.voice_on,
       next.widget_size, next.quiet_start, next.quiet_end, JSON.stringify(next.channels ?? {})]);
    await appendEventOn(client, sc, actor, {
      objectType: "secretary_settings", objectId: memberNo, action: "secretary.settings.save",
      after: { persona_key: next.persona_key, voice_key: next.voice_key, widget_size: next.widget_size },
    });
  });
  return { settings: next };
}

function personaOf(s: Settings): Persona {
  if (s.persona_key === "custom" && s.persona_custom?.name) {
    return { key: "custom", name: s.persona_custom.name, tone: s.persona_custom.tone ?? "温和亲切", wrap: (t) => t };
  }
  return PERSONAS[s.persona_key] ?? PERSONAS.tianmei!;
}

/* ================= 事件引擎（扫描→收件箱） ================= */

interface InboxDraft {
  sourceKey: string; kind: "judge" | "done" | "alert" | "daily";
  level: "red" | "high" | "mid" | "low"; title: string; body: string;
  actions?: Array<{ label: string; link: string }>; link?: string;
}

async function pushInbox(workspaceId: string, memberNo: string, d: InboxDraft): Promise<boolean> {
  const rows = await svcQuery(workspaceId,
    `INSERT INTO secretary_inbox (id, workspace_id, member_no, source_key, kind, level, title, body, actions, link)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (workspace_id, member_no, source_key) DO NOTHING
     RETURNING id`,
    [newId("si"), workspaceId, memberNo, d.sourceKey, d.kind, d.level, d.title, d.body,
     JSON.stringify(d.actions ?? []), d.link ?? null]);
  return rows.length > 0;
}

/** 勿扰判断（HH:mm 区间；跨午夜） */
export function inQuietHours(s: Pick<Settings, "quiet_start" | "quiet_end">, now = new Date()): boolean {
  const cur = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const { quiet_start: qs, quiet_end: qe } = s;
  if (qs === qe) return false;
  return qs < qe ? (cur >= qs && cur < qe) : (cur >= qs || cur < qe);
}

/** outbox（眼镜/IM 桥协议）：红线与高级别实时推送，失败静默不阻塞 */
async function emitOutbox(s: Settings, item: InboxDraft): Promise<void> {
  const urls = s.channels?.outbox_urls ?? [];
  const payload = JSON.stringify({
    protocol: "secretary.outbox/v1", level: item.level, kind: item.kind,
    title: item.title, body: item.body, actions: item.actions ?? [],
    speech: `${item.title}。${item.body}`.slice(0, 200), at: new Date().toISOString(),
  });
  for (const url of urls.slice(0, 3)) {
    void fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: payload, signal: AbortSignal.timeout(5000) })
      .catch(() => undefined);
  }
}

/** 扫描六大事件源（幂等，source_key 去重）。返回新增条数。 */
export async function scan(workspaceId: string, memberNo: string): Promise<{ added: number }> {
  const { settings } = await getSettings(workspaceId, memberNo);
  const quiet = inQuietHours(settings);
  let added = 0;
  const push = async (d: InboxDraft) => {
    // 防打扰纪律：勿扰时段非红线不推（晨报/低级别次日自然呈现）
    if (quiet && d.level !== "red") return;
    const ok = await pushInbox(workspaceId, memberNo, d);
    if (ok) {
      added += 1;
      if (d.level === "red" || d.level === "high") await emitOutbox(settings, d);
    }
  };

  // ① 审批台高风险卡（要你判断）
  const approvals = await svcQuery<{ approval_id: string; action: string; tier: string; title: string }>(workspaceId,
    `SELECT approval_id, payload->'decision'->>'action' AS action,
            payload->'decision'->'after'->>'tier' AS tier,
            COALESCE(payload->'decision'->'after'->>'title', payload->'decision'->>'action') AS title
     FROM biz_events WHERE payload->'decision'->>'action' LIKE 'approval.%'
       AND payload->'decision'->'after'->>'status'='pending'
     ORDER BY seq DESC LIMIT 20`).catch(() => [] as never[]);
  // 审批口径兼容：approvals 表为主
  const apprRows = await svcQuery<{ id: string; action: string; tier: string; created_at: string }>(workspaceId,
    `SELECT id, action, tier, created_at FROM approvals WHERE status='pending' ORDER BY created_at DESC LIMIT 10`).catch(() => [] as never[]);
  for (const a of apprRows) {
    await push({
      sourceKey: `appr-${a.id}`, kind: "judge", level: "high",
      title: "有张审批卡等您拍板", body: `${a.action}（${a.tier} 级）。要点我整理好了，您看一眼就能定。`,
      actions: [{ label: "去审批", link: "/p4" }], link: "/p4",
    });
  }
  void approvals;

  // ② 开发任务待裁决 / ③ 转人工（开发场域）
  const devPend = await svcQuery<{ id: string; title: string }>(workspaceId,
    `SELECT id, title FROM dev_tasks WHERE status='pending_approval' ORDER BY updated_at DESC LIMIT 5`).catch(() => [] as never[]);
  for (const t of devPend) {
    await push({
      sourceKey: `dev-pend-${t.id}`, kind: "judge", level: "high",
      title: "开发任务三道关全过，等您裁决", body: `「${t.title}」可以发布啦，您点头我就发。`,
      actions: [{ label: "去裁决", link: "/p25" }], link: "/p25",
    });
  }
  const devFail = await svcQuery<{ id: string; title: string; review_note: string | null }>(workspaceId,
    `SELECT id, title, review_note FROM dev_tasks WHERE status='failed' ORDER BY updated_at DESC LIMIT 5`).catch(() => [] as never[]);
  for (const t of devFail) {
    await push({
      sourceKey: `dev-fail-${t.id}`, kind: "alert", level: "high",
      title: "开发任务返修两轮没救回来，转您处理", body: `「${t.title}」：${(t.review_note ?? "原因待查").slice(0, 120)}`,
      actions: [{ label: "去看看", link: "/p25" }], link: "/p25",
    });
  }

  // ④ 发布成功（完成同步）
  const releases = await svcQuery<{ id: string; version: string; changelog: string }>(workspaceId,
    `SELECT id, version, changelog FROM releases ORDER BY released_at DESC LIMIT 3`).catch(() => [] as never[]);
  for (const r of releases) {
    await push({
      sourceKey: `rel-${r.id}`, kind: "done", level: "mid",
      title: `发布成功 ${r.version}`, body: (r.changelog.split("\n")[0] ?? "新版本已就位").slice(0, 120),
      actions: [{ label: "看版本", link: "/p25" }], link: "/p25",
    });
  }

  // ⑤ 考试结果（fail 红线）
  const exams = await svcQuery<{ id: string; verdict: string; total_score: string; exam_type: string }>(workspaceId,
    `SELECT id, verdict, total_score, exam_type FROM eval_exams WHERE status='done' ORDER BY finished_at DESC NULLS LAST LIMIT 3`).catch(() => [] as never[]);
  for (const e of exams) {
    if (e.verdict === "fail") {
      await push({
        sourceKey: `exam-fail-${e.id}`, kind: "alert", level: "red",
        title: "考试没及格（红线）", body: `${e.exam_type} 只拿了 ${Number(e.total_score).toFixed(0)} 分，得赶紧看看哪错了。`,
        actions: [{ label: "看考卷", link: "/p24" }], link: "/p24",
      });
    } else if (e.verdict) {
      await push({
        sourceKey: `exam-${e.id}`, kind: "done", level: "low",
        title: "考试过啦", body: `${e.exam_type} 得分 ${Number(e.total_score).toFixed(0)}，团队状态在线。`,
        link: "/p24",
      });
    }
  }

  // ⑥ 晨报（每日一条，低级别）
  const brief = await svcQuery<{ created_at: string; text: string }>(workspaceId,
    `SELECT created_at, payload->'decision'->'after'->>'text' AS text FROM biz_events
     WHERE payload->'decision'->>'action' IN ('ceo.briefing','ceo.board_pack')
     ORDER BY seq DESC LIMIT 1`).catch(() => [] as never[]);
  if (brief[0]?.text) {
    const day = new Date(brief[0].created_at).toDateString();
    await push({
      sourceKey: `brief-${day}`, kind: "daily", level: "low",
      title: "今早晨报出炉啦", body: brief[0].text.slice(0, 140), link: "/",
    });
  }

  // ⑦ 定时提醒到点触发
  const due = await svcQuery<{ id: string; text: string }>(workspaceId,
    `SELECT id, text FROM secretary_reminders WHERE member_no=$1 AND status='pending' AND due_at<=now()`, [memberNo]);
  for (const r of due) {
    await pushInbox(workspaceId, memberNo, {
      sourceKey: `remind-${r.id}`, kind: "judge", level: "high",
      title: "您让我提醒您的", body: r.text,
    });
    await svcQuery(workspaceId, `UPDATE secretary_reminders SET status='fired' WHERE id=$1`, [r.id]);
    added += 1;
  }

  return { added };
}

/* ================= 收件箱 / 提醒 ================= */

export async function inbox(workspaceId: string, memberNo: string, unreadOnly = false) {
  return {
    items: await svcQuery(workspaceId,
      `SELECT * FROM secretary_inbox WHERE member_no=$1 ${unreadOnly ? "AND status='unread'" : ""}
       ORDER BY created_at DESC LIMIT 50`, [memberNo]),
  };
}

export async function markInbox(workspaceId: string, memberNo: string, ids: string[], status: "read" | "acted") {
  await svcQuery(workspaceId,
    `UPDATE secretary_inbox SET status=$3 WHERE member_no=$1 AND id = ANY($2)`, [memberNo, ids, status]);
  return { ok: true };
}

export async function addReminder(workspaceId: string, memberNo: string, text: string, dueAt: string, actor: Actor) {
  const id = newId("sr");
  await serviceTx(workspaceId, async (client, sc) => {
    await client.query(
      `INSERT INTO secretary_reminders (id, workspace_id, member_no, text, due_at) VALUES ($1,$2,$3,$4,$5)`,
      [id, workspaceId, memberNo, text, dueAt]);
    await appendEventOn(client, sc, actor, {
      objectType: "secretary_reminder", objectId: id, action: "secretary.reminder.add",
      after: { text: text.slice(0, 80), dueAt },
    });
  });
  return { id, dueAt };
}

export async function listReminders(workspaceId: string, memberNo: string) {
  return { reminders: await svcQuery(workspaceId,
    `SELECT * FROM secretary_reminders WHERE member_no=$1 AND status='pending' ORDER BY due_at LIMIT 20`, [memberNo]) };
}

/* ================= 六层记忆 ================= */

export async function memoryPanel(workspaceId: string, memberNo: string) {
  const rows = await svcQuery(workspaceId,
    `SELECT id, layer, mkey, content, source, confidence, expires_at, created_at
     FROM personal_memory WHERE member_no=$1 AND (expires_at IS NULL OR expires_at > now())
     ORDER BY layer, updated_at DESC LIMIT 200`, [memberNo]);
  const grouped: Record<string, unknown[]> = { profile: [], facts: [], preferences: [], relations: [], episodic: [], working: [] };
  for (const r of rows) (grouped[(r as { layer: string }).layer] ??= []).push(r);
  return { memory: grouped };
}

/** 写记忆（事实层主入口：明示"记住"才写；upsert 同键更新） */
export async function remember(workspaceId: string, memberNo: string, input: {
  layer?: string; key: string; content: string; source?: string; expiresDays?: number;
}, actor: Actor) {
  const layer = ["profile", "facts", "preferences", "relations", "episodic", "working"].includes(input.layer ?? "") ? input.layer! : "facts";
  const id = newId("pm");
  const expires = input.expiresDays ? new Date(Date.now() + input.expiresDays * 86400_000).toISOString() : null;
  await serviceTx(workspaceId, async (client, sc) => {
    await client.query(
      `INSERT INTO personal_memory (id, workspace_id, member_no, layer, mkey, content, source, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (workspace_id, member_no, layer, mkey) DO UPDATE SET content=EXCLUDED.content, updated_at=now(), expires_at=EXCLUDED.expires_at`,
      [id, workspaceId, memberNo, layer, input.key.slice(0, 80), input.content, input.source ?? "said", expires]);
    await appendEventOn(client, sc, actor, {
      objectType: "personal_memory", objectId: `${layer}/${input.key.slice(0, 40)}`, action: "secretary.memory.remember",
      after: { layer, source: input.source ?? "said" },
    });
  });
  return { id, layer };
}

export async function forget(workspaceId: string, memberNo: string, memoryId: string, actor: Actor) {
  await serviceTx(workspaceId, async (client, sc) => {
    await client.query(`DELETE FROM personal_memory WHERE id=$1 AND member_no=$2`, [memoryId, memberNo]);
    await appendEventOn(client, sc, actor, {
      objectType: "personal_memory", objectId: memoryId, action: "secretary.memory.forget",
    });
  });
  return { ok: true };
}

/* ================= 对话（规则路由 + LLM 兜底） ================= */

const CN_NUM: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 };

/** 解析"明早八点/今晚9点/明天下午三点/14:30" → ISO 时间（解析不出返回 null） */
export function parseDueAt(text: string, now = new Date()): string | null {
  const m = /(今天|今晚|明早|明天|明晚|今早|上午|下午|晚上|今早)?\s*(\d{1,2}|[一二两三四五六七八九十]+)[点：:]\s*(\d{1,2}|半)?/.exec(text);
  if (!m) return null;
  const [, when, hRaw, minRaw] = m;
  let hour = CN_NUM[hRaw!] ?? Number(hRaw);
  if (Number.isNaN(hour)) return null;
  const minute = minRaw === "半" ? 30 : Number(minRaw ?? 0) || 0;
  if (/下午|晚上|今晚|明晚/.test(when ?? "") && hour < 12) hour += 12;
  const d = new Date(now);
  if (/明/.test(when ?? "")) d.setDate(d.getDate() + 1);
  d.setHours(hour, minute, 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);   // 已过点→明天
  return d.toISOString();
}

export async function chat(workspaceId: string, memberNo: string, text: string, actor: Actor): Promise<{ reply: string; action?: string; data?: unknown }> {
  const { settings } = await getSettings(workspaceId, memberNo);
  const persona = personaOf(settings);
  const dn = settings.display_name;
  const t = text.trim();

  // ① 记事："记住：…" / "帮我记住…"
  const rem = /^(?:记住|帮我记住|记一下)[:：，,]?\s*(.+)$/.exec(t);
  if (rem) {
    const content = rem[1]!;
    const key = content.slice(0, 24).replace(/\s+/g, "-");
    await remember(workspaceId, memberNo, { key, content, source: "said" }, actor);
    return { reply: `好嘞，记好啦～「${content.slice(0, 50)}」我收进小本本了，${dn}随时可以在记忆面板里看哦。`, action: "remembered" };
  }

  // ② 定时提醒："明早八点提醒我过审批"
  const dueM = /(明[早天晚]?|今天|今晚|上午|下午|晚上)?.{0,4}[点：:].{0,6}提醒我(.+)|提醒我(.+)/.exec(t);
  if (/提醒我/.test(t)) {
    const what = (dueM?.[2] ?? dueM?.[3] ?? t.replace(/提醒我|，|。/g, "")).trim() || "这件事";
    const dueAt = parseDueAt(t);
    if (dueAt) {
      await addReminder(workspaceId, memberNo, what, dueAt, actor);
      const when = new Date(dueAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" });
      return { reply: `嗯呐，${when} 我叫您「${what.slice(0, 30)}」，绝不迟到！`, action: "reminded", data: { dueAt } };
    }
    return { reply: `想提醒您，可是没听懂是几点呀……再说一次时间好不好，比如「明早八点提醒我过审批」～` };
  }

  // ③ 查任务状态："开发任务咋样了"
  if (/任务|开发|发布/.test(t) && /怎么样|状态|进度|如何|完事|好了吗/.test(t)) {
    const tasks = await svcQuery<{ title: string; status: string }>(workspaceId,
      `SELECT title, status FROM dev_tasks ORDER BY updated_at DESC LIMIT 3`).catch(() => [] as never[]);
    if (tasks.length === 0) return { reply: `现在还没有开发任务哦，${dn}要不要去开发场域派一个？` };
    const STATUS_TEXT: Record<string, string> = {
      draft: "待确认", confirmed: "已确认待派发", running: "机床开发中", auditing: "审计中",
      pending_approval: "等您裁决", released: "已发布", rejected: "被打回", failed: "转人工了", canceled: "已取消",
    };
    const lines = tasks.map((x) => `「${x.title}」${STATUS_TEXT[x.status] ?? x.status}`).join("；");
    const needYou = tasks.filter((x) => x.status === "pending_approval").length;
    return { reply: `${lines}。${needYou > 0 ? `有 ${needYou} 个在等您点头呢，要去看看吗～` : "都在正常跑着，您放心呀。"}`, action: "status", data: tasks };
  }

  // ④ 找 CEO
  if (/叫?CEO|总经理|老板(?![娘板])/.test(t) && !/我是/.test(t)) {
    return { reply: `好，我把场域给您打开，总经理在那儿等您～我就不插嘴啦。`, action: "goto", data: { link: "/" } };
  }

  // ⑤ LLM 兜底（带人设 + 记忆上下文；缺配置走确定性撒娇兜底）
  const mem = await svcQuery<{ content: string }>(workspaceId,
    `SELECT content FROM personal_memory WHERE member_no=$1 AND layer IN ('facts','working','profile')
       AND (expires_at IS NULL OR expires_at > now()) ORDER BY updated_at DESC LIMIT 8`, [memberNo]).catch(() => [] as never[]);
  const memCtx = mem.map((m) => `- ${m.content}`).join("\n");
  const llm = llmCall("secretary-chat");
  if (llm) {
    try {
      const reply = await llm(
        `你是「${persona.name}」，${dn}的贴身小秘书。人设：${persona.tone}。\n` +
        `铁律：不替用户做业务决策；不知道就说不知道并建议去向；回答控制在 80 字内。\n` +
        (memCtx ? `你记住的关于用户的事：\n${memCtx}\n` : "") +
        `用户说：「${t}」\n以小秘书口吻回答（称呼用户为「${dn}」）：`);
      return { reply: reply.slice(0, 300) };
    } catch { /* 落兜底 */ }
  }
  return { reply: `唔……这个我还不太会办呢。${dn}可以让我查任务、定提醒、记事情，或者说「找总经理」哦～` };
}
