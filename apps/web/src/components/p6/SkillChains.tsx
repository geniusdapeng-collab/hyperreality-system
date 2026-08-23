/**
 * P6 技能广场 · 组合环②「技能链」
 *  内置样例链：爆款种草流水线 / 合规发布流水线；可展开查看步骤；
 * 「编译为管线」为占位（toast 说明，不落库）
 */
import { useState } from "react";
import { displayName, findSkill, skillIcon } from "./skillShared";
import type { SkillRow } from "./skillShared";

interface ChainStep { skill: string; note: string }
interface SkillChain {
  key: string; name: string; icon: string; desc: string; steps: ChainStep[];
}

/** 内置样例链（官方技能短名，与 bundles/ai-video/skills 注册一致） */
const CHAINS: SkillChain[] = [
  {
    key: "chain-viral-seeding",
    name: "爆款种草流水线",
    icon: "🌱",
    desc: "情报五站供料 → Brief 解析 → 逐镜提示词，从爆款情报到可渲染脚本的种草链路",
    steps: [
      { skill: "jenny-loom-research", note: "趋势/竞品/爆款拆解，产出情报档案（G1 确认）" },
      { skill: "marketing-brief-parser", note: "情报档案 → 12 字段营销 Brief 确认单" },
      { skill: "shot-prompt-craft", note: "Brief → 逐镜 25 字段提示词（字符口径校验）" },
    ],
  },
  {
    key: "chain-compliant-publish",
    name: "合规发布流水线",
    icon: "🛡",
    desc: "提示词 → 导演评审硬阻断 → 全平台合规发布，每一步过围栏瀑布",
    steps: [
      { skill: "shot-prompt-craft", note: "逐镜提示词定稿（G6 字符硬上限）" },
      { skill: "director-review", note: "6 问评审 + 5 维评分 + 事实红线一票否决" },
      { skill: "publish-ops", note: "发布包校验 → RPA 上传 → 回执落账（G9）" },
    ],
  },
];

export function SkillChains({
  skills,
  onToast,
}: {
  skills: SkillRow[];
  onToast: (text: string) => void;
}) {
  const [openKey, setOpenKey] = useState<string | null>(null);

  return (
    <div className="mb-5">
      <div className="mb-2 text-caption font-bold tracking-wider text-ink2">
        技能链 · 组合环（样例链可展开查看步骤）
      </div>
      <div className="grid grid-cols-2 gap-3">
        {CHAINS.map((c) => {
          const open = openKey === c.key;
          return (
            <div key={c.key} className="rounded-msg border border-holo/30 bg-card p-3.5">
              <div className="flex items-center gap-2">
                <span className="text-[18px]">{c.icon}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-body font-bold text-ink">{c.name}</div>
                  <div className="mt-0.5 text-micro leading-relaxed text-ink3">{c.desc}</div>
                </div>
              </div>
              {/* 链步骤摘要（→ 连接符） */}
              <div className="mt-2 flex flex-wrap items-center gap-1 text-micro text-holo">
                {c.steps.map((st, i) => {
                  const s = findSkill(skills, st.skill);
                  return (
                    <span key={st.skill} className="flex items-center gap-1">
                      {i > 0 && <span className="text-ink3">→</span>}
                      <span className="rounded border border-holo/30 bg-holo/8 px-1.5 py-0.5 font-mono">
                        {s ? `${skillIcon(s)} ${displayName(s)}` : st.skill}
                      </span>
                    </span>
                  );
                })}
              </div>
              {open && (
                <ol className="mt-2 space-y-1 border-t border-line/60 pt-2">
                  {c.steps.map((st, i) => {
                    const s = findSkill(skills, st.skill);
                    return (
                      <li key={st.skill} className="flex gap-2 text-caption">
                        <span className="font-orb text-holo">{i + 1}.</span>
                        <span className="min-w-0 flex-1 text-ink2">
                          <b>{s ? displayName(s) : st.skill}</b>
                          <span className="ml-1 text-micro text-ink3">{st.note}</span>
                        </span>
                      </li>
                    );
                  })}
                </ol>
              )}
              <div className="mt-2.5 flex gap-2">
                <button
                  type="button"
                  onClick={() => setOpenKey(open ? null : c.key)}
                  className="cursor-pointer rounded-md border border-line px-2.5 py-1 text-micro text-ink2 hover:border-holo/50"
                >
                  {open ? "收起步骤 ▴" : "查看步骤 ▾"}
                </button>
                <button
                  type="button"
                  onClick={() => onToast(`「${c.name}」编译为管线：功能即将上线——编译后将生成可调度管线（步骤间 Handoff 校验 + 逐环围栏），当前为占位说明`)}
                  className="cursor-pointer rounded-md border border-gline bg-bg800/60 px-2.5 py-1 text-micro font-bold text-goldhi hover:border-gold/60"
                >
                  ⚙ 编译为管线
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
