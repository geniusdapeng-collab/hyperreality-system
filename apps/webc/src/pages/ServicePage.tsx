import { useEffect, useState } from "react";
import { ApiError, api } from "../lib/api";
import { getConfig, getConfigState, type ServiceEntry } from "../lib/config";
import type { ActionReceipt, ActionState } from "../lib/types";
import { EmptyState, Icon, Input, Textarea, clientIdentifierText } from "@workloom/ui";
import { PageHeader, chineseMessage } from "../components/common";

export default function ServicePage({ prefill }: { prefill: string | null }) {
  const cfg = getConfig();
  const configState = getConfigState();
  const entries = cfg.serviceEntries;
  const [step, setStep] = useState<"home" | "form" | "done">("home");
  const [entry, setEntry] = useState<ServiceEntry | null>(entries[0] ?? null);
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [reference, setReference] = useState("");
  const [actionState, setActionState] = useState<ActionState>("idle");
  const [receipt, setReceipt] = useState<ActionReceipt | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (prefill) {
      const hit = entries.find((e) => e.kind === prefill);
      if (hit) {
        setEntry(hit);
        setTitle("");
        setStep("form");
      }
    }
  }, [prefill, entries]);

  const openForm = (e: ServiceEntry) => {
    setEntry(e);
    setTitle("");
    setDesc("");
    setReference("");
    setError("");
    setReceipt(null);
    setActionState("idle");
    setStep("form");
  };

  const submit = async () => {
    if (!entry || !title.trim() || actionState === "pending") return;
    setActionState("pending");
    setError("");
    try {
      const result = await api.createTicket({
        kind: entry.kind,
        title: title.trim(),
        payload: { description: desc.trim(), reference: reference.trim() },
      });
      setReceipt(result.receipt);
      setActionState(result.receipt.demo ? "demo" : "success");
      setStep("done");
    } catch (err) {
      const requestId = err instanceof ApiError ? err.requestId : undefined;
      const message = chineseMessage(err instanceof Error ? err.message : null, "提交失败，请稍后重试");
      setError(`${message}${requestId ? `（请求${clientIdentifierText(requestId)}）` : ""}`);
      setActionState("failed");
    }
  };

  if (step === "done") {
    return (
      <div className="flex h-full flex-col">
        <PageHeader title={actionState === "demo" ? "演示记录" : "工单已受理"} />
        <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-8 py-6 text-center">
          <div className="flex h-16 w-16 animate-pop items-center justify-center rounded-full border border-go/50 bg-go/10">
            <Icon name="check" size={30} stroke="#3dffb2" strokeWidth="2.5" />
          </div>
          <h2 className="mt-4 break-words text-[1.0625rem] font-semibold text-ink">工单已真实写入并受理</h2>
          <p className="mt-2 max-w-full break-words text-body text-gold">工单{clientIdentifierText(receipt?.resourceId)}</p>
          <p className="mt-2 break-words text-body text-ink2">
            {entry?.title} · {entry?.sla}
          </p>
          {receipt?.delivery?.state === "demo" && (
            <p className="mt-3 rounded-xl border border-warn/40 bg-warn/10 px-3 py-2 text-body leading-relaxed text-warn">
              工单已受理；外部通知通道为演示模式，未向真实渠道发送。
            </p>
          )}
          {receipt?.delivery?.state === "pending" && (
            <p className="mt-3 text-body text-ink3">工单已受理，通知正在等待发送。</p>
          )}
          {receipt?.delivery?.state === "failed" && (
            <p className="mt-3 text-body text-alert">工单已受理，但通知发送失败；请在「工单」页查看进度。</p>
          )}
          <p className="mt-2 max-w-full break-words text-body text-ink3">请求回执：{clientIdentifierText(receipt?.requestId)}</p>
          {receipt?.eventId && <p className="mt-1 max-w-full break-words text-body text-ink3">账本凭证：{clientIdentifierText(receipt.eventId)}</p>}
          <button
            type="button"
            onClick={() => setStep("home")}
            className="pressable mt-8 min-h-10 w-full rounded-full bg-gold px-4 py-2 text-[0.875rem] font-medium leading-snug text-ongold"
          >
            返回服务大厅
          </button>
        </div>
      </div>
    );
  }

  if (step === "form" && entry) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader
          title={entry.title}
          right={
            <button type="button" onClick={() => setStep("home")} className="text-body text-ink2">
              返回
            </button>
          }
        />
        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
          <div className="flex min-w-0 items-start gap-2 rounded-xl border border-gline bg-gold/5 px-3 py-2.5 text-body text-goldhi">
            <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-gold/15 text-body font-semibold text-gold">
              {entry.icon}
            </span>
            <span className="min-w-0 break-words">工单类型已预填：{entry.title} · {entry.sla}</span>
          </div>
          {/* 共享表单控件：标签、错误与无障碍语义由基座统一提供（不得在本仓重写表单控件） */}
          <Input
            label="标题"
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={entry.titlePlaceholder ?? "请描述您的需求"}
          />
          <Textarea
            label="详细描述"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            rows={4}
            placeholder="补充数量、时间、具体情况等"
            className="resize-none"
          />
          <Input
            label="相关位置或编号"
            description="选填；例如订单号、地点或设备编号"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="订单号、地点或设备编号"
          />
          {error && (
            <div role="alert" className="break-words rounded-xl border border-alert/50 bg-alert/10 px-3 py-2.5 text-body leading-relaxed text-alert">
              {error}
            </div>
          )}
        </div>
        <div className="border-t border-line px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!title.trim() || actionState === "pending"}
            className="pressable min-h-11 w-full rounded-full bg-gold px-5 py-2.5 text-[0.875rem] font-medium leading-snug text-ongold disabled:opacity-40"
          >
            {actionState === "pending" ? "正在提交，请勿关闭页面…" : actionState === "failed" ? "重新提交" : "提交工单"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="服务大厅" />
      {entries.length === 0 ? (
        <div className="flex-1 overflow-y-auto">
          <EmptyState
            title="服务入口暂不可用"
            desc={configState.message ?? "服务配置尚未就绪，请稍后重试或联系服务方。"}
          />
        </div>
      ) : (
        <div className="grid flex-1 grid-cols-1 content-start gap-3 overflow-y-auto px-4 py-4 min-[360px]:grid-cols-2">
          {entries.map((s, i) => (
          <button
            key={s.kind}
            type="button"
            onClick={() => openForm(s)}
            className="pressable flex animate-fadein flex-col items-start gap-2 rounded-2xl border border-line bg-card p-4 text-left active:border-gline active:bg-bg700"
            style={{ animationDelay: `${i * 60}ms` }}
          >
            <span className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-xl bg-gold/10 text-center text-[1rem] font-semibold text-gold" aria-hidden>
              {s.icon}
            </span>
            <span className="break-words text-[0.875rem] font-medium text-ink">{s.title}</span>
            <span className="break-words text-body leading-relaxed text-ink3">{s.desc}</span>
            <span className="mt-auto break-words text-body text-gold">{s.sla}</span>
          </button>
          ))}
        </div>
      )}
    </div>
  );
}
