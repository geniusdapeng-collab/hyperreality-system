/**
 * Stage3D · 太空驾驶舱 3D 卫星视图（React Three Fiber）
 *
 * 替代原 SVG 平面卫星图——产品定位"太空驾驶舱"的渲染层兑现：
 *  - 深空场景：2000 星点粒子 + 星云色雾；
 *  - 光核：发光球体 + UnrealBloom 辉光（CEO 全息位）；
 *  - 卫星：团队成员按评级配色发光球，3 条倾斜轨道 3D 公转 + 脉动 + 轨道环线；
 *  - 交互：拖动旋转视角（受限 OrbitControls）、点击卫星选中（onPick）、hover 放大名牌；
 *  - DPR 自适应（R3F 内置）——客户端固定比例画布 zoomFactor 下天然清晰。
 */
import { useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Html, Stars } from "@react-three/drei";
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

/* ---------------- 光核（CEO 全息位） ---------------- */
function Core({ active }: { active: boolean }) {
  const mesh = useRef<THREE.Mesh>(null);
  const halo = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    const pulse = 1 + Math.sin(t * 1.6) * 0.04;
    mesh.current?.scale.setScalar(active ? pulse : 0.9);
    if (halo.current) {
      (halo.current.material as THREE.MeshBasicMaterial).opacity = 0.12 + Math.sin(t * 1.6) * 0.05;
      halo.current.rotation.z = t * 0.1;
    }
  });
  return (
    <group>
      <mesh ref={mesh}>
        <sphereGeometry args={[0.55, 48, 48]} />
        <meshStandardMaterial
          color="#ffd98a" emissive="#ffb545" emissiveIntensity={active ? 2.6 : 1.2}
          roughness={0.25} metalness={0.6}
        />
      </mesh>
      {/* 双层光环 */}
      <mesh ref={halo} rotation={[Math.PI / 2.4, 0, 0]}>
        <torusGeometry args={[0.95, 0.012, 12, 96]} />
        <meshBasicMaterial color="#ffd98a" transparent opacity={0.15} />
      </mesh>
      <mesh rotation={[Math.PI / 1.8, 0.4, 0]}>
        <torusGeometry args={[1.15, 0.008, 12, 96]} />
        <meshBasicMaterial color="#8ad8ff" transparent opacity={0.1} />
      </mesh>
      <pointLight color="#ffcf7a" intensity={active ? 26 : 10} distance={12} decay={2} />
    </group>
  );
}

/* ---------------- 单颗卫星（团队成员） ---------------- */
function Satellite({
  agent, index, total, onPick,
}: {
  agent: StageAgent; index: number; total: number; onPick: (a: StageAgent) => void;
}) {
  const group = useRef<THREE.Group>(null);
  const [hovered, setHovered] = useState(false);
  const color = colorOf(agent.grade);
  // 三条倾斜轨道：半径与倾角按序分配；奇偶反向公转（与原 SVG 节奏一致）
  const orbit = useMemo(() => ({
    radius: 2.2 + (index % 3) * 0.55,
    tilt: (index % 3) * 0.32 - 0.32,
    speed: 0.1 * (index % 2 ? 1 : -0.7),
    phase: (index / Math.max(total, 1)) * Math.PI * 2,
    pulse: 2.4 + (index % 4) * 0.5,
  }), [index, total]);

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    const ang = orbit.phase + t * orbit.speed;
    const x = Math.cos(ang) * orbit.radius;
    const z = Math.sin(ang) * orbit.radius;
    const y = Math.sin(ang) * orbit.radius * Math.sin(orbit.tilt) * 0.4;
    group.current?.position.set(x, y, z);
    const s = (hovered ? 1.7 : 1) * (1 + Math.sin(t * orbit.pulse) * 0.12);
    group.current?.scale.setScalar(s);
  });

  return (
    <group ref={group}>
      <mesh
        onClick={(e) => { e.stopPropagation(); onPick(agent); }}
        onPointerOver={(e) => { e.stopPropagation(); setHovered(true); document.body.style.cursor = "pointer"; }}
        onPointerOut={() => { setHovered(false); document.body.style.cursor = "default"; }}
      >
        <sphereGeometry args={[0.09, 24, 24]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={hovered ? 3.2 : 1.8} roughness={0.3} />
      </mesh>
      {/* 发光晕圈 */}
      <mesh>
        <sphereGeometry args={[0.16, 16, 16]} />
        <meshBasicMaterial color={color} transparent opacity={hovered ? 0.22 : 0.1} depthWrite={false} />
      </mesh>
      {(hovered) && (
        <Html center distanceFactor={8} style={{ pointerEvents: "none" }}>
          <div style={{
            whiteSpace: "nowrap", fontSize: 11, color: "#1B2A4E", fontWeight: 600,
            background: "rgba(255,255,255,.92)", border: "1px solid #CBD5E1",
            borderRadius: 6, padding: "2px 8px", transform: "translateY(-22px)",
          }}>
            {agent.name.replace("agt-", "")} · {agent.grade}
          </div>
        </Html>
      )}
    </group>
  );
}

/* ---------------- 轨道环线 ---------------- */
function OrbitRing({ radius, tilt }: { radius: number; tilt: number }) {
  const points = useMemo(() => {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 128; i++) {
      const a = (i / 128) * Math.PI * 2;
      pts.push(new THREE.Vector3(
        Math.cos(a) * radius,
        Math.sin(a) * radius * Math.sin(tilt) * 0.4,
        Math.sin(a) * radius,
      ));
    }
    return pts;
  }, [radius, tilt]);
  const geom = useMemo(() => new THREE.BufferGeometry().setFromPoints(points), [points]);
  return (
    <primitive object={new THREE.Line(geom, new THREE.LineBasicMaterial({ color: "#8ad8ff", transparent: true, opacity: 0.14 }))} />
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
  const orbits = [2.2, 2.75, 3.3];
  return (
    <div style={{ width: "100%", height: "100%", minHeight: 420, borderRadius: 12, overflow: "hidden", background: "radial-gradient(ellipse at 50% 40%, #16203d 0%, #0a0f1e 55%, #05070f 100%)" }}>
      <Canvas
        camera={{ position: [0, 2.6, 5.4], fov: 46 }}
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: true }}
      >
        <ambientLight intensity={0.35} />
        <Stars radius={40} depth={30} count={2200} factor={2.2} saturation={0.4} fade speed={0.6} />
        <Core active={active} />
        {orbits.map((r, i) => <OrbitRing key={r} radius={r} tilt={i * 0.32 - 0.32} />)}
        {agents.map((a, i) => (
          <Satellite key={a.id} agent={a} index={i} total={agents.length} onPick={onPick} />
        ))}
        <EffectComposer>
          <Bloom intensity={0.85} luminanceThreshold={0.35} luminanceSmoothing={0.25} mipmapBlur />
        </EffectComposer>
        <OrbitControls
          enablePan={false} enableZoom={false}
          minPolarAngle={Math.PI / 3.2} maxPolarAngle={Math.PI / 1.9}
          autoRotate autoRotateSpeed={0.35}
          makeDefault
        />
      </Canvas>
    </div>
  );
}
