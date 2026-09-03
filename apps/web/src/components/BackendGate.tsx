/**
 * BackendGate · 环境守门员（首启体验保护）
 *
 * 场景：第三方 AI 编程工具（Qoder/Cursor 等）打开本仓后，默认只起前端 dev server——
 * 后端（:8787）与数据库未就绪时，页面 API 全挂、布局错乱、模拟数据为空，首次体验极差。
 *
 * 机制：应用挂载前先经 vite proxy 探测 /health（2.5s 超时）——
 *   通 → 正常渲染系统；
 *   不通 → 渲染本引导页（每 3s 自动重试，后端就绪后自动进入，无需手动刷新）。
 */
import { useEffect, useState, type ReactNode } from "react";

type GateState = "probing" | "down" | "up";

async function backendAlive(): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    const r = await fetch("/health", { signal: ctrl.signal });
    clearTimeout(timer);
    return r.ok;
  } catch {
    return false;
  }
}

function CopyCmd({ cmd, children }: { cmd: string; children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try { await navigator.clipboard.writeText(cmd); } catch { /* 剪贴板不可用时静默 */ }
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      style={{
        display: "inline-flex", alignItems: "center", gap: 8,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 14, fontWeight: 600, color: "#1B2A4E",
        background: copied ? "#D1FAE5" : "#F1F5F9",
        border: "1px solid #CBD5E1", borderRadius: 8,
        padding: "8px 14px", cursor: "pointer",
      }}
      title="点击复制命令"
    >
      {children ?? cmd}
      <span style={{ fontSize: 12, color: copied ? "#047857" : "#94A3B8" }}>
        {copied ? "✓ 已复制" : "⧉"}
      </span>
    </button>
  );
}

function OptionCard(props: { badge: string; title: string; desc: string; cmd: string; accent?: boolean }) {
  return (
    <div style={{
      border: props.accent ? "2px solid #4C6FFF" : "1px solid #E2E8F0",
      borderRadius: 12, padding: "16px 18px", background: "#fff",
      display: "flex", flexDirection: "column", gap: 8, textAlign: "left",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{
          fontSize: 11, fontWeight: 700, letterSpacing: 1,
          color: props.accent ? "#fff" : "#64748B",
          background: props.accent ? "#4C6FFF" : "#E2E8F0",
          borderRadius: 999, padding: "2px 10px",
        }}>{props.badge}</span>
        <span style={{ fontSize: 15, fontWeight: 700, color: "#0F172A" }}>{props.title}</span>
      </div>
      <div style={{ fontSize: 13, color: "#475569", lineHeight: 1.6 }}>{props.desc}</div>
      <div><CopyCmd cmd={props.cmd} /></div>
    </div>
  );
}

function GuidePage() {
  return (
    <div style={{
      minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
      background: "linear-gradient(180deg, #F8FAFC 0%, #EEF2FF 100%)",
      fontFamily: "-apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif",
      padding: 24,
    }}>
      <div style={{ maxWidth: 640, width: "100%" }}>
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>🛰️</div>
          <h1 style={{ fontSize: 22, fontWeight: 800, color: "#0F172A", margin: "0 0 8px" }}>
            WorkLoom 环境未就绪
          </h1>
          <p style={{ fontSize: 14, color: "#64748B", margin: 0, lineHeight: 1.7 }}>
            前端页面已启动，但连不上后端服务（<code>localhost:8787</code>）。<br />
            这通常是因为只启动了前端——系统需要后端与数据库一起运行。<br />
            请按下面任一方式启动（在<b>项目根目录</b>的终端中执行）：
          </p>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <OptionCard
            accent
            badge="推荐 · 首次体验"
            title="一键看三端全貌"
            desc="PC 工作台 + B 端移动 + C 端前台，Mock 演示数据已固化，无需任何配置。"
            cmd="pnpm preview:all"
          />
          <OptionCard
            badge="完整安装"
            title="装齐真实环境"
            desc="环境检查 → 依赖安装 → 数据库（Docker PG）→ 迁移 + 演示数据种子，一步到位。"
            cmd="pnpm setup"
          />
          <OptionCard
            badge="开发模式"
            title="前后端联调"
            desc="同时启动 server:8787 + web:5173。需先完成上方的完整安装。"
            cmd="pnpm dev"
          />
        </div>

        <p style={{
          textAlign: "center", fontSize: 12, color: "#94A3B8", marginTop: 24, lineHeight: 1.8,
        }}>
          本页面每 3 秒自动重试连接，后端就绪后会自动进入系统，无需手动刷新。<br />
          若使用 AI 编程工具打开本项目，请让它先执行 <code>pnpm preview:all</code> 再给你浏览器地址。
        </p>
      </div>
    </div>
  );
}

export function BackendGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GateState>("probing");

  useEffect(() => {
    if (state === "up") return;
    let cancelled = false;
    const probe = async () => {
      const alive = await backendAlive();
      if (!cancelled) setState(alive ? "up" : "down");
    };
    void probe();
    const timer = setInterval(() => { void probe(); }, 3000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [state]);

  if (state === "up") return <>{children}</>;
  if (state === "probing") {
    return (
      <div style={{
        minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
        background: "#F8FAFC", color: "#64748B", fontSize: 14,
        fontFamily: "-apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif",
      }}>
        正在连接 WorkLoom 服务…
      </div>
    );
  }
  return <GuidePage />;
}
