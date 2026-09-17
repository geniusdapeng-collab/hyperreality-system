import { useEffect, useState } from "react";
import { AsyncState, EmptyState, Skeleton, clientIdentifierText } from "@workloom/ui";
import { api } from "../lib/api";
import { getConfigState } from "../lib/config";
import type { NotificationItem } from "../lib/types";
import { ServiceNoticeCard } from "../components/cards";
import { PageHeader, PullToRefresh } from "../components/common";

export default function MessagesPage() {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    if (!getConfigState().ready) {
      setItems([]);
      setError("服务配置尚未就绪，通知没有被当作空结果或演示数据处理。请恢复配置后重试。");
      setLoading(false);
      return;
    }
    try {
      const r = await api.notifications();
      setItems(r.notifications);
    } catch {
      setItems([]);
      setError("通知暂时无法读取；系统没有用演示通知替代真实结果。请检查网络后重试。");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="消息通知" />
      <PullToRefresh onRefresh={load} className="flex-1 px-4 py-4">
        {loading ? (
          <Skeleton count={3} variant="card" label="通知列表正在加载" />
        ) : error ? (
          <AsyncState status="error" title="通知读取失败" description={error} onRetry={() => void load()} />
        ) : items.length === 0 ? (
          <EmptyState title="暂无通知" desc="服务受理、完成与其他状态变更会出现在这里" />
        ) : (
          <div className="space-y-3">
            {items.map((n, i) => {
              const p = n.payload as { title?: string; detail?: string; ticketId?: string };
              return (
                <div key={n.id ?? i} className="animate-fadein" style={{ animationDelay: `${i * 50}ms` }}>
                  <ServiceNoticeCard
                    kind={n.kind}
                    title={p.title ?? "服务通知"}
                    detail={p.detail ?? (p.ticketId ? `工单${clientIdentifierText(p.ticketId)}` : undefined)}
                    createdAt={n.createdAt}
                    read={n.read}
                    deliveryState={n.deliveryState}
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
