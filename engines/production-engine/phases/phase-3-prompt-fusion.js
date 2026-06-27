/**
 * Phase 3: PromptFusion 串行执行
 * 
 * 职责：
 * - 串行执行 PromptFusion Agent（每镜头独立 LLM 调用）
 * - 动态预算计算（根据镜头数）
 * - 合并 25 字段到 shots
 * - 保存 checkpoint
 */

const { PhaseExecutor } = require('./phase-executor');

class Phase3PromptFusion extends PhaseExecutor {
  constructor(options) {
    super({ name: 'Phase3-PromptFusion', ...options });
  }

  async execute(state) {
    const { shots, result, adaptedBlueprint } = state;
    const startTime = Date.now();
    const shotCount = shots.length;

    // 动态预算计算
    // 【v2.1.6】调整预算：实测每镜头约60-90s，按90s预估
    const PHASE3_PER_SHOT_MS = 90000; // 每镜头90秒（原180s过于保守）
    const PHASE3_BUFFER_MS = 30000;   // 30秒缓冲
    const needMs = shotCount * PHASE3_PER_SHOT_MS + PHASE3_BUFFER_MS;

    this.log('PHASE-3', `📊 动态预算: ${shotCount}镜头 × ${PHASE3_PER_SHOT_MS/1000}s + ${PHASE3_BUFFER_MS/1000}s缓冲 = 需${Math.round(needMs/1000)}s`);

    // 预算检查
    if (!this.checkBudget(needMs, 'Phase 3')) {
      return { success: false, shots, result, timing: 0, error: '预算不足' };
    }

    try {
      this.log('PROMPT-FUSION-AGENT', `开始(串行模式,${shotCount}镜头,预计${Math.round(needMs/1000)}s)...`);
      
      const pfResult = await this.agents.promptFusion.process(
        this.cloneShots(shots), 
        adaptedBlueprint
      );

      // 合并 25 字段
      const newShots = this.mergeShots(shots, pfResult.shots, [
        'prompt', 'enhanced_prompt', 'negative_prompt', 'fields', 'fusionText', 'promptCharCount',
        'director_instruction', 'constraint', 'baseline', 'scene', 'lighting', 'composition',
        'color_palette', 'depth_of_field', 'camera_movement', 'character', 'costume', 'makeup',
        'action', 'props', 'portraits', 'dialogue', 'timeline', 'mood', 'pacing', 'transition',
        'audio', 'negative', 'bright_constraint', 'character_constraint', 'consistency'
      ]);

      result.llmStats.promptFusion = pfResult.timing;
      
      const timing = Date.now() - startTime;
      this.log('PROMPT-FUSION-AGENT', `完成 (${timing}ms)`);

      // 保存 checkpoint
      await this.saveCheckpoint('phase3', newShots, {
        opening: result.opening,
        llmStats: result.llmStats
      });

      return { success: true, shots: newShots, result, timing };
    } catch (e) {
      this.log('PROMPT-FUSION-FAIL', `❌ ${e.message},部分镜头降级到规则 Prompt`);
      return { success: false, shots, result, timing: Date.now() - startTime, error: e.message };
    }
  }
}

module.exports = { Phase3PromptFusion };
