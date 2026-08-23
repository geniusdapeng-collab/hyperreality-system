import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { demoNotifications } from "../lib/demo";
import type { NotificationItem } from "../lib/types";
import { ServiceNoticeCard } from "../components/cards";
import { DemoBadge, PageHeader } from "../components/common";

export default function MessagesPage() {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [demo, setDemo] = useState(false);

  useEffect(() => {
    api
      .notifications()
      .then((r) => {
        setItems(r.notifications);
        setDemo(false);
      })
      .catch(() => {
        setItems(demoNotifications);
        setDemo(true);
      });
  }, []);

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="消息通知" right={demo ? <DemoBadge /> : undefined} />
      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {items.length === 0 && <p className="pt-16 text-center text-[12px] text-ink3">暂无通知</p>}
        {items.map((n, i) => {
          const p = n.payload as { title?: string; detail?: string; ticketId?: string };
          return (
            <ServiceNoticeCard
              key={i}
              kind={n.kind}
              title={p.title ?? "服务通知"}
              detail={p.detail ?? (p.ticketId ? `工单号 ${p.ticketId}` : undefined)}
              createdAt={n.createdAt}
              read={n.read}
            />
          );
        })}
      </div>
    </div>
  );
}
