/**
 * 游戏化组件（设计规范 §6）：等级徽章 / 成就徽章 / 战队成员环 / 装配槽 / 装备稀有度边框
 * 铁律：游戏是结构不是皮肤——组件语义与《游戏规则手册》一一对应；不改变任何业务机制
 */

/** LevelBadge 等级徽章 LV（§6）：Orbitron「LV.12」金色高光字 + 段位小字（全息青）
 *  舰长=圆形头像金描边；船员=方形头像+版本角标。段位阶梯：青铜→白银→黄金→铂金→星钻 */
export function LevelBadge({
  level,
  rank,
  captain = false,
  name,
  version,
}: {
  level: number;
  rank: "青铜" | "白银" | "黄金" | "铂金" | "星钻";
  captain?: boolean;
  name: string;
  version?: string;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <div className="relative">
        <div
          className={`flex h-10 w-10 items-center justify-center border-2 font-orb text-caption font-black ${
            captain
              ? "rounded-full border-gold bg-gold/10 text-goldhi shadow-[0_0_12px_rgba(255,181,69,.4)]"
              : "rounded-md border-line bg-bg700 text-ink2"
          }`}
        >
          {name.slice(0, 1)}
        </div>
        {!captain && version && (
          <span className="absolute -right-1.5 -bottom-1 rounded border border-line bg-bg900 px-1 font-mono text-[9.5px] text-ink3">
            {version}
          </span>
        )}
      </div>
      <div>
        <div className="font-orb text-body font-bold tracking-wider text-goldhi">LV.{level}</div>
        <div className="text-micro text-holo">{rank}</div>
      </div>
    </div>
  );
}

/** AchievementBadge 成就徽章（§6）：六边形金边章 + 名称 + 达成日期（成就清单由规则手册 §7 定义） */
export function AchievementBadge({ name, achievedAt }: { name: string; achievedAt: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <div
        className="flex h-11 w-11 items-center justify-center border-2 border-gold/70 bg-gold/8 text-lg"
        style={{ clipPath: "polygon(50% 0, 93% 25%, 93% 75%, 50% 100%, 7% 75%, 7% 25%)" }}
      >
        🏅
      </div>
      <div>
        <div className="text-body font-bold text-goldhi">{name}</div>
        <div className="font-mono text-micro text-ink3">{achievedAt}</div>
      </div>
    </div>
  );
}

/** SquadRing 战队成员环（§6，P9 群头）：7 名成员环形排列；巡航逐个点亮+金色尾焰，窗口外转「待命」暗灯 */
export function SquadRing({
  members,
  active = false,
}: {
  members: Array<{ name: string; version: string }>;
  /** 夜班窗口内巡航中 */
  active?: boolean;
}) {
  const R = 56;
  return (
    <div className="relative mx-auto h-[140px] w-[140px]">
      {members.map((m, i) => {
        const angle = (i / members.length) * 2 * Math.PI - Math.PI / 2;
        const x = 70 + R * Math.cos(angle) - 14;
        const y = 70 + R * Math.sin(angle) - 14;
        return (
          <div
            key={m.name}
            title={`${m.name} ${m.version}${active ? " · 巡航中" : " · 待命"}`}
            className={`absolute flex h-7 w-7 items-center justify-center rounded-md border text-micro font-bold transition-all ${
              active
                ? "border-gold/70 bg-gold/12 text-goldhi shadow-[0_0_10px_rgba(255,181,69,.5)]"
                : "border-line bg-bg700/60 text-ink3"
            }`}
            style={{ left: x, top: y, transitionDelay: `${i * 120}ms` }}
          >
            {m.name.slice(0, 1)}
          </div>
        );
      })}
      <div className="absolute inset-0 flex items-center justify-center text-center">
        <div>
          <div className="font-orb text-caption font-bold text-holo">{active ? "巡航中" : "待命"}</div>
          <div className="text-micro text-ink3">{members.length} 名成员</div>
        </div>
      </div>
    </div>
  );
}

/** EquipSlot 装配槽（§6，仅 P7 装配中心）：六边形槽位，已装配金光点亮，失败红边 */
export function EquipSlot({
  label,
  filled = false,
  failed = false,
}: {
  label: string;
  filled?: boolean;
  failed?: boolean;
}) {
  return (
    <div
      className={`flex h-16 w-16 flex-col items-center justify-center border-2 text-micro font-bold ${
        failed
          ? "border-alert/70 bg-alert/8 text-alert"
          : filled
            ? "border-gold/70 bg-gold/10 text-goldhi shadow-[0_0_14px_rgba(255,181,69,.45)]"
            : "border-line bg-bg800/50 text-ink3"
      }`}
      style={{ clipPath: "polygon(50% 0, 93% 25%, 93% 75%, 50% 100%, 7% 75%, 7% 25%)" }}
    >
      <span>{failed ? "✗" : filled ? "◆" : "◇"}</span>
      <span className="mt-0.5 px-1 text-center leading-tight">{label}</span>
    </div>
  );
}

/** EquipCard 装备稀有度边框（§6，仅 P6 技能中心）：官方=金 / 团队=银 / 行业共享=铜 */
export function EquipCard({
  name,
  rarity,
  desc,
  installs,
}: {
  name: string;
  rarity: "official" | "team" | "industry";
  desc: string;
  installs?: number;
}) {
  const RARITY = {
    official: { border: "border-gold/60", tag: "官方", cls: "text-gold" },
    team: { border: "border-[#C0C8E8]/50", tag: "团队", cls: "text-[#C0C8E8]" },
    industry: { border: "border-[#CD8B5A]/50", tag: "行业共享", cls: "text-[#CD8B5A]" },
  }[rarity];
  return (
    <div className={`rounded-msg border-2 bg-card p-3.5 ${RARITY.border}`}>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-body font-bold text-ink">{name}</span>
        <span className={`text-micro font-bold ${RARITY.cls}`}>{RARITY.tag}</span>
      </div>
      <div className="text-caption leading-relaxed text-ink2">{desc}</div>
      {installs !== undefined && (
        <div className="mt-1.5 text-micro text-ink3">
          已装 <b className="font-orb text-holo">{installs}</b> 个工作区
        </div>
      )}
    </div>
  );
}
