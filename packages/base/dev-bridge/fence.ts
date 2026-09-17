/**
 * 机床命令围栏（高危命令判定，纯函数）
 * 三档裁决：allow（放行留痕）/ deny（默认拦截）/ escalate（升审批台）
 * 纪律：高危命令没有"工具自己决定"一说；连续拦截触发会话熔断（session.ts）。
 */

export type FenceVerdict = "allow" | "deny" | "escalate";

export interface FenceRule {
  ruleId: string;
  pattern: RegExp;
  verdict: FenceVerdict;
  note: string;
}

/** 基线规则（只可加严不可放宽——与 fence-engine 基线层同一纪律） */
export const COMMAND_FENCE_RULES: FenceRule[] = [
  // —— deny：毁灭性/越权动作，一律拦截 ——
  // rm 规则：首个目标以 / ~ * 开头才拦（根/家目录/通配的强删）；
  // rm -rf ./node_modules/.cache 这类相对路径清理不误伤
  { ruleId: "cf-rm-rf", pattern: /\brm\s+(?:-[a-zA-Z]+\s+)*(\/|~|\*)/, verdict: "deny", note: "强删（目标为根/家目录/通配）" },
  { ruleId: "cf-force-push", pattern: /\bgit\s+push\b[^|;&]*(--force|-f)(\s|$)/, verdict: "deny", note: "强制推送" },
  { ruleId: "cf-push", pattern: /\bgit\s+push\b/, verdict: "escalate", note: "任何远端推送都升审批" },
  { ruleId: "cf-pipe-exec", pattern: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(bash|sh|zsh|python|node)\b/, verdict: "deny", note: "下载即执行管道" },
  { ruleId: "cf-mkfs-dd", pattern: /\b(mkfs|fdisk|dd\s+if=)\b/, verdict: "deny", note: "磁盘级操作" },
  { ruleId: "cf-chmod-777", pattern: /\bchmod\s+(-R\s+)?777\b/, verdict: "deny", note: "权限全开" },
  { ruleId: "cf-sudo", pattern: /^\s*sudo\b/, verdict: "deny", note: "提权执行" },
  { ruleId: "cf-kill-init", pattern: /\b(kill(all)?\s+-9\s+1\b|shutdown|reboot)\b/, verdict: "deny", note: "系统级破坏" },
  { ruleId: "cf-git-reset-hard-remote", pattern: /\bgit\s+reset\s+--hard\s+(origin|upstream)\//, verdict: "escalate", note: "对齐远端硬重置（丢本地提交）" },
  { ruleId: "cf-secret-exfil", pattern: /\b(cat|less|more|tail|head)\s+[^|;&]*(\.env|id_rsa|id_ed25519|credentials|\.aws\/|\.ssh\/)/, verdict: "deny", note: "读取凭据类文件（疑似外泄前置）" },
  { ruleId: "cf-env-exfil", pattern: /\b(curl|wget|nc|ncat)\b[^|;&]*(\$[A-Z_]*(KEY|TOKEN|SECRET)|--data[^&]*process\.env)/i, verdict: "deny", note: "凭据随网络请求外发" },
  // —— escalate：影响面超出 worktree ——
  { ruleId: "cf-npm-publish", pattern: /\b(npm|pnpm|yarn)\s+publish\b/, verdict: "escalate", note: "包发布" },
  { ruleId: "cf-git-checkout-main", pattern: /\bgit\s+(checkout|switch)\s+(main|master)\b/, verdict: "escalate", note: "切向主分支（机床应留在隔离分支）" },
  { ruleId: "cf-install-global", pattern: /\b(npm|pnpm|yarn)\s+(install|add)\s+(-g|--global)\b/, verdict: "escalate", note: "全局安装改本机环境" },
];

/** 判定一条 shell 命令；默认 allow（留痕） */
export function judgeCommand(cmd: string): { verdict: FenceVerdict; ruleId?: string; note?: string } {
  const normalized = cmd.trim();
  if (!normalized) return { verdict: "allow" };
  // escalate 优先于 deny 检查中的宽松项？——不，deny 更严，deny 优先命中即拦
  let escalateHit: FenceRule | null = null;
  for (const rule of COMMAND_FENCE_RULES) {
    if (!rule.pattern.test(normalized)) continue;
    if (rule.verdict === "deny") return { verdict: "deny", ruleId: rule.ruleId, note: rule.note };
    if (!escalateHit) escalateHit = rule;
  }
  if (escalateHit) return { verdict: "escalate", ruleId: escalateHit.ruleId, note: escalateHit.note };
  return { verdict: "allow" };
}
