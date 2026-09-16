/**
 * onboarding-truth · 落地向导的不可变指纹与正式运行门禁（纯函数，可独立测试）
 *
 * 这里不读写数据库。调用方必须在事务内采集事实，再用本模块给出唯一门禁结论。
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "@workloom/base/workdata";

export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function staffingDraftHash(industryText: string, compiled: unknown): string {
  return sha256Canonical({ schema: "workloom.staffing-draft/v1", industryText, compiled });
}

export interface AssemblyFingerprintInput {
  workspaceId: string;
  draftId: string;
  draftHash: string;
  version: number;
  assets: unknown;
}

export function staffingAssemblyHash(input: AssemblyFingerprintInput): string {
  return sha256Canonical({ schema: "workloom.staffing-assembly/v1", ...input });
}

export interface ExamBinding {
  installId: string;
  draftId: string;
  version: number;
  hash: string;
}

export function sameExamBinding(a: ExamBinding, b: ExamBinding): boolean {
  return a.installId === b.installId
    && a.draftId === b.draftId
    && a.version === b.version
    && a.hash === b.hash;
}

export interface RealModeFacts {
  activationOwner?: boolean;
  llmReal: boolean;
  workspaceIsExample: boolean;
  business: {
    name?: string | null;
    industry?: string | null;
    configuredAt?: string | null;
    source?: string | null;
  } | null;
  activeInstall: boolean;
  expectedAgents: number;
  readyInstalledAgents: number;
  expectedFences: number;
  activeInstalledFences: number;
  fenceResponsibilityReady?: boolean;
  expectedSkills?: number;
  installedSkills?: number;
  capabilityClaimsSafe?: boolean;
  pendingCapabilities?: number;
  customAssembly?: {
    required: boolean;
    installStatus?: string | null;
    draftStatus?: string | null;
    examStatus?: string | null;
    examVerdict?: string | null;
    examAssessmentKind?: string | null;
    candidateExpected?: number;
    candidateTotal?: number;
    candidatePassed?: number;
    installBinding?: ExamBinding | null;
    examBinding?: ExamBinding | null;
  } | null;
}

export interface ActivationGateCheck {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface ActivationGateResult {
  canActivate: boolean;
  checks: ActivationGateCheck[];
  blockers: string[];
}

/**
 * 正式模式是服务端推导的资格，不是一个可随意翻转的标签。
 * 经营主体必须由当前向导显式保存（source=user + configuredAt），旧种子档案不能冒充真实资料。
 */
export function evaluateRealModeReadiness(facts: RealModeFacts): ActivationGateResult {
  const businessReady = Boolean(
    facts.business?.name?.trim()
    && facts.business?.industry?.trim()
    && facts.business?.configuredAt
    && facts.business?.source === "user",
  );
  const installedAgentsReady = facts.expectedAgents > 0
    && facts.readyInstalledAgents === facts.expectedAgents;
  const installedFencesReady = facts.expectedFences > 0
    && facts.activeInstalledFences === facts.expectedFences;
  const installedSkillsReady = (facts.installedSkills ?? 0) === (facts.expectedSkills ?? 0);
  const capabilityClaimsSafe = facts.capabilityClaimsSafe !== false;

  const custom = facts.customAssembly;
  const customBindingReady = !custom?.required || Boolean(
    custom.installStatus === "active"
    && custom.draftStatus === "active"
    && custom.examStatus === "done"
    && custom.examVerdict === "pass"
    && custom.examAssessmentKind === "candidate-role"
    && (custom.candidateExpected ?? 0) > 0
    && custom.candidateTotal === custom.candidateExpected
    && custom.candidatePassed === custom.candidateExpected
    && custom.installBinding
    && custom.examBinding
    && sameExamBinding(custom.installBinding, custom.examBinding),
  );

  const checks: ActivationGateCheck[] = [
    {
      key: "owner",
      label: "激活责任人",
      ok: facts.activationOwner !== false,
      detail: facts.activationOwner !== false ? "当前操作人是工作区所有者" : "只有工作区所有者可以启用正式经营模式",
    },
    {
      key: "llm",
      label: "真实大模型",
      ok: facts.llmReal,
      detail: facts.llmReal ? "已完成真实模型试调并留存校验凭据" : "仍为内置模拟模型、模型地址缺失，或当前配置没有试调凭据",
    },
    {
      key: "business",
      label: "真实经营主体",
      ok: businessReady,
      detail: businessReady ? "名称、行业与用户确认记录齐全" : "请保存真实主体名称与行业；示例档案不计入",
    },
    {
      key: "example",
      label: "示例数据退出",
      ok: !facts.workspaceIsExample,
      detail: facts.workspaceIsExample ? "当前仍标记为行业示例版" : "工作区已退出示例版",
    },
    {
      key: "install",
      label: "有效装配",
      ok: facts.activeInstall,
      detail: facts.activeInstall ? "存在且仅存在一份已激活装配台账" : "已激活装配不存在或存在重复台账",
    },
    {
      key: "agents",
      label: "数字员工",
      ok: installedAgentsReady,
      detail: `已就绪 ${facts.readyInstalledAgents}/${facts.expectedAgents} 名装配内员工`,
    },
    {
      key: "fences",
      label: "围栏规则",
      ok: installedFencesReady,
      detail: `已生效 ${facts.activeInstalledFences}/${facts.expectedFences} 条装配内围栏`,
    },
    {
      key: "fence-owner",
      label: "围栏责任人",
      ok: facts.fenceResponsibilityReady !== false,
      detail: facts.fenceResponsibilityReady !== false ? "装配内围栏均有明确确认责任人" : "存在未确认责任人或责任人与草案确认人不一致的围栏",
    },
    {
      key: "capabilities",
      label: "技能与工具声明",
      ok: installedSkillsReady && capabilityClaimsSafe,
      detail: installedSkillsReady && capabilityClaimsSafe
        ? ((facts.pendingCapabilities ?? 0) > 0
          ? `${facts.pendingCapabilities} 项建议仍待审批、未安装；相关能力保持阻断，不计为已激活能力`
          : "装配声明与实际安装记录一致")
        : "装配声明与技能安装记录不一致，或候选虚报了未安装能力",
    },
    {
      key: "exam",
      label: "上岗考绑定",
      ok: customBindingReady,
      detail: custom?.required
        ? (customBindingReady ? "全体候选岗位实测通过，且版本与哈希和当前装配一致" : "定制装配尚未完成全体候选岗位实测，或考试版本、哈希与当前装配不一致")
        : "官方行业包装配无需定制草案考试绑定",
    },
  ];
  return {
    canActivate: checks.every((check) => check.ok),
    checks,
    blockers: checks.filter((check) => !check.ok).map((check) => `${check.label}：${check.detail}`),
  };
}
