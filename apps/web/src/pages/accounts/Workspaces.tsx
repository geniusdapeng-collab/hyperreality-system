import { AsyncState, Badge, Button, Card } from "@workloom/ui";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { MEMBER_ROLE_TEXT, dictText } from "../../lib/display";
import { ensureDemoLogin, trpc } from "../../lib/trpc";
import { workspaceIndustryText } from "./systemText";

interface WorkspaceMembership {
  workspaceId: string;
  workspaceName: string;
  tenantName: string;
  industry: string;
  role: string;
  pendingApprovals: number;
}

export default function Workspaces() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<"loading" | "ready" | "empty" | "error">("loading");
  const [rows, setRows] = useState<WorkspaceMembership[]>([]);

  const load = useCallback(async () => {
    setStatus("loading");
    try {
      await ensureDemoLogin();
      const service = trpc.accounts.inbox as unknown as {
        unified: { query: () => Promise<{ groups: WorkspaceMembership[] }> };
      };
      const result = await service.unified.query();
      setRows(result.groups.map((row) => ({
        ...row,
        industry: workspaceIndustryText(row.industry),
      })));
      setStatus(result.groups.length > 0 ? "ready" : "empty");
    } catch (cause) {
      console.warn("读取工作区失败", cause);
      setStatus("error");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <main className="mx-auto min-w-0 max-w-4xl px-5 py-8" data-workloom-client="b-pc">
      <div className="mb-6">
        <h1 className="text-h1 font-black text-ink">租户与工作区</h1>
        <p className="mt-1 text-body leading-relaxed text-ink3">
          每个工作区的数据、权限和事件账本独立隔离；您只会看到当前身份有权访问的范围。
        </p>
      </div>

      <AsyncState
        status={status}
        title={status === "empty" ? "暂无可访问的工作区" : undefined}
        description={status === "empty" ? "接受邀请或完成正式开通后，工作区会显示在这里。" : undefined}
        onRetry={() => void load()}
      >
        <div className="grid gap-3 md:grid-cols-2">
          {rows.map((row) => (
            <Card key={row.workspaceId} className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-start gap-2">
                <div className="min-w-0 flex-1">
                  <h2 className="break-words text-h2 font-bold text-ink">{row.workspaceName}</h2>
                  <p className="mt-1 break-words text-body text-ink3">{row.tenantName} · {row.industry || "通用经营"}</p>
                </div>
                <Badge tone="info">{dictText(MEMBER_ROLE_TEXT, row.role)}</Badge>
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 text-body text-ink2">
                  {row.pendingApprovals > 0 ? `${row.pendingApprovals} 项待审批` : "当前无待审批事项"}
                </span>
                <Button variant="secondary" onClick={() => navigate("/approvals")}>进入审批中心</Button>
              </div>
            </Card>
          ))}
        </div>
      </AsyncState>
    </main>
  );
}
