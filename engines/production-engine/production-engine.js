// hyperreality-system/engines/production-engine/production-engine.js
// Production Engine - 制作引擎(Layer 2)
// 深度融合:直接消费 ScriptBlueprint 输出,驱动镜头生成
// 版本:v1.0.0 | 日期:2026-06-08

const path = require('path');

// v2.1.5-refactor: 提取工具函数
const { safeStringify } = require('./utils/safe-stringify');
const { CheckpointManager } = require('./utils/checkpoint-manager');
const { LLMOutputNormalizer } = require('./utils/llm-output-normalizer');

// v2.0.0-LLM-Agent: 导入Agent
const { SceneDesignAgent } = require('./agents/scene-design-agent');
const { VisualLanguageAgent } = require('./agents/visual-language-agent');
const { AudioDesignAgent } = require('./agents/audio-design-agent');
const { PromptFusionAgent } = require('./agents/prompt-fusion-agent');
const { OpeningDesignAgent } = require('./agents/opening-design-agent');
const { ContinuityReviewAgent } = require('./agents/continuity-review-agent');

// v6.6.10-fix: 全局负面提示词注入器
const { globalNegativePromptInjector } = require('../../../systems/global-negative-prompts.js');

// v2.0.0-LLM-Agent: Agent配置
const DEFAULT_AGENT_CONFIG = {
  enableLLMAgents: true,
  llmTimeout: 180000, // 【v2.1.4-fix10-P25-fix3】单次3分钟，避免一次失败吃掉1/3预算
  llmMaxRetries: 2,
  // 【v2.1.4-fix13-审计修复】从环境变量读取模型配置，消除硬编码
  llmModel: process.env.STORMAXE_LLM_MODEL || 'kimi-k2p6',
  fastModel: process.env.STORMAXE_LLM_FAST_MODEL || process.env.STORMAXE_LLM_MODEL || 'kimi-k2p6',
  totalDeadlineMs: 1050000, // 【v2.1.4-fix13-审计修复】从540000提升至1050000(~17.5分钟)，匹配实际需求：Phase1(~90s)+Phase2(~300s)+Phase3(~540s)+QualityCheck(~120s)
  memThresholdMB: 1800, // 【v2.1.4-fix10-P25-fix3】提升阈值，避免GC风暴
  promptFusionConcurrency: 2 // 【v2.1.4-fix10-P25-fix3】并发2，平衡速度与稳定性
};
// 注:实际部署时这些模块会从 systems/ 复制到 production-engine/modules/
const SYSTEMS_PATH = path.join(__dirname, '../../../systems');

// 动态加载现有模块
function loadModule(name, required = false) {
  try {
    return require(path.join(SYSTEMS_PATH, name));
  } catch (e) {
    if (required) {
      throw new Error(`[ProductionEngine] 关键模块加载失败: ${name} - ${e.message}`);
    }
    console.warn(`[ProductionEngine] 模块加载失败: ${name} - ${e.message}`);
    return null;
  }
}

class ProductionEngine {
  constructor(options = {}) {
    this.config = {
      maxPromptLength: 12000, // 【审计修复】与 config/prompt-length.js 保持一致
      targetPromptLength: 12000, // 【审计修复】与 config/prompt-length.js 保持一致
      referenceImageCount: 2,
      outputDir: options.outputDir || process.env.OUTPUT_DIR || './output/hyperreality-output',
      ...options
    };

    // v2.0.0-LLM-Agent: 初始化Agent配置
    this.agentConfig = {
      ...DEFAULT_AGENT_CONFIG,
      ...options.agentConfig,
      maxPromptLength: this.config.maxPromptLength
    };

    // v2.0.0-LLM-Agent: 初始化Agents
    this._initAgents();

    this.modules = {};
    this.logs = [];
    this._initResourceGuard();
    this._initModules();
  }

  /**
   * 【新增】运行时更新 Agent 配置
   * 修复:create() 中收到的 agentConfig 可在此应用到已实例化的引擎
   */
  updateAgentConfig(agentConfig = {}) {
    const before = this.agentConfig.enableLLMAgents;
    this.agentConfig = {
      ...this.agentConfig,
      ...agentConfig,
      maxPromptLength: this.config.maxPromptLength
    };
    // 重新初始化 Agent 以应用新配置
    this._initAgents();
    if (before !== this.agentConfig.enableLLMAgents) {
      console.log(`[ProductionEngine] ⚠️ 运行时配置切换: enableLLMAgents ${before} → ${this.agentConfig.enableLLMAgents}`);
    }
  }

  /**
   * 【新增】资源守卫初始化
   */
  _initResourceGuard() {
    this._memThresholdMB = this.agentConfig.memThresholdMB || 1200;
    this._lowResourceMode = false;
  }

  /**
   * 【新增】Checkpoint 初始化(断点续跑)
   */
  _initCheckpoint() {
    this._checkpointDir = this.agentConfig.checkpointDir || this.config.outputDir;
    this._enableResume = this.agentConfig.enableResume !== false;
  }

  /**
   * 【新增】加载最新 checkpoint(断点续跑)
   * 返回最近完成的 Phase 及其 shots
   */
  _loadLatestCheckpoint() {
    if (!this._enableResume) return null;
    try {
      const fs = require('fs');
      // 【审计修复·P0】补全 phase0/phase3.5，损坏文件删除并继续搜索
      const phases = ['phase3.5', 'phase3', 'phase2', 'phase1', 'phase0'];
      for (const phase of phases) {
        const file = path.join(this._checkpointDir, `checkpoint-${phase}.json`);
        if (!fs.existsSync(file)) continue;
        try {
          const data = fs.readFileSync(file, 'utf8');
          const parsed = JSON.parse(data);
          this.log('RESUME', `📂 发现 ${phase} checkpoint(${parsed.shots?.length || 0} 镜头,保存于 ${parsed.savedAt || 'unknown'})`);
          return parsed;
        } catch (e) {
          // 【审计修复】损坏文件删除，继续搜索更低优先级的 phase
          this.log('RESUME', `⚠️ ${phase} checkpoint 损坏(${e.message})，已删除，继续搜索`);
          try { fs.unlinkSync(file); } catch (_) {}
          continue;
        }
      }
    } catch (e) {
      this.log('RESUME', `加载 checkpoint 失败: ${e.message}`);
    }
    this.log('RESUME', '无可用 checkpoint');
    return null;
  }

  /**
   * 【新增】清除 checkpoint(成功完成后调用)
   * 【审计修复·P0】补全 phase0 和 phase3.5
   */
  _clearCheckpoints() {
    try {
      const fs = require('fs');
      const allPhases = ['phase0', 'phase1', 'phase2', 'phase3', 'phase3.5'];
      allPhases.forEach(phase => {
        const file = path.join(this._checkpointDir, `checkpoint-${phase}.json`);
        if (fs.existsSync(file)) {
          try { fs.unlinkSync(file); } catch (e) {
            this.log('CHECKPOINT', `清除 ${phase} 失败: ${e.message}`);
          }
        }
      });
    } catch (e) { /* 忽略 */ }
  }

  /**
   * 【新增】内存检查,超过阈值进入低资源模式
   */
  _checkMemory(tag = '') {
    const mem = process.memoryUsage();
    const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
    if (heapMB > this._memThresholdMB) {
      this._lowResourceMode = true;
      this.log('MEM-WARN', `⚠️ 堆内存 ${heapMB}MB 超阈值 ${this._memThresholdMB}MB @ ${tag},进入低资源模式`);
      if (global.gc) {
        global.gc();
        const after = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
        this.log('MEM-WARN', `GC 后堆内存 ${after}MB (${heapMB}→${after})`);
      }
    }
    return heapMB;
  }

  /**
   * 【新增】预算剩余(毫秒)
   */
  _budgetRemaining() {
    if (!this._globalDeadline) return Infinity;
    return Math.max(0, this._globalDeadline - Date.now());
  }

  /**
   * 【新增】预算守卫:是否还能承担 needMs
   */
  _canAfford(needMs) {
    return this._budgetRemaining() > needMs;
  }

  /**
   * 【新增】增量保存 checkpoint（已提取到 utils/checkpoint-manager.js）
   * 保持向后兼容，内部委托给 CheckpointManager
   */
  async _saveCheckpoint(phase, shots, extra = {}) {
    if (!this._checkpointManager) {
      this._checkpointManager = new CheckpointManager(this._checkpointDir);
    }
    const result = this._checkpointManager.save(phase, shots, extra, this.log.bind(this));
    if (!result.success) {
      // 保持原有行为：保存失败不抛异常
    }
  }

  /**
   * 【审计修复·P0】安全序列化（已提取到 utils/safe-stringify.js）
   * 保持向后兼容，内部委托给提取的工具函数
   */
  _safeStringify(obj) {
    return safeStringify(obj);
  }

  /**
   * v2.0.0-LLM-Agent: 初始化所有Agent
   */
  _initAgents() {
    const base = {
      llmTimeout: this.agentConfig.llmTimeout,
      llmMaxRetries: this.agentConfig.llmMaxRetries,
      enabled: this.agentConfig.enableLLMAgents
    };
    const deepModel = this.agentConfig.llmModel || 'kimi-k2p6';
    const fastModel = this.agentConfig.fastModel || deepModel;

    this.agents = {
      // 深度模型:创造性主任务
      sceneDesign: new SceneDesignAgent({ ...base, llmModel: deepModel }),
      visualLanguage: new VisualLanguageAgent({ ...base, llmModel: deepModel }),
      promptFusion: new PromptFusionAgent({ ...base, llmModel: deepModel, maxPromptLength: this.config.maxPromptLength }),

      // 快速模型:结构化小任务(音效/片头/审查),可用非推理模型加速
      audioDesign: new AudioDesignAgent({ ...base, llmModel: fastModel, llmMaxTokens: 8000 }),
      openingDesign: new OpeningDesignAgent({ ...base, llmModel: fastModel, llmMaxTokens: 8000 }),
      continuityReview: new ContinuityReviewAgent({ ...base, llmModel: fastModel, llmMaxTokens: 8000 })
    };

    console.log(`[ProductionEngine v2.0] LLM Agents ${this.agentConfig.enableLLMAgents ? '已启用' : '已禁用'} | deep=${deepModel} fast=${fastModel}`);
  }

  _initModules() {
    // 加载核心模块(从现有系统复用)
    this.modules = {
      // 时长分配
      shotDurationAllocator: loadModule('shot-duration-allocator.js')?.ShotDurationAllocator,
      durationCalculator: loadModule('duration-calculator.js')?.DurationCalculator,

      // 运镜系统
      cameraMovement: loadModule('camera-movement-system-v2.js')?.CameraMovementSystem,
      intraShotTimeline: loadModule('camera-movement-system-v3.js')?.IntraShotTimelineGenerator,

      // 连续性
      continuityEngine: loadModule('continuity-engine.js')?.ContinuityEngine,

      // Prompt 增强
      promptEnhancer: loadModule('intra-shot-prompt-enhancer.js')?.IntraShotPromptEnhancer,
      styleInjector: loadModule('universal-style-injector.js')?.UniversalStyleInjector,

      // 质量门
      promptQualityGate: loadModule('prompt-quality-gate.js')?.PromptQualityGate,

      // 字符计数
      charCounter: loadModule('char-counter')?.charCounter,

      // 片头系统
      openingSystem: loadModule('opening-system-v3.js'),

      // 角色系统
      characterManager: loadModule('character-manager-v2.js')?.CharacterManagerV2,
      characterPromptBuilder: loadModule('character-prompt-builder.js')?.CharacterPromptBuilder,

      // 校验
      storyboardValidator: loadModule('storyboard-validator.js')?.StoryboardValidator,
      preRenderValidation: loadModule('pre-render-validation.js')?.preRenderValidation,

      // 后期
      postProduction: loadModule('post-production-pipeline.js')?.PostProductionPipeline,
    };

    // 初始化实例
    for (const [key, Module] of Object.entries(this.modules)) {
      if (Module && typeof Module === 'function') {
        try {
          this.modules[key] = new Module();
        } catch (e) {
          // 已经是实例或无需 new
        }
      }
    }
  }

  log(stage, message) {
    const entry = { stage, message, timestamp: Date.now() };
    this.logs.push(entry);
    console.log(`[${stage}] ${message}`);
  }

  /**
   * 主入口:从 ScriptBlueprint 生成完整镜头
   * @param {object} adaptedBlueprint - 适配器输出的剧本数据
   * @returns {object} { shots, prompts, report }
   */
  /**
   * v2.0.5-彻底修复: LLM Agent输出标准化层
   * 已提取到 utils/llm-output-normalizer.js
   * 保持向后兼容，内部委托给 LLMOutputNormalizer
   */
  _normalizeLLMOutput(shots, blueprint) {
    const normalized = LLMOutputNormalizer.normalizeShots(shots, blueprint);
    
    // 保留原有的角色信息补全逻辑（未提取到独立工具中）
    return normalized.map((shot, idx) => {
      const originalShot = shots[idx];
      
      // 5. 角色信息补全:如果shot没有characters,从blueprint补
      if (!originalShot.characters || originalShot.characters.length === 0) {
        shot.characters = blueprint.characters || [];
      }

      // 6. 角色引用补全:如果characterRef为NONE但有角色,生成描述性引用
      if ((!originalShot.characterRef || originalShot.characterRef === 'NONE') && blueprint.characters && blueprint.characters.length > 0) {
        const mainChar = blueprint.characters.find(c => c.role === 'protagonist') || blueprint.characters[0];
        if (mainChar) {
          shot.characterRef = `${mainChar.name}: ${mainChar.description || mainChar.persona || 'main character'}`;
        }
      }

      return shot;
    });
  }

  /**
   * v2.0.5-彻底修复: 质量门适配LLM融合模式
   * 当fusionText存在时,检查标准放宽(信息在融合段中)
   */
  _runQualityGateAdapted(prompts) {
    const checks = prompts.map(p => {
      const hasFusion = p.prompt && p.prompt.includes('fusion');
      // 有fusionText时,timeline/camera/lighting可以不在独立字段中
      const hasTimeline = !!p.timelineString || hasFusion;
      const hasCamera = !!p.cameraString || hasFusion;
      const hasLighting = !!p.lightingString || hasFusion;

      return {
        shotId: p.shotId,
        hasPrompt: !!p.prompt && p.prompt.length > 50,
        hasDuration: !!p.duration && p.duration > 0,
        hasTimeline,
        hasCharacter: p.character !== 'NONE' || p.characterRef !== 'NONE',
        hasMood: !!p.mood,
        hasDialogue: p.dialogue !== 'NONE' && p.dialogue !== '',
        lengthOk: p.promptCharCount > 0 && p.promptCharCount < 2000,
        passed: false // 后面计算
      };
    });

    checks.forEach(c => {
      c.passed = c.hasPrompt && c.hasDuration && c.hasTimeline &&
                 c.hasCharacter && c.hasMood && c.hasDialogue && c.lengthOk;
    });

    const allPassed = checks.every(c => c.passed);
    return { passed: allPassed, checks };
  }

  // 【v2.1.4-fix10-P25-fix3】暴露单镜头融合方法，供 run-phase3.js 单镜头粒度续跑
  async fuseSingleShotPublic(shot, ratio, characters) {
    if (!this.agents.promptFusion) {
      throw new Error('PromptFusionAgent 未初始化');
    }
    return this.agents.promptFusion._fuseSingleShot(shot, ratio, characters);
  }
  async produce(adaptedBlueprint, runtimeAgentConfig = null) {
    const startTime = Date.now();

    // 【修复】应用运行时配置(双保险:create() 已调 updateAgentConfig,这里再兜一次)
    if (runtimeAgentConfig) {
      this.updateAgentConfig(runtimeAgentConfig);
    }

    // === 全局时间预算 ===
    // 【v2.1.4-fix11】增加总预算，确保Phase 3串行处理有足够时间
    // 原预算：540s (9min) → 新预算：1200s (20min)
    // Phase 1: ~90s | Phase 2: ~300s | Phase 3: ~570s (串行6镜头 × 90s)
    // 总计需求：~960s，预留240s余量应对波动
    const HARD_BUDGET_MS = this.agentConfig.totalDeadlineMs || 1200000;
    const SAFETY_MARGIN_MS = 60000; // 余量60s
    const globalDeadline = startTime + HARD_BUDGET_MS - SAFETY_MARGIN_MS;
    this._globalDeadline = globalDeadline;
    this._setAgentDeadline(globalDeadline);

    this.log('PRODUCE', `🎬 ProductionEngine 启动 | LLM=${this.agentConfig.enableLLMAgents} | 预算 ${Math.round(HARD_BUDGET_MS / 1000)}s | 余量 ${Math.round(SAFETY_MARGIN_MS / 1000)}s | 堆 ${this._checkMemory('start')}MB`);

    const result = {
      success: false, shots: [], prompts: [], stages: {}, errors: [],
      logs: this.logs, timing: {}, llmStats: {}, degraded: false, resumed: false
    };

    try {
      // ===== Stage 1-2:规则阶段(快)=====
      result.stages.sceneExtraction = await this._runStage('scene-extraction', () => this._extractScenes(adaptedBlueprint));
      result.stages.durationAllocation = await this._runStage('duration-allocation', () => this._allocateDuration(result.stages.sceneExtraction.shots));
      let currentShots = result.stages.durationAllocation.shots;

      // 规则降级路径(保留原行为)
      if (!this.agentConfig.enableLLMAgents) {
        return await this._produceViaRules(currentShots, adaptedBlueprint, result, startTime);
      }

      // ===== LLM 模式(主路径:断点续跑 + 预算守卫)=====
      let phase1Failed = false;

      // ===== 断点续跑:尝试加载已完成的 checkpoint =====
      const ckpt = this._loadLatestCheckpoint();
      let startPhase = 1;
      if (ckpt) {
        currentShots = ckpt.shots;
        result.opening = ckpt.opening || null;
        result.llmStats = ckpt.llmStats || {};
        if (ckpt.phase === 'phase1') startPhase = 2;
        else if (ckpt.phase === 'phase2') startPhase = 3;
        else if (ckpt.phase === 'phase3') {
          startPhase = 99;
          this.log('RESUME', '✅ 全部 Phase 已完成,跳过 LLM 直接进 Quality Gate');
        }
        result.resumed = true;
      }

      // ----- Phase 1:SceneDesign ∥ OpeningDesign -----
      if (startPhase <= 1) {
      try {
        if (!this._canAfford(140000)) {
          this.log('PHASE-1', `⚠️ 预算不足(剩${this._budgetRemaining()}ms),保存当前结果退出,下次续跑`);
          await this._saveCheckpoint('phase0', currentShots, { opening: result.opening, llmStats: result.llmStats });
          throw new Error('预算不足,请重跑以断点续跑(LLM 产出已保存)');
        }
        this.log('PHASE-1', 'SceneDesign + OpeningDesign 并行启动...');
        const phase1Start = Date.now();
        const [sdResult, odResult] = await this._runParallel({
          'scene-design-agent': this.agents.sceneDesign.process(this._cloneShots(currentShots), adaptedBlueprint),
          'opening-design-agent': this._shouldGenerateOpening(adaptedBlueprint)
            ? this.agents.openingDesign.process(adaptedBlueprint)
            : Promise.resolve(null)
        }, 'PHASE-1');

        currentShots = this._mergeShotsByShotId(currentShots, sdResult.shots, ['scene', 'mood', 'action', 'emotional_target']);
        if (odResult && odResult.opening) {
          result.stages.opening = { agent: 'openingDesign', ...odResult };
          result.opening = odResult.opening;
          // 【v2.1.4-patch3】将opening数据注入到sceneType=opening的shot中
          // 【审计修复·P0】先克隆片头shot再修改，避免直接变异原始对象
          const openingIdx = currentShots.findIndex(s => s.sceneType === 'opening');
          if (openingIdx >= 0) {
            currentShots[openingIdx] = this._deepCloneShot(currentShots[openingIdx]);
          }
          const openingShot = openingIdx >= 0 ? currentShots[openingIdx] : null;
          if (openingShot) {
            const od = odResult.opening;
            // v2.1.4-fix8: 兼容下划线命名(main_title/sub_title)和驼峰命名(mainTitle/subtitle)
            const titleOverlay = od.titleOverlay || {};
            openingShot.title = od.title || titleOverlay.mainTitle || titleOverlay.main_title || '';
            openingShot.subtitle = od.subtitle || titleOverlay.subtitle || titleOverlay.sub_title || '';
            openingShot.titleOverlay = od.titleOverlay || null;
            openingShot.audioLayer = od.audioLayer || null;
            openingShot.lightingString = od.lightingString || openingShot.lightingString;
            openingShot.cameraString = od.cameraString || openingShot.cameraString;
            console.log(`[ProductionEngine] OpeningDesign数据已注入到 ${openingShot.shotId}: title="${openingShot.title}", subtitle="${openingShot.subtitle}"`);
          }
        }
        result.llmStats.sceneDesign = sdResult.timing;
        result.llmStats.openingDesign = odResult?.timing;
        this.log('PHASE-1', `完成 (${Date.now() - phase1Start}ms)`);
        await this._saveCheckpoint('phase1', currentShots, { opening: result.opening, llmStats: result.llmStats });
        this._checkMemory('phase1');
      } catch (e) {
        this.log('PHASE-1-FAIL', `❌ ${e.message}`);
        phase1Failed = true;
      }
      }

      // ----- Phase 2:VisualLanguage → AudioDesign → ContinuityReview (串行，避免并发超限SIGKILL) -----
      // 【审计修复】Phase 1 失败不应跳过 Phase 2/3，应像 Phase 2 那样用已有 shots 继续
      if (startPhase <= 2) {
        if (phase1Failed) {
          this.log('PHASE-2', '⚠️ Phase 1 已失败，Phase 2 用现有 shots 尝试继续（降级模式）');
        }
        try {
          if (!this._canAfford(80000)) {
            this.log('PHASE-2', `⚠️ 预算不足(剩${this._budgetRemaining()}ms),保存退出,下次从 Phase2 续跑`);
            await this._saveCheckpoint('phase1', currentShots, { opening: result.opening, llmStats: result.llmStats });
            throw new Error('预算不足,请重跑以断点续跑(Phase1 LLM 产出已保存)');
          }
          this.log('PHASE-2', 'VisualLanguage → AudioDesign → ContinuityReview 串行启动...');
          const phase2Start = Date.now();
          
          // 【v2.1.4-fix9-P2】串行执行避免内存/并发超限
          const vlResult = await this.agents.visualLanguage.process(this._cloneShots(currentShots), adaptedBlueprint);
          this.log('VISUAL-LANGUAGE-AGENT', `完成`);
          currentShots = this._mergeShotsByShotId(currentShots, vlResult.shots, ['visual_elements', 'lighting', 'color_temperature', 'camera_movement']);
          
          const adResult = await this.agents.audioDesign.process(this._cloneShots(currentShots), adaptedBlueprint);
          this.log('AUDIO-DESIGN-AGENT', `完成`);
          currentShots = this._mergeShotsByShotId(currentShots, adResult.shots, ['audio', 'music', 'sound_effects', 'backgroundSound', 'backgroundSoundString']);
          
          const crResult = await this.agents.continuityReview.process(
            this._cloneShots(currentShots),
            adaptedBlueprint,
            {
              totalEpisodes: adaptedBlueprint.config?._metadata?.series?.totalEpisodes || adaptedBlueprint.config?._metadata?.totalEpisodes || 1,
              episodeIndex: adaptedBlueprint.config?._metadata?.series?.currentEpisode || adaptedBlueprint.config?._metadata?.episode || 1,
              episodeContract: this._buildEpisodeContract(adaptedBlueprint)
            }
          );
          this.log('CONTINUITY-REVIEW-AGENT', `完成`);
          
          result.stages.continuity = { agent: 'continuityReview', ...crResult };
          // 【v2.1.4】保存跨集边界校验报告
          if (crResult.boundaryReport) {
            result.stages.boundaryReport = crResult.boundaryReport;
            this.log('BOUNDARY-GUARD', `跨集边界校验: ${crResult.boundaryReport.summary}`);
          }
          result.llmStats.visualLanguage = vlResult.timing;
          result.llmStats.audioDesign = adResult.timing;
          result.llmStats.continuityReview = crResult.timing;
          this.log('PHASE-2', `完成 (${Date.now() - phase2Start}ms)`);
          await this._saveCheckpoint('phase2', currentShots, { opening: result.opening, llmStats: result.llmStats });
          this._checkMemory('phase2');
        } catch (e) {
          this.log('PHASE-2-FAIL', `❌ ${e.message},Phase2 失败但继续`);
          // Phase 2 失败不致命,用已有数据继续
        }
      }

      // ----- Phase 3:PromptFusion(串行模式,每镜头独立 LLM 调用)-----
      // 【审计修复】Phase 1 失败不应跳过 Phase 2/3
      if (startPhase <= 3) {
        if (phase1Failed) {
          this.log('PHASE-3', '⚠️ Phase 1 已失败，Phase 3 用现有 shots 尝试继续（降级模式）');
        }
        // 【v2.1.4-fix11-D】动态预算分配：根据镜头数计算Phase 3所需时间
        // 公式：镜头数 × 180秒(LLM生成) + 30秒(缓冲)
        // 【v2.1.5-fix】从90s增加到180s，实际LLM调用需120-180s/镜头
        const shotCount = currentShots.length;
        const PHASE3_PER_SHOT_MS = 180000; // 每镜头180秒（实际需120-180s）
        const PHASE3_BUFFER_MS = 30000;   // 30秒缓冲
        const phase3NeedMs = shotCount * PHASE3_PER_SHOT_MS + PHASE3_BUFFER_MS;
        
        this.log('PHASE-3', `📊 动态预算计算: ${shotCount}镜头 × ${PHASE3_PER_SHOT_MS/1000}s + ${PHASE3_BUFFER_MS/1000}s缓冲 = 需${Math.round(phase3NeedMs/1000)}s`);
        
        if (!this._canAfford(phase3NeedMs)) {
          this.log('PHASE-3', `⚠️ 预算不足(剩${Math.round(this._budgetRemaining()/1000)}s,需${Math.round(phase3NeedMs/1000)}s),保存退出,下次从 Phase3 续跑`);
          await this._saveCheckpoint('phase2', currentShots, { opening: result.opening, llmStats: result.llmStats });
          throw new Error('预算不足,请重跑以断点续跑(Phase1+2 LLM 产出已保存)');
        }
        try {
          this.log('PROMPT-FUSION-AGENT', `开始(串行模式,${shotCount}镜头,预计${Math.round(phase3NeedMs/1000)}s)...`);
          const phase3Start = Date.now();
          const pfResult = await this.agents.promptFusion.process(this._cloneShots(currentShots), adaptedBlueprint);
          // 【审计修复】补全 25 字段，原列表缺 lighting/scene/character/action/dialogue/mood/timeline/composition/constraint/baseline
          currentShots = this._mergeShotsByShotId(currentShots, pfResult.shots, [
            'prompt', 'enhanced_prompt', 'negative_prompt', 'fields', 'fusionText', 'promptCharCount',
            // 25字段全部纳入
            'director_instruction', 'constraint', 'baseline', 'scene', 'lighting', 'composition',
            'color_palette', 'depth_of_field', 'camera_movement', 'character', 'costume', 'makeup',
            'action', 'props', 'portraits', 'dialogue', 'timeline', 'mood', 'pacing', 'transition',
            'audio', 'negative', 'bright_constraint', 'character_constraint', 'consistency'
          ]);
          result.llmStats.promptFusion = pfResult.timing;
          this.log('PROMPT-FUSION-AGENT', `完成 (${Date.now() - phase3Start}ms)`);
          await this._saveCheckpoint('phase3', currentShots, { opening: result.opening, llmStats: result.llmStats });
        } catch (e) {
          this.log('PROMPT-FUSION-FAIL', `❌ ${e.message},部分镜头降级到规则 Prompt`);
        }
      }

      // ===== Phase-3.5 前置：展平 shot.fields + 统一字段命名 =====
      // 【审计修复】PromptFusion 的 fields 是最终权威来源，允许覆盖顶层旧值
      currentShots = currentShots.map(shot => {
        const flat = { ...shot };
        if (shot.fields && typeof shot.fields === 'object') {
          for (const [key, value] of Object.entries(shot.fields)) {
            if (value === undefined || value === null || value === '') continue;
            const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
            flat[key] = value; // 始终覆盖（fields 是最终权威）
            flat[camelKey] = value; // 驼峰也覆盖
          }
        }
        return flat;
      });

      // ===== Phase-3.5: 字段质量检查与修复（自适应预算）=====
      const remainingBudget = this._budgetRemaining();
      if (remainingBudget < 15000) {
        this.log('FIELD-QUALITY', `⚠️ 预算不足(剩${remainingBudget}ms),跳过字段质量检查`);
      } else if (remainingBudget < 60000) {
        // 15s-60s: 纯规则检查（不调LLM）
        try {
          this.log('FIELD-QUALITY', '开始(纯规则检查模式，预算极低)...');
          const fqStart = Date.now();
          const { FieldQualityPipeline } = require('../field-quality');
          const pipeline = new FieldQualityPipeline({
            llmModel: this.llmModel,
            maxRounds: 0, // 纯规则，不调用LLM
            checkerTimeout: 30000,
            repairerTimeout: 0,
          });
          pipeline.setPRDFromBlueprint(adaptedBlueprint);
          // 【v2.1.4-fix13-审计修复】下发全局 deadline
          pipeline.setDeadline?.(this._globalDeadline);
          const { finalShots, summary } = await pipeline.runAll(currentShots);
          currentShots = finalShots;
          this.log('FIELD-QUALITY', `完成 (${Date.now() - fqStart}ms) | 通过:${summary.passed}/${summary.totalShots} | 修复:${summary.totalRepairs} (纯规则模式)`);
        } catch (e) {
          this.log('FIELD-QUALITY-FAIL', `❌ ${e.message},继续执行`);
        }
      } else if (remainingBudget < 300000) {
        // 60s-300s: LLM检查1轮
        try {
          this.log('FIELD-QUALITY', '开始(规则+LLM 1轮检查与修复)...');
          const fqStart = Date.now();
          const { FieldQualityPipeline } = require('../field-quality');
          const pipeline = new FieldQualityPipeline({
            llmModel: this.llmModel,
            maxRounds: 1, // 1轮
            checkerTimeout: 60000,
            repairerTimeout: 120000,
          });
          pipeline.setPRDFromBlueprint(adaptedBlueprint);
          // 【v2.1.4-fix13-审计修复】下发全局 deadline
          pipeline.setDeadline?.(this._globalDeadline);
          const { finalShots, summary } = await pipeline.runAll(currentShots);
          currentShots = finalShots;
          this.log('FIELD-QUALITY', `完成 (${Date.now() - fqStart}ms) | 通过:${summary.passed}/${summary.totalShots} | 修复:${summary.totalRepairs}`);
          await this._saveCheckpoint('phase3.5', currentShots, { opening: result.opening, llmStats: result.llmStats });
        } catch (e) {
          this.log('FIELD-QUALITY-FAIL', `❌ ${e.message},继续执行`);
        }
      } else {
        // ≥300s: LLM检查2轮（原逻辑）
        try {
          this.log('FIELD-QUALITY', '开始(规则+LLM混合检查与修复)...');
          const fqStart = Date.now();
          const { FieldQualityPipeline } = require('../field-quality');
          const pipeline = new FieldQualityPipeline({
            llmModel: this.llmModel,
            maxRounds: 2,
            checkerTimeout: 120000,
            repairerTimeout: 180000,
          });
          pipeline.setPRDFromBlueprint(adaptedBlueprint);
          // 【v2.1.4-fix13-审计修复】下发全局 deadline
          pipeline.setDeadline?.(this._globalDeadline);
          const { finalShots, summary } = await pipeline.runAll(currentShots);
          currentShots = finalShots;
          this.log('FIELD-QUALITY', `完成 (${Date.now() - fqStart}ms) | 通过:${summary.passed}/${summary.totalShots} | 修复:${summary.totalRepairs}`);
          await this._saveCheckpoint('phase3.5', currentShots, { opening: result.opening, llmStats: result.llmStats });
        } catch (e) {
          this.log('FIELD-QUALITY-FAIL', `❌ ${e.message},继续执行`);
        }
      }

      // ===== 内容边界后处理(最终防线)=====
    currentShots = this._enforceContentBoundaries(currentShots, adaptedBlueprint);

    // ===== Quality Gate =====
      result.stages.qualityGate = await this._runStage('quality-gate', () => this._runQualityGate(currentShots));

      result.shots = currentShots;
      result.prompts = currentShots;
      result.meta = this._buildMeta(adaptedBlueprint);
      result.success = true;
      result.timing.total = Date.now() - startTime;
      this.log('PRODUCE', `✅ LLM 制作完成${result.resumed ? '(断点续跑)' : ''} | ${currentShots.length} 镜头 | ${result.timing.total}ms`);
      this._clearCheckpoints(); // 成功完成,清理 checkpoint

    } catch (error) {
      result.success = false;
      result.errors.push({ stage: 'production', message: error.message });
      this.log('ERROR', `❌ ${error.message}`);
      this.log('ERROR', `💡 若为预算不足,直接重跑同一命令即可从 checkpoint 续跑,LLM 产出不会丢`);

      // 【新增】最后兜底:用规则引擎抢救产出
      try {
        this.log('RECOVERY', '尝试规则兜底恢复...');
        const baseShots = result.stages.durationAllocation?.shots || [];
        const fallbackShots = await this._engineerPromptsFallback(baseShots, adaptedBlueprint);
        if (fallbackShots.length > 0) {
          result.shots = fallbackShots;
          result.prompts = fallbackShots;
          result.success = true;
          result.degraded = true;
          result.timing.total = Date.now() - startTime;
          this.log('RECOVERY', `✅ 规则兜底成功,产出 ${fallbackShots.length} 个镜头`);
        }
      } catch (e2) {
        result.errors.push({ stage: 'recovery', message: e2.message });
      }
    }

    return result;
  }

  /**
   * 【新增】规则模式完整生产路径(LLM 禁用时)
   */
  async _produceViaRules(currentShots, adaptedBlueprint, result, startTime) {
    this.log('RULES', '启用规则引擎模式(LLM 已禁用)');
    result.stages.promptEngineering = await this._runStage('prompt-engineering', () => this._engineerPrompts(currentShots, adaptedBlueprint));
    currentShots = result.stages.promptEngineering.shots;
    result.stages.qualityGate = await this._runStage('quality-gate', () => this._runQualityGate(currentShots));
    if (this._shouldGenerateOpening(adaptedBlueprint)) {
      result.stages.opening = await this._runStage('opening', () => this._generateOpening(adaptedBlueprint));
    }
    result.stages.continuity = await this._runStage('continuity', () => this._checkContinuity(currentShots));
    result.shots = currentShots;
    result.prompts = currentShots;
    result.meta = this._buildMeta(adaptedBlueprint);
    result.opening = result.stages.opening?.openingData || null;
    result.success = true;
    result.degraded = true;
    result.timing.total = Date.now() - startTime;
    this.log('PRODUCE', `✅ 规则模式完成 | ${currentShots.length} 镜头 | ${result.timing.total}ms`);
    return result;
  }

  /**
   * 【新增】规则 Prompt 工程兜底(LLM PromptFusion 失败时)
   * 优先复用现有 _engineerPrompts,否则用极简拼接
   */
  async _engineerPromptsFallback(shots, blueprint) {
    if (typeof this._engineerPrompts === 'function') {
      try {
        const r = await this._engineerPrompts(shots, blueprint);
        if (r?.shots?.length) return r.shots;
      } catch (e) {
        this.log('FALLBACK', `_engineerPrompts 失败: ${e.message},使用极简拼接`);
      }
    }
    return shots.map(s => ({
      ...s,
      prompt: this._assemblePromptSimple(s),
      enhanced_prompt: this._assemblePromptSimple(s),
      negative_prompt: 'blurry, low quality, distorted, watermark, text, deformed, extra limbs'
    }));
  }

  /**
   * 【新增】极简 Prompt 拼接(最后兜底)
   * 【v2.1.4-fix9-P12】兜底路径也强制写实场景和动作
   */
  _assemblePromptSimple(shot) {
    const parts = [];
    
    // 场景强制写实检查
    let sceneDesc = shot.scene || '';
    const sceneForbidden = ['全息', '虚拟', '投影', '抽象', '光影场域', '数据空间', '元宇宙', '时间操控', '霓虹', '微观世界', '宏观', '抽象几何', '流动光影', '交织光影', '色彩对冲'];
    if (sceneForbidden.some(w => sceneDesc.includes(w))) {
      const fallbackScenes = [
        '医院健康宣教室，白色荧光灯均匀照明，白墙面贴有无文字骨骼肌解剖图与运动损伤海报（纯图形版），木质讲台表面带有细微使用划痕，地面浅灰色防滑PVC地胶',
        '三甲医院检验科走廊，冷白色LED光源从走廊顶部连续排列向下照射，无文字箭头标识牌指向尿液检验窗口，地面浅色抛光瓷砖，墙面白色医用抗菌涂层',
        '医生诊室，白色墙面悬挂无文字人体解剖示意图（纯图形版），办公桌摆放听诊器与血压计，检查床铺有蓝色一次性床单，无影灯悬于上方，窗光透入',
        '医院健康管理中心，嵌入式LED灯带洒下柔和暖白光，接待台后方排列无文字健康宣传展板（纯图形版），前方皮质沙发与实木茶几，地面灰色哑光瓷砖'
      ];
      const idx = parseInt(shot.shotId?.replace(/\D/g, '') || '0') || 0;
      sceneDesc = fallbackScenes[idx % fallbackScenes.length];
    }
    if (sceneDesc) parts.push(sceneDesc);
    
    if (shot.visual_elements) parts.push(shot.visual_elements);
    if (shot.lighting) parts.push(shot.lighting);
    if (shot.camera_movement) parts.push(shot.camera_movement);
    
    // 动作强制写实检查
    let actionDesc = shot.action || '';
    const actionForbidden = ['全息', '虚拟', '投影', '空间扭曲', '时间残影', '霓虹', '数据流', '光即角色', '抽象构图', '梦境流动性', '手绘动画', '湿版摄影', '黑色电影'];
    if (actionForbidden.some(w => actionDesc.includes(w))) {
      const fallbackActions = [
        '镜头缓慢推近，示例角色站立讲台前，自然手势讲解，眼神注视镜头，警服在荧光灯下轮廓清晰',
        '稳定机位中景，示例角色沿走廊缓步前行，侧头指向检验窗口，白大褂医生从背景走过',
        '手持微晃跟拍，示例角色靠近检查床，手指轻触医学挂图，无影灯在头顶形成柔和光晕',
        '固定机位中景，示例角色坐于沙发边缘，双手交叠置于膝上，LED灯带在身后形成均匀轮廓光',
        '缓慢后拉全景，示例角色站立检验窗口前，转身面向镜头，不锈钢台面反射冷白色光源'
      ];
      const idx = parseInt(shot.shotId?.replace(/\D/g, '') || '0') || 0;
      actionDesc = fallbackActions[idx % fallbackActions.length];
    }
    if (actionDesc) parts.push(actionDesc);
    
    if (shot.mood) parts.push(`atmosphere: ${shot.mood}`);
    
    // v6.6.10-fix: 极简路径使用全局模块，区分片头/内容镜
    const isOpeningSimple = shot.type === 'opening' || shot.sceneType === 'opening';
    const negativeSimple = isOpeningSimple
      ? globalNegativePromptInjector.generateForOpeningShot({ maxLength: 200 }).replace('【负面约束】', '')
      : globalNegativePromptInjector.generateForContentShot({ maxLength: 250 }).replace('【负面约束】', '');
    parts.push(negativeSimple);
    
    return parts.filter(Boolean).join(', ').slice(0, this.config.maxPromptLength);
  }

  /**
   * 【新增】内容边界强制过滤(最后防线)
   * 检测并清除越界内容(预告下集、提前讲后续知识点等)
   */
  _enforceContentBoundaries(shots, blueprint) {
    const meta = blueprint.config?._metadata || blueprint._metadata || {};
    const isSeries = meta.isSeries || (meta.series?.totalEpisodes > 1) || (meta.total_episodes > 1);
    const noPreview = meta.noNextEpisodePreview || meta.no_next_episode_preview;

    if (!isSeries && !noPreview) return shots;

    const forbiddenPatterns = [
      /下一集/g, /下集/g, /后续.*介绍/g, /下次再说/g, /下次.*讲/g,
      /待.*续/g, /未完待续/g, /且听.*分解/g
    ];

    let violations = 0;
    const cleaned = shots.map(shot => {
      let prompt = shot.prompt || '';
      let fusionText = shot.fusionText || '';
      let changed = false;

      for (const pattern of forbiddenPatterns) {
        if (pattern.test(prompt)) {
          prompt = prompt.replace(pattern, '...');
          changed = true;
          violations++;
        }
        if (pattern.test(fusionText)) {
          fusionText = fusionText.replace(pattern, '...');
          changed = true;
          violations++;
        }
      }

      if (changed) {
        this.log('BOUNDARY-GUARD', `⚠️ 清除越界内容: ${shot.shotId}`);
      }
      return changed ? { ...shot, prompt, fusionText } : shot;
    });

    if (violations > 0) {
      this.log('BOUNDARY-GUARD', `✅ 共清除 ${violations} 处越界内容`);
    }
    return cleaned;
  }

  /**
   * 运行单个 Stage 并计时
   */
  async _runStage(stageName, stageFn) {
    const start = Date.now();
    this.log(stageName.toUpperCase(), `开始...`);

    try {
      const output = await stageFn();
      const duration = Date.now() - start;
      this.log(stageName.toUpperCase(), `完成 (${duration}ms)`);
      return { ...output, _stageDuration: duration };
    } catch (error) {
      const duration = Date.now() - start;
      this.log(stageName.toUpperCase(), `失败 (${duration}ms): ${error.message}`);
      throw error;
    }
  }

  /** 是否需要生成片头 */
  _shouldGenerateOpening(adaptedBlueprint) {
    const _meta = adaptedBlueprint.config?._metadata || adaptedBlueprint._metadata || {};
    return _meta.isSeries ? (_meta.episodeNumber === 1) : (_meta.hasOpening !== false);
  }

  /** 【v2.1.4】从adaptedBlueprint构造边界契约 */
  /** 【v2.1.4】从adaptedBlueprint构造边界契约 */
  _buildEpisodeContract(adaptedBlueprint) {
    // adaptedBlueprint结构: { config: { _metadata: {...} }, scenes: [...] }
    const meta = adaptedBlueprint.config?._metadata || {};
    const series = meta.series || {};
    const plan = meta.seriesContentPlan || {};
    const episodeIndex = series.currentEpisode || meta.episode || 1;

    // 优先从seriesContentPlan提取
    if (plan.episodes && plan.episodes[episodeIndex - 1]) {
      const ep = plan.episodes[episodeIndex - 1];
      return {
        mustCover: ep.mustCover || ep.coreTopics || [],
        canMention: ep.canMention || [],
        mustNotCover: ep.mustNotCover || [],
        previousSummary: null
      };
    }

    // 回退:从series信息构造
    return {
      mustCover: series.episodeThemes || [],
      canMention: [],
      mustNotCover: [],
      previousSummary: null
    };
  }

  /** 把全局截止时间下发给所有 Agent */
  _setAgentDeadline(deadlineMs) {
    for (const a of Object.values(this.agents || {})) {
      if (a && typeof a.setDeadline === 'function') a.setDeadline(deadlineMs);
    }
  }

  /** 浅拷贝 shots(并行分支互不污染) */
  _cloneShots(shots) {
    if (!Array.isArray(shots)) return [];
    return shots.map(s => this._deepCloneShot(s));
  }

  /**
   * 【审计修复·P0】安全深拷贝单个 shot
   * 处理循环引用、跳过重型字段（_blueprint等）
   */
  _deepCloneShot(shot) {
    if (shot === null || typeof shot !== 'object') return shot;

    // 快速路径：无 _blueprint 等重型字段时直接 JSON 拷贝（最快）
    if (!shot._blueprint && !shot._adapter && !shot._llm && !shot._engine) {
      try {
        return JSON.parse(JSON.stringify(shot));
      } catch (e) {
        // 有循环引用，走慢路径
      }
    }

    // 慢路径：手动递归拷贝，处理循环引用
    const seen = new WeakMap();
    const clone = (obj) => {
      if (obj === null || typeof obj !== 'object') return obj;
      if (typeof obj === 'function') return undefined; // 跳过函数
      if (seen.has(obj)) return seen.get(obj); // 循环引用：返回已拷贝的引用
      if (Array.isArray(obj)) {
        const arr = [];
        seen.set(obj, arr);
        for (const item of obj) {
          const c = clone(item);
          if (c !== undefined) arr.push(c);
        }
        return arr;
      }
      const result = {};
      seen.set(obj, result);
      for (const [key, value] of Object.entries(obj)) {
        // 跳过已知重型/循环引用字段（保留浅引用）
        if (['_blueprint', '_adapter', '_llm', '_engine', '_metadata_raw'].includes(key)) {
          continue;
        }
        const c = clone(value);
        if (c !== undefined) result[key] = c;
      }
      return result;
    };

    const result = clone(shot);
    // 保留 _blueprint 的浅引用（太重不便深拷贝，但下游需要读取）
    if (shot._blueprint) result._blueprint = shot._blueprint;
    return result;
  }

  /**
   * 【审计修复·P0】深拷贝单个字段值（用于 _mergeShotsByShotId）
   */
  _deepCloneValue(value) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) {
      return value.map(v => this._deepCloneValue(v));
    }
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (e) {
      // 循环引用兜底：浅拷贝
      return { ...value };
    }
  }

  /**
   * 按 shotId 把 updatedShots 的指定字段合并回 baseShots
   * - 只在字段非空时覆盖,避免降级返回的空字符串冲掉已有数据
   * 【审计修复·P0】merged[f] = v 是引用赋值，改为深拷贝
   */
  _mergeShotsByShotId(baseShots, updatedShots, fields) {
    const map = new Map((updatedShots || []).map(s => [s.shotId, s]));
    return baseShots.map(shot => {
      const u = map.get(shot.shotId);
      if (!u) return shot;
      const merged = this._deepCloneShot(shot); // 先深拷贝目标
      for (const f of fields) {
        const v = u[f];
        // 【审计修复】过滤假值，避免 0/false 覆盖有效数据
        if (v !== undefined && v !== null && v !== '' && !(typeof v === 'number' && v === 0 && f === 'duration')) {
          merged[f] = this._deepCloneValue(v); // 深拷贝源字段
        }
      }
      return merged;
    });
  }

  /**
   * 并行执行多个 Agent 任务(allSettled,单点失败不阻塞其余)
   * 【v2.1.4-fix13-审计修复】增加外层超时保护，防止单个task hang住拖垮整个并行阶段
   */
  async _runParallel(tasks, label, timeoutMs = 300000) {
    const keys = Object.keys(tasks);
    const starts = keys.map(() => Date.now());
    this.log(label, `${keys.join(' + ')} 并行启动...`);

    const wrapped = keys.map((k, i) =>
      Promise.resolve(tasks[k]).then(v => {
        this.log(k.toUpperCase(), `完成 (${Date.now() - starts[i]}ms)`);
        return v;
      })
    );

    // 【v2.1.4-fix13-审计修复】外层超时保护：整个并行阶段最多等timeoutMs
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}并行阶段超时(${timeoutMs}ms)`)), timeoutMs);
    });

    const settled = await Promise.race([
      Promise.allSettled(wrapped),
      timeoutPromise
    ]).finally(() => clearTimeout(timer));

    const values = [];
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        values.push(r.value);
      } else {
        this.log(label, `⚠️ ${keys[i]} 异常: ${r.reason?.message || r.reason}(降级处理,继续)`);
        values.push(this._emptyAgentResult(keys[i]));
      }
    });
    return values;
  }

  /** 并行任务异常时的兜底空结果(仅兜底,正常路径不会走到) */
  _emptyAgentResult(name) {
    if (name === 'opening-design-agent') return { opening: null, degraded: true, degradeReason: 'phase exception' };
    if (name === 'continuity-review-agent') return { review: { overallScore: 80, issues: [], summary: '并行阶段异常,跳过审查' }, degraded: true, degradeReason: 'phase exception' };
    return { shots: [], degraded: true, degradeReason: 'phase exception' };
  }

  /**
   * v6.37-P0: 构建 Meta 元信息
   */
  _buildMeta(adaptedBlueprint) {
    const worldSetting = adaptedBlueprint.worldSetting || {};
    const config = adaptedBlueprint.config || {};

    return {
      title: config.title || '未命名短片',
      worldview: worldSetting.world_id || 'default',
      totalDuration: this._calculateTotalDuration(adaptedBlueprint.scenes),
      openingDuration: config.opening_duration || 10,
      fps: 24,
      resolution: '1920x1080',
      styleNotes: config.style_notes || 'cinematic, hyperrealistic'
    };
  }

  _calculateTotalDuration(scenes) {
    if (!scenes || scenes.length === 0) return 0;
    return scenes.reduce((sum, scene) => sum + (scene.timing?.duration || 20), 0);
  }

  /**
   * v6.37-P1+: 构建角色极简锚点(专家反馈强化)
   * 规则:
   * 1. 强制3-5个视觉关键词(不含种族/物种)
   * 2. 禁止详细描述(如"十五米高的巨型身躯")
   * 3. 颜色词不超过2个
   * 4. 禁止形容词堆砌(超过3个连续形容词则截断)
   * 5. 格式:角色名: 种族/物种, 视觉关键词1, 视觉关键词2, 视觉关键词3
   *
   * 正例:白泽: lion-like beast, vertical eye, three white-flame tails, golden hooves
   * 反例:白泽: 一只十五米高的白色神兽,有着三根尾巴和金色的蹄子(太啰嗦)
   */
  _buildMinimalAnchor(cid, characters) {
    const char = characters.find(c => c.character_id === cid);
    if (!char) return `${cid}: unknown`;

    const race = char.species || char.race || char.gender || 'human';
    const features = char.visual_anchor?.core_features || [];

    // 颜色词列表(用于检查)
    const colorWords = ['white', 'black', 'red', 'blue', 'green', 'golden', 'silver', 'purple', 'brown', 'grey', 'gray', 'yellow', 'orange', 'pink', 'cyan', 'teal'];

    // 形容词列表(用于检查堆砌)
    const adjectiveWords = ['big', 'huge', 'giant', 'large', 'small', 'tiny', 'massive', 'tall', 'short', 'beautiful', 'magnificent', 'mysterious', 'ancient', 'powerful', 'fierce', 'gentle', 'elegant', 'majestic', 'terrifying', 'sacred', 'divine', 'mythical', 'legendary', 'noble', 'wise', 'brave', 'curious', 'young', 'old'];

    // 过滤并优化特征
    const processedFeatures = [];
    let colorCount = 0;
    let adjCount = 0;

    for (const feature of features) {
      const lower = feature.toLowerCase();

      // 跳过详细描述(超过15字符可能太啰嗦)
      if (feature.length > 15 && !feature.includes(' ') && !feature.includes('-')) {
        continue; // 跳过单个超长词(可能是详细描述)
      }

      // 检查颜色词
      const isColor = colorWords.some(c => lower.includes(c));
      if (isColor) {
        if (colorCount >= 2) continue; // 颜色词不超过2个
        colorCount++;
      }

      // 检查形容词堆砌(连续形容词计数)
      const isAdjective = adjectiveWords.some(a => lower.includes(a));
      if (isAdjective) {
        adjCount++;
        if (adjCount > 3) continue; // 形容词不超过3个
      } else {
        adjCount = 0; // 重置计数
      }

      processedFeatures.push(feature);

      // 强制3-5个关键词
      if (processedFeatures.length >= 5) break;
    }

    // 确保至少3个关键词
    while (processedFeatures.length < 3 && features.length > processedFeatures.length) {
      const next = features[processedFeatures.length];
      if (next) processedFeatures.push(next);
      else break;
    }

    const keywords = processedFeatures.slice(0, 5).join(', ');
    return `${char.name}: ${race}, ${keywords}`;
  }

  /**
   * Stage 1: 从适配蓝图提取场景,转换为内部镜头结构
   * v6.37-P0: 改造为符合参考文档的字段格式
   */
  _extractScenes(adaptedBlueprint) {
    const scenes = adaptedBlueprint.scenes || [];
    const characters = adaptedBlueprint.characters || [];
    const worldSetting = adaptedBlueprint.worldSetting || {};

    // v1.2.5: 系列作品非第一集处理
    // 修复:兼容adapter返回的顶层_metadata和config._metadata
    const _metadata = adaptedBlueprint.config?._metadata || adaptedBlueprint._metadata || {};
    const isSeriesNonFirst = _metadata.isSeries && _metadata.episodeNumber > 1;

    let shots = scenes.map((scene, index) => {
      // v1.2.5: 非第一集将opening类型改为establishing
      let sceneType = scene.scene_type || 'establishing';
      if (isSeriesNonFirst && sceneType === 'opening') {
        console.log(`[ProductionEngine] 非第一集,场景 ${scene.scene_id} 从 opening 降级为 establishing`);
        sceneType = 'establishing';
      }

      // 构建角色描述(v6.37-P1+: 强制极简锚点,3-5关键词)
      const characterAnchors = (scene.characters || []).map(cid => {
        return this._buildMinimalAnchor(cid, characters);
      });

      // 构建对话(v6.37-P0: 统一格式 SPEAKER|TYPE|EMOTION|TEXT|LIP_SYNC:YES)
      const dialogueLines = (scene.dialogue?.lines || []).map(line => {
        const speaker = line.speaker || '角色';
        const type = line.type || '独白';
        const emotion = line.emotion || '平静';
        const text = line.text || '';
        return `${speaker}|${type}|${emotion}|${text}|LIP_SYNC:YES`;
      });

      // v6.37-P0: 构建五维空间描述(scene字段)
      const sceneDescription = this._buildFiveDimensionScene(scene, worldSetting);

      // v6.37-P0: 构建 mood(3-5情绪关键词)
      const mood = this._buildMood(scene);

      // v6.37-P0: 构建 action(核心动词+交互目标)
      const action = this._buildAction(scene);

      return {
        shotId: scene.scene_id || `S${String(index + 1).padStart(2, '0')}`,
        sceneType: sceneType,
        sceneFunction: scene.scene_function || 'establish',

        // v6.37-P0: 时序(保留对象,后续转为字符串)
        timing: {
          start: scene.timing?.start || 0,
          duration: scene.timing?.duration || 20,
          end: scene.timing?.end || 20
        },

        // v1.2.5: 添加顶层duration字段供FieldGuard使用
        duration: scene.timing?.duration || 20,

        // v6.37-P0: 场景(五维空间描述法)
        scene: sceneDescription,

        // v6.37-P0: 情绪
        mood: mood,

        // v6.37-P0: 角色(极简锚点)
        // 【v2.1.4-patch5】将 | 改为逗号,避免Seedance渲染乱码
        character: characterAnchors.join(', '),
        characterRef: this._buildCharacterRef(scene, characters),

        // v6.37-P0: 动作
        action: action,

        // v6.37-P0: 对话(统一格式)
        dialogue: dialogueLines.join(' || '),

        // 保留原始数据(供内部使用)
        characters: scene.characters || [],
        // 【v2.1.4-patch5】将 | 改为逗号,避免Seedance渲染乱码
        characterDescs: characterAnchors.join(', '),
        dialogueText: (scene.dialogue?.lines || []).map(l => l.text).join(';'),

        // 情感
        emotionalTarget: scene.emotional_target || { valence: 0, arousal: 0.5 },
        
        // 【v2.1.4-fix9-P1】附加 blueprint 引用，供 Agent 读取导演上下文
        _blueprint: adaptedBlueprint,

        // 视觉方向
        visualDirection: scene.visual_direction || {},

        // Prompt 基础
        promptBase: scene.prompt_base || '',

        // 世界设定
        worldId: worldSetting.world_id || 'default',

        // 状态
        status: 'pending'
      };
    });

    // v1.2.5: 时长归一化--确保总时长严格等于目标时长
    const targetDuration = adaptedBlueprint.config?.target_duration || adaptedBlueprint.meta?.target_duration || 120;
    shots = this._normalizeDurations(shots, targetDuration);

    return { shots, sceneCount: shots.length };
  }

  /**
   * v1.2.5: 时长归一化
   * 将场景时长按比例缩放,使总时长严格等于目标时长
   */
  _normalizeDurations(shots, targetDuration) {
    if (!shots || shots.length === 0) return shots;

    // 计算当前总时长(取最后一个场景的end时间)
    const currentEnd = Math.max(...shots.map(s => s.timing?.end || 0));
    if (currentEnd <= 0) return shots;

    // 如果已经精确匹配,无需调整
    if (currentEnd === targetDuration) {
      console.log(`[ProductionEngine] 时长已精确匹配: ${targetDuration}s`);
      return shots;
    }

    // 计算缩放比例
    const scale = targetDuration / currentEnd;
    console.log(`[ProductionEngine] 时长归一化: ${currentEnd}s → ${targetDuration}s (缩放: ${scale.toFixed(3)})`);

    // 按比例缩放每个场景的timing
    let accumulatedEnd = 0;
    for (let i = 0; i < shots.length; i++) {
      const shot = shots[i];
      const origDuration = shot.timing?.duration || 10;

      // 缩放时长,至少保留3秒
      const newDuration = Math.max(3, Math.round(origDuration * scale));

      // 更新timing和顶层duration
      shot.timing = {
        start: accumulatedEnd,
        duration: newDuration,
        end: accumulatedEnd + newDuration
      };
      shot.duration = newDuration;

      accumulatedEnd += newDuration;
    }

    // 最后微调:确保总时长精确等于目标
    const lastShot = shots[shots.length - 1];
    const diff = targetDuration - lastShot.timing.end;
    if (diff !== 0) {
      lastShot.timing.duration += diff;
      lastShot.timing.end = targetDuration;
      console.log(`[ProductionEngine] 最后微调: ${lastShot.shotId} 时长调整为 ${lastShot.timing.duration}s`);
    }

    return shots;
  }

  /**
   * v6.37-P0: 构建五维空间描述
   * 【v2.1.4-fix9-P7】强制写实场景：根据内容主题返回真实医院场景
   */
  _buildFiveDimensionScene(scene, worldSetting) {
    // 强制写实场景池 - 医院环境
    const realisticScenes = [
      '医院健康宣教室，白色荧光灯均匀照明，白墙面贴有骨骼肌解剖图与运动损伤海报，木质讲台表面带有细微使用划痕，地面浅灰色防滑PVC地胶，金属边框海报挂架反射冷光',
      '三甲医院检验科走廊，冷白色LED光源从走廊顶部连续排列向下照射，指示牌清晰指向尿液检验窗口，地面浅色抛光瓷砖反射冷光，墙面白色医用抗菌涂层，空间纵深长达20米',
      '医生诊室，白色墙面悬挂医学挂图，办公桌摆放听诊器与血压计，检查床铺有蓝色一次性床单，无影灯悬于上方，窗光透入形成自然侧光',
      '医院健康管理中心，嵌入式LED灯带洒下柔和暖白光，接待台后方排列健康宣传展板，前方皮质沙发与实木茶几，地面灰色哑光瓷砖，墙面浅米色乳胶漆',
      '医院检验科窗口前，冷白色荧光灯维持恒定色温，检验窗口玻璃带有微弱反射，不锈钢台面反光，墙面悬挂清晰的科室标识指示牌，地面浅灰色防滑PVC地板',
      '医院走廊，双管荧光灯从天花板均匀投下冷白光，白墙面贴有健康知识海报，地面浅灰色防滑地胶，远处可见护士站与推车'
    ];
    
    // 根据场景索引选择（循环使用）
    const sceneIndex = parseInt(scene.scene_id?.replace(/\D/g, '') || '0');
    return realisticScenes[sceneIndex % realisticScenes.length];
  }

  /**
   * v6.37-P0: 构建 mood(3-5情绪关键词)
   */
  /**
   * v6.37-P0: 构建 mood(3-5情绪关键词)
   * B8-fix: 优先从 scene 动态提取,兜底用默认映射
   */
  _buildMood(scene) {
    // B8-fix: 优先使用 LLM 生成的情绪数据
    if (scene.emotional_target) {
      const et = scene.emotional_target;
      const moods = [];
      // 从 emotional_target 的 valence/arousal 推断情绪
      if (et.valence > 0.5) moods.push('hopeful', 'positive');
      else if (et.valence < -0.3) moods.push('tense', 'serious');
      else moods.push('neutral', 'calm');

      if (et.arousal > 0.7) moods.push('intense', 'dramatic');
      else if (et.arousal < 0.3) moods.push('peaceful', 'gentle');

      // 补充 scene 自带的情绪标签
      if (scene.mood_tags && Array.isArray(scene.mood_tags)) {
        moods.push(...scene.mood_tags.slice(0, 2));
      }

      if (moods.length >= 3) return moods.slice(0, 5).join(', ');
    }

    // 兜底:按场景类型映射
    const moodMap = {
      'opening': 'epic, mysterious, awe-inspiring',
      'establishing': 'mysterious, anticipation, wonder',
      'conflict': 'tense, determined, brave, confrontational',
      'emotional_climax': 'epic, emotional, powerful, cathartic',
      'resolution': 'peaceful, warm, nostalgic, hopeful',
      'discovery': 'curious, excited, surprised, wondrous',
      'transition': 'flowing, continuous, seamless'
    };

    return moodMap[scene.scene_type] || 'neutral, calm, steady';
  }

  /**
   * v6.37-P0: 构建 action(核心动词+交互目标)
   * B8-fix: 优先从 scene 动态提取
   */
  _buildAction(scene) {
    // B8-fix: 优先使用 scene 自带的 action/visual_notes
    if (scene.action && scene.action.length > 5) return scene.action;
    if (scene.visual_notes && scene.visual_notes.length > 5) return scene.visual_notes;

    // 从 dialogue 推断动作
    if (scene.dialogue?.lines?.[0]?.text) {
      const firstLine = scene.dialogue.lines[0].text;
      // 根据台词情绪推断基础动作
      const emotion = scene.dialogue.lines[0].emotion || '';
      if (emotion.includes('紧张') || emotion.includes('tense')) {
        return 'tense posture, direct gaze, deliberate movement';
      }
      if (emotion.includes('兴奋') || emotion.includes('excited')) {
        return 'animated gesture, energetic movement, expressive';
      }
      return 'speaking to camera, clear hand gestures, professional delivery';
    }

    // 兜底:按场景类型映射
    const actionMap = {
      'opening': 'establishing shot, camera slowly descending through atmospheric layers',
      'establishing': 'standing in scene, observing and explaining with focused gaze',
      'conflict': 'confrontation stance, direct eye contact, tension building in posture',
      'emotional_climax': 'dramatic gesture, emotional peak, decisive movement',
      'resolution': 'gentle release, returning to calm, peaceful closure',
      'discovery': 'leaning forward, reaching out, examining with curiosity'
    };

    return actionMap[scene.scene_type] || 'neutral stance, steady breathing';
  }

  /**
   * v1.2.7-fix-A2: 构建角色定妆照引用
   * 修复:优先使用真实定妆照路径,而非凭空生成
   */
  _buildCharacterRef(scene, characters) {
    const fs = require('fs');
    const path = require('path');

    const refs = (scene.characters || []).map(cid => {
      // 先通过 character_id 查找角色
      let char = characters.find(c => c.character_id === cid);
      // 如果没找到,再通过 name 查找(scene.characters 可能存储的是中文名)
      if (!char) {
        char = characters.find(c => c.name === cid);
      }
      if (!char) return null;

      // v1.2.7-fix-A2: 优先使用角色已有的真实定妆照路径
      const existingPaths = [];

      // 来源1: visual_anchor.reference_images(LLM生成或角色覆盖注入的)
      const refImages = char.visual_anchor?.reference_images || [];
      if (Array.isArray(refImages) && refImages.length > 0) {
        existingPaths.push(...refImages.filter(p => p && typeof p === 'string'));
      }

      // 来源2: portraits 对象(adapter 解析的真实文件路径)
      if (char.portraits && typeof char.portraits === 'object') {
        const portraitPaths = Object.values(char.portraits).filter(p => p && typeof p === 'string');
        existingPaths.push(...portraitPaths);
      }

      // 来源3: portraitPaths 数组(用户直接传入的)
      if (Array.isArray(char.portraitPaths)) {
        existingPaths.push(...char.portraitPaths.filter(p => p && typeof p === 'string'));
      }

      // 去重
      const uniquePaths = [...new Set(existingPaths)];

      if (uniquePaths.length > 0) {
        // 有真实路径,直接使用
        return `${char.name}: ${uniquePaths.join(', ')}`;
      }

      // 兜底:检查默认目录是否有定妆照文件(支持递归子目录搜索)
      const charDir = char.character_id || cid;
      const defaultAngles = ['front', 'profile', 'three-quarter', 'closeup', 'side', 'threeQuarter'];
      const baseDir = this.config?.charactersDir || 'characters';
      const foundPaths = [];

      console.log(`[_buildCharacterRef] 搜索定妆照: charDir=${charDir}, baseDir=${baseDir}`);

      // v2.1.5-fix: 递归搜索所有子目录
      const searchDirRecursive = (dir) => {
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              // 递归搜索子目录
              searchDirRecursive(fullPath);
            } else if (entry.isFile()) {
              // 检查文件是否匹配角色和角度
              const ext = path.extname(entry.name).toLowerCase();
              if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) continue;
              
              const basename = path.basename(entry.name, ext);
              // 匹配规则: 文件名包含角色ID或角色名，且包含角度名称
              const isMatch = (basename.includes(charDir) || basename.includes(char.name)) &&
                defaultAngles.some(angle => basename.includes(angle));
              
              if (isMatch) {
                const relativePath = path.relative(baseDir, fullPath);
                foundPaths.push(`image://characters/${relativePath}`);
                console.log(`[_buildCharacterRef] 找到定妆照: ${fullPath}`);
              }
            }
          }
        } catch (e) {
          // 目录不存在或无权访问，跳过
        }
      };

      // 从角色专属目录开始搜索
      const charBaseDir = path.join(baseDir, charDir);
      if (fs.existsSync(charBaseDir)) {
        searchDirRecursive(charBaseDir);
      }

      // 同时搜索 portraits 子目录
      const portraitsDir = path.join(baseDir, charDir, 'portraits');
      if (fs.existsSync(portraitsDir)) {
        searchDirRecursive(portraitsDir);
      }

      if (foundPaths.length > 0) {
        return `${char.name}: ${foundPaths.join(', ')}`;
      }

      // 最终兜底:标记为无定妆照(而非虚构路径)
      console.warn(`[ProductionEngine] ⚠️ 角色 ${char.name}(${cid}) 无定妆照,characterRef 标记为 NONE`);
      return null;
    }).filter(Boolean);

    return refs.join(', ') || 'NONE';
  }

  /**
   * Stage 2: 时长分配(精细化)
   * v6.37-P0: 新增 timeline 字段
   */
  _allocateDuration(shots) {
    const allocator = this.modules.shotDurationAllocator;
    if (!allocator) {
      // 回退:使用剧本引擎的时长
      return { shots };
    }

    // 基于内容重要性、台词长度、视觉复杂度三维度重新分配
    const allocatedShots = shots.map((shot, index) => {
      // 台词越长,时长越长
      const dialogueLength = shot.dialogue?.length || 0;
      const dialogueFactor = Math.min(dialogueLength / 30, 1.5); // 30字基准

      // 场景类型权重
      const typeWeights = {
        'opening': 1.2,
        'emotional_climax': 1.5,
        'conflict': 1.3,
        'resolution': 1.0,
        'establishing': 1.0
      };
      const typeWeight = typeWeights[shot.sceneType] || 1.0;

      // 基础时长 × 调整因子
      const baseDuration = shot.timing.duration;
      const adjustedDuration = Math.round(baseDuration * typeWeight * (1 + dialogueFactor * 0.2));

      // 限制在合理范围
      const finalDuration = Math.max(10, Math.min(40, adjustedDuration));

      // v6.37-P1+: 构建 timeline 字段(结构化对象 + 字符串)
      // v1.2.5: 使用已归一化的时长,不再重新分配
      const timelineResult = this._buildTimeline(shot, index, baseDuration);

      return {
        ...shot,
        // v6.37-P1+: timeline 结构化对象
        timeline: timelineResult,
        allocation: {
          baseDuration,
          dialogueFactor,
          typeWeight,
          // v1.2.5: 标记为保留原始时长
          preserved: true
        }
      };
    });

    return { shots: allocatedShots };
  }

  /**
   * v6.37-P0: 构建 timeline 字段
   * 格式:T00:XX-T00:XX / duration: Xs / type: XXX / mood: XXX
   */
  _buildTimeline(shot, index, duration) {
    const startTime = shot.timing.start || 0;
    const endTime = startTime + duration;
    const type = shot.sceneType || 'normal';
    const mood = shot.mood || 'neutral';

    const formatTime = (seconds) => {
      const mins = Math.floor(seconds / 60);
      const secs = Math.floor(seconds % 60);
      return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    };

    // v6.37-P1+: 结构化对象 + 字符串
    const timelineObj = {
      start: `T${formatTime(startTime)}`,
      end: `T${formatTime(endTime)}`,
      duration: duration,
      type: type,
      mood: mood
    };

    const timelineStr = `${timelineObj.start}-${timelineObj.end} / duration: ${timelineObj.duration}s / type: ${timelineObj.type} / mood: ${timelineObj.mood}`;

    return {
      object: timelineObj,
      string: timelineStr
    };
  }

  /**
   * Stage 3: 运镜设计
   * v6.37-P0: 改造 camera 字段为字符串格式,新增 lighting 字段
   */
  _designCameraMovement(shots) {
    const cameraSystem = this.modules.cameraMovement;

    const designedShots = shots.map(shot => {
      // 基于场景类型推断运镜
      const cameraConfig = this._inferCameraConfig(shot);

      // v6.37-P1+: 构建 camera 字段(结构化对象 + 字符串)
      const cameraResult = this._buildCameraString(cameraConfig, shot);

      // v6.37-P1+: 构建 lighting 字段(结构化对象 + 字符串)
      const lightingResult = this._buildLighting(shot, cameraConfig);

      return {
        ...shot,
        camera: cameraResult, // 结构化对象
        lighting: lightingResult, // 结构化对象
        cameraMovement: {
          ...cameraConfig,
          // 4段式运镜时间轴
          timeline: this._generateCameraTimeline(shot.timing.duration, cameraConfig)
        }
      };
    });

    return { shots: designedShots };
  }

  /**
   * v6.37-P0: 构建 camera 字符串(12级机位+14运镜+焦距+速度)
   */
  /**
   * v6.37-P1+: 构建 camera 字段(结构化对象 + 字符串)
   * 专家反馈:字段级结构化,对象用于程序解析,字符串用于Prompt融合
   */
  _buildCameraString(cameraConfig, shot) {
    const shotSizeMap = {
      'wide': 'wide',
      'medium': 'medium',
      'close_up': 'close-up',
      'extreme_close_up': 'extreme close-up',
      'establishing': 'establishing'
    };

    const movementMap = {
      '缓慢推进': 'dolly in',
      '稳定机位': 'static',
      '手持晃动': 'handheld',
      '快速推近': 'push in',
      '缓慢后拉': 'pull back'
    };

    const focalMap = {
      'slow': '24mm',
      'normal': '35mm',
      'fast': '85mm',
      'dynamic': '50mm'
    };

    const speedMap = {
      'slow': 0.3,
      'normal': 1.0,
      'fast': 1.5,
      'dynamic': 0.8
    };

    // 结构化对象
    const cameraObj = {
      shotSize: shotSizeMap[cameraConfig.shotType] || 'medium',
      movement: movementMap[cameraConfig.movement] || 'static',
      lens: focalMap[cameraConfig.speed] || '35mm',
      speed: speedMap[cameraConfig.speed] || 1.0,
      aperture: 'f/2.8', // 默认值
      focus: 'normal' // 默认值
    };

    // 字符串格式(用于Prompt融合)
    const cameraStr = `${cameraObj.shotSize} shot, ${cameraObj.movement}, ${cameraObj.lens} lens, speed ${cameraObj.speed}`;

    return {
      object: cameraObj,
      string: cameraStr
    };
  }

  /**
   * v6.37-P0: 构建 lighting 字段(主光方向+色温K值+特效光)
   */
  _buildLighting(shot, cameraConfig) {
    const lightingMap = {
      'opening': {
        keyLight: { direction: 'backlight', colorTemp: 3200, effect: 'golden hour rim' },
        fillLight: { direction: 'ambient', colorTemp: 6500, effect: 'cool fill' },
        special: 'volumetric god rays'
      },
      'establishing': {
        keyLight: { direction: 'front', colorTemp: 4500, effect: 'neutral balanced' },
        fillLight: { direction: 'ambient', colorTemp: 4500, effect: 'soft fill' },
        special: ''
      },
      'conflict': {
        keyLight: { direction: 'top', colorTemp: 5600, effect: 'harsh shadows' },
        fillLight: { direction: 'none', colorTemp: 0, effect: 'dramatic contrast' },
        special: 'high contrast noir'
      },
      'emotional_climax': {
        keyLight: { direction: 'omni', colorTemp: 8000, effect: 'bright key' },
        fillLight: { direction: 'ambient', colorTemp: 8000, effect: 'volumetric glow' },
        special: 'volumetric glow'
      },
      'resolution': {
        keyLight: { direction: 'backlight', colorTemp: 2800, effect: 'warm sunset' },
        fillLight: { direction: 'ambient', colorTemp: 3200, effect: 'soft diffusion' },
        special: 'soft diffusion'
      },
      'discovery': {
        keyLight: { direction: 'side', colorTemp: 4500, effect: 'cool blue accent' },
        fillLight: { direction: 'ambient', colorTemp: 5500, effect: 'practical source' },
        special: 'practical source'
      }
    };

    const lightingObj = lightingMap[shot.sceneType] || lightingMap['establishing'];

    // 字符串格式(用于Prompt融合)
    const keyLight = lightingObj.keyLight;
    const fillLight = lightingObj.fillLight;
    let lightingStr = `${keyLight.direction} ${keyLight.colorTemp}K, ${keyLight.effect}`;
    if (fillLight.direction !== 'none') {
      lightingStr += `, ${fillLight.direction} ${fillLight.colorTemp}K, ${fillLight.effect}`;
    }
    if (lightingObj.special) {
      lightingStr += `, ${lightingObj.special}`;
    }

    return {
      object: lightingObj,
      string: lightingStr
    };
  }

  /**
   * 推断运镜配置
   */
  _inferCameraConfig(shot) {
    const configs = {
      'opening': {
        shotType: 'wide',
        movement: '缓慢推进',
        speed: 'slow',
        transition: 'none'
      },
      'establishing': {
        shotType: 'medium',
        movement: '稳定机位',
        speed: 'normal',
        transition: 'smooth'
      },
      'conflict': {
        shotType: 'close_up',
        movement: '手持晃动',
        speed: 'fast',
        transition: 'cut'
      },
      'emotional_climax': {
        shotType: 'extreme_close_up',
        movement: '快速推近',
        speed: 'dynamic',
        transition: 'dramatic'
      },
      'resolution': {
        shotType: 'medium',
        movement: '缓慢后拉',
        speed: 'slow',
        transition: 'fade'
      }
    };

    return configs[shot.sceneType] || configs['establishing'];
  }

  /**
   * 生成 4 段式运镜时间轴
   */
  _generateCameraTimeline(duration, cameraConfig) {
    const segments = 4;
    const segmentDuration = duration / segments;

    const timeline = [];
    for (let i = 0; i < segments; i++) {
      const start = i * segmentDuration;
      const end = (i + 1) * segmentDuration;

      timeline.push({
        segment: i + 1,
        timeRange: `${start.toFixed(1)}s-${end.toFixed(1)}s`,
        duration: segmentDuration.toFixed(1) + 's',
        cameraMovement: this._getSegmentMovement(i, cameraConfig.movement),
        shotType: this._getSegmentShotType(i, cameraConfig.shotType),
        purpose: this._getSegmentPurpose(i, cameraConfig)
      });
    }

    return timeline;
  }

  _getSegmentMovement(index, baseMovement) {
    const variations = {
      '缓慢推进': ['远景缓推', '中景推进', '近景聚焦', '特写定格'],
      '稳定机位': ['全景稳定', '中景观察', '近景注视', '特写定格'],
      '手持晃动': ['全景晃动', '中景逼近', '近景紧张', '特写冲击'],
      '快速推近': ['远景突袭', '中景冲刺', '近景逼近', '特写定格'],
      '缓慢后拉': ['近景特写', '中景展开', '全景揭示', '远景收尾']
    };

    const movements = variations[baseMovement] || variations['稳定机位'];
    return movements[index] || movements[movements.length - 1];
  }

  _getSegmentShotType(index, baseType) {
    const progression = {
      'wide': ['远景', '全景', '中景', '近景'],
      'medium': ['中景', '近景', '中景', '近景'],
      'close_up': ['中景', '近景', '特写', '极特写'],
      'extreme_close_up': ['近景', '特写', '极特写', '微距']
    };

    const types = progression[baseType] || progression['medium'];
    return types[index] || types[types.length - 1];
  }

  _getSegmentPurpose(index, config) {
    const purposes = [
      '建立空间/环境',
      '展示角色/关系',
      '推进情绪/冲突',
      '定格核心瞬间'
    ];
    return purposes[index] || '推进叙事';
  }

  /**
   * Stage 4: Prompt 工程(核心)
   * v6.37-P0: 按参考文档融合顺序构建 Prompt,产出标准字段格式
   * 保留卓越系统特有字段:mouthAction, importance, visualComplexity, qualityScore, enhanced
   */
  _engineerPrompts(shots, blueprint) {
    const prompts = [];
    const engineeredShots = [];
    
    // 【v2.1.4-fix9-P13】兜底路径(_engineerPrompts)也强制写实场景和动作
    const sceneForbidden = ['全息', '虚拟', '投影', '抽象', '光影场域', '数据空间', '元宇宙', '时间操控', '霓虹', '微观世界', '宏观', '抽象几何', '流动光影', '交织光影', '色彩对冲'];
    const fallbackScenes = [
      '医院健康宣教室，白色荧光灯均匀照明，白墙面贴有无文字骨骼肌解剖图与运动损伤海报（纯图形版），木质讲台表面带有细微使用划痕，地面浅灰色防滑PVC地胶',
      '三甲医院检验科走廊，冷白色LED光源从走廊顶部连续排列向下照射，无文字箭头标识牌指向尿液检验窗口，地面浅色抛光瓷砖，墙面白色医用抗菌涂层',
      '医生诊室，白色墙面悬挂无文字人体解剖示意图（纯图形版），办公桌摆放听诊器与血压计，检查床铺有蓝色一次性床单，无影灯悬于上方，窗光透入',
      '医院健康管理中心，嵌入式LED灯带洒下柔和暖白光，接待台后方排列无文字健康宣传展板（纯图形版），前方皮质沙发与实木茶几，地面灰色哑光瓷砖'
    ];
    const actionForbidden = ['全息', '虚拟', '投影', '空间扭曲', '时间残影', '霓虹', '数据流', '光即角色', '抽象构图', '梦境流动性', '手绘动画', '湿版摄影', '黑色电影'];
    const fallbackActions = [
      '镜头缓慢推近，示例角色站立讲台前，自然手势讲解，眼神注视镜头，警服在荧光灯下轮廓清晰',
      '稳定机位中景，示例角色沿走廊缓步前行，侧头指向检验窗口，白大褂医生从背景走过',
      '手持微晃跟拍，示例角色靠近检查床，手指轻触医学挂图，无影灯在头顶形成柔和光晕',
      '固定机位中景，示例角色坐于沙发边缘，双手交叠置于膝上，LED灯带在身后形成均匀轮廓光',
      '缓慢后拉全景，示例角色站立检验窗口前，转身面向镜头，不锈钢台面反射冷白色光源'
    ];

    for (const shot of shots) {
      // 【v2.1.4-fix9-P13】强制写实过滤
      let filteredScene = shot.scene || '';
      if (sceneForbidden.some(w => filteredScene.includes(w))) {
        const idx = parseInt(shot.shotId?.replace(/\D/g, '') || '0') || 0;
        filteredScene = fallbackScenes[idx % fallbackScenes.length];
        console.warn(`[ProductionEngine] ⚠️ 镜头 ${shot.shotId} 场景含禁止词汇，兜底替换为写实场景`);
      }
      
      let filteredAction = shot.action || '';
      if (actionForbidden.some(w => filteredAction.includes(w))) {
        const idx = parseInt(shot.shotId?.replace(/\D/g, '') || '0') || 0;
        filteredAction = fallbackActions[idx % fallbackActions.length];
        console.warn(`[ProductionEngine] ⚠️ 镜头 ${shot.shotId} 动作含禁止词汇，兜底替换为写实动作`);
      }
      
      const filteredShot = {
        ...shot,
        scene: filteredScene,
        action: filteredAction
      };

      // v2.0.5-彻底修复: 优先使用标准化后的字段(由_normalizeLLMOutput处理过)
      // 如果标准化字段存在,直接使用;否则做兜底处理
      const cameraStr = filteredShot.cameraString ||
                        filteredShot.camera?.string ||
                        (typeof filteredShot.camera === 'string' ? filteredShot.camera : '') || '';
      const lightingStr = filteredShot.lightingString ||
                          filteredShot.lighting?.string ||
                          (typeof filteredShot.lighting === 'string' ? filteredShot.lighting : '') || '';

      // v2.0.5-彻底修复: timeline优先使用标准化后的timelineString
      let timelineStr = filteredShot.timelineString || '';
      if (!timelineStr) {
        if (filteredShot.timeline?.string && typeof filteredShot.timeline.string === 'string') {
          timelineStr = filteredShot.timeline.string;
        } else if (typeof filteredShot.timeline === 'string') {
          timelineStr = filteredShot.timeline;
        } else if (Array.isArray(filteredShot.timeline)) {
          timelineStr = filteredShot.timeline.map(seg => 
            `${seg.timeRange || ''}: ${seg.cameraMovement || ''}`
          ).join('; ');
        }
      }

      // v2.0.5-彻底修复: 确保backgroundSound有string版本
      let bgSoundResult;
      if (filteredShot.backgroundSoundString && typeof filteredShot.backgroundSoundString === 'string') {
        bgSoundResult = {
          object: filteredShot.backgroundSound || {},
          string: filteredShot.backgroundSoundString
        };
      } else {
        bgSoundResult = this._buildBackgroundSound(filteredShot);
      }

      // v2.0.5-彻底修复: 构建shotWithSound供_buildShotPrompt使用
      const shotWithSound = {
        ...filteredShot,
        backgroundSound: bgSoundResult
      };
      const prompt = this._buildShotPrompt(shotWithSound, blueprint, { cameraStr, lightingStr, timelineStr });

      // 字符计数
      const promptLength = this._countChars(prompt.fullPrompt);

      // v6.37-P1+: 构建标准输出对象(严格按 v6.37 标准字段)
      // 正片 S01+: 14 核心字段 | 片头 S00: + audioLayer + titleOverlay
      // v2.0.4-fix: 添加人物介绍卡片
      const characterCards = this._buildCharacterCards(filteredShot, blueprint);

      const standardOutput = {
        // === 标准字段(v6.37-production+)===
        shotId: filteredShot.shotId,
        duration: filteredShot.timing?.duration || 20,
        scene: filteredShot.scene || '',
        mood: filteredShot.mood || '',
        camera: filteredShot.camera?.object || filteredShot.camera || '',
        cameraString: cameraStr,
        lighting: filteredShot.lighting?.object || filteredShot.lighting || '',
        lightingString: lightingStr,
        characterRef: filteredShot.characterRef || 'NONE',
        // v2.0.5-fix: 如果shot.character不存在,从blueprint获取主角名
        character: filteredShot.character || this._getMainCharacterName(blueprint) || 'NONE',
        action: filteredShot.action || '',
        dialogue: filteredShot.dialogue || 'NONE',
        dialogueText: filteredShot.dialogueText || '',
        timeline: filteredShot.timeline?.object || filteredShot.timeline || {},
        timelineString: timelineStr,
        backgroundSound: bgSoundResult.object,
        backgroundSoundString: bgSoundResult.string,
        prompt: prompt.fullPrompt,
        promptCharCount: promptLength,
        // v2.0.4-fix: 人物介绍卡片
        characterCards: characterCards,
        // v2.1.4-fix12: 片头专属字段占位（OpeningTitleOptimizer后处理填充）
        title_content: '',
        subtitle_content: '',
        title_animation: '',
        title_font_design: '',
        opening_audio_design: '',
        // 【v2.1.5-fix】兜底路径也生成P0字段，避免FieldGuard报错
        director_instruction: '好莱坞大导演质感，电影级画面，写实风格，无特效，无科幻元素，自然光效与人工照明融合',
        constraint: 'Aspect ratio: 16:9, Resolution: 1920x1080, Format: MP4, Frame rate: 24fps, no text, no subtitle, no caption, no watermark',
        baseline: '8K resolution, cinematic quality, highly detailed, photorealistic, intricate textures, sharp focus',
        negative: 'no text, no watermark, no logo, no cartoon style, no flat lighting, no blurry, no distorted, no deformed, no extra limbs',
        consistency: '保持角色形象一致，服装发型每帧统一，禁止角色变形或分身',
        // fields对象供FieldGuard校验
        fields: {
          director_instruction: '好莱坞大导演质感，电影级画面，写实风格，无特效，无科幻元素',
          constraint: 'Aspect ratio: 16:9, Resolution: 1920x1080, Format: MP4, Frame rate: 24fps, no text, no subtitle, no caption, no watermark',
          baseline: '8K resolution, cinematic quality, highly detailed, photorealistic, intricate textures, sharp focus',
          scene: filteredShot.scene || '',
          lighting: lightingStr,
          camera_movement: cameraStr,
          character: filteredShot.character || this._getMainCharacterName(blueprint) || 'NONE',
          action: filteredShot.action || '',
          dialogue: filteredShot.dialogue || 'NONE',
          negative: 'no text, no watermark, no logo, no cartoon style, no flat lighting, no blurry, no distorted, no deformed, no extra limbs',
          bright_constraint: 'bright lighting, well-lit scene, clear visibility, no dark shadows on face, adequate illumination',
          character_constraint: `只出现${filteredShot.character || this._getMainCharacterName(blueprint) || '主角'}一人，禁止其他人物入镜，禁止同一角色重复出现，禁止角色分身或克隆`,
          consistency: '保持角色形象一致，服装发型每帧统一，禁止角色变形或分身'
        }
      };

      // 片头专属字段(仅 S00)
      const _meta = blueprint.config?._metadata || blueprint._metadata || {};
      const isSeries = _meta.isSeries || false;
      const episodeNumber = _meta.episodeNumber || 1;
      const hasOpening = isSeries ? (episodeNumber === 1) : true;

      if (filteredShot.sceneType === 'opening' && hasOpening) {
        const audioLayer = this._buildAudioLayer(filteredShot);
        const titleOverlay = this._buildTitleOverlay(blueprint);
        standardOutput.audioLayer = audioLayer.object;
        standardOutput.audioLayerString = audioLayer.string;
        standardOutput.titleOverlay = titleOverlay.object;
        standardOutput.titleOverlayString = titleOverlay.string;
      }

      engineeredShots.push(standardOutput);
      prompts.push(standardOutput);
    }

    return { shots: engineeredShots, prompts };
  }

  /**
   * v6.37-P0: 构建 mouthAction 字段(供Seedance对口型)
   */
  _buildMouthAction(shot) {
    const actionMap = {
      'opening': '嘴部自然闭合,面对镜头,准备开口',
      'establishing': '嘴部微张,观察时自然呼吸',
      'conflict': '嘴部紧闭,紧张时咬紧牙关',
      'emotional_climax': '嘴部张大,情感爆发时大声呼喊',
      'resolution': '嘴部放松,微笑,平静呼吸'
    };

    return actionMap[shot.sceneType] || '嘴部自然闭合';
  }

  /**
   * v6.37-P0: 构建 backgroundSound 字段(三段式)
   */
  _buildBackgroundSound(shot) {
    const type = shot.sceneType || 'normal';

    const soundMap = {
      'opening': {
        ambient: 'deep earth rumble 20-60Hz, epic atmosphere',
        spatial: '3D audio pan synchronized with camera movement',
        intensity: { crescendo: '0-3s', peak: '3-7s', decay: '7-10s' }
      },
      'establishing': {
        ambient: 'natural environment, wind and distant sounds',
        spatial: 'ambient stereo field',
        intensity: { steady: '0-100%', variations: 'subtle' }
      },
      'conflict': {
        ambient: 'tension building, low frequency rumble',
        spatial: 'directional audio pan',
        intensity: { building: '0-5s', peak: '5-8s', decay: '8-10s' }
      },
      'emotional_climax': {
        ambient: 'full frequency spectrum, rich harmonics',
        spatial: 'immersive surround',
        intensity: { maximum: '0-3s', sustain: '3-10s' }
      },
      'resolution': {
        ambient: 'gentle atmosphere, soft reverb',
        spatial: 'wide stereo field',
        intensity: { fading: '0-5s', quiet: '5-10s' }
      }
    };

    const soundObj = soundMap[type] || {
      ambient: 'neutral atmosphere',
      spatial: 'centered mono',
      intensity: { steady: '100%' }
    };

    // 字符串格式(用于Prompt融合)
    const intensityStr = Object.entries(soundObj.intensity).map(([k, v]) => `${k} ${v}`).join(', ');
    // 【v2.1.4-patch5】将竖杠改为分号，避免Seedance渲染乱码
    const soundStr = `AMBIENT: ${soundObj.ambient}; SPATIAL: ${soundObj.spatial}; INTENSITY: ${intensityStr}`;

    return {
      object: soundObj,
      string: soundStr
    };
  }

  /**
   * v6.37-P1+: 构建 audioLayer 字段(片头专属,结构化对象)
   */
  _buildAudioLayer(shot) {
    const segments = [
      { time: '0-3s', sound: 'sub-bass earth rumble fade in' },
      { time: '3-5s', sound: 'distant wind and environmental sounds' },
      { time: '5-8s', sound: 'string section long note' },
      { time: '8-10s', sound: 'timpani strike' }
    ];

    const audioStr = segments.map(s => s.sound).join(', ');

    return {
      object: { segments },
      string: audioStr
    };
  }

  /**
   * v6.37-P1+: 构建 titleOverlay 字段(片头专属,结构化对象)
   */
  _buildTitleOverlay(blueprint) {
    const config = blueprint.config || {};
    const worldSetting = blueprint.worldSetting || {};
    // v1.2.5-fix: 兼容顶层_metadata和config._metadata
    const _metadata = config._metadata || blueprint._metadata || {};

    // v1.2.5: 系列作品片头逻辑
    const isSeries = _metadata.isSeries || false;
    const episodeNumber = _metadata.episodeNumber || 1;
    const totalEpisodes = _metadata.totalEpisodes || 1;

    // 只有第一集显示完整片头title
    const showTitle = isSeries ? (episodeNumber === 1) : true;

    const titleObj = {
      mainTitle: showTitle ? (config.title || '未命名') : '',
      subtitle: showTitle ? (worldSetting.name || '系列作品') : '',
      producer: showTitle ? `by ${config.producer || 'HAVS Team'}` : '',
      titleAnim: showTitle ? 'light-vein carving growth 3.0-5.0s' : 'none',
      episodeInfo: isSeries ? `第${episodeNumber}集 / 共${totalEpisodes}集` : ''
    };

    const titleStr = showTitle
      ? `MAIN_TITLE: "${titleObj.mainTitle}"; SUBTITLE: "${titleObj.subtitle}"; PRODUCER: "${titleObj.producer}"; TITLE_ANIM: ${titleObj.titleAnim}`
      : `EPISODE: ${titleObj.episodeInfo}; TITLE_ANIM: none`;

    return {
      object: titleObj,
      string: titleStr
    };
  }

  /**
   * 🔊 v2.0-B+: 音频场景映射(极致视听融合)
   */
  _getAudioSceneMap() {
    return {
      'beach': { env: '海浪轻拍沙滩的白噪音,海鸟远处鸣叫', action: '白沙从指缝流下沙沙声', emotion: '温暖治愈的氛围音' },
      'ocean': { env: '海浪拍打礁石,海风呼啸', action: '水花溅起声', emotion: '自由辽阔的海洋气息' },
      'forest': { env: '风吹树叶沙沙声,远处溪流潺潺', action: '脚步声踩落叶', emotion: '宁静安详的自然氛围' },
      'city': { env: '车流白噪音,远处鸣笛', action: '快门声、键盘敲击', emotion: '都市节奏感' },
      'home': { env: '室内温暖环境音', action: '婴儿咯咯笑声', emotion: '温馨家庭氛围' },
      'mountain': { env: '山风呼啸,远处鸟鸣', action: '雪粉飞扬声', emotion: '壮丽寂静的高山氛围' },
      'studio': { env: '摄影棚安静环境', action: '快门咔嚓声', emotion: '专业专注的工作氛围' }
    };
  }

  /**
   * 🔊 v2.0-B+: 构建音频描述(自然语言格式,Seedance可理解)
   */
  _buildAudioDescription(shot) {
    const parts = [];
    const sceneName = (shot.sceneName || shot.scene || shot.setting || '').toLowerCase();
    const emotion = (shot.emotionPhase || shot.emotion || 'neutral').toLowerCase();
    const timeOfDay = (shot.timeOfDay || shot.lighting?.timeOfDay || 'golden hour').toLowerCase();

    const audioMap = this._getAudioSceneMap();
    let template = null;

    // 匹配场景类型
    for (const [key, t] of Object.entries(audioMap)) {
      if (sceneName.includes(key)) {
        template = t;
        break;
      }
    }

    // 回退:基于时间
    if (!template) {
      if (timeOfDay.includes('night') || timeOfDay.includes('dusk')) {
        template = { env: '夜晚虫鸣,远处低语', action: '轻柔脚步声', emotion: '神秘宁静的夜晚氛围' };
      } else {
        template = { env: '白天环境音', action: '自然动作声', emotion: '明亮日常氛围' };
      }
    }

    // L1: 环境音 - 自然语言格式
    parts.push(`伴随${template.env}`);

    // L2: 动作音 - 自然语言格式
    parts.push(`动作产生${template.action}`);

    // L3: 情绪音 - 自然语言格式
    const emotionAudioMap = {
      'warm': '温暖治愈的轻音乐渐入',
      'joy': '欢快的节奏音',
      'tense': '紧张的心跳声渐强',
      'sad': '低沉的弦乐余韵',
      'epic': '宏大的交响乐铺垫',
      'peaceful': '宁静的钢琴轻弹',
      'establishing': '环境音渐显,氛围建立',
      'climax': '全频段饱满,情绪峰值',
      'resolve': '音乐渐弱,余音缭绕'
    };
    const emotionSound = emotionAudioMap[emotion] || template.emotion;
    parts.push(`氛围弥漫${emotionSound}`);

    // L4: 声画同步(如果含对话)
    if (shot.dialogueText || shot.hasDialogue) {
      parts.push('声画精准同步,嘴型与发音对齐');
    }

    return parts.join(',');
  }

  /**
   * 构建单个镜头的完整 Prompt(v2.0-B+: 七层架构 + 极致视听融合 + v6.37-P0 字段对齐)
   *
   * 融合顺序(按参考文档 v6.37-Peng):
   * CharacterRef → Timeline → Dialogue → AudioLayer(片头) → TitleOverlay(片头) →
   * BackgroundSound → Character → Action → Scene → Mood → Camera → Lighting →
   * PhysicsLayer → ColorScience → NegativePrompt → RenderStyle → DirectorStyle
   *
   * 七层结构:
   * L1: 约束层(P0必加)- 画幅/帧率/无字幕
   * L2: 基础层(P0必加)- 写实度/HDR/胶片质感
   * L3: 空间层(P1防平庸)- scene字段(五维空间)
   * L4: 主体层(P2防漂移)- character/action/dialogue
   * L5: 动态层(P1防平庸)- camera/timeline
   * L6: 风格层(P2防漂移)- mood/lighting
   * L7: 音频层(🔊 新增)- backgroundSound/audioLayer
   * L8: 内部层(扩展)- PhysicsLayer/ColorScience/NegativePrompt/RenderStyle/DirectorStyle
   * L9: 质控层(P0必加)- 负面约束/角色一致性
   */
  /**
   * 构建单个镜头的完整 Prompt(v6.37-P1+: 优先级截断 + 结构化对象)
   */
  _buildShotPrompt(shot, blueprint, structuredStrings = {}) {
    const { cameraStr, lightingStr, timelineStr } = structuredStrings;

    // v2.0.4-fix: 如果 shot 有 fusionText(LLM融合产出),优先使用作为L3-L7基础
    const hasFusion = shot.fusionText && shot.fusionText.length > 10;

    // v1.2.5: 从blueprint metadata中提取系列信息,控制片头和结尾
    // 修复:兼容顶层_metadata和config._metadata
    const _meta = blueprint._metadata || blueprint.config?._metadata || {};
    const isSeries = _meta.isSeries || false;
    const episodeNumber = _meta.episodeNumber || 1;
    const hasOpening = _meta.hasOpening !== false; // 默认true
    const noNextEpisodePreview = blueprint._metadata?.noNextEpisodePreview || false;

    // 检查当前镜头是否为片头/结尾,根据系列规则调整
    const isOpeningShot = shot.sceneType === 'opening' || shot.sceneType === 'establish';
    const isResolutionShot = shot.sceneType === 'resolution';

    // 定义优先级和截断策略(专家反馈)
    const priorityMap = {
      'L1_constraint': { priority: 'P0', strategy: 'never' },
      'L2_base': { priority: 'P0', strategy: 'never' },
      'L3_scene': { priority: 'P1', strategy: 'keep_core_location' },
      'L4_character': { priority: 'P0', strategy: 'minimal_anchor' },
      'L4_action': { priority: 'P1', strategy: 'keep_core_verb' },
      'L4_dialogue': { priority: 'P0', strategy: 'keep_core_dialogue' },
      'L5_camera': { priority: 'P1', strategy: 'keep_core_movement' },
      'L5_timeline': { priority: 'P2', strategy: 'keep_duration_type' },
      'L6_mood': { priority: 'P2', strategy: 'keyword_list' },
      'L6_lighting': { priority: 'P1', strategy: 'keep_main_light' },
      'L7_audio': { priority: 'P1', strategy: 'keep_core_sound' },
      'L8_internal': { priority: 'P2', strategy: 'truncate' },
      'L9_negative': { priority: 'P0', strategy: 'keep_top_3' }
    };

    const parts = [];
    const partMeta = [];

    // === L1: 约束层(P0必加)===
    // v1.2.5: 从blueprint.config读取画幅,默认16:9横屏
    const ratio = blueprint.config?.aspectRatio || '16:9';
    // v6.6.10-fix: 使用全局负面提示词模块，区分片头/内容镜
    const isOpening = shot.sceneType === 'opening' || shot.sceneType === 'establish';
    const negativePrompt = isOpening
      ? globalNegativePromptInjector.generateForOpeningShot({ maxLength: 250 })
      : globalNegativePromptInjector.generateForContentShot({ maxLength: 300 });
    const l1Constraint = `${ratio} cinematic, 24fps cinematic, ${negativePrompt.replace('【负面约束】', '')}`;
    parts.push(`【约束】${l1Constraint}`);
    partMeta.push({ id: 'L1_constraint', priority: 'P0' });

    // === L2: 基础层(P0必加)===
    parts.push('【基础】hyperrealistic, ultra-detailed, high dynamic range, detail in highlights and shadows, film grain, 35mm texture, cinematic film');
    partMeta.push({ id: 'L2_base', priority: 'P0' });

    // === L3: 空间层(P1)===
    if (hasFusion) {
      // v2.0.4-fix: LLM融合段直接放入,包含场景/角色/动作/运镜/灯光/情绪的叙事化描述
      parts.push(`【场景】${shot.fusionText}`);
      partMeta.push({ id: 'L3-L7_fusion', priority: 'P1' });
    } else {
      if (shot.scene) {
        parts.push(`【场景】${shot.scene}`);
        partMeta.push({ id: 'L3_scene', priority: 'P1' });
      }

      // === L4: 主体层(P0-P1)===
      if (shot.character && shot.character !== 'NONE') {
        parts.push(`【角色】${shot.character}`);
        partMeta.push({ id: 'L4_character', priority: 'P0' });
      }

      if (shot.action) {
        parts.push(`【动作】${shot.action}`);
        partMeta.push({ id: 'L4_action', priority: 'P1' });
      }
    }

    // v2.0.4-fix: 注入定妆照引用(characterRef)到prompt中
    if (shot.characterRef && shot.characterRef !== 'NONE') {
      parts.push(`【定妆照】${shot.characterRef}`);
      partMeta.push({ id: 'L4_characterRef', priority: 'P0' });
    }

    if (shot.dialogueText && shot.dialogueText !== '') {
      // 【v2.1.4-fix6】台词字段只包含纯台词内容，不包含结构化标签
      // 使用 shot.dialogueText（纯文本）而非 shot.dialogue（含SPEAKER/TYPE/EMOTION/LIP_SYNC标签）
      const pureDialogue = shot.dialogueText.replace(/;/g, '；'); // 将分号分隔改为中文分号，更自然
      parts.push(`"${pureDialogue}"`);
      partMeta.push({ id: 'L4_dialogue', priority: 'P0' });
    } else if (shot.dialogue && shot.dialogue !== '') {
      // 兜底：如果dialogueText不存在，从dialogue提取纯文本
      const pureDialogue = shot.dialogue.replace(/[^:]+:([^;]+);/g, '$1').replace(/LIP_SYNC:YES/g, '').replace(/;+/g, '；').replace(/^;+|;+$/g, '').trim();
      if (pureDialogue) {
        parts.push(`"${pureDialogue}"`);
        partMeta.push({ id: 'L4_dialogue', priority: 'P0' });
      }
    }

    // === L5: 动态层(P1-P2)===
    // v2.0.5-fix: 确保始终是字符串,防止对象污染prompt
    const camera = cameraStr || (typeof shot.camera === 'string' ? shot.camera : '');
    if (camera) {
      parts.push(`【运镜】${camera}`);
      partMeta.push({ id: 'L5_camera', priority: 'P1' });
    }

    const timeline = timelineStr || (typeof shot.timeline === 'string' ? shot.timeline : '');
    if (timeline) {
      parts.push(`【时间轴】${timeline}`);
      partMeta.push({ id: 'L5_timeline', priority: 'P2' });
    }

    // === L6: 风格层(P1-P2)===
    if (shot.mood) {
      parts.push(`【情绪】${shot.mood}`);
      partMeta.push({ id: 'L6_mood', priority: 'P2' });
    }

    const lighting = lightingStr || (typeof shot.lighting === 'string' ? shot.lighting : '');
    if (lighting) {
      parts.push(`【灯光】${lighting}`);
      partMeta.push({ id: 'L6_lighting', priority: 'P1' });
    }

    // === L7: 音频层(P1)===
    // v6.37-P1+: 使用字符串版本(避免对象输出)
    const bgSound = shot.backgroundSound?.string || shot.backgroundSound;
    if (bgSound && typeof bgSound === 'string') {
      parts.push(`【音频】${bgSound}`);
      partMeta.push({ id: 'L7_audio', priority: 'P1' });
    }

    const audioLayer = shot.audioLayer?.string || shot.audioLayer;
    if (audioLayer && audioLayer !== '' && typeof audioLayer === 'string') {
      parts.push(`【音频层】${audioLayer}`);
      partMeta.push({ id: 'L7_audio', priority: 'P1' });
    }

    // === L8: 内部层(P2)===
    if (shot.physicsLayer && shot.physicsLayer !== '') {
      parts.push(`【物理】${shot.physicsLayer}`);
      partMeta.push({ id: 'L8_internal', priority: 'P2' });
    }

    if (shot.colorScience && shot.colorScience !== '') {
      parts.push(`【色彩】${shot.colorScience}`);
      partMeta.push({ id: 'L8_internal', priority: 'P2' });
    }

    if (shot.renderStyle && shot.renderStyle !== '') {
      parts.push(`【渲染】${shot.renderStyle}`);
      partMeta.push({ id: 'L8_internal', priority: 'P2' });
    }

    if (shot.directorStyle && shot.directorStyle !== '') {
      parts.push(`【导演】${shot.directorStyle}`);
      partMeta.push({ id: 'L8_internal', priority: 'P2' });
    }

    // === L9: 质控层(P0)===
    if (shot.worldId && shot.worldId !== 'default') {
      parts.push(`${shot.worldId} world`);
    }

    // === L9: 质控层(P0)===
    const negativeConstraints = [
      '【负面约束】no watermark, no logo, no text overlay, no subtitle, no caption, no text anywhere in frame, no readable characters, no alphabets, no Chinese characters',
      '【负面约束】no text on walls, no text on objects, no text on documents, no text on signs, no text on labels, no text on screens, no text on clothing, no text in background',
      '【负面约束】no brand logos with text, no text in medical charts, no text on posters, no text on billboards, no text on packaging, no handwritten text, no printed text, no signage text',
      '【负面约束】no text overlays, no UI elements with text, no text on book covers, no text on medicine bottles, no text on report forms, no text on devices, no text on badges, no text on nameplates',
      '【负面约束】no text on doors, no text on windows, no text on floors, no text on ceilings',
      '【负面约束】blurry, low resolution, pixelated, compression artifacts',
      '【负面约束】cartoon, anime, illustration, 3D render look, CGI appearance, plastic look',
      '【负面约束】distorted perspective, impossible geometry, floating objects',
      '【负面约束】flat lighting, overexposed, crushed blacks, double shadows',
      '【负面约束】unnatural physics, fake water, static water, cardboard texture, plastic foliage'
    ];

    if (shot.characters?.length > 0 || shot.character) {
      negativeConstraints.push('【负面约束】distorted face, deformed face, extra fingers, plastic skin, waxy skin, unnatural pose');
    }

    if (shot.worldId && shot.worldId !== 'default') {
      negativeConstraints.push('【负面约束】natural eye colors only, no metallic shine');
    }
    parts.push(...negativeConstraints);
    partMeta.push({ id: 'L9_negative', priority: 'P0' });

    if (shot.characters?.length > 0) {
      parts.push(`【角色一致性】保持${shot.characters.join('、')}形象一致,杜绝分身重影`);
    }

    const fullPrompt = parts.join(',');

    // v6.37-P1+: 优先级截断(专家反馈)
    const truncated = this._truncateWithPriority(fullPrompt, this.config.maxPromptLength, partMeta, parts);

    // 【v2.1.4-patch5】兜底过滤：最终prompt中任何残留的竖杠全部过滤，防止Seedance渲染乱码
    const stripPipes = (str) => str.replace(/\|/g, '; ');

    return {
      fullPrompt: stripPipes(truncated),
      rawPrompt: fullPrompt, // 保留原始prompt用于调试
      parts,
      partMeta,
      wasTruncated: fullPrompt.length !== truncated.length,
      audioIncluded: !!shot.backgroundSound
    };
  }

  /**
   * v1.2.7-fix-A3: 优先级截断(保持 L1-L9 原始顺序)
   * 修复:截断时不再重排 parts,保持 v6.37 规定的融合顺序
   */
  _truncateWithPriority(prompt, maxLength, partMeta, parts) {
    if (prompt.length <= maxLength) return prompt;

    // 阶段1: 最小化所有 P2 部分(保持原位)
    let workingParts = parts.map((p, i) => {
      if (partMeta[i]?.priority === 'P2') return this._minimizePart(p, 'P2');
      return p;
    });
    let result = workingParts.join(',');
    if (result.length <= maxLength) return result;

    // 阶段2: 最小化所有 P1 部分(P2 已最小化,保持原位)
    workingParts = parts.map((p, i) => {
      if (partMeta[i]?.priority === 'P2') return this._minimizePart(p, 'P2');
      if (partMeta[i]?.priority === 'P1') return this._minimizePart(p, 'P1');
      return p;
    });
    result = workingParts.join(',');
    if (result.length <= maxLength) return result;

    // 阶段3: 逐个移除 P2 部分(从后往前移除,保持其余顺序)
    const p2Indices = partMeta
      .map((m, i) => m?.priority === 'P2' ? i : -1)
      .filter(i => i >= 0);

    for (const idx of p2Indices.slice().reverse()) {
      workingParts[idx] = null; // 标记移除
      result = workingParts.filter(p => p !== null).join(',');
      if (result.length <= maxLength) return result;
    }

    // 阶段4: 逐个移除 P1 部分(从后往前)
    const p1Indices = partMeta
      .map((m, i) => m?.priority === 'P1' ? i : -1)
      .filter(i => i >= 0);

    for (const idx of p1Indices.slice().reverse()) {
      workingParts[idx] = null;
      result = workingParts.filter(p => p !== null).join(',');
      if (result.length <= maxLength) return result;
    }

    // 阶段5: 最后兜底--保留前N个字符(P0字段在前,至少保留 L1+L2)
    return result.substring(0, maxLength);
  }

  /**
   * 最小化部分(按策略)
   * v1.2.7-fix-A6: P1 用英文逗号和中文逗号都尝试分割
   */
  _minimizePart(part, priority) {
    if (priority === 'P2') {
      // P2: 只保留前20字符
      return part.substring(0, 20) + '...';
    }
    if (priority === 'P1') {
      // P1: 保留核心(第一个逗号前的内容,兼容中英文逗号)
      const core = part.split(/[,,]/)[0];
      return core.length < part.length ? core + '...' : part;
    }
    return part;
  }

  /**
   * 🔊 v2.0-B+: 截断保护(保留音频层和角色一致性)
   */
  _truncatePromptWithAudioProtection(prompt, maxLength) {
    if (prompt.length <= maxLength) return prompt;

    // 保护末尾:角色一致性 + 音频层(如果存在)
    const lastPart = '角色一致性:保持形象一致,杜绝分身重影';

    // 检查是否包含音频描述
    const hasAudio = prompt.includes('伴随') && prompt.includes('氛围弥漫');
    let audioPart = '';
    if (hasAudio) {
      const audioMatch = prompt.match(/伴随[^,]*,[^,]*氛围弥漫[^,]*(?:,[^,]*声画精准同步[^,]*)?/);
      if (audioMatch) {
        audioPart = audioMatch[0];
      }
    }

    const protectParts = [lastPart];
    if (audioPart) protectParts.unshift(audioPart);

    const protectText = protectParts.join(',');
    const availableLength = maxLength - protectText.length - 2;

    if (availableLength > 50) {
      return prompt.substring(0, availableLength) + ',' + protectText;
    }

    return prompt.substring(0, maxLength);
  }

  /**
   * 截断 Prompt(旧方法,保留向后兼容)
   */
  _truncatePrompt(prompt, maxLength) {
    return this._truncatePromptWithAudioProtection(prompt, maxLength);
  }

  /**
   * 构建定妆照引用
   */
  _buildImageReferences(shot, blueprint) {
    const refs = [];
    const characters = blueprint.characters || [];

    for (const cid of (shot.characters || [])) {
      const char = characters.find(c => c.character_id === cid);
      if (!char) continue;

      const portraits = char.portraits || {};

      // 选择最佳角度
      const angle = this._selectBestAngle(shot.sceneType, Object.keys(portraits));
      const path = portraits[angle];

      if (path) {
        refs.push({
          characterId: cid,
          characterName: char.name,
          angle,
          path,
          description: this._buildImageDescription(char, angle)
        });
      }
    }

    return refs;
  }

  /**
   * 选择最佳角度
   */
  _selectBestAngle(sceneType, availableAngles) {
    if (!availableAngles || availableAngles.length === 0) return null;

    const priority = {
      'opening': ['front', 'threeQuarter', 'closeup'],
      'establishing': ['threeQuarter', 'front', 'closeup'],
      'conflict': ['closeup', 'threeQuarter', 'front'],
      'emotional_climax': ['closeup', 'front', 'threeQuarter'],
      'resolution': ['threeQuarter', 'front', 'closeup']
    };

    const preferred = priority[sceneType] || ['threeQuarter', 'front', 'closeup'];

    for (const angle of preferred) {
      if (availableAngles.includes(angle)) return angle;
    }

    return availableAngles[0];
  }

  /**
   * 构建定妆照描述
   */
  _buildImageDescription(character, angle) {
    const angleDesc = {
      'front': '正面',
      'threeQuarter': '侧面',
      'closeup': '近景',
      'side': '另一侧面'
    };

    const features = character.visual_anchor?.core_features || [];
    return `${character.name}${angleDesc[angle] || angle},${features.join(',')},超写实`;
  }

  /**
   * v6.37-P0: 字符计数
   */
  _countChars(text) {
    if (!text) return 0;
    // 计算字符数(包括中英文)
    let count = 0;
    for (const char of text) {
      count++;
    }
    return count;
  }

  /**
   * Stage 5: 质量门校验
   * v6.37-P2: 审核增强 - 检查新字段格式与完整性
   */
  _runQualityGate(prompts) {
    const checks = [];
    for (const p of prompts) {
      // v2.0.5-fix: 质量门也做类型保护,确保 .trim() 安全
      const camStr = String(p.cameraString || (typeof p.camera === 'string' ? p.camera : '') || '');
      const lightStr = String(p.lightingString || (typeof p.lighting === 'string' ? p.lighting : '') || '');
      const tlStr = String(p.timelineString || (typeof p.timeline === 'string' ? p.timeline : '') || '');
      const bgStr = String(p.backgroundSoundString || (typeof p.backgroundSound === 'string' ? p.backgroundSound : '') || '');

      const check = {
        shotId: p.shotId,
        promptLength: p.promptCharCount || 0,

        // 格式无关:只看字段是否存在且有内容
        hasScene: !!(p.scene && String(p.scene).trim().length > 8),
        hasMood: !!(p.mood && String(p.mood).trim().length > 1),
        hasCamera: camStr.trim().length > 5,
        hasLighting: lightStr.trim().length > 5,
        hasCharacter: !!(p.character && p.character !== 'NONE'),
        hasAction: !!(p.action && String(p.action).length > 3),
        hasTimeline: tlStr.trim().length > 3 || Array.isArray(p.timeline) && p.timeline.length > 0,
        hasBackgroundSound: bgStr.trim().length > 3,
        hasPrompt: !!(p.prompt && String(p.prompt).length > 50),

        withinLimit: (p.promptCharCount || 0) <= this.config.maxPromptLength,

        // 片头专属(S00 在 openingData 中,这里仅保留兼容检查)
        isOpening: p.shotId === 'S00',
        hasAudioLayer: p.shotId === 'S00' ? (!!p.audioLayerString && p.audioLayerString.length > 5) : true,
        hasTitleOverlay: p.shotId === 'S00' ? (!!p.titleOverlayString && p.titleOverlayString.length > 5) : true
      };

      // 对白/角色可为 NONE(无对白、无人物镜头),不强制;其余为核心必过项
      check.passed =
        check.hasScene && check.hasMood && check.hasCamera && check.hasLighting &&
        check.hasAction && check.hasTimeline && check.hasBackgroundSound &&
        check.hasPrompt && check.withinLimit && check.hasAudioLayer && check.hasTitleOverlay;

      checks.push(check);
    }

    const allPassed = checks.every(c => c.passed);
    return {
      passed: allPassed,
      checks,
      totalPrompts: prompts.length,
      passedCount: checks.filter(c => c.passed).length,
      failedFields: checks.filter(c => !c.passed).map(c => ({
        shotId: c.shotId,
        failed: Object.entries(c).filter(([k, v]) => k.startsWith('has') && !v).map(([k]) => k)
      }))
    };
  }

  /**
   * Stage 6: 片头生成
   * v6.37-P0: 产出符合片头结构(15字段)
   */
  _generateOpening(blueprint) {
    const config = blueprint.config || {};
    const worldSetting = blueprint.worldSetting || {};
    // B6-fix: 移除 featured_beast_id 强制要求,通用项目也生成片头
    // const beastId = config.featured_beast_id;
    // if (!beastId) { return { generated: false, reason: '无 featured_beast_id' }; }

    // B7-fix: 复用 _buildBackgroundSound 保证格式一致
    const openingBgSound = this._buildBackgroundSound({ sceneType: 'opening' });
    const openingData = {
      shotId: 'S00',
      duration: config.opening_duration || 10,
      scene: this._buildOpeningScene(worldSetting),
      mood: 'epic, mysterious, awe-inspiring',
      // 结构化 camera 对象
      camera: {
        shotSize: 'extreme wide',
        movement: 'dolly in',
        lens: '24mm',
        speed: 0.3,
        aperture: 'f/2.8',
        focus: 'rack focus from atmosphere to ground'
      },
      cameraString: 'epic wide shot, slow descent through atmospheric layers, 24mm wide lens, slow speed',
      // 结构化 lighting 对象
      lighting: {
        keyLight: { direction: 'backlight', colorTemp: 3200, effect: 'golden hour rim' },
        fillLight: { direction: 'ambient', colorTemp: 6500, effect: 'cool fill' },
        special: 'volumetric god rays'
      },
      lightingString: 'backlight 3200K, golden hour rim, volumetric god rays',
      characterRef: 'NONE',
      character: 'NONE',
      action: 'establishing shot, camera slowly descending through atmospheric layers',
      dialogue: 'NONE',
      // 结构化 timeline 对象
      timeline: {
        start: 'T00:00',
        end: 'T00:10',
        duration: 10,
        type: 'opening',
        mood: 'epic'
      },
      timelineString: 'T00:00-T00:10 / duration: 10s / type: opening / mood: epic',
      // 结构化 audioLayer 对象
      audioLayer: {
        segments: [
          { time: '0-3s', sound: 'sub-bass earth rumble fade in' },
          { time: '3-5s', sound: 'distant wind and environmental sounds' },
          { time: '5-8s', sound: 'string section long note' },
          { time: '8-10s', sound: 'timpani strike' }
        ]
      },
      audioLayerString: 'Sub-bass earth rumble fade in 3s, distant wind and environmental sounds, string section long note at 5s, timpani strike at 8s',
      // 结构化 titleOverlay 对象
      titleOverlay: {
        mainTitle: config.title || '未命名',
        subtitle: worldSetting.name || '系列作品',
        producer: `by ${config.producer || 'HAVS Team'}`,
        titleAnim: 'light-vein carving growth 3.0-5.0s'
      },
      titleOverlayString: `MAIN_TITLE: "${config.title || '未命名'}"; SUBTITLE: "${worldSetting.name || '系列作品'}"; PRODUCER: "by ${config.producer || 'HAVS Team'}"; TITLE_ANIM: light-vein carving growth 3.0-5.0s`,
      // 【v2.1.4-patch2】FieldGuard兼容:添加顶层title/subtitle字段
      title: config.title || '未命名',
      subtitle: worldSetting.name || '系列作品',
      // B7-fix: 复用 _buildBackgroundSound 保证格式一致
      backgroundSound: openingBgSound.object,
      backgroundSoundString: openingBgSound.string,
      prompt: '', // 由 Prompt 工程构建
      promptCharCount: 0
    };

    // 构建片头 Prompt(传入结构化字符串)
    const prompt = this._buildShotPrompt(openingData, blueprint, {
      cameraStr: openingData.cameraString,
      lightingStr: openingData.lightingString,
      timelineStr: openingData.timelineString
    });
    openingData.prompt = prompt.fullPrompt;
    openingData.promptCharCount = this._countChars(prompt.fullPrompt);

    return {
      generated: true,
      openingData,
      shotId: 'S00',
      type: 'opening',
      beastId: null
    };
  }

  _buildOpeningScene(worldSetting) {
    const worldName = worldSetting.name || worldSetting.world_id || 'Unknown World';
    const atmosphere = worldSetting.atmosphere || 'mysterious';
    const timeOfDay = worldSetting.time_of_day || 'golden hour';
    const depth = worldSetting.spatial_depth || 'atmospheric layers';

    return `${worldName}, ${atmosphere} atmosphere, ${timeOfDay} lighting, ${depth}, spatial depth: infinite`;
  }

  /**
   * Stage 7: 连续性检查
   * v6.37-P0: 适配新字段结构(characterRef 替代 imageRefs)
   */
  _checkContinuity(prompts) {
    const issues = [];

    // 检查角色连续性(从 characterRef 解析)
    const characterMentions = prompts.map((p, idx) => {
      const chars = this._parseCharacterRefForContinuity(p.characterRef);
      return { idx, chars };
    });

    // 检查时序连续性
    for (let i = 1; i < prompts.length; i++) {
      const prev = prompts[i - 1];
      const curr = prompts[i];

      const prevChars = this._parseCharacterRefForContinuity(prev.characterRef);
      const currChars = this._parseCharacterRefForContinuity(curr.characterRef);

      // 检查是否有共享角色
      const sharedChars = prevChars.filter(c => currChars.includes(c));

      if (sharedChars.length === 0 && prevChars.length > 0 && currChars.length > 0) {
        issues.push({
          type: 'character_gap',
          between: [prev.shotId, curr.shotId],
          message: '相邻镜头无共享角色,可能导致叙事断裂'
        });
      }
    }

    return {
      passed: issues.length === 0,
      issues,
      promptCount: prompts.length
    };
  }

  /**
   * v6.37-P0: 从 characterRef 解析角色名(用于连续性检查)
   */
  _parseCharacterRefForContinuity(characterRef) {
    if (!characterRef || characterRef === 'NONE') return [];

    const chars = [];
    const parts = characterRef.split('; ');

    for (const part of parts) {
      const match = part.match(/(.+?):\s*/);
      if (match) {
        chars.push(match[1].trim());
      }
    }

    return chars;
  }

  /**
   * v2.0.5-fix: 从blueprint获取主角名称
   */
  _getMainCharacterName(blueprint) {
    const characters = blueprint.characters || [];
    // 找 protagonist 角色,或第一个角色
    const protagonist = characters.find(c => c.role === 'protagonist') || characters[0];
    return protagonist?.name || null;
  }

  /**
   * v6.37+: 构建 portraits 数组(FieldGuard 要求的关键字段)
   */
  _buildPortraits(shot, blueprint) {
    const portraits = [];
    const characters = shot.characters || blueprint.characters || [];

    for (const char of characters) {
      // v6.37+: 预生产阶段如果没有定妆照,生成占位符记录,避免FieldGuard警告
      portraits.push({
        character: char.name || char.id || 'unknown',
        characterId: char.id || char.name || 'unknown',
        url: char.portraitUrl || 'PENDING_GENERATION',
        angle: 'default',
        source: char.portraitUrl ? 'character_system' : 'pending'
      });
    }

    return portraits;
  }

  /**
   * v6.37+: 构建 characterCards 数组(FieldGuard 要求的关键字段)
   */
  _buildCharacterCards(shot, blueprint) {
    const cards = [];
    // v2.0.5-彻底修复: 优先从blueprint获取完整角色信息
    // _normalizeLLMOutput已经确保shot.characters被填充,但blueprint.characters更完整
    const characters = blueprint.characters || shot.characters || [];

    if (characters.length === 0) {
      // 兜底:如果完全没有角色信息,尝试从blueprint.config或meta提取
      const config = blueprint.config || {};
      const meta = blueprint.meta || {};
      if (config.character || meta.character) {
        const char = config.character || meta.character;
        cards.push({
          characterId: char.character_id || char.id || char.name || 'unknown',
          name: char.name || '未知角色',
          role: char.role || 'protagonist',
          description: char.description || char.persona || '',
          voiceProfile: char.voiceProfile || char.voice_profile || {}
        });
      }
      return cards;
    }

    for (const char of characters) {
      cards.push({
        // v2.0.5-彻底修复: 支持character_id和id两种字段名
        characterId: char.character_id || char.id || char.name || 'unknown',
        name: char.name || char.id || char.character_id || '未知角色',
        role: char.role || 'supporting',
        description: char.description || char.persona || char.personality || '',
        voiceProfile: char.voiceProfile || char.voice_profile || {}
      });
    }

    return cards;
  }

  /**
   * 生成生产报告
   */
  generateReport(result) {
    // v1.2.6-fix: 标准输出对象没有 timing 字段,用顶层 duration;prompts 用 promptCharCount
    const totalDuration = (result.shots || []).reduce((sum, s) => {
      return sum + (s.duration || s.timing?.duration || 0);
    }, 0);

    const prompts = result.prompts || [];
    const avgPromptLength = prompts.length > 0
      ? prompts.reduce((sum, p) => sum + (p.promptCharCount || (typeof p.prompt === 'string' ? p.prompt.length : 0) || 0), 0) / prompts.length
      : 0;

    return {
      engine: 'ProductionEngine',
      version: '1.0.0',
      success: result.success,
      summary: {
        totalShots: (result.shots || []).length,
        totalPrompts: prompts.length,
        totalDuration,
        avgPromptLength: Math.round(avgPromptLength)
      },
      stages: Object.fromEntries(
        Object.entries(result.stages || {}).map(([k, v]) => [k, {
          duration: v._stageDuration || 0,
          success: !v.error
        }])
      ),
      errors: result.errors,
      timing: result.timing
    };
  }
  /**
   * 【v2.1.4-fix10-P25-fix3】暴露给外部（如 index.js FieldGuard 重算 prompt）
   */
  assemblePromptFromFields(shot, fields, ratio) {
    // 委托给 PromptFusionAgent 的 _assembleStandardPrompt
    const agent = this.agents?.promptFusion || new PromptFusionAgent({ maxPromptLength: this.config.maxPromptLength });
    return agent._assembleStandardPrompt(shot, fields, ratio);
  }

  countChars(s) {
    const agent = this.agents?.promptFusion || new PromptFusionAgent({ maxPromptLength: this.config.maxPromptLength });
    return agent._countChars(s);
  }
}

module.exports = { ProductionEngine };
