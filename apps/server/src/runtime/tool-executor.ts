/**
 * 部署层 ToolExecutor 注入 seam（多桥注册表版本，GR-15）。
 *
 * 背景：`runQuest` 已预留 `input.toolExecutor`，但宿主原本只有**单模块**注入口
 * （`WORKLOOM_TOOL_EXECUTOR_MODULE`）——go-growth/ai-video 合计 5+ 个桥适配器
 * （visual/subtitle/bgm/post/color-bridge）只能挂一个，其余写工具全部落
 * `executeDeclaredTool` 兜底（真实数据态 → `connector-required` + 无回执 → 线程 failed）。
 *
 * 现在的口径：
 *  - `WORKLOOM_TOOL_EXECUTOR_MODULES`：逗号/换行分隔的**多桥规格表**（旧单变量仍兼容，排在首位）；
 *    单个规格形如 `<模块绝对路径>[::<工厂名>][::<工具名模式1|模式2>][::<端点>]`；
 *    （分隔符用 `::` 而不是 `#`：Node `--env-file` 会把 `#` 当行内注释截断，规格串会静默丢段。）
 *  - 工厂调用两种形态：具名工厂（通常是桥适配器）→ 收 `BridgeFactoryConfig`
 *    （baseUrl/token/tenantId/timeoutMs）；缺省工厂 `createToolExecutorForScope` / `createToolExecutor`
 *    → 收 `{ tenantId, workspaceId }`（与既有契约一致）；
 *  - 工具名路由：按规格声明的模式（支持 `前缀.*` 通配）先到先得；无模式的模块是**兜底桥**（仅第一个生效）；
 *  - 没有任何桥覆盖的工具 → 返回 `connector-required`（synced=false，走 E3.7「未核实」；
 *    绝不伪造成功回执），并由 `describeToolCoverage()` 供派遣前提示；
 *  - 导入失败/工厂抛错 → 该桥跳过并落服务端日志（fail-closed，不影响其它桥）。
 */
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface DeploymentToolResult {
  result: Record<string, unknown>;
  receipt: { synced: boolean; snapshot_uri?: string; verified_at?: string; mode?: "simulated" | "real"; error?: string };
}

export type DeploymentToolExecutor = (
  name: string,
  params: Record<string, unknown>,
) => Promise<DeploymentToolResult>;

type Scope = { tenantId: string; workspaceId: string };

/** 桥适配器工厂的入参（秘密只从环境来，不落文件、不打日志） */
export interface BridgeFactoryConfig {
  baseUrl: string;
  token: string;
  tenantId: string;
  timeoutMs: number;
  /** 规格第三段解析结果（工具名模式），供适配器自检 */
  patterns: string[];
}

interface ModuleShape {
  createToolExecutorForScope?: (scope?: Partial<Scope>) => DeploymentToolExecutor | undefined;
  createToolExecutor?: () => DeploymentToolExecutor | undefined;
  TOOL_PATTERNS?: unknown;
  toolPatterns?: unknown;
  /** 老契约：模块自报覆盖（可选） */
  supportsTool?: unknown;
  [key: string]: unknown;
}

interface BridgeSpec {
  modulePath: string;
  factoryName?: string;
  patterns: string[];
  /** 第④段：本桥专用端点（多工位各占端口时使用）；缺省回落 WORKLOOM_BRIDGE_BASE_URL */
  baseUrlOverride?: string;
}

interface LoadedBridge {
  modulePath: string;
  patterns: string[];
  wildcard: boolean;
  executor: DeploymentToolExecutor;
}

/** 桥缓存：按「env 规格 + 作用域」分桶（作用域进键是因为适配器在构造期绑定 tenantId） */
const bridgeCache = new Map<string, LoadedBridge[]>();

/**
 * 规格解析：`<path>[::<factory>][::<pattern|pattern>][::<baseUrl>]`（`#` 旧写法仍兼容）。
 * 用 `::` 是因为 Node `--env-file`/多数 dotenv 实现会把 `#` 之后当注释吃掉。
 */
export function parseBridgeSpecs(raw: string): BridgeSpec[] {
  return raw
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const parts = entry.includes("::") ? entry.split("::") : entry.split("#");
      const [modulePath = "", factoryName, patternPart, urlPart] = parts;
      return {
        modulePath: modulePath.trim(),
        ...(factoryName?.trim() ? { factoryName: factoryName.trim() } : {}),
        patterns: (patternPart ?? "").split("|").map((p) => p.trim()).filter(Boolean),
        ...(urlPart?.trim() ? { baseUrlOverride: urlPart.trim() } : {}),
      };
    })
    .filter((spec) => spec.modulePath.length > 0);
}

function specEnv(): string {
  const list = (process.env.WORKLOOM_TOOL_EXECUTOR_MODULES ?? "").trim();
  const legacy = (process.env.WORKLOOM_TOOL_EXECUTOR_MODULE ?? "").trim();
  return [legacy, list].filter(Boolean).join(",");
}

/**
 * 工位 token 解析顺序（秘密不进 .env 文件）：
 * ① `WORKLOOM_BRIDGE_TOKEN`（进程环境，由部署方注入）；
 * ② `WORKLOOM_BRIDGE_TOKEN_FILE` 指定文件；
 * ③ 本机工位标准位置（视觉工位安装目录下的 token 文件）。
 * 都取不到 → 空串（桥工厂按 fail-closed 处理：不装配该桥，写步骤走「未核实」语义）。
 */
function resolveBridgeToken(): string {
  const direct = (process.env.WORKLOOM_BRIDGE_TOKEN ?? "").trim();
  if (direct) return direct;
  const candidates = [
    (process.env.WORKLOOM_BRIDGE_TOKEN_FILE ?? "").trim(),
    join(homedir(), "Library", "Application Support", "WorkLoomVisualBridge", "token"),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      const value = readFileSync(file, "utf8").trim();
      if (value) return value;
    } catch {
      /* 文件不存在/不可读 → 继续找下一个候选 */
    }
  }
  return "";
}

/** 工具名模式匹配：精确名或 `前缀.*` 通配 */
export function toolMatchesPattern(tool: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) return tool.startsWith(pattern.slice(0, -1));
  return tool === pattern;
}

function patternsFromModule(mod: ModuleShape): string[] {
  const raw = [mod.TOOL_PATTERNS, mod.toolPatterns].find((value) => Array.isArray(value)) as unknown[] | undefined;
  return (raw ?? []).filter((v): v is string => typeof v === "string" && v.trim().length > 0);
}

async function loadBridges(scope: Scope): Promise<LoadedBridge[]> {
  const raw = specEnv();
  if (!raw) return [];
  /**
   * 缓存键必须含**作用域**：桥适配器在构造时就绑定了 tenantId（工位会校验 token 与租户一致），
   * 只按 env 规格缓存会让第二个工作区复用第一个工作区的租户绑定——
   * 实测（2026-09-28 生产态验收）：调度器先跑 hotel 工作区后，geo 工作区出图被桥拒绝
   * `tenant_mismatch: token for tenant ws-geo cannot act for tenant ws-yunqi`。
   */
  const cacheKey = `${raw}|${scope.tenantId}|${scope.workspaceId}`;
  const cachedBridges = bridgeCache.get(cacheKey);
  if (cachedBridges) return cachedBridges;

  const specs = parseBridgeSpecs(raw);
  const sharedBaseUrl = (process.env.WORKLOOM_BRIDGE_BASE_URL ?? "").trim();
  const token = resolveBridgeToken();
  const timeoutMs = Number(process.env.WORKLOOM_BRIDGE_TIMEOUT_MS ?? 300_000);
  const bridges: LoadedBridge[] = [];

  for (const spec of specs) {
    try {
      const mod = (await import(pathToFileURL(spec.modulePath).href)) as ModuleShape;
      const scopedFactory = mod.createToolExecutorForScope;
      const bareFactory = mod.createToolExecutor;
      const namedFactory = spec.factoryName ? mod[spec.factoryName] : undefined;
      let executor: DeploymentToolExecutor | undefined;
      if (spec.factoryName) {
        if (typeof namedFactory !== "function") {
          console.error(`[tool-executor] 模块 ${spec.modulePath} 未导出工厂 ${spec.factoryName}（fail-closed：跳过该桥）`);
          continue;
        }
        executor = (namedFactory as (cfg: BridgeFactoryConfig) => DeploymentToolExecutor | undefined)({
          baseUrl: spec.baseUrlOverride ?? sharedBaseUrl,
          token, tenantId: scope.workspaceId, timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 300_000,
          patterns: spec.patterns,
        }) ?? undefined;
      } else if (typeof scopedFactory === "function") {
        executor = scopedFactory({ tenantId: scope.tenantId, workspaceId: scope.workspaceId }) ?? undefined;
      } else if (typeof bareFactory === "function") {
        executor = bareFactory() ?? undefined;
      }
      if (!executor) continue;
      const patterns = spec.patterns.length > 0 ? spec.patterns : patternsFromModule(mod);
      bridges.push({ modulePath: spec.modulePath, patterns, wildcard: patterns.length === 0, executor });
    } catch (error) {
      console.error(
        `[tool-executor] 部署执行器加载失败（fail-closed：跳过该桥 ${spec.modulePath}）`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  bridgeCache.set(cacheKey, bridges);
  return bridges;
}

/** 测试/热更新用：清空桥缓存 */
export function resetToolExecutorCache(): void {
  bridgeCache.clear();
}

/**
 * 多桥合并执行器：按工具名路由到声明覆盖该工具的桥；无桥覆盖 → connector-required（未核实语义）。
 * 未配置任何桥 → undefined（调用方保持 `executeDeclaredTool` 的原有兜底语义）。
 */
export async function loadDeploymentToolExecutor(scope: Scope): Promise<DeploymentToolExecutor | undefined> {
  let bridges: LoadedBridge[];
  try {
    bridges = await loadBridges(scope);
  } catch (error) {
    console.error("[tool-executor] 部署执行器装配失败（fail-closed：任务将按未核实处理）",
      error instanceof Error ? error.message : String(error));
    return undefined;
  }
  if (bridges.length === 0) return undefined;

  const fallback = bridges.find((bridge) => bridge.wildcard);
  return async (name, params) => {
    const bridge = bridges.find((candidate) => candidate.patterns.some((pattern) => toolMatchesPattern(name, pattern))) ?? fallback;
    if (!bridge) {
      // 有桥但都不覆盖该工具：如实标「未核实」，绝不伪造回执（E3.7）
      return {
        result: { state: "connector-required", tool: name, reason: "no-connector-for-tool" },
        receipt: { synced: false, mode: "real" },
      };
    }
    const result = await bridge.executor(name, params);
    // 桥回执统一标 mode=real（真连接器）；桥自身若已声明模式则尊重之
    return { ...result, receipt: { ...result.receipt, mode: result.receipt?.mode ?? "real" } };
  };
}

/**
 * 派遣前覆盖度提示（GR-15 第③条）：按当前已装配桥声明，判断 preset 的写工具是否都有执行器。
 * 未配置任何桥时返回空结果（调用方按"未配置连接器"另行提示）。
 */
export async function describeToolCoverage(
  scope: Scope,
  toolNames: string[],
): Promise<{ covered: string[]; uncovered: string[]; bridges: number }> {
  const bridges = await loadBridges(scope);
  if (bridges.length === 0) return { covered: [], uncovered: [], bridges: 0 };
  const covered: string[] = [];
  const uncovered: string[] = [];
  for (const name of toolNames) {
    const hit = bridges.some((bridge) => bridge.wildcard || bridge.patterns.some((pattern) => toolMatchesPattern(name, pattern)));
    (hit ? covered : uncovered).push(name);
  }
  return { covered, uncovered, bridges: bridges.length };
}
