import { useState } from "react";
import { Icon, StatusChip, clientChineseText, clientValueText } from "@workloom/ui";
import { getConfig } from "../lib/config";
import type { CatalogInfo, Citation, MemberInfo, BusinessRecord } from "../lib/types";
import { formatTime } from "./common";

/** AI 答案下方的引用来源卡（可展开/收起） */
export function CitationCard({ citations }: { citations: Citation[] }) {
  const [open, setOpen] = useState(false);
  if (citations.length === 0) return null;
  return (
    <div className="mt-2 min-w-0 animate-fadein overflow-hidden rounded-xl border border-holo/30 bg-holo/5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="pressable flex min-w-0 w-full items-center justify-between gap-2 px-3 py-2 text-left"
      >
        <span className="flex min-w-0 items-center gap-1.5 break-words text-body text-holo">
          <Icon name="book" size={12} />
          引用来源 · {citations.length} 条
        </span>
        <Icon name="chevron" size={14} className={`text-holo transition-transform duration-200 ${open ? "-rotate-90" : "rotate-90"}`} />
      </button>
      {open && (
        <div className="animate-fadein space-y-2 border-t border-holo/20 px-3 py-2">
          {citations.map((c, i) => (
            <div key={i} className="min-w-0 rounded-lg bg-bg900/60 p-2">
              <p className="break-words text-body font-medium text-holo">
                《{clientChineseText(c.documentTitle, "参考资料")}》 · {clientChineseText(c.heading, "相关章节")}
              </p>
              <p className="mt-1 break-words text-body leading-relaxed text-ink2">{clientChineseText(c.content, "引用内容暂无法安全展示")}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 订单业务卡 */
export function OrderCard({ order }: { order: BusinessRecord }) {
  return (
    <div className="mt-2 animate-fadein overflow-hidden rounded-xl border border-gline bg-card">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 bg-gold/10 px-3 py-1.5">
        <span className="min-w-0 break-words text-body font-medium text-gold">
          {clientChineseText(order.cardTitle, "业务记录")}
        </span>
        {order.referenceText && (
          <span className="min-w-0 break-all text-body text-ink3">
            {clientValueText(order.referenceText)}
          </span>
        )}
      </div>
      <div className="px-3 py-2.5">
        <div className="flex min-w-0 items-start justify-between gap-2">
          <p className="min-w-0 break-words text-body font-medium text-ink">
            {clientChineseText(order.title, "业务记录")}
          </p>
          <StatusChip status={clientChineseText(order.statusText, "状态待确认")} />
        </div>
        <div className="mt-2 grid min-w-0 gap-1.5 text-body text-ink2">
          {order.details.map((field, index) => (
            <div key={`${field.label}-${index}`} className="flex min-w-0 items-start justify-between gap-3">
              <span className="shrink-0 text-ink3">{clientChineseText(field.label, "详情")}</span>
              <span className="min-w-0 break-words text-right">{clientValueText(field.value)}</span>
            </div>
          ))}
          {order.amountText && (
            <div className="flex min-w-0 items-start justify-between gap-3 border-t border-line/60 pt-1.5">
              <span className="shrink-0 text-ink3">金额</span>
              <span className="min-w-0 break-words text-right font-orb text-gold">
                {clientValueText(order.amountText)}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** 会员业务卡 */
export function MemberCard({ member }: { member: MemberInfo }) {
  return (
    <div className="mt-2 animate-fadein overflow-hidden rounded-xl border border-gline bg-gradient-to-br from-bg700 to-bg800">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 pt-3">
        <span className="flex min-w-0 items-center gap-1.5 break-words text-body font-semibold text-gold">
          <Icon name="star" size={14} fill="currentColor" stroke="none" />
          {clientChineseText(member.title, "用户权益")}
        </span>
        {member.metric && (
          <span className="min-w-0 break-words text-right font-orb text-[0.9375rem] text-goldhi">
            {clientChineseText(member.metric.label, "权益值")} {clientValueText(member.metric.value)}
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5 px-3 py-2.5">
        {member.benefits.map((b) => (
          <span key={b} className="max-w-full break-words rounded-full bg-gold/10 px-2 py-0.5 text-body text-goldhi">
            {clientChineseText(b, "权益待确认")}
          </span>
        ))}
        {member.benefits.length === 0 && <span className="text-body text-ink3">暂无可展示权益</span>}
      </div>
    </div>
  );
}

/** 配置驱动的服务目录业务卡 */
export function CatalogCard({ catalog }: { catalog: CatalogInfo }) {
  return (
    <div className="mt-2 animate-fadein overflow-hidden rounded-xl border border-gline bg-card">
      <div className="break-words bg-gold/10 px-3 py-1.5 text-body font-medium text-gold">
        {clientChineseText(catalog.cardTitle, "服务目录")}
      </div>
      <div className="divide-y divide-line/60 px-3">
        {catalog.items.map((item) => (
          <div key={item.id} className="min-w-0 py-2 text-body">
            <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-1">
              <span className="min-w-0 break-words text-ink">
                {clientChineseText(item.title, "服务项目")}
              </span>
              {item.priceText && (
                <span className="shrink-0 font-orb text-body text-gold">{clientValueText(item.priceText)}</span>
              )}
            </div>
            {item.summary && (
              <p className="mt-1 break-words text-ink3">{clientChineseText(item.summary, "详情待确认")}</p>
            )}
            {item.details.map((field, index) => (
              <p key={`${field.label}-${index}`} className="mt-1 break-words text-ink2">
                {clientChineseText(field.label, "详情")}：{clientValueText(field.value)}
              </p>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** 工单草稿/已受理状态卡：只有服务端返回真实工单时才能展示“已受理”。 */
export function TicketNoticeCard({ title, state }: { title: string; state: "draft" | "accepted" }) {
  return (
    <div className="mt-2 flex animate-fadein items-start gap-2.5 rounded-xl border border-warn/40 bg-warn/10 p-3">
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-warn/20 text-warn">
        <Icon name="notice" size={14} />
      </span>
      <div className="min-w-0">
        <p className="text-body font-medium text-warn">{state === "accepted" ? "工单已受理" : "尚未提交"}</p>
        <p className="mt-0.5 break-words text-body leading-relaxed text-ink2">{title}</p>
      </div>
    </div>
  );
}

/** 仿微信服务通知卡 */
export function ServiceNoticeCard({
  kind,
  title,
  detail,
  createdAt,
  read,
  deliveryState,
}: {
  kind: string;
  title: string;
  detail?: string;
  createdAt: string;
  read: boolean;
  deliveryState?: "demo" | "pending" | "failed" | "sent";
}) {
  const label =
    kind === "ticket.completed"
      ? "工单完成通知"
      : kind === "ticket.accepted"
        ? "工单受理通知"
        : kind === "member.benefit"
          ? "会员权益通知"
          : "服务通知";
  const tone = kind === "ticket.completed" ? "text-go" : kind === "ticket.accepted" ? "text-holo" : "text-gold";
  const deliveryLabel = deliveryState === "demo"
    ? "演示未发送"
    : deliveryState === "pending"
      ? "等待发送"
      : deliveryState === "failed"
        ? "发送失败"
        : deliveryState === "sent"
          ? "已发送"
          : null;
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-card">
      <div className="flex min-w-0 items-center justify-between gap-2 border-b border-line px-3 py-2">
        <span className={`min-w-0 break-words text-body font-medium ${tone}`}>{label}</span>
        <span className="flex shrink-0 items-center gap-1.5 text-body text-ink3">
          {!read && <span className="h-1.5 w-1.5 rounded-full bg-alert" />}
          {formatTime(createdAt)}
        </span>
      </div>
      <div className="px-3 py-2.5">
        <p className="break-words text-body font-medium text-ink">{clientChineseText(title, "服务通知")}</p>
        {detail && <p className="mt-1 break-words text-body leading-relaxed text-ink2">{clientChineseText(detail, "服务进度已更新")}</p>}
        {deliveryLabel && (
          <p className={`mt-2 text-body ${deliveryState === "failed" ? "text-alert" : deliveryState === "sent" ? "text-go" : "text-warn"}`}>
            通知状态：{deliveryLabel}
          </p>
        )}
      </div>
      <div className="border-t border-line px-3 py-1.5 text-body text-ink3">
        {getConfig().brandName} · AI 服务前台
      </div>
    </div>
  );
}
