/**
 * SideNav · 客户端左侧常驻导航（WorkBuddy/Codex 桌面端范式）
 *
 * 设计口径：
 *  - 全局常驻（App 级挂载，所有产品页面可见——此前部分页面无导航入口的问题根治）；
 *  - 一级=分组（经营/行业/治理/系统），二级=页面项（图标+文字）；
 *  - 各行业版页面清单不同（各仓 NAV_ENTRIES），分级结构恒定；
 *  - 当前页：金色左指示条 + 高亮底；hover 即反馈；项多时自身滚动。
 */
import { useLocation } from "react-router";
import { NAV_ENTRIES, type NavEntry } from "./NavMenu";

const GROUP_ORDER = ["经营", "行业", "治理", "系统"];

/** 页面图标（内联 SVG——任何渲染环境一致，不依赖系统 emoji 字体） */
function Icon({ d, active }: { d: string; active?: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      style={{ opacity: active ? 1 : 0.75, flexShrink: 0 }} aria-hidden>
      <path d={d} />
    </svg>
  );
}
const ICON_PATHS: Record<string, string> = {
  "/": "M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6",                                    // 经营主页·楼宇
  "/p1": "M4 20V10M10 20V4M16 20v-8M22 20H2",                                       // 工作台·柱状
  "/p3": "M7 2h10v20H7zM10 18h4",                                                   // 掌上日报·手机
  "/p22": "M4 18v-6a8 8 0 0116 0v6M2 18h20v3H2z",                                   // 服务前台·铃
  "/p25": "M12 8.5A3.5 3.5 0 100 15.5 3.5 3.5 0 0012 8.5zM21 13.4v-2.8l-2.3-.5a7 7 0 00-.6-1.5l1.3-2-2-2-2 1.3a7 7 0 00-1.5-.6L13.5 3h-2.8l-.5 2.3a7 7 0 00-1.5.6l-2-1.3-2 2 1.3 2a7 7 0 00-.6 1.5l-2.3.5v2.8l2.3.5c.14.53.34 1.03.6 1.5l-1.3 2 2 2 2-1.3c.47.26.97.46 1.5.6l.5 2.3h2.8l.5-2.3a7 7 0 001.5-.6l2 1.3 2-2-1.3-2c.26-.47.46-.97.6-1.5l2.3-.5z", // 开发场域·齿轮
  "/p4": "M20 6L9 17l-5-5",                                                         // 审批中心·对勾
  "/p21": "M3 18l2-10 5 4 2-8 2 8 5-4 2 10zM5 21h14",                               // 董事长视图·冠
  "/p9": "M21 12.8A9 9 0 1111.2 3 7 7 0 0021 12.8z",                                // 夜班中心·月
  "/p24": "M12 15a5 5 0 100-10 5 5 0 000 10zM8.5 13.5L7 22l5-3 5 3-1.5-8.5",            // 考试院·徽章
  "/p5": "M12 3l8 3v6c0 4.5-3.2 7.8-8 9-4.8-1.2-8-4.5-8-9V6z",                      // 规则权限·盾
  "/p6": "M10 4h4v4h4v4h-4v4h-4v-4H6V8h4zM4 20h16",                                 // 技能中心·拼
  "/p23": "M12 3a7 7 0 017 7c0 3-2 4-2 6H7c0-2-2-3-2-6a7 7 0 017-7zM9 20h6",        // 组织记忆·脑
  "/p7": "M4 20V8l8-5 8 5v12M4 20h16M12 20v-7",                                     // 装配中心·筑
  "/p8": "M16 19c0-2.8-1.8-5-4-5s-4 2.2-4 5M12 11a3 3 0 100-6 3 3 0 000 6zM19 19c0-2-1-3.6-2.5-4.2M5 19c0-2 1-3.6 2.5-4.2", // 团队·人
  "/p11": "M3 17l6-6 4 4 8-8M15 7h6v6",                                             // 价格健康·趋势
  "/p12": "M12 22a10 10 0 100-20 10 10 0 000 20zM12 16a4 4 0 100-8 4 4 0 000 8z",   // 经营目标·靶
  "/p13": "M21 8l-9-5-9 5v8l9 5 9-5zM3 8l9 5 9-5M12 13v8",                          // 订单·包裹
  "/p14": "M5 12a10 10 0 0114 0M8.5 15.5a5 5 0 017 0M12 19h.01",                     // 渠道·信号
  "/p15": "M12 2l3 6.5 7 .8-5.2 4.7 1.5 7-6.3-3.8L5.7 21l1.5-7L2 9.3l7-.8z",       // 口碑·星
  "/p16": "M4 5a8 8 0 018 8M4 5v0M6 3c6 0 12 5 12 12M8 21a3 3 0 106 0 3 3 0 00-6 0z", // 语音前台·波
  "/p17": "M3 18v-6a3 3 0 013-3h12a3 3 0 013 3v6M3 18h18M6 9V6a2 2 0 012-2h8a2 2 0 012 2v3", // 前厅客房·床
  "/p18": "M3 21h18M6 21V5h12v16M10 9h1M10 13h1M13 9h1M13 13h1M10 17h4",             // 多店·楼群
  "/p19": "M3 3v18h18M7 15l4-6 3 3 5-8",                                            // 收益·分析
  "/p20": "M4 4h6l2 3h8v13H4zM4 4v16",                                              // 档案·夹
};

export function SideNav({ entries = NAV_ENTRIES }: { entries?: NavEntry[] }) {
  const { pathname } = useLocation();
  const groups = GROUP_ORDER.map((g) => [g, entries.filter((e) => e.group === g)] as const)
    .filter(([, list]) => list.length > 0);

  return (
    <nav
      aria-label="主导航"
      className="flex h-screen w-[208px] shrink-0 flex-col border-r border-line bg-bg950/95 backdrop-blur-md"
    >
      {/* 品牌区 */}
      <div className="flex items-center gap-2.5 border-b border-line px-4 py-3.5">
        <span className="inline-block h-4 w-4 rotate-45 rounded gold-grad shadow-[0_0_14px_rgba(255,160,60,.6)]" />
        <div className="leading-tight">
          <div className="bg-gradient-to-r from-gold to-gold2 bg-clip-text text-[14px] font-black tracking-wider text-transparent">
            WorkLoom
          </div>
          <div className="text-[10px] text-ink3">企业数字员工 IM</div>
        </div>
      </div>

      {/* 分级导航（可滚动区） */}
      <div className="flex-1 overflow-y-auto px-2.5 py-3">
        {groups.map(([g, list]) => (
          <div key={g} className="mb-4">
            <div className="mb-1.5 px-2 text-[10px] font-semibold tracking-[.2em] text-ink3/80">{g}</div>
            {list.map((e) => {
              const active = pathname === e.path || (e.path !== "/" && pathname.startsWith(e.path + "/"));
              return (
                <a
                  key={e.path}
                  href={e.path}
                  aria-current={active ? "page" : undefined}
                  className={`group relative mb-0.5 flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[12.5px] no-underline transition-colors ${
                    active ? "bg-card font-semibold text-gold" : "text-ink2 hover:bg-card/60 hover:text-ink"
                  }`}
                >
                  {active && (
                    <span className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-gold shadow-[0_0_8px_rgba(255,190,106,.7)]" />
                  )}
                  <Icon d={ICON_PATHS[e.path] ?? "M9 5l7 7-7 7"} active={active} />
                  <span className="truncate">{e.label}</span>
                </a>
              );
            })}
          </div>
        ))}
      </div>

      {/* 底部状态区 */}
      <div className="border-t border-line px-4 py-2.5 text-[10px] leading-relaxed text-ink3/70">
        桌面客户端 · 布局比例恒定
      </div>
    </nav>
  );
}
