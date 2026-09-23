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
import { actionText, actorText, floorStatusText } from "./display";
import { clientChineseText } from "@workloom/ui";

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

type TheaterTickerItem = NonNullable<TheaterLike["ticker"]>[number];

function directorAgentName(name: unknown, fallbackActorId: string): string {
  const fallback = clientChineseText(actorText(fallbackActorId), "数字员工");
  return clientChineseText(name, fallback);
}

/** 请示事件在进入导演、字幕和语音链路前统一收口。 */
export function askingDirectorEvent(seq: number, agent: FloorAgent): DirectorEvent {
  const agentName = directorAgentName(agent.name, agent.presetKey);
  return {
    seq,
    kind: "ask",
    agentId: agent.id,
    agentName,
    // 请示气泡：内部动作码必须先经动作字典，否则整句回落成兜底文案。
    text: floorStatusText(agent.statusLine, `${agentName} 向您请示`),
  };
}

/** ticker 动作码仅用于内部判定，对外事件文案必须经动作字典。 */
export function tickerDirectorEvent(seq: number, ticker: TheaterTickerItem): DirectorEvent | null {
  const agentName = directorAgentName(ticker.who, ticker.who);
  const action = actionText(ticker.action);
  if (FUSE_PATTERNS.some((pattern) => pattern.test(ticker.action))) {
    return { seq, kind: "fuse", agentName, text: `围栏熔断：${action}` };
  }
  if (CHEER_PATTERNS.some((pattern) => pattern.test(ticker.action))) {
    return { seq, kind: "cheer", agentName, text: `捷报：${action}` };
  }
  return null;
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
        setEvent(askingDirectorEvent(seq.current, a));
        break; // 一次一个，队列化由导演层消化
      }
    }
    for (const a of agents) prevAgents.current.set(a.id, a.state);

    // —— ticker 新增 ——
    for (const t of theater.ticker ?? []) {
      if (seenEvents.current.has(t.event_id)) continue;
      seenEvents.current.add(t.event_id);
      const nextEvent = tickerDirectorEvent(seq.current + 1, t);
      if (nextEvent) {
        seq.current += 1;
        setEvent(nextEvent);
      }
    }
  }, [theater]);

  return event;
}
