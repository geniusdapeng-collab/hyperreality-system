/**
 * cinematic · 电影级渲染工具包（3D 双视图共用，纯渲染层，零业务逻辑）
 *
 * 大片感四件套：
 *  1. CineFloor   —— 镜面反射地面（drei MeshReflectorMaterial，模糊倒影=质感核心）
 *  2. SpotBeam    —— 体积光柱（双层叠加锥体，呼吸微闪，舞台光效）
 *  3. CineRig     —— 电影运镜（开场低机位推轨入场 → 缓慢环绕 + 呼吸浮动）
 *  4. CinePost    —— 后期管线（Bloom 辉光 + Vignette 暗角 + 胶片颗粒 + 色差 + SMAA）
 *  5. SkyDome     —— 穹顶渐变天幕 + 地平线城市光带剪影（空间纵深感）
 *  6. NamePlate   —— 电影字幕感名牌（人名为主、官衔为辅、状态呼吸灯）
 */
import { useMemo, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { MeshReflectorMaterial, Sparkles, Html } from "@react-three/drei";
import { EffectComposer, Bloom, Vignette, Noise } from "@react-three/postprocessing";
import * as THREE from "three";

/* ---------------- 1. 镜面反射地面 ---------------- */
export function CineFloor({
  radius = 6, color = "#070c18", mirror = 0.55, night = false, shape = "circle", lowRes = false,
}: {
  radius?: number; color?: string; mirror?: number; night?: boolean;
  shape?: "circle" | "square";
  /** 低清反射（软渲染/大面积地面场景防反射通道与后期管线冲突） */
  lowRes?: boolean;
}) {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]}>
      {shape === "circle" ? <circleGeometry args={[radius, 96]} /> : <planeGeometry args={[radius * 2, radius * 2]} />}
      <MeshReflectorMaterial
        blur={lowRes ? [120, 40] : [280, 90]}
        resolution={lowRes ? 192 : 768}
        mixBlur={0.9}
        mixStrength={night ? 6 : 9}
        roughness={0.92}
        depthScale={1.1}
        minDepthThreshold={0.4}
        maxDepthThreshold={1.4}
        color={color}
        metalness={0.6}
        mirror={mirror}
      />
    </mesh>
  );
}

/* ---------------- 2. 体积光柱（双层锥体 + 呼吸） ---------------- */
export function SpotBeam({
  color = "#ffd98a", height = 5, topR = 0.22, bottomR = 1.1, opacity = 0.16,
  position = [0, 0, 0] as [number, number, number], flicker = 1, phase = 0,
}: {
  color?: string; height?: number; topR?: number; bottomR?: number; opacity?: number;
  position?: [number, number, number]; flicker?: number; phase?: number;
}) {
  const outer = useRef<THREE.Mesh>(null);
  const inner = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    const t = clock.getElapsedTime() + phase;
    const breathe = 0.82 + Math.sin(t * 1.1) * 0.1 * flicker + Math.sin(t * 3.7) * 0.04 * flicker;
    if (outer.current) (outer.current.material as THREE.MeshBasicMaterial).opacity = opacity * breathe;
    if (inner.current) (inner.current.material as THREE.MeshBasicMaterial).opacity = opacity * 1.1 * breathe;
  });
  return (
    <group position={position}>
      <mesh ref={outer} position={[0, height / 2, 0]}>
        <cylinderGeometry args={[topR, bottomR, height, 24, 1, true]} />
        <meshBasicMaterial color={color} transparent opacity={opacity} side={THREE.DoubleSide} depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>
      <mesh ref={inner} position={[0, height / 2, 0]}>
        <cylinderGeometry args={[topR * 0.45, bottomR * 0.42, height, 20, 1, true]} />
        <meshBasicMaterial color="#ffffff" transparent opacity={opacity * 1.1} side={THREE.DoubleSide} depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>
    </group>
  );
}

/* ---------------- 3. 电影运镜（开场推轨 + 环绕呼吸） ---------------- */
export function CineRig({
  from, to, target = [0, 0.7, 0], duration = 3.2, autoRotateSpeed = 0.35, controlsRef,
}: {
  from: [number, number, number]; to: [number, number, number];
  target?: [number, number, number]; duration?: number; autoRotateSpeed?: number;
  controlsRef: React.RefObject<any>;
}) {
  const { camera } = useThree();
  const [done, setDone] = useState(false);
  const start = useRef<number | null>(null);
  const fromV = useMemo(() => new THREE.Vector3(...from), [from]);
  const toV = useMemo(() => new THREE.Vector3(...to), [to]);
  const tgt = useMemo(() => new THREE.Vector3(...target), [target]);

  useFrame(({ clock }) => {
    if (done) return;
    if (start.current === null) {
      start.current = clock.getElapsedTime();
      camera.position.copy(fromV);
    }
    const t = Math.min((clock.getElapsedTime() - start.current) / duration, 1);
    // easeInOutCubic：推轨起步缓、中段稳、落点柔
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    camera.position.lerpVectors(fromV, toV, e);
    camera.lookAt(tgt);
    if (t >= 1) {
      setDone(true);
      const c = controlsRef.current;
      if (c) { c.enabled = true; c.autoRotate = true; c.autoRotateSpeed = autoRotateSpeed; c.update(); }
    }
  });
  // 入场期间禁用用户控制，落幕后交还
  const c = controlsRef.current;
  if (!done && c && c.enabled) c.enabled = false;
  return null;
}

/* ---------------- 4. 后期管线 ---------------- */
export function CinePost({ bloom = 0.7, grain = 0.055, vignette = 0.82 }: {
  bloom?: number; grain?: number; vignette?: number;
}) {
  return (
    <EffectComposer multisampling={0}>
      <Bloom intensity={bloom} luminanceThreshold={0.5} luminanceSmoothing={0.3} mipmapBlur />
      <Noise opacity={grain} />
      <Vignette eskil={false} offset={0.22} darkness={vignette} />
    </EffectComposer>
  );
}

/* ---------------- 5. 穹顶天幕 + 地平线城市光带 ---------------- */
const SKY_VERT = `
varying vec3 vPos;
void main() { vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;
const SKY_FRAG = `
varying vec3 vPos;
uniform vec3 uTop; uniform vec3 uMid; uniform vec3 uBot; uniform float uNight;
void main() {
  float h = normalize(vPos).y; // -1..1
  vec3 c = h > 0.12
    ? mix(uMid, uTop, smoothstep(0.12, 0.85, h))
    : mix(uMid, uBot, smoothstep(0.12, -0.45, h));
  gl_FragColor = vec4(c, 1.0);
}
`;

export function SkyDome({ night = false }: { night?: boolean }) {
  const uniforms = useMemo(() => ({
    uTop: { value: new THREE.Color(night ? "#02040a" : "#060c1c") },
    uMid: { value: new THREE.Color(night ? "#0a1226" : "#14244a") },
    uBot: { value: new THREE.Color(night ? "#030509" : "#080e1e") },
    uNight: { value: night ? 1 : 0 },
  }), [night]);
  return (
    <mesh scale={[60, 60, 60]}>
      <sphereGeometry args={[1, 32, 24]} />
      <shaderMaterial vertexShader={SKY_VERT} fragmentShader={SKY_FRAG} uniforms={uniforms} side={THREE.BackSide} depthWrite={false} />
    </mesh>
  );
}

/** 地平线城市剪影（远处竖直光条阵列，additive 微光——“世界”的纵深） */
export function Skyline({ radius = 16, count = 42, night = false }: { radius?: number; count?: number; night?: boolean }) {
  const bars = useMemo(() => Array.from({ length: count }, (_, i) => {
    const a = (i / count) * Math.PI * 2 + (i % 3) * 0.05;
    const h = 0.6 + ((i * 37) % 10) / 10 * 2.6;
    const w = 0.12 + ((i * 53) % 10) / 10 * 0.3;
    return { a, h, w, warm: i % 4 === 0 };
  }), [count]);
  return (
    <group>
      {bars.map((b, i) => (
        <mesh
          key={i}
          position={[Math.sin(b.a) * radius, b.h / 2 - 0.1, Math.cos(b.a) * radius]}
          rotation={[0, b.a, 0]}
        >
          <planeGeometry args={[b.w, b.h]} />
          <meshBasicMaterial
            color={b.warm ? "#ffcf7a" : "#5aa2ff"}
            transparent opacity={night ? 0.10 : 0.16}
            blending={THREE.AdditiveBlending} depthWrite={false} side={THREE.DoubleSide}
          />
        </mesh>
      ))}
    </group>
  );
}

/* ---------------- 6. 电影字幕感名牌 ---------------- */
export function NamePlate({
  persona, role, color = "#8ad8ff", sub, spotlight = false, spotText, position = [0, 1.6, 0], distanceFactor = 9,
}: {
  /** 人名（主标题， naming.ts personaOf） */
  persona: string;
  /** 官衔（副标题） */
  role: string;
  color?: string; sub?: string; spotlight?: boolean;
  /** 高光时追加的文案（仅仪式报到等场景传入，默认无） */
  spotText?: string;
  position?: [number, number, number]; distanceFactor?: number;
}) {
  return (
    <Html center distanceFactor={distanceFactor > 0 ? distanceFactor : undefined} position={position} style={{ pointerEvents: "none" }} zIndexRange={[20, 0]}>
      <div style={{
        display: "flex", flexDirection: "column", alignItems: "center", gap: 2,
        transform: spotlight ? "scale(1.18)" : "scale(1)", transition: "transform .25s",
        filter: spotlight ? `drop-shadow(0 0 10px ${color})` : "none",
      }}>
        <div style={{
          whiteSpace: "nowrap", fontSize: spotlight ? 14 : 12, fontWeight: 700, letterSpacing: 1.5,
          color: spotlight ? "#fff8e8" : "#eef4ff",
          textShadow: `0 0 8px ${color}88, 0 1px 3px rgba(0,0,0,.85)`,
        }}>
          {persona}{spotlight && spotText ? ` · ${spotText}` : ""}
        </div>
        <div style={{
          whiteSpace: "nowrap", fontSize: 9, fontWeight: 500, letterSpacing: 2.5,
          color, textShadow: "0 1px 2px rgba(0,0,0,.8)", opacity: 0.95,
        }}>
          {role}{sub ? ` · ${sub}` : ""}
        </div>
        <div style={{
          width: spotlight ? 56 : 40, height: 1.5, borderRadius: 1,
          background: `linear-gradient(90deg, transparent, ${color}, transparent)`,
          boxShadow: `0 0 6px ${color}`,
        }} />
      </div>
    </Html>
  );
}

/* ---------------- 氛围尘埃（光柱里的浮尘） ---------------- */
export function DustMotes({
  count = 90, area = [8, 3.2, 8] as [number, number, number], color = "#bcd6ff",
  size = 1.6, speed = 0.25, position = [0, 1.4, 0] as [number, number, number],
}: {
  count?: number; area?: [number, number, number]; color?: string;
  size?: number; speed?: number; position?: [number, number, number];
}) {
  return (
    <Sparkles
      count={count} scale={area} size={size} speed={speed}
      color={color} opacity={0.5} position={position}
    />
  );
}
