import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { DemoBadge, PageHeader } from "../components/common";

type Kind = "delivery" | "repair" | "complaint" | "other";

const SERVICES: { kind: Kind; title: string; desc: string; icon: string }[] = [
  { kind: "delivery", title: "售后退换", desc: "退换货 / 配件补发 / 质量问题", icon: "换" },
  { kind: "repair", title: "物流催办", desc: "发货慢 / 物流异常一键催办", icon: "催" },
  { kind: "complaint", title: "投诉建议", desc: "您的意见让我们更好", icon: "诉" },
  { kind: "other", title: "其他需求", desc: "更多个性化服务", icon: "他" },
];

const SLA: Record<Kind, string> = {
  delivery: "约 15 分钟内送达",
  repair: "约 30 分钟内上门",
  complaint: "值班经理 2 小时内回复",
  other: "服务专员 30 分钟内响应",
};

export default function ServicePage({ prefill }: { prefill: Kind | null }) {
  const [step, setStep] = useState<"home" | "form" | "done">("home");
  const [kind, setKind] = useState<Kind>("delivery");
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [room, setRoom] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [ticketId, setTicketId] = useState("");
  const [demo, setDemo] = useState(false);

  useEffect(() => {
    if (prefill) {
      setKind(prefill);
      setTitle("");
      setStep("form");
    }
  }, [prefill]);

  const openForm = (k: Kind) => {
    setKind(k);
    setTitle("");
    setDesc("");
    setDemo(false);
    setStep("form");
  };

  const submit = async () => {
    if (!title.trim() || submitting) return;
    setSubmitting(true);
    try {
      const t = await api.createTicket({
        kind,
        title: title.trim(),
        payload: { description: desc.trim(), room: room.trim() },
      });
      setTicketId(t.id);
    } catch {
      setDemo(true);
      setTicketId(`TK-DEMO-${Math.floor(Math.random() * 900 + 100)}`);
    } finally {
      setSubmitting(false);
      setStep("done");
    }
  };

  if (step === "done") {
    const svc = SERVICES.find((s) => s.kind === kind)!;
    return (
      <div className="flex h-full flex-col">
        <PageHeader title="提交成功" />
        <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full border border-go/50 bg-go/10">
            <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#3dffb2" strokeWidth="2.5">
              <path d="M20 6L9 17l-5-5" />
            </svg>
          </div>
          <h2 className="mt-4 text-[17px] font-semibold text-ink">工单已提交</h2>
          <p className="mt-2 font-mono text-[13px] text-gold">{ticketId}</p>
          <p className="mt-2 text-[12px] text-ink2">
            {svc.title} · {SLA[kind]}
          </p>
          {demo && (
            <div className="mt-3">
              <DemoBadge />
            </div>
          )}
          <button
            type="button"
            onClick={() => setStep("home")}
            className="mt-8 h-10 w-full rounded-full bg-gold text-[14px] font-medium text-ongold"
          >
            返回服务大厅
          </button>
        </div>
      </div>
    );
  }

  if (step === "form") {
    const svc = SERVICES.find((s) => s.kind === kind)!;
    return (
      <div className="flex h-full flex-col">
        <PageHeader
          title={`${svc.title}`}
          right={
            <button type="button" onClick={() => setStep("home")} className="text-[12px] text-ink2">
              返回
            </button>
          }
        />
        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
          <div className="flex items-center gap-2 rounded-xl border border-gline bg-gold/5 px-3 py-2.5 text-[12px] text-goldhi">
            <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-gold/15 text-[12px] font-semibold text-gold">{svc.icon}</span>
            工单类型已预填：{svc.title} · {SLA[kind]}
          </div>
          <label className="block">
            <span className="mb-1.5 block text-[12px] text-ink2">标题 *</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={`例如：${kind === "delivery" ? "补充两瓶矿泉水" : kind === "repair" ? "空调制冷效果差" : "请描述您的需求"}`}
              className="h-11 w-full rounded-xl border border-line bg-bg900 px-3.5 text-[13.5px] text-ink outline-none placeholder:text-ink3 focus:border-gline"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[12px] text-ink2">详细描述</span>
            <textarea
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              rows={4}
              placeholder="补充数量、时间、具体情况等"
              className="w-full resize-none rounded-xl border border-line bg-bg900 px-3.5 py-3 text-[13.5px] text-ink outline-none placeholder:text-ink3 focus:border-gline"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[12px] text-ink2">订单号/联系方式</span>
            <input
              value={room}
              onChange={(e) => setRoom(e.target.value)}
              placeholder="例如 1208"
              inputMode="numeric"
              className="h-11 w-full rounded-xl border border-line bg-bg900 px-3.5 text-[13.5px] text-ink outline-none placeholder:text-ink3 focus:border-gline"
            />
          </label>
        </div>
        <div className="border-t border-line px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!title.trim() || submitting}
            className="h-11 w-full rounded-full bg-gold text-[14px] font-medium text-ongold disabled:opacity-40"
          >
            {submitting ? "提交中…" : "提交工单"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="服务大厅" />
      <div className="grid flex-1 grid-cols-2 content-start gap-3 overflow-y-auto px-4 py-4">
        {SERVICES.map((s) => (
          <button
            key={s.kind}
            type="button"
            onClick={() => openForm(s.kind)}
            className="flex flex-col items-start gap-2 rounded-2xl border border-line bg-card p-4 text-left active:border-gline active:bg-bg700"
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-gold/10 text-[16px] font-semibold text-gold">
              {s.icon}
            </span>
            <span className="text-[14px] font-medium text-ink">{s.title}</span>
            <span className="text-[11px] leading-relaxed text-ink3">{s.desc}</span>
            <span className="mt-auto text-[10px] text-gold">{SLA[s.kind]}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
