import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAllPools } from "@workloom/db";
import {
  assignWizardDraft,
  completeWizardDraft,
  getWizardDraft,
  replayWelcome,
  saveWelcomeProgress,
  saveWizardDraft,
  welcomeProgress,
  type OnboardingIdentity,
  type WizardDraftPayload,
} from "./onboarding-continuity.js";

const RUN_DB = process.env.RUN_DB_TESTS === "1"
  && Boolean(process.env.DATABASE_URL)
  && Boolean(process.env.DATABASE_APP_URL)
  && Boolean(process.env.DATABASE_GATEWAY_URL);

// vitest 5 移除 describe.sequential（默认即顺序执行，且本仓未开启 sequence.shuffle）。
describe.runIf(RUN_DB)("Onboarding PostgreSQL 集成", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const tenantId = `it-onb-tenant-${suffix}`;
  const workspaceId = `it-onb-ws-${suffix}`;
  const accountId = `it-onb-account-${suffix}`;
  const ownerId = `it-onb-owner-${suffix}`;
  const managerId = `it-onb-manager-${suffix}`;
  const viewerId = `it-onb-viewer-${suffix}`;
  const ownerIdentity: OnboardingIdentity = { memberId: ownerId, memberNo: `IT-OWNER-${suffix}`, role: "owner" };
  const managerIdentity: OnboardingIdentity = { memberId: managerId, memberNo: `IT-MANAGER-${suffix}`, role: "manager" };
  const viewerIdentity: OnboardingIdentity = { memberId: viewerId, memberNo: `IT-VIEWER-${suffix}`, role: "readonly" };
  let owner: pg.Pool;

  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query(`INSERT INTO tenants (id,name,plan) VALUES ($1,$2,'pro')`, [tenantId, "Onboarding 集成测试租户"]);
      await client.query(
        `INSERT INTO workspaces (id,tenant_id,name,slug,industry,is_example)
         VALUES ($1,$2,$3,$4,'test',false)`,
        [workspaceId, tenantId, "Onboarding 集成测试工作区", `it-onb-${suffix}`],
      );
      await client.query(
        `INSERT INTO accounts (id,display_name) VALUES ($1,$2)`,
        [accountId, "Onboarding 集成测试账号"],
      );
      await client.query(
        `INSERT INTO members (id,workspace_id,member_no,name,role,account_id,status)
         VALUES ($1,$4,$2,$3,'owner',$5,'active'),
                ($6,$4,$7,$8,'manager',$5,'active'),
                ($9,$4,$10,$11,'readonly',NULL,'active')`,
        [
          ownerId, ownerIdentity.memberNo, "测试所有者", workspaceId, accountId,
          managerId, managerIdentity.memberNo, "测试管理员",
          viewerId, viewerIdentity.memberNo, "测试观察成员",
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await closeAllPools();
    await owner?.end();
  });

  it("欢迎进度真实落库，并按账号、角色与工作区隔离后可重播", async () => {
    const saved = await saveWelcomeProgress(workspaceId, ownerIdentity, {
      status: "paused",
      currentStep: "team",
    });
    expect(saved).toMatchObject({ persisted: true, status: "paused", currentStep: "team", shouldShow: true });
    await expect(welcomeProgress(workspaceId, ownerIdentity)).resolves.toMatchObject({
      persisted: true,
      status: "paused",
      currentStep: "team",
    });
    // 同一账号但角色不同，不能继承所有者旅程完成态。
    await expect(welcomeProgress(workspaceId, managerIdentity)).resolves.toMatchObject({
      persisted: false,
      status: "not_started",
      shouldShow: true,
    });

    await saveWelcomeProgress(workspaceId, ownerIdentity, { status: "completed", currentStep: "done" });
    await expect(welcomeProgress(workspaceId, ownerIdentity)).resolves.toMatchObject({
      status: "completed",
      shouldShow: false,
    });
    await expect(replayWelcome(workspaceId, ownerIdentity)).resolves.toMatchObject({
      status: "not_started",
      currentStep: "start",
      replayCount: 1,
      shouldShow: true,
    });

    const row = await owner.query<{ identity_key: string; role: string }>(
      `SELECT identity_key,role FROM onboarding_progress WHERE workspace_id=$1`, [workspaceId],
    );
    expect(row.rows).toEqual([{ identity_key: `account:${accountId}`, role: "owner" }]);
  });

  it("草稿真实续办、乐观锁、责任人交接与秘密白名单均生效", async () => {
    await expect(getWizardDraft(workspaceId)).resolves.toBeNull();
    const unsafePayload: WizardDraftPayload & Record<string, unknown> = {
      provider: "deepseek",
      model: "deepseek-chat",
      businessName: "真实测试企业",
      apiKey: "sk-never-store",
      documentBody: "不应写入草稿的正文",
    };
    const first = await saveWizardDraft(workspaceId, ownerIdentity, {
      expectedVersion: 0,
      currentStep: 2,
      payload: unsafePayload,
    });
    expect(first).toMatchObject({ version: 1, currentStep: 2, responsible: { memberId: ownerId } });
    expect(first.payload).toEqual({
      provider: "deepseek",
      model: "deepseek-chat",
      businessName: "真实测试企业",
    });

    const stored = await owner.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM onboarding_wizard_drafts WHERE workspace_id=$1`, [workspaceId],
    );
    expect(stored.rows[0]?.payload).not.toHaveProperty("apiKey");
    expect(stored.rows[0]?.payload).not.toHaveProperty("documentBody");

    await expect(saveWizardDraft(workspaceId, ownerIdentity, {
      expectedVersion: 0,
      currentStep: 3,
      payload: first.payload,
    })).rejects.toThrow(/当前版本 1/);
    await expect(saveWizardDraft(workspaceId, viewerIdentity, {
      expectedVersion: 1,
      currentStep: 3,
      payload: first.payload,
    })).rejects.toThrow(/其他成员负责/);

    const assigned = await assignWizardDraft(workspaceId, ownerIdentity, {
      memberId: managerId,
      expectedVersion: 1,
    });
    expect(assigned).toMatchObject({ version: 2, responsible: { memberId: managerId, role: "manager" } });
    const continued = await saveWizardDraft(workspaceId, managerIdentity, {
      expectedVersion: 2,
      currentStep: 4,
      payload: { ...assigned.payload, siteUrl: "https://example.com" },
    });
    expect(continued).toMatchObject({ version: 3, currentStep: 4 });
    const completed = await completeWizardDraft(workspaceId, managerIdentity, 3);
    expect(completed).toMatchObject({ version: 4, status: "completed", currentStep: 4 });
    await expect(getWizardDraft(workspaceId)).resolves.toMatchObject({ version: 4, status: "completed" });
  });

  it("RLS 隔离错误工作区读取，且 0030 从数据库层拒绝双 active", async () => {
    const app = new pg.Pool({ connectionString: process.env.DATABASE_APP_URL });
    const client = await app.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id',$1,true)", [`wrong-${workspaceId}`]);
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
      const hidden = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM onboarding_wizard_drafts WHERE workspace_id=$1`, [workspaceId],
      );
      expect(hidden.rows[0]?.count).toBe("0");
      await client.query("ROLLBACK");
    } finally {
      client.release();
      await app.end();
    }

    await owner.query(
      `INSERT INTO bundle_installs (id,workspace_id,bundle_id,assets,status)
       VALUES ($1,$2,'first','{}','active')`,
      [`it-onb-install-a-${suffix}`, workspaceId],
    );
    await expect(owner.query(
      `INSERT INTO bundle_installs (id,workspace_id,bundle_id,assets,status)
       VALUES ($1,$2,'second','{}','active')`,
      [`it-onb-install-b-${suffix}`, workspaceId],
    )).rejects.toMatchObject({ code: "23505" });
  });
});
