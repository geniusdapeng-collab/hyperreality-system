/**
 * 模拟数据横幅（D24 落地向导入口）
 *
 * 事实源 = onboarding.status（数据模式 + LLM 装配）：
 *  - 数据为模拟种子 或 模型为内置 mock → 常显（宁可多提示，不可漏提示）
 *  - 两者均真实 → 自动熄灭
 * 挂载点：P0 经营主页顶栏下方 + Bridge 工作台顶栏下方（全覆盖所有页面）。
 */
import { useEffect, useState } from "react";
import { ensureDemoLogin, trpc } from "../lib/trpc";

export interface OnboardingStatus {
  dataMode: "simulated" | "real";
  llm: { provider: string; model: string; baseUrl: string; real: boolean };
  workspace: { name: string; events: number; members: number; agents: number; memories: number };
  bundle?: { id: string | null; isExample: boolean };
}

export function SimBanner() {
  const [st, setSt] = useState<OnboardingStatus | null>(null);
  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        await ensureDemoLogin();
        const s = (await trpc.onboarding.status.query()) as OnboardingStatus;
        if (!stop) setSt(s);
      } catch {
        /* 服务未就绪时静默（横幅不阻塞任何页面） */
      }
    };
    void load();
    const id = setInterval(() => void load(), 15_000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, []);
  if (!st) return null;
  // V4 §2：示例版银带（深空银辉语义——不是警告，是身份说明；与黄色模拟态警示分色）
  if (st.bundle?.isExample) {
    return (
      <div className="relative z-30 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-bg800/90 px-4 py-1.5 text-[12px] text-ink2 backdrop-blur">
        <span aria-hidden className="text-gold">◈</span>
        <span className="min-w-0 flex-1">
          当前运行：<b className="text-ink">行业示例版</b>（{st.workspace.name}）——这是基座的示例装配，数据与团队可真实操作；
          也可一键清空后按引导定制您的专属行业版。
        </span>
        <a
          href="/onboarding?mode=customize"
          className="shrink-0 rounded border border-gline bg-bg700 px-3 py-1 font-bold text-ink no-underline transition-colors hover:bg-bg700"
        >
          定制我的行业版 →
        </a>
      </div>
    );
  }
  const simData = st.dataMode === "simulated";
  const mockLlm = !st.llm.real;
  if (!simData && !mockLlm) return null;
  return (
    <div className="relative z-30 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-amber-500/50 bg-amber-100/80 px-4 py-2 text-[12px] text-amber-800 backdrop-blur">
      <span aria-hidden>⚠️</span>
      <span className="min-w-0 flex-1">
        {simData && mockLlm && (
          <>当前为<b>全模拟运行态</b>：经营数据是演示种子数据，应答由内置确定性模型生成。</>
        )}
        {simData && !mockLlm && (
          <>经营数据仍为<b>演示种子数据</b>（大模型已接真实）。</>
        )}
        {!simData && mockLlm && (
          <>大模型仍为<b>内置确定性应答</b>（数据已切真实模式）。</>
        )}
        {" "}请开始接入真实数据使用——点击右侧按钮进入「落地向导」，全程自动完成。
      </span>
      <a
        href="/onboarding"
        className="shrink-0 rounded border border-amber-500/60 bg-amber-200/60 px-3 py-1 font-bold text-amber-900 no-underline transition-colors hover:bg-amber-300/60"
      >
        接入真实数据 →
      </a>
    </div>
  );
}
