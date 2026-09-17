/**
 * GazeSystem · 视线感知（3A NPC 杀手锏）
 *
 *  - 角色注册表（GazeRegistry）：Worker 挂载时注册 {id, getPos, onGaze}；
 *  - 每 120ms 计算相机视锥中心射线与各角色头部点的夹角，最近且 <6° 记为注视候选；
 *  - 持续 ≥1.5s 触发一次 onGaze（抬头点头 + 状态气泡），同一角色 30s 冷却；
 *  - 用户拖动视角（pointerdown）时暂停判定（拖动中的扫视不算"注视"）。
 */
import { useEffect, useRef } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";

export interface GazeTarget {
  id: string;
  getPos: () => THREE.Vector3;
  onGaze: () => void;
}

class GazeRegistryImpl {
  private targets = new Map<string, GazeTarget>();
  register(t: GazeTarget): () => void {
    this.targets.set(t.id, t);
    return () => { this.targets.delete(t.id); };
  }
  get(id: string): GazeTarget | undefined { return this.targets.get(id); }
  all(): GazeTarget[] { return [...this.targets.values()]; }
}
export const GazeRegistry = new GazeRegistryImpl();

const GAZE_ANGLE = Math.cos(THREE.MathUtils.degToRad(6));
const GAZE_HOLD_MS = 1500;
const GAZE_COOLDOWN_MS = 30_000;

export function GazeSystem() {
  const { camera } = useThree();
  const candidate = useRef<{ id: string; since: number } | null>(null);
  const cooldowns = useRef<Map<string, number>>(new Map());
  const dragging = useRef(false);

  useEffect(() => {
    const down = () => { dragging.current = true; candidate.current = null; };
    const up = () => { dragging.current = false; };
    window.addEventListener("pointerdown", down);
    window.addEventListener("pointerup", up);
    window.addEventListener("wheel", down, { passive: true });
    window.addEventListener("pointerup", up);

    const dir = new THREE.Vector3();
    const toTarget = new THREE.Vector3();
    const timer = window.setInterval(() => {
      if (dragging.current) return;
      try {
        camera.getWorldDirection(dir);
        let best: { id: string; dot: number } | null = null;
        const now = Date.now();
        for (const t of GazeRegistry.all()) {
          const cd = cooldowns.current.get(t.id) ?? 0;
          if (now < cd) continue;
          const p = t.getPos();
          toTarget.copy(p).sub(camera.position).normalize();
          const dot = dir.dot(toTarget);
          if (dot > GAZE_ANGLE && (!best || dot > best.dot)) best = { id: t.id, dot };
        }
        if (!best) { candidate.current = null; return; }
        if (candidate.current?.id !== best.id) {
          candidate.current = { id: best.id, since: now };
          return;
        }
        if (now - candidate.current.since >= GAZE_HOLD_MS) {
          candidate.current = null;
          cooldowns.current.set(best.id, now + GAZE_COOLDOWN_MS);
          GazeRegistry.get(best.id)?.onGaze();
        }
      } catch { /* 静默 */ }
    }, 120);

    return () => {
      window.removeEventListener("pointerdown", down);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("wheel", down);
      window.removeEventListener("pointerup", up);
      window.clearInterval(timer);
    };
  }, [camera]);

  return null;
}
