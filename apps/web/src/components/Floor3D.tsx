/**
 * Floor3D · 游戏化 3D 数字办公区（React Three Fiber）
 *
 * 渲染层升级（Canvas 2D 等距 2.5D → Three.js 真 3D 空间），业务逻辑零改动：
 *  - 数据同源：floor payload（scene/agents）原样消费；走位目标计算与 Floor.tsx 同语义
 *    （asking→指挥台前 / blocked→工位侧 / idle→休息角 / disabled→入口 / working→工位，
 *    同工位按 id hash 微偏移站位）；
 *  - 交互同义：点击员工 → asking 且有 approvalId 走 onPickApproval（审批卡），
 *    否则 onPickAgent（绩效卡）——与 Canvas 版点击分派一字不差；
 *  - 视觉升级：3D 工位/发光网格地板/数字人全息员工/请示金色光柱/彩带粒子/Bloom 辉光。
 */
import { useMemo, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import * as THREE from "three";
import { DigitalHuman } from "./Stage3D";
import type { FloorAgent, FloorScene, FloorPayload } from "../pages/p0/Floor";

/* ---------------- 与 Floor.tsx 同语义的工具 ---------------- */
function hash(s: string): number { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }

/** 走位目标（与 Floor.tsx targetOf 逐分支一致） */
function targetOf(a: FloorAgent, scene: FloorScene): { x: number; y: number } {
  const st = scene.stations.find((s) => s.id === a.stationId);
  const jx = ((hash(a.id) % 5) - 2) * 0.16, jy = ((hash(a.id) % 3) - 1) * 0.18;
  switch (a.state) {
    case "asking": return { x: scene.ceoDesk.x + 0.1 + jx, y: scene.ceoDesk.y + 1.1 + jy };
    case "blocked": return st ? { x: st.x + jx, y: st.y + 0.7 + jy } : { x: scene.grid.w / 2, y: scene.grid.h / 2 };
    case "idle":
      return st
        ? { x: st.x + jx, y: st.y + jy * 0.5 }
        : { x: scene.lounge.x + (hash(a.id) % 10) / 14 - 0.35, y: scene.lounge.y + (hash(a.id) % 6) / 12 - 0.25 };
    case "disabled": return { x: scene.entrance.x, y: scene.entrance.y };
    default: return st ? { x: st.x + jx, y: st.y + jy * 0.5 } : { x: scene.lounge.x + jx * 2, y: scene.lounge.y + jy * 2 };
  }
}

const STATE_COLOR: Record<string, string> = {
  working: "#8ad8ff",
  asking: "#ffd98a",
  blocked: "#ff8a8a",
  celebrating: "#6adf8a",
  collab: "#8ad8ff",
  idle: "#a8b8d8",
  disabled: "#5a6478",
};

/* ---------------- 单个数字员工 ---------------- */
function Worker({
  agent, scene, tile, onPick,
}: {
  agent: FloorAgent; scene: FloorScene; tile: number;
  onPick: (a: FloorAgent) => void;
}) {
  const group = useRef<THREE.Group>(null);
  const pillar = useRef<THREE.Mesh>(null);
  const ring = useRef<THREE.Mesh>(null);
  const target = useMemo(() => targetOf(agent, scene), [agent, scene]);
  const color = STATE_COLOR[agent.state] ?? "#8ad8ff";
  const toWorld = (lx: number, ly: number) => ({
    x: (lx - scene.grid.w / 2) * tile,
    z: (ly - scene.grid.h / 2) * tile,
  });
  // 初始位置直接落在目标点（避免首帧从原点滑入）
  const init = useMemo(() => toWorld(target.x, target.y), []); // eslint-disable-line react-hooks/exhaustive-deps

  useFrame(({ clock }, delta) => {
    const g = group.current;
    if (!g) return;
    const t = clock.getElapsedTime();
    const w = toWorld(target.x, target.y);
    // 走位插值（与 Canvas 版同语义的平滑趋近）
    const k = 1 - Math.pow(0.002, delta); // 帧率无关的平滑系数
    g.position.x += (w.x - g.position.x) * k;
    g.position.z += (w.z - g.position.z) * k;

    // 状态动画
    if (agent.state === "celebrating") {
      g.position.y = Math.abs(Math.sin(t * 4)) * 0.22;
    } else if (agent.state === "blocked") {
      g.position.y = 0;
      g.rotation.y = Math.sin(t * 2.4) * 0.5; // 踱步摇摆
    } else {
      g.position.y = Math.sin(t * 1.8 + hash(agent.id)) * 0.02; // 呼吸浮动
      g.rotation.y = 0;
    }
    if (pillar.current) {
      (pillar.current.material as THREE.MeshBasicMaterial).opacity = 0.22 + Math.sin(t * 3) * 0.1;
      pillar.current.rotation.y = t * 0.8;
    }
    if (ring.current) {
      (ring.current.material as THREE.MeshBasicMaterial).opacity = 0.5 + Math.sin(t * 2.2 + hash(agent.id)) * 0.15;
    }
  });

  const dimmed = agent.state === "disabled";
  return (
    <group ref={group} position={[init.x, 0, init.z]}>
      {/* 状态底座光环 */}
      <mesh ref={ring} position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.2, 0.27, 32]} />
        <meshBasicMaterial color={color} transparent opacity={dimmed ? 0.15 : 0.55} side={THREE.DoubleSide} />
      </mesh>
      <group scale={dimmed ? 0.85 : 0.95}>
        <DigitalHuman color={color} emissive={dimmed ? 0.4 : agent.state === "asking" ? 2.4 : 1.5} />
      </group>
      {/* 请示金色光柱（asking 专属——游戏化任务标记） */}
      {agent.state === "asking" && (
        <mesh ref={pillar} position={[0, 1.6, 0]}>
          <cylinderGeometry args={[0.09, 0.16, 1.6, 16, 1, true]} />
          <meshBasicMaterial color="#ffd98a" transparent opacity={0.25} side={THREE.DoubleSide} depthWrite={false} />
        </mesh>
      )}
      {/* 庆祝彩带粒子 */}
      {agent.state === "celebrating" && <Confetti seed={hash(agent.id)} />}
      {/* 点击热区 */}
      <mesh
        position={[0, 0.7, 0]} visible={false}
        onClick={(e) => { e.stopPropagation(); onPick(agent); }}
        onPointerOver={() => { document.body.style.cursor = "pointer"; }}
        onPointerOut={() => { document.body.style.cursor = "default"; }}
      >
        <sphereGeometry args={[0.4, 8, 8]} />
      </mesh>
    </group>
  );
}

/* ---------------- 彩带粒子（庆祝） ---------------- */
function Confetti({ seed }: { seed: number }) {
  const ref = useRef<THREE.Points>(null);
  const colors = ["#ffd98a", "#8ad8ff", "#6adf8a", "#ff8a8a", "#e8a2ff"];
  const { positions, velocities } = useMemo(() => {
    const pos = new Float32Array(40 * 3);
    const vel = new Float32Array(40 * 3);
    for (let i = 0; i < 40; i++) {
      pos[i * 3] = (((seed + i * 7) % 10) / 10 - 0.5) * 0.5;
      pos[i * 3 + 1] = 1.2 + ((seed + i * 13) % 10) / 10 * 0.6;
      pos[i * 3 + 2] = (((seed + i * 17) % 10) / 10 - 0.5) * 0.5;
      vel[i * 3] = (((seed + i * 3) % 7) / 7 - 0.5) * 0.4;
      vel[i * 3 + 1] = 0.5 + ((seed + i * 5) % 5) / 5 * 0.6;
      vel[i * 3 + 2] = (((seed + i * 11) % 7) / 7 - 0.5) * 0.4;
    }
    return { positions: pos, velocities: vel };
  }, [seed]);
  useFrame(({ clock }) => {
    const pts = ref.current;
    if (!pts) return;
    const t = (clock.getElapsedTime() * 0.9) % 1.4; // 循环爆发
    const arr = (pts.geometry.attributes.position as THREE.BufferAttribute).array as Float32Array;
    for (let i = 0; i < 40; i++) {
      arr[i * 3] = positions[i * 3]! + velocities[i * 3]! * t;
      arr[i * 3 + 1] = positions[i * 3 + 1]! + velocities[i * 3 + 1]! * t - 1.8 * t * t;
      arr[i * 3 + 2] = positions[i * 3 + 2]! + velocities[i * 3 + 2]! * t;
    }
    (pts.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  });
  void colors;
  return (
    <points ref={ref}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions.slice(), 3]} />
      </bufferGeometry>
      <pointsMaterial size={0.05} color="#ffd98a" transparent opacity={0.9} sizeAttenuation />
    </points>
  );
}

/* ---------------- 3D 场景（地板/工位/指挥台/休息角） ---------------- */
function OfficeScene({ scene, tile, ceoName }: { scene: FloorScene; tile: number; ceoName: string }) {
  const toWorld = (lx: number, ly: number) => ({
    x: (lx - scene.grid.w / 2) * tile,
    z: (ly - scene.grid.h / 2) * tile,
  });
  const floorW = scene.grid.w * tile + 0.8;
  const floorH = scene.grid.h * tile + 0.8;
  return (
    <group>
      {/* 地板主体（深色金属 + 发光网格线） */}
      <mesh position={[0, -0.06, 0]}>
        <boxGeometry args={[floorW, 0.1, floorH]} />
        <meshStandardMaterial color={scene.theme.night ? "#0e1626" : "#14203a"} metalness={0.55} roughness={0.5} />
      </mesh>
      <gridHelper
        args={[Math.max(floorW, floorH), Math.max(scene.grid.w, scene.grid.h) + 1, "#3d5a8a", "#24344f"]}
        position={[0, 0.005, 0]}
      />
      {/* 工位：桌台 + 发光屏幕 */}
      {scene.stations.map((st) => {
        const w = toWorld(st.x, st.y);
        return (
          <group key={st.id} position={[w.x, 0, w.z]}>
            <mesh position={[0, 0.22, 0]}>
              <boxGeometry args={[0.5, 0.44, 0.34]} />
              <meshStandardMaterial color="#1c2a48" metalness={0.6} roughness={0.4} />
            </mesh>
            <mesh position={[0, 0.52, -0.1]} rotation={[-0.35, 0, 0]}>
              <boxGeometry args={[0.4, 0.26, 0.02]} />
              <meshStandardMaterial color="#0a1220" emissive="#4d96ff" emissiveIntensity={0.9} roughness={0.2} />
            </mesh>
          </group>
        );
      })}
      {/* CEO 指挥台（金色高台 + 全息数字人） */}
      {(() => {
        const w = toWorld(scene.ceoDesk.x, scene.ceoDesk.y);
        return (
          <group position={[w.x, 0, w.z]}>
            <mesh position={[0, 0.14, 0]}>
              <cylinderGeometry args={[0.44, 0.52, 0.28, 40]} />
              <meshStandardMaterial color="#233156" metalness={0.7} roughness={0.3} />
            </mesh>
            <mesh position={[0, 0.29, 0]} rotation={[-Math.PI / 2, 0, 0]}>
              <ringGeometry args={[0.36, 0.44, 40]} />
              <meshBasicMaterial color="#ffd98a" transparent opacity={0.8} />
            </mesh>
            <group position={[0, 0.28, 0]}>
              <DigitalHuman color="#ffd98a" scale={1.15} emissive={2} />
            </group>
            <pointLight color="#ffcf7a" intensity={10} distance={6} decay={2} position={[0, 1.4, 0]} />
            {/* CEO 名牌 */}
            <mesh position={[0, 0.05, 0.5]} rotation={[-Math.PI / 6, 0, 0]} visible={false}>
              <planeGeometry args={[0.6, 0.16]} />
            </mesh>
            <CeoLabel name={ceoName} />
          </group>
        );
      })()}
      {/* 休息角（沙发色平台） */}
      {(() => {
        const w = toWorld(scene.lounge.x, scene.lounge.y);
        return (
          <mesh position={[w.x, 0.08, w.z]}>
            <boxGeometry args={[0.9, 0.16, 0.6]} />
            <meshStandardMaterial color="#2a3a5c" roughness={0.7} />
          </mesh>
        );
      })()}
      {/* 入口光门 */}
      {(() => {
        const w = toWorld(scene.entrance.x, scene.entrance.y);
        return (
          <mesh position={[w.x, 0.6, w.z]}>
            <planeGeometry args={[0.5, 1.2]} />
            <meshBasicMaterial color="#8ad8ff" transparent opacity={0.18} side={THREE.DoubleSide} />
          </mesh>
        );
      })()}
    </group>
  );
}

function CeoLabel({ name }: { name: string }) {
  void name; // 名牌由 DOM 层信息条呈现（保持与 Canvas 版一致的信息架构）
  return null;
}

/* ---------------- 主组件（props 与 FloorView 全兼容） ---------------- */
export function Floor3D({
  floor, ceoName, onPickAgent, onPickApproval,
}: {
  floor: FloorPayload;
  ceoName: string;
  onPickAgent: (a: FloorAgent) => void;
  onDecide: (approvalId: string, gesture: "approve" | "reject") => void;
  onPickApproval: (a: FloorAgent) => void;
}) {
  const tile = 0.86;
  const scene = floor.scene;
  // 点击分派与 Floor.tsx onClick 一字不差：asking 且有 approvalId → 审批卡；否则绩效卡
  const onPick = (a: FloorAgent) => {
    if (a.state === "asking" && a.approvalId) onPickApproval(a);
    else onPickAgent(a);
  };
  const camY = Math.max(scene.grid.w, scene.grid.h) * tile * 0.95;
  return (
    <div style={{ width: "100%", height: 440, borderRadius: 12, overflow: "hidden", background: "radial-gradient(ellipse at 50% 25%, #101a30 0%, #0a101f 60%, #060a14 100%)" }}>
      <Canvas
        camera={{ position: [camY * 0.85, camY, camY * 0.85], fov: 40 }}
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: true }}
      >
        <ambientLight intensity={0.55} color="#c4d6ff" />
        <directionalLight position={[5, 8, 4]} intensity={0.8} color="#a8c8ff" />
        <pointLight position={[-5, 3, -2]} intensity={5} color="#5aa2ff" distance={12} decay={2} />
        <fog attach="fog" args={["#0a101f", 9, 20]} />

        <OfficeScene scene={scene} tile={tile} ceoName={ceoName} />
        {floor.agents.map((a) => (
          <Worker key={a.id} agent={a} scene={scene} tile={tile} onPick={onPick} />
        ))}

        <EffectComposer>
          <Bloom intensity={0.65} luminanceThreshold={0.3} luminanceSmoothing={0.3} mipmapBlur />
        </EffectComposer>
        <OrbitControls
          enablePan={false} enableZoom={false}
          minPolarAngle={Math.PI / 4.2} maxPolarAngle={Math.PI / 2.4}
          target={[0, 0.3, 0]}
          makeDefault
        />
      </Canvas>
    </div>
  );
}
