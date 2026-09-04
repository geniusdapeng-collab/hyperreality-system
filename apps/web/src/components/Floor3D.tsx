/**
 * Floor3D · 游戏化 3D 数字办公区（电影级版，React Three Fiber）
 *
 * 渲染层升级（Canvas 2D 等距 2.5D → Three.js 真 3D 空间 → 电影级质感），业务逻辑零改动：
 *  - 数据同源：floor payload（scene/agents）原样消费；走位目标计算与 Floor.tsx 同语义
 *    （asking→指挥台前 / blocked→工位侧 / idle→休息角 / disabled→入口 / working→工位，
 *    同工位按 id hash 微偏移站位）；
 *  - 交互同义：点击员工 → asking 且有 approvalId 走 onPickApproval（审批卡），
 *    否则 onPickAgent（绩效卡）——与 Canvas 版点击分派一字不差；
 *  - 视觉（cinematic 工具包）：镜面反射地板 / 体积光柱 / 开场推轨运镜 /
 *    穹顶天幕 + 城市光带 / 电影字幕名牌（人名·官衔）/ 辉光 + 暗角 + 胶片颗粒。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, Html } from "@react-three/drei";
import * as THREE from "three";
import { Avatar3D, roleSkinOf, type AvatarHandle } from "./Avatar3D";
import { GazeSystem, GazeRegistry } from "./GazeSystem";
import { HoverBubble } from "./HoverBubble";
import { CineDirector, FuseVignette } from "./CineDirector";
import type { DirectorEvent } from "../lib/theaterDiff";
import { AudioEngine } from "../audio/AudioEngine";
import { useNightTime } from "../lib/useNightTime";
import { personaOf } from "../lib/naming";
import { CineFloor, SpotBeam, CineRig, CinePost, SkyDome, Skyline, NamePlate, DustMotes } from "./cinematic";
import type { FloorAgent, FloorScene, FloorPayload } from "../pages/p0/Floor";

/* ---------------- 与 Floor.tsx 同语义的工具 ---------------- */
function hash(s: string): number { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }

/** 走位目标（与 Floor.tsx targetOf 逐分支一致） */
function targetOf(a: FloorAgent, scene: FloorScene): { x: number; y: number } {
  const st = scene.stations.find((s) => s.id === a.stationId);
  const jx = ((hash(a.id) % 5) - 2) * 0.16, jy = ((hash(a.id) % 3) - 1) * 0.18;
  switch (a.state) {
    case "asking": {
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
const STATE_TEXT: Record<string, string> = {
  working: "作业中",
  asking: "请您定",
  blocked: "受阻",
  celebrating: "捷报",
  collab: "协作中",
  idle: "休整",
  disabled: "停用",
};

/* ---------------- 单个数字员工 ---------------- */
function Worker({
  agent, scene, tile, onPick, onDropTask, night,
}: {
  agent: FloorAgent; scene: FloorScene; tile: number;
  onPick: (a: FloorAgent) => void;
  onDropTask?: (a: FloorAgent, task: string) => void;
  night: boolean;
}) {
  const group = useRef<THREE.Group>(null);
  const ring = useRef<THREE.Mesh>(null);
  const avatarRef = useRef<AvatarHandle>(null);
  const [bubble, setBubble] = useState(false);
  const hoverTimer = useRef<number | null>(null);
  const target = useMemo(() => targetOf(agent, scene), [agent, scene]);
  const color = STATE_COLOR[agent.state] ?? "#8ad8ff";
  const toWorld = (lx: number, ly: number) => ({
    x: (lx - scene.grid.w / 2) * tile,
    z: (ly - scene.grid.h / 2) * tile,
  });
  const init = useMemo(() => toWorld(target.x, target.y), []); // eslint-disable-line react-hooks/exhaustive-deps

  const movingRef = useRef(false);
  useFrame(({ clock }, delta) => {
    const g = group.current;
    if (!g) return;
    const t = clock.getElapsedTime();
    const w = toWorld(target.x, target.y);
    const k = 1 - Math.pow(0.002, delta);
    const dx = w.x - g.position.x, dz = w.z - g.position.z;
    movingRef.current = (dx * dx + dz * dz) > 0.04;
    if (movingRef.current) g.rotation.y = Math.atan2(dx, dz);
    g.position.x += dx * k;
    g.position.z += dz * k;
    if (!movingRef.current && agent.state !== "blocked") g.rotation.y *= 0.95;
    if (ring.current) {
      (ring.current.material as THREE.MeshBasicMaterial).opacity = 0.5 + Math.sin(t * 2.2 + hash(agent.id)) * 0.15;
    }
  });

  // 视线感知注册：getPos 供注视检测/运镜取点，onGaze 抬头点头+气泡
  useEffect(() => {
    const unregister = GazeRegistry.register({
      id: agent.id,
      getPos: () => {
        const v = new THREE.Vector3();
        if (group.current) group.current.getWorldPosition(v);
        v.y += 0.85;
        return v;
      },
      onGaze: () => {
        const cam = (window as unknown as { __wlCamera?: THREE.Camera }).__wlCamera;
        if (cam) avatarRef.current?.gazeNod(cam.position.clone());
        setBubble(true);
        window.setTimeout(() => setBubble(false), 4000);
        AudioEngine.play("pop");
      },
    });
    return unregister;
  }, [agent.id]);

  const dimmed = agent.state === "disabled";
  const skin = roleSkinOf(agent.name, agent.presetKey);
  const asking = agent.state === "asking";
  return (
    <group ref={group} position={[init.x, 0, init.z]}>
      {/* 状态底座光环 */}
      <mesh ref={ring} position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.2, 0.27, 32]} />
        <meshBasicMaterial color={color} transparent opacity={dimmed ? 0.15 : 0.55} side={THREE.DoubleSide} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>
      {/* 真人风数字员工（KayKit 骨骼动画；ref 供注视点头） */}
      <group scale={dimmed ? 0.52 : 0.64}>
        <Avatar3D ref={avatarRef} skin={skin} state={agent.state} moving={movingRef.current} />
      </group>
      {/* 一句话状态气泡（hover 0.5s / 注视触发） */}
      <HoverBubble text={agent.statusLine} visible={bubble} position={[0, 1.0, 0]} />
      {/* 请示金色体积光柱 */}
      {asking && (
        <SpotBeam color="#ffd98a" height={4.2} topR={0.12} bottomR={0.62} opacity={night ? 0.1 : 0.14} phase={hash(agent.id) % 3} />
      )}
      {/* 庆祝彩带粒子 */}
      {agent.state === "celebrating" && <Confetti seed={hash(agent.id)} />}
      {/* 点击热区 */}
      <mesh
        position={[0, 0.7, 0]} visible={false}
        onClick={(e) => { e.stopPropagation(); onPick(agent); }}
        onPointerOver={(e) => {
          e.stopPropagation();
          document.body.style.cursor = "pointer";
          hoverTimer.current = window.setTimeout(() => setBubble(true), 500);
        }}
        onPointerOut={() => {
          document.body.style.cursor = "default";
          if (hoverTimer.current) { window.clearTimeout(hoverTimer.current); hoverTimer.current = null; }
          window.setTimeout(() => setBubble(false), 1600);
        }}
      >
        <sphereGeometry args={[0.4, 8, 8]} />
      </mesh>
      {/* 电影字幕名牌（人名 · 官衔 · 状态） */}
      {!dimmed && (
        <NamePlate
          persona={personaOf(agent.presetKey)}
          role={asking ? `${agent.name} · 请您定` : ""}
          color={color}
          spotlight={asking}
          position={[0, 1.22 + (hash(agent.id) % 4) * 0.24, 0]}
          distanceFactor={0}
        />
      )}
      {/* 拖拽接收锚点 */}
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
    const t = (clock.getElapsedTime() * 0.9) % 1.4;
    const arr = (pts.geometry.attributes.position as THREE.BufferAttribute).array as Float32Array;
    for (let i = 0; i < 40; i++) {
      arr[i * 3] = positions[i * 3]! + velocities[i * 3]! * t;
      arr[i * 3 + 1] = positions[i * 3 + 1]! + velocities[i * 3 + 1]! * t - 1.8 * t * t;
      arr[i * 3 + 2] = positions[i * 3 + 2]! + velocities[i * 3 + 2]! * t;
    }
    (pts.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  });
  return (
    <points ref={ref}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions.slice(), 3]} />
      </bufferGeometry>
      <pointsMaterial size={0.05} color="#ffd98a" transparent opacity={0.9} sizeAttenuation />
    </points>
  );
}

/* ---------------- 3D 场景（地板/工位/指挥台/休息角/氛围） ---------------- */
function OfficeScene({ scene, tile, ceoName, night }: { scene: FloorScene; tile: number; ceoName: string; night: boolean }) {
  const nightScreen = night ? 2.1 : 1.0;
  const toWorld = (lx: number, ly: number) => ({
    x: (lx - scene.grid.w / 2) * tile,
    z: (ly - scene.grid.h / 2) * tile,
  });
  const floorW = scene.grid.w * tile + 1.2;
  const floorH = scene.grid.h * tile + 1.2;
  return (
    <group>
      {/* 镜面反射地板（质感核心） */}
      <CineFloor radius={Math.max(floorW, floorH)} color={night ? "#04070f" : "#080f20"} mirror={night ? 0.4 : 0.55} night={night} shape="square" lowRes />
      <gridHelper
        args={[Math.max(floorW, floorH), Math.max(scene.grid.w, scene.grid.h) + 1, "#4d6ea8", "#2a3c5c"]}
        position={[0, 0.005, 0]}
      />
      {/* 四周矮墙 + 顶部发光檐口（空间围合感） */}
      {([
        [0, -floorH / 2, floorW, 0.06] as const,
        [0, floorH / 2, floorW, 0.06] as const,
      ]).map(([x, z, w], i) => (
        <group key={i} position={[x, 0, z]}>
          <mesh position={[0, 0.35, 0]}>
            <boxGeometry args={[w, 0.7, 0.08]} />
            <meshStandardMaterial color="#0c1428" metalness={0.6} roughness={0.5} />
          </mesh>
          <mesh position={[0, 0.71, 0]}>
            <boxGeometry args={[w, 0.02, 0.1]} />
            <meshBasicMaterial color="#4d96ff" transparent opacity={night ? 0.35 : 0.6} blending={THREE.AdditiveBlending} />
          </mesh>
        </group>
      ))}
      {([
        [-floorW / 2, 0, floorH] as const,
        [floorW / 2, 0, floorH] as const,
      ]).map(([x, z, w], i) => (
        <group key={i} position={[x, 0, z]}>
          <mesh position={[0, 0.35, 0]}>
            <boxGeometry args={[0.08, 0.7, w]} />
            <meshStandardMaterial color="#0c1428" metalness={0.6} roughness={0.5} />
          </mesh>
          <mesh position={[0, 0.71, 0]}>
            <boxGeometry args={[0.1, 0.02, w]} />
            <meshBasicMaterial color="#4d96ff" transparent opacity={night ? 0.35 : 0.6} blending={THREE.AdditiveBlending} />
          </mesh>
        </group>
      ))}
      {/* 天花灯组（发光顶板阵列——办公室顶灯） */}
      {Array.from({ length: 4 }, (_, i) => {
        const x = (i - 1.5) * (floorW / 4.4);
        return (
          <group key={i} position={[x, 3.6, 0]}>
            <mesh rotation={[Math.PI / 2, 0, 0]}>
              <planeGeometry args={[1.4, 0.7]} />
              <meshBasicMaterial color={night ? "#2a3850" : "#cfe2ff"} transparent opacity={night ? 0.25 : 0.75} />
            </mesh>
            <pointLight position={[0, -0.4, 0]} intensity={night ? 0.6 : 2.4} color={night ? "#5a78b8" : "#bcd6ff"} distance={7} decay={2} />
          </group>
        );
      })}
      {/* 工位：桌台 + 双屏发光 + 桌底氛围灯带 */}
      {scene.stations.map((st) => {
        const w = toWorld(st.x, st.y);
        return (
          <group key={st.id} position={[w.x, 0, w.z]}>
            <mesh position={[0, 0.22, 0]}>
              <boxGeometry args={[0.5, 0.44, 0.34]} />
              <meshStandardMaterial color="#1c2a48" metalness={0.65} roughness={0.35} />
            </mesh>
            <mesh position={[0, 0.52, -0.1]} rotation={[-0.35, 0, 0]}>
              <boxGeometry args={[0.4, 0.26, 0.02]} />
              <meshStandardMaterial color="#0a1220" emissive="#4d96ff" emissiveIntensity={nightScreen} roughness={0.2} />
            </mesh>
            <mesh position={[0, 0.025, 0]} rotation={[-Math.PI / 2, 0, 0]}>
              <ringGeometry args={[0.34, 0.42, 32]} />
              <meshBasicMaterial color="#4d96ff" transparent opacity={night ? 0.3 : 0.2} blending={THREE.AdditiveBlending} depthWrite={false} />
            </mesh>
          </group>
        );
      })}
      {/* CEO 指挥台（金色高台 + 主光柱 + 全息数字人） */}
      {(() => {
        const w = toWorld(scene.ceoDesk.x, scene.ceoDesk.y);
        return (
          <group position={[w.x, 0, w.z]}>
            <mesh position={[0, 0.14, 0]}>
              <cylinderGeometry args={[0.44, 0.54, 0.28, 48]} />
              <meshStandardMaterial color="#233156" metalness={0.75} roughness={0.25} />
            </mesh>
            <mesh position={[0, 0.29, 0]} rotation={[-Math.PI / 2, 0, 0]}>
              <ringGeometry args={[0.36, 0.46, 48]} />
              <meshBasicMaterial color="#ffd98a" transparent opacity={0.85} blending={THREE.AdditiveBlending} depthWrite={false} />
            </mesh>
            <group position={[0, 0.28, 0]}>
              <Avatar3D skin={{ model: "Knight", cape: true, tint: "#ffd98a", workAction: "Idle" }} state="working" scale={0.66} />
            </group>
            <SpotBeam color="#ffd98a" height={4.6} topR={0.24} bottomR={1.0} opacity={night ? 0.07 : 0.1} />
            <pointLight color="#ffcf7a" intensity={night ? 7 : 5} distance={7} decay={2} position={[0, 1.5, 0]} />
            <NamePlate persona={personaOf("company-ceo")} role={ceoName} color="#ffd98a" position={[0, 1.62, 0]} distanceFactor={0} />
          </group>
        );
      })()}
      {/* 休息角 */}
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
          <group position={[w.x, 0, w.z]}>
            <mesh position={[0, 0.6, 0]}>
              <planeGeometry args={[0.5, 1.2]} />
              <meshBasicMaterial color="#8ad8ff" transparent opacity={0.2} side={THREE.DoubleSide} blending={THREE.AdditiveBlending} depthWrite={false} />
            </mesh>

          </group>
        );
      })()}
    </group>
  );
}

/* ---------------- 相机探针（gazeNod 的世界点来源；避免循环依赖） ---------------- */
function CameraProbe() {
  const { camera } = useThree();
  useEffect(() => {
    (window as unknown as { __wlCamera?: THREE.Camera }).__wlCamera = camera;
    return () => { delete (window as unknown as { __wlCamera?: THREE.Camera }).__wlCamera; };
  }, [camera]);
  return null;
}

/* ---------------- 平移范围钳制（enablePan 开放后防止场景被拖出视野） ---------------- */
function PanClamp({ controlsRef, bounds }: { controlsRef: React.RefObject<any>; bounds: { x: number; z: number } }) {
  useFrame(() => {
    const c = controlsRef.current;
    if (!c) return;
    const t = c.target as THREE.Vector3;
    t.x = THREE.MathUtils.clamp(t.x, -bounds.x, bounds.x);
    t.z = THREE.MathUtils.clamp(t.z, -bounds.z, bounds.z);
    t.y = THREE.MathUtils.clamp(t.y, 0, 1.2);
  });
  return null;
}

/* ---------------- 主组件（props 与 FloorView 全兼容） ---------------- */
export function Floor3D({
  floor, ceoName, onPickAgent, onPickApproval, onDropTask, directorEvent = null,
}: {
  floor: FloorPayload;
  ceoName: string;
  onPickAgent: (a: FloorAgent) => void;
  onDecide: (approvalId: string, gesture: "approve" | "reject") => void;
  onPickApproval: (a: FloorAgent) => void;
  onDropTask?: (a: FloorAgent, task: string) => void;
  /** 导演运镜事件（theaterDiff 输入；null=无新事件） */
  directorEvent?: DirectorEvent | null;
}) {
  const tile = 0.86;
  const scene = floor.scene;
  const onPick = (a: FloorAgent) => {
    if (a.state === "asking" && a.approvalId) onPickApproval(a);
    else onPickAgent(a);
  };
  const night = useNightTime();
  const camY = Math.max(scene.grid.w, scene.grid.h) * tile * 0.95;
  const controlsRef = useRef<any>(null);
  return (
    <div style={{ width: "100%", height: 440, borderRadius: 12, overflow: "hidden", background: "#0b0d10", position: "relative" }}>
      <FuseVignette event={directorEvent} />
      <Canvas
        camera={{ position: [camY * 1.5, camY * 0.5, camY * 1.5], fov: 40 }}
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: false }}
      >
        <SkyDome night={night} />
        <Skyline radius={Math.max(scene.grid.w, scene.grid.h) * tile * 2.2} night={night} />
        {/* 三点布光：主光（暖）+ 补光（冷）+ 轮廓逆光 */}
        <ambientLight intensity={night ? 0.2 : 0.58} color={night ? "#8ea8d8" : "#c4d6ff"} />
        <directionalLight position={[5, 8, 4]} intensity={night ? 0.28 : 0.95} color={night ? "#7a98c8" : "#a8c8ff"} />
        <directionalLight position={[-4, 5, -6]} intensity={night ? 0.45 : 0.8} color="#6fb2ff" />
        <pointLight position={[-5, 3, -2]} intensity={night ? 3 : 5} color="#5aa2ff" distance={12} decay={2} />
        <fog attach="fog" args={[night ? "#030509" : "#080f20", 11, 26]} />

        <OfficeScene scene={scene} tile={tile} ceoName={ceoName} night={night} />
        {floor.agents.map((a) => (
          <Worker key={a.id} agent={a} scene={scene} tile={tile} onPick={onPick} onDropTask={onDropTask} night={night} />
        ))}
        <DustMotes count={46} area={[9, 2.8, 7]} color={night ? "#8aa8d8" : "#bcd6ff"} size={1.2} position={[0, 1.5, 0]} speed={0.18} />

        <GazeSystem />
        <CineDirector event={directorEvent} controlsRef={controlsRef} />
        <CameraProbe />
        <CinePost bloom={night ? 0.42 : 0.5} grain={0.028} vignette={0.72} />
        <OrbitControls
          ref={controlsRef}
          enablePan enableZoom enableRotate
          panSpeed={0.8} zoomSpeed={0.9}
          screenSpacePanning={false}
          minDistance={camY * 0.35} maxDistance={camY * 1.8}
          minPolarAngle={Math.PI / 4.2} maxPolarAngle={Math.PI / 2.4}
          target={[0, 0.3, 0]}
          onStart={() => { if (controlsRef.current) controlsRef.current.autoRotate = false; }}
          makeDefault
        />
        {/* 平移目标点钳制在地板范围内（人再多也不会把场景拖丢） */}
        <PanClamp controlsRef={controlsRef} bounds={{ x: scene.grid.w * tile * 0.55, z: scene.grid.h * tile * 0.55 }} />
        <CineRig
          from={[camY * 1.5, camY * 0.5, camY * 1.5]} to={[camY * 0.76, camY * 0.88, camY * 0.76]}
          target={[0, 0.3, 0]} duration={3.2} autoRotateSpeed={0.12} controlsRef={controlsRef}
        />
      </Canvas>
    </div>
  );
}
