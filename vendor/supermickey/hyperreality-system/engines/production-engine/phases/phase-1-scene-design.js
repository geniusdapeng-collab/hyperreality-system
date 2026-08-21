/**
 * Phase 1: SceneDesign + OpeningDesign 并行执行
 * 
 * 职责：
 * - 并行调用 sceneDesignAgent 和 openingDesignAgent
 * - 合并场景设计结果到 shots
 * - 注入片头数据到 sceneType=opening 的镜头
 * - 保存 checkpoint
 */

const { PhaseExecutor } = require('./phase-executor');

class Phase1SceneDesign extends PhaseExecutor {
  constructor(options) {
    super({ name: 'Phase1-SceneDesign', ...options });
  }

  async execute(state) {
    const { shots, result, adaptedBlueprint } = state;
    const startTime = Date.now();
    
    // 预算检查
    if (!this.checkBudget(140000, 'Phase 1')) {
      return { success: false, shots, result, timing: 0, error: '预算不足' };
    }

    this.log('PHASE-1', 'SceneDesign + OpeningDesign 并行启动...');

    try {
      // 【fix-1C】补全 genre/mood/theme 映射，防止 OpeningDesignAgent 收到"题材=通用 情绪=epic"
      if (adaptedBlueprint) {
        const ct = adaptedBlueprint._creativeTheme || adaptedBlueprint.metadata?._creativeTheme || {};
        if (!adaptedBlueprint.genre) {
          adaptedBlueprint.genre = adaptedBlueprint.type || ct.type || null;
        }
        if (!adaptedBlueprint.mood) {
          adaptedBlueprint.mood = adaptedBlueprint.tone || ct.tone || null;
        }
        if (!adaptedBlueprint.theme && ct.theme) adaptedBlueprint.theme = ct.theme;
        if (!adaptedBlueprint.targetAudience && ct.target_audience) adaptedBlueprint.targetAudience = ct.target_audience;
        if (!adaptedBlueprint.description && ct.description) adaptedBlueprint.description = ct.description;
        // 【v2.4.0-B3】全片导演前置：蓝图阶段选定，场景设计即感知风格宪法
        try {
          const { assignFilmDirector } = require('../../../skills/hollywood-cinematography/cinematography-skill-router');
          const fd = assignFilmDirector(adaptedBlueprint);
          adaptedBlueprint.filmDirector = fd.director;
          adaptedBlueprint.filmDirectorSource = fd.source;
        } catch (e) { /* 风格指南缺失不阻断主流程 */ }
      }

      // 并行执行两个 Agent
      const [sdResult, odResult] = await this._runParallel({
        'scene-design': this.agents.sceneDesign.process(this.cloneShots(shots), adaptedBlueprint),
        'opening-design': this._shouldGenerateOpening(adaptedBlueprint)
          ? this.agents.openingDesign.process(adaptedBlueprint)
          : Promise.resolve(null)
      });

      // 合并场景设计结果（sdResult.shots 可能因 Agent 内部降级而缺失）
      // 【修复 新-P0】白名单补齐 makeup/props：SceneDesign schema 输出 6 字段，
      // 严格白名单生效后这两个字段会被 MERGE-GUARD 误拦截
      let newShots = this.mergeShots(shots, sdResult.shots || [], [
        'scene', 'mood', 'action', 'emotional_target', 'makeup', 'props'
      ]);

      // 处理片头设计结果
      if (odResult && odResult.opening) {
        result.stages.opening = { agent: 'openingDesign', ...odResult };
        result.opening = odResult.opening;
        newShots = this._injectOpeningData(newShots, odResult);
      }

      // 更新统计
      result.llmStats.sceneDesign = sdResult.timing;
      result.llmStats.openingDesign = odResult?.timing;

      const timing = Date.now() - startTime;
      this.log('PHASE-1', `完成 (${timing}ms)`);

      // 保存 checkpoint
      await this.saveCheckpoint('phase1', newShots, { 
        opening: result.opening, 
        llmStats: result.llmStats 
      });
      this.checkMemory('phase1');

      return { success: true, shots: newShots, result, timing };
    } catch (e) {
      this.log('PHASE-1-FAIL', `❌ ${e.message}`);
      return { success: false, shots, result, timing: Date.now() - startTime, error: e.message };
    }
  }

  /**
   * 并行执行多个任务（部分容错版）
   * 【修复 P2-1】核心任务(scene-design)失败才算 Phase 失败；
   * 非核心任务(opening-design)失败降级为 null 继续，保住核心 LLM 产出
   */
  async _runParallel(tasks) {
    const entries = Object.entries(tasks);
    const results = await Promise.all(
      entries.map(([key, promise]) =>
        Promise.resolve(promise)
          .then(result => ({ key, result, success: true }))
          .catch(error => ({ key, error, success: false }))
      )
    );

    const output = {};
    const failed = [];
    for (const r of results) {
      if (r.success) output[r.key] = r.result;
      else failed.push(r);
    }

    // 核心任务失败 → Phase 失败（抛出由 execute 的 catch 统一处理）
    const coreFailure = failed.find(r => r.key === 'scene-design');
    if (coreFailure) throw coreFailure.error;

    // 非核心任务失败 → 降级继续
    for (const f of failed) {
      this.log('PHASE-1', `⚠️ 非核心任务 ${f.key} 失败(${f.error?.message})，降级继续`);
      output[f.key] = null;
    }
    return [output['scene-design'], output['opening-design']];
  }

  /**
   * 判断是否需要生成片头
   */
  _shouldGenerateOpening(adaptedBlueprint) {
    // 检查是否需要片头（可以扩展为更复杂的逻辑）
    return true;
  }

  /**
   * 注入片头数据到片头镜头
   * 【v2.1.22-fix 片头字段丢失】多级查找 + 永不静默：
   * 1. 优先 sceneType === 'opening'
   * 2. 启发式：shotId 形如 S00/SC00/S00-01/OP/opening/intro
   * 3. 兜底 shots[0]（与 _shouldGenerateOpening 恒 true 的设计一致：片头永远是第一个镜头）
   * 注入时强制 sceneType = 'opening'，让下游 isOpeningShot / FieldGuard /
   * OpeningTitleOptimizer 判定全部对齐；每次选择都打日志，杜绝"静默跳过"。
   */
  _injectOpeningData(shots, odResult) {
    if (!Array.isArray(shots) || shots.length === 0) {
      this.log('OPENING-INJECT-SKIP', '⚠️ shots 为空，片头数据无法注入');
      return shots;
    }

    let openingIdx = shots.findIndex(s => s.sceneType === 'opening');
    let matchedBy = 'sceneType';

    if (openingIdx < 0) {
      openingIdx = shots.findIndex(s =>
        /^(S?C?00($|-|_)|OP|opening|intro)/i.test(String(s.shotId || s.sceneId || ''))
      );
      matchedBy = 'id-heuristic';
    }
    if (openingIdx < 0) {
      openingIdx = 0;
      matchedBy = 'fallback-first-shot';
    }
    if (matchedBy !== 'sceneType') {
      this.log('OPENING-INJECT', `⚠️ 未找到 sceneType=opening 的镜头，经 ${matchedBy} 选中 ${shots[openingIdx].shotId} 作为片头`);
    }

    const od = odResult.opening;
    const titleOverlay = od.titleOverlay || {};

    // 克隆并修改（避免直接变异原始对象）
    const newShots = [...shots];
    newShots[openingIdx] = this.cloneShots([shots[openingIdx]])[0];

    const openingShot = newShots[openingIdx];
    // 【v2.1.22-fix】修正类型标记，保证下游所有"找片头"逻辑都能识别本镜头
    openingShot.sceneType = 'opening';

    openingShot.title = od.title || titleOverlay.mainTitle || titleOverlay.main_title || '';
    openingShot.subtitle = od.subtitle || titleOverlay.subtitle || titleOverlay.sub_title || '';
    openingShot.titleOverlay = od.titleOverlay || null;
    openingShot.audioLayer = od.audioLayer || null;
    openingShot.lightingString = od.lightingString || openingShot.lightingString;
    openingShot.cameraString = od.cameraString || openingShot.cameraString;

    // 【2026-07-17 升级】注入片头电影级方案：完整 plan + 秒级时间轴
    if (od.cinematic) {
      openingShot.cinematic = od.cinematic;
      // 【v2.1.22-fix】电影级方案直出片头专属字段（OpeningTitleOptimizer 之前的保险，
      // 尽力而为，拿不到就留给 OpeningTitleOptimizer 后补）
      try {
        const plan = od.cinematic;
        openingShot.title_content = plan.title_content || openingShot.title || '';
        openingShot.subtitle_content = plan.subtitle_content || openingShot.subtitle || '';
        if (plan.typography?.description) openingShot.title_font_design = plan.typography.description;
        const audioBits = [plan.audio?.signature, plan.audio?.bgm, plan.audio?.syncNotes].filter(Boolean);
        if (audioBits.length) openingShot.opening_audio_design = audioBits.join('；');
      } catch (_) { /* 增强字段尽力而为，不影响主流程 */ }
    }
    if (od.promptTimeline) {
      openingShot.promptTimeline = od.promptTimeline;
      // 片头镜头的 timeline 字段直接采用片头节拍表（25字段体系/PromptFusion 可消费）
      openingShot.timeline = od.promptTimeline;
    }

    this.log('OPENING-INJECT', `片头数据已注入 ${openingShot.shotId}: title="${openingShot.title}" (matchedBy=${matchedBy})`);

    return newShots;
  }
}

module.exports = { Phase1SceneDesign };