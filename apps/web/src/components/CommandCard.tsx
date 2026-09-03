/**
 * CommandCard · 指挥卡（派活闭环核心组件）
 *
 * 点击数字员工 → 原地弹出指挥卡：绩效速览 + 派活输入 + 岗位快捷任务钮。
 * 下达复用 quest 派遣通道（captain.dispatch，指定 presetKey 直达该岗位）——
 * 业务通道零新增，只是把"派活"从 Ask 栏打字升级为"点人下令"。
 */
import { useState } from "react";
import { trpc } from "../lib/trpc";

export interface CommandTarget {
  id: string;
  presetKey: string;
  name: string;
  grade: string;
}

/** 岗位快捷任务（按岗位语义预置，点击即填入输入框） */
const QUICK_TASKS: Array<{ match: RegExp; tasks: string[] }> = [
  { match: /调价|价格|pricing|收益/, tasks: ["抓一下竞对价格", "评估周末房价策略", "复盘本周调价效果"] },
  { match: /竞对|competitor|scout/, tasks: ["抓竞对最新动态", "对比竞对价格带", "出一份竞对周报"] },
  { match: /评价|口碑|review|客服/, tasks: ["回复最新差评", "汇总本周口碑变化", "分析差评高频问题"] },
  { match: /内容|content|writer/, tasks: ["写一条今日主推内容", "优化店铺首图文案", "复盘昨日内容数据"] },
  { match: /对账|财务|finance|账/, tasks: ["对一遍昨日流水", "核查异常订单", "出今日营收快报"] },
  { match: /巡检|inspect/, tasks: ["全店巡检一遍", "核查安全与卫生点位", "出巡检异常清单"] },
  { match: /前台|语音|voice/, tasks: ["回听今日来电记录", "整理高频咨询问题", "演练周末接待话术"] },
];
const DEFAULT_TASKS = ["盘点今日订单", "出一份经营快报", "巡检一遍当前异常"];

export function quickTasksOf(name: string, presetKey: string): string[] {
  const k = `${name}${presetKey}`;
  return QUICK_TASKS.find((q) => q.match.test(k))?.tasks ?? DEFAULT_TASKS;
}

export function CommandCard({
  target, onClose, onDispatched,
}: {
  target: CommandTarget;
  onClose: () => void;
  onDispatched: (msg: string) => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const tasks = quickTasksOf(target.name, target.presetKey);

  const dispatch = async (title: string) => {
    if (!title.trim() || busy) return;
    setBusy(true);
    setFeedback(null);
    try {
      const r = await trpc.threads.dispatch.mutate({
        title: title.trim(),
        presetKey: target.presetKey,
        runImmediately: true,
      });
      const res = r as { kind?: string; question?: string };
      if (res.kind === "clarify") {
        setFeedback(`🤔 ${res.question ?? "指令不够具体，能再说细一点吗？"}`);
      } else {
        onDispatched(`已派活给 ${target.name.replace("agt-", "")}：${title.trim().slice(0, 24)}`);
        onClose();
      }
    } catch (err) {
      setFeedback(`派活失败：${err instanceof Error ? err.message.slice(0, 60) : "未知错误"}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="w-80 rounded-xl border border-gline bg-card p-4 shadow-[0_16px_48px_rgba(74,43,51,.25)]" onClick={(e) => e.stopPropagation()}>
        {/* 绩效速览 */}
        <div className="mb-1 flex items-center justify-between">
          <div className="text-sm font-bold text-ink">{target.name.replace("agt-", "")}</div>
          <span className={`rounded border px-1.5 py-0.5 text-[10px] ${target.grade === "表扬" ? "border-go/50 text-go" : target.grade === "辅导" ? "border-warn/50 text-warn" : target.grade === "关注" ? "border-amber-500/50 text-amber-600" : "border-line text-ink3"}`}>
            {target.grade}
          </span>
        </div>
        <div className="text-[11px] text-ink3">岗位：{target.presetKey}</div>

        {/* 派活区 */}
        <div className="mt-3 border-t border-line pt-3">
          <div className="mb-1.5 text-[11px] font-semibold tracking-[.15em] text-holo">给 TA 派活</div>
          <div className="flex gap-1.5">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void dispatch(text); }}
              placeholder="下指令，回车即派…"
              maxLength={200}
              className="min-w-0 flex-1 rounded border border-line bg-bg900 px-2.5 py-1.5 text-xs text-ink outline-none placeholder:text-ink3/60 focus:border-gline"
            />
            <button
              onClick={() => void dispatch(text)}
              disabled={busy || !text.trim()}
              className="shrink-0 rounded border border-gline bg-gold/10 px-2.5 py-1.5 text-xs font-semibold text-gold disabled:opacity-40"
            >
              {busy ? "…" : "下达"}
            </button>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {tasks.map((t) => (
              <button
                key={t}
                onClick={() => void dispatch(t)}
                disabled={busy}
                className="rounded-full border border-line bg-bg900 px-2.5 py-1 text-[11px] text-ink2 hover:border-gline hover:text-gold disabled:opacity-40"
              >
                {t}
              </button>
            ))}
          </div>
          {feedback && <div className="mt-2 rounded border border-amber-500/40 bg-amber-400/10 px-2 py-1.5 text-[11px] text-amber-600">{feedback}</div>}
        </div>

        <div className="mt-3 flex gap-2">
          <a href="/p8" className="flex-1 rounded border border-line px-2 py-1.5 text-center text-[11px] text-holo no-underline hover:border-gline">团队档案</a>
          <button onClick={onClose} className="flex-1 rounded border border-line py-1.5 text-[11px] text-ink3">关闭</button>
        </div>
      </div>
    </div>
  );
}
