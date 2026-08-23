/**
 * P6 技能广场 · 进化环③
 *  - 冷藏区（折叠）：连续 4 周零命中技能降权展示（事件投影无调用即命中口径；无数据时 Mock 2 条兜底）
 *  - 进化提案：基于驳回样本（skills.usage.rejectReasons）的修订建议卡片，批准按钮 toast 占位
 */
import { useState } from "react";
import { displayName, skillIcon } from "./skillShared";
import type { SkillRow, SkillUsage } from "./skillShared";

/** 冷藏区 Mock 兜底（连续 4 周零命中的示例口径；真实数据为空时展示） */
const MOCK_COLD: Array<{ name: string; reason: string }> = [
  { name: "口播字幕压制", reason: "连续 4 周零命中——近 30 天无绑定 Agent 调用投影" },
  { name: "弹幕热词贴片", reason: "连续 4 周零命中——玩法已被「评论区运营」分流策略覆盖" },
];

export function EvolutionZone({
  skills,
  usage,
  onToast,
}: {
  skills: SkillRow[];
  usage: Record<string, SkillUsage>;
  onToast: (text: string) => void;
}) {
  const [coldOpen, setColdOpen] = useState(false);

  // 冷藏口径：近 30 天调用投影为 0（连续 4 周零命中的保守近似，不伪造精确周桶）
  const cold = skills.filter((s) => (usage[s.id]?.calls30 ?? 0) === 0);
  // 进化提案：有驳回样本的技能 → 修订建议
  const proposals = skills
    .map((s) => ({ skill: s, u: usage[s.id] }))
    .filter((x): x is { skill: SkillRow; u: SkillUsage } => Boolean(x.u && x.u.rejectReasons.length > 0))
    .slice(0, 4);

  return (
    <div className="mb-5">
      <div className="mb-2 text-caption font-bold tracking-wider text-ink2">
        进化环 · 冷藏与进化提案（F8.5 采纳闭环）
      </div>

      {/* 冷藏区（折叠 · 降权展示） */}
      <div className="mb-3 rounded-lg border border-line bg-bg800/40">
        <button
          type="button"
          onClick={() => setColdOpen((v) => !v)}
          className="flex w-full cursor-pointer items-center gap-2 px-3.5 py-2.5 text-left"
        >
          <span className="text-[15px]">🧊</span>
          <span className="text-caption font-bold text-ink3">冷藏区（连续 4 周零命中 · 降权展示）</span>
          <span className="rounded border border-line px-1.5 py-0.5 font-mono text-micro text-ink3">
            {cold.length > 0 ? cold.length : MOCK_COLD.length}
          </span>
          <span className="ml-auto text-micro text-ink3">{coldOpen ? "收起 ▴" : "展开 ▾"}</span>
        </button>
        {coldOpen && (
          <div className="space-y-1.5 border-t border-line/60 px-3.5 py-2.5">
            {cold.length > 0
              ? cold.map((s) => (
                  <div key={s.id} className="flex items-center gap-2 text-caption opacity-55">
                    <span>{skillIcon(s)}</span>
                    <span className="min-w-0 flex-1 truncate text-ink3">{displayName(s)}</span>
                    <span className="text-micro text-ink3">近 30 天零调用投影 · 建议优化或下架（F8.5）</span>
                  </div>
                ))
              : MOCK_COLD.map((m) => (
                  <div key={m.name} className="flex items-center gap-2 text-caption opacity-55">
                    <span>🧊</span>
                    <span className="min-w-0 flex-1 truncate text-ink3">{m.name}（示例）</span>
                    <span className="text-micro text-ink3">{m.reason}</span>
                  </div>
                ))}
          </div>
        )}
      </div>

      {/* 进化提案（基于驳回样本的修订建议） */}
      <div className="rounded-lg border border-line bg-card p-3.5">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-[15px]">🧬</span>
          <b className="text-caption font-bold text-ink2">进化提案</b>
          <span className="text-micro text-ink3">基于驳回样本的修订建议（校准闭环 E8.3）</span>
        </div>
        {proposals.length === 0 ? (
          <div className="text-caption text-ink3">暂无进化提案——出现驳回样本后自动生成修订建议</div>
        ) : (
          <div className="space-y-2">
            {proposals.map(({ skill, u }) => (
              <div key={skill.id} className="rounded-lg border border-warn/30 bg-warn/5 p-2.5">
                <div className="flex items-center gap-2 text-caption">
                  <span>{skillIcon(skill)}</span>
                  <b className="min-w-0 flex-1 truncate text-ink">{displayName(skill)}</b>
                  <span className="text-micro text-warn">驳回 {u.rejected30} 件 / 30 天</span>
                </div>
                <div className="mt-1 text-micro leading-relaxed text-ink2">
                  驳回样本：{u.rejectReasons.map((r) => `「${r.reason}」×${r.count}`).join("、")}
                  ——建议修订触发条件与边界声明，将高频驳回原因写入「不能做什么」（自动转围栏 F8.3）
                </div>
                <div className="mt-1.5 flex gap-2">
                  <button
                    type="button"
                    onClick={() => onToast(`已批准「${displayName(skill)}」进化提案（占位）：批准后将生成 v2 修订草稿进版本管理（F8.3），当前为占位说明`)}
                    className="cursor-pointer rounded-md border border-go/50 px-2.5 py-1 text-micro font-bold text-go hover:bg-go/10"
                  >
                    ✓ 批准修订
                  </button>
                  <button
                    type="button"
                    onClick={() => onToast(`已驳回「${displayName(skill)}」进化提案（占位）：该样本口径将降权（E8.3 校准闭环）`)}
                    className="cursor-pointer rounded-md border border-line px-2.5 py-1 text-micro text-ink3 hover:border-alert/40 hover:text-alert"
                  >
                    驳回
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
