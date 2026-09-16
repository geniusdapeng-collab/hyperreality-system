/**
 * C 端工作区路由只接受服务端可信配置。
 *
 * - 单租户部署：SERVICE_C_WORKSPACE_ID
 * - 多站点部署：SERVICE_C_WORKSPACE_MAP JSON + 前端公开 workspaceKey
 *
 * workspaceKey 只是公开站点标识，真正的 workspaceId 必须来自服务端映射；
 * 未配置、映射缺失或格式错误时一律 fail closed，禁止猜测数据库中的工作区。
 */

export class ServiceWorkspaceRoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceWorkspaceRoutingError";
  }
}

export interface ServiceWorkspaceRoutingInput {
  fixedWorkspaceId?: string;
  workspaceMap?: string;
  workspaceKey?: string;
}

function clean(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result ? result : undefined;
}

export function selectServiceWorkspaceId(input: ServiceWorkspaceRoutingInput): string {
  const fixedWorkspaceId = clean(input.fixedWorkspaceId);
  if (fixedWorkspaceId) return fixedWorkspaceId;

  const workspaceKey = clean(input.workspaceKey);
  const rawMap = clean(input.workspaceMap);
  if (!rawMap) {
    throw new ServiceWorkspaceRoutingError(
      "C 端工作区未配置，请设置 SERVICE_C_WORKSPACE_ID 或 SERVICE_C_WORKSPACE_MAP",
    );
  }
  if (!workspaceKey) {
    throw new ServiceWorkspaceRoutingError("C 端站点缺少可信 workspaceKey 映射");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawMap);
  } catch {
    throw new ServiceWorkspaceRoutingError("SERVICE_C_WORKSPACE_MAP 不是有效 JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ServiceWorkspaceRoutingError("SERVICE_C_WORKSPACE_MAP 必须是对象映射");
  }

  const rawMapped = (parsed as Record<string, unknown>)[workspaceKey];
  const mapped = typeof rawMapped === "string" ? clean(rawMapped) : undefined;
  if (!mapped) {
    throw new ServiceWorkspaceRoutingError(`C 端站点 ${workspaceKey} 未配置工作区映射`);
  }
  return mapped;
}
