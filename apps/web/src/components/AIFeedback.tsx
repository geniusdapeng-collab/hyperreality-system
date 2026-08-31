/**
 * AIFeedback · 👍/👎 一键升级重答组件（v3.0 反馈环产品化）
 *
 * 交互：AI 生成卡片右下角常驻 👍/👎；
 *  - 👍 → modelFeedback.submit（质量信号入事件库）；
 *  - 👎 → modelFeedback.escalate（升一档模型重新生成），对比展示「原回答 vs 升级版」；
 *    首次免费（24h 限免 1 次，防刷），超出按倍率实扣；L3 天花板 → 引导转人工。
 * 反馈数据回流驱动路由调表（场景升级率 >15% 自动上调默认档）。
 */
import { useState } from "react";
import { trpc } from "../lib/trpc";

export interface AIFeedbackProps {
  /** 路由场景（model-policy.yml 场景表 key） */
  scene: string;
  /** 业务动作标识（留痕用） */
  action: string;
  /** 原始提问（升级重答的输入） */
  prompt: string;
  /** 原回答文本（对比展示） */
  originalText: string;
  /** 原模型档（缺省 L2 中坚档） */
  fromTier?: "L1" | "L2" | "L3";
}

interface EscalateResult {
  escalated: boolean;
  fromTier: string;
  toTier: string | null;
  freeEscalation: boolean;
  kind: string;
  text: string | null;
  suggestHuman: boolean;
}

export function AIFeedback({ scene, action, prompt, originalText, fromTier = "L2" }: AIFeedbackProps) {
  const [voted, setVoted] = useState<"up" | "down" | null>(null);
  const [busy, setBusy] = useState(false);
  const [upgraded, setUpgraded] = useState<EscalateResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const vote = async (thumbs: "up" | "down") => {
    if (busy || voted) return;
    setBusy(true);
    setErr(null);
    try {
      if (thumbs === "up") {
        await trpc.modelFeedback.submit.mutate({ scene, action, thumbs: "up", originalTier: fromTier });
        setVoted("up");
      } else {
        const r = (await trpc.modelFeedback.escalate.mutate({
          scene, action, prompt, fromTier,
          fingerprint: `${scene}:${prompt.slice(0, 40)}`,
        })) as EscalateResult;
        setUpgraded(r);
        setVoted("down");
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-1.5">
      <div className="flex items-center gap-2 text-micro text-ink3">
        <span>回答有帮助吗？</span>
        <button
          type="button"
          disabled={busy || voted !== null}
          onClick={() => void vote("up")}
          className={`cursor-pointer rounded px-1.5 py-0.5 transition-colors ${
            voted === "up" ? "bg-emerald-500/20 text-emerald-300" : "hover:bg-white/5"
          } disabled:opacity-50`}
          title="满意"
        >👍</button>
        <button
          type="button"
          disabled={busy || voted !== null}
          onClick={() => void vote("down")}
          className={`cursor-pointer rounded px-1.5 py-0.5 transition-colors ${
            voted === "down" ? "bg-rose-500/20 text-rose-300" : "hover:bg-white/5"
          } disabled:opacity-50`}
          title="不满意——换更强大脑重答"
        >👎</button>
        {busy && <span className="animate-pulse">更强大脑思考中…</span>}
        {voted === "up" && <span className="text-emerald-300/80">已收到，感谢反馈</span>}
        {err && <span className="text-rose-300/80">{err}</span>}
      </div>

      {upgraded && (
        <div className="mt-2 rounded-md border border-holo/30 bg-holo/5 p-2">
          <div className="mb-1 flex items-center gap-2 text-micro">
            <span className="text-holo">升级版回答（{upgraded.fromTier} → {upgraded.toTier ?? "—"}）</span>
            {upgraded.freeEscalation
              ? <span className="rounded bg-emerald-500/15 px-1.5 text-emerald-300">本次免费</span>
              : <span className="rounded bg-amber-500/15 px-1.5 text-amber-300">按倍率实扣</span>}
          </div>
          {upgraded.text ? (
            <div className="whitespace-pre-wrap text-caption text-ink">{upgraded.text}</div>
          ) : (
            <div className="text-caption text-ink3">
              {upgraded.suggestHuman
                ? "已是最强模型档——建议转人工/工单，由值班同事跟进（三级兜底）。"
                : "升级模型暂时不可用，已留痕，稍后可在任务中心重试。"}
            </div>
          )}
          <details className="mt-1 text-micro text-ink3">
            <summary className="cursor-pointer">查看原回答（{fromTier}）</summary>
            <div className="mt-1 whitespace-pre-wrap opacity-70">{originalText}</div>
          </details>
        </div>
      )}
    </div>
  );
}
