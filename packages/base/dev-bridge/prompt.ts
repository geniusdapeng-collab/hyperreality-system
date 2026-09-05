/**
 * 任务书模板（开发总指挥 → 机床的唯一输入）
 * 纪律：验收标准逐条可测；红线写死（不许碰主分支/不许提交远端/不许装全局依赖）；
 *      一次调用只干一件事（批量=多次调用，任务之间互不污染）。
 */

export interface TaskPromptInput {
  prdTitle: string;
  prdSummary: string;            // PRD 摘要（方案章节）
  acceptance: string[];          // 验收标准（逐条可测）
  constraints?: string[];        // 禁改目录/禁加依赖等
  repoName: string;
}

const HARD_RED_LINES = [
  "只修改当前工作目录（隔离分支）内的文件；绝不切换或合并分支",
  "绝不执行 git push / git remote 相关命令",
  "绝不全局安装依赖（npm -g 等）；新增依赖须先列入说明",
  "绝不读取或输出 .env、密钥、证书等凭据类文件内容",
  "完成后输出一段中文总结：改了什么、为什么、自测结果",
];

export function buildTaskPrompt(input: TaskPromptInput): string {
  const lines: string[] = [
    `# 开发任务（来自 WorkLoom 开发场域 · 开发总指挥派单）`,
    ``,
    `## 需求（PRD：${input.prdTitle}，仓库：${input.repoName}）`,
    input.prdSummary.trim(),
    ``,
    `## 验收标准（逐条必须满足）`,
    ...input.acceptance.map((a, i) => `${i + 1}. ${a}`),
  ];
  if (input.constraints?.length) {
    lines.push(``, `## 约束`, ...input.constraints.map((c) => `- ${c}`));
  }
  lines.push(
    ``,
    `## 红线（违反即任务失败）`,
    ...HARD_RED_LINES.map((r) => `- ${r}`),
    ``,
    `## 工作方式`,
    `- 先读懂相关代码再动手；遵循仓库现有代码风格与目录约定`,
    `- 仓库自带测试/类型检查存在时，完成后自行运行并确保通过`,
    `- 范围严格限定在本任务；不做顺手重构`,
  );
  return lines.join("\n");
}
