/**
 * 行业 ask 事实面装载（GR-19 / N-09）。
 *
 * 约定：`bundles/<industry>/connectors/ask-facts/provider.ts` 导出
 *   - `createAskFactProvider(): AskFactProvider`（必需）
 *   - `ASK_FACT_INDUSTRY?: string`（可选；缺省用目录名）
 * 服务端启动时扫描并注册到 runtime 的行业注册表（进程级，不持久——与 feedback-enums 同范式：
 * 每次启动重装，重启即恢复，不引入新的持久化面）。
 *
 * 失败语义（fail-closed 但不阻塞启动）：模块不存在/导入失败/工厂抛错 → 跳过该行业并落日志，
 * ask 回落底座通用事实面（行为与接入前一致，不会挂）。
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { bundlesRoot } from "@workloom/base/bundles";
import { registerAskFactProvider } from "@workloom/runtime";

interface AskFactModule {
  createAskFactProvider?: () => unknown;
  ASK_FACT_INDUSTRY?: unknown;
}

export async function registerBundleAskFacts(root = bundlesRoot()): Promise<string[]> {
  if (!existsSync(root)) return [];
  const registered: string[] = [];
  for (const slug of readdirSync(root).sort()) {
    const file = join(root, slug, "connectors", "ask-facts", "provider.ts");
    if (!existsSync(file)) continue;
    try {
      const mod = (await import(pathToFileURL(file).href)) as AskFactModule;
      if (typeof mod.createAskFactProvider !== "function") {
        console.error(`[ask-facts] ${slug} 的 provider.ts 未导出 createAskFactProvider（跳过）`);
        continue;
      }
      const provider = mod.createAskFactProvider() as Parameters<typeof registerAskFactProvider>[1];
      const industry = typeof mod.ASK_FACT_INDUSTRY === "string" && mod.ASK_FACT_INDUSTRY ? mod.ASK_FACT_INDUSTRY : slug;
      registerAskFactProvider(industry, provider);
      registered.push(industry);
    } catch (error) {
      console.error(
        `[ask-facts] ${slug} 行业事实面装载失败（回落地通用事实面）`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return registered;
}
