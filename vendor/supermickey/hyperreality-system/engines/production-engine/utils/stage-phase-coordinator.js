/**
 * Stage到Phase映射协调器
 * 【P0-ARCH-02 修复】将11个Stage映射到4个Phase，确保断点续跑不跳过关键子Stage
 * 
 * 职责：
 * - 在Phase执行器内部维护Stage级状态
 * - 每个子Stage完成后更新PipelineStateMachine
 * - 断点续跑时恢复到最细粒度的失败点
 */

const { PipelineStateMachine } = require('../../../core/pipeline-state-machine');

class StagePhaseCoordinator {
  constructor(projectId, productionEngine) {
    this.projectId = projectId;
    this.engine = productionEngine;
    this.stateMachine = new PipelineStateMachine(projectId);
    this.stageToPhase = {
      'INIT': 0,
      'REQUIREMENT_PARSED': 0,
      'SCRIPT_COMPLETE': 1,           // Phase 1
      'SCENE_DESIGN_COMPLETE': 1,     // Phase 1
      'OPENING_DESIGN_COMPLETE': 1,   // Phase 1
      'VISUAL_LANGUAGE_COMPLETE': 2,  // Phase 2
      'AUDIO_DESIGN_COMPLETE': 2,     // Phase 2
      'CONTINUITY_REVIEW_COMPLETE': 2,// Phase 2
      'PROMPT_FUSION_COMPLETE': 3,    // Phase 3
      'QUALITY_CHECK_COMPLETE': 3,    // Phase 3.5
      'RENDER_READY': 4
    };
  }

  /**
   * 在Phase执行前注册Stage
   * @param {string} stageName - Stage名称
   * @param {object} context - 执行上下文
   */
  beforeStage(stageName, context = {}) {
    console.log(`[StagePhaseCoordinator] Stage开始: ${stageName}`);
    this.currentStage = stageName;
    this.currentContext = context;
  }

  /**
   * Stage成功完成后提交
   * @param {string} stageName - Stage名称
   * @param {object} result - Stage执行结果
   */
  async afterStage(stageName, result = {}) {
    const checkpointData = {
      shots: result.shots || [],
      opening: result.opening || null,
      llmStats: result.llmStats || {},
      timestamp: Date.now()
    };
    
    await this.stateMachine.executeStage(stageName, async () => result);
    console.log(`[StagePhaseCoordinator] Stage完成: ${stageName}`);
  }

  /**
   * 获取应该从哪个Phase开始恢复
   * @returns {number} Phase编号(0-4)
   */
  getResumePhase() {
    const completedStages = Object.keys(this.stateMachine.checkpointData || {});
    if (completedStages.length === 0) return 0;

    // 找到最后一个完成的Stage对应的Phase
    let maxPhase = 0;
    for (const stage of completedStages) {
      const phase = this.stageToPhase[stage];
      if (phase !== undefined && phase > maxPhase) {
        maxPhase = phase;
      }
    }

    // 如果当前Phase还有未完成的Stage，返回到当前Phase
    const currentPhaseStages = Object.entries(this.stageToPhase)
      .filter(([_, p]) => p === maxPhase)
      .map(([s, _]) => s);
    
    const allCompleted = currentPhaseStages.every(s => completedStages.includes(s));
    
    return allCompleted ? maxPhase + 1 : maxPhase;
  }

  /**
   * 获取缺失的Stage列表
   * @returns {string[]}
   */
  getMissingStages() {
    const allStages = Object.keys(this.stageToPhase);
    const completedStages = Object.keys(this.stateMachine.checkpointData || {});
    return allStages.filter(s => !completedStages.includes(s));
  }

  /**
   * 重置所有状态（从头开始）
   */
  async reset() {
    await this.stateMachine.cleanup();
    this.stateMachine = new PipelineStateMachine(this.projectId);
  }
}

module.exports = { StagePhaseCoordinator };
