/**
 * 驳回/改稿原因对话框（D24 自我进化飞轮 M1：受控枚举 + editKind 归因分流）
 *
 * 口径：
 *  - 驳回必须选择原因枚举（L5.2 + M1.2）：枚举来自本工作区装配的行业反馈枚举表
 *    （memory.feedbackEnums，Bundle 第⑧槽）；未装配时回落到底座中性兜底「其他」
 *    （D17/D18 红线：底座不预置行业词汇）；
 *  - 改稿（edit）手势强制二分 editKind：correction（纠错→缺陷池）/ preference（口味→偏好池），
 *    解决「改文案是纠错还是口味」的归因歧义（M1.3）；
 *  - 结构化原因是校准信号可信度的前提——自由文本只做补充说明（≤200 字 L5.2）。
 */
import { useEffect, useState } from "react";
import { trpc } from "../lib/trpc";

export interface RejectDialogResult {
  reasonEnum: string;
  reasonText?: string;
  /** 仅 edit 手势：纠错/口味二分（M1.3） */
  editKind?: "correction" | "preference";
}

interface EnumDef {
  code: string;
  label: string;
  appliesTo?: Array<"reject" | "edit">;
}

/** 底座中性兜底（未装配行业枚举表时；零行业词汇红线） */
const FALLBACK_ENUMS: EnumDef[] = [{ code: "other", label: "其他（请补充说明）" }];

export function RejectDialog(props: {
  open: boolean;
  /** reject=驳回（必选枚举）；edit=改稿（必选 editKind + 可选枚举补充） */
  mode: "reject" | "edit";
  title?: string;
  onCancel: () => void;
  onSubmit: (r: RejectDialogResult) => void;
}) {
  const { open, mode, onCancel, onSubmit } = props;
  const [enums, setEnums] = useState<EnumDef[]>(FALLBACK_ENUMS);
  const [reasonEnum, setReasonEnum] = useState("");
  const [reasonText, setReasonText] = useState("");
  const [editKind, setEditKind] = useState<"correction" | "preference" | "">("");

  useEffect(() => {
    if (!open) return;
    setReasonEnum("");
    setReasonText("");
    setEditKind("");
    trpc.memory.feedbackEnums
      .query()
      .then((defs) => {
        const list = (defs as EnumDef[]).filter((d) => !d.appliesTo || d.appliesTo.includes(mode));
        setEnums(list.length > 0 ? list : FALLBACK_ENUMS);
      })
      .catch(() => setEnums(FALLBACK_ENUMS)); // 接口异常不阻塞审批手势（驳回永远零摩擦）
  }, [open, mode]);

  if (!open) return null;

  const canSubmit = mode === "reject" ? reasonEnum !== "" : editKind !== "";
  const heading = props.title ?? (mode === "reject" ? "驳回原因（必选，L5.2）" : "改稿归因（必选，M1.3）");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onCancel}>
      <div
        className="w-[420px] rounded-xl border border-line bg-panel p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 text-sm font-semibold text-ink">{heading}</div>

        {mode === "edit" && (
          <div className="mb-3">
            <div className="mb-1.5 text-xs text-ink3">这次修改属于？（纠错进缺陷池，口味进偏好池）</div>
            <div className="flex gap-2">
              {([
                { key: "correction", label: "纠错", sub: "事实/数据错误" },
                { key: "preference", label: "口味", sub: "风格/偏好调整" },
              ] as const).map((k) => (
                <button
                  key={k.key}
                  onClick={() => setEditKind(k.key)}
                  className={`flex-1 rounded border px-3 py-2 text-left text-xs transition ${
                    editKind === k.key ? "border-gold bg-gold/10 text-ink" : "border-line text-ink3 hover:border-gold/50"
                  }`}
                >
                  <div className="font-semibold">{k.label}</div>
                  <div className="mt-0.5 opacity-70">{k.sub}</div>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="mb-3">
          <div className="mb-1.5 text-xs text-ink3">
            {mode === "reject" ? "原因枚举（行业受控词表，结构化才能校准）" : "原因枚举（可选补充）"}
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            {enums.map((d) => (
              <button
                key={d.code}
                onClick={() => setReasonEnum(d.code)}
                className={`rounded border px-2 py-1.5 text-left text-xs transition ${
                  reasonEnum === d.code ? "border-gold bg-gold/10 text-ink" : "border-line text-ink3 hover:border-gold/50"
                }`}
              >
                {d.label}
              </button>
            ))}
          </div>
        </div>

        <textarea
          value={reasonText}
          onChange={(e) => setReasonText(e.target.value.slice(0, 200))}
          placeholder="补充说明（可选，≤200 字）"
          className="mb-4 h-16 w-full resize-none rounded border border-line bg-bg950 px-2 py-1.5 text-xs text-ink outline-none focus:border-gold/60"
        />

        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="rounded border border-line px-3 py-1.5 text-xs text-ink3 hover:text-ink">
            取消
          </button>
          <button
            disabled={!canSubmit}
            onClick={() =>
              onSubmit({
                reasonEnum: reasonEnum || "other",
                reasonText: reasonText.trim() || undefined,
                editKind: mode === "edit" ? (editKind as "correction" | "preference") : undefined,
              })
            }
            className="rounded bg-gold px-4 py-1.5 text-xs font-semibold text-bg950 disabled:cursor-not-allowed disabled:opacity-40"
          >
            确认{mode === "reject" ? "驳回" : "提交"}
          </button>
        </div>
      </div>
    </div>
  );
}
