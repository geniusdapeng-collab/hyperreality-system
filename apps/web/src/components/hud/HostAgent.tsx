/**
 * HostAgent 本页主理员工卡（页面右上角挂载点；供各页复用）
 *  - 按 presetKey 从 workspace.agents 投影取在册员工（姓名/版本/状态点真实数据）
 *  - 点击 → /p8/agent/:id 员工档案（P8E1）；未匹配到 → /p8 团队成员兜底
 *  - 取数失败 → 静态兜底卡（preset 显示名），不阻塞页面（E1.1 优雅降级）
 */
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { ensureDemoLogin, trpc } from "../../lib/trpc";

interface AgentRow {
  id: string;
  preset_key: string;
  name: string;
  version: string;
  kind: string;
  status: string;
}

export function HostAgent({
  presetKey,
  /** 未取到团队成员时的兜底显示名 */
  fallbackName,
  /** 副标题（缺省「本页主理员工」） */
  subtitle = "本页主理员工",
}: {
  presetKey: string;
  fallbackName: string;
  subtitle?: string;
}) {
  const nav = useNavigate();
  const [agent, setAgent] = useState<AgentRow | null>(null);

  const load = useCallback(async () => {
    try {
      await ensureDemoLogin();
      const rows = (await trpc.workspace.agents.query()) as AgentRow[];
      setAgent(rows.find((a) => a.preset_key === presetKey) ?? null);
    } catch {
      setAgent(null); // 降级为静态兜底卡
    }
  }, [presetKey]);

  useEffect(() => {
    void load();
  }, [load]);

  const name = agent?.name ?? fallbackName;
  return (
    <button
      type="button"
      onClick={() => nav(agent ? `/p8/agent/${encodeURIComponent(agent.id)}` : "/p8")}
      title={`${name} · 查看员工档案（P8）`}
      className="flex cursor-pointer items-center gap-2 rounded-lg border border-gline bg-gold/5 px-2.5 py-1.5 text-left transition-colors hover:bg-gold/10"
    >
      <span className="flex h-7 w-7 items-center justify-center rounded-md border border-gold/60 bg-gold/10 text-caption font-bold text-goldhi">
        {name.slice(0, 1)}
      </span>
      <span className="min-w-0">
        <span className="block text-micro tracking-wider text-ink3">{subtitle}</span>
        <span className="block text-caption font-bold text-ink">
          {name}
          {agent && <span className="ml-1 font-mono text-micro font-normal text-ink3">{agent.version}</span>}
        </span>
      </span>
      <span
        className={`ml-1 inline-block h-1.5 w-1.5 rounded-full ${agent?.status === "ready" ? "bg-go shadow-[0_0_8px_rgba(34,200,138,.7)]" : "bg-ink3"}`}
      />
      <span className="text-caption text-gold">→</span>
    </button>
  );
}
