/**
 * runtime · 通用工具执行边界。
 *
 * 基座只理解「工具是否由当前已装配 preset 声明」以及「回执是否可核验」，
 * 不理解任何行业对象或业务动作。真实执行器由部署适配器注入；示例 Bundle
 * 只有在档案明确标记 dataMode=simulated 时，才允许走通用模拟器。
 */

export interface ToolReceipt {
  synced: boolean;
  snapshot_uri?: string;
  verified_at?: string;
}

export interface ToolResult {
  result: Record<string, unknown>;
  receipt: ToolReceipt;
}

export type ToolExecutor = (
  name: string,
  params: Record<string, unknown>,
) => Promise<ToolResult>;

export interface DeclaredToolExecution {
  allowedTools: readonly string[];
  simulated: boolean;
}

/**
 * 无行业假设的安全兜底执行器：
 * - 未由 preset 声明的工具直接拒绝；
 * - 真实数据态没有适配器时返回“未核实”，任务不得宣称完成；
 * - 仅模拟数据态生成可验证的本地模拟回执。
 */
export async function executeDeclaredTool(
  name: string,
  params: Record<string, unknown>,
  options: DeclaredToolExecution,
): Promise<ToolResult> {
  if (!options.allowedTools.includes(name)) {
    throw new Error("工具未在当前数字员工的能力清单中声明");
  }
  if (!options.simulated) {
    return {
      result: { state: "connector-required" },
      receipt: { synced: false },
    };
  }
  const verifiedAt = new Date().toISOString();
  return {
    result: { state: "simulated", input: params },
    receipt: {
      synced: true,
      snapshot_uri: `workloom-sim://receipt/${encodeURIComponent(name)}/${Date.now().toString(36)}`,
      verified_at: verifiedAt,
    },
  };
}
