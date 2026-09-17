/**
 * 工作台框架（F1：壳 + 顶栏，视觉事实源=原型 V4.0 .frame/.abar/.night-pill/.brk，D5）
 *  - 星野背景（设计公理 Ⅰ/§7 drift 90s：星云渐变层 + 星点层，禁死黑满铺；reduced-motion 降级静态）
 *  - HUD 四角金色刻度（原型 .frame::before/::after/.bc：18px·2px·贴边·随 20px 圆角）
 *  - 顶栏只显示工作区与运行控制，所有页面级导航统一归入左侧主导航；
 *  - 三栏以容器宽度响应式降级，不再把 1180px 固定画布叠加到导航和 AI 助手栏上。
 * 内部数据为占位；逐页接线真实 API 在 F3–F11。
 */
import { Icon, Overlay, TopContextBar } from "@workloom/ui";
import type { CSSProperties, ReactNode } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { EmergencyBrake, NightStatusPill } from "../components/hud";
import { SimBanner } from "../components/SimBanner";
import { SkillDistBanner } from "../components/SkillDistBanner";
import { COMMON_STATUS_TEXT, dictText, shortId } from "../lib/display";
import { PlanSwitcher } from "./PlanSwitcher";

/** 星野背景（氛围层；永不遮挡信息、不影响 G10 首屏口径——§7 动效纪律） */
function StarField() {
  return (
    <div className="pointer-events-none fixed inset-0 overflow-hidden" aria-hidden>
      {/* 星云晕染层（星云紫仅出现在背景晕染——§2.2） */}
      <div
        className="absolute inset-0 animate-drift"
        style={{
          background:
            "radial-gradient(60% 45% at 18% 8%, rgb(37 42 48 / .55), transparent 70%)," +
            "radial-gradient(50% 40% at 85% 20%, rgb(26 31 38 / .5), transparent 70%)," +
            "radial-gradient(70% 50% at 50% 110%, rgb(18 22 28 / .6), transparent 70%)",
        }}
      />
      {/* 星点层（确定性伪随机分布；随 drift 同层缓漂） */}
      <div
        className="absolute inset-0 animate-drift"
        style={{
          backgroundImage:
            "radial-gradient(1px 1px at 12% 22%, rgb(214 220 228 / .5) 50%, transparent 51%)," +
            "radial-gradient(1px 1px at 34% 68%, rgb(214 220 228 / .3) 50%, transparent 51%)," +
            "radial-gradient(1.5px 1.5px at 57% 15%, rgb(143 169 201 / .45) 50%, transparent 51%)," +
            "radial-gradient(1px 1px at 72% 47%, rgb(214 220 228 / .35) 50%, transparent 51%)," +
            "radial-gradient(1px 1px at 88% 78%, rgb(214 220 228 / .35) 50%, transparent 51%)," +
            "radial-gradient(1.5px 1.5px at 25% 88%, rgb(179 198 222 / .45) 50%, transparent 51%)," +
            "radial-gradient(1px 1px at 45% 40%, rgb(214 220 228 / .35) 50%, transparent 51%)," +
            "radial-gradient(1px 1px at 66% 90%, rgb(214 220 228 / .35) 50%, transparent 51%)," +
            "radial-gradient(1px 1px at 94% 10%, rgb(214 220 228 / .3) 50%, transparent 51%)," +
            "radial-gradient(1.5px 1.5px at 8% 55%, rgb(143 169 201 / .35) 50%, transparent 51%)",
        }}
      />
    </div>
  );
}

/** HUD 四角金色刻度（原型 .frame::before/::after/.bc：18px·2px·贴边·随工作台圆角） */
function CornerTicks() {
  const base = "pointer-events-none absolute h-[18px] w-[18px] border-2 border-gold z-10";
  return (
    <>
      <span className={`${base} -top-px -left-px rounded-tl-bridge border-r-0 border-b-0`} />
      <span className={`${base} -top-px -right-px rounded-tr-bridge border-l-0 border-b-0`} />
      <span className={`${base} -bottom-px -left-px rounded-bl-bridge border-r-0 border-t-0`} />
      <span className={`${base} -bottom-px -right-px rounded-br-bridge border-l-0 border-t-0`} />
    </>
  );
}



export function Bridge({
  children,
  left,
  right,
}: {
  children: ReactNode;
  /** 左栏会话列表（P1 起由页面注入真实数据；缺省为占位） */
  left?: ReactNode;
  /** 右栏上下文面板（同上） */
  right?: ReactNode;
}) {
  // 当前版本（F7.2）：社区版隐藏夜班胶囊与制动杆（隐藏非置灰 E2.6；F12 权限态演示）
  const [plan, setPlan] = useState<string | null>(null);
  const [leftVisible, setLeftVisible] = useState(true);
  const [rightVisible, setRightVisible] = useState(true);
  const [leftWidth, setLeftWidth] = useState(() => Number(localStorage.getItem("workloom.pc.panel.left-width")) || 236);
  const [rightWidth, setRightWidth] = useState(() => Number(localStorage.getItem("workloom.pc.panel.right-width")) || 264);
  // ResizeObserver 首次回报前按最窄安全布局渲染，避免在嵌套工作区中先塞入
  // 512px 固定侧栏、下一帧再收起所造成的首帧横向溢出与视觉闪动。
  const [containerWidth, setContainerWidth] = useState(0);
  const [drawer, setDrawer] = useState<"left" | "right" | null>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const community = plan === "community";
  const workspaceLabel = typeof document === "undefined"
    ? "当前工作区"
    : (document.title.split("·").slice(1).join("·").trim() || "当前工作区");
  const compact = containerWidth <= 880;
  const narrow = containerWidth <= 650;
  const leftInGrid = leftVisible && !narrow;
  const rightInGrid = rightVisible && !compact;

  useLayoutEffect(() => {
    const node = shellRef.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setContainerWidth(entry?.contentRect.width ?? node.clientWidth));
    setContainerWidth(node.clientWidth);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("workloom.pc.panel.left-width", String(leftWidth));
      localStorage.setItem("workloom.pc.panel.right-width", String(rightWidth));
    } catch { /* 当前会话尺寸仍有效 */ }
  }, [leftWidth, rightWidth]);

  useEffect(() => {
    const reset = () => {
      setLeftVisible(true); setRightVisible(true); setLeftWidth(236); setRightWidth(264); setDrawer(null);
      try {
        localStorage.removeItem("workloom.pc.panel.left-width");
        localStorage.removeItem("workloom.pc.panel.right-width");
      } catch { /* 当前会话已恢复 */ }
    };
    const panels = (event: Event) => {
      const action = (event as CustomEvent<"show" | "hide">).detail;
      setDrawer(null);
      setLeftVisible(action === "show");
      setRightVisible(action === "show");
    };
    window.addEventListener("workloom:reset-layout", reset);
    window.addEventListener("workloom:workspace-panels", panels);
    return () => {
      window.removeEventListener("workloom:reset-layout", reset);
      window.removeEventListener("workloom:workspace-panels", panels);
    };
  }, []);

  const resize = (side: "left" | "right", start: React.PointerEvent<HTMLDivElement>) => {
    start.currentTarget.setPointerCapture(start.pointerId);
    const origin = start.clientX;
    const initial = side === "left" ? leftWidth : rightWidth;
    const onMove = (event: PointerEvent) => {
      const delta = event.clientX - origin;
      const next = Math.max(180, Math.min(420, initial + (side === "left" ? delta : -delta)));
      if (side === "left") setLeftWidth(next); else setRightWidth(next);
    };
    const done = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", done);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", done, { once: true });
  };

  const resizeByKey = (side: "left" | "right", event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const logicalDelta = event.key === "ArrowRight" ? 16 : -16;
    if (side === "left") setLeftWidth((value) => Math.max(180, Math.min(420, value + logicalDelta)));
    else setRightWidth((value) => Math.max(180, Math.min(420, value - logicalDelta)));
  };

  const leftContent = left ?? (<>
    <div className="mb-2 px-1 text-body tracking-[.2em] text-ink3">任务会话</div>
    {[
      { id: "T-101", title: "本周经营复盘", status: "completed", cls: "text-go" },
      { id: "T-102", title: "待审批事项处理", status: "pending_review", cls: "text-warn" },
      { id: "T-103", title: "重点任务推进", status: "running", cls: "text-holo" },
    ].map((task) => (
      <div key={task.id} className="mb-1.5 min-w-0 rounded-lg border border-line bg-card px-3 py-2.5">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-1">
          <span className="text-body text-ink3">任务{shortId(task.id)}</span>
          <span className={`text-body ${task.cls}`}>{dictText(COMMON_STATUS_TEXT, task.status)}</span>
        </div>
        <div className="mt-1 break-words text-body text-ink2">{task.title}</div>
      </div>
    ))}
  </>);
  const rightContent = right ?? (<>
    <div className="mb-2 px-1 text-body tracking-[.2em] text-ink3">任务上下文</div>
    <div className="rounded-lg border border-line bg-card p-3 text-body leading-relaxed text-ink3">
      当前任务的业务档案、阶段、目标和依据会显示在这里。
    </div>
  </>);
  const gridStyle = {
    gridTemplateColumns: `${leftInGrid ? leftWidth : 0}px ${leftInGrid ? 6 : 0}px minmax(0,1fr) ${rightInGrid ? 6 : 0}px ${rightInGrid ? rightWidth : 0}px`,
  } satisfies CSSProperties;
  const toggleLeft = () => {
    if (narrow) setDrawer("left");
    else setLeftVisible((visible) => !visible);
  };
  const toggleRight = () => {
    if (compact) setDrawer("right");
    else setRightVisible((visible) => !visible);
  };
  return (
    <div className="wl-bridge-viewport min-h-screen min-w-0 w-full overflow-x-clip bg-bg950">
      <StarField />
      <div className="relative flex min-h-screen min-w-0 items-start justify-center px-3 py-8">
        <div ref={shellRef} className="wl-bridge-shell relative w-full min-w-0 max-w-[var(--wl-content-max)] overflow-hidden rounded-bridge border border-line bg-gradient-to-b from-bg900 to-bg950 shadow-[0_30px_80px_rgba(0,0,0,.5)]">
          <CornerTicks />

          {/* 顶栏（原型 V4.0 .abar chrome 条） */}
          <TopContextBar
            className="border-b border-line bg-bg950/90 px-4.5 py-2.5 backdrop-blur-md"
            title={(
              <span className="min-w-0 break-words text-body font-normal text-ink3">
                企业数字员工即时协作 · <b className="font-semibold text-ink2">{workspaceLabel}</b>
              </span>
            )}
            actions={(
              <>
                <button type="button" onClick={toggleLeft} className="flex min-h-9 items-center gap-1 rounded-lg border border-line px-2.5 text-body text-ink2 hover:border-gline hover:text-gold" aria-label={leftInGrid ? "隐藏任务会话面板" : "显示任务会话面板"} aria-pressed={leftInGrid}>
                  <Icon name="inbox" size={15} />会话
                </button>
                <button type="button" onClick={toggleRight} className="flex min-h-9 items-center gap-1 rounded-lg border border-line px-2.5 text-body text-ink2 hover:border-gline hover:text-gold" aria-label={rightInGrid ? "隐藏任务上下文面板" : "显示任务上下文面板"} aria-pressed={rightInGrid}>
                  <Icon name="workspace" size={15} />上下文
                </button>
                <PlanSwitcher onPlan={setPlan} />
                {!community && <NightStatusPill />}
                {!community && <EmergencyBrake />}
              </>
            )}
          />


          {/* 模拟数据横幅（D24：模拟态/mock 模型常显，引导落地向导接入真实数据） */}
          <SimBanner />
          {/* 技能更新通栏（技能保鲜环：夜班自动更新提示 / L2 待审批引导） */}
          <SkillDistBanner />

          {/* IM 工作区：用户可折叠、隐藏、拖拽缩放；窄屏降级为抽屉。 */}
          <div className="wl-bridge-grid wl-bridge-grid--managed grid min-h-[640px] min-w-0" style={gridStyle}>
            <aside hidden={!leftInGrid} className="wl-bridge-left min-w-0 overflow-auto border-r border-line p-3" style={{ gridColumn: 1 }}>
              {leftInGrid ? leftContent : null}
            </aside>
            <div
              hidden={!leftInGrid}
              role="separator"
              tabIndex={leftInGrid ? 0 : -1}
              aria-label="调整任务会话面板宽度"
              aria-orientation="vertical"
              aria-valuemin={180}
              aria-valuemax={420}
              aria-valuenow={leftWidth}
              onPointerDown={(event) => resize("left", event)}
              onKeyDown={(event) => resizeByKey("left", event)}
              className="cursor-col-resize bg-line/40 transition-colors hover:bg-gline focus:bg-gline"
              style={{ gridColumn: 2 }}
            />
            <main className="min-w-0 overflow-x-clip p-5" style={{ gridColumn: 3 }}>{children}</main>
            <div
              hidden={!rightInGrid}
              role="separator"
              tabIndex={rightInGrid ? 0 : -1}
              aria-label="调整任务上下文面板宽度"
              aria-orientation="vertical"
              aria-valuemin={180}
              aria-valuemax={420}
              aria-valuenow={rightWidth}
              onPointerDown={(event) => resize("right", event)}
              onKeyDown={(event) => resizeByKey("right", event)}
              className="cursor-col-resize bg-line/40 transition-colors hover:bg-gline focus:bg-gline"
              style={{ gridColumn: 4 }}
            />
            <aside hidden={!rightInGrid} className="wl-bridge-right min-w-0 overflow-auto border-l border-line p-3" style={{ gridColumn: 5 }}>
              {rightInGrid ? rightContent : null}
            </aside>
          </div>
          <Overlay open={drawer === "left"} onClose={() => setDrawer(null)} kind="drawer" side="left" title="任务会话" description="选择任务后返回工作区继续处理。">
            {leftContent}
          </Overlay>
          <Overlay open={drawer === "right"} onClose={() => setDrawer(null)} kind="drawer" side="right" title="任务上下文" description="查看当前任务的业务依据和进展。">
            {rightContent}
          </Overlay>
        </div>
      </div>
    </div>
  );
}
