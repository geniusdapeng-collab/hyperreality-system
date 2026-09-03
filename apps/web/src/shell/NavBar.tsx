/**
 * NavBar · 桌面客户端常驻导航条（替代 ☰ 收合菜单的桌面端范式）
 *
 * 设计口径：客户端即产品——导航必须"看得见、点得到"，不收进二级入口。
 *  - 顶栏第二行整行平铺：分组（经营/行业/治理/系统）间细点分隔；
 *  - 当前页金色高亮 + 底部指示线；hover 即反馈；
 *  - 页面清单复用 NavMenu.NAV_ENTRIES（各仓路由裁剪口径不变，hotel 行业组自动并入）。
 */
import { useLocation } from "react-router";
import { NAV_ENTRIES, type NavEntry } from "./NavMenu";

const GROUP_ORDER = ["经营", "行业", "治理", "系统"];

export function NavBar({ entries = NAV_ENTRIES }: { entries?: NavEntry[] }) {
  const { pathname } = useLocation();
  const groups = GROUP_ORDER.map((g) => [g, entries.filter((e) => e.group === g)] as const)
    .filter(([, list]) => list.length > 0);

  return (
    <nav
      aria-label="主导航"
      className="flex items-center gap-0.5 overflow-x-auto border-t border-line/60 bg-bg950/85 px-2.5 py-1 backdrop-blur-md"
    >
      {groups.map(([g, list], gi) => (
        <div key={g} className="flex items-center gap-1">
          {gi > 0 && <span className="mx-1.5 h-3 w-px bg-line" aria-hidden />}
          <span className="mr-0.5 select-none text-[9px] tracking-[.12em] text-ink3/70">{g}</span>
          {list.map((e) => {
            // 精确命中或子路由（path + "/" 边界）——防 /p11 被 /p1 前缀误伤
            const active = pathname === e.path || (e.path !== "/" && pathname.startsWith(e.path + "/"));
            return (
              <a
                key={e.path}
                href={e.path}
                aria-current={active ? "page" : undefined}
                className={`relative whitespace-nowrap rounded px-2 py-0.5 text-[11.5px] no-underline transition-colors ${
                  active
                    ? "bg-card font-semibold text-gold shadow-[inset_0_-2px_0_0_var(--color-gold)]"
                    : "text-ink2 hover:bg-card/60 hover:text-ink"
                }`}
              >
                {e.label}
              </a>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
