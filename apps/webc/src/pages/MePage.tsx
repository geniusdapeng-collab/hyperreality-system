import { useEffect, useState } from "react";
import { api, getStoredUser } from "../lib/api";
import { getConfig, memberLevelLabel } from "../lib/config";
import { getDemoMember, getDemoOrders } from "../lib/demo";
import { startPrefetch } from "../lib/prefetch";
import type { MemberInfo, Order } from "../lib/types";
import { DemoBadge, PageHeader } from "../components/common";

export default function MePage({ onGoChat }: { onGoChat: () => void }) {
  const cfg = getConfig();
  const [member, setMember] = useState<MemberInfo | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [demo, setDemo] = useState(false);
  const user = getStoredUser();

  useEffect(() => {
    // 优先消费首屏并行预取结果；预取未命中再自行拉取
    void startPrefetch().then(async (p) => {
      let m = p.member;
      let o = p.orders;
      if (!m) {
        m = await api.member().catch(() => null);
      }
      if (!o) {
        o = await api.orders().then((r) => r.orders).catch(() => null);
      }
      if (m) setMember(m);
      else {
        setMember(getDemoMember());
        setDemo(true);
      }
      setOrders(o ?? getDemoOrders());
      setLoading(false);
    });
  }, []);

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="我的" right={demo ? <DemoBadge /> : undefined} />
      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {/* 会员卡片 */}
        <div className="overflow-hidden rounded-2xl border border-gline bg-gradient-to-br from-bg700 via-bg800 to-bg900 p-4">
          {loading ? (
            <div aria-hidden>
              <div className="flex items-center gap-3">
                <div className="skeleton h-12 w-12 rounded-full" />
                <div className="flex-1">
                  <div className="skeleton h-4 w-24" />
                  <div className="skeleton mt-2 h-3 w-16" />
                </div>
                <div className="skeleton h-7 w-14" />
              </div>
              <div className="mt-3 flex gap-1.5 border-t border-gline/40 pt-3">
                <div className="skeleton h-5 w-20 rounded-full" />
                <div className="skeleton h-5 w-24 rounded-full" />
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full border border-gline bg-gold/15 font-orb text-[16px] text-gold">
                    {user?.nickname?.slice(0, 1) ?? cfg.logoText}
                  </div>
                  <div>
                    <p className="text-[15px] font-semibold text-ink">
                      {user?.nickname ?? `${cfg.brandName}宾客`}
                    </p>
                    <p className="mt-0.5 flex items-center gap-1 text-[11px] text-gold">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 2l2.4 4.8 5.3.8-3.8 3.7.9 5.3L12 14.1 7.2 16.6l.9-5.3L4.3 7.6l5.3-.8L12 2z" />
                      </svg>
                      {member ? memberLevelLabel(member.level) : "…"}
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
            </>
          )}
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
          className="pressable flex w-full items-center justify-between rounded-2xl border border-line bg-card px-4 py-3.5 text-left active:bg-bg700"
        >
          <div>
            <p className="text-[13px] text-ink">历史会话</p>
            <p className="mt-0.5 text-[11px] text-ink3">继续与 AI 前台{cfg.agentName}的对话</p>
          </div>
          <span className="text-ink3">›</span>
        </button>

        {/* 客服电话（配置驱动） */}
        {cfg.supportPhone && (
          <a
            href={`tel:${cfg.supportPhone}`}
            className="pressable flex w-full items-center justify-between rounded-2xl border border-line bg-card px-4 py-3.5"
          >
            <div>
              <p className="text-[13px] text-ink">联系客服</p>
              <p className="mt-0.5 text-[11px] text-ink3">{cfg.supportPhone}</p>
            </div>
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-holo/10 text-holo">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" />
              </svg>
            </span>
          </a>
        )}

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
            {orders.length === 0 && !loading && <p className="text-[11px] text-ink3">暂无订单</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
