import { clientIdentifierText } from "@workloom/ui";

/**
 * EventIdChip #E 事件编号（设计规范 §10：等宽青色，点击展开决策链路 F1.12）
 * 数据/编号/回执一律全息青（§2.2）；编号禁止换行（§3 mono 规则，tokens.css 全局）。
 */
export function EventIdChip({ id, onClick }: { id: string; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="点击展开决策链路"
      aria-label={`查看事件${clientIdentifierText(id)}的决策链路`}
      className="max-w-full cursor-pointer break-all rounded border border-holo/30 bg-holo/5 px-1.5 py-0.5 font-mono text-body text-holo transition-colors hover:border-holo/60"
    >
      {clientIdentifierText(id)}
    </button>
  );
}
