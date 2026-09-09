/**
 * P28 · 统一待办（PRD §6.1：登录后默认首页——跨 membership 聚合的审批/告警/工单收件箱，按店分组）
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { ensureDemoLogin, trpc } from "../../lib/trpc";

interface Group {
  workspaceId: string; slug: string; workspaceName: string; tenantName: string;
  role: string; industry: string; pendingApprovals: number;
}

const ROLE_LABEL: Record<string, string> = { owner: "老板", manager: "店长", staff: "员工", readonly: "查看" };

export default function P28() {
  const nav = useNavigate();
  const [groups, setGroups] = useState<Group[]>([]);
  const [err, setErr] = useState("");

  useEffect(() => {
    void (async () => {
      await ensureDemoLogin(); // 真实登录由 /login 完成；开发期保持演示兼容
      try {
        const svc = trpc.accounts.inbox as unknown as { unified: { query: () => Promise<{ groups: Group[] }> } };
        const r = await svc.unified.query();
        setGroups(r.groups);
      } catch (e) { setErr(e instanceof Error ? e.message : "加载失败"); }
    })();
  }, []);

  const total = groups.reduce((s, g) => s + g.pendingApprovals, 0);

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <h1 className="text-xl font-bold">统一待办</h1>
      <p className="mt-1 text-sm text-neutral-400">
        您在 {groups.length} 家店有 {total} 项待审批——点任意一家进入处理
      </p>
      {err && <p className="mt-3 text-sm text-red-400">{err}</p>}
      <div className="mt-6 space-y-3">
        {groups.map((g) => (
          <button
            key={g.workspaceId}
            onClick={() => nav("/p4")}
            className="flex w-full items-center justify-between rounded-xl border border-neutral-800 bg-neutral-900 px-5 py-4 text-left hover:border-emerald-600"
          >
            <div>
              <div className="font-semibold">{g.workspaceName}</div>
              <div className="mt-0.5 text-xs text-neutral-400">
                {g.tenantName} · {g.industry} · 我的角色：{ROLE_LABEL[g.role] ?? g.role}
              </div>
            </div>
            <div className="text-right">
              {g.pendingApprovals > 0 ? (
                <span className="rounded-full bg-amber-600/20 px-3 py-1 text-sm font-bold text-amber-400">
                  {g.pendingApprovals} 待审批
                </span>
              ) : (
                <span className="text-xs text-emerald-500">无待办 ✓</span>
              )}
            </div>
          </button>
        ))}
        {groups.length === 0 && !err && (
          <p className="rounded-xl border border-neutral-800 p-6 text-center text-sm text-neutral-500">
            暂无工作区成员关系——接受邀请或注册开通后，这里会聚合您所有店的待办
          </p>
        )}
      </div>
    </div>
  );
}
