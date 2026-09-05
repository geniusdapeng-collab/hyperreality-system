/**
 * CeremonyStage · 仪式引擎（方案 V4 §0/§7b/§7d）
 * 通用产品机制：输入当前工作区团队编制 → 按 roleSkinOf 自动布阵 → KayKit 骨骼动画演绎。
 * 任何行业版零定制复用：酒店版出来酒店团队、电商版出来电商团队。
 *
 * 编舞机制：
 *  - 慢半拍担当：每场随机 1-2 名员工节奏慢 29%、相位晚半拍（不协调之美）；
 *  - 每日编舞种子表：日期种子决定慢拍担当/队形/节奏——同一天全仓同一场，每日有新鲜感；
 *  - 去武器：Avatar3D 已全场景隐藏武器节点。
 *
 * 触发类型（occasion）：first-install 首次装机欢迎 / morning 每日晨迎 / milestone 里程碑庆祝。
 * 离线渲染契约：?capture 模式由 window.__ceremonyStep 驱动虚拟时钟（录屏技能路线 B）。
 */
import { Suspense, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { Canvas, useFrame } from "@react-three/fiber";
import { Avatar3D, roleSkinOf } from "./Avatar3D";
import { CineFloor, SpotBeam, CinePost } from "./cinematic";

export interface CeremonyActor {
  presetKey: string;
  name: string;          // 岗位名（displayNameOf 已解析）
}

export type CeremonyOccasion = "first-install" | "morning" | "milestone";

/* ---------------- 每日编舞种子（同一天全仓同一场） ---------------- */
function daySeed(): number {
  const d = new Date();
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}
function seededRand(seed: number): () => number {
  let s = seed;
  return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
}

interface Choreography {
  slowDancers: number[];       // 慢半拍担当（员工索引）
  formation: "arc" | "line" | "v";
  cheerScale: number;          // 节奏（每日微变 1.05-1.25）
}

export function choreographyOf(actorCount: number, occasion: CeremonyOccasion): Choreography {
  const rand = seededRand(daySeed());
  const staffN = Math.max(0, actorCount - 1);
  const slowDancers: number[] = [];
  const slowN = Math.min(2, staffN);
  while (slowDancers.length < slowN) {
    const i = Math.floor(rand() * staffN);
    if (!slowDancers.includes(i)) slowDancers.push(i);
  }
  const formations: Array<Choreography["formation"]> = ["arc", "line", "v"];
  const formation = occasion === "first-install" ? "arc" : formations[Math.floor(rand() * formations.length)]!;
  const cheerScale = 1.05 + rand() * 0.2;
  return { slowDancers, formation, cheerScale };
}

/* ---------------- 布阵 ---------------- */
function formationPos(formation: Choreography["formation"], i: number, n: number): [number, number] {
  if (formation === "line") return [(i - (n - 1) / 2) * 1.5, -0.9];
  if (formation === "v") {
    const side = i % 2 === 0 ? -1 : 1;
    const rank = Math.ceil((i + 1) / 2);
    return [side * rank * 1.35, -0.6 - rank * 0.45];
  }
  // arc（默认）
  const x = (i - (n - 1) / 2) * 1.55;
  return [x, -0.9 - Math.abs(x) * 0.07];
}

/* ---------------- 单个演员 ---------------- */
function Actor({ actor, pos, isCeo, slow, cheerScale, dancing }: {
  actor: CeremonyActor;
  pos: [number, number];
  isCeo: boolean;
  slow: boolean;
  cheerScale: number;
  dancing: boolean;
}) {
  const group = useRef<THREE.Group>(null);
  const mixerRef = useRef<{ t: number }>({ t: 0 });

  useFrame((_, dt) => {
    if (!group.current) return;
    // 跳舞期群体律动（慢拍担当频率低 29% + 相位偏移）
    if (dancing) {
      const freq = slow ? 5.6 : 7.9;
      const phase = slow ? -1.2 : 0;
      mixerRef.current.t += dt;
      group.current.position.y = Math.abs(Math.sin(mixerRef.current.t * freq + phase)) * 0.07;
    } else {
      group.current.position.y *= 0.9;
    }
  });

  return (
    <group position={[pos[0], 0, pos[1]]}>
      <group ref={group} scale={isCeo ? 0.82 : 0.62}>
        <Avatar3D
          skin={isCeo
            ? { model: "Knight", cape: true, tint: "#ffd98a", workAction: "Idle" }
            : roleSkinOf(actor.name, actor.presetKey)}
          state={dancing ? "celebrating" : "idle"}
        />
      </group>
      {/* 主光柱：CEO 金色常驻，员工仅里程碑场 */}
      {isCeo && <SpotBeam color="#ffd98a" height={4.6} topR={0.22} bottomR={0.95} opacity={0.1} />}
    </group>
  );
}

/* ---------------- 场景 ---------------- */
function CeremonyScene({ actors, occasion, dancing, onReady }: {
  actors: CeremonyActor[];
  occasion: CeremonyOccasion;
  dancing: boolean;
  onReady: () => void;
}) {
  const choreo = useMemo(() => choreographyOf(actors.length, occasion), [actors.length, occasion]);
  const readyFired = useRef(false);
  useEffect(() => {
    const t = setTimeout(() => {
      if (!readyFired.current) { readyFired.current = true; onReady(); }
    }, 800);
    return () => clearTimeout(t);
  }, [onReady]);

  // 供离线渲染/测试读取编舞（同日全仓一致性验证）
  useEffect(() => {
    (window as unknown as { __choreography?: Choreography }).__choreography = choreo;
  }, [choreo]);

  return (
    <>
      <color attach="background" args={["#0b0d10"]} />
      <ambientLight intensity={0.55} color="#a8bce0" />
      <directionalLight position={[5, 8, 6]} intensity={1.0} color="#dce8ff" />
      <directionalLight position={[0, 3.5, 10]} intensity={0.7} color="#e8edf4" />
      <CineFloor radius={14} color="#0a0e16" mirror={0.5} night shape="square" lowRes />
      <gridHelper args={[24, 24, "#2c333b", "#1a1f26"]} position={[0, 0.005, 0]} />
      {/* 五道聚光（中央金） */}
      {[-4.4, -2.2, 0, 2.2, 4.4].map((x, i) => (
        <SpotBeam key={x} color={i === 2 ? "#ffd98a" : "#b3c6de"} height={7}
          topR={0.5} bottomR={1.6} opacity={i === 2 ? 0.1 : 0.07} position={[x, 0, -1]} />
      ))}

      {actors.map((a, i) => {
        const isCeo = i === 0;
        const pos: [number, number] = isCeo ? [0, 0.6] : formationPos(choreo.formation, i - 1, actors.length - 1);
        return (
          <Actor
            key={a.presetKey}
            actor={a}
            pos={pos}
            isCeo={isCeo}
            slow={!isCeo && choreo.slowDancers.includes(i - 1)}
            cheerScale={choreo.cheerScale}
            dancing={dancing}
          />
        );
      })}
      <CinePost bloom={0.45} grain={0.03} vignette={0.72} />
    </>
  );
}

/* ---------------- 主组件 ---------------- */
export function CeremonyStage({ actors, occasion = "first-install", dancing = true, height = 460, onReady }: {
  actors: CeremonyActor[];
  occasion?: CeremonyOccasion;
  dancing?: boolean;
  height?: number;
  onReady?: () => void;
}) {
  return (
    <div style={{ width: "100%", height, borderRadius: 12, overflow: "hidden", background: "#0b0d10", position: "relative" }}>
      <Canvas
        dpr={typeof window !== "undefined" ? window.devicePixelRatio : 1}
        camera={{ position: [0, 3.0, 13.5], fov: 38 }}
        gl={{ antialias: true, preserveDrawingBuffer: true }}
      >
        <Suspense fallback={null}>
          <CeremonyScene actors={actors} occasion={occasion} dancing={dancing} onReady={() => onReady?.()} />
        </Suspense>
      </Canvas>
    </div>
  );
}
