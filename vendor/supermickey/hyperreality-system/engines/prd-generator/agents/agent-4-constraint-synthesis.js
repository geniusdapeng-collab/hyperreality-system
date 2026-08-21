
/**
 * Agent 4: ConstraintSynthesisAgent
 * 约束合成 Agent - 规则引擎为主，无需 LLM
 * 职责：合成制作约束、质量阈值、受众定位、参考案例
 * 耗时：< 100ms
 */
class ConstraintSynthesisAgent {
  constructor(options = {}) {
    this.config = options;
  }

  process(discoveryResult, productResult, creativeResult, productionResult, budgetProfile) {
    const { upstreamFields, riskAssessment, audienceProfile, referenceCases, userModifications } = discoveryResult;
    const type = upstreamFields.type || '通用';
    const difficulty = upstreamFields.difficulty || 'medium';
    
    // 1. 制作约束（注入用户修改意见）
    const productionConstraints = this._buildConstraints(type, difficulty, riskAssessment, upstreamFields, budgetProfile, userModifications);
    
    // 2. 受众定位（直接透传）
    const audienceProfileOut = this._buildAudienceProfile(audienceProfile);
    
    // 3. 参考案例（直接透传）
    const referenceCasesOut = this._buildReferenceCases(referenceCases);
    
    return {
      productionConstraints,
      audienceProfile: audienceProfileOut,
      referenceCases: referenceCasesOut
    };
  }

  _buildConstraints(type, difficulty, riskAssessment, upstreamFields, budgetProfile, userModifications = []) {
    // 技术约束
    const technicalConstraints = [];
    if (riskAssessment?.technicalRisks) {
      riskAssessment.technicalRisks.forEach(risk => {
        if (risk.impact >= 3) {
          technicalConstraints.push(`${risk.risk}: ${risk.level}`);
        }
      });
    }
    if (upstreamFields?.special_notes) {
      // 【v2.1.15-fix】特殊要求全量保留（如婴儿拍摄安全规范），截断50字符会丢约束
      technicalConstraints.push(`特殊要求: ${upstreamFields.special_notes}`);
    }
    // 【脱节1 修复】注入用户修改意见到技术约束
    if (userModifications && userModifications.length > 0) {
      userModifications.forEach(mod => {
        const modStr = String(mod).slice(0, 100);
        if (modStr.length > 3) {
          technicalConstraints.push(`用户要求: ${modStr}`);
        }
      });
    }
    if (technicalConstraints.length === 0) {
      technicalConstraints.push('保持视觉风格一致性');
    }
    
    // 业务约束
    const businessConstraints = [];
    if (riskAssessment?.businessConstraints) {
      businessConstraints.push(...riskAssessment.businessConstraints.slice(0, 3));
    }
    if (businessConstraints.length === 0) {
      businessConstraints.push('符合目标平台审核规范');
    }
    
    // 禁止元素（基础 + 用户修改）
    const forbiddenByType = {
      '硬科幻': ['卡通风格', '过度简化', '模糊镜头'],
      '赛博朋克': ['自然光线', '田园风光', '暖色调为主'],
      '恐怖悬疑': ['明亮色调', '喜剧元素', '欢快音乐'],
      '商业广告': ['负面信息', '政治敏感', '暴力内容'],
      '艺术实验': ['商业模板', '套路化', '标准分镜'],
      '自然纪录片': ['虚构情节', '夸张特效', '人物表演'],
      '通用': ['低质量', '模糊', '不稳定']
    };
    const forbiddenElements = [...(forbiddenByType[type] || ['低质量', '模糊', '不稳定'])];
    
    // 【脱节1 修复】从用户修改意见中提取禁止类要求
    if (userModifications && userModifications.length > 0) {
      userModifications.forEach(mod => {
        const modStr = String(mod).toLowerCase();
        if (modStr.includes('不要') || modStr.includes('禁止') || modStr.includes('避免') || modStr.includes('不准')) {
          const item = String(mod).replace(/不要|禁止|避免|不准|不[要需]/g, '').trim().slice(0, 60); // 【v2.1.15-fix】30→60，避免禁止项被腰斩
          if (item && !forbiddenElements.includes(item)) {
            forbiddenElements.push(item);
          }
        }
      });
    }
    
    // 质量阈值
    const thresholdsByDifficulty = {
      'easy': { visual: 0.75, audio: 0.70, narrative: 0.75, consistency: 0.70 },
      'medium': { visual: 0.80, audio: 0.75, narrative: 0.85, consistency: 0.75 },
      'hard': { visual: 0.85, audio: 0.80, narrative: 0.90, consistency: 0.80 },
      'extreme': { visual: 0.90, audio: 0.85, narrative: 0.95, consistency: 0.85 }
    };
    const qualityThresholds = thresholdsByDifficulty[difficulty] || thresholdsByDifficulty['medium'];
    
    // 模型能力边界
    const qualityTier = budgetProfile?.qualityTier || 'standard';
    const boundsByTier = {
      'standard': {
        maxPromptComplexity: 'moderate',
        supportedEffects: ['基础调色', '简单转场'],
        consistencyStrategy: 'textual-description'
      },
      'premium': {
        maxPromptComplexity: 'complex',
        supportedEffects: ['粒子特效', '光效', '景深模拟', '运动模糊'],
        consistencyStrategy: 'style-reference'
      },
      'film': {
        maxPromptComplexity: 'complex',
        supportedEffects: ['粒子特效', '光效', '景深模拟', '运动模糊', '体积光', '镜头畸变'],
        consistencyStrategy: 'hybrid'
      }
    };
    const modelCapabilityBounds = boundsByTier[qualityTier] || boundsByTier['standard'];
    
    return {
      technicalConstraints: technicalConstraints.slice(0, 5),
      businessConstraints: businessConstraints.slice(0, 3),
      forbiddenElements: forbiddenElements.slice(0, 5),
      qualityThresholds,
      modelCapabilityBounds
    };
  }

  _buildAudienceProfile(audienceProfile) {
    if (!audienceProfile) {
      return {
        primaryAudience: {
          ageRange: '25-30',
          gender: 'all',
          interests: ['通用内容'],
          consumptionLevel: 'medium'
        },
        emotionTriggers: ['好奇心', '共鸣'],
        contentExpectations: ['高质量内容']
      };
    }
    
    return {
      primaryAudience: {
        ageRange: audienceProfile.primaryAudience?.ageRange || '25-30',
        gender: audienceProfile.primaryAudience?.gender || 'all',
        interests: (audienceProfile.primaryAudience?.interestTags || ['通用内容']).slice(0, 5),
        consumptionLevel: audienceProfile.primaryAudience?.consumptionLevel || 'medium'
      },
      emotionTriggers: (audienceProfile.emotionTriggers || ['好奇心', '共鸣']).slice(0, 5),
      contentExpectations: (audienceProfile.contentExpectations || ['高质量内容']).slice(0, 4)
    };
  }

  _buildReferenceCases(referenceCases) {
    if (!referenceCases) {
      return {
        filmReferences: ['通用参考'],
        adReferences: [],
        styleReferences: ['通用风格']
      };
    }
    
    return {
      filmReferences: (referenceCases.filmReferences || []).map(f => f.title || f).slice(0, 4),
      adReferences: (referenceCases.adReferences || []).map(a => a.brand || a).slice(0, 3),
      styleReferences: (referenceCases.styleReferences || []).slice(0, 4)
    };
  }

  fallback(discoveryResult) {
    return this.process(discoveryResult, {}, {}, {}, { qualityTier: 'standard' });
  }
}

module.exports = { ConstraintSynthesisAgent };