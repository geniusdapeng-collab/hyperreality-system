// hyperreality-system/engines/production-engine/production-engine.js
// Production Engine - 制作引擎(Layer 2)
// 深度融合:直接消费 ScriptBlueprint 输出,驱动镜头生成
// 版本:v1.0.0 | 日期:2026-06-08

const path = require('path');
const { FALLBACK_SCENES, renderFallbackAction } = require('../../config/neutral-fallbacks');

// v2.1.5-refactor: 提取工具函数
const { safeStringify } = require('./utils/safe-stringify');
const { CheckpointManager } = require('./utils/checkpoint-manager');
const { LLMOutputNormalizer } = require('./utils/llm-output-normalizer');
const { ContentBoundaryGuard } = require('./utils/content-boundary-guard');
const { RuleFallbackEngine } = require('./utils/rule-fallback');
const { QualityGate } = require('./utils/quality-gate');
const { ContinuityChecker } = require('./utils/continuity-checker');
const { ShotNormalizer } = require('./utils/shot-normalizer');
const { PromptBuilder } = require('./utils/prompt-builder');

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
  llmTimeout: 300000,        // 【v2.1.9-fix】180秒→300秒，匹配PromptFusion实际耗时
  llmMaxRetries: 2,          // 【v2.1.8-fix】恢复2次重试（时间预算增加后）
  llmModel: process.env.STORMAXE_LLM_MODEL || 'kimi-k2p6',
  fastModel: process.env.STORMAXE_LLM_FAST_MODEL || process.env.STORMAXE_LLM_MODEL || 'kimi-k2p6',
  totalDeadlineMs: parseInt(process.env.STORMAXE_TOTAL_DEADLINE_MS || '3600000'), // 【v2.1.8-fix】从环境变量读取，默认 60 分钟
  memThresholdMB: 1800,
  promptFusionConcurrency: 1, // 【v2.1.8-fix】串行模式（预算增加后更稳定）
  maxMsPerShot: 180000,      // 3分钟/镜头
  enableSegmentedExecution: true,
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
    // 【修复 P1-1】长度限制从唯一真源读取，消除 12000/3000/2000 各自为政
    const PromptLengthConfig = require('../../config/prompt-length.js');
    this.config = {
      maxPromptLength: PromptLengthConfig.HARD_MAX, // 唯一真源：3000
      targetPromptLength: PromptLengthConfig.TARGET_MAX, // 唯一真源：3000
      referenceImageCount: 2,
      outputDir: options.outputDir || process.env.OUTPUT_DIR || './output/super-mickey-output',
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

    // 【修复 P2-5】补齐 llmModel 属性，修复 Phase35/RuleFallback 的配置传递链
    this.llmModel = this.agentConfig.llmModel;

    this.modules = {};
    this.logs = [];
    this._initResourceGuard();
    this._initModules();

    // 【v2.1.10-fix 提示词融合断点】checkpoint 目录与续跑开关初始化
    // 原实现：this._checkpointDir / this._enableResume 从未被赋值（agentConfig 里
    // 传入的 checkpointDir/enableResume 无人读取），导致：
    // 1) _loadLatestCheckpoint 中 path.join(undefined, ...) 抛 TypeError，
    // 被 catch 静默吞掉后返回 null —— Phase 级断点续跑从未生效；
    // 2) _clearCheckpoints 同样抛异常被吞 —— 旧 checkpoint 残留；
    // 3) !this._enableResume 恒为 true —— 续跑在入口处就被短路。
    this._checkpointDir = this.agentConfig.checkpointDir
      || options.checkpointDir
      || path.join(process.cwd(), 'checkpoints');
    this._enableResume = this.agentConfig.enableResume !== false;
    this._checkpointManager = null;
    
    // v2.1.5-refactor: 初始化 Phase 执行器（渐进式重构）
    this._initPhases();

    // 【2026-07-17 复活】降级观测与熔断器（TOP 5 #1）
    const { DegradationObserver } = require('./agents/degradation-observer');
    this.degradationObserver = new DegradationObserver({
      softThreshold: 3,
      hardThreshold: 5,
      degradationRateThreshold: 0.5
    });

    // 【2026-07-17 复活】Agent 间数据契约校验器（TOP 5 #4）
    const { AgentContractValidator } = require('./utils/agent-contract-validator');
    this.contractValidator = new AgentContractValidator({ strict: false, autoFix: true });
  }

  /**
   * v2.1.5-refactor: 初始化 Phase 执行器
   * 通过环境变量 HYPERREALITY_USE_PHASES 控制是否启用新架构
   */
  _initPhases() {
    // v2.1.5-refactor: 默认启用新 Phase 架构
    const { Phase1SceneDesign } = require('./phases/phase-1-scene-design');
    const { Phase2VisualAudio } = require('./phases/phase-2-visual-audio');
    const { Phase3PromptFusion } = require('./phases/phase-3-prompt-fusion');
    const { Phase35FieldQuality } = require('./phases/phase-3-5-field-quality');
    
    const commonOptions = {
      agents: this.agents,
      logFn: this.log.bind(this),
      saveCheckpoint: this._saveCheckpoint.bind(this),
      canAfford: this._canAfford.bind(this),
      budgetRemaining: this._budgetRemaining.bind(this),
      checkMemory: this._checkMemory.bind(this),
      cloneShots: this._cloneShots.bind(this),
      mergeShots: this._mergeShotsByShotId.bind(this),
      // 【v2.1.10-fix 提示词融合断点】下发 checkpointManager，
      // 让 Phase3 能把它传给 PromptFusionAgent 启用镜头级子 checkpoint
      checkpointManager: this._getCheckpointManager()
    };
    
    this.phase1 = new Phase1SceneDesign(commonOptions);
    this.phase2 = new Phase2VisualAudio(commonOptions);
    this.phase3 = new Phase3PromptFusion(commonOptions);
    this.phase35 = new Phase35FieldQuality({
      ...commonOptions,
      llmModel: this.llmModel,
      globalDeadline: this._globalDeadline
    });
    
    // v2.1.5-refactor: 初始化辅助模块
    this.boundaryGuard = new ContentBoundaryGuard(this.log.bind(this));
    this.ruleFallback = new RuleFallbackEngine({
      logFn: this.log.bind(this),
      config: this.config,
      llmModel: this.llmModel
    });
    this.qualityGate = new QualityGate(this.config);
    this.continuityChecker = new ContinuityChecker();
    this.shotNormalizer = new ShotNormalizer(this.config);
    this.promptBuilder = new PromptBuilder(this.config);
    
    // 【v2.1.6-fix】系统级修复：传递 healthMonitor 给 Phase 执行器
    this.healthMonitor = null;
  }

  /**
   * 【v2.1.6-fix】系统级修复：设置 HealthMonitor 引用，供 Phase 长时间任务使用
   * @param {HealthMonitor} healthMonitor - HealthMonitor 实例
   */
  setHealthMonitor(healthMonitor) {
    console.log('[ProductionEngine] setHealthMonitor called with', healthMonitor ? 'HealthMonitor instance' : 'null');
    this.healthMonitor = healthMonitor;
    // 重新初始化 Phase 执行器，传递 healthMonitor
    const { Phase1SceneDesign } = require('./phases/phase-1-scene-design');
    const { Phase2VisualAudio } = require('./phases/phase-2-visual-audio');
    const { Phase3PromptFusion } = require('./phases/phase-3-prompt-fusion');
    const { Phase35FieldQuality } = require('./phases/phase-3-5-field-quality');
    const commonOptions = {
      agents: this.agents,
      logFn: this.log.bind(this),
      saveCheckpoint: this._saveCheckpoint.bind(this),
      canAfford: this._canAfford.bind(this),
      budgetRemaining: this._budgetRemaining.bind(this),
      checkMemory: this._checkMemory.bind(this),
      cloneShots: this._cloneShots.bind(this),
      mergeShots: this._mergeShotsByShotId.bind(this),
      healthMonitor: this.healthMonitor,
      // 【v2.1.10-fix 提示词融合断点】下发 checkpointManager（含 baseDir），
      // 供 Phase3 将其下发给 PromptFusionAgent 做镜头级子 checkpoint。
      // 原实现未接收该选项，this.checkpointManager 恒为 undefined，
      // 导致 PromptFusionAgent 的镜头级断点续跑在主链路中完全失效。
      checkpointManager: this._getCheckpointManager()
    };
    this.phase1 = new Phase1SceneDesign(commonOptions);
    this.phase2 = new Phase2VisualAudio(commonOptions);
    this.phase3 = new Phase3PromptFusion(commonOptions);
    this.phase35 = new Phase35FieldQuality({
      ...commonOptions,
      llmModel: this.llmModel,
      globalDeadline: this._globalDeadline
    });
    console.log('[ProductionEngine] Phases re-initialized with healthMonitor:', this.phase3.healthMonitor ? 'yes' : 'no');
  }

  /**
   * 【新增】运行时更新 Agent 配置
   * 修复:create() 中收到的 agentConfig 可在此应用到已实例化的引擎
   * 【P1-ARCH-05 修复】添加配置锁，防止并发更新导致状态不一致
   */
  updateAgentConfig(agentConfig = {}) {
    // 【P1-ARCH-05 修复】简单的配置锁：如果正在更新中，跳过重复更新
    if (this._configUpdating) {
      console.warn('[ProductionEngine] ⚠️ 配置更新冲突，跳过重复更新');
      return;
    }
    this._configUpdating = true;
    try {
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
    } finally {
      this._configUpdating = false;
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
   * 【新增】加载最新 checkpoint(断点续跑)
   * 返回最近完成的 Phase 及其 shots
   */
  _loadLatestCheckpoint(expectedFingerprint = null) {
    if (!this._enableResume) return null;
    try {
      const fs = require('fs');
      const phases = ['phase3.5', 'phase3', 'phase2', 'phase1', 'phase0'];
      for (const phase of phases) {
        const file = path.join(this._checkpointDir, `checkpoint-${phase}.json`);
        if (!fs.existsSync(file)) continue;
        try {
          const data = fs.readFileSync(file, 'utf8');
          const parsed = JSON.parse(data);
          // 【P1-9 修复】校验 blueprint 指纹一致性
          if (expectedFingerprint && parsed.blueprintFingerprint) {
            if (parsed.blueprintFingerprint.hash !== expectedFingerprint.hash) {
              this.log('RESUME', `⚠️ ${phase} checkpoint 指纹不匹配(旧${parsed.blueprintFingerprint.hash}→新${expectedFingerprint.hash})，丢弃`);
              try { fs.unlinkSync(file); } catch (_) {}
              continue;
            }
          }
          this.log('RESUME', `📂 发现 ${phase} checkpoint(${parsed.shots?.length || 0} 镜头,保存于 ${parsed.savedAt || 'unknown'})`);
          return parsed;
        } catch (e) {
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
   * 【修复 P0-5】同时清理 PromptFusion 镜头级子 checkpoint（checkpoint-phase3-<hash>.json）
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
      // 【修复 P0-5】清理 PromptFusion 镜头级子 checkpoint
      try {
        for (const f of fs.readdirSync(this._checkpointDir)) {
          if (/^checkpoint-phase3-[0-9a-f]{8,}\.json$/i.test(f)) {
            try { fs.unlinkSync(path.join(this._checkpointDir, f)); } catch (_) {}
          }
        }
      } catch (_) {}
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
   * 【v2.1.10-fix 提示词融合断点】CheckpointManager 惰性单例
   * 供 _saveCheckpoint 与 Phase 执行器（镜头级子 checkpoint）共用同一 baseDir
   */
  _getCheckpointManager() {
    if (!this._checkpointManager) {
      this._checkpointManager = new CheckpointManager(this._checkpointDir);
    }
    return this._checkpointManager;
  }

  /**
   * 【新增】增量保存 checkpoint（已提取到 utils/checkpoint-manager.js）
   * 保持向后兼容，内部委托给 CheckpointManager
   */
  async _saveCheckpoint(phase, shots, extra = {}) {
    const checkpointManager = this._getCheckpointManager();
    // 【P1-9 修复】自动附加 blueprint 指纹
    const enrichedExtra = {
      ...extra,
      blueprintFingerprint: this._blueprintFingerprint
    };
    const result = checkpointManager.save(phase, shots, enrichedExtra, this.log.bind(this));
    if (!result.success) {
      // 保持原有行为：保存失败不抛异常
    }
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
      // 【一致性修复】VL 是最慢 Agent（实测 258s 起），显式给足 450s，不再被 base 的 300s 覆盖
      visualLanguage: new VisualLanguageAgent({ ...base, llmModel: deepModel, llmTimeout: 450000 }),
      // 【一致性修复】PromptFusion 是最重 Agent，显式恢复 5 次重试，不再被 base 的 2 次覆盖
      promptFusion: new PromptFusionAgent({ ...base, llmModel: deepModel, llmMaxRetries: 5, maxPromptLength: this.config.maxPromptLength }),

      // 快速模型:结构化小任务(音效/片头/审查),可用非推理模型加速
      audioDesign: new AudioDesignAgent({ ...base, llmModel: fastModel, llmMaxTokens: 8000 }),
      openingDesign: new OpeningDesignAgent({ ...base, llmModel: fastModel, llmMaxTokens: 8000 }),
      continuityReview: new ContinuityReviewAgent({ ...base, llmModel: fastModel, llmMaxTokens: 8000 })
    };

    console.log(`[ProductionEngine v2.0] LLM Agents ${this.agentConfig.enableLLMAgents ? '已启用' : '已禁用'} | deep=${deepModel} fast=${fastModel}`);
  }

  _initModules() {
    // 加载核心模块(从现有系统复用)
    // 【一致性修复】注册表瘦身：只在用的模块正常加载；
    // 历史遗留模块集中登记到 legacyModules，不实例化、明确标注禁用，
    // 防止其携带的过时约定（12s/30s/旧长度标准）被误接回流程
    this.modules = {
      // 时长分配（在用）
      shotDurationAllocator: loadModule('shot-duration-allocator.js')?.ShotDurationAllocator,
    };

    this.legacyModules = {
      // ⚠️ 以下模块未接入当前流程，约定值已过时，禁止直接调用
      // durationCalculator: 未使用
      // intraShotTimeline: 未使用
      // continuityEngine: 未使用
      // camera-movement-system-v2: 已内联为 _getSegmentMovement 方法，文件已归档
      // promptEnhancer: 未使用
      // styleInjector: 未使用
      // promptQualityGate: 旧长度标准（现行见 config/prompt-length.js）
      // charCounter: 未使用
      // openingSystem: 未使用（片头由 OpeningDesignAgent 处理）
      // characterManager: 未使用（角色由 CharacterRefResolver 处理）
      // characterPromptBuilder: 未使用
      // storyboardValidator: 时长上限30s（现行15s）
      // preRenderValidation: 时长上限12s（现行15s）
      // postProduction: 未使用
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

    // 【P1-ARCH-01 修复】动态预算分配：根据剩余镜头数和阶段动态调整预算
    // 将总预算分为阶段预算池，前面节省的时间可流入后续阶段
    const HARD_BUDGET_MS = this.agentConfig.totalDeadlineMs || 1200000;
    const PHASE_BUDGET_RATIOS = {
      phase1: 0.08,   // Phase 1: 8% 总预算
      phase2: 0.15,   // Phase 2: 15% 总预算 (并行化后耗时减少)
      phase3: 0.70,   // Phase 3: 70% 总预算 (PromptFusion 最耗时，给予更多预算)
      phase3_5: 0.07  // Phase 3.5: 7% 总预算
    };
    const phaseBudgets = {};
    let accumulatedBudget = 0;
    for (const [phase, ratio] of Object.entries(PHASE_BUDGET_RATIOS)) {
      phaseBudgets[phase] = Math.floor(HARD_BUDGET_MS * ratio);
      accumulatedBudget += phaseBudgets[phase];
    }
    // 剩余预算分配给 Phase 3
    phaseBudgets.phase3 += (HARD_BUDGET_MS - accumulatedBudget);
    
    this.log('PRODUCE', `💰 动态预算分配: phase1=${phaseBudgets.phase1}ms phase2=${phaseBudgets.phase2}ms phase3=${phaseBudgets.phase3}ms phase3.5=${phaseBudgets.phase3_5}ms`);
    const SAFETY_MARGIN_MS = 60000; // 余量60s
    const globalDeadline = startTime + HARD_BUDGET_MS - SAFETY_MARGIN_MS;
    this._globalDeadline = globalDeadline;
    this._setAgentDeadline(globalDeadline);
    // 【P1-7 修复】Phase35 FieldQuality 同步下发 deadline
    if (this.phase35) {
      this.phase35.globalDeadline = globalDeadline;
      if (this.phase35.fieldQualityPipeline && typeof this.phase35.fieldQualityPipeline.setDeadline === 'function') {
        this.phase35.fieldQualityPipeline.setDeadline(globalDeadline);
      }
    }

    // 【2026-07-17 复活】DegradationObserver 熔断检查
    const proceed = this.degradationObserver.canProceed();
    if (!proceed.allowed) {
      this.log('DEGRADATION', `🚫 熔断器拦截: ${proceed.reason}`);
      return {
        success: false,
        shots: [],
        prompts: [],
        degraded: true,
        degradationReport: proceed.report,
        errors: [{ stage: 'circuit-breaker', message: proceed.reason }],
        timing: { total: Date.now() - startTime }
      };
    }

    // 【P1-9 修复】生成 blueprint 指纹，用于 checkpoint 一致性校验
    // 【修复 P3-1】使用稳定序列化（键排序）消除 JSON 键序不确定性导致的哈希漂移
    const crypto = require('crypto');
    const stableHashInput = JSON.stringify(adaptedBlueprint.scenes || [], (k, v) => {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        return Object.keys(v).sort().reduce((sorted, key) => { sorted[key] = v[key]; return sorted; }, {});
      }
      return v;
    });
    this._blueprintFingerprint = {
      sceneCount: adaptedBlueprint.scenes?.length || 0,
      shotIds: (adaptedBlueprint.scenes || []).map(s => s.scene_id).join(','),
      hash: crypto.createHash('md5').update(stableHashInput).digest('hex').slice(0, 8)
    };
    this.log('PRODUCE', `🔖 Blueprint 指纹: ${this._blueprintFingerprint.hash} (${this._blueprintFingerprint.sceneCount}场景)`);

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
      const ckpt = this._loadLatestCheckpoint(this._blueprintFingerprint);
      let startPhase = 1;
      if (ckpt) {
        currentShots = ckpt.shots;
        result.opening = ckpt.opening || null;
        result.llmStats = ckpt.llmStats || {};
        if (ckpt.phase === 'phase1') startPhase = 2;
        else if (ckpt.phase === 'phase2') startPhase = 3;
        else if (ckpt.phase === 'phase3') startPhase = 4; // 【P1-8 修复】phase3完成后应进phase3.5
        else if (ckpt.phase === 'phase3.5') {
          startPhase = 99;
          this.log('RESUME', '✅ Phase3.5 已完成,跳过 LLM 直接进 Quality Gate');
        }
        result.resumed = true;
      }

      // ----- Phase 1:SceneDesign ∥ OpeningDesign -----
      // v2.1.5-refactor: 使用新 Phase 架构
      if (startPhase <= 1) {
        const phase1Result = await this.phase1.execute({ 
          shots: currentShots, 
          result, 
          adaptedBlueprint 
        });
        // 【修复 P0-1】重构时丢失的 phase1Result.success 分支：成功时必须合并 shots
        if (phase1Result.success) {
          currentShots = phase1Result.shots || currentShots;
        } else {
          // 【修复 P2-2】phase1 失败降级记录（不再依赖 phase1Failed 布尔，直接写 result）
          result.degraded = true;
          result.errors.push({ stage: 'phase1', message: phase1Result.error || 'Phase1 失败' });
          this.log('PRODUCE', `⚠️ Phase 1 失败(${phase1Result.error})，已标记 degraded 继续`);
        }
        // 【2026-07-17 复活】Agent 间契约校验：Phase 1 → Phase 2
        const cv1 = this.contractValidator.validate('phase1-phase2', { shots: currentShots, blueprint: adaptedBlueprint });
        if (!cv1.valid) {
          this.log('CONTRACT', `⚠️ Phase1→Phase2 契约校验未通过: ${cv1.errors.join('; ')}`);
          if (cv1.fixed) this.log('CONTRACT', `🔧 自动修复 ${cv1.fixCount} 项`);
          currentShots = cv1.fixed.shots;
        }
      }

      // ----- Phase 2:VisualLanguage → AudioDesign → ContinuityReview -----
      // v2.1.5-refactor: 使用新 Phase 架构
      if (startPhase <= 2) {
        const phase2Result = await this.phase2.execute({ 
          shots: currentShots, 
          result, 
          adaptedBlueprint 
        });
        if (phase2Result.success) {
          currentShots = phase2Result.shots;
        } else {
          // 【修复 P2-2】失败必须留痕：degraded 标记 + errors 记录
          result.degraded = true;
          result.errors.push({ stage: 'phase2', message: phase2Result.error || 'Phase2 失败，使用未增强镜头继续' });
          this.log('PRODUCE', `⚠️ Phase 2 失败(${phase2Result.error})，已标记 degraded 继续`);
        }
        // 【2026-07-17 复活】Agent 间契约校验：Phase 2 → Phase 3
        const cv2 = this.contractValidator.validate('phase2-phase3', { shots: currentShots });
        if (!cv2.valid) {
          this.log('CONTRACT', `⚠️ Phase2→Phase3 契约校验未通过: ${cv2.errors.join('; ')}`);
          if (cv2.fixed) this.log('CONTRACT', `🔧 自动修复 ${cv2.fixCount} 项`);
          currentShots = cv2.fixed.shots;
        }
      }

      // ----- Phase 3:PromptFusion -----
      // v2.1.5-refactor: 使用新 Phase 架构
      if (startPhase <= 3) {
        const phase3Result = await this.phase3.execute({ 
          shots: currentShots, 
          result, 
          adaptedBlueprint 
        });
        if (phase3Result.success) {
          currentShots = phase3Result.shots;
        } else {
          // 【修复 P2-2】Phase 3 是核心环节：失败 = 整体降级交付，必须显式标记
          result.degraded = true;
          result.degradeReason = `Phase3 PromptFusion 失败: ${phase3Result.error || '未知原因'}`;
          result.errors.push({ stage: 'phase3', message: phase3Result.error || 'PromptFusion 失败' });
          this.log('PRODUCE', `🔴 Phase 3 失败(${phase3Result.error})，产出为未融合镜头，已标记 degraded`);
        }
        // 【2026-07-17 复活】Agent 间契约校验：Phase 3 → 输出
        const cv3 = this.contractValidator.validate('phase3-output', { shots: currentShots });
        if (!cv3.valid) {
          this.log('CONTRACT', `⚠️ Phase3→Output 契约校验未通过: ${cv3.errors.join('; ')}`);
          if (cv3.fixed) this.log('CONTRACT', `🔧 自动修复 ${cv3.fixCount} 项`);
          currentShots = cv3.fixed.shots;
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
      // v2.1.5-refactor: 使用新 Phase 架构
      // 【修复 P2-3】断点续跑守卫：startPhase=99 表示 phase3.5 已完成，直接跳过
      let phase35Success = startPhase > 4; // 恢复自 phase3.5 checkpoint 视为已成功
      if (startPhase <= 4) {
        try {
          const phase35Result = await this.phase35.execute({ 
            shots: currentShots, 
            result, 
            adaptedBlueprint 
          });
          if (phase35Result.success) {
            currentShots = phase35Result.shots;
            phase35Success = true;
          }
        } catch (phase35Error) {
          this.log('PHASE-3.5', `❌ Phase 3.5 异常: ${phase35Error.message}`);
        }
      } else {
        this.log('PHASE-3.5', '⏭️ 断点续跑：phase3.5 已完成，跳过');
      }

      // 【v2.1.8-审计修复】Phase 3.5 失败后使用隔离的降级逻辑，确保不抛异常到外层
      if (!phase35Success) {
        try {
          this.log('PHASE-3.5', '⚠️ 字段质量检查失败，运行 FieldGuard 兜底修复');
          const { FieldGuard } = require('../field-guard');
          const fg = new FieldGuard({ strict: false });
          // 【修复】使用 normalizeAndValidate（检查+就地修复），而非仅 check（只检查不修复）
          const nv = fg.normalizeAndValidate(currentShots, 'Phase3.5-fallback');
          currentShots = nv.shots; // 使用修复后的 shots
          if (!nv.report.passed || nv.report.summary.fixedShots > 0) {
            this.log('PHASE-3.5', `⚠️ FieldGuard 已就地修复 ${nv.report.summary.fixedShots} 个镜头，已标记降级`);
          }
        } catch (fgError) {
          this.log('PHASE-3.5', `⚠️ FieldGuard兜底也失败: ${fgError.message}，继续使用当前shots`);
          // 【关键】标记降级但不中断流程
          currentShots = currentShots.map(s => ({ ...s, degraded: true, degradeReason: 'Phase3.5 完全失败' }));
        }
      }

      // ===== 【2026-07-17 新增】运镜协调性校验（纯规则，零LLM，毫秒级，永不降级）=====
      try {
        const { CoherenceValidator } = require('../../../systems/camera-coherence');
        const coherenceReport = new CoherenceValidator().validate(currentShots);
        result.stages.cameraCoherence = coherenceReport;
        this.log('CAMERA-COHERENCE',
          `运镜协调校验: ${coherenceReport.passed ? '✅ 通过' : '⚠️ 有临界问题'} | ` +
          `节奏曲线: ${coherenceReport.rhythm.curve} | ` +
          `critical=${coherenceReport.issueCount.critical} warning=${coherenceReport.issueCount.warning} info=${coherenceReport.issueCount.info}`);

        if (!coherenceReport.passed) {
          // 临界问题不阻断流程：标记降级 + 把可执行修复建议写进镜头 metadata
          result.degraded = true;
          const criticalIssues = coherenceReport.issues.filter(i => i.severity === 'critical');
          result.errors.push({
            stage: 'camera-coherence',
            message: `${criticalIssues.length} 处运镜/转场临界问题：${criticalIssues[0]?.message || ''}`
          });
          currentShots = currentShots.map(s => {
            const id = s.shotId || s.shot_id;
            const related = coherenceReport.issues.filter(i => i.shots.includes(id));
            return related.length
              ? { ...s, _coherenceIssues: related.map(i => ({ rule: i.rule, severity: i.severity, message: i.message, hint: i.rewrite_hint })) }
              : s;
          });
        }
      } catch (ccError) {
        this.log('CAMERA-COHERENCE', `⚠️ 协调校验异常: ${ccError.message}，跳过`);
      }

      // ===== 内容边界后处理(最终防线)=====
      // v2.1.5-refactor: 使用 ContentBoundaryGuard
      try {
        currentShots = this.boundaryGuard.enforce(currentShots, adaptedBlueprint);
      } catch (bgError) {
        this.log('BOUNDARY-GUARD', `⚠️ 边界检查失败: ${bgError.message}，跳过`);
      }

      // ===== Quality Gate =====
      // v2.1.5-refactor: 使用 QualityGate 模块
      // 【接线3 修复】传入 PRD 交付标准作为验收阈值
      try {
        const prd = adaptedBlueprint?._prd || adaptedBlueprint?.meta?._prd || adaptedBlueprint?.config?._metadata?._prd || null;
        result.stages.qualityGate = await this._runStage('quality-gate', () => this.qualityGate.run(currentShots, prd));
      } catch (qgError) {
        this.log('QUALITY-GATE', `⚠️ QualityGate失败: ${qgError.message}，继续`);
        result.stages.qualityGate = { passed: false, error: qgError.message, shots: currentShots };
      }

      result.shots = currentShots;
      result.prompts = currentShots;
      result.meta = this._buildMeta(adaptedBlueprint);
      result.success = true;
      result.timing.total = Date.now() - startTime;
      this.log('PRODUCE', `✅ LLM 制作完成${result.resumed ? '(断点续跑)' : ''} | ${currentShots.length} 镜头 | ${result.timing.total}ms`);

      // 【2026-07-17 复活】最终完整性校验（pipeline-integrity-validator 轻量化）
      const integrity = this._finalIntegrityCheck(currentShots, adaptedBlueprint);
      if (!integrity.valid) {
        this.log('INTEGRITY', `⚠️ 最终完整性校验未通过: ${integrity.errors.join('; ')}`);
        result.warnings = result.warnings || [];
        result.warnings.push(...integrity.errors);
      } else {
        this.log('INTEGRITY', `✅ 最终完整性校验通过`);
      }

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
        const fallbackShots = await this.ruleFallback.engineerPromptsFallback(baseShots, adaptedBlueprint);
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

    // 【2026-07-17 复活】注入降级观测报告
    if (this.degradationObserver) {
      result.degradationReport = this.degradationObserver._generateReport();
    }

    return result;
  }

  /**
   * 【修复 P0-2】纯规则生产路径（enableLLMAgents=false 时使用）
   * 不调用任何 LLM Agent，直接用规则引擎生成 Prompt
   */
  async _produceViaRules(currentShots, adaptedBlueprint, result, startTime) {
    this.log('RULES-MODE', '🔧 LLM Agents 已禁用，使用纯规则引擎生产');
    try {
      // 1. 规则 Prompt 生成
      let shots = await this.ruleFallback.engineerPromptsFallback(currentShots, adaptedBlueprint);
      if (!Array.isArray(shots) || shots.length === 0) {
        throw new Error('规则引擎未产出任何镜头');
      }

      // 2. 展平 fields（与 LLM 路径保持同一数据规范）
      shots = shots.map(shot => {
        const flat = { ...shot };
        if (shot.fields && typeof shot.fields === 'object') {
          for (const [key, value] of Object.entries(shot.fields)) {
            if (value === undefined || value === null || value === '') continue;
            const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
            flat[key] = value;
            flat[camelKey] = value;
          }
        }
        return flat;
      });

      // 3. 内容边界 + 质量门（与 LLM 路径同一套最终防线）
      try {
        shots = this.boundaryGuard.enforce(shots, adaptedBlueprint);
      } catch (bgError) {
        this.log('BOUNDARY-GUARD', `⚠️ 边界检查失败: ${bgError.message}，跳过`);
      }
      try {
        result.stages.qualityGate = await this._runStage('quality-gate', () => this.qualityGate.run(shots));
      } catch (qgError) {
        this.log('QUALITY-GATE', `⚠️ QualityGate失败: ${qgError.message}，继续`);
        result.stages.qualityGate = { passed: false, error: qgError.message, shots };
      }

      result.shots = shots;
      result.prompts = shots;
      result.meta = this._buildMeta(adaptedBlueprint);
      result.success = true;
      result.degraded = true;
      result.degradeReason = 'LLM Agents 禁用，纯规则模式产出';
      result.timing.total = Date.now() - startTime;
      this.log('RULES-MODE', `✅ 规则生产完成 | ${shots.length} 镜头 | ${result.timing.total}ms`);
      return result;
    } catch (e) {
      this.log('RULES-MODE', `❌ 规则生产失败: ${e.message}`);
      throw e; // 交给 produce() 外层 catch → RECOVERY 兜底
    }
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


  /** 【v2.1.4】从adaptedBlueprint构造边界契约 */
  /** 【v2.1.4】从adaptedBlueprint构造边界契约 */


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
   * 【修复 P1-2】严格白名单 + 键名兼容：
   * - 传了 fields 就只合并 fields（阶段隔离不可被幻觉字段击穿）
   * - 未传 fields 才全量合并（保留旧行为的逃生门）
   * - 合并键兼容 shotId / shot_id 两种命名
   * - 被白名单拦截的字段打印日志，便于观察 LLM 是否越权输出
   */
  _mergeShotsByShotId(baseShots, updatedShots, fields) {
    const map = new Map(
      (updatedShots || [])
        .filter(s => s && (s.shotId || s.shot_id))
        .map(s => [s.shotId || s.shot_id, s])
    );
    return baseShots.map(shot => {
      const u = map.get(shot.shotId) || map.get(shot.shot_id);
      if (!u) return shot;
      const merged = this._deepCloneShot(shot);

      const strictWhitelist = fields && fields.length > 0;
      const keys = strictWhitelist ? fields : Object.keys(u);

      // 观测：严格白名单模式下，记录被拦截的越权字段（每镜头只报一次）
      if (strictWhitelist) {
        const blocked = Object.keys(u).filter(k =>
          !fields.includes(k) &&
          !['shotId', 'shot_id', 'degraded', 'degradeReason'].includes(k) &&
          u[k] !== undefined && u[k] !== null && u[k] !== ''
        );
        if (blocked.length > 0) {
          this.log('MERGE-GUARD', `🛡️ ${shot.shotId || shot.shot_id}: 拦截白名单外字段 ${blocked.join(', ')}`);
        }
      }

      for (const f of keys) {
        if (f === 'shotId' || f === 'shot_id') continue;
        const v = u[f];
        if (v === undefined || v === null || v === '') continue;
        if (typeof v === 'number' && v === 0) continue;
        merged[f] = this._deepCloneValue(v);
      }
      if (u.degraded !== undefined) merged.degraded = u.degraded;
      if (u.degradeReason !== undefined) merged.degradeReason = u.degradeReason;
      return merged;
    });
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

    let shots = Array.isArray(scenes) ? scenes.map((scene, index) => {
      // v1.2.5: 非第一集将opening类型改为establishing
      let sceneType = scene.scene_type || 'establishing';
      if (isSeriesNonFirst && sceneType === 'opening') {
        console.log(`[ProductionEngine] 非第一集,场景 ${scene.scene_id} 从 opening 降级为 establishing`);
        sceneType = 'establishing';
      }

      // 构建角色描述(v6.37-P1+: 强制极简锚点,3-5关键词)
      const characterAnchors = Array.isArray(scene.characters) ? scene.characters.map(cid => {
        return this._buildMinimalAnchor(cid, characters);
      }) : [];

      // 构建对话(v6.37-P0: 统一格式 SPEAKER|TYPE|EMOTION|TEXT|LIP_SYNC:YES)
      // 【v2.1.5-fix-C】优先使用 blocks 字段，回退到 lines
      const dialogueSource = (scene.dialogue?.blocks && Array.isArray(scene.dialogue.blocks))
        ? scene.dialogue.blocks
        : (scene.dialogue?.lines && Array.isArray(scene.dialogue.lines))
          ? scene.dialogue.lines
          : [];
      const dialogueLines = dialogueSource.map(line => {
        const speaker = line.speaker || '角色';
        const type = line.type || (line.manner ? line.manner : '独白');
        const emotion = line.emotion || '平静';
        const text = line.text || line.line || '';
        return `${speaker}|${type}|${emotion}|${text}|LIP_SYNC:YES`;
      });

      // v6.37-P0: 构建五维空间描述(scene字段)
      const sceneDescription = this._buildFiveDimensionScene(scene, worldSetting);

      // v6.37-P0: 构建 mood(3-5情绪关键词)
      let mood = this.shotNormalizer.buildMood(scene);

      // 【审计修复】消费 EmotionArc: 此前 index.js 设计的 _emotionArc 挂在 blueprint 上后全库无人读取,
      // 情绪系统对成片完全不起作用。现将弧线目标注入镜头: 弧线情绪并入 mood, 目标详情挂上镜头。
      const arcTarget = (adaptedBlueprint._emotionArc && Array.isArray(adaptedBlueprint._emotionArc.targets))
        ? adaptedBlueprint._emotionArc.targets[index] || null
        : null;
      if (arcTarget && arcTarget.emotion) {
        mood = `${arcTarget.emotion}, ${mood}`;
      }

      // v6.37-P0: 构建 action(核心动词+交互目标)
      const action = this.shotNormalizer.buildAction(scene);

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
        // 【审计修复】情绪弧线目标(供 PromptFusion/导演评审细粒度使用)
        emotionArcTarget: arcTarget,

        // v6.37-P0: 角色(极简锚点)
        // 【v2.1.4-patch5】将 | 改为逗号,避免Seedance渲染乱码
        character: characterAnchors.join(', '),
        characterRef: this.shotNormalizer.buildCharacterRef(scene, characters),

        // v6.37-P0: 动作
        action: action,

        // v6.37-P0: 对话(统一格式)
        dialogue: dialogueLines.join(' || '),

        // 【v2.1.5-fix-C】DIALOGUE_BLOCK 数组，供后续环节（VisualLanguage/AudioDesign/PromptFusion）读取
        dialogueBlocks: scene.dialogue?.blocks || [],

        // 保留原始数据(供内部使用)
        characters: scene.characters || [],
        // 【v2.1.4-patch5】将 | 改为逗号,避免Seedance渲染乱码
        characterDescs: characterAnchors.join(', '),
        dialogueText: (scene.dialogue?.lines && Array.isArray(scene.dialogue.lines))
          ? scene.dialogue.lines.map(l => l.text || l.line || '').filter(Boolean).join(';')
          : '',

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
    }) : [];

    // v1.2.5: 时长归一化--确保总时长严格等于目标时长
    // 【v2.1.10-fix 时长断层】兜底与 production-profile 唯一真源对齐(60s)，消除 120s 测试残留
    const targetDuration = adaptedBlueprint.config?.target_duration || adaptedBlueprint.meta?.target_duration || 60;
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
   * 【v2.1.6】删除硬编码场景池，完全信任剧本生成的 setting，由 LLM 自由设计写实场景
   */
  _buildFiveDimensionScene(scene, worldSetting) {
    // 完全信任剧本生成的 setting
    if (scene.setting && scene.setting.length > 10) {
      return scene.setting;
    }
    
    // 兜底：返回空字符串，由 SceneDesignAgent 的 LLM 调用根据上下文自由生成
    // 系统通过 prompt 中的写实约束（禁止科幻词汇、要求真实光源等）保证质量
    return '';
  }

  /**
   * v6.37-P0: 构建 mood(3-5情绪关键词)
   */
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


  _buildOpeningScene(worldSetting) {
    const worldName = worldSetting.name || worldSetting.world_id || 'Unknown World';
    const atmosphere = worldSetting.atmosphere || 'mysterious';
    const timeOfDay = worldSetting.time_of_day || 'golden hour';
    const depth = worldSetting.spatial_depth || 'atmospheric layers';

    return `${worldName}, ${atmosphere} atmosphere, ${timeOfDay} lighting, ${depth}, spatial depth: infinite`;
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
   * 【2026-07-17 复活】最终完整性校验（pipeline-integrity-validator 轻量化）
   * 检查 shots 结构完整性和 prompt 有效性
   */
  _finalIntegrityCheck(shots, blueprint) {
    const errors = [];
    const warnings = [];

    if (!Array.isArray(shots) || shots.length === 0) {
      errors.push('shots 为空或非数组');
      return { valid: false, errors, warnings };
    }

    for (const shot of shots) {
      const id = shot.shotId || shot.shot_id || 'unknown';
      // 检查必需字段
      if (!shot.prompt || typeof shot.prompt !== 'string' || shot.prompt.length < 50) {
        errors.push(`${id}: prompt 缺失或过短(${shot.prompt?.length || 0}字符)`);
      }
      if (!shot.duration || shot.duration <= 0) {
        warnings.push(`${id}: duration 无效(${shot.duration})`);
      }
      if (!shot.scene && !shot.fields?.scene) {
        warnings.push(`${id}: scene 描述缺失`);
      }
      // 检查 prompt 是否包含关键要素
      const p = shot.prompt || '';
      if (!p.includes('运镜') && !p.includes('camera') && !p.includes('镜头')) {
        warnings.push(`${id}: prompt 可能缺少运镜描述`);
      }
      if (!p.includes('灯光') && !p.includes('lighting') && !p.includes('光影')) {
        warnings.push(`${id}: prompt 可能缺少灯光描述`);
      }
      // 【v2.2.7-fix】台词丢失闭环检查：数据层有台词但渲染产物无【台词】字段 → 硬错误。
      // 历史事故：归一化把台词写在 shot.dialogue 顶层，组装层只读 fields.dialogue，
      // 字段整体丢失而数据层校验（shot.dialogue 非空）全部通过——校验必须覆盖渲染产物。
      const dataHasDialogue = (Array.isArray(shot.dialogueBlocks) && shot.dialogueBlocks.length > 0)
        || (typeof shot.dialogue === 'string' && shot.dialogue.trim().length > 0)
        || (typeof shot.dialogueText === 'string' && shot.dialogueText.trim().length > 0);
      if (dataHasDialogue && !p.includes('【台词】')) {
        errors.push(`${id}: 数据层存在台词但 prompt 缺失【台词】字段（组装链路回退失败）`);
      }
    }

    // 检查场景覆盖
    const blueprintScenes = blueprint.scenes?.length || 0;
    const shotScenes = new Set(shots.map(s => s.scene || s.fields?.scene).filter(Boolean)).size;
    if (blueprintScenes > 0 && shotScenes < Math.min(blueprintScenes, 2)) {
      warnings.push(`场景覆盖不足: 剧本${blueprintScenes}个场景, 镜头仅覆盖${shotScenes}个`);
    }

    return { valid: errors.length === 0, errors, warnings };
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