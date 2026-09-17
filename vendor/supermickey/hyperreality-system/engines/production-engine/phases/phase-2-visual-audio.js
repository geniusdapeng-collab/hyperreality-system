/**
 * Phase 2: VisualLanguage ∥ AudioDesign → ContinuityReview
 * 
 * 【P0-PERF-02 修复】VisualLanguage 和 AudioDesign 并行执行（可节省45%时间）
 * ContinuityReview 仍串行（依赖前两者结果）
 * 
 * 职责：
 * - 并行执行 VL + AD（节省 ~45% Phase2 时间）
 * - 串行执行 CR（依赖 VL+AD 结果）
 * - 逐步合并结果到 shots
 * - 生成跨集边界校验报告
 * - 保存 checkpoint
 */

const { PhaseExecutor } = require('./phase-executor');

class Phase2VisualAudio extends PhaseExecutor {
  constructor(options) {
    super({ name: 'Phase2-VisualAudio', ...options });
  }

  async execute(state) {
    const { shots, result, adaptedBlueprint } = state;
    const startTime = Date.now();

    // 预算检查
    if (!this.checkBudget(80000, 'Phase 2')) {
      return { success: false, shots, result, timing: 0, error: '预算不足' };
    }

    this.log('PHASE-2', 'VisualLanguage ∥ AudioDesign → ContinuityReview 启动...');

    try {
      // 【修复 P1-2】VL + AD 并行执行，Promise.all → Promise.allSettled，
      // 避免一个失败导致另一个结果也被丢弃
      const [vlSettled, adSettled] = await Promise.allSettled([
        this.agents.visualLanguage.process(
          this.cloneShots(shots), 
          adaptedBlueprint
        ),
        this.agents.audioDesign.process(
          this.cloneShots(shots), 
          adaptedBlueprint
        )
      ]);
      
      const vlResult = vlSettled.status === 'fulfilled' ? vlSettled.value : { shots: [], timing: 0, error: vlSettled.reason?.message };
      const adResult = adSettled.status === 'fulfilled' ? adSettled.value : { shots: [], timing: 0, error: adSettled.reason?.message };
      
      if (vlSettled.status === 'rejected') {
        this.log('VISUAL-LANGUAGE-AGENT', `❌ 失败: ${vlSettled.reason?.message}`);
      } else {
        this.log('VISUAL-LANGUAGE-AGENT', `完成 (${vlResult.timing}ms)`);
      }
      if (adSettled.status === 'rejected') {
        this.log('AUDIO-DESIGN-AGENT', `❌ 失败: ${adSettled.reason?.message}`);
      } else {
        this.log('AUDIO-DESIGN-AGENT', `完成 (${adResult.timing}ms)`);
      }

      // 合并 VL + AD 结果到 shots
      // 【修复 新-P0】白名单补齐 composition/color_palette/depth_of_field：
      // VL agent 明确输出这三个字段，不应被拦截（Phase3 虽可兜底，但 VL 的专门设计更优）
      let newShots = this.mergeShots(shots, vlResult.shots, [
        'camera', 'cameraString', 'cameraMovement',
        'lighting', 'lightingString',
        'timeline',
        'composition', 'color_palette', 'depth_of_field',
        'visual_elements', 'color_temperature', 'camera_movement'
      ]);
      
      newShots = this.mergeShots(newShots, adResult.shots, [
        'audio', 'music', 'sound_effects', 'backgroundSound', 'backgroundSoundString'
      ]);

      // ContinuityReview 串行（依赖 VL+AD 结果）
      const crResult = await this.agents.continuityReview.process(
        this.cloneShots(newShots),
        adaptedBlueprint,
        {
          totalEpisodes: this._extractTotalEpisodes(adaptedBlueprint),
          episodeIndex: this._extractEpisodeIndex(adaptedBlueprint),
          episodeContract: this._buildEpisodeContract(adaptedBlueprint)
        }
      );
      this.log('CONTINUITY-REVIEW-AGENT', '完成');

      // 保存连续性检查结果
      result.stages.continuity = { agent: 'continuityReview', ...crResult };
      if (crResult.boundaryReport) {
        result.stages.boundaryReport = crResult.boundaryReport;
        this.log('BOUNDARY-GUARD', `跨集边界校验: ${crResult.boundaryReport.summary}`);
      }

      // 更新统计
      result.llmStats.visualLanguage = vlResult.timing;
      result.llmStats.audioDesign = adResult.timing;
      result.llmStats.continuityReview = crResult.timing;

      const timing = Date.now() - startTime;
      this.log('PHASE-2', `完成 (${timing}ms, 并行 VL∥AD 节省 ~${Math.round((vlResult.timing + adResult.timing) * 0.45)}ms)`);

      // 保存 checkpoint
      await this.saveCheckpoint('phase2', newShots, {
        opening: result.opening,
        llmStats: result.llmStats
      });
      this.checkMemory('phase2');

      return { success: true, shots: newShots, result, timing };
    } catch (e) {
      this.log('PHASE-2-FAIL', `❌ ${e.message}, Phase2 失败但继续`);
      // Phase 2 降级：注入基础运镜/灯光保底
      shots.forEach(shot => {
        if (!shot.cameraString && !shot.cameraMovement && !shot.camera_movement) {
          shot.cameraString = '固定机位，中景构图，主体位于画面黄金分割点';
          this.log('PHASE-2-FALLBACK', `${shot.shotId} 注入基础运镜`);
        }
        if (!shot.lightingString && !shot.lighting) {
          shot.lightingString = '自然光，5600K，三点布光，主光45度侧前方';
          this.log('PHASE-2-FALLBACK', `${shot.shotId} 注入基础灯光`);
        }
        if (!shot.backgroundSoundString && !shot.audio) {
          shot.backgroundSoundString = '环境底噪，无配乐，人声清晰';
        }
      });
      return { success: false, shots, result, timing: Date.now() - startTime, error: e.message };
    }
  }

  _extractTotalEpisodes(adaptedBlueprint) {
    return adaptedBlueprint.config?._metadata?.series?.totalEpisodes 
      || adaptedBlueprint.config?._metadata?.totalEpisodes 
      || 1;
  }

  _extractEpisodeIndex(adaptedBlueprint) {
    return adaptedBlueprint.config?._metadata?.series?.currentEpisode 
      || adaptedBlueprint.config?._metadata?.episode 
      || 1;
  }

  _buildEpisodeContract(adaptedBlueprint) {
    // 从blueprint构建跨集连续性契约
    const contract = {
      characters: adaptedBlueprint.characters || [],
      worldSetting: adaptedBlueprint.worldSetting || {},
      keyEvents: adaptedBlueprint.keyEvents || []
    };
    return contract;
  }
}

module.exports = { Phase2VisualAudio };