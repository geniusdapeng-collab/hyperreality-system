import { charterSchema, type CeoMode } from "@workloom/base/captain";

export interface GovernanceFixtureRequirements {
  mode: CeoMode;
  ranges?: Record<string, { lower: number; anchor: number; upper: number }>;
  caps?: Record<string, number>;
  repairHint: string;
}

/**
 * 校验套件声明的治理夹具，不对任何行业键作内建假设。
 * 各行业套件通过 requirements 显式传入自身的键和值。
 */
export function assertGovernanceFixtureContract(
  raw: unknown,
  requirements: GovernanceFixtureRequirements,
): void {
  const parsed = charterSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => issue.path.join(".") || "charter")
      .join("、");
    throw new Error(`治理夹具契约不兼容（${details}）；${requirements.repairHint}`);
  }

  const charter = parsed.data;
  if (charter.mode !== requirements.mode) {
    throw new Error(
      `治理夹具模式不符（期望 ${requirements.mode}，实际 ${charter.mode}）；${requirements.repairHint}`,
    );
  }

  for (const [key, expected] of Object.entries(requirements.ranges ?? {})) {
    const actual = charter.autonomy.ranges[key];
    if (
      !actual
      || actual.lower !== expected.lower
      || actual.anchor !== expected.anchor
      || actual.upper !== expected.upper
    ) {
      throw new Error(`治理夹具区间 ${key} 不符合当前基线；${requirements.repairHint}`);
    }
  }

  for (const [key, expected] of Object.entries(requirements.caps ?? {})) {
    const actual = charter.autonomy.caps[key];
    if (!actual || actual.limit !== expected) {
      throw new Error(`治理夹具上限 ${key} 不符合当前基线；${requirements.repairHint}`);
    }
  }
}
