/**
 * 舰桥框架（F1：壳 + 顶栏，视觉事实源=原型 V4.0 .frame/.abar/.night-pill/.brk，D5）
 *  - 星野背景（设计公理 Ⅰ/§7 drift 90s：星云渐变层 + 星点层，禁死黑满铺；reduced-motion 降级静态）
 *  - HUD 四角金色刻度（原型 .frame::before/::after/.bc：18px·2px·贴边·随 20px 圆角）
 *  - 顶栏：logo / 工作区 / 夜班状态胶囊（P1E5，含 paused 变体）/ 紧急制动杆（P1E6，.brk 描边款）
 *  - IM 三栏：236px 左会话列表｜弹性中央｜264px 右上下文（§4.1）
 * 内部数据为占位；逐页接线真实 API 在 F3–F11。
 */
import type { ReactNode } from "react";
import { useState } from "react";
import { EmergencyBrake, NightStatusPill } from "../components/hud";
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
            "radial-gradient(60% 45% at 18% 8%, rgb(36 27 77 / .55), transparent 70%)," +
            "radial-gradient(50% 40% at 85% 20%, rgb(58 42 110 / .38), transparent 70%)," +
            "radial-gradient(70% 50% at 50% 110%, rgb(36 27 77 / .45), transparent 70%)",
        }}
      />
      {/* 星点层（确定性伪随机分布；随 drift 同层缓漂） */}
      <div
        className="absolute inset-0 animate-drift"
        style={{
          backgroundImage:
            "radial-gradient(1px 1px at 12% 22%, rgb(234 241 255 / .8) 50%, transparent 51%)," +
            "radial-gradient(1px 1px at 34% 68%, rgb(234 241 255 / .5) 50%, transparent 51%)," +
            "radial-gradient(1.5px 1.5px at 57% 15%, rgb(69 224 255 / .6) 50%, transparent 51%)," +
            "radial-gradient(1px 1px at 72% 47%, rgb(234 241 255 / .7) 50%, transparent 51%)," +
            "radial-gradient(1px 1px at 88% 78%, rgb(234 241 255 / .45) 50%, transparent 51%)," +
            "radial-gradient(1.5px 1.5px at 25% 88%, rgb(255 181 69 / .5) 50%, transparent 51%)," +
            "radial-gradient(1px 1px at 45% 40%, rgb(234 241 255 / .55) 50%, transparent 51%)," +
            "radial-gradient(1px 1px at 66% 90%, rgb(234 241 255 / .6) 50%, transparent 51%)," +
            "radial-gradient(1px 1px at 94% 10%, rgb(234 241 255 / .5) 50%, transparent 51%)," +
            "radial-gradient(1.5px 1.5px at 8% 55%, rgb(69 224 255 / .4) 50%, transparent 51%)",
        }}
      />
    </div>
  );
}

/** HUD 四角金色刻度（原型 .frame::before/::after/.bc：18px·2px·贴边·随舰桥圆角） */
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
  const community = plan === "community";
  return (
    <div className="min-h-screen bg-bg950">
      <StarField />
      <div className="relative flex min-h-screen items-start justify-center py-8">
        <div className="relative w-bridge overflow-hidden rounded-bridge border border-line bg-gradient-to-b from-[#0a1230eb] to-[#050a1af5] shadow-[0_30px_80px_rgba(0,0,0,.55)]">
          <CornerTicks />

          {/* 顶栏（原型 V4.0 .abar chrome 条） */}
          <header className="flex items-center gap-3.5 border-b border-line bg-bg950/90 px-4.5 py-2.5 backdrop-blur-md">
            <div className="flex items-center gap-2.5 text-[15px] font-black tracking-wider">
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden
                className="shadow-[0_0_14px_rgba(255,160,60,.6)]"
              >
                {/* 场记板 + 播放键（金色系） */}
                <rect x="2.5" y="8" width="19" height="12.5" rx="2.2" fill="#c9922e" />
                <path d="M3.2 5.4 20.6 3.2l.5 2.6L3.7 8z" fill="#e9b558" />
                <path d="M6.4 4.9l2 2.2M10.6 4.5l2 2.2M14.8 4l2 2.2" stroke="#7a5410" strokeWidth="1.1" />
                <path d="M10.2 11.4v5.6l4.8-2.8z" fill="#1b1206" />
              </svg>
              <span className="bg-gradient-to-r from-[#fff6e3] to-gold bg-clip-text text-transparent">
                视频经理
              </span>
            </div>
            <span className="text-xs text-ink3">
              HyperReality · <b className="font-semibold text-ink2">视频创作工作室</b>
            </span>
            <span className="flex-1" />
            <PlanSwitcher onPlan={setPlan} />
            {!community && <NightStatusPill onClick={() => { window.location.href = "/p9"; }} />}
            {!community && <EmergencyBrake />}
          </header>

          {/* IM 三栏（§4.1：236px 左｜弹性中｜264px 右；栏间 1px 全息青细线=border-line） */}
          <div className="flex min-h-[640px]">
            {/* 左侧会话列表（P1 注入真实分组数据；缺省占位=演示线程种子口径） */}
            <aside className="w-col-left border-r border-line p-3">
              {left ?? (<>
              <div className="mb-2 px-1 text-[11px] tracking-[.2em] text-ink3">会话 · THREADS</div>
              {[
                { id: "T-101", title: "保温杯种草片·三镜渲染", status: "running", cls: "text-holo" },
                { id: "T-102", title: "抖音评论区差评分流", status: "pending_review", cls: "text-warn" },
                { id: "T-103", title: "早八点账号战报", status: "completed", cls: "text-go" },
              ].map((t) => (
                <div
                  key={t.id}
                  className="mb-1.5 cursor-pointer rounded-lg border border-line bg-card px-3 py-2.5 hover:border-gline"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[11px] text-ink3">{t.id}</span>
                    <span className={`text-[11px] ${t.cls}`}>{t.status}</span>
                  </div>
                  <div className="mt-1 text-body text-ink2">{t.title}</div>
                </div>
              ))}
              </>)}
            </aside>

            {/* 主区 */}
            <main className="flex-1 p-5">{children}</main>

            {/* 右上下文面板（P1 注入真实投影；缺省占位） */}
            <aside className="w-col-right border-l border-line p-3">
              {right ?? (
                <>
                  <div className="mb-2 px-1 text-[11px] tracking-[.2em] text-ink3">上下文 · CONTEXT</div>
                  <div className="rounded-lg border border-line bg-card p-3 text-xs leading-relaxed text-ink3">
                    档案 / 阶段 / 目标三要素投影位（L3.7）。阶段三接线。
                  </div>
                </>
              )}
            </aside>
          </div>
        </div>
      </div>
    </div>
  );
}
