/**
 * CommandCard · 指挥卡（派活闭环核心组件）
 *
 * 点击数字员工 → 原地弹出指挥卡：绩效速览 + 派活输入 + 岗位快捷任务钮。
 * 下达复用 quest 派遣通道（captain.dispatch，指定 presetKey 直达该岗位）——
 * 业务通道零新增，只是把"派活"从 Ask 栏打字升级为"点人下令"。
 */
import { useState } from "react";
import { trpc } from "../lib/trpc";
import { actorText } from "../lib/display";
import { Link } from "react-router";
import { Button, Overlay, clientChineseText } from "@workloom/ui";

export interface CommandTarget {
  id: string;
  presetKey: string;
  name: string;
  grade: string;
}

/**
 * 基座只提供跨行业都成立的快捷指令。岗位专属指令属于行业投影，必须由
 * Bundle 首页组件或后续的任务建议投影提供，不能根据 preset_key 在客户端猜测。
 */
const BASE_QUICK_TASKS = [
  "汇报当前进展并给出下一步建议",
  "检查当前异常并说明影响",
  "整理今日待办与需要我确认的事项",
];

export function quickTasksOf(_name: string, _presetKey: string): string[] {
  return BASE_QUICK_TASKS;
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
  const targetName = clientChineseText(target.name, actorText(target.presetKey));

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
        setFeedback(clientChineseText(res.question, "指令不够具体，能再说细一点吗？"));
      } else {
        onDispatched(`已派活给 ${targetName}：${title.trim().slice(0, 24)}`);
        onClose();
      }
    } catch (err) {
      console.warn("派活失败", err);
      setFeedback("暂时无法派发任务，请稍后重试。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Overlay
      open
      title={`给「${targetName}」派活`}
      description={`岗位：${actorText(target.presetKey)}`}
      onClose={onClose}
      footer={(
        <>
          <Link to="/agents" className="wl-button wl-button--secondary no-underline">查看团队档案</Link>
          <Button onClick={onClose}>关闭</Button>
        </>
      )}
    >
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm font-bold text-ink">绩效状态</div>
          <span className={`rounded border px-1.5 py-0.5 text-body ${target.grade === "表扬" ? "border-go/50 text-go" : target.grade === "辅导" ? "border-warn/50 text-warn" : target.grade === "关注" ? "border-amber-500/50 text-amber-600" : "border-line text-ink3"}`}>
            {clientChineseText(target.grade, "状态待确认")}
          </span>
        </div>

        {/* 派活区 */}
        <div className="mt-3 border-t border-line pt-3">
          <label htmlFor={`command-${target.id}`} className="mb-1.5 block text-body font-semibold tracking-[.15em] text-holo">任务目标</label>
          <div className="flex flex-wrap gap-1.5">
            <input
              id={`command-${target.id}`}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void dispatch(text); }}
              placeholder="下指令，回车即派…"
              maxLength={200}
              className="min-w-0 flex-1 basis-48 rounded border border-line bg-bg900 px-2.5 py-2 text-body text-ink outline-none placeholder:text-ink3/60 focus:border-gline"
            />
            <Button
              variant="primary"
              onClick={() => void dispatch(text)}
              disabled={busy || !text.trim()}
            >
              {busy ? "派发中…" : "下达任务"}
            </Button>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {tasks.map((t) => (
              <button
                key={t}
                onClick={() => void dispatch(t)}
                disabled={busy}
                className="rounded-full border border-line bg-bg900 px-2.5 py-1 text-body text-ink2 hover:border-gline hover:text-gold disabled:opacity-40"
              >
                {t}
              </button>
            ))}
          </div>
          {feedback && <div className="mt-2 rounded border border-amber-500/40 bg-amber-400/10 px-2 py-1.5 text-body text-amber-600" role="status">{feedback}</div>}
        </div>
    </Overlay>
  );
}
