/**
 * Agent 5: DeliveryStandardAgent
 * 交付标准 Agent - 混合模式（规则引擎为主，LLM 辅助可选）
 * 职责：生成交付标准、验收指标、降级预案
 * 耗时：规则引擎 50ms + LLM 辅助 10-20s
 */
class DeliveryStandardAgent {
  constructor(options = {}) {
    this.config = options;
    this.useLLM = options.useLLM || false; // 默认使用规则引擎
  }

  process(productResult, creativeResult, productionResult, constraintResult, budgetProfile) {
    const productType = productResult?.productPositioning?.productType || '剧情短片';
    const qualityTier = budgetProfile?.qualityTier || 'standard';
    
    // 1. 交付物清单（规则引擎）
    const deliverables = this._buildDeliverables(productType);
    
    // 2. 验收标准（规则引擎）
    const acceptanceCriteria = this._buildAcceptanceCriteria(qualityTier);
    
    // 3. 输出格式规范（规则引擎）
    const outputFormat = this._buildOutputFormat(productType);
    
    // 4. 修订策略（规则引擎）
    const revisionPolicy = this._buildRevisionPolicy(qualityTier);
    
    // 5. 降级预案（规则引擎 + 可选 LLM）
    const fallbackPlan = this._buildFallbackPlan(qualityTier, productType);
    
    // 6. 连续性检查点（规则引擎）
    const continuityCheckpoints = this._buildContinuityCheckpoints(productionResult);
    
    return {
      deliveryStandard: {
        deliverables,
        acceptanceCriteria,
        outputFormat,
        revisionPolicy,
        fallbackPlan,
        continuityCheckpoints
      }
    };
  }

  _buildDeliverables(productType) {
    const deliverablesByType = {
      '剧情短片': [
        { item: 'video_master', spec: 'MP4/H.264, 1080p', priority: 'required' },
        { item: 'character_portraits', spec: '定妆照全套', priority: 'required' },
        { item: 'script_document', spec: '完整剧本+分镜', priority: 'required' },
        { item: 'shot_list', spec: '镜头清单+Prompt日志', priority: 'optional' }
      ],
      '商业广告': [
        { item: 'video_master', spec: 'MP4/H.265, 4K', priority: 'required' },
        { item: 'audio_stems', spec: '分轨音频', priority: 'optional' },
        { item: 'prompt_log', spec: '完整Prompt审计日志', priority: 'required' }
      ],
      '品牌宣传': [
        { item: 'video_master', spec: 'MP4/H.265, 4K', priority: 'required' },
        { item: 'script_document', spec: '品牌故事脚本', priority: 'required' },
        { item: 'shot_list', spec: '镜头清单', priority: 'optional' }
      ],
      '纪录片': [
        { item: 'video_master', spec: 'MP4/H.264, 1080p', priority: 'required' },
        { item: 'script_document', spec: '旁白脚本', priority: 'required' },
        { item: 'shot_list', spec: '镜头清单', priority: 'optional' }
      ],
      '音乐MV': [
        { item: 'video_master', spec: 'MP4/H.265, 4K', priority: 'required' },
        { item: 'audio_stems', spec: '分轨音频', priority: 'required' }
      ],
      '科普教育': [
        { item: 'video_master', spec: 'MP4/H.264, 1080p', priority: 'required' },
        { item: 'script_document', spec: '知识脚本', priority: 'required' }
      ],
      '社交媒体内容': [
        { item: 'video_master', spec: 'MP4/H.264, 1080p/9:16', priority: 'required' },
        { item: 'shot_list', spec: '镜头清单', priority: 'optional' }
      ],
      '艺术实验': [
        { item: 'video_master', spec: 'MOV/ProRes, 4K', priority: 'required' },
        { item: 'prompt_log', spec: '完整Prompt审计日志', priority: 'required' }
      ]
    };
    
    return deliverablesByType[productType] || deliverablesByType['剧情短片'];
  }

  _buildAcceptanceCriteria(qualityTier) {
    const acceptanceByTier = {
      'standard': { visual: 0.75, audio: 0.70, narrative: 0.75, consistency: 0.70 },
      'premium': { visual: 0.85, audio: 0.80, narrative: 0.85, consistency: 0.80 },
      'film': { visual: 0.92, audio: 0.88, narrative: 0.92, consistency: 0.90 }
    };
    
    return acceptanceByTier[qualityTier] || acceptanceByTier['standard'];
  }

  _buildOutputFormat(productType) {
    const isHighEnd = ['商业广告', '品牌宣传', '音乐MV', '艺术实验'].includes(productType);
    
    return {
      videoCodec: isHighEnd ? 'H.265' : 'H.264',
      audioCodec: 'AAC',
      container: productType === '艺术实验' ? 'MOV' : 'MP4'
    };
  }

  _buildRevisionPolicy(qualityTier) {
    const maxRevisionsByTier = {
      'standard': 1,
      'premium': 2,
      'film': 3
    };
    
    return {
      maxRevisions: maxRevisionsByTier[qualityTier] || 1,
      revisionScope: ['visual', 'audio', 'narrative']
    };
  }

  _buildFallbackPlan(qualityTier, productType) {
    const triggers = {
      'standard': '视觉质量低于 0.75 或连续 2 次迭代无改善',
      'premium': '视觉质量低于 0.85 或连续 3 次迭代无改善',
      'film': '视觉质量低于 0.92 或连续 3 次迭代无改善'
    };
    
    const actions = {
      'standard': '降低视觉复杂度，使用 simpler prompt，减少特效需求',
      'premium': '降低特效层级，使用 textual-description 一致性策略',
      'film': '启用 hybrid 一致性策略，增加 character-seed 参考'
    };
    
    const expectedOutputs = {
      '剧情短片': '降低质量但保证叙事完整性',
      '商业广告': '降低视觉震撼度但保证品牌信息传达',
      '纪录片': '降低画面精致度但保证内容真实性',
      '通用': '降低质量但保证可交付'
    };
    
    return {
      trigger: triggers[qualityTier] || triggers['standard'],
      action: actions[qualityTier] || actions['standard'],
      expectedOutput: expectedOutputs[productType] || expectedOutputs['通用']
    };
  }

  _buildContinuityCheckpoints(productionResult) {
    const characterCount = productionResult?.characterSystem?.characters?.length || 0;
    const checkpoints = [];
    
    if (characterCount > 0) {
      checkpoints.push({
        checkpoint: 'character-appearance',
        validationMethod: '跨镜头角色外貌一致性检查（服装、发型、面部特征）'
      });
      checkpoints.push({
        checkpoint: 'costume-continuity',
        validationMethod: '服装道具连续性检查（同一场景内服装不变）'
      });
    }
    
    checkpoints.push({
      checkpoint: 'scene-logic',
      validationMethod: '场景逻辑连续性检查（时间线、空间转换合理性）'
    });
    
    checkpoints.push({
      checkpoint: 'lighting-continuity',
      validationMethod: '光照连续性检查（同一场景光照方向和色温一致）'
    });
    
    if (characterCount > 1) {
      checkpoints.push({
        checkpoint: 'prop-continuity',
        validationMethod: '道具连续性检查（关键道具在不同场景中出现一致性）'
      });
    }
    
    return checkpoints.slice(0, 5);
  }

  fallback(productType, qualityTier) {
    return this.process(
      { productPositioning: { productType } },
      {},
      {},
      {},
      { qualityTier }
    );
  }
}

module.exports = { DeliveryStandardAgent };
