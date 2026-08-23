import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { getDemoNotifications } from "../lib/demo";
import type { NotificationItem } from "../lib/types";
import { ServiceNoticeCard } from "../components/cards";
import { DemoBadge, EmptyState, PageHeader, PullToRefresh, SkeletonList } from "../components/common";

export default function MessagesPage() {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [demo, setDemo] = useState(false);

  const load = async () => {
    try {
      const r = await api.notifications();
      setItems(r.notifications);
      setDemo(false);
    } catch {
      setItems(getDemoNotifications());
      setDemo(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="消息通知" right={demo ? <DemoBadge /> : undefined} />
      <PullToRefresh onRefresh={load} className="flex-1 px-4 py-4">
        {loading ? (
          <SkeletonList rows={3} />
        ) : items.length === 0 ? (
          <EmptyState title="暂无通知" desc="工单受理、完成与会员权益通知会出现在这里" />
        ) : (
          <div className="space-y-3">
            {items.map((n, i) => {
              const p = n.payload as { title?: string; detail?: string; ticketId?: string };
              return (
                <div key={n.id ?? i} className="animate-fadein" style={{ animationDelay: `${i * 50}ms` }}>
                  <ServiceNoticeCard
                    kind={n.kind}
                    title={p.title ?? "服务通知"}
                    detail={p.detail ?? (p.ticketId ? `工单号 ${p.ticketId}` : undefined)}
                    createdAt={n.createdAt}
                    read={n.read}
                  />
                </div>
              );
            })}
          </div>
        )}
      </PullToRefresh>
    </div>
  );
}
