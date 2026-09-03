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
import { OrbitControls, Html } from "@react-three/drei";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import * as THREE from "three";
import { Avatar3D, roleSkinOf } from "./Avatar3D";
import { useNightTime } from "../lib/useNightTime";
import type { FloorAgent, FloorScene, FloorPayload } from "../pages/p0/Floor";

/* ---------------- 与 Floor.tsx 同语义的工具 ---------------- */
function hash(s: string): number { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }

/** 走位目标（与 Floor.tsx targetOf 逐分支一致） */
function targetOf(a: FloorAgent, scene: FloorScene): { x: number; y: number } {
  const st = scene.stations.find((s) => s.id === a.stationId);
  const jx = ((hash(a.id) % 5) - 2) * 0.16, jy = ((hash(a.id) % 3) - 1) * 0.18;
  switch (a.state) {
    case "asking": {
      // 请示者在指挥台前扇形排队（按 id hash 分 6 点位——空间感，不再堆叠）
      const slot = hash(a.id) % 6;
      const ang = -0.95 + slot * 0.38;
      return {
        x: scene.ceoDesk.x + Math.sin(ang) * 2.3,
        y: scene.ceoDesk.y + 1.0 + (1 - Math.cos(ang)) * 1.6,
      };
    }
    case "blocked": return st ? { x: st.x + jx, y: st.y + 0.7 + jy } : { x: scene.grid.w / 2, y: scene.grid.h / 2 };
    case "idle":
      return st
        ? { x: st.x + jx, y: st.y + jy * 0.5 }
        : { x: scene.lounge.x + (hash(a.id) % 10) / 14 - 0.35, y: scene.lounge.y + (hash(a.id) % 6) / 12 - 0.25 };
    case "disabled": return { x: scene.entrance.x, y: scene.entrance.y };
    default: return st ? { x: st.x + jx, y: st.y + 0.45 + jy * 0.5 } : { x: scene.lounge.x + jx * 2, y: scene.lounge.y + jy * 2 };
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
  agent, scene, tile, onPick, onDropTask,
}: {
  agent: FloorAgent; scene: FloorScene; tile: number;
  onPick: (a: FloorAgent) => void;
  /** 拖拽任务卡落到该员工身上（派活闭环·拖拽形态） */
  onDropTask?: (a: FloorAgent, task: string) => void;
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

  const movingRef = useRef(false);
  useFrame(({ clock }, delta) => {
    const g = group.current;
    if (!g) return;
    const t = clock.getElapsedTime();
    const w = toWorld(target.x, target.y);
    // 走位插值（与 Canvas 版同语义的平滑趋近）
    const k = 1 - Math.pow(0.002, delta); // 帧率无关的平滑系数
    const dx = w.x - g.position.x, dz = w.z - g.position.z;
    movingRef.current = (dx * dx + dz * dz) > 0.04; // 位移超阈值=步行动画
    if (movingRef.current) g.rotation.y = Math.atan2(dx, dz); // 面朝行进方向
    g.position.x += dx * k;
    g.position.z += dz * k;

    // 状态动画由 Avatar3D 骨骼动画承担；非走位时朝向缓慢回正
    if (!movingRef.current && agent.state !== "blocked") g.rotation.y *= 0.95;
    void t;
    if (pillar.current) {
      (pillar.current.material as THREE.MeshBasicMaterial).opacity = 0.22 + Math.sin(t * 3) * 0.1;
      pillar.current.rotation.y = t * 0.8;
    }
    if (ring.current) {
      (ring.current.material as THREE.MeshBasicMaterial).opacity = 0.5 + Math.sin(t * 2.2 + hash(agent.id)) * 0.15;
    }
  });

  const dimmed = agent.state === "disabled";
  const skin = roleSkinOf(agent.name, agent.presetKey);
  return (
    <group ref={group} position={[init.x, 0, init.z]}>
      {/* 状态底座光环 */}
      <mesh ref={ring} position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.2, 0.27, 32]} />
        <meshBasicMaterial color={color} transparent opacity={dimmed ? 0.15 : 0.55} side={THREE.DoubleSide} />
      </mesh>
      {/* 真人风数字员工（KayKit 骨骼动画：走位=步行/请示=举手/庆祝=欢呼/休息=坐下） */}
      <group scale={dimmed ? 0.5 : 0.58}>
        <Avatar3D skin={skin} state={agent.state} moving={movingRef.current} />
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
      {/* 拖拽接收锚点（透明热区：任务卡拖到该员工身上即派活） */}
      {onDropTask && (
        <Html center position={[0, 0.8, 0]} zIndexRange={[10, 0]}>
          <div
            data-agent-drop={agent.id}
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
            onDrop={(e) => {
              e.preventDefault();
              const task = e.dataTransfer.getData("text/workloom-task");
              if (task) onDropTask(agent, task);
            }}
            style={{ width: 72, height: 96, transform: "translateY(-48px)", borderRadius: 12 }}
            title={`拖任务给 ${agent.name}`}
          />
        </Html>
      )}
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
function OfficeScene({ scene, tile, ceoName, night }: { scene: FloorScene; tile: number; ceoName: string; night?: boolean }) {
  const nightScreen = night ? 1.8 : 0.9;
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
              <meshStandardMaterial color="#0a1220" emissive="#4d96ff" emissiveIntensity={nightScreen} roughness={0.2} />
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
              <Avatar3D skin={{ model: "Knight", cape: true, tint: "#ffd98a", workAction: "Idle" }} state="working" scale={0.66} />
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
  floor, ceoName, onPickAgent, onPickApproval, onDropTask,
}: {
  floor: FloorPayload;
  ceoName: string;
  onPickAgent: (a: FloorAgent) => void;
  onDecide: (approvalId: string, gesture: "approve" | "reject") => void;
  onPickApproval: (a: FloorAgent) => void;
  /** 拖拽任务卡到员工身上派活 */
  onDropTask?: (a: FloorAgent, task: string) => void;
}) {
  const tile = 0.86;
  const scene = floor.scene;
  // 点击分派与 Floor.tsx onClick 一字不差：asking 且有 approvalId → 审批卡；否则绩效卡
  const onPick = (a: FloorAgent) => {
    if (a.state === "asking" && a.approvalId) onPickApproval(a);
    else onPickAgent(a);
  };
  const night = useNightTime(); // 夜班节律：随真实时间切换（22:00→08:30 上海墙钟）
  const camY = Math.max(scene.grid.w, scene.grid.h) * tile * 0.95;
  return (
    <div style={{ width: "100%", height: 440, borderRadius: 12, overflow: "hidden", background: night
      ? "radial-gradient(ellipse at 50% 25%, #070b16 0%, #04060d 60%, #020409 100%)"
      : "radial-gradient(ellipse at 50% 25%, #101a30 0%, #0a101f 60%, #060a14 100%)",
      transition: "background 2s" }}>
      <Canvas
        camera={{ position: [camY * 0.85, camY, camY * 0.85], fov: 40 }}
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: true }}
      >
        {/* 夜班调光：环境光压暗、工位屏幕增亮（台灯感）、CEO 台金光更醒目 */}
        <ambientLight intensity={night ? 0.22 : 0.55} color={night ? "#8ea8d8" : "#c4d6ff"} />
        <directionalLight position={[5, 8, 4]} intensity={night ? 0.3 : 0.8} color={night ? "#7a98c8" : "#a8c8ff"} />
        <pointLight position={[-5, 3, -2]} intensity={night ? 3 : 5} color="#5aa2ff" distance={12} decay={2} />
        {night && <pointLight position={[0, 2.2, 0]} intensity={7} color="#ffb545" distance={8} decay={2} />}
        <fog attach="fog" args={[night ? "#04060d" : "#0a101f", 9, 20]} />

        <OfficeScene scene={scene} tile={tile} ceoName={ceoName} night={night} />
        {floor.agents.map((a) => (
          <Worker key={a.id} agent={a} scene={scene} tile={tile} onPick={onPick} onDropTask={onDropTask} />
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
