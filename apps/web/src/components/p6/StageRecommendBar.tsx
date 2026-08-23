/**
 * P6 技能广场 · 发现环①「适合当前阶段」推荐横条
 *  按工作区阶段（workspace.profile.stage）推荐 3 个官方技能；一键装备（安装即绑定围栏 F8.2）
 */
import { displayDesc, displayName, findSkill, skillIcon } from "./skillShared";
import type { SkillRow } from "./skillShared";

/** 阶段 → 推荐官方技能短名（未识别阶段走 stable 口径） */
const STAGE_PICKS: Record<string, { picks: string[]; label: string }> = {
  launch: {
    label: "冷启动期",
    picks: ["jenny-loom-research", "marketing-brief-parser", "shot-prompt-craft"],
  },
  growth: {
    label: "成长期",
    picks: ["shot-prompt-craft", "render-ops", "director-review"],
  },
  stable: {
    label: "稳定运营期",
    picks: ["director-review", "publish-ops", "comment-ops"],
  },
};

const STAGE_LABEL: Record<string, string> = {
  launch: "冷启动期", growth: "成长期", stable: "稳定运营期",
};

export function StageRecommendBar({
  stage,
  officials,
  installedSet,
  busy,
  canManage,
  onInstall,
}: {
  stage: string | null;
  officials: SkillRow[];
  installedSet: Set<string>;
  busy: string | null;
  canManage: boolean;
  onInstall: (skillId: string) => void;
}) {
  const conf = STAGE_PICKS[stage ?? ""] ?? STAGE_PICKS.stable!;
  const picks = conf.picks
    .map((ref) => findSkill(officials, ref))
    .filter((s): s is SkillRow => Boolean(s))
    .slice(0, 3);
  if (picks.length === 0) return null; // 官方套件未装配（空态）时不显推荐横条

  return (
    <div className="mb-4 rounded-lg border border-gline bg-gold/6 px-4 py-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[15px]">🧭</span>
        <b className="text-caption font-bold text-goldhi">适合当前阶段 · {STAGE_LABEL[stage ?? ""] ?? conf.label}</b>
        <span className="text-micro text-ink3">按工作区阶段推荐的 3 件官方装备（发现环）</span>
      </div>
      <div className="grid grid-cols-3 gap-2.5">
        {picks.map((s) => {
          const installed = installedSet.has(s.id);
          return (
            <div key={s.id} className="flex items-center gap-2.5 rounded-lg border border-gold/40 bg-card px-3 py-2">
              <span className="text-[18px]">{skillIcon(s)}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-caption font-bold text-ink">{displayName(s)}</div>
                <div className="truncate text-micro text-ink3">{displayDesc(s)}</div>
              </div>
              {installed ? (
                <span className="shrink-0 rounded border border-go/40 px-2 py-0.5 text-micro text-go">✓ 已装备</span>
              ) : (
                canManage && (
                  <button
                    type="button"
                    disabled={busy === s.id}
                    onClick={() => onInstall(s.id)}
                    className="shrink-0 cursor-pointer rounded-md border border-gline bg-bg800/60 px-2 py-1 text-micro font-bold text-goldhi hover:border-gold/60 disabled:opacity-40"
                  >
                    ⚙ 装备
                  </button>
                )
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
