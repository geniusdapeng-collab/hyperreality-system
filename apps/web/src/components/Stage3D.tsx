/**
 * Stage3D · 职业经理人团队 3D 汇报视图（React Three Fiber）
 *
 * 场景语义（不是天文卫星图）：中央是 CEO 数字人，周围是他的数字人团队——
 * 一整支职业经理人团队以全息形态列队，向董事长（客户视角）汇报。
 *  - 全息指挥舱：深色科技舱室 + 发光同心环平台 + 放射网格（非星空）；
 *  - CEO：金色全息数字人（指挥台位，胸口光核）；
 *  - 团队：全息数字人（人形 capsule），按绩效评级配色的底座光环 + 悬浮名牌；
 *  - 交互：拖动旋转视角、点击成员选中（onPick）、hover 放大；
 *  - DPR 自适应（R3F 内置）——客户端固定比例画布 zoomFactor 下天然清晰。
 */
import { useMemo, useRef, useState } from "react";
import { Avatar3D, roleSkinOf } from "./Avatar3D";
import { useNightTime } from "../lib/useNightTime";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Html } from "@react-three/drei";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import * as THREE from "three";

export interface StageAgent { id: string; name: string; grade: string }

const GRADE_COLOR: Record<string, string> = {
  表扬: "#6adf8a",
  辅导: "#ff8a8a",
  关注: "#ffbe6a",
  正常: "#8ad8ff",
};
const colorOf = (g: string) => GRADE_COLOR[g] ?? "#8ad8ff";

/* ---------------- 数字人（全息人形 · 战备呼吸版；Floor3D 复用） ----------------
 * 设计：修长比例 + 发光面罩 + 全息扫描环 + 双层底座光环；
 * 呼吸感：身体起伏 / 发光呼吸 / 头部扫视（战备警觉）/ 胸口光核脉动。 */
export function DigitalHuman({
  color, scale = 1, emissive = 1.6, children,
}: {
  color: string; scale?: number; emissive?: number; children?: React.ReactNode;
}) {
  const body = useRef<THREE.Group>(null);
  const head = useRef<THREE.Group>(null);
  const scan = useRef<THREE.Mesh>(null);
  const coreLight = useRef<THREE.Mesh>(null);
  const mat = useRef<THREE.MeshStandardMaterial>(null);
  const phase = useMemo(() => Math.random() * Math.PI * 2, []);

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime() + phase;
    // 呼吸：发光强度缓慢起伏（战备状态的"活着"感）
    if (mat.current) mat.current.emissiveIntensity = emissive * (0.62 + Math.sin(t * 1.7) * 0.14);
    // 身体：呼吸微起伏 + 微微前倾（警觉姿态）
    if (body.current) {
      body.current.position.y = Math.sin(t * 1.7) * 0.018;
      body.current.rotation.x = 0.04 + Math.sin(t * 0.9) * 0.012;
    }
    // 头部：缓慢扫视（观察四周=战备）
    if (head.current) head.current.rotation.y = Math.sin(t * 0.55) * 0.5;
    // 全息扫描环：自下而上循环
    if (scan.current) {
      scan.current.position.y = 0.15 + ((t * 0.45) % 1.15);
      (scan.current.material as THREE.MeshBasicMaterial).opacity = 0.34 * (1 - ((t * 0.45) % 1.15) / 1.15);
    }
    // 胸口光核脉动
    if (coreLight.current) coreLight.current.scale.setScalar(1 + Math.sin(t * 2.6) * 0.25);
  });

  return (
    <group scale={scale}>
      <group ref={body}>
        {/* 下半身（圆锥台，下摆微扩） */}
        <mesh position={[0, 0.34, 0]}>
          <cylinderGeometry args={[0.14, 0.2, 0.62, 20]} />
          <meshStandardMaterial ref={mat} color={color} emissive={color} emissiveIntensity={emissive * 0.62} transparent opacity={0.78} roughness={0.3} metalness={0.25} />
        </mesh>
        {/* 胸肩（上宽下窄，肩部线条） */}
        <mesh position={[0, 0.82, 0]}>
          <cylinderGeometry args={[0.19, 0.14, 0.36, 20]} />
          <meshStandardMaterial color={color} emissive={color} emissiveIntensity={emissive * 0.7} transparent opacity={0.86} roughness={0.28} metalness={0.3} />
        </mesh>
        {/* 肩甲 */}
        {[-0.21, 0.21].map((x) => (
          <mesh key={x} position={[x, 0.95, 0]}>
            <sphereGeometry args={[0.065, 14, 14]} />
            <meshStandardMaterial color={color} emissive={color} emissiveIntensity={emissive * 0.8} transparent opacity={0.9} roughness={0.25} />
          </mesh>
        ))}
        {/* 纵向发光纹线（左右两条，全息能量感） */}
        {[-0.09, 0.09].map((x) => (
          <mesh key={x} position={[x, 0.55, 0.145]}>
            <boxGeometry args={[0.012, 0.62, 0.012]} />
            <meshBasicMaterial color="#ffffff" transparent opacity={0.5} />
          </mesh>
        ))}
        {/* 胸口光核（脉动） */}
        <mesh ref={coreLight} position={[0, 0.82, 0.16]}>
          <sphereGeometry args={[0.042, 14, 14]} />
          <meshBasicMaterial color="#ffffff" />
        </mesh>
      </group>
      {/* 头（球体 + 发光面罩 visor） */}
      <group ref={head} position={[0, 1.18, 0]}>
        <mesh>
          <sphereGeometry args={[0.125, 26, 26]} />
          <meshStandardMaterial color={color} emissive={color} emissiveIntensity={emissive * 0.85} transparent opacity={0.92} roughness={0.2} metalness={0.35} />
        </mesh>
        {/* 面罩（前额发光带，科技感） */}
        <mesh position={[0, 0.02, 0.085]} rotation={[0.12, 0, 0]}>
          <boxGeometry args={[0.15, 0.035, 0.06]} />
          <meshBasicMaterial color="#ffffff" transparent opacity={0.95} />
        </mesh>
      </group>
      {/* 全息扫描环（自下而上） */}
      <mesh ref={scan} rotation={[-Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.24, 0.006, 8, 40]} />
        <meshBasicMaterial color="#ffffff" transparent opacity={0.3} />
      </mesh>
      {children}
    </group>
  );
}

/* ---------------- CEO（金色，指挥台位） ---------------- */
function CeoFigure({ active }: { active: boolean }) {
  const group = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (group.current) group.current.position.y = 0.32 + Math.sin(t * 1.4) * 0.02;
  });
  return (
    <group position={[0, 0, 0.55]}>
      {/* 指挥台 */}
      <mesh position={[0, 0.1, 0]}>
        <cylinderGeometry args={[0.5, 0.58, 0.2, 48]} />
        <meshStandardMaterial color="#1a2540" metalness={0.7} roughness={0.3} />
      </mesh>
      <mesh position={[0, 0.21, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.42, 0.5, 48]} />
        <meshBasicMaterial color="#ffd98a" transparent opacity={0.7} />
      </mesh>
      <group ref={group}>
        {/* CEO：Knight 金甲披风（真人风角色，Idle 骨骼动画） */}
        <Avatar3D skin={{ model: "Knight", cape: true, tint: active ? "#ffd98a" : "#9a8a6a", workAction: "Idle" }} state="working" scale={1.35} />
      </group>
      <pointLight color="#ffcf7a" intensity={active ? 9 : 5} distance={9} decay={2} position={[0, 1.6, 0.4]} />
    </group>
  );
}

/* ---------------- 底座脉冲环（全息投影的扩散波） ---------------- */
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

/* ---------------- 团队成员（弧形列队，面向董事长） ---------------- */
function Member({
  agent, index, total, onPick,
}: {
  agent: StageAgent; index: number; total: number; onPick: (a: StageAgent) => void;
}) {
  const group = useRef<THREE.Group>(null);
  const ring = useRef<THREE.Mesh>(null);
  const [hovered, setHovered] = useState(false);
  const color = colorOf(agent.grade);
  // 弧形列队：以 CEO 为圆心的扇形两排（前排 60%、后排 40%），全员面向董事长（+Z）
  const slot = useMemo(() => {
    const front = Math.ceil(total * 0.6);
    const isFront = index < front;
    const rowIdx = isFront ? index : index - front;
    const rowCount = isFront ? front : Math.max(total - front, 1);
    const radius = isFront ? 2.4 : 3.3;
    const spread = Math.PI * 0.85; // 扇形张角
    const ang = -spread / 2 + (rowCount === 1 ? spread / 2 : (rowIdx / (rowCount - 1)) * spread);
    return {
      x: Math.sin(ang) * radius,
      z: -Math.cos(ang) * radius * 0.62 - 0.35, // 后排略远，整体在 CEO 后弧
      phase: index * 0.7,
    };
  }, [index, total]);

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (group.current) {
      group.current.position.y = Math.sin(t * 1.8 + slot.phase) * 0.025;
      group.current.scale.setScalar(hovered ? 1.18 : 1);
    }
    if (ring.current) {
      (ring.current.material as THREE.MeshBasicMaterial).opacity = hovered ? 0.95 : 0.55 + Math.sin(t * 2 + slot.phase) * 0.12;
    }
  });

  return (
    <group position={[slot.x, 0, slot.z]}>
      {/* 底座评级光环（双层：内环恒定 + 外环脉冲扩散） */}
      <mesh ref={ring} position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.26, 0.34, 40]} />
        <meshBasicMaterial color={color} transparent opacity={0.6} side={THREE.DoubleSide} />
      </mesh>
      <PulseRing color={color} phase={slot.phase} />
      <group ref={group}>
        {/* 数字人团队成员（真人风角色：岗位角色选型+评级调色） */}
        <Avatar3D
          skin={{ ...roleSkinOf(agent.name, agent.id), tint: color }}
          state="working"
          scale={hovered ? 0.92 : 0.82}
        />
      </group>
      {/* 点击热区（放大透明球，小目标也好点） */}
      <mesh
        position={[0, 0.7, 0]} visible={false}
        onClick={(e) => { e.stopPropagation(); onPick(agent); }}
        onPointerOver={(e) => { e.stopPropagation(); setHovered(true); document.body.style.cursor = "pointer"; }}
        onPointerOut={() => { setHovered(false); document.body.style.cursor = "default"; }}
      >
        <sphereGeometry args={[0.42, 8, 8]} />
      </mesh>
      {/* 名牌（常驻小字，hover 高亮） */}
      <Html center distanceFactor={9} position={[0, index % 2 === 0 ? 1.52 : 1.72, 0]} style={{ pointerEvents: "none" }}>
        <div style={{
          whiteSpace: "nowrap", fontSize: hovered ? 12 : 10, fontWeight: hovered ? 700 : 500,
          color: hovered ? "#0F172A" : "#334155",
          background: hovered ? "rgba(255,255,255,.95)" : "rgba(255,255,255,.72)",
          border: `1px solid ${color}`, borderRadius: 6, padding: "1px 7px",
          transition: "all .15s",
        }}>
          {agent.name.replace("agt-", "")}{hovered ? ` · ${agent.grade}` : ""}
        </div>
      </Html>
    </group>
  );
}

/* ---------------- 指挥舱平台（科技地面：同心环 + 放射网格） ---------------- */
function Platform() {
  const grid = useMemo(() => {
    const g = new THREE.Group();
    return g;
  }, []);
  void grid;
  return (
    <group>
      {/* 主平台圆盘 */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]}>
        <circleGeometry args={[4.4, 72]} />
        <meshStandardMaterial color="#0d1526" metalness={0.6} roughness={0.45} />
      </mesh>
      {/* 同心发光环 */}
      {[1.2, 2.1, 2.9, 3.7, 4.3].map((r, i) => (
        <mesh key={r} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.005 + i * 0.001, 0]}>
          <ringGeometry args={[r - 0.014, r, 96]} />
          <meshBasicMaterial color={i % 2 ? "#8ad8ff" : "#ffd98a"} transparent opacity={i % 2 ? 0.16 : 0.12} />
        </mesh>
      ))}
      {/* 放射网格线 */}
      {Array.from({ length: 12 }, (_, i) => {
        const a = (i / 12) * Math.PI * 2;
        return (
          <mesh key={i} rotation={[-Math.PI / 2, 0, a]} position={[0, 0.004, 0]}>
            <planeGeometry args={[8.6, 0.008]} />
            <meshBasicMaterial color="#8ad8ff" transparent opacity={0.07} side={THREE.DoubleSide} />
          </mesh>
        );
      })}
    </group>
  );
}

/* ---------------- 主组件 ---------------- */
export function Stage3D({
  agents, active = true, onPick,
}: {
  agents: StageAgent[];
  active?: boolean;
  onPick: (a: StageAgent) => void;
}) {
  const night = useNightTime();
  return (
    <div style={{ width: "100%", height: "100%", minHeight: 440, borderRadius: 12, overflow: "hidden", background: night
      ? "radial-gradient(ellipse at 50% 30%, #070b16 0%, #04060d 55%, #020409 100%)"
      : "radial-gradient(ellipse at 50% 30%, #101a30 0%, #0a101f 55%, #060a14 100%)",
      transition: "background 2s" }}>
      <Canvas camera={{ position: [0, 2.4, 5.6], fov: 44 }} dpr={[1, 2]} gl={{ antialias: true, alpha: true }}>
        {/* 舱室光环境：顶部冷色环境光 + 两侧青色补光（无星空，纯指挥舱）；夜班整体压暗 */}
        <ambientLight intensity={night ? 0.22 : 0.5} color={night ? "#8ea8d8" : "#bcd2ff"} />
        <directionalLight position={[4, 6, 5]} intensity={night ? 0.3 : 0.7} color={night ? "#7a98c8" : "#9fc4ff"} />
        <pointLight position={[-4, 2.5, 2]} intensity={6} color="#5aa2ff" distance={10} decay={2} />
        <fog attach="fog" args={[night ? "#04060d" : "#0a101f", 8, 16]} />

        <Platform />
        <CeoFigure active={active} />
        {agents.map((a, i) => (
          <Member key={a.id} agent={a} index={i} total={agents.length} onPick={onPick} />
        ))}

        <EffectComposer>
          <Bloom intensity={0.5} luminanceThreshold={0.42} luminanceSmoothing={0.3} mipmapBlur />
        </EffectComposer>
        <OrbitControls
          enablePan={false} enableZoom={false}
          minPolarAngle={Math.PI / 3.4} maxPolarAngle={Math.PI / 2.1}
          minAzimuthAngle={-Math.PI / 3} maxAzimuthAngle={Math.PI / 3}
          autoRotate autoRotateSpeed={0.25}
          target={[0, 0.7, 0]}
          makeDefault
        />
      </Canvas>
    </div>
  );
}
