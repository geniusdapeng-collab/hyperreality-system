/**
 * DispatchBar 航线设定台（设计规范 §5.1；派遣输入框，P1 常驻底部）
 * 结构：航线图标（金色径向渐变方块）+ 输入区 + 上下文 chips（全息青描边 ≥1 项）
 *      + 三态 pill（主线 Quest 默认选中·金边发光）+ 金色「启航 ▶」按钮
 * 状态：empty 空文本置灰（深空 700 底）/ typing 输入中 / routing 路由识别中（>3s 可取消，F3.2）
 * 铁律：「启航」为全站唯一最高级金色按钮；每页至多 1 个（§5.1）
 */
import { Icon, clientValueText } from "@workloom/ui";

export type DispatchBarState = "empty" | "typing" | "routing";

export function DispatchBar({
  state = "empty",
  value = "",
  chips = ["当前工作区 · 正常运行"],
  onCancelRoute,
  onChange,
  onSubmit,
}: {
  state?: DispatchBarState;
  value?: string;
  chips?: string[];
  onCancelRoute?: () => void;
  /** 受控输入（P1 接线；缺省为纯展示态） */
  onChange?: (v: string) => void;
  /** Enter 或「启航」提交（空文本不可点——§5.1） */
  onSubmit?: () => void;
}) {
  return (
    <div className="rounded-msg border border-gline bg-card p-3 shadow-[0_0_30px_rgba(255,160,60,.10)]">
      <div className="flex flex-wrap items-center gap-3">
        {/* 航线图标（金色径向渐变方块） */}
        <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg gold-grad text-ongold shadow-[0_0_16px_rgba(255,160,60,.5)]"><Icon name="rocket" size={17} /></span>
        {/* 输入区（受控；≤500 字 F3.1） */}
        <div
          className={`min-w-0 flex-1 basis-48 rounded-lg border px-3 py-2 text-body transition-colors ${
            state === "empty" ? "border-line bg-bg700 text-ink3" : "border-gline bg-bg800 text-ink"
          }`}
        >
          {state === "routing" ? (
            <span className="inline-flex items-center gap-2 text-holo">
              识别中…
              <span className="inline-block h-3 w-3 animate-spin rounded-full border border-holo border-t-transparent" />
            </span>
          ) : onChange ? (
            <input
              value={value}
              maxLength={500}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && value.trim()) onSubmit?.(); }}
              placeholder="说出一句话目标…（最多 500 字）"
              className="w-full bg-transparent text-ink outline-none placeholder:text-ink3"
            />
          ) : (
            (state === "empty" ? "说出一句话目标…（最多 500 字）" : value)
          )}
        </div>
        {/* 三态 pill（主线 Quest 默认选中·金边发光） */}
        <div className="flex min-w-0 flex-wrap gap-1.5 text-body">
          <span className="rounded-md border border-gold/70 bg-gold/10 px-2.5 py-1 font-bold text-gold shadow-[0_0_10px_rgba(214,220,228,.25)]">
            主线任务
          </span>
          <span className="rounded-md border border-line px-2.5 py-1 text-ink3">闲聊</span>
          <span className="rounded-md border border-line px-2.5 py-1 text-ink3">夜班</span>
        </div>
        {/* 启航：全站唯一最高级金色按钮（sheen 流光，§7） */}
        {state === "routing" ? (
          <button
            type="button"
            onClick={onCancelRoute}
            className="cursor-pointer rounded-lg border border-alert/55 bg-alert/7 px-4 py-2 text-body font-bold text-alert"
          >
            取消
          </button>
        ) : (
          <button
            type="button"
            disabled={!value.trim()}
            onClick={onSubmit}
            className="relative cursor-pointer overflow-hidden rounded-lg gold-grad px-4 py-2 text-body font-black text-ongold shadow-[0_0_18px_rgba(255,160,60,.45)] disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
          >
            <span className="relative z-10 inline-flex items-center gap-1">启航 <Icon name="send" size={14} /></span>
            <span
              className="pointer-events-none absolute inset-y-0 w-1/3 animate-sheen"
              style={{ background: "linear-gradient(105deg,transparent,rgba(255,255,255,.5),transparent)" }}
            />
          </button>
        )}
      </div>
      {/* 上下文 chips（全息青描边 ≥1 项） */}
      <div className="mt-2 flex min-w-0 flex-wrap gap-1.5 pl-0 sm:pl-11">
        {chips.map((c) => (
          <span key={c} className="max-w-full break-words rounded-md border border-holo/35 bg-holo/5 px-2 py-0.5 text-body text-holo">
            {clientValueText(c)}
          </span>
        ))}
      </div>
    </div>
  );
}
