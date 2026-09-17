/**
 * CineDirector · 导演运镜（事件驱动镜头状态机 + 日频熔断）
 *
 * 事件（P0 经 theaterDiff 输入）：
 *  - ask（新请示）：1.2s 轻推至请示者中景 + 风铃；
 *  - fuse（熔断）：快速急推 + 边缘红晕 + 警报（语音打断由 P0 旁路处理）；
 *  - cheer（捷报）：0.8s 特写 + 琶音；
 *
 * 纪律（PRD F3）：
 *  - ask/cheer 日合计 ≤6 次（localStorage 计数），fuse 不计入；
 *  - 用户任何输入（OrbitControls onStart）立即让出控制权；
 *  - 导演模式可关（wl-director-on）；运镜结束回到用户原机位（机位栈）。
 */
import { useEffect, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { GazeRegistry } from "./GazeSystem";
import { AudioEngine } from "../audio/AudioEngine";
import type { DirectorEvent } from "../lib/theaterDiff";

type Phase = "idle" | "moveIn" | "hold" | "restore";
interface Shot {
  kind: DirectorEvent["kind"];
  fromPos: THREE.Vector3;
  fromTarget: THREE.Vector3;
  toPos: THREE.Vector3;
  toTarget: THREE.Vector3;
  t: number;
  moveDur: number;
  holdUntil: number;
}

const COUNT_KEY = "wl-director-count";
const DAILY_LIMIT = 6;

function dailyCount(): { date: string; count: number } {
  try {
    const raw = localStorage.getItem(COUNT_KEY);
    if (raw) {
      const v = JSON.parse(raw) as { date: string; count: number };
      if (v.date === new Date().toDateString()) return v;
    }
  } catch { /* 静默 */ }
  return { date: new Date().toDateString(), count: 0 };
}
function bumpCount(): void {
  const v = dailyCount();
  try { localStorage.setItem(COUNT_KEY, JSON.stringify({ date: v.date, count: v.count + 1 })); } catch { /* 静默 */ }
}

export function directorEnabled(): boolean {
  try { return localStorage.getItem("wl-director-on") !== "0"; } catch { return true; }
}

export function CineDirector({
  event, controlsRef,
}: {
  event: DirectorEvent | null;
  controlsRef: React.RefObject<any>;
}) {
  const { camera } = useThree();
  const shot = useRef<Shot | null>(null);
  const phase = useRef<Phase>("idle");
  const lastSeq = useRef(0);

  // 用户接管：立即中断运镜
  useEffect(() => {
    const c = controlsRef.current;
    if (!c) return;
    const onStart = () => { shot.current = null; phase.current = "idle"; };
    c.addEventListener?.("start", onStart);
    return () => c.removeEventListener?.("start", onStart);
  }, [controlsRef]);

  // 新事件 → 立项运镜
  useEffect(() => {
    if (!event || event.seq === lastSeq.current || phase.current !== "idle") return;
    lastSeq.current = event.seq;
    if (!directorEnabled()) return;
    // 日频熔断（fuse 不计）
    if (event.kind !== "fuse") {
      const v = dailyCount();
      if (v.count >= DAILY_LIMIT) return;
      bumpCount();
    }
    const controls = controlsRef.current;
    if (!controls) return;

    // 目标点：请示者头顶（注册表取世界坐标），否则保持当前 target
    const toTarget = controls.target.clone() as THREE.Vector3;
    if (event.agentId) {
      const g = GazeRegistry.get(event.agentId);
      if (g) {
        const p = g.getPos();
        toTarget.set(p.x, p.y + 0.8, p.z);
      }
    }
    // 目标机位：保持当前方位角，按事件类型定距离/极角
    const offset = camera.position.clone().sub(controls.target);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    if (event.kind === "fuse") { spherical.radius = Math.max(spherical.radius * 0.55, 3.2); spherical.phi = Math.min(spherical.phi, Math.PI / 2.6); }
    else if (event.kind === "ask") { spherical.radius = Math.max(spherical.radius * 0.7, 3.6); spherical.phi = Math.min(spherical.phi, Math.PI / 2.5); }
    else { spherical.radius = Math.max(spherical.radius * 0.75, 3.4); }
    const toPos = new THREE.Vector3().setFromSpherical(spherical).add(toTarget);

    shot.current = {
      kind: event.kind,
      fromPos: camera.position.clone(),
      fromTarget: controls.target.clone(),
      toPos, toTarget,
      t: 0,
      moveDur: event.kind === "fuse" ? 0.8 : 1.2,
      holdUntil: 0,
    };
    phase.current = "moveIn";
    AudioEngine.play(event.kind === "fuse" ? "alarm" : event.kind === "ask" ? "chime" : "cheer");
  }, [event, camera, controlsRef]);

  useFrame((_, delta) => {
    const s = shot.current;
    const controls = controlsRef.current;
    if (!s || !controls) return;
    if (phase.current === "moveIn" || phase.current === "restore") {
      s.t = Math.min(s.t + delta / s.moveDur, 1);
      const e = s.t < 0.5 ? 4 * s.t * s.t * s.t : 1 - Math.pow(-2 * s.t + 2, 3) / 2;
      if (phase.current === "moveIn") {
        camera.position.lerpVectors(s.fromPos, s.toPos, e);
        controls.target.lerpVectors(s.fromTarget, s.toTarget, e);
      } else {
        camera.position.lerpVectors(s.toPos, s.fromPos, e);
        controls.target.lerpVectors(s.toTarget, s.fromTarget, e);
      }
      controls.update();
      if (s.t >= 1) {
        if (phase.current === "moveIn") {
          phase.current = "hold";
          s.holdUntil = performance.now() + (s.kind === "fuse" ? 2400 : s.kind === "ask" ? 1800 : 1000);
        } else {
          shot.current = null;
          phase.current = "idle";
        }
      }
    } else if (phase.current === "hold") {
      if (performance.now() >= s.holdUntil) {
        s.t = 0;
        phase.current = "restore";
      }
    }
  });

  return null;
}

/** 熔断红晕（fuse 事件后 4s 呼吸显示，自动消隐） */
export function FuseVignette({ event }: { event: DirectorEvent | null }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (event?.kind !== "fuse") return;
    setShow(true);
    const t = window.setTimeout(() => setShow(false), 4000);
    return () => window.clearTimeout(t);
  }, [event?.seq]);
  if (!show) return null;
  return (
    <div
      style={{
        position: "absolute", inset: 0, pointerEvents: "none", zIndex: 5,
        boxShadow: "inset 0 0 80px rgba(224,90,107,.45)",
        animation: "wl-pulse 0.9s ease-in-out 4",
        borderRadius: 12,
      }}
    />
  );
}
