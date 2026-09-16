/**
 * 工作区活动 Bundle 的唯一运行时解析入口。
 *
 * 数据库通过 RLS 只提供“哪个安装处于 active”的事实；磁盘清单还必须通过
 * 契约、兼容性、摘要以及生产签名校验。指针冲突、多个活动安装或投影异常
 * 一律失败关闭，调用方不得回退到示例行业。
 */
import { loadBundleUiProjection, type BundleUiProjection } from "@workloom/base/bundles";
import { serviceTx } from "./events.js";

export type ActiveBundleState =
  | "ready"
  | "not-installed"
  | "bundle-mismatch"
  | "projection-invalid";

export interface WorkspaceBundleFacts {
  workspaceBundleId: string | null;
  activeInstalls: Array<{ id: string; bundleId: string }>;
}

export interface ActiveBundleResolution {
  state: ActiveBundleState;
  bundleId: string | null;
  installId: string | null;
  projection: BundleUiProjection | null;
  /** 仅用于服务端诊断，禁止直接回显给客户端。 */
  reason: string;
}

type ProjectionLoader = (bundleId: string) => BundleUiProjection;

type ProjectionSource = NonNullable<BundleUiProjection["sources"]>[number];

const SHA256_HEX = /^[a-f0-9]{64}$/;

function validDigest(value: string | null | undefined): value is string {
  return typeof value === "string" && SHA256_HEX.test(value);
}

function populatedString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * 对已经完成磁盘验签的投影再做纯结构闭包校验。
 *
 * 这里不重新读取清单或信任环，只证明当前返回值没有在组合过程中丢失、替换或
 * 伪造来源：每条依赖父链都必须留在来源集合内并最终收敛到唯一主包；主包镜像
 * 必须与投影顶层身份完全一致；导航权限全集必须可由实际槽位唯一重建。
 */
export function validateProjectionStructure(
  projection: BundleUiProjection,
  activeBundleId: string,
): string | null {
  if (projection.primaryBundleId !== activeBundleId || projection.bundleId !== activeBundleId) {
    return "投影主包身份与活动装配不一致";
  }
  if (!populatedString(projection.bundleName) || !populatedString(projection.bundleVersion)) {
    return "投影主包名称或版本为空";
  }
  if (!validDigest(projection.integrityDigest)) return "投影主包缺少有效完整性摘要";
  if (projection.bundleStatus !== "candidate" && projection.bundleStatus !== "stable") {
    return "投影主包未处于可运行状态";
  }
  if (projection.bundleStatus === "stable" && !populatedString(projection.signatureKeyId)) {
    return "稳定主包缺少签名密钥标识";
  }

  if (!Array.isArray(projection.sources) || projection.sources.length === 0) {
    return "投影缺少完整组合来源";
  }
  if (!Array.isArray(projection.navigationPermissionUniverse)) {
    return "投影缺少导航权限全集";
  }

  const sourceById = new Map<string, ProjectionSource>();
  for (const source of projection.sources) {
    if (!populatedString(source.bundleId) || sourceById.has(source.bundleId)) {
      return "投影来源标识为空或重复";
    }
    if (!populatedString(source.bundleName) || !populatedString(source.bundleVersion)) {
      return `投影来源「${source.bundleId}」名称或版本为空`;
    }
    if (!validDigest(source.integrityDigest)) return `投影来源「${source.bundleId}」摘要无效`;
    if (source.bundleStatus !== "candidate" && source.bundleStatus !== "stable") {
      return `投影来源「${source.bundleId}」未处于可运行状态`;
    }
    if (source.bundleStatus === "stable" && !populatedString(source.signatureKeyId)) {
      return `稳定投影来源「${source.bundleId}」缺少签名密钥标识`;
    }
    sourceById.set(source.bundleId, source);
  }

  const primarySources = projection.sources.filter((source) => source.role === "primary");
  if (primarySources.length !== 1) return "投影必须且只能包含一个主来源";
  const primary = primarySources[0]!;
  if (primary.bundleId !== activeBundleId || primary.parentBundleId !== null) {
    return "投影主来源身份或父级无效";
  }
  if (
    primary.bundleName !== projection.bundleName
    || primary.bundleVersion !== projection.bundleVersion
    || primary.bundleStatus !== projection.bundleStatus
    || primary.integrityDigest !== projection.integrityDigest
    || primary.signatureKeyId !== projection.signatureKeyId
  ) {
    return "投影主来源与顶层主包镜像不一致";
  }
  if (
    projection.bundleStatus === "stable"
    && projection.sources.some((source) => source.bundleStatus !== "stable")
  ) {
    return "稳定主包不能组合未稳定来源";
  }

  for (const source of projection.sources) {
    if (source.role === "primary") continue;
    if (source.role !== "dependency" || !populatedString(source.parentBundleId)) {
      return `依赖来源「${source.bundleId}」缺少有效父级`;
    }
    if (source.parentBundleId === source.bundleId || !sourceById.has(source.parentBundleId)) {
      return `依赖来源「${source.bundleId}」父级不在组合闭包内`;
    }

    const visited = new Set<string>();
    let cursor: ProjectionSource = source;
    while (cursor.bundleId !== activeBundleId) {
      if (visited.has(cursor.bundleId)) return `依赖来源「${source.bundleId}」父链形成循环`;
      visited.add(cursor.bundleId);
      if (!populatedString(cursor.parentBundleId)) {
        return `依赖来源「${source.bundleId}」父链未收敛到主包`;
      }
      const parent = sourceById.get(cursor.parentBundleId);
      if (!parent) return `依赖来源「${source.bundleId}」父链越出组合闭包`;
      cursor = parent;
    }
  }

  const slots = projection.ui?.navigation?.slots;
  if (!Array.isArray(slots)) return "投影缺少导航槽位集合";
  if (slots.some((slot) => !Array.isArray(slot.permissions)
    || slot.permissions.some((permission) => !populatedString(permission)))) {
    return "投影导航槽位包含无效权限声明";
  }
  const expectedPermissions = [...new Set(slots.flatMap((slot) => (
    slot.permissions
  )))].sort();
  if (
    projection.navigationPermissionUniverse.some((permission) => !populatedString(permission))
    || projection.navigationPermissionUniverse.length !== expectedPermissions.length
    || projection.navigationPermissionUniverse.some((permission, index) => permission !== expectedPermissions[index])
  ) {
    return "导航权限全集无法由投影槽位精确重建";
  }
  return null;
}

export function bindVerifiedActiveBundle(
  facts: WorkspaceBundleFacts,
  loadProjection: ProjectionLoader = loadBundleUiProjection,
): ActiveBundleResolution {
  if (facts.activeInstalls.length !== 1) {
    return {
      state: "not-installed",
      bundleId: null,
      installId: null,
      projection: null,
      reason: facts.activeInstalls.length === 0 ? "工作区没有生效装配" : "工作区存在多个生效装配",
    };
  }
  const active = facts.activeInstalls[0]!;
  if (facts.workspaceBundleId && facts.workspaceBundleId !== active.bundleId) {
    return {
      state: "bundle-mismatch",
      bundleId: active.bundleId,
      installId: active.id,
      projection: null,
      reason: "工作区指针与生效装配不一致",
    };
  }
  try {
    const projection = loadProjection(active.bundleId);
    const structureIssue = validateProjectionStructure(projection, active.bundleId);
    if (structureIssue) {
      return {
        state: "projection-invalid",
        bundleId: active.bundleId,
        installId: active.id,
        projection: null,
        reason: structureIssue,
      };
    }
    return {
      state: "ready",
      bundleId: active.bundleId,
      installId: active.id,
      projection,
      reason: "活动行业包投影已验证",
    };
  } catch (error) {
    return {
      state: "projection-invalid",
      bundleId: active.bundleId,
      installId: active.id,
      projection: null,
      reason: error instanceof Error ? error.message : "行业投影校验失败",
    };
  }
}

export async function resolveWorkspaceActiveBundle(workspaceId: string): Promise<ActiveBundleResolution> {
  const facts = await serviceTx(workspaceId, async (client) => {
    const workspace = await client.query<{ bundle_id: string | null }>(
      `SELECT bundle_id FROM workspaces WHERE id=$1`,
      [workspaceId],
    );
    const active = await client.query<{ id: string; bundle_id: string }>(
      `SELECT id, bundle_id FROM bundle_installs
       WHERE workspace_id=$1 AND status='active' ORDER BY installed_at DESC`,
      [workspaceId],
    );
    return {
      workspaceBundleId: workspace.rows[0]?.bundle_id ?? null,
      activeInstalls: active.rows.map((row) => ({ id: row.id, bundleId: row.bundle_id })),
    } satisfies WorkspaceBundleFacts;
  });
  return bindVerifiedActiveBundle(facts);
}
