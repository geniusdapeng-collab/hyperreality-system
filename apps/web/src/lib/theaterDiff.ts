/**
 * theaterDiff · 轮询数据 diff → 导演事件（CineDirector 的事件源）
 *
 * 对 P0 的 theater 轮询 payload 做增量检测：
 *  - ask：新增 asking 成员（含 approvalId）→ 请示事件（运镜+风铃）
 *  - fuse：ticker 新增围栏熔断类动作 → 熔断事件（警报+语音打断）
 *  - cheer：ticker 新增完成/捷报类动作 → 捷报事件（特写+琶音）
 */
import { useEffect, useRef, useState } from "react";
import type { FloorAgent } from "../pages/p0/Floor";

export interface DirectorEvent {
  seq: number;
  kind: "ask" | "fuse" | "cheer";
  agentId?: string;
  agentName?: string;
  text: string;
}

const FUSE_PATTERNS = [/fence\.block/i, /熔断/, /倒挂/, /超售防护/];
const CHEER_PATTERNS = [/done$/i, /complete/i, /达成/, /新高/, /表扬/];

interface TheaterLike {
  ticker?: Array<{ event_id: string; action: string; who: string }>;
  floor?: { agents: FloorAgent[] } | null;
}

export function useTheaterDiff(theater: TheaterLike | null): DirectorEvent | null {
  const [event, setEvent] = useState<DirectorEvent | null>(null);
  const prevAgents = useRef<Map<string, string>>(new Map());
  const seenEvents = useRef<Set<string>>(new Set());
  const seq = useRef(0);
  const booted = useRef(false);

  useEffect(() => {
    if (!theater) return;
    const agents = theater.floor?.agents ?? [];
    // 首帧只建立基线，不发事件（避免进场误报）
    if (!booted.current) {
      booted.current = true;
      for (const a of agents) prevAgents.current.set(a.id, a.state);
      for (const t of theater.ticker ?? []) seenEvents.current.add(t.event_id);
      return;
    }

    // —— 新增 asking ——
    for (const a of agents) {
      const prev = prevAgents.current.get(a.id);
      if (a.state === "asking" && prev !== "asking" && a.approvalId) {
        seq.current += 1;
        setEvent({ seq: seq.current, kind: "ask", agentId: a.id, agentName: a.name, text: a.statusLine || `${a.name} 向您请示` });
        break; // 一次一个，队列化由导演层消化
      }
    }
    for (const a of agents) prevAgents.current.set(a.id, a.state);

    // —— ticker 新增 ——
    for (const t of theater.ticker ?? []) {
      if (seenEvents.current.has(t.event_id)) continue;
      seenEvents.current.add(t.event_id);
      if (FUSE_PATTERNS.some((p) => p.test(t.action))) {
        seq.current += 1;
        setEvent({ seq: seq.current, kind: "fuse", agentName: t.who, text: `围栏熔断：${t.action}` });
      } else if (CHEER_PATTERNS.some((p) => p.test(t.action))) {
        seq.current += 1;
        setEvent({ seq: seq.current, kind: "cheer", agentName: t.who, text: `捷报：${t.action}` });
      }
    }
  }, [theater]);

  return event;
}
