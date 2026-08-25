/**
 * Floor 数字办公区（D25）——等距 2.5D 办公区 Canvas 渲染器
 *
 * 纪律：零素材（纯 Canvas 程序化绘制）；员工每个动作来自 theater.floor 派生态（动作即数据）。
 * 渲染模型：逻辑网格 (x,y) → 等距屏幕坐标；员工位置逐帧插值（走位动画）；
 * 五态动画：working=打字 / blocked=踱步 / asking=走到指挥台举手+聚光灯 / celebrating=跳跃+彩带 / idle=休息角待命。
 * 交互：点员工 → 回调父级（绩效卡）；点请示员工 → 弹出审批卡（原地三手势）。
 */
import { useEffect, useRef } from "react";

/* ================= 类型（与 base/captain/floor.ts 对齐） ================= */
export interface FloorAgent {
  id: string; presetKey: string; name: string;
  state: "working" | "asking" | "blocked" | "celebrating" | "collab" | "idle" | "disabled";
  stationId: string | null;
  currentThread: { id: string; title: string } | null;
  pendingTier: string | null;
  approvalId: string | null;
  statusLine: string;
}
export interface FloorScene {
  id: string; name: string;
  theme: { floorA: string; floorB: string; wall: string; accent: string; night: boolean };
  grid: { w: number; h: number };
  stations: Array<{ id: string; x: number; y: number; kind: string }>;
  props: Array<{ kind: string; x: number; y: number; label?: string }>;
  ceoDesk: { x: number; y: number };
  lounge: { x: number; y: number };
  entrance: { x: number; y: number };
}
export interface FloorPayload { scene: FloorScene; agents: FloorAgent[] }

/* ================= 员工运行时（位置/动画） ================= */
interface ActorRt {
  x: number; y: number;           // 当前逻辑坐标
  tx: number; ty: number;         // 目标逻辑坐标
  phase: number;                  // 动画相位
  state: FloorAgent["state"];
  confetti: Array<{ x: number; y: number; vx: number; vy: number; c: string; life: number }>;
  enteredAt: number;
}

const CONFETTI_COLORS = ["#ffd98a", "#8ad8ff", "#6adf8a", "#ff8a8a", "#e8a2ff"];

export function FloorView({
  floor, ceoName, onPickAgent, onDecide, onPickApproval,
}: {
  floor: FloorPayload;
  ceoName: string;
  onPickAgent: (a: FloorAgent) => void;
  onDecide: (approvalId: string, gesture: "approve" | "reject") => void;
  onPickApproval: (a: FloorAgent) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const actors = useRef<Map<string, ActorRt>>(new Map());
  const hitboxes = useRef<Array<{ id: string; sx: number; sy: number; r: number }>>([]);
  const floorRef = useRef(floor);
  floorRef.current = floor;

  /* 目标点位计算（同工位多名员工按 id hash 微偏移站位；无工位溢出者才去休息角） */
  const targetOf = (a: FloorAgent, scene: FloorScene): { x: number; y: number } => {
    const st = scene.stations.find((s) => s.id === a.stationId);
    const jx = ((hash(a.id) % 5) - 2) * 0.16, jy = ((hash(a.id) % 3) - 1) * 0.18;
    switch (a.state) {
      case "asking": return { x: scene.ceoDesk.x + 0.1 + jx, y: scene.ceoDesk.y + 1.1 + jy };
      case "blocked": return st ? { x: st.x + jx, y: st.y + 0.7 + jy } : { x: scene.grid.w / 2, y: scene.grid.h / 2 };
      case "idle":
        return st
          ? { x: st.x + jx * 1.4, y: st.y + 0.55 + jy }
          : { x: scene.lounge.x + (hash(a.id) % 10) / 14 - 0.35, y: scene.lounge.y + (hash(a.id) % 6) / 12 - 0.25 };
      case "disabled": return { x: scene.entrance.x, y: scene.entrance.y };
      default: return st ? { x: st.x + jx, y: st.y + jy * 0.5 } : { x: scene.lounge.x + jx * 2, y: scene.lounge.y + jy * 2 };
    }
  };

  useEffect(() => {
    const cv = ref.current!;
    const ctx = cv.getContext("2d")!;
    let raf = 0;
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    const frame = () => {
      const scene = floorRef.current.scene;
      const W = cv.offsetWidth, H = cv.offsetHeight;
      if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      const gw = scene.grid.w, gh = scene.grid.h;
      // 等距铺满：地图宽=(gw+gh)·tileW/2，高=(gw+gh)·tileW/4；取容器 92% 宽与 78% 高的较小约束
      const tileW = Math.min((W * 0.92 * 2) / (gw + gh), (H * 0.78 * 4) / (gw + gh));
      const tileH = tileW / 2;
      const cx = W / 2, cy = H * 0.1;
      const iso = (x: number, y: number) => ({ sx: cx + (x - y) * (tileW / 2), sy: cy + (x + y) * (tileH / 2) });
      const now = performance.now() / 1000;

      /* 地板 */
      const p0 = iso(0, 0), p1 = iso(gw, 0), p2 = iso(gw, gh), p3 = iso(0, gh);
      const grad = ctx.createLinearGradient(p0.sx, p0.sy, p2.sx, p2.sy);
      grad.addColorStop(0, scene.theme.floorA); grad.addColorStop(1, scene.theme.floorB);
      ctx.beginPath();
      ctx.moveTo(p0.sx, p0.sy); ctx.lineTo(p1.sx, p1.sy); ctx.lineTo(p2.sx, p2.sy); ctx.lineTo(p3.sx, p3.sy);
      ctx.closePath(); ctx.fillStyle = grad; ctx.fill();
      ctx.strokeStyle = scene.theme.wall; ctx.lineWidth = 2; ctx.stroke();
      ctx.strokeStyle = "rgba(255,255,255,.05)"; ctx.lineWidth = 1;
      for (let i = 1; i < gw; i++) { const a = iso(i, 0), b = iso(i, gh); ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke(); }
      for (let j = 1; j < gh; j++) { const a = iso(0, j), b = iso(gw, j); ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke(); }

      /* 工位家具（员工站在工位后） */
      for (const st of scene.stations) {
        const { sx, sy } = iso(st.x, st.y);
        if (st.kind === "counter") {
          // 前台柜台（宽体）
          ctx.fillStyle = "#4a3a28"; roundRect(ctx, sx - 22, sy - 12, 44, 14, 3); ctx.fill();
          ctx.fillStyle = "#6a5638"; roundRect(ctx, sx - 22, sy - 14, 44, 5, 2); ctx.fill();
          ctx.fillStyle = "#101018"; roundRect(ctx, sx - 8, sy - 22, 16, 10, 1.5); ctx.fill();
          ctx.fillStyle = "#45e0ff"; ctx.globalAlpha = 0.6; ctx.fillRect(sx - 6, sy - 20, 12, 2); ctx.globalAlpha = 1;
        } else if (st.kind === "bench") {
          ctx.fillStyle = "#3a5a6a"; roundRect(ctx, sx - 16, sy - 8, 32, 10, 4); ctx.fill();
        } else if (st.kind === "monitor") {
          ctx.fillStyle = "#101018"; roundRect(ctx, sx - 14, sy - 26, 28, 18, 2); ctx.fill();
          ctx.strokeStyle = "#4a4a66"; ctx.strokeRect(sx - 14, sy - 26, 28, 18);
          ctx.fillStyle = "#6adf8a"; ctx.globalAlpha = 0.7; ctx.fillRect(sx - 10, sy - 22, 8, 2); ctx.fillRect(sx - 10, sy - 18, 14, 2); ctx.globalAlpha = 1;
          ctx.strokeStyle = "#4a4a66"; ctx.beginPath(); ctx.moveTo(sx, sy - 8); ctx.lineTo(sx, sy); ctx.stroke();
        } else {
          // desk：桌面 + 显示器
          ctx.fillStyle = "#38384c"; roundRect(ctx, sx - 16, sy - 8, 32, 10, 2); ctx.fill();
          ctx.fillStyle = "#2a2a3a"; roundRect(ctx, sx - 16, sy - 10, 32, 4, 2); ctx.fill();
          ctx.fillStyle = "#101018"; roundRect(ctx, sx - 6, sy - 20, 14, 10, 1.5); ctx.fill();
          ctx.fillStyle = "#45e0ff"; ctx.globalAlpha = 0.55; ctx.fillRect(sx - 4, sy - 18, 10, 2); ctx.fillRect(sx - 4, sy - 15, 6, 2); ctx.globalAlpha = 1;
        }
      }

      /* 道具 */
      for (const pr of scene.props) {
        const { sx, sy } = iso(pr.x, pr.y);
        if (pr.kind === "plant") {
          ctx.fillStyle = "#2a5a3a"; ctx.beginPath(); ctx.ellipse(sx, sy - 6, 7, 9, 0, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = "#6a4a2a"; ctx.fillRect(sx - 4, sy, 8, 5);
        } else if (pr.kind === "sofa") {
          ctx.fillStyle = "#3a5a6a"; roundRect(ctx, sx - 14, sy - 8, 28, 12, 4); ctx.fill();
        } else if (pr.kind === "coffee") {
          ctx.fillStyle = "#8a8a9a"; roundRect(ctx, sx - 5, sy - 12, 10, 14, 2); ctx.fill();
          ctx.fillStyle = "#c8a24a"; ctx.fillRect(sx - 3, sy - 10, 6, 3);
        } else if (pr.kind === "whiteboard") {
          ctx.fillStyle = "#e8e8f022"; roundRect(ctx, sx - 16, sy - 22, 32, 20, 2); ctx.fill();
          ctx.strokeStyle = "#8ad8ff66"; ctx.strokeRect(sx - 16, sy - 22, 32, 20);
        } else if (pr.kind === "luggage") {
          ctx.fillStyle = "#7a5a3a"; roundRect(ctx, sx - 8, sy - 8, 16, 10, 3); ctx.fill();
        } else if (pr.kind === "camera") {
          ctx.fillStyle = "#2a2a3a"; roundRect(ctx, sx - 9, sy - 14, 18, 12, 2); ctx.fill();
          ctx.beginPath(); ctx.arc(sx, sy - 8, 4, 0, Math.PI * 2); ctx.fillStyle = "#101018"; ctx.fill();
          ctx.strokeStyle = "#8a8a9a"; ctx.beginPath(); ctx.moveTo(sx, sy - 2); ctx.lineTo(sx - 6, sy + 8); ctx.moveTo(sx, sy - 2); ctx.lineTo(sx + 6, sy + 8); ctx.stroke();
        } else if (pr.kind === "light") {
          ctx.fillStyle = "#ffd98a33"; ctx.beginPath(); ctx.moveTo(sx, sy - 26); ctx.lineTo(sx - 10, sy); ctx.lineTo(sx + 10, sy); ctx.closePath(); ctx.fill();
          ctx.fillStyle = "#3a3a4a"; ctx.fillRect(sx - 2, sy - 30, 4, 30);
        } else if (pr.kind === "greenscreen") {
          ctx.fillStyle = "#1a6a3a"; roundRect(ctx, sx - 20, sy - 26, 40, 26, 2); ctx.fill();
        } else if (pr.kind === "clapper") {
          ctx.fillStyle = "#2a2a3a"; roundRect(ctx, sx - 8, sy - 12, 16, 12, 2); ctx.fill();
          ctx.fillStyle = "#e8e8f0"; for (let i = 0; i < 3; i++) ctx.fillRect(sx - 8 + i * 6, sy - 12, 3, 4);
        } else if (pr.kind === "board") {
          ctx.fillStyle = "#26303a"; roundRect(ctx, sx - 18, sy - 20, 36, 18, 2); ctx.fill();
          ctx.fillStyle = "#6adf8a"; for (let i = 0; i < 4; i++) ctx.fillRect(sx - 14 + i * 8, sy - 16, 5, 3);
          ctx.fillStyle = "#ffbe6a"; ctx.fillRect(sx - 14, sy - 10, 5, 3);
        }
        if (pr.label) { ctx.fillStyle = "#9a9aa8"; ctx.font = "8px sans-serif"; ctx.textAlign = "center"; ctx.fillText(pr.label, sx, sy + 12); }
      }

      /* CEO 指挥台 */
      const cd = iso(scene.ceoDesk.x, scene.ceoDesk.y);
      ctx.beginPath();
      ctx.ellipse(cd.sx, cd.sy, tileW * 0.55, tileH * 0.55, 0, 0, Math.PI * 2);
      ctx.fillStyle = "#3a2f1a"; ctx.fill(); ctx.strokeStyle = "#c8a24a"; ctx.lineWidth = 1.5; ctx.stroke();
      const pulse = 0.7 + 0.3 * Math.sin(now * 2);
      const glow = ctx.createRadialGradient(cd.sx, cd.sy - 18, 2, cd.sx, cd.sy - 18, 26 * pulse);
      glow.addColorStop(0, "rgba(255,217,138,.85)"); glow.addColorStop(1, "rgba(255,217,138,0)");
      ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(cd.sx, cd.sy - 18, 26 * pulse, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "#ffd98a"; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.ellipse(cd.sx, cd.sy - 20, 6, 9, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = "#ffd98a"; ctx.font = "bold 9px sans-serif"; ctx.textAlign = "center";
      ctx.fillText(ceoName, cd.sx, cd.sy + 14);

      /* 员工：更新目标 + 插值走位（先清理已离场员工的运行时，防泄漏） */
      const alive = new Set(floorRef.current.agents.map((a) => a.id));
      for (const id of [...actors.current.keys()]) {
        if (!alive.has(id)) actors.current.delete(id);
      }
      hitboxes.current = [];
      const list = floorRef.current.agents;
      const sorted = [...list].sort((a, b) => { // 远的先画（遮挡）
        const ta = targetOf(a, scene), tb = targetOf(b, scene);
        return ta.x + ta.y - (tb.x + tb.y);
      });
      for (const a of sorted) {
        if (a.state === "disabled") continue;
        let rt = actors.current.get(a.id);
        const tgt = targetOf(a, scene);
        if (!rt) {
          rt = { x: scene.entrance.x, y: scene.entrance.y, tx: tgt.x, ty: tgt.y, phase: Math.random() * 6.28, state: a.state, confetti: [], enteredAt: now };
          actors.current.set(a.id, rt);
        }
        if (rt.state !== a.state) { rt.state = a.state; rt.enteredAt = now; if (a.state === "celebrating") spawnConfetti(rt); }
        // blocked：绕工位踱步（往返两锚点）
        if (a.state === "blocked") {
          const swing = Math.sin(now * 1.6 + rt.phase) * 0.55;
          rt.tx = tgt.x + swing; rt.ty = tgt.y + Math.abs(swing) * 0.3;
        } else { rt.tx = tgt.x; rt.ty = tgt.y; }
        const speed = a.state === "asking" ? 0.06 : 0.045;
        rt.x += (rt.tx - rt.x) * speed; rt.y += (rt.ty - rt.y) * speed;
        rt.phase += 0.08;

        const { sx, sy } = iso(rt.x, rt.y);
        const walking = Math.abs(rt.tx - rt.x) + Math.abs(rt.ty - rt.y) > 0.08;
        drawAgent(ctx, sx, sy, rt, a, now, walking);
        hitboxes.current.push({ id: a.id, sx, sy: sy - 14, r: 16 });

        /* 彩带粒子 */
        for (const c of rt.confetti) {
          c.x += c.vx; c.y += c.vy; c.vy += 0.06; c.life -= 0.016;
          if (c.life > 0) { ctx.fillStyle = c.c; ctx.globalAlpha = Math.min(1, c.life); ctx.fillRect(sx + c.x, sy - 34 + c.y, 3, 3); ctx.globalAlpha = 1; }
        }
        rt.confetti = rt.confetti.filter((c) => c.life > 0);
        if (a.state === "celebrating" && now - rt.enteredAt < 3 && Math.random() < 0.08) spawnConfetti(rt, 2);

        /* 名牌 + 气泡 */
        ctx.font = "8.5px sans-serif"; ctx.textAlign = "center";
        ctx.fillStyle = "rgba(10,10,18,.72)";
        const label = a.name.replace(/^agt-/, "");
        const lw = ctx.measureText(label).width + 10;
        roundRect(ctx, sx - lw / 2, sy + 6, lw, 12, 6); ctx.fill();
        ctx.fillStyle = "#e8e8f0"; ctx.fillText(label, sx, sy + 15);
        if (a.state === "asking") {
          bubble(ctx, sx, sy - 46, a.pendingTier === "l4_chairman" ? "请您定（董事长级）" : "请您定", "#ffbe6a");
          // 聚光灯
          const sp = ctx.createRadialGradient(sx, sy, 2, sx, sy, 30);
          sp.addColorStop(0, "rgba(255,190,106,.28)"); sp.addColorStop(1, "rgba(255,190,106,0)");
          ctx.fillStyle = sp; ctx.beginPath(); ctx.ellipse(sx, sy, 30, 14, 0, 0, Math.PI * 2); ctx.fill();
        } else if (a.state === "blocked") {
          bubble(ctx, sx, sy - 46, "!", "#ffbe6a");
        } else if (a.state === "working" && a.currentThread) {
          ctx.fillStyle = "#6adf8a"; ctx.font = "8px sans-serif";
          const dots = "▮".repeat(1 + (Math.floor(now * 2 + rt.phase) % 3));
          ctx.fillText(dots, sx, sy - 38);
        }
      }

      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ceoName]);

  /* 点击：命中员工 → 请示卡 / 绩效卡（绘制顺序远→近，点击逆序=上层优先） */
  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    for (const h of [...hitboxes.current].reverse()) {
      if ((mx - h.sx) ** 2 + (my - h.sy) ** 2 < h.r ** 2 * 2.2) {
        const agent = floorRef.current.agents.find((a) => a.id === h.id);
        if (!agent) return;
        if (agent.state === "asking" && agent.approvalId) onPickApproval(agent);
        else onPickAgent(agent);
        return;
      }
    }
  };

  return (
    <canvas
      ref={ref}
      onClick={onClick}
      className="h-[380px] w-full cursor-pointer sm:h-[440px]"
      data-scene={floor.scene.id}
    />
  );
}

/* ================= 绘制原语 ================= */
function hash(s: string): number { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function spawnConfetti(rt: ActorRt, n = 14) {
  for (let i = 0; i < n; i++) {
    rt.confetti.push({
      x: (Math.random() - 0.5) * 24, y: -Math.random() * 8,
      vx: (Math.random() - 0.5) * 1.6, vy: -Math.random() * 2 - 0.5,
      c: CONFETTI_COLORS[i % CONFETTI_COLORS.length]!, life: 1 + Math.random(),
    });
  }
}
function bubble(ctx: CanvasRenderingContext2D, sx: number, sy: number, text: string, color: string) {
  ctx.font = "bold 9px sans-serif"; ctx.textAlign = "center";
  const w = ctx.measureText(text).width + 12;
  ctx.fillStyle = "rgba(20,20,32,.88)";
  roundRect(ctx, sx - w / 2, sy - 9, w, 15, 7); ctx.fill();
  ctx.strokeStyle = color; ctx.lineWidth = 1; roundRect(ctx, sx - w / 2, sy - 9, w, 15, 7); ctx.stroke();
  ctx.fillStyle = color; ctx.fillText(text, sx, sy + 2);
}

const SKIN: Record<string, [string, string]> = {
  working: ["#6adf8a", "#2a8a4a"], asking: ["#8ad8ff", "#3a9ec8"], blocked: ["#ffbe6a", "#c8842a"],
  celebrating: ["#8ad8ff", "#3a9ec8"], collab: ["#e8a2ff", "#8a4ac8"], idle: ["#9a9aa8", "#5a5a68"], disabled: ["#666", "#444"],
};

function drawAgent(ctx: CanvasRenderingContext2D, sx: number, sy: number, rt: ActorRt, a: FloorAgent, now: number, walking: boolean) {
  const [head, body] = SKIN[a.state] ?? SKIN.idle!;
  let jump = 0;
  if (a.state === "celebrating") jump = Math.abs(Math.sin((now - rt.enteredAt) * 6)) * 10;
  const bob = walking ? Math.abs(Math.sin(rt.phase * 2)) * 2 : a.state === "idle" ? Math.sin(now + rt.phase) * 0.8 : 0;
  const y0 = sy - jump - bob;
  // 影
  ctx.fillStyle = "rgba(0,0,0,.3)";
  ctx.beginPath(); ctx.ellipse(sx, sy + 2, 8 - jump * 0.3, 3, 0, 0, Math.PI * 2); ctx.fill();
  // 身
  ctx.fillStyle = body;
  roundRect(ctx, sx - 5, y0 - 16, 10, 14, 3); ctx.fill();
  // 头
  ctx.fillStyle = head;
  ctx.beginPath(); ctx.arc(sx, y0 - 21, 6, 0, Math.PI * 2); ctx.fill();
  // 手臂动作
  ctx.strokeStyle = head; ctx.lineWidth = 2; ctx.lineCap = "round";
  if (a.state === "asking") {
    ctx.beginPath(); ctx.moveTo(sx + 4, y0 - 13); ctx.lineTo(sx + 10, y0 - 26); ctx.stroke(); // 举手
  } else if (a.state === "working") {
    const tap = Math.sin(now * 10 + rt.phase) * 1.6;
    ctx.beginPath(); ctx.moveTo(sx + 4, y0 - 12); ctx.lineTo(sx + 9, y0 - 8 + tap); ctx.stroke(); // 打字
    // 屏幕
    ctx.fillStyle = "#101018"; roundRect(ctx, sx + 8, y0 - 16, 12, 9, 1.5); ctx.fill();
    ctx.fillStyle = "#45e0ff"; ctx.globalAlpha = 0.5 + 0.5 * Math.abs(Math.sin(now * 3 + rt.phase));
    ctx.fillRect(sx + 10, y0 - 14, 8, 1.5); ctx.fillRect(sx + 10, y0 - 11, 5, 1.5); ctx.globalAlpha = 1;
  } else if (walking || a.state === "blocked") {
    const swing = Math.sin(rt.phase * 2) * 4;
    ctx.beginPath(); ctx.moveTo(sx - 4, y0 - 12); ctx.lineTo(sx - 7, y0 - 6 + swing * 0.4); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(sx + 4, y0 - 12); ctx.lineTo(sx + 7, y0 - 6 - swing * 0.4); ctx.stroke();
  } else if (a.state === "celebrating") {
    ctx.beginPath(); ctx.moveTo(sx - 4, y0 - 13); ctx.lineTo(sx - 9, y0 - 24); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(sx + 4, y0 - 13); ctx.lineTo(sx + 9, y0 - 24); ctx.stroke(); // 双手举起
  }
}
