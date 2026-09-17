import { Bridge } from "../../../shell/Bridge";
import { GATE_AGENT_MAP } from "../components/review/gateAgentMap";

export default function ReviewGuide() {
  return (
    <Bridge>
      <h2 className="break-words text-h1 font-black text-ink">视频审批分工</h2>
      <p className="mt-1 break-words text-caption text-ink3">行业角色映射只在本页解释；实际审批仍进入基座审批中心并由围栏裁决。</p>
      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
        {Object.values(GATE_AGENT_MAP).map((item) => (
          <div key={item.gate} className="rounded-lg border border-line bg-card p-3">
            <div className="text-body font-bold text-ink">{item.gate} 审批门 · {item.name}</div>
            <div className="mt-1 text-caption text-ink3">负责本审批门的视频行业请示与说明，最终裁决权仍由人类审批人持有。</div>
          </div>
        ))}
      </div>
    </Bridge>
  );
}
