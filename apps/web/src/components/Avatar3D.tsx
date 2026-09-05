/**
 * Avatar3D · 真人风数字员工（KayKit CC0 角色 + 骨骼动画状态机）
 *
 * 形象系统 v2（真人风 GLTF 路线，评审决策①）：
 *  - 5 个 KayKit 冒险者角色（Knight/Mage/Rogue/Rogue_Hooded/Barbarian，CC0 可商用），
 *    76 组骨骼动画；贴图内嵌单文件；装备节点（剑/盾/盔/披风）可显隐做外观差异；
 *  - 岗位映射：角色选型 + 材质调色 + 手部道具挂点（handslot.r/l）；
 *  - 状态动画机：working=Idle+岗位动作 / asking=Interact 举手 / blocked=Hit_A /
 *    celebrating=Cheer / idle=Sit_Chair_Idle / disabled=Lie_Idle / 走位=Walking_A；
 *    crossFade 平滑过渡，帧率无关。
 *
 * 素材登记：oss-components.json → kaykit-adventurers（CC0，https://kaylousberg.itch.io/kaykit-adventurers）
 */
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { SkeletonUtils } from "three-stdlib";

/* ---------------- 岗位形象映射（角色选型 + 调色 + 工作动作） ---------------- */
export interface RoleSkin {
  model: "Knight" | "Mage" | "Rogue" | "Rogue_Hooded" | "Barbarian";
  tint?: string;          // 材质调色（覆盖贴图色；undefined=原贴图）
  workAction?: string;    // working 状态的岗位演绎动画
  cape?: boolean;         // Knight 披风（CEO 专属）
  helmetOff?: boolean;    // 去头盔（员工露脸，CEO 戴冠）
}

const MODEL_FILES: Record<RoleSkin["model"], string> = {
  Knight: "/models/kaykit/Knight.glb",
  Mage: "/models/kaykit/Mage.glb",
  Rogue: "/models/kaykit/Rogue.glb",
  Rogue_Hooded: "/models/kaykit/Rogue_Hooded.glb",
  Barbarian: "/models/kaykit/Barbarian.glb",
};

/** 岗位 → 形象（按名称关键词匹配，未命中按 hash 稳定分配） */
export function roleSkinOf(name: string, presetKey: string): RoleSkin {
  const k = `${name}${presetKey}`.toLowerCase();
  if (k.includes("ceo")) return { model: "Knight", cape: true, tint: "#ffd98a", workAction: "Idle" };
  // —— AI 产品经理团队（ai-pm 行业包；形象语义与岗位一致） ——
  if (k.includes("pm-staff") || k.includes("参谋")) return { model: "Knight", cape: true, tint: "#ffd98a", workAction: "Idle" };
  if (k.includes("requirement") || k.includes("需求")) return { model: "Rogue", workAction: "Use_Item" };
  if (k.includes("industry") || k.includes("瞭望")) return { model: "Rogue_Hooded", tint: "#8ad8ff", workAction: "1H_Ranged_Aiming" };
  if (k.includes("data") || k.includes("洞察")) return { model: "Mage", workAction: "Spellcasting" };
  if (k.includes("listener") || k.includes("倾听")) return { model: "Rogue", tint: "#a8e6ff", workAction: "Use_Item" };
  if (k.includes("doc-writer") || k.includes("主笔")) return { model: "Mage", workAction: "Spellcasting" };
  if (k.includes("release") || k.includes("护航")) return { model: "Barbarian", workAction: "PickUp" };
  if (k.includes("竞对") || k.includes("scout") || k.includes("competitor"))
    return { model: "Rogue_Hooded", workAction: "1H_Ranged_Aiming" };   // 举镜远眺
  if (k.includes("内容") || k.includes("content") || k.includes("writer"))
    return { model: "Mage", workAction: "Spellcasting" };               // 施法书写
  if (k.includes("评价") || k.includes("review") || k.includes("客服"))
    return { model: "Rogue", workAction: "Use_Item" };                  // 持平板处理
  if (k.includes("对账") || k.includes("账") || k.includes("finance"))
    return { model: "Barbarian", workAction: "PickUp" };                // 盘点核算
  if (k.includes("巡检") || k.includes("inspect"))
    return { model: "Barbarian", tint: "#8ad8ff", workAction: "Walking_A" };
  if (k.includes("前台") || k.includes("语音") || k.includes("voice"))
    return { model: "Rogue", tint: "#a8e6ff", workAction: "Idle" };
  if (k.includes("调价") || k.includes("价格") || k.includes("pricing") || k.includes("收益"))
    return { model: "Mage", tint: "#ffd98a", workAction: "Spellcast_Long" };
  // 稳定兜底：按 hash 分配四角色之一
  const pool: RoleSkin["model"][] = ["Knight", "Mage", "Rogue", "Barbarian"];
  let h = 0; for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) | 0;
  return { model: pool[Math.abs(h) % pool.length]!, workAction: "Idle" };
}

/* ---------------- 状态 → 动画（业务六态 + 走位，与 Floor 状态机一致） ---------------- */
export function stateAnimOf(state: string, moving: boolean, workAction = "Idle"): string {
  if (moving) return "Walking_A";
  switch (state) {
    case "asking": return "Interact";          // 举手请示
    case "blocked": return "Hit_A";            // 受阻踉跄
    case "celebrating": return "Cheer";        // 庆祝欢呼
    case "idle": return "Sit_Chair_Idle";      // 休息角坐下
    case "disabled": return "Lie_Idle";        // 躺平（入口）
    case "collab": return "Use_Item";          // 协作交互
    default: return workAction;                // working=岗位动作
  }
}

/* ---------------- 视线感知命令句柄（GazeSystem 专用） ---------------- */
export interface AvatarHandle {
  /** 抬头转向世界点 + 点头一次（头部骨骼缓动，自动衰减归位） */
  gazeNod: (worldPoint: THREE.Vector3) => void;
}

/* ---------------- 主组件 ---------------- */
export const Avatar3D = forwardRef<AvatarHandle, {
  skin: RoleSkin;
  state?: string;
  moving?: boolean;
  scale?: number;
  onClick?: () => void;
  onHover?: (hovered: boolean) => void;
}>(function Avatar3D({ skin, state = "working", moving = false, scale = 1, onClick, onHover }, ref) {
  const { scene, animations } = useGLTF(MODEL_FILES[skin.model]);
  const clone = useMemo(() => SkeletonUtils.clone(scene), [scene]);
  const mixer = useMemo(() => new THREE.AnimationMixer(clone), [clone]);
  const current = useRef<string>("");
  const group = useRef<THREE.Group>(null);

  /* 材质定制：调色 + 装备显隐（披风/头盔） */
  useEffect(() => {
    clone.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        const mesh = obj as THREE.Mesh;
        mesh.castShadow = true;
        const name = obj.name.toLowerCase();
        // 装备显隐
        if (skin.cape === false || (!skin.cape && name.includes("cape"))) obj.visible = false;
        if (skin.helmetOff && name.includes("helmet")) obj.visible = false;
        // 默认隐藏全部手持武器与战斗道具（职场不是战场：
        // 剑/盾/法杖/魔典/匕首/投掷物/弩/斧/酒杯——KayKit 武器节点一律隐藏）
        if (/sword|shield|wand|staff|spellbook|knife|throwable|crossbow|axe|mug/.test(name)) obj.visible = false;
        // 调色：原贴图色向 tint 轻混 35%（保留角色贴图质感，只罩色调；
        // 全量覆盖会把角色变成色块、强光下糊成一团——大片感走查根因修复）
        if (skin.tint) {
          const m = mesh.material as THREE.MeshStandardMaterial;
          if (m && m.color) {
            mesh.material = m.clone();
            (mesh.material as THREE.MeshStandardMaterial).color = m.color.clone().lerp(new THREE.Color(skin.tint), 0.35);
          }
        }
      }
    });
  }, [clone, skin]);

  /* 动画状态机：crossFade 切换 */
  useEffect(() => {
    const want = stateAnimOf(state, moving, skin.workAction);
    if (current.current === want) return;
    const clip = animations.find((c) => c.name === want) ?? animations.find((c) => c.name === "Idle");
    if (!clip) return;
    const next = mixer.clipAction(clip);
    next.reset();
    // 一次性动作（Hit/PickUp）也保持循环演绎（挂机观察态）
    next.setLoop(THREE.LoopRepeat, Infinity);
    const prevName = current.current;
    if (prevName) {
      const prevClip = animations.find((c) => c.name === prevName);
      if (prevClip) {
        const prev = mixer.clipAction(prevClip);
        next.crossFadeFrom(prev, 0.25, true);
      }
    }
    next.play();
    current.current = want;
  }, [state, moving, skin.workAction, animations, mixer]);

  /* —— 视线感知：头部骨骼 + gazeNod 句柄 —— */
  const headBone = useMemo<THREE.Object3D | null>(() => {
    let bone: THREE.Object3D | null = null;
    clone.traverse((o) => { if (!bone && /head/i.test(o.name)) bone = o as THREE.Object3D; });
    return bone;
  }, [clone]);
  const gaze = useRef<{ point: THREE.Vector3; until: number; nodAt: number } | null>(null);
  useImperativeHandle(ref, () => ({
    gazeNod: (worldPoint: THREE.Vector3) => {
      gaze.current = { point: worldPoint.clone(), until: performance.now() + 2600, nodAt: performance.now() + 250 };
    },
  }), []);

  useFrame((_, delta) => {
    mixer.update(delta);
    // 注视：头部缓动转向镜头点 + 一次点头，2.6s 后衰减归位
    const g = gaze.current;
    if (!g || !headBone || !group.current) return;
    const now = performance.now();
    const remain = (g.until - now) / 2600;
    if (remain <= 0) {
      headBone.rotation.y *= 0.85;
      headBone.rotation.x *= 0.85;
      gaze.current = null;
      return;
    }
    const weight = Math.min(1, remain * 2) * 0.65; // 进场快、出场缓
    const local = group.current.worldToLocal(g.point.clone());
    const headWorld = new THREE.Vector3();
    headBone.getWorldPosition(headWorld);
    group.current.worldToLocal(headWorld);
    const dy = Math.atan2(local.x - headWorld.x, local.z - headWorld.z);
    const targetY = THREE.MathUtils.clamp(dy, -0.9, 0.9) * weight;
    headBone.rotation.y += (targetY - headBone.rotation.y) * Math.min(1, delta * 8);
    // 点头：0.25s 后 X 轴一次正弦俯仰
    const nodT = now - g.nodAt;
    const nodX = nodT > 0 && nodT < 700 ? Math.sin((nodT / 700) * Math.PI) * 0.22 * weight : 0;
    headBone.rotation.x += (nodX - headBone.rotation.x) * Math.min(1, delta * 10);
  });

  return (
    <group ref={group} scale={scale}>
      <primitive
        object={clone}
        onClick={onClick ? (e: { stopPropagation: () => void }) => { e.stopPropagation(); onClick(); } : undefined}
        onPointerOver={onHover ? (e: { stopPropagation: () => void }) => { e.stopPropagation(); onHover(true); } : undefined}
        onPointerOut={onHover ? () => onHover(false) : undefined}
      />
    </group>
  );
});
Avatar3D.displayName = "Avatar3D";

/* 预加载全部角色（首屏不卡） */
export function preloadAvatars() {
  Object.values(MODEL_FILES).forEach((f) => useGLTF.preload(f));
}
