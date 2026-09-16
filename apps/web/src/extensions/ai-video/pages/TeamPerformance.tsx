import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { Skeleton } from "@workloom/ui";
import { ensureDemoLogin, trpc } from "../../../lib/trpc";
import { Bridge } from "../../../shell/Bridge";
import { EmployeeCardDrawer, type EmployeeRow } from "../components/team/EmployeeCardDrawer";
import { HostAgent } from "../components/team/HostAgent";

interface TeamProjection {
  nightWindow: { range: string };
  agents: EmployeeRow[];
}

export default function TeamPerformance() {
  const navigate = useNavigate();
  const { agentId } = useParams<{ agentId: string }>();
  const [ready, setReady] = useState(false);
  const [canDispatch, setCanDispatch] = useState(false);
  const [team, setTeam] = useState<TeamProjection>({ nightWindow: { range: "22:00–08:00" }, agents: [] });

  const load = useCallback(async () => {
    await ensureDemoLogin();
    const [roster, member] = await Promise.all([
      trpc.roster.list.query() as Promise<TeamProjection>,
      trpc.members.me.query() as Promise<{ identity: { role: string } }>,
    ]);
    setTeam(roster);
    setCanDispatch(member.identity.role !== "readonly");
    setReady(true);
  }, []);
  useEffect(() => { void load(); }, [load]);
  const selected = agentId ? team.agents.find((agent) => agent.id === agentId) ?? null : null;

  return (
    <Bridge>
      <div className="mb-4 flex min-w-0 flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="break-words text-h1 font-black text-ink">视频团队战绩</h2>
          <p className="mt-1 break-words text-caption text-ink3">查看视频班组在岗状态、围栏绑定与可归因成绩。</p>
        </div>
        <HostAgent presetKey="director" fallbackName="总导演" />
      </div>
      {!ready ? <Skeleton count={5} /> : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {team.agents.map((agent) => (
            <button key={agent.id} type="button" onClick={() => navigate(`/ai-video/team-performance/${encodeURIComponent(agent.id)}`)} className="min-w-0 rounded-lg border border-line bg-card p-3 text-left hover:border-gline">
              <div className="truncate text-body font-bold text-ink">{agent.name}</div>
              <div className="mt-1 break-words text-caption text-ink3">{agent.online ? "夜班在线" : agent.readonly ? "只读待命" : "待命"} · 近 30 天 {agent.stats.actions30} 个动作</div>
            </button>
          ))}
        </div>
      )}
      {selected ? <EmployeeCardDrawer agent={selected} nightRange={team.nightWindow.range} canDispatch={canDispatch} onClose={() => navigate("/ai-video/team-performance")} /> : null}
    </Bridge>
  );
}
