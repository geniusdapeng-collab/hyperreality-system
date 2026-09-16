/**
 * onboarding-continuity · 首次欢迎与标准落地向导的服务端事实源。
 *
 * 首次欢迎按账号（无账号的开发成员退回 member）×角色×工作区×旅程版本隔离；
 * 标准落地向导保存无秘密草稿并以 expectedVersion 做乐观并发控制。
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { appendEventOn, serviceTx } from "./events.js";

const WELCOME_JOURNEY = "workspace-welcome";
export const WELCOME_JOURNEY_VERSION = 1;
export const WELCOME_STEPS = ["start", "mate", "team", "summary", "done"] as const;
export type WelcomeStep = (typeof WELCOME_STEPS)[number];
export type WelcomeStatus = "not_started" | "in_progress" | "paused" | "completed";

export interface OnboardingIdentity {
  memberId: string;
  memberNo: string;
  role: string;
}

export interface WelcomeProgress {
  persisted: boolean;
  status: WelcomeStatus;
  currentStep: WelcomeStep;
  journeyVersion: number;
  replayCount: number;
  shouldShow: boolean;
  updatedAt: string | null;
}

interface Subject {
  identityKey: string;
  accountId: string | null;
}

interface WelcomeRow {
  status: WelcomeStatus;
  current_step: string;
  journey_version: number;
  replay_count: number;
  updated_at: string;
}

const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;

/** 账号存在时跨成员身份续播；历史/开发成员才退回工作区内 member 身份。 */
export function onboardingIdentityKey(accountId: string | null, memberId: string): string {
  return accountId ? `account:${accountId}` : `member:${memberId}`;
}

function welcomeStep(value: string): WelcomeStep {
  return (WELCOME_STEPS as readonly string[]).includes(value) ? value as WelcomeStep : "start";
}

async function subjectOf(client: pg.PoolClient, identity: OnboardingIdentity): Promise<Subject> {
  const result = await client.query<{ account_id: string | null }>(
    `SELECT account_id FROM members WHERE id=$1`, [identity.memberId],
  );
  const accountId = result.rows[0]?.account_id ?? null;
  return {
    accountId,
    identityKey: onboardingIdentityKey(accountId, identity.memberId),
  };
}

export async function welcomeProgress(
  workspaceId: string,
  identity: OnboardingIdentity,
): Promise<WelcomeProgress> {
  // 未登录开发预览共用 GUEST 成员，不能把某一台浏览器的完成态写成所有访客的完成态。
  if (identity.memberNo === "GUEST") {
    return {
      persisted: false,
      status: "not_started",
      currentStep: "start",
      journeyVersion: WELCOME_JOURNEY_VERSION,
      replayCount: 0,
      shouldShow: true,
      updatedAt: null,
    };
  }
  return serviceTx(workspaceId, async (client) => {
    const subject = await subjectOf(client, identity);
    const rows = await client.query<WelcomeRow>(
      `SELECT status, current_step, journey_version, replay_count, updated_at
       FROM onboarding_progress
       WHERE workspace_id=$1 AND identity_key=$2 AND role=$3
         AND journey_key=$4 AND journey_version=$5`,
      [workspaceId, subject.identityKey, identity.role, WELCOME_JOURNEY, WELCOME_JOURNEY_VERSION],
    );
    const row = rows.rows[0];
    if (!row) {
      return {
        persisted: false,
        status: "not_started",
        currentStep: "start",
        journeyVersion: WELCOME_JOURNEY_VERSION,
        replayCount: 0,
        shouldShow: true,
        updatedAt: null,
      };
    }
    return {
      persisted: true,
      status: row.status,
      currentStep: welcomeStep(row.current_step),
      journeyVersion: row.journey_version,
      replayCount: row.replay_count,
      shouldShow: row.status !== "completed",
      updatedAt: row.updated_at,
    };
  });
}

export async function saveWelcomeProgress(
  workspaceId: string,
  identity: OnboardingIdentity,
  input: { status: Exclude<WelcomeStatus, "not_started">; currentStep: WelcomeStep },
): Promise<WelcomeProgress> {
  if (identity.memberNo === "GUEST") {
    return {
      persisted: false,
      status: input.status,
      currentStep: input.status === "completed" ? "done" : input.currentStep,
      journeyVersion: WELCOME_JOURNEY_VERSION,
      replayCount: 0,
      shouldShow: input.status !== "completed",
      updatedAt: null,
    };
  }
  return serviceTx(workspaceId, async (client, scope) => {
    const subject = await subjectOf(client, identity);
    const completed = input.status === "completed";
    const rows = await client.query<WelcomeRow>(
      `INSERT INTO onboarding_progress
         (id, workspace_id, identity_key, account_id, member_id, role, journey_key,
          journey_version, status, current_step, started_at, completed_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),CASE WHEN $9='completed' THEN now() ELSE NULL END,now())
       ON CONFLICT (workspace_id, identity_key, role, journey_key, journey_version)
       DO UPDATE SET status=EXCLUDED.status,
                     current_step=EXCLUDED.current_step,
                     member_id=EXCLUDED.member_id,
                     account_id=EXCLUDED.account_id,
                     completed_at=CASE WHEN EXCLUDED.status='completed' THEN now() ELSE NULL END,
                     updated_at=now()
       RETURNING status, current_step, journey_version, replay_count, updated_at`,
      [newId("obp"), workspaceId, subject.identityKey, subject.accountId, identity.memberId,
       identity.role, WELCOME_JOURNEY, WELCOME_JOURNEY_VERSION, input.status,
       completed ? "done" : input.currentStep],
    );
    await appendEventOn(client, scope, { id: identity.memberNo, type: "human" }, {
      objectType: "member",
      objectId: identity.memberId,
      action: completed ? "onboarding.welcome.completed" : "onboarding.welcome.progress",
      after: { journey_version: WELCOME_JOURNEY_VERSION, status: input.status, current_step: completed ? "done" : input.currentStep },
    });
    const row = rows.rows[0]!;
    return {
      persisted: true,
      status: row.status,
      currentStep: welcomeStep(row.current_step),
      journeyVersion: row.journey_version,
      replayCount: row.replay_count,
      shouldShow: row.status !== "completed",
      updatedAt: row.updated_at,
    };
  });
}

export async function replayWelcome(
  workspaceId: string,
  identity: OnboardingIdentity,
): Promise<WelcomeProgress> {
  if (identity.memberNo === "GUEST") {
    return {
      persisted: false,
      status: "not_started",
      currentStep: "start",
      journeyVersion: WELCOME_JOURNEY_VERSION,
      replayCount: 0,
      shouldShow: true,
      updatedAt: null,
    };
  }
  return serviceTx(workspaceId, async (client, scope) => {
    const subject = await subjectOf(client, identity);
    const rows = await client.query<WelcomeRow>(
      `INSERT INTO onboarding_progress
         (id, workspace_id, identity_key, account_id, member_id, role, journey_key,
          journey_version, status, current_step, started_at, replay_count, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'not_started','start',now(),1,now())
       ON CONFLICT (workspace_id, identity_key, role, journey_key, journey_version)
       DO UPDATE SET status='not_started', current_step='start', completed_at=NULL,
                     replay_count=onboarding_progress.replay_count+1,
                     member_id=EXCLUDED.member_id, account_id=EXCLUDED.account_id, updated_at=now()
       RETURNING status, current_step, journey_version, replay_count, updated_at`,
      [newId("obp"), workspaceId, subject.identityKey, subject.accountId, identity.memberId,
       identity.role, WELCOME_JOURNEY, WELCOME_JOURNEY_VERSION],
    );
    await appendEventOn(client, scope, { id: identity.memberNo, type: "human" }, {
      objectType: "member",
      objectId: identity.memberId,
      action: "onboarding.welcome.replayed",
      after: { journey_version: WELCOME_JOURNEY_VERSION, current_step: "start" },
    });
    const row = rows.rows[0]!;
    return {
      persisted: true,
      status: row.status,
      currentStep: welcomeStep(row.current_step),
      journeyVersion: row.journey_version,
      replayCount: row.replay_count,
      shouldShow: true,
      updatedAt: row.updated_at,
    };
  });
}

export interface WizardDraftPayload {
  provider?: string;
  baseUrl?: string;
  model?: string;
  businessName?: string;
  industry?: string;
  note?: string;
  siteUrl?: string;
  documentTitle?: string;
  testQuestion?: string;
}

const WIZARD_PAYLOAD_KEYS = [
  "provider", "baseUrl", "model", "businessName", "industry", "note",
  "siteUrl", "documentTitle", "testQuestion",
] as const satisfies ReadonlyArray<keyof WizardDraftPayload>;

/**
 * 服务层再次执行白名单过滤，避免绕过 tRPC 时把模型密钥、文档正文等秘密写入续办草稿；
 * 读取旧草稿时也只投影允许向客户端显示的字段。
 */
export function normalizeWizardDraftPayload(value: unknown): WizardDraftPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const result: WizardDraftPayload = {};
  for (const key of WIZARD_PAYLOAD_KEYS) {
    if (typeof source[key] === "string") result[key] = source[key];
  }
  return result;
}

export interface WizardDraftView {
  id: string;
  version: number;
  status: "draft" | "completed" | "abandoned";
  currentStep: number;
  payload: WizardDraftPayload;
  responsible: { memberId: string; memberNo: string; name: string; role: string };
  updatedAt: string;
}

interface WizardRow {
  id: string;
  version: number;
  status: "draft" | "completed" | "abandoned";
  current_step: number;
  payload: WizardDraftPayload;
  responsible_member_id: string;
  responsible_role: string;
  responsible_member_no: string;
  responsible_name: string;
  updated_at: string;
}

function wizardView(row: WizardRow): WizardDraftView {
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    currentStep: row.current_step,
    payload: normalizeWizardDraftPayload(row.payload),
    responsible: {
      memberId: row.responsible_member_id,
      memberNo: row.responsible_member_no,
      name: row.responsible_name,
      role: row.responsible_role,
    },
    updatedAt: row.updated_at,
  };
}

const WIZARD_SELECT = `SELECT d.id, d.version, d.status, d.current_step, d.payload,
                              d.responsible_member_id, d.responsible_role,
                              m.member_no AS responsible_member_no,
                              COALESCE(m.alias,m.name) AS responsible_name,
                              d.updated_at
                       FROM onboarding_wizard_drafts d
                       JOIN members m ON m.id=d.responsible_member_id AND m.workspace_id=d.workspace_id`;

export async function getWizardDraft(workspaceId: string): Promise<WizardDraftView | null> {
  return serviceTx(workspaceId, async (client) => {
    const rows = await client.query<WizardRow>(
      `${WIZARD_SELECT} WHERE d.workspace_id=$1 AND d.journey_key='real-mode-setup'`, [workspaceId],
    );
    return rows.rows[0] ? wizardView(rows.rows[0]) : null;
  });
}

export function canEditWizard(identity: OnboardingIdentity, responsibleMemberId: string): boolean {
  return identity.memberId === responsibleMemberId || identity.role === "owner" || identity.role === "manager";
}

export async function saveWizardDraft(
  workspaceId: string,
  identity: OnboardingIdentity,
  input: { expectedVersion: number; currentStep: number; payload: WizardDraftPayload },
): Promise<WizardDraftView> {
  return serviceTx(workspaceId, async (client, scope) => {
    await client.query(`SELECT id FROM workspaces WHERE id=$1 FOR UPDATE`, [workspaceId]);
    const currentRows = await client.query<{
      id: string; version: number; responsible_member_id: string; status: string;
    }>(
      `SELECT id, version, responsible_member_id, status FROM onboarding_wizard_drafts
       WHERE workspace_id=$1 AND journey_key='real-mode-setup' FOR UPDATE`, [workspaceId],
    );
    const current = currentRows.rows[0];
    if (current && !canEditWizard(identity, current.responsible_member_id)) {
      throw new Error("当前向导由其他成员负责，请联系责任人或管理员交接");
    }
    if (current && current.status === "completed") throw new Error("该落地向导已完成；如需变更请从配置中心发起新版本");
    if ((current?.version ?? 0) !== input.expectedVersion) {
      throw new Error(`向导草稿已由其他成员更新（当前版本 ${current?.version ?? 0}），请刷新后继续`);
    }
    const id = current?.id ?? newId("obw");
    if (current) {
      await client.query(
        `UPDATE onboarding_wizard_drafts
         SET version=version+1, current_step=$3, payload=$4, updated_by=$5, updated_at=now()
         WHERE workspace_id=$1 AND id=$2`,
        [workspaceId, id, input.currentStep, JSON.stringify(normalizeWizardDraftPayload(input.payload)), identity.memberId],
      );
    } else {
      await client.query(
        `INSERT INTO onboarding_wizard_drafts
           (id, workspace_id, journey_key, version, status, current_step, payload,
            responsible_member_id, responsible_role, created_by, updated_by)
         VALUES ($1,$2,'real-mode-setup',1,'draft',$3,$4,$5,$6,$5,$5)`,
        [id, workspaceId, input.currentStep, JSON.stringify(normalizeWizardDraftPayload(input.payload)), identity.memberId, identity.role],
      );
    }
    const savedRows = await client.query<WizardRow>(
      `${WIZARD_SELECT} WHERE d.workspace_id=$1 AND d.id=$2`, [workspaceId, id],
    );
    const saved = savedRows.rows[0]!;
    await appendEventOn(client, scope, { id: identity.memberNo, type: "human" }, {
      objectType: "onboarding_wizard",
      objectId: id,
      action: "onboarding.draft.saved",
      after: { version: saved.version, current_step: saved.current_step, responsible_member_id: saved.responsible_member_id },
    });
    return wizardView(saved);
  });
}

export async function assignWizardDraft(
  workspaceId: string,
  identity: OnboardingIdentity,
  input: { memberId: string; expectedVersion: number },
): Promise<WizardDraftView> {
  if (identity.role !== "owner") throw new Error("只有工作区所有者可以交接落地向导责任人");
  return serviceTx(workspaceId, async (client, scope) => {
    const target = await client.query<{ id: string; role: string }>(
      `SELECT id, role FROM members WHERE workspace_id=$1 AND id=$2 AND status='active'`,
      [workspaceId, input.memberId],
    );
    if (!target.rows[0]) throw new Error("目标责任人不是当前工作区的有效成员");
    const updated = await client.query<{ id: string }>(
      `UPDATE onboarding_wizard_drafts
       SET responsible_member_id=$3, responsible_role=$4, version=version+1,
           updated_by=$5, updated_at=now()
       WHERE workspace_id=$1 AND journey_key='real-mode-setup' AND version=$2 AND status='draft'
       RETURNING id`,
      [workspaceId, input.expectedVersion, input.memberId, target.rows[0].role, identity.memberId],
    );
    if (!updated.rows[0]) throw new Error("向导草稿版本已变化或尚未创建，请刷新后重试");
    const rows = await client.query<WizardRow>(
      `${WIZARD_SELECT} WHERE d.workspace_id=$1 AND d.id=$2`, [workspaceId, updated.rows[0].id],
    );
    await appendEventOn(client, scope, { id: identity.memberNo, type: "human" }, {
      objectType: "onboarding_wizard",
      objectId: updated.rows[0].id,
      action: "onboarding.draft.assigned",
      after: { responsible_member_id: input.memberId, version: rows.rows[0]!.version },
    });
    return wizardView(rows.rows[0]!);
  });
}

/** 正式模式翻转时只推进到服务前台步骤；服务前台仍可选配，不能提前宣告整段向导完成。 */
export async function advanceWizardDraftOn(
  client: pg.PoolClient,
  workspaceId: string,
  memberId: string,
): Promise<void> {
  await client.query(
    `UPDATE onboarding_wizard_drafts
     SET current_step=4, version=version+1,
         updated_by=$2, updated_at=now()
     WHERE workspace_id=$1 AND journey_key='real-mode-setup' AND status='draft'`,
    [workspaceId, memberId],
  );
}

export async function completeWizardDraft(
  workspaceId: string,
  identity: OnboardingIdentity,
  expectedVersion: number,
): Promise<WizardDraftView> {
  return serviceTx(workspaceId, async (client, scope) => {
    await client.query(`SELECT id FROM workspaces WHERE id=$1 FOR UPDATE`, [workspaceId]);
    const current = await client.query<{ id: string; version: number; responsible_member_id: string }>(
      `SELECT id, version, responsible_member_id FROM onboarding_wizard_drafts
       WHERE workspace_id=$1 AND journey_key='real-mode-setup' AND status='draft' FOR UPDATE`, [workspaceId],
    );
    const row = current.rows[0];
    if (!row) throw new Error("落地向导草稿不存在或已经完成");
    if (!canEditWizard(identity, row.responsible_member_id)) throw new Error("当前向导由其他成员负责，请联系责任人或管理员交接");
    if (row.version !== expectedVersion) throw new Error(`向导草稿已更新（当前版本 ${row.version}），请刷新后继续`);
    await client.query(
      `UPDATE onboarding_wizard_drafts
       SET status='completed', current_step=4, version=version+1, completed_at=now(),
           updated_by=$3, updated_at=now()
       WHERE workspace_id=$1 AND id=$2`, [workspaceId, row.id, identity.memberId],
    );
    const savedRows = await client.query<WizardRow>(
      `${WIZARD_SELECT} WHERE d.workspace_id=$1 AND d.id=$2`, [workspaceId, row.id],
    );
    await appendEventOn(client, scope, { id: identity.memberNo, type: "human" }, {
      objectType: "onboarding_wizard",
      objectId: row.id,
      action: "onboarding.completed",
      after: { version: savedRows.rows[0]!.version, current_step: 4 },
    });
    return wizardView(savedRows.rows[0]!);
  });
}
