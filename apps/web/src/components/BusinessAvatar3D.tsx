/**
 * BusinessAvatar3D · 零外部素材的现代职场数字员工。
 *
 * 正式职场不再复用骑士/法师游戏资产。人物由轻量 Three.js 几何体组成，因而没有
 * GLTF 下载、纹理丢失或跨 WebGL 上下文污染风险；身份决定肤色、发型、服装和强调色，
 * 业务状态驱动走路、工作、举手、庆祝与注视动作。
 */
import { forwardRef, useImperativeHandle, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { AvatarHandle } from "./Avatar3D";

const SUITS = ["#274c72", "#3b416f", "#285f59", "#70483f", "#3d5369", "#594579"];
const ACCENTS = ["#8ad8ff", "#ffd98a", "#84eadb", "#ffb29e", "#b9aaff", "#a8c5ff"];
const SKINS = ["#f2c7a6", "#e4ae87", "#d7966d", "#b97752", "#8f5a42"];
const HAIRS = ["#172033", "#30241f", "#4a3025", "#101722", "#56372a"];

function hashOf(value: string): number {
  let h = 0;
  for (const ch of value) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(h);
}

const lerpAngle = (from: number, to: number, delta: number) => from + (to - from) * Math.min(1, delta * 8);

export const BusinessAvatar3D = forwardRef<AvatarHandle, {
  identity: string;
  state?: string;
  moving?: boolean;
  scale?: number;
}>(function BusinessAvatar3D({ identity, state = "working", moving = false, scale = 1 }, ref) {
  const root = useRef<THREE.Group>(null);
  const head = useRef<THREE.Group>(null);
  const leftArm = useRef<THREE.Group>(null);
  const rightArm = useRef<THREE.Group>(null);
  const leftLeg = useRef<THREE.Group>(null);
  const rightLeg = useRef<THREE.Group>(null);
  const gaze = useRef<{ point: THREE.Vector3; until: number; nodAt: number } | null>(null);
  const appearance = useMemo(() => {
    const h = hashOf(identity);
    return {
      suit: SUITS[h % SUITS.length]!, accent: ACCENTS[(h >> 2) % ACCENTS.length]!,
      skin: SKINS[(h >> 4) % SKINS.length]!, hair: HAIRS[(h >> 6) % HAIRS.length]!,
      longHair: (h % 5) === 1 || (h % 5) === 3, glasses: (h % 4) === 0,
    };
  }, [identity]);

  useImperativeHandle(ref, () => ({
    gazeNod: (worldPoint: THREE.Vector3) => {
      gaze.current = { point: worldPoint.clone(), until: performance.now() + 2400, nodAt: performance.now() + 240 };
    },
  }), []);

  useFrame(({ clock }, delta) => {
    const t = clock.getElapsedTime() + (hashOf(identity) % 31) * .17;
    if (root.current) root.current.position.y = Math.sin(t * 1.45) * .012;
    let la = 0, ra = 0, ll = 0, rl = 0;
    if (moving) {
      la = Math.sin(t * 7) * .55; ra = -la; ll = -la; rl = la;
    } else if (state === "asking") {
      ra = -2.65 + Math.sin(t * 3) * .08; la = .08;
    } else if (state === "celebrating") {
      la = 2.35 + Math.sin(t * 5) * .12; ra = -2.35 - Math.sin(t * 5) * .12;
    } else if (state === "working" || state === "collab") {
      la = .72 + Math.sin(t * 4) * .06; ra = -.72 - Math.sin(t * 4.5) * .06;
    } else if (state === "blocked") {
      la = .32 + Math.sin(t * 2.2) * .15; ra = -.32 - Math.sin(t * 2.2) * .15;
    }
    if (leftArm.current) leftArm.current.rotation.z = lerpAngle(leftArm.current.rotation.z, la, delta);
    if (rightArm.current) rightArm.current.rotation.z = lerpAngle(rightArm.current.rotation.z, ra, delta);
    if (leftLeg.current) leftLeg.current.rotation.x = lerpAngle(leftLeg.current.rotation.x, ll, delta);
    if (rightLeg.current) rightLeg.current.rotation.x = lerpAngle(rightLeg.current.rotation.x, rl, delta);

    const g = gaze.current;
    if (!head.current) return;
    if (!g || !root.current || performance.now() >= g.until) {
      head.current.rotation.x *= .86; head.current.rotation.y *= .86;
      if (g) gaze.current = null;
      return;
    }
    const local = root.current.worldToLocal(g.point.clone());
    const wantY = THREE.MathUtils.clamp(Math.atan2(local.x, Math.max(.1, local.z)), -.75, .75);
    const nodT = performance.now() - g.nodAt;
    const wantX = nodT > 0 && nodT < 650 ? Math.sin((nodT / 650) * Math.PI) * .2 : 0;
    head.current.rotation.y = lerpAngle(head.current.rotation.y, wantY, delta);
    head.current.rotation.x = lerpAngle(head.current.rotation.x, wantX, delta);
  });

  const limb = (side: "left" | "right") => (
    <group ref={side === "left" ? leftArm : rightArm} position={[side === "left" ? -.34 : .34, 1.02, 0]}>
      <mesh position={[0, -.22, 0]}><capsuleGeometry args={[.075, .3, 5, 10]} /><meshStandardMaterial color={appearance.suit} emissive={appearance.suit} emissiveIntensity={.2} roughness={.72} /></mesh>
      <mesh position={[0, -.45, 0]}><sphereGeometry args={[.085, 12, 10]} /><meshStandardMaterial color={appearance.skin} roughness={.8} /></mesh>
    </group>
  );
  return (
    <group ref={root} scale={scale}>
      {/* 腿与鞋 */}
      <group ref={leftLeg} position={[-.14, .5, 0]}>
        <mesh position={[0, -.25, 0]}><capsuleGeometry args={[.09, .34, 5, 10]} /><meshStandardMaterial color="#17243a" roughness={.78} /></mesh>
        <mesh position={[0, -.49, .045]} scale={[1.15, .55, 1.45]}><sphereGeometry args={[.105, 12, 8]} /><meshStandardMaterial color="#09111f" /></mesh>
      </group>
      <group ref={rightLeg} position={[.14, .5, 0]}>
        <mesh position={[0, -.25, 0]}><capsuleGeometry args={[.09, .34, 5, 10]} /><meshStandardMaterial color="#17243a" roughness={.78} /></mesh>
        <mesh position={[0, -.49, .045]} scale={[1.15, .55, 1.45]}><sphereGeometry args={[.105, 12, 8]} /><meshStandardMaterial color="#09111f" /></mesh>
      </group>
      {/* 现代商务上装 */}
      <mesh position={[0, .91, 0]} scale={[1, 1.05, .62]}><capsuleGeometry args={[.3, .3, 7, 14]} /><meshStandardMaterial color={appearance.suit} emissive={appearance.suit} emissiveIntensity={.24} roughness={.58} metalness={.04} /></mesh>
      <mesh position={[0, 1.04, .2]} scale={[.38, .85, .18]}><boxGeometry args={[.24, .34, .08]} /><meshStandardMaterial color="#edf4ff" roughness={.8} /></mesh>
      <mesh position={[0, .99, .235]}><boxGeometry args={[.045, .25, .026]} /><meshStandardMaterial color={appearance.accent} emissive={appearance.accent} emissiveIntensity={.18} /></mesh>
      <mesh position={[.2, 1.05, .235]}><boxGeometry args={[.09, .055, .025]} /><meshBasicMaterial color={appearance.accent} /></mesh>
      {limb("left")}{limb("right")}
      {/* 头、头发与表情 */}
      <group ref={head} position={[0, 1.48, 0]}>
        {appearance.longHair && <mesh position={[0, -.015, -.055]} scale={[1.08, 1.2, .9]}><sphereGeometry args={[.245, 16, 12]} /><meshStandardMaterial color={appearance.hair} roughness={.9} /></mesh>}
        <mesh><sphereGeometry args={[.225, 18, 14]} /><meshStandardMaterial color={appearance.skin} roughness={.88} /></mesh>
        <mesh position={[0, .11, -.025]} scale={[1.02, .62, 1.04]}><sphereGeometry args={[.228, 16, 10, 0, Math.PI * 2, 0, Math.PI * .58]} /><meshStandardMaterial color={appearance.hair} roughness={.9} /></mesh>
        <mesh position={[-.075, .025, .213]}><sphereGeometry args={[.018, 8, 6]} /><meshBasicMaterial color="#172033" /></mesh>
        <mesh position={[.075, .025, .213]}><sphereGeometry args={[.018, 8, 6]} /><meshBasicMaterial color="#172033" /></mesh>
        {appearance.glasses && <>
          <mesh position={[-.078, .025, .222]}><torusGeometry args={[.055, .009, 6, 14]} /><meshBasicMaterial color={appearance.accent} /></mesh>
          <mesh position={[.078, .025, .222]}><torusGeometry args={[.055, .009, 6, 14]} /><meshBasicMaterial color={appearance.accent} /></mesh>
          <mesh position={[0, .025, .222]}><boxGeometry args={[.045, .008, .008]} /><meshBasicMaterial color={appearance.accent} /></mesh>
        </>}
        <mesh position={[0, -.065, .218]} rotation={[0, 0, Math.PI / 2]}><torusGeometry args={[.045, .009, 6, 12, Math.PI]} /><meshBasicMaterial color="#8d5545" /></mesh>
      </group>
    </group>
  );
});
BusinessAvatar3D.displayName = "BusinessAvatar3D";
