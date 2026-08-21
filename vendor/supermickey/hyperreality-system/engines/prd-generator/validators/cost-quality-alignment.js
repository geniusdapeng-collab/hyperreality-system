/**
 * 成本-质量一致性校验器
 * 确保 PRD 中的预算配置与质量阈值、模型能力边界一致
 */
function validateCostQualityAlignment(prd) {
  if (!prd || !prd.budgetProfile || !prd.productionConstraints) {
    return { passed: true }; // 无预算配置时跳过校验
  }
  
  const tier = prd.budgetProfile.qualityTier;
  const thresholds = prd.productionConstraints.qualityThresholds;
  const bounds = prd.productionConstraints.modelCapabilityBounds;
  
  if (!tier || !thresholds || !bounds) {
    return { passed: true };
  }
  
  // 校验 1: film 档位必须允许 hybrid 一致性策略
  if (tier === 'film' && bounds.consistencyStrategy !== 'hybrid') {
    return {
      passed: false,
      reason: 'film 档位要求 hybrid 一致性策略，当前为 ' + bounds.consistencyStrategy,
      adjustedBudget: {
        ...prd.budgetProfile,
        qualityTier: 'premium'
      }
    };
  }
  
  // 校验 2: consistency 阈值不能超过模型能力
  if (thresholds.consistency > 0.85 && bounds.consistencyStrategy === 'textual-description') {
    return {
      passed: false,
      reason: 'textual-description 策略无法支撑 >0.85 的一致性阈值，当前为 ' + thresholds.consistency,
      adjustedBudget: prd.budgetProfile
    };
  }
  
  // 校验 3: premium/film 档位必须允许 complex prompt 复杂度
  if ((tier === 'premium' || tier === 'film') && bounds.maxPromptComplexity !== 'complex') {
    return {
      passed: false,
      reason: tier + ' 档位要求 complex prompt 复杂度，当前为 ' + bounds.maxPromptComplexity,
      adjustedBudget: prd.budgetProfile
    };
  }
  
  // 校验 4: standard 档位不应要求过高一致性
  if (tier === 'standard' && thresholds.consistency > 0.80) {
    return {
      passed: false,
      reason: 'standard 档位不应要求 >0.80 的一致性阈值，建议降至 0.70-0.75',
      adjustedBudget: prd.budgetProfile
    };
  }
  
  // 校验 5: 算力预算与品质档位匹配（如果算力预算存在）
  const maxCalls = prd.budgetProfile.computeBudget?.maxCalls;
  if (maxCalls !== undefined && maxCalls !== null) {
    const minCallsByTier = { 'standard': 5, 'premium': 10, 'film': 15 };
    if (maxCalls < minCallsByTier[tier]) {
      return {
        passed: false,
        reason: tier + ' 档位至少需要 ' + minCallsByTier[tier] + ' 次算力调用，当前为 ' + maxCalls,
        adjustedBudget: {
          ...prd.budgetProfile,
          computeBudget: {
            ...prd.budgetProfile.computeBudget,
            maxCalls: minCallsByTier[tier]
          }
        }
      };
    }
  }
  
  return { passed: true };
}

module.exports = { validateCostQualityAlignment };
