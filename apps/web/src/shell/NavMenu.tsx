/**
 * NavMenu · PC 端全页导航菜单（F-NAV1：补齐各页可达性——此前仅 3 个页面有顶栏入口）
 *  - 顶栏「☰ 导航」按钮 → 下拉网格（按 经营/治理/系统 分组）；Esc/点外关闭
 *  - 当前页高亮；移动端窄屏自动两列
 */
import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";

export interface NavEntry { path: string; label: string; group: string }

/** 页面清单（按仓路由裁剪；hotel 仓另有行业页组） */
export const NAV_ENTRIES: NavEntry[] = [
  { path: "/", label: "经营主页", group: "经营" },
  { path: "/p1", label: "工作台 · 总览", group: "经营" },
  { path: "/p3", label: "掌上日报", group: "经营" },
  { path: "/p22", label: "服务前台", group: "经营" },
  { path: "/p25", label: "开发场域", group: "经营" },
  { path: "/p4", label: "审批中心", group: "治理" },
  { path: "/p21", label: "董事长视图", group: "治理" },
  { path: "/p9", label: "夜班中心", group: "治理" },
  { path: "/p24", label: "考试院", group: "治理" },
  { path: "/p5", label: "规则与权限", group: "系统" },
  { path: "/p6", label: "技能中心", group: "系统" },
  { path: "/p23", label: "组织记忆", group: "系统" },
  { path: "/p7", label: "装配中心", group: "系统" },
  { path: "/p8", label: "团队成员", group: "系统" },
  { path: "/p10", label: "片库 · 内容资产", group: "系统" },
];

const GROUP_ORDER = ["经营", "行业", "治理", "系统"];

export function NavMenu({ entries = NAV_ENTRIES }: { entries?: NavEntry[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const { pathname } = useLocation();

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const groups = GROUP_ORDER.map((g) => [g, entries.filter((e) => e.group === g)] as const)
    .filter(([, list]) => list.length > 0);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`rounded border px-2 py-0.5 text-[11px] ${open ? "border-gline bg-card text-gold" : "border-line text-ink2 hover:border-gline"}`}
      >
        ☰ 导航
      </button>
      {open && (
        <div className="absolute right-0 top-8 z-50 w-[26rem] rounded-xl border border-line bg-bg900/98 p-3 shadow-[0_16px_48px_rgba(74,43,51,.18)] backdrop-blur-md">
          {groups.map(([g, list]) => (
            <div key={g} className="mb-2.5 last:mb-0">
              <div className="mb-1 px-1 text-[10px] tracking-[.2em] text-ink3">{g}</div>
              <div className="grid grid-cols-2 gap-1.5">
                {list.map((e) => {
                  const active = e.path === "/" ? pathname === "/" : pathname.startsWith(e.path);
                  return (
                    <a
                      key={e.path}
                      href={e.path}
                      onClick={() => setOpen(false)}
                      className={`rounded-lg border px-3 py-2 text-xs no-underline ${
                        active ? "border-gline bg-gold/10 font-bold text-gold" : "border-line bg-card text-ink2 hover:border-gline"
                      }`}
                    >
                      {e.label}
                    </a>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
