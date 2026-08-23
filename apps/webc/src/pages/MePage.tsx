import { useEffect, useState } from "react";
import { api, getStoredUser } from "../lib/api";
import { demoMember, demoOrders } from "../lib/demo";
import type { MemberInfo, Order } from "../lib/types";
import { DemoBadge, PageHeader } from "../components/common";

export default function MePage({ onGoChat }: { onGoChat: () => void }) {
  const [member, setMember] = useState<MemberInfo | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [demo, setDemo] = useState(false);
  const user = getStoredUser();

  useEffect(() => {
    api
      .member()
      .then(setMember)
      .catch(() => {
        setMember(demoMember);
        setDemo(true);
      });
    api
      .orders()
      .then((r) => setOrders(r.orders))
      .catch(() => setOrders(demoOrders));
  }, []);

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="我的" right={demo ? <DemoBadge /> : undefined} />
      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {/* 会员卡片 */}
        <div className="overflow-hidden rounded-2xl border border-gline bg-gradient-to-br from-bg700 via-bg800 to-bg900 p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-full border border-gline bg-gold/15 font-orb text-[16px] text-gold">
                {user?.nickname?.slice(0, 1) ?? "宾"}
              </div>
              <div>
                <p className="text-[15px] font-semibold text-ink">{user?.nickname ?? "星芒客户"}</p>
                <p className="mt-0.5 flex items-center gap-1 text-[11px] text-gold">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 2l2.4 4.8 5.3.8-3.8 3.7.9 5.3L12 14.1 7.2 16.6l.9-5.3L4.3 7.6l5.3-.8L12 2z" />
                  </svg>
                  {member?.level ?? "…"}
                </p>
              </div>
            </div>
            <div className="text-right">
              <p className="font-orb text-[20px] text-goldhi">{member?.points ?? "…"}</p>
              <p className="text-[10px] text-ink3">当前积分</p>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5 border-t border-gline/40 pt-3">
            {(member?.benefits ?? []).map((b) => (
              <span key={b} className="rounded-full bg-gold/10 px-2.5 py-1 text-[10.5px] text-goldhi">
                {b}
              </span>
            ))}
          </div>
        </div>

        {/* 身份绑定状态 */}
        <div className="flex items-center justify-between rounded-2xl border border-line bg-card px-4 py-3">
          <div>
            <p className="text-[13px] text-ink">身份绑定</p>
            <p className="mt-0.5 text-[11px] text-ink3">
              {user?.memberId ? `会员号 ${user.memberId}` : "H5 游客身份 · 绑定会员享积分"}
            </p>
          </div>
          <span
            className={`rounded-full border px-2.5 py-1 text-[11px] ${
              user?.memberId ? "border-go/50 bg-go/10 text-go" : "border-gline bg-gold/10 text-gold"
            }`}
          >
            {user?.memberId ? "已绑定" : "去绑定"}
          </span>
        </div>

        {/* 历史会话入口 */}
        <button
          type="button"
          onClick={onGoChat}
          className="flex w-full items-center justify-between rounded-2xl border border-line bg-card px-4 py-3.5 text-left active:bg-bg700"
        >
          <div>
            <p className="text-[13px] text-ink">历史会话</p>
            <p className="mt-0.5 text-[11px] text-ink3">继续与 AI 前台小芒的对话</p>
          </div>
          <span className="text-ink3">›</span>
        </button>

        {/* 近期订单摘要 */}
        <div className="rounded-2xl border border-line bg-card p-4">
          <p className="text-[13px] font-medium text-ink">近期订单</p>
          <div className="mt-2.5 space-y-2.5">
            {orders.slice(0, 3).map((o) => (
              <div key={o.id} className="flex items-center justify-between text-[12px]">
                <span className="text-ink2">{o.title}</span>
                <span className="text-ink3">{o.status}</span>
              </div>
            ))}
            {orders.length === 0 && <p className="text-[11px] text-ink3">暂无订单</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
