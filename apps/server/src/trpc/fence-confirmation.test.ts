import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import pg from "pg";
import { closeAllPools, getAppPool, getGatewayPool } from "@workloom/db";
import { signDemoToken, type Identity } from "@workloom/base/tenancy";
import { gatewayAppend } from "@workloom/base/workdata";
import { activateRuleVersion } from "@workloom/base/fence-engine";
import { decide as decideApproval } from "@workloom/base/review-console";
import { stableStringify } from "@workloom/base/im-channels";
import { appRouter } from "./router.js";
import { createContext } from "./context.js";

const RUN_DB = process.env.RUN_DB_TESTS === "1"
  && Boolean(process.env.DATABASE_URL && process.env.DATABASE_APP_URL && process.env.DATABASE_GATEWAY_URL);

describe.skipIf(!RUN_DB)("围栏确认 HTTP/PG：预演、版本、审批与回滚同链", () => {
  const suffix = randomUUID();
  const tenantId = `tenant-fence-http-${suffix}`;
  const workspaceId = `ws-fence-http-${suffix}`;
  const foreignWorkspaceId = `ws-fence-foreign-${suffix}`;
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  let tokens: { owner: string; foreign: string; readonly: string; denied: string; guardrailDenied: string; approvalDenied: string };
  let sequence = 970000;
  const requestErrors: string[] = [];

  const rule = (level: "auto" | "review" | "block" = "auto") => ({
    ruleId: `R${++sequence}`, name: "围栏确认回归候选", level,
    objectTypes: ["fence_probe"], actions: ["fence_probe.adjust"], when: "true",
  });
  type Candidate = ReturnType<typeof rule>;

  async function request(path: string, body: unknown, token?: string, headers: Record<string, string> = {}) {
    const req = new Request(`http://fence-regression.local/trpc/${path}`, {
      method: "POST", headers: {
        "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers,
      }, body: JSON.stringify(body),
    });
    const res = await fetchRequestHandler({
      endpoint: "/trpc", req, router: appRouter, createContext: () => createContext(req),
      onError: ({ error }) => { requestErrors.push(error.message); },
    });
    const json = await res.json() as {
      result: { data: { dryRunId: string; eventId: string; status?: string; deduped?: boolean } };
      error: { message: string };
    };
    return { status: res.status, json };
  }

  async function dryRun(candidate: Candidate): Promise<string> {
    const res = await request("fence.dryRun", candidate, tokens.owner);
    expect(res.status, requestErrors.at(-1)).toBe(200);
    expect(res.json.result.data.dryRunId).toBeTypeOf("string");
    return res.json.result.data.dryRunId;
  }

  async function confirm(candidate: Candidate, dryRunId: string, token = tokens.owner) {
    return request("fence.confirmDryRun", { dryRunId, rule: candidate }, token);
  }

  async function rowState(dryRunId: string) {
    return (await owner.query<{ status: string }>("SELECT status FROM fence_dry_runs WHERE id=$1", [dryRunId])).rows[0]?.status;
  }

  async function candidates(ruleId: string) {
    return (await owner.query<{ id: string; version: string; status: string; level: string }>(
      "SELECT id,version,status,level FROM fence_rules WHERE workspace_id=$1 AND rule_id=$2 ORDER BY version",
      [workspaceId, ruleId],
    )).rows;
  }

  async function proposeAndApprove(candidate: Candidate) {
    const dryRunId = await dryRun(candidate);
    const proposal = await confirm(candidate, dryRunId);
    expect(proposal.status).toBe(200);
    const eventId = proposal.json.result.data.eventId as string;
    const approvalId = (await owner.query<{ approval_id: string; snapshot: { high_risk?: boolean } }>(
      "SELECT approval_id,snapshot FROM approvals WHERE workspace_id=$1 AND event_id=$2", [workspaceId, eventId],
    )).rows[0]!;
    expect(approvalId.snapshot.high_risk).toBe(true);
    const approved = await request("approvals.decide", { approvalId: approvalId.approval_id, gesture: "approve" }, tokens.owner);
    expect(approved.status).toBe(200);
    const event = (await owner.query<{ payload: { decision: { after: { ruleRowId: string; version: string; dryRunId: string } } } }>(
      "SELECT payload FROM biz_events WHERE workspace_id=$1 AND event_id=$2", [workspaceId, eventId],
    )).rows[0]!.payload.decision.after;
    expect(event.dryRunId).toBe(dryRunId);
    expect((await candidates(candidate.ruleId)).find((row) => row.id === event.ruleRowId)).toMatchObject({ status: "active", version: event.version });
    return { dryRunId, event, approvalId: approvalId.approval_id };
  }

  beforeAll(async () => {
    await owner.query("INSERT INTO tenants(id,name,plan) VALUES($1,'围栏 HTTP 回归专用','pro')", [tenantId]);
    for (const ws of [workspaceId, foreignWorkspaceId]) {
      await owner.query("INSERT INTO workspaces(id,tenant_id,slug,name,industry,stage) VALUES($1,$2,$1,'围栏回归','test','stable')", [ws, tenantId]);
      for (const [memberNo, role, permissions] of [
        ["MEM-001", "owner", {}], ["MEM-003", "readonly", {}],
        ["MEM-002", "manager", { deny: ["workspace.write", "guardrail.manage", "approval.decide"] }],
        ["MEM-004", "manager", { deny: ["guardrail.manage"] }],
        ["MEM-005", "manager", { deny: ["approval.decide"] }],
        ["MEM-006", "manager", { "approval.decide": false }],
        ["MEM-007", "readonly", {}],
      ] as const) {
        await owner.query("INSERT INTO members(id,workspace_id,member_no,name,role,permissions) VALUES($1,$2,$3,$3,$4,$5)",
          [`${ws}-${memberNo}`, ws, memberNo, role, JSON.stringify(permissions)]);
      }
    }
    const token = (ws: string, memberNo: string, role: Identity["role"]) => signDemoToken({
      memberId: `${ws}-${memberNo}`, memberNo, name: "围栏回归", role, tenantId, workspaceId: ws, plan: "pro",
    });
    tokens = {
      owner: await token(workspaceId, "MEM-001", "owner"),
      foreign: await token(foreignWorkspaceId, "MEM-001", "owner"),
      readonly: await token(workspaceId, "MEM-003", "readonly"),
      denied: await token(workspaceId, "MEM-002", "manager"),
      guardrailDenied: await token(workspaceId, "MEM-004", "manager"),
      approvalDenied: await token(workspaceId, "MEM-005", "manager"),
    };
    await owner.query("UPDATE members SET im_openids=$2 WHERE workspace_id=$1 AND member_no='MEM-001'", [workspaceId, JSON.stringify({ dingtalk: `owner-${suffix}` })]);
    await owner.query("UPDATE members SET im_openids=$2 WHERE workspace_id=$1 AND member_no='MEM-005'", [workspaceId, JSON.stringify({ dingtalk: `denied-${suffix}` })]);
    for (let i = 0; i < 10; i++) await gatewayAppend(getGatewayPool(), {
      tenantId, workspaceId, actor: { id: "MEM-001", type: "human" },
    }, {
      who: { id: "MEM-001", type: "human" },
      context: { tenant_id: tenantId, workspace_id: workspaceId, time: new Date().toISOString() },
      object: { type: "fence_probe", id: `sample-${i}` }, decision: { action: "fence_probe.read" }, rule_impact: [],
    });
  });

  afterAll(async () => {
    // 事件账本只追加；保留独立 UUID 工作区，不删除审计事实或其他用例数据。
    await Promise.allSettled([owner.end(), closeAllPools()]);
  });

  it("真实 HTTP 确认→具名版本提案→人工批准→规则生效", async () => {
    const candidate = rule();
    const { dryRunId, event } = await proposeAndApprove(candidate);
    expect(await rowState(dryRunId)).toBe("confirmed");
    expect(event.version).toBe("v1");
    expect(event.ruleRowId).toBe(`fr-${candidate.ruleId.toLowerCase()}-v1-${workspaceId}`);
  });

  it("同规则连续加严分配独立版本；放宽在确认前拒绝", async () => {
    const candidate = rule();
    await proposeAndApprove(candidate);
    await proposeAndApprove({ ...candidate, level: "review" });
    await proposeAndApprove({ ...candidate, level: "block" });
    expect(await candidates(candidate.ruleId)).toEqual([
      expect.objectContaining({ version: "v1", status: "rolled_back" }),
      expect.objectContaining({ version: "v2", status: "rolled_back" }),
      expect.objectContaining({ version: "v3", status: "active", level: "block" }),
    ]);
    const id = await dryRun(candidate);
    const rejected = await confirm(candidate, id);
    expect(rejected.status).toBe(400);
    expect(rejected.json.error.message).toContain("只可加严");
    expect(await rowState(id)).toBe("pending");
    expect(await candidates(candidate.ruleId)).toHaveLength(3);
  });

  it("并列待批提案激活时保留预留版本；旧版本不能覆盖已生效新版本", async () => {
    async function pair(candidate: Candidate) {
      const ids = await Promise.all([dryRun(candidate), dryRun(candidate)]);
      const proposals = [];
      for (const id of ids) {
        const response = await confirm(candidate, id);
        expect(response.status).toBe(200);
        const approval = (await owner.query<{ approval_id: string }>(
          "SELECT approval_id FROM approvals WHERE workspace_id=$1 AND event_id=$2",
          [workspaceId, response.json.result.data.eventId],
        )).rows[0]!;
        proposals.push(approval.approval_id);
      }
      return proposals;
    }
    const inOrder = rule();
    const firstPair = await pair(inOrder);
    expect((await request("approvals.decide", { approvalId: firstPair[0]!, gesture: "approve" }, tokens.owner)).status).toBe(200);
    expect(await candidates(inOrder.ruleId)).toEqual([
      expect.objectContaining({ id: `fr-${inOrder.ruleId.toLowerCase()}-v1-${workspaceId}`, version: "v1", status: "active" }),
      expect.objectContaining({ id: `fr-${inOrder.ruleId.toLowerCase()}-v2-${workspaceId}`, version: "v2", status: "pending_approval" }),
    ]);
    expect((await request("approvals.decide", { approvalId: firstPair[1]!, gesture: "approve" }, tokens.owner)).status).toBe(200);
    expect((await candidates(inOrder.ruleId)).filter((row) => row.status === "active")).toEqual([
      expect.objectContaining({ version: "v2" }),
    ]);
    const reversed = rule();
    const secondPair = await pair(reversed);
    expect((await request("approvals.decide", { approvalId: secondPair[1]!, gesture: "approve" }, tokens.owner)).status).toBe(200);
    expect((await request("approvals.decide", { approvalId: secondPair[0]!, gesture: "approve" }, tokens.owner)).status).toBe(400);
    expect(requestErrors.at(-1)).toContain("已过期");
    expect((await owner.query<{ status: string }>("SELECT status FROM approvals WHERE approval_id=$1", [secondPair[0]!])).rows[0]!.status).toBe("pending");
    expect((await owner.query<{ count: string }>(
      `SELECT count(*)::text FROM biz_events WHERE workspace_id=$1 AND payload->'decision'->>'action'='approval.gesture'
        AND payload->'decision'->'after'->>'approvalId'=$2`, [workspaceId, secondPair[0]!],
    )).rows[0]!.count).toBe("0");
    expect((await candidates(reversed.ruleId)).filter((row) => row.status === "active")).toEqual([
      expect.objectContaining({ version: "v2" }),
    ]);
  });

  it("并发批准同规则两个待批版本后仅最高具名版本生效", async () => {
    const candidate = rule();
    const ids = await Promise.all([dryRun(candidate), dryRun(candidate)]);
    const approvals: string[] = [];
    for (const id of ids) {
      const proposal = await confirm(candidate, id);
      expect(proposal.status).toBe(200);
      approvals.push((await owner.query<{ approval_id: string }>(
        "SELECT approval_id FROM approvals WHERE workspace_id=$1 AND event_id=$2",
        [workspaceId, proposal.json.result.data.eventId],
      )).rows[0]!.approval_id);
    }
    const responses = await Promise.all(approvals.map((approvalId) => request(
      "approvals.decide", { approvalId, gesture: "approve" }, tokens.owner,
    )));
    expect(responses.some((response) => response.status === 200)).toBe(true);
    expect(responses.every((response) => [200, 400].includes(response.status))).toBe(true);
    const rows = await candidates(candidate.ruleId);
    expect(rows.filter((row) => row.status === "active")).toEqual([
      expect.objectContaining({ id: `fr-${candidate.ruleId.toLowerCase()}-v2-${workspaceId}`, version: "v2" }),
    ]);
    expect(rows.map((row) => row.version)).toEqual(["v1", "v2"]);
  });

  it("激活失败使审批、手势及版本切换一并回滚；恢复后可批准并幂等重试", async () => {
    const candidate = rule();
    await proposeAndApprove(candidate);
    const changed = { ...candidate, level: "review" as const };
    const id = await dryRun(changed);
    const proposal = await confirm(changed, id);
    expect(proposal.status).toBe(200);
    const approvalId = (await owner.query<{ approval_id: string }>(
      "SELECT approval_id FROM approvals WHERE workspace_id=$1 AND event_id=$2",
      [workspaceId, proposal.json.result.data.eventId],
    )).rows[0]!.approval_id;
    const pendingId = (await candidates(candidate.ruleId)).find((row) => row.status === "pending_approval")!.id;
    const constraint = `activation_fail_${suffix.replaceAll("-", "")}`;
    await owner.query(`ALTER TABLE fence_rules ADD CONSTRAINT "${constraint}" CHECK (id <> '${pendingId}' OR status <> 'active')`);
    try {
      expect((await request("approvals.decide", { approvalId, gesture: "approve" }, tokens.owner)).status).toBe(500);
      expect((await owner.query<{ status: string }>("SELECT status FROM approvals WHERE approval_id=$1", [approvalId])).rows[0]!.status).toBe("pending");
      expect((await owner.query<{ status: string; approved_event_id: string | null }>(
        "SELECT status,approved_event_id FROM fence_rules WHERE id=$1", [pendingId],
      )).rows[0]).toEqual({ status: "pending_approval", approved_event_id: null });
      expect((await owner.query<{ count: string }>(
        `SELECT count(*)::text FROM biz_events WHERE workspace_id=$1 AND payload->'decision'->>'action'='approval.gesture'
          AND payload->'decision'->'after'->>'approvalId'=$2`, [workspaceId, approvalId],
      )).rows[0]!.count).toBe("0");
      expect((await candidates(candidate.ruleId)).filter((row) => row.status === "active")).toEqual([
        expect.objectContaining({ version: "v1", level: "auto" }),
      ]);
    } finally {
      await owner.query(`ALTER TABLE fence_rules DROP CONSTRAINT "${constraint}"`);
    }
    expect((await request("approvals.decide", { approvalId, gesture: "approve" }, tokens.owner)).status).toBe(200);
    const repeat = await request("approvals.decide", { approvalId, gesture: "approve" }, tokens.owner);
    expect(repeat.status).toBe(200);
    expect(repeat.json.result.data.deduped).toBe(true);
    expect((await candidates(candidate.ruleId)).filter((row) => row.status === "active")).toEqual([
      expect.objectContaining({ version: "v2", level: "review" }),
    ]);
  });

  it("不完整围栏提案不能静默批准，显式禁审批成员不能直调批准", async () => {
    const candidate = rule();
    const id = await dryRun(candidate);
    const proposal = await confirm(candidate, id);
    expect(proposal.status).toBe(200);
    const approvalId = (await owner.query<{ approval_id: string }>(
      "SELECT approval_id FROM approvals WHERE workspace_id=$1 AND event_id=$2",
      [workspaceId, proposal.json.result.data.eventId],
    )).rows[0]!.approval_id;
    expect((await request("approvals.decide", { approvalId, gesture: "approve" }, tokens.approvalDenied)).status).toBe(403);
    expect((await request("approvals.batchApprove", { approvalIds: [approvalId] }, tokens.approvalDenied)).status).toBe(403);
    expect((await request("approvals.sweep", undefined, tokens.approvalDenied)).status).toBe(403);
    expect((await owner.query<{ status: string }>("SELECT status FROM approvals WHERE approval_id=$1", [approvalId])).rows[0]!.status).toBe("pending");
    const edit = await request("approvals.decide", {
      approvalId, gesture: "edit", editedAfter: { ...candidate, level: "block" }, editKind: "correction",
    }, tokens.owner);
    expect(edit.status).toBe(400);
    expect(edit.json.error.message).toContain("重新预演");
    expect((await owner.query<{ status: string }>("SELECT status FROM approvals WHERE approval_id=$1", [approvalId])).rows[0]!.status).toBe("pending");
    const pending = (await candidates(candidate.ruleId))[0]!;
    for (const after of [
      { ruleId: candidate.ruleId },
      { ruleId: `R${++sequence}`, ruleRowId: pending.id, version: "v1", dryRunId: id },
      { ruleId: candidate.ruleId, ruleRowId: pending.id, version: "v99", dryRunId: id },
    ]) {
      const invalid = await gatewayAppend(getGatewayPool(), { tenantId, workspaceId, actor: { id: "MEM-001", type: "human" } }, {
        who: { id: "MEM-001", type: "human" },
        context: { tenant_id: tenantId, workspace_id: workspaceId, time: new Date().toISOString() },
        object: { type: "staff", id: candidate.ruleId },
        decision: { action: "fence.rule.propose", after }, rule_impact: [],
      });
      const invalidId = `apr-${invalid.eventId.toLowerCase()}`;
      await owner.query(
        `INSERT INTO approvals(approval_id,tenant_id,workspace_id,event_id,channel,status,snapshot)
          VALUES($1,$2,$3,$4,'inapp','pending',$5)`,
        [invalidId, tenantId, workspaceId, invalid.eventId, JSON.stringify({ high_risk: true })],
      );
      const response = await request("approvals.decide", { approvalId: invalidId, gesture: "approve" }, tokens.owner);
      expect(response.status).toBe(400);
      expect(response.json.error.message).toMatch(/缺少|未绑定/);
      expect((await owner.query<{ status: string }>("SELECT status FROM approvals WHERE approval_id=$1", [invalidId])).rows[0]!.status).toBe("pending");
    }
    expect((await candidates(candidate.ruleId))[0]!.status).toBe("pending_approval");
  });

  it("IM 同权回调自动激活；已验签回调不能替被禁审批成员放行", async () => {
    const candidate = rule();
    const id = await dryRun(candidate);
    const proposed = await confirm(candidate, id);
    const approvalId = (await owner.query<{ approval_id: string }>(
      "SELECT approval_id FROM approvals WHERE workspace_id=$1 AND event_id=$2", [workspaceId, proposed.json.result.data.eventId],
    )).rows[0]!.approval_id;
    const previousSecret = process.env.IM_CHANNEL_SECRET_DINGTALK;
    try {
      const denied = { channel: "dingtalk", approvalId, operatorOpenId: `denied-${suffix}`, conversationId: "fence-regression", gesture: "approve" };
      const secret = "mock-fence-channel-secret-only-for-regression";
      process.env.IM_CHANNEL_SECRET_DINGTALK = secret;
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac("sha256", secret).update(`${timestamp}.${stableStringify(denied)}`).digest("hex");
      const blocked = await request("im.callback", denied, tokens.owner, { "x-channel-timestamp": timestamp, "x-channel-signature": signature });
      expect(blocked.status).toBe(403);
      expect((await owner.query<{ status: string }>("SELECT status FROM approvals WHERE approval_id=$1", [approvalId])).rows[0]!.status).toBe("pending");
      delete process.env.IM_CHANNEL_SECRET_DINGTALK;
      const own = { ...denied, operatorOpenId: `owner-${suffix}` };
      const accepted = await request("im.callback", own, tokens.owner);
      expect(accepted.status).toBe(200);
      expect((await candidates(candidate.ruleId))[0]!.status).toBe("active");
      expect((await request("im.callback", own, tokens.owner)).json.result.data.deduped).toBe(true);
    } finally {
      if (previousSecret === undefined) delete process.env.IM_CHANNEL_SECRET_DINGTALK;
      else process.env.IM_CHANNEL_SECRET_DINGTALK = previousSecret;
    }
  });

  it("直接服务 decide 无需 HTTP 后置钩子即可激活；普通业务编辑保持原语义", async () => {
    const candidate = rule();
    const id = await dryRun(candidate);
    const proposed = await confirm(candidate, id);
    const approvalId = (await owner.query<{ approval_id: string }>(
      "SELECT approval_id FROM approvals WHERE workspace_id=$1 AND event_id=$2", [workspaceId, proposed.json.result.data.eventId],
    )).rows[0]!.approval_id;
    await expect(decideApproval(getAppPool(), getGatewayPool(), { tenantId, workspaceId },
      { memberNo: "MEM-005", role: "owner" }, approvalId, { type: "approve" })).rejects.toThrow(/approval.decide/);
    for (const memberNo of ["MEM-006", "MEM-007", "MEM-NOT-FOUND"]) {
      await expect(decideApproval(getAppPool(), getGatewayPool(), { tenantId, workspaceId },
        { memberNo, role: "owner" }, approvalId, { type: "approve" })).rejects.toThrow(/approval.decide/);
    }
    const approved = await decideApproval(getAppPool(), getGatewayPool(), { tenantId, workspaceId },
      { memberNo: "MEM-001", role: "owner" }, approvalId, { type: "approve" });
    expect(approved.activatedRuleRowId).toBe((await candidates(candidate.ruleId))[0]!.id);
    expect((await candidates(candidate.ruleId))[0]!.status).toBe("active");
    const event = await gatewayAppend(getGatewayPool(), { tenantId, workspaceId, actor: { id: "MEM-001", type: "human" } }, {
      who: { id: "MEM-001", type: "human" },
      context: { tenant_id: tenantId, workspace_id: workspaceId, time: new Date().toISOString() },
      object: { type: "fence_probe", id: "ordinary-edit" }, decision: { action: "fence_probe.adjust", after: { value: 1 } }, rule_impact: [],
    });
    const ordinaryId = `apr-${event.eventId.toLowerCase()}`;
    await owner.query(
      `INSERT INTO approvals(approval_id,tenant_id,workspace_id,event_id,channel,status,snapshot)
        VALUES($1,$2,$3,$4,'inapp','pending',$5)`,
      [ordinaryId, tenantId, workspaceId, event.eventId, JSON.stringify({ after: { value: 1 } })],
    );
    const edited = await decideApproval(getAppPool(), getGatewayPool(), { tenantId, workspaceId },
      { memberNo: "MEM-001", role: "owner" }, ordinaryId, { type: "edit", editedAfter: { value: 2 }, editKind: "correction" });
    expect(edited.status).toBe("edited");
    expect(edited.activatedRuleRowId).toBeUndefined();
  });

  it("同事件跨通道并发批准不死锁且只产生一次手势与激活", async () => {
    const candidate = rule();
    const id = await dryRun(candidate);
    const proposal = await confirm(candidate, id);
    expect(proposal.status).toBe(200);
    const first = (await owner.query<{ approval_id: string; snapshot: unknown }>(
      "SELECT approval_id,snapshot FROM approvals WHERE workspace_id=$1 AND event_id=$2",
      [workspaceId, proposal.json.result.data.eventId],
    )).rows[0]!;
    const secondId = `${first.approval_id}-dingtalk`;
    await owner.query(
      `INSERT INTO approvals(approval_id,tenant_id,workspace_id,event_id,channel,status,snapshot)
        VALUES($1,$2,$3,$4,'dingtalk','pending',$5)`,
      [secondId, tenantId, workspaceId, proposal.json.result.data.eventId, JSON.stringify(first.snapshot)],
    );
    const results = await Promise.all([first.approval_id, secondId].map((approvalId) => request(
      "approvals.decide", { approvalId, gesture: "approve" }, tokens.owner,
    )));
    expect(results.map((result) => result.status)).toEqual([200, 200]);
    expect(results.map((result) => result.json.result.data.deduped).sort()).toEqual([false, true]);
    expect((await owner.query<{ count: string }>(
      `SELECT count(*)::text FROM biz_events WHERE workspace_id=$1 AND payload->'decision'->>'action'='approval.gesture'
        AND payload->'decision'->'after'->>'approvalId'=ANY($2::text[])`,
      [workspaceId, [first.approval_id, secondId]],
    )).rows[0]!.count).toBe("1");
    expect((await candidates(candidate.ruleId)).filter((row) => row.status === "active")).toHaveLength(1);
  });

  it("候选在回放后被编辑或旧报告没有快照时，必须重跑预演", async () => {
    const candidate = rule("review");
    const changedId = await dryRun(candidate);
    const changed = await confirm({ ...candidate, level: "block" }, changedId);
    expect(changed.status).toBe(400);
    expect(changed.json.error.message).toContain("重新预演");
    expect(await rowState(changedId)).toBe("pending");
    const legacyId = await dryRun(candidate);
    await owner.query("UPDATE fence_dry_runs SET report=report-'candidateRules'-'candidateDefaultLevel' WHERE id=$1 AND workspace_id=$2", [legacyId, workspaceId]);
    expect((await confirm(candidate, legacyId)).status).toBe(400);
    expect(await rowState(legacyId)).toBe("pending");
    expect(await candidates(candidate.ruleId)).toHaveLength(0);
  });

  it("真实已批准的提案不得换绑到另一个候选行或预演", async () => {
    const approved = await proposeAndApprove(rule());
    const gesture = (await owner.query<{ event_id: string }>(
      `SELECT event_id FROM biz_events WHERE workspace_id=$1
        AND payload->'decision'->>'action'='approval.gesture'
        AND payload->'decision'->'after'->>'approvalId'=$2 ORDER BY seq DESC LIMIT 1`,
      [workspaceId, approved.approvalId],
    )).rows[0]!.event_id;
    const other = rule();
    const otherId = await dryRun(other);
    expect((await confirm(other, otherId)).status).toBe(200);
    const pending = (await candidates(other.ruleId))[0]!;
    await expect(activateRuleVersion(getAppPool(), { tenantId, workspaceId }, {
      ruleRowId: pending.id, dryRunId: otherId, approvalEventId: gesture,
    })).rejects.toThrow(/未绑定/);
    expect((await candidates(other.ruleId))[0]!.status).toBe("pending_approval");
    await expect(activateRuleVersion(getAppPool(), { tenantId, workspaceId }, {
      ruleRowId: approved.event.ruleRowId, dryRunId: otherId, approvalEventId: gesture,
    })).rejects.toThrow(/未绑定/);
  });

  it("匿名、只读、显式禁写与另一个工作区均不能确认本工作区预演", async () => {
    const candidate = rule();
    const id = await dryRun(candidate);
    expect((await request("fence.confirmDryRun", { dryRunId: id, rule: candidate })).status).toBe(401);
    expect((await confirm(candidate, id, tokens.readonly)).status).toBe(403);
    expect((await confirm(candidate, id, tokens.denied)).status).toBe(403);
    expect((await confirm(candidate, id, tokens.guardrailDenied)).status).toBe(403);
    expect((await request("fence.dryRun", candidate, tokens.guardrailDenied)).status).toBe(403);
    expect((await confirm(candidate, id, tokens.foreign)).status).toBe(400);
    expect(await rowState(id)).toBe("pending");
    expect(await candidates(candidate.ruleId)).toHaveLength(0);
  });

  it("相同预演并发确认恰好一次；不同预演并发同规则不复用版本", async () => {
    const candidate = rule();
    const sameId = await dryRun(candidate);
    const same = await Promise.all([confirm(candidate, sameId), confirm(candidate, sameId)]);
    expect(same.map((r) => r.status).sort()).toEqual([200, 400]);
    expect(await candidates(candidate.ruleId)).toHaveLength(1);
    const independent = rule();
    // 请求可以落在同一毫秒；预演身份不能依赖时间戳分辨率来避免主键冲突。
    const fixedClock = vi.spyOn(Date, "now").mockReturnValue(1792810000000);
    let ids: string[];
    try {
      ids = await Promise.all([dryRun(independent), dryRun(independent)]);
    } finally {
      fixedClock.mockRestore();
    }
    expect(ids[0]).not.toBe(ids[1]);
    const distinct = await Promise.all(ids.map((id) => confirm(independent, id)));
    expect(distinct.map((r) => r.status)).toEqual([200, 200]);
    expect((await candidates(independent.ruleId)).map((row) => row.version)).toEqual(["v1", "v2"]);
  });

  it("无效输入不写库；候选插入失败回滚确认，恢复后可重试", async () => {
    const candidate = rule();
    const id = await dryRun(candidate);
    for (const invalid of [
      { ...candidate, ruleId: "bad" }, { ...candidate, name: "" },
      { ...candidate, actions: [] }, { ...candidate, objectTypes: [""] }, { ...candidate, when: "" },
    ]) expect((await request("fence.confirmDryRun", { dryRunId: id, rule: invalid }, tokens.owner)).status).toBe(400);
    expect(await rowState(id)).toBe("pending");
    const constraint = `fence_fail_${suffix.replaceAll("-", "")}`;
    await owner.query(`ALTER TABLE fence_rules ADD CONSTRAINT "${constraint}" CHECK (workspace_id <> '${workspaceId}' OR rule_id <> '${candidate.ruleId}')`);
    try {
      expect((await confirm(candidate, id)).status).toBe(500);
      expect(await rowState(id)).toBe("pending");
      expect(await candidates(candidate.ruleId)).toHaveLength(0);
    } finally {
      await owner.query(`ALTER TABLE fence_rules DROP CONSTRAINT "${constraint}"`);
    }
    expect((await confirm(candidate, id)).status).toBe(200);
    expect(await rowState(id)).toBe("confirmed");
    expect(await candidates(candidate.ruleId)).toHaveLength(1);
  });
});
