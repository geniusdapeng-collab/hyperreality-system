/**
 * asset-cms · 素材服务（fusion-design §5 video_assets）
 *
 * 素材五类：商品图 product_image / 参考图 reference_image / 定妆照 portrait / 片段 clip / 成片 final_cut
 * 纪律：
 *  - 一切写入经 workdata 安全网关落五元事件（D16：业务行与事件同一 COMMIT）
 *  - sha256 幂等去重（L1.4 同源：重复注册返回已有行，不重复写事件）
 *  - 版本链：chain_id 为根（v1 的 id），parent_id 指上一版本；versionChain 即审批/回溯锚点
 *  - 语义检索走 workdata recall 的接口预留（AssetSemanticSearcher seam，pgvector 接入点）
 */
import type pg from "pg";
import { gatewayAppendOnClient } from "../workdata/gateway.js";

interface Scope { tenantId: string; workspaceId: string }

export const ASSET_KINDS = ["product_image", "reference_image", "portrait", "clip", "final_cut"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export const LICENSE_RISKS = ["none", "low", "high", "unknown"] as const;
export type LicenseRisk = (typeof LICENSE_RISKS)[number];

export interface AssetRow {
  id: string;
  workspace_id: string;
  project_id: string | null;
  chain_id: string;
  kind: AssetKind;
  version: number;
  parent_id: string | null;
  source_url: string;
  provenance: Record<string, unknown>;
  license_risk: LicenseRisk;
  hero_image_id: string | null;
  sha256: string;
  meta: Record<string, unknown>;
  publish_at: string | null;
  status: string;
  created_by: string;
  created_at: string;
}

export class AssetError extends Error {
  constructor(
    public readonly code: "NOT_FOUND" | "BAD_KIND" | "BAD_LICENSE_RISK" | "PARENT_KIND_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "AssetError";
  }
}

/** 事务内事件留痕（D16：调用方持有事务，与素材行同一 COMMIT） */
async function emitInTx(
  client: pg.PoolClient,
  scope: Scope,
  by: string,
  objectType: string,
  objectId: string,
  decision: Record<string, unknown>,
): Promise<string> {
  const r = await gatewayAppendOnClient(client, {
    tenantId: scope.tenantId, workspaceId: scope.workspaceId,
    actor: { id: by, type: "system" },
  }, {
    who: { type: "system", id: by },
    context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
    object: { type: objectType, id: objectId },
    decision: decision as never,
    rule_impact: [],
  });
  return r.eventId;
}

export interface RegisterAssetInput {
  id: string;
  projectId?: string;
  kind: AssetKind;
  sourceUrl: string;
  /** 来源：生成/上传/抓取 + 上游事件链（归因） */
  provenance?: Record<string, unknown>;
  licenseRisk?: LicenseRisk;
  heroImageId?: string;
  sha256: string;
  /** 传 parentId = 注册该素材的下一版本（版本链） */
  parentId?: string;
  /** 成片扩展元数据（platforms/durationSeconds/prdId/shotPackageVersion，cms.ts 使用） */
  meta?: Record<string, unknown>;
  /** 初始状态（素材默认 registered；成片由 cms 置 draft） */
  status?: string;
  by: string;
}

/**
 * 注册素材（含版本链与 sha256 幂等去重）
 *  - 同 (workspace_id, sha256) 已存在 → 返回已有行 deduped=true，不写行不写事件（L1.4 同源）
 *  - parentId 存在 → version=parent.version+1，chain_id 继承；否则 v1 开新链（chain_id=自身 id）
 */
export async function register(
  app: pg.Pool,
  gateway: pg.Pool,
  scope: Scope,
  input: RegisterAssetInput,
): Promise<{ asset: AssetRow; deduped: boolean }> {
  if (!ASSET_KINDS.includes(input.kind)) {
    throw new AssetError("BAD_KIND", `非法素材类型「${input.kind}」（${ASSET_KINDS.join("/")}）`);
  }
  const licenseRisk = input.licenseRisk ?? "unknown";
  if (!LICENSE_RISKS.includes(licenseRisk)) {
    throw new AssetError("BAD_LICENSE_RISK", `非法授权风险级别「${licenseRisk}」`);
  }
  const client = await app.connect();
  try {
    // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]); // D16：append_event_insert 双 GUC 校验要求

    // sha256 幂等去重：同内容重复注册 → 返回已有行（不重复写事件）
    const dup = await client.query<AssetRow>(
      `SELECT * FROM video_assets WHERE workspace_id=$1 AND sha256=$2`,
      [scope.workspaceId, input.sha256],
    );
    if (dup.rows[0]) {
      await client.query("COMMIT");
      return { asset: dup.rows[0], deduped: true };
    }

    // 版本链定位
    let version = 1;
    let chainId = input.id;
    if (input.parentId) {
      const parent = await client.query<AssetRow>(
        `SELECT * FROM video_assets WHERE workspace_id=$1 AND id=$2`,
        [scope.workspaceId, input.parentId],
      );
      const p = parent.rows[0];
      if (!p) throw new AssetError("NOT_FOUND", `父版本素材 ${input.parentId} 不存在`);
      if (p.kind !== input.kind) {
        throw new AssetError("PARENT_KIND_MISMATCH", `版本链类型必须一致：parent=${p.kind} vs new=${input.kind}`);
      }
      version = p.version + 1;
      chainId = p.chain_id;
    }

    const ins = await client.query<AssetRow>(
      `INSERT INTO video_assets
         (id, workspace_id, project_id, chain_id, kind, version, parent_id,
          source_url, provenance, license_risk, hero_image_id, sha256, meta, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        input.id, scope.workspaceId, input.projectId ?? null, chainId, input.kind, version,
        input.parentId ?? null, input.sourceUrl, JSON.stringify(input.provenance ?? {}),
        licenseRisk, input.heroImageId ?? null, input.sha256,
        JSON.stringify(input.meta ?? {}), input.status ?? "registered", input.by,
      ],
    );
    // D16（#1/A）：素材行与事件同一事务同一 COMMIT
    await emitInTx(client, scope, input.by, "asset", input.id, {
      action: input.parentId ? "asset.version" : "asset.register",
      after: {
        assetId: input.id, kind: input.kind, version, chainId,
        parentId: input.parentId ?? null, sha256: input.sha256, licenseRisk,
      },
      basis: input.parentId
        ? [`版本链推进：${input.parentId} → v${version}`]
        : ["素材注册（sha256 幂等去重，UNIQUE(workspace_id,sha256) 双保险）"],
    });
    await client.query("COMMIT");
    return { asset: ins.rows[0]!, deduped: false };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** 版本链：按 chain_id 取全部版本（v1→vn 有序；版本即审批/回溯对象） */
export async function versionChain(app: pg.Pool, scope: Scope, assetId: string): Promise<AssetRow[]> {
  const client = await app.connect();
  try {
    // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    const cur = await client.query<AssetRow>(
      `SELECT * FROM video_assets WHERE workspace_id=$1 AND id=$2`,
      [scope.workspaceId, assetId],
    );
    const row = cur.rows[0];
    if (!row) throw new AssetError("NOT_FOUND", `素材 ${assetId} 不存在`);
    const chain = await client.query<AssetRow>(
      `SELECT * FROM video_assets WHERE workspace_id=$1 AND chain_id=$2 ORDER BY version ASC`,
      [scope.workspaceId, row.chain_id],
    );
    await client.query("COMMIT");
    return chain.rows;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/* ---------- 检索（结构化 + 语义检索接口预留） ---------- */

/**
 * 语义检索 seam：走 workdata recall 的 pgvector 语义检索（fusion-design §5 预留）。
 * 生产实现由 video-studio 适配层注入（embedding → 相似素材 id 列表）；
 * 未注入时 search 退化为结构化过滤，禁止伪造语义结果（同 E1.6 降级纪律）。
 */
export interface AssetSemanticSearcher {
  search(query: string, scope: Scope): Promise<string[]>;
}

export interface AssetFilter {
  kind?: AssetKind;
  projectId?: string;
  /** 文本片段（source_url / meta 包含；演示规模 ILIKE，搜索引擎进停车场） */
  text?: string;
}

export async function search(
  app: pg.Pool,
  scope: Scope,
  filter: AssetFilter,
  opts: { limit?: number; semantic?: AssetSemanticSearcher } = {},
): Promise<AssetRow[]> {
  const limit = Math.min(opts.limit ?? 50, 200);
  // 语义检索（预留）：注入 searcher 且带文本 → 先取向量近邻 id 集，再回表
  const semanticIds = opts.semantic && filter.text
    ? await opts.semantic.search(filter.text, scope)
    : null;

  const clauses: string[] = ["workspace_id = $1"];
  const params: unknown[] = [scope.workspaceId];
  const add = (clause: string, value: unknown) => {
    params.push(value);
    clauses.push(clause.replace("?", `$${params.length}`));
  };
  if (filter.kind) add(`kind = ?`, filter.kind);
  if (filter.projectId) add(`project_id = ?`, filter.projectId);
  if (semanticIds) {
    if (semanticIds.length === 0) return []; // 语义检索空命中 → 空（越权/无结果返回空，L7.1 同源）
    add(`id = ANY(?::text[])`, semanticIds);
  } else if (filter.text) {
    // 两占位（source_url + meta），参数化双保险
    params.push(filter.text, filter.text);
    clauses.push(
      `(source_url ILIKE '%' || $${params.length - 1}::text || '%' OR meta::text ILIKE '%' || $${params.length}::text || '%')`,
    );
  }

  const client = await app.connect();
  try {
    // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    const r = await client.query<AssetRow>(
      `SELECT * FROM video_assets WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT ${limit}`,
      params,
    );
    await client.query("COMMIT");
    return r.rows;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
