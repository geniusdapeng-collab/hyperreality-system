/**
 * Stage3D · 职业经理人团队 3D 汇报视图（电影级版）
 *
 * 场景语义（不是天文卫星图）：中央是 CEO 数字人，周围是他的数字人团队——
 * 一整支职业经理人团队列队于环形剧场，向董事长（客户视角）汇报。
 *
 * 电影级渲染（cinematic 工具包，纯渲染层，业务逻辑零改动）：
 *  - 穹顶天幕 + 地平线城市光带剪影（纵深）；
 *  - 镜面反射舞台地面（倒影=大制作质感核心）；
 *  - CEO 金色主光柱 + 团队成员评级色光柱（体积光）；
 *  - 开场低机位推轨运镜 → 缓慢环绕；胶片颗粒 + 暗角 + 辉光后期；
 *  - 名牌电影字幕化：人名为主（naming.ts 命名规范）、官衔为辅。
 */
import { useMemo, useRef, useState } from "react";
import { Avatar3D, roleSkinOf } from "./Avatar3D";
import { useNightTime } from "../lib/useNightTime";
import { personaOf } from "../lib/naming";
import { actorText } from "../lib/display";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { CineFloor, SpotBeam, CineRig, CinePost, SkyDome, Skyline, NamePlate, DustMotes } from "./cinematic";

export interface StageAgent { id: string; name: string; grade: string }

const GRADE_COLOR: Record<string, string> = {
  表扬: "#6adf8a",
  辅导: "#ff8a8a",
  关注: "#ffbe6a",
  正常: "#8ad8ff",
};
const colorOf = (g: string) => GRADE_COLOR[g] ?? "#8ad8ff";

/** id → preset_key（agt-competitor-agent → competitor-agent） */
const keyOf = (id: string) => id.replace(/^agt-/, "");
/** 官衔展示：name 已是官衔直接用；万一还是原始 id 则过展示层 */
const roleOf = (a: StageAgent) => (a.name.startsWith("agt-") ? actorText(keyOf(a.name)) : a.name);

/* ---------------- 底座脉冲环 ---------------- */
function PulseRing({ color, phase }: { color: string; phase: number }) {
  const ref = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    const t = ((clock.getElapsedTime() + phase) * 0.6) % 1.6;
    if (ref.current) {
      const s = 1 + t * 0.85;
      ref.current.scale.setScalar(s);
      (ref.current.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.4 * (1 - t / 1.6));
    }
  });
  return (
    <mesh ref={ref} position={[0, 0.015, 0]} rotation={[-Math.PI / 2, 0, 0]}>
      <ringGeometry args={[0.3, 0.34, 40]} />
      <meshBasicMaterial color={color} transparent opacity={0.3} side={THREE.DoubleSide} />
    </mesh>
  );
}

/* ---------------- CEO（金色主位 · 高台 + 主光柱） ---------------- */
function CeoFigure({ active, night }: { active: boolean; night: boolean }) {
  const group = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (group.current) group.current.position.y = 0.46 + Math.sin(t * 1.4) * 0.02;
  });
  return (
    <group position={[0, 0, 0.55]}>
      {/* 双层高台（鎏金收边） */}
      <mesh position={[0, 0.08, 0]}>
        <cylinderGeometry args={[0.78, 0.88, 0.16, 64]} />
        <meshStandardMaterial color="#131d38" metalness={0.75} roughness={0.28} />
      </mesh>
      <mesh position={[0, 0.17, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.72, 0.8, 64]} />
        <meshBasicMaterial color="#ffd98a" transparent opacity={0.55} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>
      <mesh position={[0, 0.24, 0]}>
        <cylinderGeometry args={[0.52, 0.6, 0.18, 64]} />
        <meshStandardMaterial color="#1a2542" metalness={0.8} roughness={0.22} />
      </mesh>
      <mesh position={[0, 0.335, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.44, 0.52, 64]} />
        <meshBasicMaterial color="#ffe9b8" transparent opacity={0.85} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>
      {/* CEO：Knight 金甲披风 */}
      <group ref={group}>
        <Avatar3D skin={{ model: "Knight", cape: true, tint: active ? "#ffd98a" : "#9a8a6a", workAction: "Idle" }} state="working" scale={1.35} />
      </group>
      {/* 金色主光柱（体积光） */}
      <SpotBeam color="#ffd98a" height={6.2} topR={0.3} bottomR={1.35} opacity={night ? 0.06 : 0.09} position={[0, 0.3, 0]} />
      <pointLight color="#ffcf7a" intensity={active ? 6 : 3.5} distance={10} decay={2} position={[0, 2.1, 0.4]} />
      <NamePlate persona="顾云峥" role="公司CEO" color="#ffd98a" position={[0, 2.55, 0]} />
    </group>
  );
}

/* ---------------- 团队成员（弧形列队，面向董事长） ---------------- */
function Member({
  agent, index, total, onPick, ceremony = false, night,
}: {
  agent: StageAgent; index: number; total: number; onPick: (a: StageAgent) => void;
  ceremony?: boolean; night: boolean;
}) {
  const group = useRef<THREE.Group>(null);
  const ring = useRef<THREE.Mesh>(null);
  const [hovered, setHovered] = useState(false);
  const [spotlight, setSpotlight] = useState(false);
  const color = colorOf(agent.grade);
  const pkey = keyOf(agent.id);
  const persona = personaOf(pkey);
  const role = roleOf(agent);
  // 弧形列队（与上一版同语义：前排 60% / 后排 40%，全员面向董事长 +Z）
  const slot = useMemo(() => {
    const front = Math.ceil(total * 0.6);
    const isFront = index < front;
    const rowIdx = isFront ? index : index - front;
    const rowCount = isFront ? front : Math.max(total - front, 1);
    const radius = isFront ? 2.9 : 4.05;
    const spread = Math.PI * 0.78;
    const ang = -spread / 2 + (rowCount === 1 ? spread / 2 : (rowIdx / (rowCount - 1)) * spread);
    return {
      x: Math.sin(ang) * radius,
      z: -Math.cos(ang) * radius * 0.62 - 0.35,
      phase: index * 0.7,
    };
  }, [index, total]);

  const bornAt = useRef<number | null>(null);
  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (bornAt.current === null) bornAt.current = t;
    const elapsed = t - bornAt.current;
    const spotStart = index * 1.6, spotEnd = spotStart + 1.5;
    const inSpot = ceremony && elapsed >= spotStart && elapsed < spotEnd;
    if (group.current) {
      const targetZ = inSpot ? slot.z + 1.35 : slot.z;
      group.current.position.z += (targetZ - group.current.position.z) * 0.14;
      group.current.position.y = Math.sin(t * 1.8 + slot.phase) * 0.025;
      group.current.scale.setScalar(inSpot ? 1.15 : hovered ? 1.18 : 1);
    }
    setSpotlight(inSpot);
    if (ring.current) {
      (ring.current.material as THREE.MeshBasicMaterial).opacity = hovered ? 0.95 : 0.55 + Math.sin(t * 2 + slot.phase) * 0.12;
    }
  });

  return (
    <group position={[slot.x, 0, slot.z]}>
      {/* 底座评级光环（双层） */}
      <mesh ref={ring} position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.26, 0.34, 40]} />
        <meshBasicMaterial color={color} transparent opacity={0.6} side={THREE.DoubleSide} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>
      <PulseRing color={color} phase={slot.phase} />
      <group ref={group}>
        <Avatar3D
          skin={{ ...roleSkinOf(agent.name, agent.id), tint: color }}
          state="working"
          scale={hovered ? 0.92 : 0.82}
        />
      </group>
      {/* 报到/点名的评级色光柱 */}
      {(spotlight || hovered) && (
        <SpotBeam color={color} height={4.6} topR={0.16} bottomR={0.75} opacity={night ? 0.14 : 0.2} phase={slot.phase} />
      )}
      {/* 点击热区 */}
      <mesh
        position={[0, 0.7, 0]} visible={false}
        onClick={(e) => { e.stopPropagation(); onPick(agent); }}
        onPointerOver={(e) => { e.stopPropagation(); setHovered(true); document.body.style.cursor = "pointer"; }}
        onPointerOut={() => { setHovered(false); document.body.style.cursor = "default"; }}
      >
        <sphereGeometry args={[0.42, 8, 8]} />
      </mesh>
      {/* 电影字幕名牌：人名为主 · 官衔+评级为辅 */}
      <NamePlate
        persona={persona} role={role} color={color}
        sub={hovered ? agent.grade : undefined}
        spotlight={spotlight}
        spotText="向您报到"
        position={[0, index < Math.ceil(total * 0.6) ? 1.55 : 2.0, 0]}
      />
    </group>
  );
}

/* ---------------- 环形剧场（台阶 + 同心环 + 放射线） ---------------- */
function Theater({ night }: { night: boolean }) {
  const ringGlow = night ? 0.10 : 0.17;
  return (
    <group>
      <CineFloor radius={5.4} color={night ? "#04070f" : "#070d1c"} mirror={night ? 0.45 : 0.6} night={night} />
      {/* 台阶外沿（一圈矮台，剧场感） */}
      <mesh position={[0, -0.09, 0]}>
        <cylinderGeometry args={[5.4, 5.6, 0.14, 96]} />
        <meshStandardMaterial color="#0a1122" metalness={0.7} roughness={0.4} />
      </mesh>
      <mesh position={[0, -0.015, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[5.28, 5.42, 96]} />
        <meshBasicMaterial color="#8ad8ff" transparent opacity={0.35} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>
      {/* 同心发光环 */}
      {[1.3, 2.2, 3.0, 3.85, 4.6].map((r, i) => (
        <mesh key={r} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.005 + i * 0.001, 0]}>
          <ringGeometry args={[r - 0.016, r, 96]} />
          <meshBasicMaterial
            color={i % 2 ? "#8ad8ff" : "#ffd98a"} transparent opacity={i % 2 ? ringGlow : ringGlow * 0.75}
            blending={THREE.AdditiveBlending} depthWrite={false}
          />
        </mesh>
      ))}
      {/* 放射网格线 */}
      {Array.from({ length: 16 }, (_, i) => {
        const a = (i / 16) * Math.PI * 2;
        return (
          <mesh key={i} rotation={[-Math.PI / 2, 0, a]} position={[0, 0.004, 0]}>
            <planeGeometry args={[10.6, 0.009]} />
            <meshBasicMaterial color="#8ad8ff" transparent opacity={night ? 0.045 : 0.07} blending={THREE.AdditiveBlending} depthWrite={false} side={THREE.DoubleSide} />
          </mesh>
        );
      })}
    </group>
  );
}

/* ---------------- 主组件 ---------------- */
export function Stage3D({
  agents, active = true, onPick, ceremony = false,
}: {
  agents: StageAgent[];
  active?: boolean;
  onPick: (a: StageAgent) => void;
  ceremony?: boolean;
}) {
  const night = useNightTime();
  const controlsRef = useRef<any>(null);
  return (
    <div style={{ width: "100%", height: "100%", minHeight: 440, borderRadius: 12, overflow: "hidden", background: "#04060d" }}>
      <Canvas camera={{ position: [8.6, 0.9, 11.2], fov: 42 }} dpr={[1, 2]} gl={{ antialias: true, alpha: false }}>
        <SkyDome night={night} />
        <Skyline radius={17} night={night} />
        {/* 舱室光环境：夜班整体压暗、金光更突出 */}
        <ambientLight intensity={night ? 0.2 : 0.42} color={night ? "#8ea8d8" : "#bcd2ff"} />
        <directionalLight position={[4, 6, 5]} intensity={night ? 0.28 : 0.65} color={night ? "#7a98c8" : "#9fc4ff"} />
        {/* 轮廓光（逆光勾勒人物边缘=电影感关键） */}
        <directionalLight position={[-3, 4, -6]} intensity={night ? 0.5 : 0.9} color="#6fb2ff" />
        <pointLight position={[-4, 2.5, 2]} intensity={6} color="#5aa2ff" distance={10} decay={2} />
        <fog attach="fog" args={[night ? "#030509" : "#070d1c", 10, 26]} />

        <Theater night={night} />
        <CeoFigure active={active} night={night} />
        {agents.map((a, i) => (
          <Member key={a.id} agent={a} index={i} total={agents.length} onPick={onPick} ceremony={ceremony} night={night} />
        ))}

        {/* 氛围：两侧环境光柱 + 浮尘 */}
        <SpotBeam color="#4d96ff" height={7} topR={0.5} bottomR={2.2} opacity={night ? 0.05 : 0.08} position={[-5.6, 0, -2.5]} phase={1.3} />
        <SpotBeam color="#4d96ff" height={7} topR={0.5} bottomR={2.2} opacity={night ? 0.05 : 0.08} position={[5.6, 0, -2.5]} phase={2.6} />
        <DustMotes count={70} area={[10, 3.6, 9]} color={night ? "#8aa8d8" : "#bcd6ff"} size={1.3} position={[0, 1.6, 0]} speed={0.2} />
        <DustMotes count={50} area={[2.4, 3.4, 2.4]} color="#ffe9b8" position={[0, 1.9, 0.55]} speed={0.3} />

        <CinePost bloom={night ? 0.42 : 0.5} grain={0.028} vignette={0.75} />
        <OrbitControls
          ref={controlsRef}
          enablePan={false} enableZoom={false}
          minPolarAngle={Math.PI / 3.4} maxPolarAngle={Math.PI / 2.1}
          minAzimuthAngle={-Math.PI / 3} maxAzimuthAngle={Math.PI / 3}
          target={[0, 0.8, 0.2]}
          makeDefault
        />
        <CineRig
          from={[8.6, 0.9, 11.2]} to={[0, 3.4, 8.8]} target={[0, 0.8, 0.2]}
          duration={3.4} autoRotateSpeed={0.3} controlsRef={controlsRef}
        />
      </Canvas>
    </div>
  );
}
