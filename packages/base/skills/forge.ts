/**
 * skills · 零代码自定义技能（F8.3）+ dry-run 预览
 *  - 自然语言三要素（触发 / 步骤 / 边界）引导式生成技能草稿（SKILL.md 标准目录，F8.1 资产不锁死）
 *  - 生成物进版本管理：同名再生成 = version 递增（skills 行 UPDATE version）
 *  - 生效前 dry-run 预览：回放最近 10 条历史动作（F2.5 同口径），写 skill.dry_run 事件留痕——
 *    本事件即 installSkill 的「已预览」前置凭证（registry.ts hasDryRunTrace）
 */
import type pg from "pg";
import { DRY_RUN_REPLAY_LIMIT, type BusinessEvent } from "@workloom/shared";
import { replayRules, type RuntimeRule } from "../fence-engine/index.js";
import { gatewayAppend, gatewayAppendOnClient } from "../workdata/gateway.js";
import { getSkill, SkillError, type SkillRow } from "./registry.js";

interface Scope { tenantId: string; workspaceId: string }

/** 三要素（F8.3 原文：触发 / 步骤 / 边界） */
export interface SkillTriplet {
  trigger: string;
  steps: string[];
  boundary: string;
}

/** 渲染 SKILL.md（纯函数）：YAML frontmatter + 三要素正文 */
export function renderSkillMarkdown(name: string, description: string, triplet: SkillTriplet): string {
  const steps = triplet.steps.map((s, i) => `${i + 1}. ${s}`).join("\n");
  return `---
name: ${name}
description: ${description}
---

# ${name}

## 触发（何时用）
${triplet.trigger}

## 步骤（怎么做）
${steps}

## 边界（什么不做）
${triplet.boundary}
`;
}

/**
 * 名称 → 团队技能 ID（skill-t-<workspaceId>- 命名空间即 L8.2 白名单内「本工作区自建」标识）
 * 修复（#23）：ID 内嵌 workspaceId——skills 是无 RLS 的全局表，原纯名称派生 ID
 * 会让两个工作区的同名技能 ON CONFLICT 互相覆盖（跨工作区数据污染）
 */
export function teamSkillId(name: string, workspaceId: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9一-鿿]+/g, "-").replace(/^-+|-+$/g, "");
  return `skill-t-${workspaceId}-${slug || "unnamed"}`;
}

async function nextVersion(app: pg.Pool, id: string): Promise<string> {
  const cur = await app.query<{ version: string }>(`SELECT version FROM skills WHERE id=$1`, [id]);
  const v = cur.rows[0]?.version;
  if (!v) return "1.0.0";
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) return "1.0.0";
  return `${m[1]}.${Number(m[2]) + 1}.0`; // 内容迭代 = minor 递增
}

/** 生成/迭代技能草稿（F8.3：生成物进版本管理） */
export async function createSkillDraft(
  app: pg.Pool,
  gateway: pg.Pool,
  scope: Scope,
  input: { name: string; description: string; triplet: SkillTriplet; fenceBindings?: string[]; by: string },
): Promise<{ skillId: string; version: string }> {
  const skillId = teamSkillId(input.name, scope.workspaceId);
  const version = await nextVersion(app, skillId);
  const body = renderSkillMarkdown(input.name, input.description, input.triplet);
  // D16（#1/A）：技能行与草稿事件同一事务同一 COMMIT
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    await client.query(
      `INSERT INTO skills (id, level, bundle, name, version, description, fence_bindings, body, desensitized)
       VALUES ($1,'team',NULL,$2,$3,$4,$5,$6,false)
       ON CONFLICT (id) DO UPDATE SET version=EXCLUDED.version, description=EXCLUDED.description,
         fence_bindings=EXCLUDED.fence_bindings, body=EXCLUDED.body`,
      [skillId, input.name, version, input.description, JSON.stringify(input.fenceBindings ?? []), body],
    );
    await gatewayAppendOnClient(client, {
      tenantId: scope.tenantId, workspaceId: scope.workspaceId,
      actor: { id: input.by, type: "human" },
    }, {
      who: { type: "human", id: input.by },
      context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
      object: { type: "skill", id: skillId },
      decision: {
        action: "skill.draft.created",
        after: { skillId, name: input.name, version, triplet: input.triplet, fenceBindings: input.fenceBindings ?? [] },
        basis: ["自然语言三要素引导式生成技能草稿（F8.3）", "生成物进版本管理（F8.3）"],
      },
      rule_impact: [],
    } as never);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  return { skillId, version };
}

export interface SkillDryRunReport {
  skillId: string;
  replayed: number;
  /** 按绑定规则分组的模拟判定 */
  perRule: Array<{ ruleId: string; version: string; wouldBlock: number; wouldReview: number; pass: number }>;
}

/** dry-run 预览（F8.3 生效前）：对技能声明的绑定围栏逐条回放最近 10 条（F2.5 口径） */
export async function dryRunSkill(
  app: pg.Pool,
  gateway: pg.Pool,
  scope: Scope,
  input: { skillId: string; by: string },
): Promise<SkillDryRunReport> {
  const skill: SkillRow | null = await getSkill(app, input.skillId);
  if (!skill) throw new SkillError("NOT_FOUND", `技能 ${input.skillId} 不存在`);

  const client = await app.connect();
  let events: BusinessEvent[] = [];
  let rules: RuntimeRule[] = [];
  try {
    // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const ev = await client.query<{ payload: BusinessEvent }>(
      `SELECT payload FROM biz_events WHERE workspace_id=$1 ORDER BY seq DESC LIMIT $2`,
      [scope.workspaceId, DRY_RUN_REPLAY_LIMIT],
    );
    events = ev.rows.map((r) => r.payload);
    const bindings = skill.fence_bindings ?? [];
    if (bindings.length > 0) {
      const rr = await client.query<{
        rule_id: string; version: string; name: string; level: RuntimeRule["level"];
        is_baseline: boolean; match_spec: { object_types?: string[]; actions?: string[]; when?: string };
      }>(
        `SELECT DISTINCT ON (rule_id) rule_id, version, name, level, is_baseline, match_spec
         FROM fence_rules WHERE (workspace_id=$1 OR workspace_id='*') AND status='active' AND rule_id = ANY($2)
         ORDER BY rule_id, created_at DESC`,
        [scope.workspaceId, bindings],
      );
      rules = rr.rows.map((r) => ({
        rule_id: r.rule_id, version: r.version, name: r.name, level: r.level, is_baseline: r.is_baseline,
        objectTypes: r.match_spec.object_types ?? [], actions: r.match_spec.actions ?? [], when: r.match_spec.when ?? "true",
      }));
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    await client.query("COMMIT").catch(() => undefined);
    client.release();
  }

  const perRule = rules.map((rule) => {
    const { verdicts } = replayRules(events, [rule], "auto");
    return {
      ruleId: rule.rule_id,
      version: rule.version,
      wouldBlock: verdicts.filter((v) => v.verdict.level === "block").length,
      wouldReview: verdicts.filter((v) => v.verdict.level === "review").length,
      pass: verdicts.filter((v) => v.verdict.level === "auto").length,
    };
  });
  const report: SkillDryRunReport = { skillId: skill.id, replayed: events.length, perRule };

  await gatewayAppend(gateway, {
    tenantId: scope.tenantId, workspaceId: scope.workspaceId,
    actor: { id: input.by, type: "human" },
  }, {
    who: { type: "human", id: input.by },
    context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
    object: { type: "skill", id: skill.id },
    decision: {
      action: "skill.dry_run",
      after: { ...report, name: skill.name, version: skill.version },
      basis: ["生效前 dry-run 预览（F8.3）；回放窗口=最近 10 条（F2.5 同口径）"],
    },
    rule_impact: [],
  } as never);
  return report;
}
