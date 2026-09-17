
// hyperreality-system/index.js
// SuperMickey - 超级小香宝统一入口
// 深度融合:剧本引擎 → 适配层 → 制作引擎 → 完整镜头
// 版本:v2.12.1 | 日期:2026-07-30

require('./engines/process-guard'); // 【审计修复】全局崩溃防护,必须最先加载
require('../systems/env-aliases'); // 【v2.2.8】SUPERMICKEY_* → STORMAXE_* 环境变量别名桥

const { isOpeningShot } = require('./engines/field-standardizer');

const { ScriptEngine } = require('./engines/script-engine');
const { ProductionEngine } = require('./engines/production-engine/production-engine');
const { RenderingEngine } = require('./engines/rendering-engine/rendering-engine');
const { PostProductionEngine } = require('./engines/post-production-engine/post-production-engine');
const { RequirementListBuilder } = require('./engines/script-engine/core/requirement-list-builder');
// ⭐ v2.1.8: 需求洞察引擎（替代原 RequirementListBuilder 的 LLM 解析部分）
const { RequirementDiscoveryEngine } = require('./engines/requirement-discovery-engine');
// 🐼 [PandaCineForge] Phase 3: 影视技能引擎适配器
const { PandaCineForgeAdapter } = require('./engines/panda-cineforge-adapter');
const { CreativeIntensityEngine } = require('./engines/script-engine/core/creative-intensity-engine');
const { CreativeIntensityRecommender } = require('./engines/script-engine/core/creative-intensity-engine');
const { OpeningTitleOptimizer } = require('./engines/production-engine/agents/opening-title-optimizer');
const { PortraitResolver } = require('./engines/portrait-resolver');
// ⭐ v2.8.0: 定妆照工作室（定妆照生成环节，产出固定交付项"定妆照集"）
const { PortraitStudio } = require('./engines/portrait-studio');
const { routeAndEnhance } = require('./skills/hollywood-cinematography/cinematography-skill-router');
const { FieldGuard } = require('./engines/field-guard');
const ErrorCodes = require('./config/error-codes');
const AUDIT_STANDARDS = require('./config/audit-standards');
const { StabilityShield } = require('./shields/stability-shield');

// 【修复 P3-3】引入优雅关闭工具，统一 SIGTERM/SIGINT 清理逻辑
const { gracefulShutdown } = require('./utils/graceful-shutdown');

// ⭐ v2.1.9: PRD 生成器（Step 3.5 - 产品需求文档）
const { PRDGenerator } = require('./engines/prd-generator/prd-generator');

// ===== Phase 1: 基础设施层注入 =====
const { PromptGuardian } = require('./engines/prompt-guardian');
const { RenderPipelineGuard } = require('./engines/render-pipeline-guard');
const { EventBus } = require('./infrastructure/event-bus');
const { PipelineLogger } = require('./engines/pipeline-logger');

// ===== Phase 2: 增强引擎层注入 =====
const { MicroMotionAdapter } = require('./engines/enhancers/micro-motion-adapter');
const { NarrativeRhythmAdapter } = require('./engines/enhancers/narrative-rhythm-adapter');
const { ShotQualityEnhancer } = require('./engines/enhancers/shot-quality-enhancer');
const { RequirementAlignmentGate } = require('./engines/enhancers/requirement-alignment-gate');
const { DirectorOptimizationAgent } = require('./engines/enhancers/director-optimization-agent');

// ===== Phase 3: 情绪价值全链路注入 =====
const { EmotionIntentParser } = require('./engines/emotion/emotion-intent-parser');
const { EmotionArcDesigner } = require('./engines/emotion/emotion-arc-designer');
const { EmotionShotSyntaxInjector } = require('./engines/emotion/emotion-shot-syntax');

// ===== 审计修复：新增功能模块 =====
const { CharacterCostumePrompter } = require('./engines/character-system/character-costume-prompter');
const { DurationConstraintManager } = require('./engines/duration-constraint/duration-constraint-manager');
const { BehaviorAnchorSystem } = require('./engines/behavior-system/behavior-anchor-system');

// 【v2.1.10-hotfix】密码学验证模块——AI 无法伪造确认签名
const { verifyConfirmation, verifyConfirmationDetailed } = require('../scripts/confirmation-crypto');
// 【v2.1.12-fix 多进程竞态修复】单实例锁 + 运行身份 + 确认文件生命周期
const runCoordinator = require('../scripts/run-coordinator');
const { SmartImageReferencer } = require('./engines/smart-image-referencer');
const { SceneNumberMapper } = require('./engines/scene-number-mapper');
const { IdentityPersistenceSystem } = require('./engines/identity-persistence-system');
// ⭐ v2.1.7: 创意主题生成器（全链路最开头）
const { CreativeThemeGenerator } = require('./skills/creative-theme-generator');

// ===== Phase 4: 垂直场景层注入 =====
const { CommercialModeEnhancer } = require('./engines/scenarios/commercial-mode-enhancer');
const { FPVModeEnhancer } = require('./engines/scenarios/fpv-mode-enhancer');

const fs = require('fs');
const path = require('path');

// v2.1.5-fix: 日志级别控制
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const CURRENT_LOG_LEVEL = LOG_LEVELS[LOG_LEVEL] || 1;

function log(level, ...args) {
  if (LOG_LEVELS[level] >= CURRENT_LOG_LEVEL) {
    const prefix = `[${level.toUpperCase()}]`;
    if (level === 'error') console.error(prefix, ...args);
    else if (level === 'warn') console.warn(prefix, ...args);
    else console.log(prefix, ...args);
  }
}

class HyperrealitySystem {
  constructor(options = {}) {
    // 【v2.1.6-fix】配置隔离：深拷贝配置防止多实例共享
    const { ConfigIsolator } = require('./utils/config-isolator');
    const isolatedOptions = ConfigIsolator.isolate(options);
    this.options = isolatedOptions;
    
    // ⭐ v2.2.1-fix: LLM 引擎自动接线 —— 禁止静默降级为本地规则
    this.llmEngine = this._resolveLLMEngine(isolatedOptions);

    this.requirementListBuilder = new RequirementListBuilder(isolatedOptions.requirementListBuilder);
    
    // ⭐ v2.1.8: 需求洞察引擎 - 基于上游 12 字段进行深度业务洞察
    this.requirementDiscoveryEngine = new RequirementDiscoveryEngine({
      llmEngine: this.llmEngine,
      timeoutMs: 720000,
      agentTimeoutMs: 180000
    });
    this.creativeIntensityEngine = new CreativeIntensityEngine(options.creativeIntensityEngine);
    // 【2026-07-17 修复】创意指数推荐器（历史完播率反馈闭环）
    this.creativeRecommender = new CreativeIntensityRecommender({
      dataPath: process.env.CREATIVE_FEEDBACK_PATH
        || path.join(process.cwd(), 'data', 'creative-intensity-feedback.json')
    });
    this.scriptEngine = new ScriptEngine({
      ...options.scriptEngine,
      charactersDir: options.scriptEngine?.charactersDir || path.join(__dirname, '../characters')
    });
    this.productionEngine = new ProductionEngine({
      ...options.productionEngine,
      charactersDir: options.productionEngine?.charactersDir || path.join(__dirname, '../characters')
    });
    this.renderingEngine = new RenderingEngine({
      ...options.renderingEngine,
      charactersDir: options.renderingEngine?.charactersDir || path.join(__dirname, '../characters')
    });
    this.postProductionEngine = new PostProductionEngine(options.postProductionEngine);
    this.fieldGuard = new FieldGuard({ strict: true, logPrefix: '[Hyperreality]' });

    // ⭐ v2.1.9: PRD 生成器 - Step 3.5 产品需求文档生成
    this.prdGenerator = new PRDGenerator({
      llmEngine: this.llmEngine,
      timeoutMs: 600000,
      agent2TimeoutMs: 120000,
      agent3TimeoutMs: 180000,
      budgetProfile: options.budgetProfile || null
    });

    // 🛡️ v2.1.5-shield: 三层稳定性护盾
    this.stabilityShield = new StabilityShield({
      baselineRegistryDir: options.baselineRegistryDir || path.join(__dirname, './shields/baseline-registry/templates'),
      primaryModel: options.primaryModel || 'kimi-k2p6',
      backupModel: options.backupModel || 'kimi-k2p5',
      cacheEnabled: options.cacheEnabled !== false,
      llmTimeout: options.llmTimeout || 300000
    });

    // 🐼 [PandaCineForge] Phase 3: 影视技能引擎适配器
    this.pandaAdapter = new PandaCineForgeAdapter({
      enabled: options.pandaCineForge?.enabled === true,
      autoStart: options.pandaCineForge?.autoStart !== false,
      endpoint: options.pandaCineForge?.endpoint || 'http://127.0.0.1:8765',
      timeout: options.pandaCineForge?.timeout || 5000,
    });

    // 【v2.1.6-fix】AsyncInitGuard: 防止 PandaAdapter 异步初始化竞态
    const { AsyncInitGuard } = require('./utils/async-init-guard');
    this._pandaInitGuard = new AsyncInitGuard({ initTimeout: 10000, retryAttempts: 2 });
    // 包装 recall 方法，确保初始化完成后再调用
    const originalRecall = this.pandaAdapter.recall.bind(this.pandaAdapter);
    this.pandaAdapter.recall = async (...args) => {
      await this._pandaInitGuard._waitForInit().catch(() => {}); // 未初始化时静默降级
      return originalRecall(...args);
    };
    // 触发初始化（如果 adapter 有 async init）
    if (this.pandaAdapter.init && typeof this.pandaAdapter.init === 'function') {
      this._pandaInitGuard.initialize(() => this.pandaAdapter.init());
    } else {
      this._pandaInitGuard._initialized = true; // 无初始化需求，直接标记完成
    }

    this.stabilityShield.initialize(this.productionEngine);

    // ===== Phase 1: 基础设施层初始化 =====
    // P1-1: Prompt Guardian - Prompt自动修复与防护
    this.promptGuardian = new PromptGuardian({
      strictMode: options.promptGuardian?.strictMode || false,
      enabled: options.promptGuardian?.enabled !== false
    });

    // P1-2: Render Pipeline Guard - 渲染管线强制检查
    this.pipelineGuard = new RenderPipelineGuard({
      strictMode: options.pipelineGuard?.strictMode !== false,
      enabled: options.pipelineGuard?.enabled !== false
    });

    // P1-4: EventBus - 全链路事件追踪
    this.eventBus = new EventBus({
      name: 'supermickey-bus',
      enabled: options.eventBus?.enabled !== false,
      maxEvents: options.eventBus?.maxEvents || 10000
    });

    // P1-5: Pipeline Logger - 全链路日志留档
    this.pipelineLogger = new PipelineLogger({
      outputDir: options.pipelineLogger?.outputDir || './output',
      format: options.pipelineLogger?.format || 'markdown',
      enabled: options.pipelineLogger?.enabled !== false
    });

    // ===== Phase 2: 增强引擎层初始化 =====
    // P2-1: MicroMotion Adapter - 微动作增强系统
    this.microMotionAdapter = new MicroMotionAdapter({
      enabled: options.microMotion?.enabled !== false,
      intensity: options.microMotion?.intensity || 0.5
    });

    // P2-2: Narrative Rhythm Adapter - 叙事节奏引擎
    this.narrativeRhythmAdapter = new NarrativeRhythmAdapter({
      enabled: options.narrativeRhythm?.enabled !== false,
      intensity: options.narrativeRhythm?.intensity || 0.5
    });

    // P2-3: Shot Quality Enhancer - 镜头质量增强系统
    this.shotQualityEnhancer = new ShotQualityEnhancer({
      enabled: options.shotQuality?.enabled !== false,
      intensity: options.shotQuality?.intensity || 0.7
    });

    // P2-4: Requirement Alignment Gate - 需求对齐闸机

    // 🆕 【v2.1.6-fix】Prompt 长度同步器（所有修改 prompt 的模块共用）
    const { PromptSync } = require('./utils/prompt-sync');
    this.promptSync = new PromptSync({ maxLength: 12000 });

    // 🆕 【v2.1.6-fix】台词时长计算器（已存在但未集成）
    const { DialogueTimingCalculator } = require('./utils/dialogue-timing-calculator');
    this.dialogueTimingCalc = new DialogueTimingCalculator({
      autoAdjust: true,
      adjustStrategy: 'smart'
    });
    this.requirementAlignmentGate = new RequirementAlignmentGate({
      enabled: options.requirementAlignment?.enabled !== false,
      threshold: options.requirementAlignment?.threshold || 0.7,
      strictMode: options.requirementAlignment?.strictMode || false
    });

    // P2-5: Director Optimization Agent - 导演优化 Agent
    this.directorOptimizationAgent = new DirectorOptimizationAgent({
      enabled: options.directorOptimization?.enabled !== false,
      threshold: options.directorOptimization?.threshold || 4.0,
      maxIterations: options.directorOptimization?.maxIterations || 3
    });

    // ===== Phase 3: 情绪价值全链路 =====
    // P3-1: Emotion Intent Parser - 情绪意图解析器
    this.emotionIntentParser = new EmotionIntentParser({
      enabled: options.emotion?.enabled !== false
    });

    // P3-2: Emotion Arc Designer - 情绪弧线设计器
    this.emotionArcDesigner = new EmotionArcDesigner({
      enabled: options.emotion?.enabled !== false
    });

    // P3-3: Emotion Shot Syntax Injector - 情绪镜头语法注入器
    this.emotionShotSyntaxInjector = new EmotionShotSyntaxInjector({
      enabled: options.emotion?.enabled !== false
    });

    // ===== Phase 4: 垂直场景层 =====
    // P4-1: Commercial Mode Enhancer - 商业广告模式
    this.commercialModeEnhancer = new CommercialModeEnhancer({
      enabled: options.commercialMode?.enabled === true, // 严格默认关闭,必须显式启用
      platform: options.commercialMode?.platform || 'douyin',
      brandConfig: options.commercialMode?.brandConfig || null
    });

    // P4-2: FPV Mode Enhancer - 极限运动/FPV 模式
    this.fpvModeEnhancer = new FPVModeEnhancer({
      enabled: options.fpvMode?.enabled === true, // 严格默认关闭,必须显式启用
      sportType: options.fpvMode?.sportType || 'auto'
    });

    // ===== 审计修复：初始化6个功能增强模块 =====
    this.characterCostumePrompter = new CharacterCostumePrompter({
      strictMode: options.characterCostume?.strictMode !== false,
      enabled: options.characterCostume?.enabled !== false
    });

    this.durationConstraintManager = new DurationConstraintManager({
      maxSingleShot: options.durationConstraint?.maxSingleShot || 15,
      // 【v2.2.5-审计修复】下限 5→3，与"单镜 3-12 秒"全链路规范对齐
      minSingleShot: options.durationConstraint?.minSingleShot || 3,
      enabled: options.durationConstraint?.enabled !== false
    });

    this.behaviorAnchorSystem = new BehaviorAnchorSystem({
      enabled: options.behaviorAnchor?.enabled !== false
    });

    this.smartImageReferencer = new SmartImageReferencer({
      enabled: options.smartImageRef?.enabled !== false
    });

    this.sceneNumberMapper = new SceneNumberMapper({
      enabled: options.sceneNumberMapper?.enabled !== false
    });

    this.identityPersistenceSystem = new IdentityPersistenceSystem({
      enabled: options.identityPersistence?.enabled !== false
    });

    // ⭐ v2.1.7: 创意主题生成器（全链路最开头）
    this.creativeThemeGenerator = new CreativeThemeGenerator({
      eventBus: this.eventBus,
      llmEngine: this.llmEngine
    });

    this.version = '2.0.0';
    this._shutdownRequested = false; // 【v2.1.6-fix】优雅关闭标志
    this._confirmationAbortController = null; // 【v2.1.6-fix】确认轮询中断控制器

    // 【审计修复】进程信号处理，优雅关闭
    this._setupSignalHandlers();
  }

  _setupSignalHandlers() {
    this._shuttingDown = false; // 【修复 P3-3】防重入 guard

    // 【v2.2.5-审计修复】信号处理器进程级单例化：
    // 旧实现每 new 一个实例就 process.on 注册 5 个监听且从不摘除，
    // 多实例场景（集成测试、长驻服务反复实例化）会导致
    // ① 同一信号被多个实例重复处理（实测 SIGTERM 触发两次 shutdown）
    // ② 监听器累积超 10 个触发 MaxListenersExceededWarning
    // 现改为：进程级注册一次，所有存活实例进入注册表，信号到来时逐个关闭一次。
    const registry = HyperrealitySystem._instanceRegistry
      || (HyperrealitySystem._instanceRegistry = new Set());
    registry.add(this);

    if (HyperrealitySystem._signalHandlersInstalled) return;
    HyperrealitySystem._signalHandlersInstalled = true;

    const shutdownAll = (signal) => {
      const instances = [...registry];
      if (instances.length === 0) return;
      console.log(`\n[HyperrealitySystem] 收到 ${signal}，启动 gracefulShutdown（${instances.length} 个实例）...`);
      for (const inst of instances) {
        // 实例级防重入 guard：每实例只关闭一次
        if (inst._shuttingDown) continue;
        inst._shuttingDown = true;
        inst._shutdownRequested = true;
        // fire-and-forget：gracefulShutdown 自带 timeout guard 和 process.exit
        gracefulShutdown({
          healthMonitor: inst.productionEngine?.healthMonitor || null,
          agents: [inst.productionEngine, inst.scriptEngine, inst.renderingEngine].filter(Boolean),
          timeoutMs: 15000
        }).catch(() => process.exit(0));
      }
    };

    const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'];
    for (const signal of signals) {
      process.on(signal, () => shutdownAll(signal));
    }

    // 未捕获异常处理（保留原有行为，但同样标记 shutdown 防止竞态）
    process.on('uncaughtException', (err) => {
      console.error('[HyperrealitySystem] 未捕获异常:', err.message);
      console.error(err.stack);

      for (const inst of registry) {
        if (inst.eventBus) {
          inst.eventBus.emit('system.fatal', { error: err.message, stack: err.stack });
        }
      }

      setTimeout(() => process.exit(1), 1000);
    });

    process.on('unhandledRejection', (reason, promise) => {
      console.error('[HyperrealitySystem] 未处理 rejection:', reason);

      for (const inst of registry) {
        if (inst.eventBus) {
          inst.eventBus.emit('system.unhandledRejection', { reason: String(reason) });
        }
      }
    });
  }

  /**
   * 主创作流程(需求确认 → 提示词审核 → 渲染 → 后期制作)
   * @param {string} intent - 用户意图
   * @param {object} metadata - 元数据
   * @param {object} options - { skipPromptReview, skipRender, skipPostProduction }
   * 注意:需求清单确认不可跳过!已移除 skipRequirementConfirmation 选项。
   * @returns {object} 完整创作结果
   */
  async create(intent, metadata = {}, options = {}) {
    // 【v2.1.6-fix-bug39】metadata 深拷贝隔离，防止模块间状态污染
    const { deepClone } = require('./utils/safe-clone');
    metadata = deepClone(metadata);

    // 【v2.1.12-fix 多进程竞态修复】单实例锁 + 运行身份登记
    // 任何入口（run-preproduction-*.js / app/commands/preproduction.js / 直调 create）
    // 都必须先获得锁，杜绝"多进程并发跑预生产、互相清理输出、竞争消费确认文件"
    if (this._activeRun) {
      const reentrantMsg = `本实例已有运行中的预生产任务 (run_id=${this._activeRun})，禁止并发 create()`;
      console.error(`   ⛔ ${reentrantMsg}`);
      return {
        success: false,
        lockConflict: true,
        stages: { preproductionLock: { status: 'reentrant-blocked', run_id: this._activeRun } },
        errors: [{ stage: 'preproductionLock', message: reentrantMsg }],
        confirmations: {},
        totalWaitTimeMs: 0
      };
    }
    let lockResult = { acquired: true, skipped: true };
    if (process.env.STORMAXE_SKIP_LOCK === '1') {
      console.warn('   ⚠️ STORMAXE_SKIP_LOCK=1，跳过单实例锁（仅限测试用途）');
    } else {
      lockResult = runCoordinator.acquireLock(
        { title: metadata.title, intent: String(intent).substring(0, 120), source: 'HyperrealitySystem.create' },
        { force: process.env.STORMAXE_FORCE_RUN === '1' }
      );
    }
    if (!lockResult.acquired) {
      const h = lockResult.holder || {};
      const lockMsg = `已有预生产流程在运行: PID=${h.pid} | 主题=${h.title || '?'} | 启动于=${h.started_at || '?'}，禁止重复启动`;
      console.error('');
      console.error('⛔ '.repeat(20));
      console.error(`   ${lockMsg}`);
      console.error('   处理建议:');
      console.error(`     1. 等待该流程完成（或人工确认后 kill ${h.pid}）`);
      console.error('     2. 确认其为僵尸进程后重试（失效锁会被自动接管）');
      console.error('     3. 确需强制接管: STORMAXE_FORCE_RUN=1（危险，慎用）');
      console.error('⛔ '.repeat(20));
      return {
        success: false,
        lockConflict: true,
        stages: { preproductionLock: { status: 'locked', holder: h } },
        errors: [{ stage: 'preproductionLock', message: lockMsg }],
        confirmations: {},
        totalWaitTimeMs: 0
      };
    }
    if (lockResult.tookOverStale) {
      console.log(`   ♻️ 已接管失效锁（原持有者 PID=${lockResult.previousHolder?.pid} 已退出）`);
    }
    if (lockResult.forcedOverLiveHolder) {
      console.warn(`   ⚠️ STORMAXE_FORCE_RUN=1 强制接管锁！原持有者 PID=${lockResult.previousHolder?.pid} 仍存活，请确认这是你有意为之`);
    }
    // 登记本次运行身份：run_id 将绑定到本运行产生的所有确认文件
    this._runId = runCoordinator.startRun({ title: metadata.title });
    this._activeRun = this._runId;
    console.log(`   🔒 单实例锁已持有 (PID=${process.pid}) | 运行编号: ${this._runId}`);

    console.log(`\n🔥 [HyperrealitySystem v${this.version}] 开始创作`);
    console.log(`   意图: ${intent}`);
    console.log(`   项目: ${metadata.title || '未命名'}`);
    console.log(`   流程: 创意主题 → 需求确认 → ${options.skipPromptReview ? '跳过' : '含'}提示词审核 → ${options.skipRender ? '跳过' : '含'}渲染 → ${options.skipPostProduction ? '跳过' : '含'}后期`);
    console.log('');

    const result = {
      success: false,
      stages: {},
      errors: [],
      timing: {},
      confirmations: {}, // 记录确认状态
      deliverables: {}, // 【v2.8.0】固定交付项挂载点（定妆照集等）
      totalWaitTimeMs: 0 // 【v2.1.10-hotfix】累计等待确认时间，不计入有效时间
    };

    const totalStart = Date.now();

    // 【P0-4 修复】productionResult 声明提升到 try 块之前,避免块级作用域导致 finally 后死代码
    let productionResult = null;

    try {
      // v2.1.7: 系统级修复:整个创作过程启用长时间任务模式,避免HealthMonitor误判
      // 【v2.1.8-fix】60 分钟（3600000ms），支持环境变量覆盖
      const totalDeadlineMs = parseInt(process.env.STORMAXE_TOTAL_DEADLINE_MS || '3600000');
      this.stabilityShield.setLongTaskMode('ProductionEngine', true, totalDeadlineMs);

      // 【审计修复·全局预算协调】此前 totalDeadlineMs 只约束 ProductionEngine 内部预算和健康监控阈值，
      // 前置层(需求/PRD/剧本)与渲染/后期层各自为政，整体任务耗时可远超预期总时长。
      // 现建立全局截止时间，在各层入口按"剩余预算"动态调度。
      // 【v2.1.16-fix 预算吞等待时间】改为 let：人工确认等待时间将补偿到全局截止时间
      let globalDeadline = totalStart + totalDeadlineMs;
      this._globalDeadline = globalDeadline;
      console.log(` ⏱️ 全局任务预算: ${Math.round(totalDeadlineMs/60000)} 分钟 | 截止: ${new Date(globalDeadline).toISOString()}`);

      // 【v2.1.16-fix 预算吞等待时间】确认等待补偿器：
      // 用户思考确认的时间(可能10-30分钟)原本直接吃掉全局截止(墙钟)，
      // 导致到达制作层时预算归零→切换纯规则模式。现每次确认返回后把等待时长
      // 补偿到 globalDeadline，与"等待时间不计入流程有效时间"的设计对齐
      const _extendDeadlineForWait = (waitTimeMs, stepName) => {
        if (!waitTimeMs || waitTimeMs <= 0) return;
        globalDeadline += waitTimeMs;
        this._globalDeadline = globalDeadline;
        console.log(`   ⏱️ [${stepName}] 确认等待 ${Math.round(waitTimeMs/60000)} 分钟已补偿到全局截止时间（新截止: ${new Date(globalDeadline).toISOString()}）`);
      };

      // ========== 🧵 Layer -2: 数据挖掘引擎（珍妮纺织机）==========
      // 情报层：营销/商品模式在主题生成之前产出《商品情报档案》。
      // 纪律：可选增强、永不阻断主流程——任何异常捕获后降级继续；
      //      档案命中即复用，未命中产出采集任务书（spec）或直接装配（有回填数据时）。
      try {
        const dmInput = metadata.dataMining
          || (metadata.brief && typeof metadata.brief === 'object' && metadata.brief.product
              ? { name: metadata.brief.product, brand: metadata.brief.brand?.name, category: metadata.brief.category }
              : null);
        if (dmInput && dmInput.name) {
          const stageNeg2Start = Date.now();
          console.log('🧵 [Layer -2] 珍妮纺织机·数据挖掘 - 商品情报档案...');
          const { JennyLoomEngine } = require('./engines/data-mining-engine');
          const dmEngine = new JennyLoomEngine({
            mode: options.dataMiningMode || process.env.SUPERMICKEY_DATA_MINING_MODE || 'spec',
            executor: options.dataMiningExecutor
          });
          const dmProductId = JennyLoomEngine.deriveProductId(dmInput);

          let dmResult = null;
          if (options.dataMiningRaw) {
            // 执行方已完成检索回填：直接装配
            dmResult = dmEngine.assemble(dmEngine.plan(dmInput).trace_id, dmInput, options.dataMiningRaw);
          } else if (dmEngine.reusable(dmProductId, Boolean(options.dataMiningRefresh))) {
            // 档案命中且未过期：零耗时复用
            dmResult = { ok: true, reused: true, ...dmEngine.consume(dmInput) };
          } else if ((options.dataMiningMode || process.env.SUPERMICKEY_DATA_MINING_MODE) === 'api' && options.dataMiningExecutor) {
            dmResult = await dmEngine.run(dmInput);
          } else {
            // spec 模式：产出采集任务书，由执行 Agent 就地检索后回填再装配
            const planOut = dmEngine.plan(dmInput);
            dmResult = { ok: true, spec_tasks: planOut, note: '商品情报采集任务书已生成，执行方检索回填后调用 assemble 完成装订' };
          }

          result.stages.dataMining = { data: dmResult, timing: Date.now() - stageNeg2Start, product_id: dmProductId };

          // 档案就绪 → 【人工确认闸】确认后才允许注入下游（与创意主题确认同级）
          if (dmResult && dmResult.cards) {
            const { generateDossierConfirmationSheet } = require('./engines/data-mining-engine/contracts/confirmation-sheet');
            const sheet = generateDossierConfirmationSheet(dmResult.dossier, dmResult.cards, {
              reused: Boolean(dmResult.reused), stale: Boolean(dmResult.stale)
            });
            console.log(sheet);

            let dmApproved = true;
            let dmRejectReason = null;
            if (!(options.batchMode || options.skipDataMiningReview)) {
              console.log('\n🧵 [商品情报档案] 等待人工确认...');
              const dmConfirmation = await this._waitForExternalConfirmation('data-mining-dossier', sheet);
              result.confirmations.dataMining = dmConfirmation;
              if (dmConfirmation.waitTimeMs) {
                result.totalWaitTimeMs += dmConfirmation.waitTimeMs;
                _extendDeadlineForWait(dmConfirmation.waitTimeMs, '商品情报档案');
              }
              dmApproved = dmConfirmation.approved;
              dmRejectReason = dmConfirmation.reason || null;
            } else {
              result.confirmations.dataMining = { approved: true, batchMode: true };
            }

            if (dmApproved) {
              // 确认通过：摘要卡注入 metadata，Brief 自动回填
              metadata._dataDossier = { product_id: dmProductId, cards: dmResult.cards, stale: Boolean(dmResult.stale) };
              if (metadata.brief && typeof metadata.brief === 'object' && dmResult.cards.brief_card) {
                try {
                  const { MarketingBriefParser } = require('./skills/marketing-brief');
                  const parser = new MarketingBriefParser();
                  const enriched = parser.applyBriefCard(metadata.brief, dmResult.cards.brief_card);
                  if (enriched.filled.length > 0) {
                    metadata.brief = enriched.raw;
                    console.log(`   📥 Brief 已由情报档案自动回填: ${enriched.filled.join(' / ')}`);
                  }
                } catch (e) {
                  console.warn(`   ⚠️ Brief 情报回填失败（不阻断）: ${e.message}`);
                }
              }
              result.stages.dataMining.status = 'confirmed';
              console.log(`   ✅ 商品情报档案已确认 (${result.stages.dataMining.timing}ms)${dmResult.reused ? ' [复用]' : ''} | 摘要卡已注入下游`);
            } else {
              // 驳回：情报层整体退出，主流程继续（无档案运行）
              result.stages.dataMining.status = 'rejected';
              result.stages.dataMining.reason = dmRejectReason || '用户未确认商品情报档案';
              console.log(`   ⏭️ 情报档案被驳回（${result.stages.dataMining.reason}），主流程无情报继续`);
            }
          } else if (dmResult && dmResult.spec_tasks) {
            console.log(`   📋 情报采集任务书已生成 (${result.stages.dataMining.timing}ms)，等待执行回填`);
          }
        }
      } catch (dmErr) {
        console.warn(`   ⚠️ 珍妮纺织机异常（不阻断主流程）: ${dmErr.message}`);
        result.errors.push({ stage: 'DataMiningEngine', message: dmErr.message });
      }

      // ========== 🆕 Layer -1: 创意主题生成与确认 ==========
      // 【v2.1.8-强制流程】Step 2: 创意主题生成 + 人工确认（不可跳过）
      console.log('🎨 [Layer -1] 创意主题生成 - 解析用户意图...');
      const stageNeg1Start = Date.now();

      try {
        const themeResult = await this.creativeThemeGenerator.generate(intent);
        
        result.stages.creativeTheme = {
          data: themeResult,
          timing: Date.now() - stageNeg1Start
        };

        console.log(`   ✅ 创意主题生成完成 (${result.stages.creativeTheme.timing}ms)`);
        console.log(`      类型: ${themeResult.tasks[0].type} | 主题: ${themeResult.tasks[0].theme}`);
        console.log(`      时长: ${themeResult.tasks[0].duration_sec}秒 | 难度: ${themeResult.tasks[0].difficulty}`);

        // 生成确认摘要
        const summary = this.creativeThemeGenerator.generateConfirmationSummary(themeResult);
        console.log(summary);

        // 【强制】等待用户确认
        const themeConfirmation = await this._confirmCreativeTheme(themeResult);
        result.confirmations.creativeTheme = themeConfirmation;
        
        // 【v2.1.10-hotfix】累加等待时间
        if (themeConfirmation.waitTimeMs) {
          result.totalWaitTimeMs += themeConfirmation.waitTimeMs;
          _extendDeadlineForWait(themeConfirmation.waitTimeMs, '创意主题');
        }

        if (!themeConfirmation.approved) {
          console.log('   ❌ 创意主题未确认,流程中止');
          result.success = false;
          result.stages.creativeTheme.status = 'rejected';
          result.stages.creativeTheme.reason = themeConfirmation.reason || '用户未确认创意主题';
          return result;
        }

        console.log('   ✅ 创意主题已确认,继续创作');

        // 将创意主题注入到 metadata 中，供后续链路使用
        metadata._creativeTheme = themeResult.tasks[0];
        // 【方案A-fix】原始故事文本直通：从 themeResult 传递到 metadata
        if (themeResult._originalStoryText) {
          metadata._originalStoryText = themeResult._originalStoryText;
          metadata._creativeTheme._originalStoryText = themeResult._originalStoryText;
        }
        
        // 如果用户有调整，应用调整
        if (themeConfirmation.adjustments) {
          const adjusted = this.creativeThemeGenerator.adjustTask(themeResult, themeConfirmation.adjustments);
          metadata._creativeTheme = adjusted.tasks[0];
          console.log('   🔄 已应用用户调整');
        }

      } catch (err) {
        // 【DXB-fix】确认门崩溃属于流程性故障，继续跑只会产出全模板垃圾，必须中止
        if (/onPoll|confirmation|确认/.test(err.message)) {
          result.success = false;
          result.errors.push({ stage: 'CreativeThemeConfirmation', message: err.message, fatal: true });
          return result;
        }
        console.warn(`   ⚠️ 创意主题生成失败: ${err.message}，继续原有链路`);
        result.errors.push({ stage: 'CreativeThemeGenerator', message: err.message });
      }

      // ========== 🆕 Layer 0: 需求洞察 + 业务需求对齐清单 ==========
      // 【v2.1.8-强制流程】Step 3: 需求洞察 + 人工确认（不可跳过）
      console.log('📋 [Layer 0] 需求洞察 - 基于创意主题进行深度业务分析...');
      const stage0Start = Date.now();

      // 从上游 CreativeThemeGenerator 获取 12 字段
      const upstreamFields = {
        ...metadata._creativeTheme,
        // 【方案A-fix】原始故事文本透传到需求洞察
        _originalStoryText: metadata._originalStoryText || metadata._creativeTheme?._originalStoryText || ''
      };
      
      // 调用需求洞察引擎
      let discoveryResult;
      try {
        discoveryResult = await this.requirementDiscoveryEngine.discover(upstreamFields);
        result.stages.requirementDiscovery = {
          data: discoveryResult,
          timing: Date.now() - stage0Start
        };
        console.log(`   ✅ 需求洞察完成 (${result.stages.requirementDiscovery.timing}ms)`);
      } catch (err) {
        console.warn(`   ⚠️ 需求洞察引擎失败: ${err.message}，使用兜底规则`);
        discoveryResult = this.requirementDiscoveryEngine._fastMode(upstreamFields);
        result.stages.requirementDiscovery = {
          data: discoveryResult,
          timing: Date.now() - stage0Start,
          degraded: true,
          error: err.message
        };
      }

      // 同时保留原有的 RequirementListBuilder 输出（兼容下游）
      // 将 discoveryResult 转换为 requirementList 格式
      const requirementList = this._convertDiscoveryToRequirementList(discoveryResult, upstreamFields);

      // 【2026-07-17 修复】创意指数优先级：用户直传 > 主题确认值 > 默认
      // 原实现只读 upstreamFields.creative_style，metadata.creativeIntensity 直传被丢弃
      if (metadata.creativeIntensity !== undefined && metadata.creativeIntensity !== null) {
        requirementList.creativeIntensity = Math.max(0, Math.min(1, Number(metadata.creativeIntensity)));
        console.log(` 💡 创意指数采用用户直传值: ${requirementList.creativeIntensity}`);
      }

      // 生成 Markdown 供人工确认 - 需求清单确认不可跳过!
      console.log('\n📋 [业务需求对齐清单] 等待人工确认...');

      const markdown = this.requirementDiscoveryEngine.generateMarkdown(discoveryResult);
      const requirementConfirmation = await this._confirmRequirementList(markdown, requirementList);
      result.confirmations.requirementList = requirementConfirmation;
      
      // 【v2.1.10-hotfix】累加等待时间
      if (requirementConfirmation.waitTimeMs) {
        result.totalWaitTimeMs += requirementConfirmation.waitTimeMs;
        _extendDeadlineForWait(requirementConfirmation.waitTimeMs, '需求清单');
      }

      if (!requirementConfirmation.approved) {
        console.log('   ❌ 业务需求对齐清单未确认,流程中止');
        result.success = false;
        result.stages.requirementReview = {
          status: 'rejected',
          reason: requirementConfirmation.reason || '用户未确认业务需求对齐清单',
          suggestions: requirementConfirmation.suggestions || []
        };
        return result;
      }

      console.log('   ✅ 业务需求对齐清单已确认,继续创作');

        // ========== P3-1: Emotion Intent Parser 情绪意图解析 ==========
        if (this.emotionIntentParser.enabled) {
          console.log('\n💫 [EmotionIntentParser] 情绪意图解析...');
          try {
            const emotionProfile = this.emotionIntentParser.parse(intent, metadata);
            metadata._emotionProfile = emotionProfile;
            requirementList.emotionProfile = emotionProfile;

            console.log(`   ✅ 情绪解析完成: ${emotionProfile.primary}${emotionProfile.secondary ? ' + ' + emotionProfile.secondary : ''}`);
            console.log(`      强度: ${(emotionProfile.intensity * 100).toFixed(0)}% | 触发器: ${emotionProfile.triggers.slice(0, 3).join(', ')}${emotionProfile.triggers.length > 3 ? '...' : ''}`);

            result.stages.emotionIntent = {
              primary: emotionProfile.primary,
              secondary: emotionProfile.secondary,
              intensity: emotionProfile.intensity,
              triggers: emotionProfile.triggers,
              confidence: emotionProfile.confidence
            };
          } catch (err) {
            console.warn(`   ⚠️ EmotionIntentParser 失败: ${err.message}`);
            result.errors.push({ stage: 'EmotionIntentParser', message: err.message });
          }
        }

        // 如果用户提供了修改意见,重新生成
        if (requirementConfirmation.suggestions?.length > 0) {
          console.log(`   🔄 根据用户反馈重新生成...`);
          requirementList.contentConstraints = requirementList.contentConstraints || [];
          requirementList.contentConstraints.push(...requirementConfirmation.suggestions.map(s => `用户要求: ${s}`));
        }

        // 将需求清单转换为 ScriptEngine 可用的 metadata
        // v1.2.6-fix4b: 确保 characters 正确传递(用户传入优先,否则用 requirementList 的)
        const scriptEngineMeta = this.requirementListBuilder.toScriptEngineMetadata(requirementList);
        const enhancedMetadata = {
          ...metadata,
          ...scriptEngineMeta,
          // 【fix】用户传入的标题优先，禁止被需求清单的默认值覆盖
          title: metadata.title || scriptEngineMeta.title,
          // 显式保留 characters:用户传入的优先(含 portraitPaths 等详细信息)
          characters: metadata.characters || scriptEngineMeta.characters || [],
          // 【v2.1.4】保留原始metadata中的系列信息(用户传入的优先)
          series: metadata.series || scriptEngineMeta.series || null,
          seriesContentPlan: metadata.seriesContentPlan || scriptEngineMeta.seriesContentPlan || null
        };
        metadata = enhancedMetadata;

        // 🐼 [PandaCineForge] F1: Layer 0 需求清单后 - 影视技能预召回
        if (this.pandaAdapter.enabled) {
          console.log('\n🐼 [PandaCineForge] F1 技能预召回...');
          try {
            const skillHints = await this.pandaAdapter.recall({
              call_id: `pcf_f1_${Date.now()}`,
              caller_agent: 'SceneDesign',
              route_fields: {
                module_target: ['MyStudio.SceneDesign'],
                cinematic_role: 'scene_design',
                deliverable_type: 'beat_sheet',
                project_stage: 'preproduction',
                sub_domain: requirementList.videoType || 'cinema'
              },
              context: {
                project_id: metadata.projectId || 'default',
                caller_agent: 'SceneDesign',
                project_type: requirementList.videoType || 'feature_film'
              },
              query_text: `${requirementList.style.primary} ${requirementList.videoTypeName || '电影'} 剧本结构`,
              recall_mode: 'fast',
              topk: 2
            });
            if (skillHints.status === 'hit' || skillHints.status === 'forged') {
              metadata._pandaSkillHints = skillHints;
              console.log(`   ✅ 技能预召回: ${skillHints.skills?.length || 0} 个技能 | 来源: ${skillHints.source_layer}`);
            } else {
              console.log(`   ⚠️ 技能预召回降级: ${skillHints.reason || skillHints.status}`);
            }
          } catch (err) {
            console.warn(`   ⚠️ PandaCineForge F1 失败: ${err.message}`);
          }
        }

        // ========== 🆕 创意指数解析与配置注入 ==========
        // 【2026-07-17 修复】指数来源三级优先：用户约定 > 历史推荐 > 解析默认
        const userSpecifiedIntensity =
          (requirementList.creativeIntensity !== undefined && requirementList.creativeIntensity !== null) ||
          (upstreamFields.creative_style !== undefined && upstreamFields.creative_style !== null);
        let intensity = this.creativeIntensityEngine.parse(requirementList);
        if (!userSpecifiedIntensity) {
          const rec = this.creativeRecommender.recommend(requirementList.videoType || requirementList.genre || 'unknown');
          intensity = rec.intensity;
          console.log(` 🤖 创意指数采用推荐值: ${intensity}（${rec.reason} | 来源:${rec.source} 置信度:${rec.confidence}）`);
        }
        const narrativeMode = requirementList.narrativeMode || 'dialogue';
        const worldSetting = requirementList.worldSetting || requirementList._analysis?.worldSetting || 'default';

        console.log(`\n💡 [创意指数] 解析结果: ${intensity} (${this.creativeIntensityEngine.getLevel(intensity).name})`);
        console.log(`   叙事模式: ${narrativeMode} | 世界设定: ${worldSetting}`);

        const engineConfigs = this.creativeIntensityEngine.generateEngineConfigs(intensity, narrativeMode, worldSetting);

        result.stages.creativeIntensity = {
          intensity,
          level: engineConfigs.level,
          activeCapabilities: engineConfigs._metadata.activeCapabilities,
          report: this.creativeIntensityEngine.generateReport(intensity, narrativeMode, worldSetting)
        };

        // 将创意指数配置注入到各引擎选项
        metadata._creativeIntensity = {
          intensity,
          engineConfigs,
          instructions: {
            script: engineConfigs.scriptEngine?.creativeInstructions || '',
            production: engineConfigs.productionEngine?.creativeInstructions || '',
            rendering: engineConfigs.renderingEngine?.creativeInstructions || '',
            postProduction: engineConfigs.postProductionEngine?.creativeInstructions || ''
          }
        };

        console.log(`   ✅ 创意指数配置已生成,${engineConfigs._metadata.activeCapabilities}个能力激活`);
        console.log(`      Layer 1: ${Object.keys(engineConfigs.scriptEngine).length > 0 ? '✅' : '❌'} 叙事结构配置`);
        console.log(`      Layer 2: ${Object.keys(engineConfigs.productionEngine).length > 0 ? '✅' : '❌'} 视觉表现配置`);
        console.log(`      Layer 3: ${Object.keys(engineConfigs.renderingEngine).length > 0 ? '✅' : '❌'} 渲染质感配置`);
        console.log(`      Layer 4: ${Object.keys(engineConfigs.postProductionEngine).length > 0 ? '✅' : '❌'} 后期风格配置`);

        // 🛡️ v2.1.5-shield: 基线热启动判断
        const baselineMatch = this.stabilityShield.baselineRegistry.findBestMatch({
          intent,
          title: metadata.title,
          characters: metadata.characters,
          style: requirementList.style
        });

        if (baselineMatch.isHotStart && baselineMatch.template) {
          console.log(`\n🛡️ [稳定性护盾] 热启动模式: 命中基线模板 ${baselineMatch.template.id}`);
          console.log(`   题材: ${baselineMatch.category} | 已使用${baselineMatch.template.metadata.usageCount}次`);
          // 【2026-07-17 清理】_baseline/_baselineCategory 写后无人读，暂存 local 变量
          const baselineTemplate = baselineMatch.template;
          const baselineCategory = baselineMatch.category;
          // TODO: 如需注入剧本 prompt，从此处透传
        } else {
          console.log(`\n🛡️ [稳定性护盾] 冷启动模式: 未命中基线,将全LLM生成`);
        }

      // ========== 🆕 v2.1.9: Step 3.5 PRD 生成 ==========
      // 【v2.1.9-强制流程】PRD 生成 - 从业务需求转为产品制作需求
      let prdResult;
      try {
        console.log('\n📋 [Step 3.5] PRD 生成 - 产品需求文档...');
        const prdStart = Date.now();

        // 注入用户修改意见到 discoveryResult
        if (requirementConfirmation.suggestions?.length > 0) {
          discoveryResult.userModifications = requirementConfirmation.suggestions;
        }

        // 生成 PRD
        prdResult = await this.prdGenerator.generate(discoveryResult);
        result.stages.prdGeneration = {
          data: prdResult,
          timing: Date.now() - prdStart,
          summary: prdResult.prdSummary
        };
        console.log(`   ✅ PRD 生成完成 (${result.stages.prdGeneration.timing}ms)`);
        console.log(`   📄 ${prdResult.prdSummary?.humanReadable || 'PRD 已生成'}`);

        // 生成 Markdown 供人工确认
        const prdMarkdown = this.prdGenerator.generateMarkdown(prdResult);
        const prdConfirmation = await this._confirmPRD(prdMarkdown, prdResult);
        result.confirmations.prd = prdConfirmation;
        
        // 【v2.1.10-hotfix】累加等待时间
        if (prdConfirmation.waitTimeMs) {
          result.totalWaitTimeMs += prdConfirmation.waitTimeMs;
          _extendDeadlineForWait(prdConfirmation.waitTimeMs, 'PRD');
        }

        if (!prdConfirmation.approved) {
          console.log('   ❌ PRD 未确认,流程中止');
          result.success = false;
          result.stages.prdReview = {
            status: 'rejected',
            reason: prdConfirmation.reason || '用户未确认 PRD',
            suggestions: prdConfirmation.suggestions || []
          };
          return result;
        }

        console.log('   ✅ PRD 已确认,继续创作');

        // 将 PRD 注入到 metadata，供下游消费
        metadata._prd = prdResult;

        // 如果用户修改了 PRD，重新生成
        if (prdConfirmation.suggestions?.length > 0) {
          console.log(`   🔄 根据用户反馈重新生成 PRD...`);
          discoveryResult.userModifications = [
            ...(discoveryResult.userModifications || []),
            ...prdConfirmation.suggestions
          ];
          prdResult = await this.prdGenerator.generate(discoveryResult);
          result.stages.prdGeneration.regenerated = true;
          result.stages.prdGeneration.data = prdResult;
          metadata._prd = prdResult;
        }

        // 【v2.1.16-fix 时长漂移】PRD 是时长的唯一权威（经人工确认），
        // 同步回 metadata.target_duration，供剧本引擎/制作引擎使用。
        // 原问题：主题/PRD/剧本/制作各自为政（45 vs 60 漂移），budget 按错时长计算
        const prdDuration = prdResult?.productPositioning?.targetDuration
          || prdResult?.prdSummary?.targetDuration
          || null;
        if (prdDuration && Number.isFinite(Number(prdDuration)) && Number(prdDuration) > 0) {
          const prevDuration = metadata.target_duration;
          if (prevDuration !== Number(prdDuration)) {
            console.log(`   🔄 时长权威同步: metadata.target_duration ${prevDuration}s → ${prdDuration}s（以 PRD 为准）`);
          }
          metadata.target_duration = Number(prdDuration);
        }

      } catch (err) {
        console.warn(`   ⚠️ PRD 生成失败: ${err.message},使用兜底模式`);
        result.errors.push({ stage: 'PRDGeneration', message: err.message });
        
        // 生成最小可用 PRD（fallback）
        prdResult = this._generateMinimalPRD(discoveryResult);
        metadata._prd = prdResult;
        result.stages.prdGeneration = {
          data: prdResult,
          timing: 0,
          degraded: true,
          error: err.message
        };
      }

      // ========== Layer 1: 剧本引擎 ==========
      let scriptResult;
      try {
        console.log('📖 [Layer 1] 剧本引擎 - 生成结构化剧本...');
        const stage1Start = Date.now();

        // 🐼 [PandaCineForge] F2: Layer 1 前 - 剧本设计技能注入
        if (this.pandaAdapter.enabled && metadata._pandaSkillHints?.skills?.length > 0) {
          console.log('\n🐼 [PandaCineForge] F2 剧本技能注入...');
          try {
            const scriptSkills = await this.pandaAdapter.recall({
              call_id: `pcf_f2_${Date.now()}`,
              caller_agent: 'SceneDesign',
              route_fields: {
                module_target: ['MyStudio.SceneDesign'],
                cinematic_role: 'scene_design',
                deliverable_type: 'beat_sheet',
                project_stage: 'preproduction',
                sub_domain: metadata.videoType || 'cinema'
              },
              context: {
                project_id: metadata.projectId || 'default',
                upstream_deliverable: (metadata._pandaSkillHints?.skills || [])[0]?.deliverable_type
              },
              query_text: `${(metadata._pandaSkillHints?.skills || [])[0]?.name || '剧本结构'} 叙事设计`,
              recall_mode: 'fast',
              topk: 2
            });
            if (scriptSkills.status === 'hit' || scriptSkills.status === 'forged') {
              metadata._pandaScriptSkills = scriptSkills;
              console.log(`   ✅ 剧本技能注入: ${scriptSkills.skills?.length || 0} 个技能 | 来源: ${scriptSkills.source_layer}`);
            }
          } catch (err) {
            console.warn(`   ⚠️ PandaCineForge F2 失败: ${err.message}`);
          }
        }

        scriptResult = await this.scriptEngine.process(intent, metadata);

        // 【审计修复·P0】校验 adapted 存在且非空
        if (!scriptResult || !scriptResult.adapted) {
          const err = new Error('scriptEngine 未产出 adapted Blueprint');
          err.code = ErrorCodes.DATA_MISSING;
          throw err;
        }
        if (!Array.isArray(scriptResult.adapted.scenes) || scriptResult.adapted.scenes.length === 0) {
          const err = new Error('Blueprint scenes 为空,无法继续生产');
          err.code = ErrorCodes.DATA_MISSING;
          throw err;
        }

        result.stages.scriptEngine = {
          blueprint: scriptResult.blueprint?.meta,
          validation: scriptResult.validation,
          report: scriptResult.report
        };
        result.stages.scriptEngine.timing = Date.now() - stage1Start;

        console.log(`   ✅ 剧本生成完成 (${result.stages.scriptEngine.timing}ms)`);
        console.log(`      场景: ${scriptResult.report.scenes_count} | 角色: ${scriptResult.report.characters_count} | 台词: ${scriptResult.report.dialogues_count}`);
        console.log(`      校验: ${scriptResult.validation.passed ? '通过' : '失败'} (${scriptResult.validation.overall_score}分)`);
        console.log('   ✅ 剧本生成完成,直接进入制作环节');

        // 剧本确认已移除:需求确认后直接跑完整预生产
        result.confirmations.script = { approved: true, skipped: true, reason: '剧本确认环节已移除,需求确认后直接生产' };

        // ========== P3-2: Emotion Arc Designer 情绪弧线设计 ==========
        if (this.emotionArcDesigner.enabled && metadata._emotionProfile) {
          console.log('\n🎼 [EmotionArcDesigner] 情绪弧线设计...');
          try {
            // 🐼 [PandaCineForge] F5: 情绪弧线设计前 - 情绪/叙事技能注入
            if (this.pandaAdapter.enabled) {
              console.log('\n🐼 [PandaCineForge] F5 情绪技能注入...');
              try {
                const emotionSkills = await this.pandaAdapter.recall({
                  call_id: `pcf_f5_${Date.now()}`,
                  caller_agent: 'SceneDesign',
                  route_fields: {
                    module_target: ['MyStudio.SceneDesign'],
                    cinematic_role: 'scene_design',
                    deliverable_type: 'beat_sheet',
                    project_stage: 'preproduction',
                    sub_domain: metadata.videoType || 'cinema'
                  },
                  context: {
                    project_id: metadata.projectId || 'default',
                    caller_agent: 'SceneDesign',
                    upstream_deliverable: 'beat_sheet_v1'
                  },
                  query_text: `${metadata._emotionProfile?.primary || '情绪'} 叙事节奏 情绪曲线设计`,
                  recall_mode: 'fast',
                  topk: 2
                });
                if (emotionSkills.status === 'hit' || emotionSkills.status === 'forged') {
                  metadata._pandaEmotionSkills = emotionSkills;
                  console.log(`   ✅ 情绪技能注入: ${emotionSkills.skills?.length || 0} 个技能 | 来源: ${emotionSkills.source_layer}`);
                }
              } catch (err) {
                console.warn(`   ⚠️ PandaCineForge F5 失败: ${err.message}`);
              }
            }

            const sceneCount = scriptResult.adapted.scenes.length;
            const emotionArc = this.emotionArcDesigner.design(metadata._emotionProfile, {
              duration: metadata.targetDuration || 10,
              sceneCount,
              narrativeMode: metadata.narrativeMode || 'dialogue'
            });

            metadata._emotionArc = emotionArc;
            scriptResult.adapted._emotionArc = emotionArc;

            console.log(`   ✅ 情绪弧线设计完成`);
            console.log(`      曲线类型: ${emotionArc.curveType} | ${emotionArc.description}`);
            console.log(`      场景情绪目标: ${emotionArc.targets.map(t => t.emotion).join(' → ')}`);

            result.stages.emotionArc = {
              curveType: emotionArc.curveType,
              description: emotionArc.description,
              targets: emotionArc.targets.map(t => ({
                sceneIndex: t.sceneIndex,
                emotion: t.emotion,
                intensity: t.intensity,
                descriptor: t.descriptor
              }))
            };
          } catch (err) {
            console.warn(`   ⚠️ EmotionArcDesigner 失败: ${err.message}`);
            result.errors.push({ stage: 'EmotionArcDesigner', message: err.message });
          }
        }

      } catch (error) {
        result.success = false;
        result.errors.push({ layer: 'script-engine', error: error.message });
        console.error(`\n❌ [Layer 1 失败] ${error.message}`);
        return result;
      }

      // ========== 适配层 ==========
      console.log('\n🔗 [Adapter] 适配层 - 转换数据格式...');
      const adapted = scriptResult.adapted;

      // ========== P2-2: 叙事节奏增强 ==========
      if (this.narrativeRhythmAdapter.enabled) {
        console.log('\n🎼 [NarrativeRhythm] 叙事节奏增强...');
        try {
          const rhythmResult = this.narrativeRhythmAdapter.enhance(adapted, metadata);

          // 将增强后的蓝图替换原 adapted
          if (rhythmResult.blueprint && rhythmResult.blueprint !== adapted) {
            // 更新 adapted 的 scenes 和 rhythmProfile
            adapted.scenes = rhythmResult.blueprint.scenes || adapted.scenes;
            adapted._rhythmProfile = rhythmResult.blueprint._rhythmProfile;

            console.log(`   ✅ 叙事节奏增强完成`);
            console.log(`      情绪曲线: ${rhythmResult.blueprint._rhythmProfile?.curveType || 'default'}`);
            console.log(`      场景节奏: ${rhythmResult.blueprint.scenes?.length || 0} 个场景已注入`);

            result.stages.narrativeRhythm = {
              curveType: rhythmResult.blueprint._rhythmProfile?.curveType,
              dynamicMode: rhythmResult.blueprint._rhythmProfile?.dynamicMode,
              beatInterval: rhythmResult.blueprint._rhythmProfile?.beatInterval,
              rhythmProfile: rhythmResult.rhythmProfile
            };

            // P1-4: EventBus 记录
            this.eventBus.emit('narrativeRhythm.completed', {
              layerId: 'layer-1-rhythm',
              curveType: rhythmResult.blueprint._rhythmProfile?.curveType,
              timing: Date.now()
            });
          }
        } catch (err) {
          console.warn(`   ⚠️ 叙事节奏增强失败: ${err.message}`);
          result.errors.push({ stage: 'NarrativeRhythm', message: err.message });

          this.eventBus.emit('narrativeRhythm.failed', {
            layerId: 'layer-1-rhythm',
            error: err.message,
            timing: Date.now()
          });
        }
      }

      // ========== Layer 2: 制作引擎 ==========
      console.log('\n🎬 [Layer 2] 制作引擎 - 生成镜头...');
      const stage2Start = Date.now();

      // 🐼 [PandaCineForge] F3: Layer 2 前 - 视觉语言技能注入
      if (this.pandaAdapter.enabled) {
        console.log('\n🐼 [PandaCineForge] F3 视觉技能注入...');
        try {
          const visualSkills = await this.pandaAdapter.recall({
            call_id: `pcf_f3_${Date.now()}`,
            caller_agent: 'VisualLanguage',
            route_fields: {
              module_target: ['MyStudio.VisualLanguage'],
              cinematic_role: 'visual_language',
              deliverable_type: 'shotlist',
              project_stage: 'production',
              sub_domain: metadata.videoType || 'cinema'
            },
            context: {
              project_id: metadata.projectId || 'default',
              caller_agent: 'VisualLanguage',
              upstream_deliverable: 'beat_sheet_v1'
            },
            query_text: `${(metadata._pandaScriptSkills?.skills || [])[0]?.name || '镜头语言'} 分镜设计 运镜`,
            recall_mode: 'fast',
            topk: 2
          });
          if (visualSkills.status === 'hit' || visualSkills.status === 'forged') {
            metadata._pandaVisualSkills = visualSkills;
            console.log(`   ✅ 视觉技能注入: ${visualSkills.skills?.length || 0} 个技能 | 来源: ${visualSkills.source_layer}`);
          }
        } catch (err) {
          console.warn(`   ⚠️ PandaCineForge F3 失败: ${err.message}`);
        }
      }

      // 【审计修复·全局预算协调】将"全局剩余预算"下发给制作引擎，取代其独立的60分钟预算；
      // 预留渲染/后期时间；预算告急时切换纯规则模式保交付，而不是整体超时崩盘
      const RENDER_RESERVE_MS = parseInt(process.env.STORMAXE_RENDER_RESERVE_MS || '300000'); // 渲染+后期预留(默认5分钟)
      const remainingForProduction = globalDeadline - Date.now() - RENDER_RESERVE_MS;
      const MIN_PRODUCTION_BUDGET_MS = 10 * 60 * 1000;
      const baseAgentConfig = { ...(options.productionEngine?.agentConfig || {}) };
      if (remainingForProduction < MIN_PRODUCTION_BUDGET_MS) {
        console.warn(` ⏰ 全局预算告急: 制作环节仅剩 ${Math.max(0, Math.round(remainingForProduction/60000))} 分钟，切换纯规则模式保交付`);
        baseAgentConfig.enableLLMAgents = false;
        baseAgentConfig.totalDeadlineMs = Math.max(remainingForProduction, 60000);
      } else {
        baseAgentConfig.totalDeadlineMs = remainingForProduction;
        console.log(` 💰 全局预算: 制作引擎可用 ${Math.round(remainingForProduction/60000)} 分钟(已预留渲染/后期 ${Math.round(RENDER_RESERVE_MS/60000)} 分钟)`);
      }

      // 【修复】应用运行时 agentConfig(解决配置不生效问题)
      this.productionEngine.updateAgentConfig(baseAgentConfig);
      
      // ⭐ v2.2.1-fix: 原始故事文本注入生产引擎蓝图（PromptFusion 上下文三源兜底的全覆盖）
      const _storyText = metadata._originalStoryText || metadata._creativeTheme?._originalStoryText || '';
      if (_storyText) {
        adapted._originalStoryText = _storyText;
        adapted._metadata = { ...(adapted._metadata || {}), _originalStoryText: _storyText };
        adapted.config = { ...(adapted.config || {}), _originalStoryText: _storyText };
      }

      adapted._creativeTheme = metadata._creativeTheme || adapted._creativeTheme || null;

      productionResult = await this.productionEngine.produce(adapted, baseAgentConfig);

      // 【接线4 修复】场景规划一致性检查：PRD scenePlan vs 实际生成
      // 【接线5 修复】角色双轨仲裁：PRD characterSystem vs 定妆照目录
      try {
        const prd = prdResult || metadata?._prd || null;
        if (prd) {
          // 场景一致性检查
          const scenePlan = prd.productionSpecification?.scenePlan || prd.scenePlan || null;
          if (scenePlan?.scenes && productionResult?.shots) {
            const plannedSceneCount = scenePlan.scenes.length;
            const plannedShotCount = scenePlan.shotMapping?.reduce((sum, s) => sum + (s.estimatedShots || 0), 0) || 0;
            const actualSceneCount = new Set(productionResult.shots.map(s => s.shotId?.split('-')[0] || s.sceneId)).size;
            const actualShotCount = productionResult.shots.length;
            
            if (Math.abs(plannedSceneCount - actualSceneCount) > 1 || Math.abs(plannedShotCount - actualShotCount) > 3) {
              console.warn(`   ⚠️ [场景一致性] 规划 vs 实际偏差: 场景${plannedSceneCount}→${actualSceneCount}, 镜头${plannedShotCount}→${actualShotCount}`);
              result.warnings = result.warnings || [];
              result.warnings.push({ type: 'scene_mismatch', planned: { scenes: plannedSceneCount, shots: plannedShotCount }, actual: { scenes: actualSceneCount, shots: actualShotCount } });
            } else {
              console.log(`   ✅ [场景一致性] 规划/实际匹配: 场景${plannedSceneCount}/${actualSceneCount}, 镜头${plannedShotCount}/${actualShotCount}`);
            }
          }
          
          // 角色双轨仲裁
          const prdChars = prd.productionSpecification?.characterSystem?.characters 
            || prd.characterSystem?.characters || [];
          if (prdChars.length > 0) {
            const fs = require('fs');
            const path = require('path');
            const charsDir = options.productionEngine?.charactersDir || path.join(__dirname, '../characters');
            let portraitCount = 0;
            try {
              const entries = fs.readdirSync(charsDir);
              portraitCount = entries.filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f)).length;
            } catch (e) {
              // 目录可能不存在
            }
            
            if (prdChars.length !== portraitCount) {
              console.warn(`   ⚠️ [角色双轨] PRD角色${prdChars.length}个 vs 定妆照${portraitCount}张: ${prdChars.map(c => c.name || c.characterId).join(', ')}`);
              result.warnings = result.warnings || [];
              result.warnings.push({ type: 'character_mismatch', prdCharacters: prdChars.length, portraits: portraitCount, names: prdChars.map(c => c.name || c.characterId) });
            } else {
              console.log(`   ✅ [角色双轨] PRD角色${prdChars.length}个 / 定妆照${portraitCount}张 — 匹配`);
            }
          }
        }
      } catch (checkErr) {
        console.warn(`   ⚠️ 场景/角色一致性检查失败: ${checkErr.message}`);
      }

      // 【v2.1.6-fix-bug36+38】分离 shots↔prompts 引用 + 建立 O(1) 索引
      const { DualArraySync } = require('./utils/dual-array-sync');
      this.dualSync = new DualArraySync();
      const detached = this.dualSync.detach(productionResult.shots, productionResult.prompts);
      productionResult.shots = detached.shots;
      productionResult.prompts = detached.prompts;

      result.stages.productionEngine = {
        shots: productionResult.shots.map(s => {
          const clean = {};
          for (const [k, v] of Object.entries(s)) {
            if (k.startsWith('_')) continue; // 跳过内部字段
            if (typeof v === 'function') continue;
            clean[k] = v;
          }
          return clean;
        }),
        prompts: productionResult.prompts,
        quality: productionResult.stages.qualityGate,
        // 【v2.1.4】跨集边界校验报告
        boundaryReport: productionResult.stages.boundaryReport || null
      };
      result.stages.productionEngine.timing = Date.now() - stage2Start;

      console.log(`   ✅ 制作完成 (${result.stages.productionEngine.timing}ms)`);
      console.log(`      镜头: ${productionResult.shots.length} | Prompts: ${productionResult.prompts.length}`);
      console.log(`      质量门: ${productionResult.stages.qualityGate?.passed ? '通过' : '失败'}`);

      // ========== 🆕 审计修复：6个功能增强模块注入 ==========
      
      // 1. 时长约束（必须在制作引擎后第一个执行，约束基础数据）
      if (this.durationConstraintManager.enabled && scriptResult?.adapted?.scenes) {
        console.log('\n⏱️ [DurationManager] 时长约束检查...');
        try {
          const rhythmType = metadata.rhythmType ||
            (metadata.target_duration <= 30 ? 'fast' :
             metadata.target_duration >= 120 ? 'slow' : 'standard');
          
          const constrainResult = this.durationConstraintManager.constrain(
            scriptResult.adapted.scenes,
            { targetDuration: metadata.target_duration, rhythmType, forceAdjust: true }
          );
          
          if (constrainResult.adjustments.length > 0) {
            console.log(`   ⚠️ 时长调整: ${constrainResult.adjustments.length} 处`);
          } else {
            console.log('   ✅ 时长约束通过');
          }
        } catch (err) {
          console.warn(`   ⚠️ DurationManager 失败: ${err.message}`);
        }
      }

      // 2. 场景编号映射（建立 shotId ↔ 内容映射表）
      if (this.sceneNumberMapper.enabled && productionResult?.shots) {
        console.log('\n🗺️ [SceneMapper] 场景编号映射...');
        try {
          const mapResult = this.sceneNumberMapper.map(
            productionResult.shots,
            scriptResult?.adapted?.scenes || [],
            scriptResult?.adapted?.dialogues || []
          );
          result.stages.sceneNumberMap = mapResult.mappings;
          console.log(`   ✅ 场景映射完成: ${mapResult.mappings.length} 条映射`);
        } catch (err) {
          console.warn(`   ⚠️ SceneMapper 失败: ${err.message}`);
        }
      }

      // 3. 角色服装锁定（在情绪注入前，确保服装稳定）
      if (this.characterCostumePrompter.enabled && metadata.characters?.length > 0 && productionResult?.shots) {
        console.log('\n👔 [CharacterCostume] 角色服装锁定注入...');
        try {
          const enhancedShots = this.characterCostumePrompter.enhance(
            productionResult.shots,
            metadata.characters
          );
          productionResult.shots = enhancedShots;
          for (const p of productionResult.prompts) {
            const shot = enhancedShots.find(s => s.shotId === p.shotId);
            if (shot) { p.prompt = shot.prompt; p.promptCharCount = shot.promptCharCount; }
          }
          console.log('   ✅ 角色服装锁定注入完成');
        } catch (err) {
          console.warn(`   ⚠️ CharacterCostume 失败: ${err.message}`);
        }
      }

      // 4. 身份持续提示（确保角色身份跨镜头一致）
      if (this.identityPersistenceSystem.enabled && metadata.characters?.length > 0 && productionResult?.shots) {
        console.log('\n🆔 [IdentityPersist] 身份持续提示注入...');
        try {
          productionResult.shots = this.identityPersistenceSystem.persist(
            productionResult.shots,
            metadata.characters,
            scriptResult?.adapted?.scenes || []
          );
          console.log('   ✅ 身份持续提示注入完成');
        } catch (err) {
          console.warn(`   ⚠️ IdentityPersist 失败: ${err.message}`);
        }
      }

      // 5. 行为锚定（确保姿态自然过渡）
      if (this.behaviorAnchorSystem.enabled && productionResult?.shots) {
        console.log('\n🚶 [BehaviorAnchor] 行为锚定注入...');
        try {
          productionResult.shots = this.behaviorAnchorSystem.anchor(
            productionResult.shots,
            scriptResult?.adapted?.scenes || []
          );
          console.log('   ✅ 行为锚定注入完成');
        } catch (err) {
          console.warn(`   ⚠️ BehaviorAnchor 失败: ${err.message}`);
        }
      }

      // 6. 智能引用（绑定场景引用图）
      if (this.smartImageReferencer.enabled && productionResult?.shots) {
        console.log('\n🖼️ [SmartImageRef] 智能引用绑定...');
        try {
          productionResult.shots = await this.smartImageReferencer.bind(
            productionResult.shots,
            scriptResult?.adapted?.scenes || [],
            metadata.referenceImages || []
          );
          console.log('   ✅ 智能引用绑定完成');
        } catch (err) {
          console.warn(`   ⚠️ SmartImageRef 失败: ${err.message}`);
        }
      }

      // 🆕 【v2.1.6-fix】Prompt 长度同步：所有增强模块完成后统一同步
      if (productionResult?.shots) {
        this.promptSync.syncAll(productionResult.shots, 'PostEnhancement');
      }

      // 🆕 【v2.1.6-fix】台词时长校验（已有工具，集成到主流程）
      if (this.dialogueTimingCalc && scriptResult?.adapted?.scenes && metadata.target_duration) {
        console.log('\n🗣️ [DialogueTiming] 台词时长校验...');
        try {
          const dialogueShots = scriptResult.adapted.scenes.map((scene) => ({
            shot_id: scene.scene_id,
            duration: scene.timing?.duration || scene.duration || 0,
            emotion: scene.emotion || scene.mood || 'normal',
            dialogue: scene.dialogue
          }));
          const validation = this.dialogueTimingCalc.validateShots(dialogueShots);
          if (validation.criticalCount > 0) {
            console.warn(`   ⚠️ 发现 ${validation.criticalCount} 个台词溢出问题！`);
            for (const issue of validation.results.filter((r) => r.severity === 'critical')) {
              console.warn(`   • ${issue.shotId}: ${issue.suggestion}`);
              if (issue.autoFix) {
                const scene = scriptResult.adapted.scenes.find((s) => s.scene_id === issue.shotId);
                if (scene && issue.autoFix.type === 'extend_shot') {
                  const newDuration = issue.autoFix.suggestedDuration;
                  if (scene.timing) scene.timing.duration = newDuration;
                  scene.duration = newDuration;
                  console.log(`   ✅ 已自动延长 ${issue.shotId} 至 ${newDuration}秒`);
                }
              }
            }
          }
          if (validation.warningCount > 0) {
            console.warn(`   ℹ️ ${validation.warningCount} 个台词占比警告`);
          }
          if (validation.valid) {
            console.log('   ✅ 台词时长校验通过');
          }
        } catch (err) {
          console.warn(`   ⚠️ DialogueTiming 校验失败: ${err.message}`);
        }
      }

      // ========== P3-3: Emotion Shot Syntax Injection 情绪镜头语法注入 ==========
      if (this.emotionShotSyntaxInjector.enabled && metadata._emotionArc) {
        console.log('\n💫 [EmotionShotSyntax] 情绪镜头语法注入...');
        try {
          const injectedShots = this.emotionShotSyntaxInjector.inject(productionResult.shots, metadata._emotionArc);
          const oldShots = productionResult.shots; // 【v2.1.6-fix-bug37】保存旧 shots 用于元数据保留
          productionResult.shots = injectedShots;

          // 【v2.1.6-fix-bug37】不可变更新保留元数据
          productionResult.shots = this.dualSync.immutableUpdate(oldShots, productionResult.shots);

          // 同步 prompts（使用 DualArraySync O(1) 查找）
          this.dualSync.syncShotsToPrompts('EmotionShotSyntax', productionResult.shots, productionResult.prompts, ['_emotionInjected']);

          console.log(`   ✅ 情绪镜头语法注入完成`);
          result.stages.emotionShotSyntax = {
            injectedCount: injectedShots.filter(s => s._emotionInjected).length
          };

          // P1-4: EventBus 记录
          this.eventBus.emit('emotionShotSyntax.completed', {
            layerId: 'layer-2-emotion',
            injectedCount: injectedShots.filter(s => s._emotionInjected).length,
            timing: Date.now()
          });
        } catch (err) {
          console.warn(`   ⚠️ EmotionShotSyntax 失败: ${err.message}`);
          result.errors.push({ stage: 'EmotionShotSyntax', message: err.message });

          this.eventBus.emit('emotionShotSyntax.failed', {
            layerId: 'layer-2-emotion',
            error: err.message,
            timing: Date.now()
          });
        }
      }

      // ========== P2-3: Shot Quality Enhancer 镜头质量增强 ==========
      if (this.shotQualityEnhancer.enabled) {
        console.log('\n✨ [ShotQualityEnhancer] 镜头质量增强...');
        try {
          const sqResult = this.shotQualityEnhancer.enhance(productionResult.shots, {
            duration: metadata.targetDuration,
            intent,
            style: metadata.style
          });

          productionResult.shots = sqResult.shots;

          // 同步 prompts
          for (const p of productionResult.prompts) {
            // 同步 prompts（使用 DualArraySync O(1) 查找）
            this.dualSync.syncShotsToPrompts('ShotQuality', productionResult.shots, productionResult.prompts, [
              '_qualityEnhanced', '_narrativePurpose', '_visualHook', '_primaryFocus'
            ]);
          }

          console.log(`   ✅ 镜头质量增强完成: ${sqResult.enhancedCount}/${productionResult.shots.length} 个镜头`);
          result.stages.shotQuality = {
            enhancedCount: sqResult.enhancedCount,
            report: sqResult.report
          };

          // P1-4: EventBus 记录
          this.eventBus.emit('shotQuality.completed', {
            layerId: 'layer-2-quality',
            enhancedCount: sqResult.enhancedCount,
            timing: Date.now()
          });
        } catch (err) {
          console.warn(`   ⚠️ ShotQualityEnhancer 失败: ${err.message}`);
          result.errors.push({ stage: 'ShotQualityEnhancer', message: err.message });

          this.eventBus.emit('shotQuality.failed', {
            layerId: 'layer-2-quality',
            error: err.message,
            timing: Date.now()
          });
        }
      }

      // ========== 🆕 字段标准化与守门(专家诊断建议)==========
      console.log('\n🛡️ [FieldGuard] Layer 2 输出标准化与校验...');
      try {
        const normalized = this.fieldGuard.normalizeAndValidate(productionResult.shots, 'Layer2-Production');
        productionResult.shots = normalized.shots;

        // 【v2.1.4-fix10-P25-fix3】关键修复:标准化后用完整的 25 字段重算 prompt,消除"假完整"
        for (const shot of productionResult.shots) {
          if (shot.fields && this.productionEngine.assemblePromptFromFields) {
            const rebuilt = this.productionEngine.assemblePromptFromFields(shot, shot.fields, shot.ratio || '16:9');
            shot.prompt = rebuilt;
            shot.promptCharCount = this.productionEngine.countChars ? this.productionEngine.countChars(rebuilt) : rebuilt.length;
          }
        }
        // prompts 数组同步（使用 DualArraySync O(1) 查找）
        this.dualSync.syncShotsToPrompts('FieldGuard', productionResult.shots, productionResult.prompts, ['prompt', 'promptCharCount']);

        // v1.2.6-fix5: 不再用 normalized.shots 覆盖 prompts(prompts 已是标准输出对象,标准化会破坏结构)
        // productionResult.prompts = normalized.shots; // ❌ 删除此行
        console.log(`   ✅ 字段标准化通过 (${normalized.report.warnings.length} 警告),prompt 已按 25 字段重算`);
        this.fieldGuard.printShotSummary(normalized.shots, 'Layer2-Production');
      } catch (err) {
        console.error(`   ❌ 字段校验失败: ${err.message}`);
        if (err.report) {
          console.error(`      错误: ${err.report.errors.join(' | ')}`);
        }
        // 非严格模式下继续,但记录错误
        result.errors.push({ stage: 'FieldGuard-Layer2', message: err.message });
      }

      // ========== Phase 4: 垂直场景层（可选模式） ==========

      // 🐼 [PandaCineForge] F6: 垂直场景前 — 商业/短视频/FPV 技能注入
      if (this.pandaAdapter.enabled) {
        console.log('\n🐼 [PandaCineForge] F6 垂直场景技能注入...');
        try {
          const verticalSkills = await this.pandaAdapter.recall({
            call_id: `pcf_f6_${Date.now()}`,
            caller_agent: 'SceneDesign',
            route_fields: {
              module_target: ['MyStudio.SceneDesign'],
              cinematic_role: 'scene_design',
              deliverable_type: 'shotlist',
              project_stage: 'production',
              sub_domain: metadata.videoType === 'short_video' ? 'short_video' : 'cinema'
            },
            context: {
              project_id: metadata.projectId || 'default',
              caller_agent: 'SceneDesign',
              upstream_deliverable: 'shotlist_v1'
            },
            query_text: `${metadata.videoType === 'short_video' ? '短视频钩子 投流策略' : '商业广告 品牌一致性'}`,
            recall_mode: 'fast',
            topk: 2
          });
          if (verticalSkills.status === 'hit' || verticalSkills.status === 'forged') {
            metadata._pandaVerticalSkills = verticalSkills;
            console.log(`   ✅ 垂直场景技能注入: ${verticalSkills.skills?.length || 0} 个技能 | 来源: ${verticalSkills.source_layer}`);
          }
        } catch (err) {
          console.warn(`   ⚠️ PandaCineForge F6 失败: ${err.message}`);
        }
      }

      // P4-1: Commercial Mode 商业广告模式
      if (this.commercialModeEnhancer.enabled || options.commercialMode?.enabled) {
        console.log('\n📺 [CommercialMode] 商业广告模式增强...');
        try {
          const commercialResult = this.commercialModeEnhancer.enhance(productionResult.shots, {
            platform: options.commercialMode?.platform || this.commercialModeEnhancer.platform,
            brandConfig: options.commercialMode?.brandConfig || this.commercialModeEnhancer.brandConfig
          });

          const oldShots = productionResult.shots; // 【v2.1.6-fix-bug37】保存旧 shots 用于元数据保留
          productionResult.shots = commercialResult.shots;

          // 【v2.1.6-fix-bug37+41】不可变更新保留元数据 + 同步 prompts
          productionResult.shots = this.dualSync.immutableUpdate(oldShots, productionResult.shots);
          this.dualSync.syncShotsToPrompts('CommercialMode', productionResult.shots, productionResult.prompts);

          console.log(`   ✅ 商业广告模式增强完成`);
          if (!commercialResult.complianceReport.passed) {
            console.warn(`   ⚠️ 合规警告: ${commercialResult.complianceReport.issues.length} 项`);
          }

          result.stages.commercialMode = {
            platform: this.commercialModeEnhancer.platform,
            enhancements: commercialResult.enhancements.length,
            compliancePassed: commercialResult.complianceReport.passed,
            complianceIssues: commercialResult.complianceReport.issues.length
          };

          // P1-4: EventBus 记录
          this.eventBus.emit('commercialMode.completed', {
            layerId: 'layer-2-commercial',
            platform: this.commercialModeEnhancer.platform,
            compliancePassed: commercialResult.complianceReport.passed,
            timing: Date.now()
          });
        } catch (err) {
          console.warn(`   ⚠️ CommercialMode 失败: ${err.message}`);
          result.errors.push({ stage: 'CommercialMode', message: err.message });

          this.eventBus.emit('commercialMode.failed', {
            layerId: 'layer-2-commercial',
            error: err.message,
            timing: Date.now()
          });
        }
      }

      // P4-2: FPV Mode 极限运动模式
      if (this.fpvModeEnhancer.enabled || options.fpvMode?.enabled) {
        console.log('\n🎬 [FPVMode] 极限运动模式检测...');
        try {
          const fpvResult = this.fpvModeEnhancer.enhance(productionResult.shots, intent);

          if (fpvResult.fpvEnabled) {
            const oldShots = productionResult.shots; // 【v2.1.6-fix-bug37】保存旧 shots 用于元数据保留
            productionResult.shots = fpvResult.shots;

            // 【v2.1.6-fix-bug37+41】不可变更新保留元数据 + 同步 prompts
            productionResult.shots = this.dualSync.immutableUpdate(oldShots, productionResult.shots);
            this.dualSync.syncShotsToPrompts('FPVMode', productionResult.shots, productionResult.prompts);

            console.log(`   ✅ FPV 模式增强完成: ${fpvResult.enhancements.length} 个镜头`);
            console.log(`      运动类型: ${fpvResult.sportType}`);

            result.stages.fpvMode = {
              enabled: true,
              sportType: fpvResult.sportType,
              enhancements: fpvResult.enhancements.length
            };

            // P1-4: EventBus 记录
            this.eventBus.emit('fpvMode.completed', {
              layerId: 'layer-2-fpv',
              sportType: fpvResult.sportType,
              timing: Date.now()
            });
          } else {
            console.log(`   i️ 未检测到极限运动内容,跳过 FPV 模式`);
          }
        } catch (err) {
          console.warn(`   ⚠️ FPVMode 失败: ${err.message}`);
          result.errors.push({ stage: 'FPVMode', message: err.message });

          this.eventBus.emit('fpvMode.failed', {
            layerId: 'layer-2-fpv',
            error: err.message,
            timing: Date.now()
          });
        }
      }

      // ========== 🆕 好莱坞导演技能注入（fix-1B：注入 25 字段提示词内部） ==========
      console.log('\n🎬 [Director Skills] 好莱坞导演技能注入...');
      try {
        const { enhancedShots, report } = routeAndEnhance(productionResult.shots, {
          minScore: 5,
          maxSkillsPerShot: 2
        });

        // 【fix-1B】技能增强写进 25 字段提示词内部，替换旧的"裸贴 prompt 末尾"
        // 旧写法在 MERGE-GUARD 与报告格式化下不可见、不生效
        const _injectSkillIntoPromptFields = (shot) => {
          const skills = shot._appliedSkills;
          if (!skills || skills.length === 0 || !shot.prompt) return shot;
          const skillTag = skills.map(s => `${s.type}_${s.director}_${s.emotion}${s.fallback ? '(回退匹配)' : ''}`).join('、');
          const skillRef = `【技能增强】本镜技法参考好莱坞技能库：${skillTag}，运镜与光影按该导演该情绪的标准手法执行`;
          let p = shot.prompt;
          if (/【导演意图】/.test(p)) {
            p = p.replace(/(【导演意图】[^【]*)/, `$1${skillRef}；`);
          } else {
            p = skillRef + '。 | ' + p;
          }
          if (shot._skillForbidden && /【负面约束】/.test(p)) {
            p = p.replace(/(【负面约束】[^【]*)/, `$1, ${shot._skillForbidden}`);
          }
          shot.prompt = p;
          return shot;
        };
        productionResult.shots = enhancedShots.map(_injectSkillIntoPromptFields);

        // 【fix-1B】同步 prompt 文本到 prompts 数组（旧版只同步两个元数据键）
        const oldShots = productionResult.shots;
        productionResult.shots = this.dualSync.immutableUpdate(oldShots, productionResult.shots);
        this.dualSync.syncShotsToPrompts('DirectorSkills', productionResult.shots, productionResult.prompts, [
          'prompt', 'directorStyle', '_appliedSkills'
        ]);

        console.log(`   ✅ 导演技能注入完成`);
        console.log(`      增强镜头: ${report.enhancedShots}/${report.totalShots}`);
        console.log(`      使用技能: ${report.skillsUsed.length}个`);
        if (report.skillsUsed.length > 0) {
          console.log(`      技能列表: ${report.skillsUsed.slice(0, 5).join(', ')}${report.skillsUsed.length > 5 ? '...' : ''}`);
        }

        result.stages.directorSkills = {
          enhancedShots: report.enhancedShots,
          totalShots: report.totalShots,
          skillsUsed: report.skillsUsed,
          details: report.details
        };
      } catch (err) {
        console.warn(`   ⚠️ 导演技能注入失败: ${err.message}`);
        result.errors.push({ stage: 'DirectorSkills', message: err.message });
      }

      // 【架构-L4】技能命中遥测：append 到 usage-stats.jsonl，供淘汰零命中技能、发现覆盖空洞【fix-3D】
      try {
        const statsPath = require('path').join(__dirname, 'skills/hollywood-cinematography/usage-stats.jsonl');
        const record = {
          run_id: this._runId, ts: new Date().toISOString(),
          title: metadata.title, shots: (result.stages.skillPrematch || [])
        };
        require('fs').appendFileSync(statsPath, JSON.stringify(record) + '\n');
      } catch (_) { /* 遥测失败不影响主流程 */ }

      // ========== P2-5: Director Optimization Agent 导演优化 ==========
      if (this.directorOptimizationAgent.enabled) {
        console.log('\n🎬 [DirectorOptimizationAgent] 导演优化...');
        try {
          // 🐼 [PandaCineForge] F4: 导演优化前 - 导演技能注入
          if (this.pandaAdapter.enabled) {
            console.log('\n🐼 [PandaCineForge] F4 导演技能注入...');
            try {
              const directorSkills = await this.pandaAdapter.recall({
                call_id: `pcf_f4_${Date.now()}`,
                caller_agent: 'VisualLanguage',
                route_fields: {
                  module_target: ['MyStudio.VisualLanguage'],
                  cinematic_role: 'visual_language',
                  deliverable_type: 'color_script',
                  project_stage: 'production',
                  sub_domain: metadata.videoType || 'cinema'
                },
                context: {
                  project_id: metadata.projectId || 'default',
                  caller_agent: 'VisualLanguage',
                  upstream_deliverable: 'shotlist_v1'
                },
                query_text: `${(metadata._pandaVisualSkills?.skills || [])[0]?.name || '导演技巧'} 视觉设计 镜头语言`,
                recall_mode: 'fast',
                topk: 2
              });
              if (directorSkills.status === 'hit' || directorSkills.status === 'forged') {
                metadata._pandaDirectorSkills = directorSkills;
                console.log(`   ✅ 导演技能注入: ${directorSkills.skills?.length || 0} 个技能 | 来源: ${directorSkills.source_layer}`);
              }
            } catch (err) {
              console.warn(`   ⚠️ PandaCineForge F4 失败: ${err.message}`);
            }
          }

          const optResult = await this.directorOptimizationAgent.optimize(productionResult.shots, metadata);

          if (optResult.improved) {
            const oldShots = productionResult.shots; // 【v2.1.6-fix-bug37】保存旧 shots 用于元数据保留
            productionResult.shots = optResult.shots;

            // 【v2.1.6-fix-bug37】不可变更新保留元数据
            productionResult.shots = this.dualSync.immutableUpdate(oldShots, productionResult.shots);
            console.log(`   ✅ 导演优化完成: ${optResult.score.toFixed(2)}/5.0 (迭代 ${optResult.iterations} 次)`);
          } else {
            console.log(`   ✅ 导演优化检查通过: ${optResult.score.toFixed(2)}/5.0`);
          }

          result.stages.directorOptimization = {
            score: optResult.score,
            iterations: optResult.iterations,
            improved: optResult.improved,
            threshold: this.directorOptimizationAgent.threshold
          };

          // P1-4: EventBus 记录
          this.eventBus.emit('directorOptimization.completed', {
            layerId: 'layer-2-director',
            score: optResult.score,
            improved: optResult.improved,
            timing: Date.now()
          });
        } catch (err) {
          console.warn(`   ⚠️ DirectorOptimizationAgent 失败: ${err.message}`);
          result.errors.push({ stage: 'DirectorOptimizationAgent', message: err.message });

          this.eventBus.emit('directorOptimization.failed', {
            layerId: 'layer-2-director',
            error: err.message,
            timing: Date.now()
          });
        }
      }

      // ========== P2-1: MicroMotion 微动作增强 ==========
      if (this.microMotionAdapter.enabled) {
        console.log('\n🎭 [MicroMotion] 微动作增强...');
        try {
          const mmResult = this.microMotionAdapter.enhance(productionResult.prompts, {
            characters: metadata.characters || [],
            emotionArc: metadata._emotionArc || null
          });

          productionResult.prompts = mmResult.prompts;

          // 同步 shots（使用 DualArraySync O(1) 查找）
          this.dualSync.syncPromptsToShots('MicroMotion', productionResult.shots, productionResult.prompts, ['_microMotion']);

          console.log(`   ✅ 微动作增强完成: ${mmResult.enhancedCount}/${productionResult.prompts.length} 镜头`);
          result.stages.microMotion = {
            enhancedCount: mmResult.enhancedCount,
            details: mmResult.details
          };

          // P1-4: EventBus 记录
          this.eventBus.emit('micromotion.completed', {
            layerId: 'layer-2-enhancer',
            enhancedCount: mmResult.enhancedCount,
            timing: Date.now()
          });
        } catch (err) {
          console.warn(`   ⚠️ MicroMotion 失败: ${err.message}`);
          result.errors.push({ stage: 'MicroMotion', message: err.message });

          this.eventBus.emit('micromotion.failed', {
            layerId: 'layer-2-enhancer',
            error: err.message,
            timing: Date.now()
          });
        }
      }

      // ========== P1-1: Prompt Guardian 自动修复 ==========
      if (this.promptGuardian.enabled) {
        console.log('\n🔍 [PromptGuardian] 启动 Prompt 自动修复...');
        try {
          const guardianResult = this.promptGuardian.guard(productionResult.prompts, {
            characters: metadata.characters || []
          });

          if (guardianResult.fixes.length > 0) {
            console.log(`   ✅ 自动修复 ${guardianResult.fixes.length} 处问题:`);
            for (const fix of guardianResult.fixes.slice(0, 5)) {
              console.log(`      • ${fix.type}: ${fix.action}`);
            }
            if (guardianResult.fixes.length > 5) {
              console.log(`      ... 等 ${guardianResult.fixes.length} 处修复`);
            }

            productionResult.prompts = guardianResult.prompts;

            // 同步 shots 中的 prompt
            for (const p of productionResult.prompts) {
              // 同步 shots（使用 DualArraySync O(1) 查找）
              this.dualSync.syncPromptsToShots('PromptGuardian', productionResult.shots, productionResult.prompts, ['prompt', 'promptCharCount']);
            }

            result.stages.promptGuardian = {
              fixes: guardianResult.fixes,
              safe: guardianResult.safe,
              fixCount: guardianResult.fixes.length
            };

            // P1-4: EventBus 记录 Prompt Guardian 事件
            this.eventBus.emit('guardian.completed', {
              layerId: 'layer-2-guardian',
              fixCount: guardianResult.fixes.length,
              safe: guardianResult.safe,
              timing: Date.now()
            });
          } else {
            console.log('   ✅ Prompt Guardian 检查通过,无需修复');
            result.stages.promptGuardian = {
              fixes: [],
              safe: true,
              fixCount: 0
            };
          }
        } catch (err) {
          console.warn(`   ⚠️ PromptGuardian 失败: ${err.message}`);
          result.errors.push({ stage: 'PromptGuardian', message: err.message });

          // P1-4: EventBus 记录失败事件
          this.eventBus.emit('guardian.failed', {
            layerId: 'layer-2-guardian',
            error: err.message,
            timing: Date.now()
          });
        }
      }

      // ⭐ v2.2.1-fix: 片头专属5字段在审核前生成，审核报告必须是完整30字段
      try {
        await this._optimizeOpeningTitle(productionResult, result, metadata);
      } catch (e) {
        console.warn(' ⚠️ 审核前片头优化异常（不阻断流程）:', e.message);
      }

      // ⭐ v2.8.0: 定妆照生成环节（PortraitStudio，审核前）
      // 角色按戏份重要性分级配角度；商品走独立分支链路（搜参考图→抠图/白底/光影→风格化）
      // 交互模式：输出计划 → 人工确认 → 执行；批量模式：免询问自动执行
      // 定妆照为增强交付项：失败/拒绝不阻断主流程
      try {
        const portraitCharacters = scriptResult?.character_system?.characters
          || scriptResult?.blueprint?.character_system?.characters
          || productionResult?.blueprint?.characters || [];
        const portraitProducts = metadata.products
          || metadata.brief?.products
          || (metadata.brief?.product ? [metadata.brief.product] : [])
          || (metadata.productHero ? [{ name: metadata.product || metadata.title, productHero: metadata.productHero }] : [])
          || [];

        const portraitStudio = new PortraitStudio({
          mode: (options.batchMode || options.autoConfirmPortraits) ? 'auto' : 'interactive',
          executor: options.portraitExecutor || 'spec',
          outputDir: path.join(__dirname, '..', 'deliverables', 'portraits')
        });

        const portraitPlan = portraitStudio.plan({
          characters: portraitCharacters,
          products: portraitProducts,
          prompts: productionResult.prompts || [],
          prd: result.stages.prdGeneration?.data || {},
          blueprint: result.stages.adapter || {},
          sceneContext: {
            typicalScene: result.stages.adapter?.typical_scene
              || result.stages.adapter?.world_setting
              || null
          }
        });

        if (portraitPlan.characterTasks.length > 0 || portraitPlan.productTasks.length > 0) {
          console.log('\n🖼️ [PortraitStudio] 定妆照生成计划已就绪');
          console.log(`   角色 ${portraitPlan.characterTasks.length} 个 / 商品 ${portraitPlan.productTasks.length} 个`);

          let portraitApproved = true;
          let portraitRejectedReason = null;

          if (portraitStudio.needsConfirmation() && !options.skipPortraitReview) {
            console.log('\n🖼️ [定妆照生成] 等待人工确认...');
            const portraitConfirmation = await this._waitForExternalConfirmation('portrait-generation', portraitPlan.summary);
            result.confirmations.portraitGeneration = portraitConfirmation;

            if (portraitConfirmation.waitTimeMs) {
              result.totalWaitTimeMs += portraitConfirmation.waitTimeMs;
              _extendDeadlineForWait(portraitConfirmation.waitTimeMs, '定妆照生成');
            }

            portraitApproved = portraitConfirmation.approved;
            if (!portraitApproved) {
              portraitRejectedReason = portraitConfirmation.reason || '用户未确认定妆照生成';
              console.log(`   ⏭️ 定妆照生成被跳过: ${portraitRejectedReason}（不阻断主流程）`);
            }
          } else {
            result.confirmations.portraitGeneration = {
              approved: true,
              skipped: true,
              reason: portraitStudio.mode === 'auto' ? '批量模式：系统自动决策生成定妆照' : 'skipPortraitReview 指定跳过确认'
            };
            console.log(`   ⚡ [定妆照生成] ${portraitStudio.mode === 'auto' ? '批量模式自动决策' : '确认已跳过'}，直接执行`);
          }

          if (portraitApproved) {
            const portraitExecResult = await portraitStudio.execute(portraitPlan, options.portraitRuntime || {});
            const portraitSet = portraitStudio.finalize(portraitPlan, {
              title: metadata.title || '未命名',
              runId: this._runId,
              generatedAt: new Date().toISOString()
            });

            result.stages.portraitStudio = {
              status: 'completed',
              mode: portraitStudio.mode,
              executor: portraitStudio.executorType,
              characters: portraitSet.stats.characterCount,
              products: portraitSet.stats.productCount,
              totalPortraits: portraitSet.stats.totalPortraits,
              completedPortraits: portraitSet.stats.completedPortraits,
              pendingPortraits: portraitSet.stats.pendingPortraits,
              errors: portraitExecResult.errors || []
            };

            // 固定交付项：定妆照集
            result.deliverables.portraitSet = {
              manifestPath: portraitSet.manifestPath,
              docPath: portraitSet.docPath,
              stats: portraitSet.stats,
              visualStyleAnchor: portraitSet.manifest.visualStyleAnchor
            };

            console.log(`   ✅ 定妆照集已交付: ${portraitSet.stats.characterCount} 角色 / ${portraitSet.stats.productCount} 商品 / 共 ${portraitSet.stats.totalPortraits} 张`);
            console.log(`      📄 ${portraitSet.docPath}`);
          } else {
            result.stages.portraitStudio = {
              status: 'skipped',
              reason: portraitRejectedReason
            };
          }
        } else {
          console.log('\n🖼️ [PortraitStudio] 未识别到需要定妆的角色或商品，跳过');
          result.stages.portraitStudio = { status: 'skipped', reason: 'no-characters-or-products' };
        }
      } catch (e) {
        console.warn(` ⚠️ 定妆照生成环节异常（不阻断流程）: ${e.message}`);
        result.stages.portraitStudio = { status: 'failed', error: e.message };
      }

      // ⭐ v2.2.1-fix: 定妆照双模式解析（审核前）
      try {
        console.log('\n🖼️ [PortraitResolver] 定妆照双模式解析...');
        const characters = scriptResult?.character_system?.characters
          || scriptResult?.blueprint?.character_system?.characters
          || productionResult?.blueprint?.characters || [];
        const portraitResolver = new PortraitResolver({
          charactersDir: path.join(__dirname, '..', 'characters')
        });
        // 【v2.8.0】优先消费 PortraitStudio 定妆照集产物，其次目录扫描，最后文字兜底
        let studioManifest = null;
        if (result.deliverables?.portraitSet?.manifestPath) {
          try {
            studioManifest = JSON.parse(fs.readFileSync(result.deliverables.portraitSet.manifestPath, 'utf8'));
          } catch (e) {
            console.warn(` ⚠️ 定妆照集 manifest 读取失败（回退目录扫描）: ${e.message}`);
          }
        }
        const resolved = portraitResolver.resolve(productionResult.prompts || [], characters, studioManifest);
        result.stages.portraitResolver = {
          bindings: resolved.bindings,
          studioCount: resolved.bindings.filter(b => b.mode === 'studio').length,
          uploadedCount: resolved.bindings.filter(b => b.mode === 'uploaded').length,
          textCount: resolved.bindings.filter(b => b.mode === 'text').length
        };
        console.log(` ✅ 定妆照解析完成: 定妆照集 ${result.stages.portraitResolver.studioCount} 个 / 上传 ${result.stages.portraitResolver.uploadedCount} 个 / 文字 ${result.stages.portraitResolver.textCount} 个`);
      } catch (e) {
        console.warn(` ⚠️ 定妆照解析失败（不阻断流程）: ${e.message}`);
      }

      // ========== 🆕 提示词审核确认环节 ==========
      if (!options.skipPromptReview) {
        console.log('\n📝 [提示词审核] 等待人工确认...');

        const promptConfirmation = await this._confirmPrompts(productionResult.prompts);
        result.confirmations.prompts = promptConfirmation;

        // 【v2.1.16-fix】累加等待时间并补偿全局截止（与其余三个确认点对齐）
        if (promptConfirmation.waitTimeMs) {
          result.totalWaitTimeMs += promptConfirmation.waitTimeMs;
          _extendDeadlineForWait(promptConfirmation.waitTimeMs, '提示词');
        }

        if (!promptConfirmation.approved) {
          console.log('   ❌ 提示词未确认,流程中止');
          result.success = false;
          result.stages.promptReview = {
            status: 'rejected',
            reason: promptConfirmation.reason || '用户未确认',
            issues: promptConfirmation.issues || []
          };
          return result;
        }

        console.log('   ✅ 提示词已确认,继续渲染');
      } else {
        console.log('\n⚠️ [提示词审核] 跳过(调试模式)');
        result.confirmations.prompts = { approved: true, skipped: true };
      }

      // ========== 🆕 Step 6: 预生产结果最终确认 ==========
      if (!options.skipPreproductionReview) {
        console.log('\n🎬 [Step 6] 预生产结果最终确认...');

        const preproductionConfirmation = await this._confirmPreproductionResult(
          productionResult,
          scriptResult,
          result.timing,
          result.confirmations
        );
        result.confirmations.preproduction = preproductionConfirmation;

        if (preproductionConfirmation.waitTimeMs) {
          result.totalWaitTimeMs += preproductionConfirmation.waitTimeMs;
          _extendDeadlineForWait(preproductionConfirmation.waitTimeMs, '预生产结果');
        }

        if (!preproductionConfirmation.approved) {
          console.log('   ❌ 预生产结果未确认,流程中止');
          result.success = false;
          result.stages.preproductionReview = {
            status: 'rejected',
            reason: preproductionConfirmation.reason || '用户未确认预生产结果',
            suggestions: preproductionConfirmation.suggestions || []
          };
          return result;
        }

        console.log('   ✅ 预生产结果已确认,进入渲染管线');
      } else {
        console.log('\n⚠️ [预生产结果确认] 跳过(调试模式)');
        result.confirmations.preproduction = { approved: true, skipped: true };
      }

      // ========== P1-2: Render Pipeline Guard 强制检查 ==========
      if (this.pipelineGuard.enabled) {
        console.log('\n🛡️ [PipelineGuard] 启动渲染管线检查...');
        try {
          const guardResult = this.pipelineGuard.check(productionResult.prompts, {
            strictMode: this.pipelineGuard.strictMode
          });

          result.stages.pipelineGuard = {
            pass: guardResult.pass,
            errorCount: guardResult.errors.length,
            warningCount: guardResult.warnings.length,
            errors: guardResult.errors,
            warnings: guardResult.warnings
          };

          if (!guardResult.pass) {
            console.error(`   ❌ 检查失败: ${guardResult.errors.length} 错误, ${guardResult.warnings.length} 警告`);
            for (const err of guardResult.errors.slice(0, 3)) {
              console.error(`      • [${err.ruleName}] ${err.promptId}: ${err.message}`);
              console.error(`        修复: ${err.fix}`);
            }
            if (guardResult.errors.length > 3) {
              console.error(`      ... 等 ${guardResult.errors.length} 个错误`);
            }

            if (this.pipelineGuard.strictMode) {
              console.error('   ⛔ 严格模式已启用,渲染被阻止');
              result.success = false;
              result.errors.push({ stage: 'PipelineGuard', message: `渲染管线检查未通过: ${guardResult.errors.length} 错误` });
              return result;
            } else {
              console.warn('   ⚠️ 非严格模式,继续渲染(可能产生问题)');
            }
          } else {
            if (guardResult.warnings.length > 0) {
              console.log(`   ✅ 检查通过 (${guardResult.warnings.length} 警告)`);
              for (const warn of guardResult.warnings) {
                console.log(`      🟡 [${warn.ruleName}] ${warn.promptId}: ${warn.message}`);
              }
            } else {
              console.log('   ✅ 检查通过,无错误无警告');
            }
          }

          // P1-4: EventBus 记录 Pipeline Guard 事件
          this.eventBus.emit('pipelineGuard.completed', {
            layerId: 'layer-3-guard',
            pass: guardResult.pass,
            errorCount: guardResult.errors.length,
            warningCount: guardResult.warnings.length,
            timing: Date.now()
          });
        } catch (err) {
          console.warn(`   ⚠️ PipelineGuard 失败: ${err.message}`);
          result.errors.push({ stage: 'PipelineGuard', message: err.message });

          // P1-4: EventBus 记录失败事件
          this.eventBus.emit('pipelineGuard.failed', {
            layerId: 'layer-3-guard',
            error: err.message,
            timing: Date.now()
          });
        }
      }

      // ========== Layer 3: 渲染引擎 ==========
      let renderResult = null;

      if (!options.skipRender) {
        try {
          console.log('\n🎨 [Layer 3] 渲染引擎 - 提交 Seedance...');
          const stage3Start = Date.now();

          // 【审计修复·全局预算协调】渲染前检查全局剩余预算，不足时显式跳过而非渲染到一半被外部杀掉
          const remainingForRender = globalDeadline - Date.now();
          if (remainingForRender <= 60000) {
            throw new Error(`全局预算耗尽(剩余 ${Math.max(0, Math.round(remainingForRender/1000))}s)，跳过渲染保产出物；Prompts 已生成，可单独提交渲染`);
          }
          console.log(` ⏱️ 全局预算: 渲染可用约 ${Math.round(remainingForRender/60000)} 分钟`);

          renderResult = await this.renderingEngine.render(productionResult.prompts, {
            // 【P0-9 修复】dryRun 仅由显式选项控制,不再因缺 apiKey 强制开启
            // 无 apiKey 时让渲染引擎自己抛错,暴露配置问题
            dryRun: options.dryRun === true,
            // 【2026-07-17 修复】Layer 3 创意指数配置下发（此前生成后无人消费）
            creativeIntensity: metadata._creativeIntensity || null
          });

          result.stages.renderingEngine = {
            render: renderResult,
            report: this.renderingEngine.generateReport(renderResult)
          };
          result.stages.renderingEngine.timing = Date.now() - stage3Start;

          console.log(`   ✅ 渲染完成 (${result.stages.renderingEngine.timing}ms)`);
          console.log(`      提交: ${renderResult.submitted}/${renderResult.results.length} | 失败: ${renderResult.failed}`);
        } catch (error) {
          result.errors.push({ layer: 'rendering-engine', error: error.message });
          console.warn(`\n⚠️ [Layer 3 失败] ${error.message}`);
          result.stages.renderingEngine = { error: error.message, skipped: false };
        }
      } else {
        console.log('\n⚠️ [渲染] 跳过(调试模式)');
        result.stages.renderingEngine = { skipped: true };
      }

      // ========== Layer 4: 后期引擎 ==========

      // 🐼 [PandaCineForge] F7: Layer 4 前 - 调色/混音/后期技能注入
      if (this.pandaAdapter.enabled) {
        console.log('\n🐼 [PandaCineForge] F7 后期技能注入...');
        try {
          const postSkills = await this.pandaAdapter.recall({
            call_id: `pcf_f7_${Date.now()}`,
            caller_agent: 'AudioDesign',
            route_fields: {
              module_target: ['MyStudio.AudioDesign'],
              cinematic_role: 'audio_design',
              deliverable_type: 'mix_plan',
              project_stage: 'postproduction',
              sub_domain: metadata.videoType || 'cinema'
            },
            context: {
              project_id: metadata.projectId || 'default',
              caller_agent: 'AudioDesign',
              upstream_deliverable: 'shotlist_v1'
            },
            query_text: `${(metadata._pandaVisualSkills?.skills || [])[0]?.name || '后期制作'} 调色 混音 剪辑`,
            recall_mode: 'fast',
            topk: 2
          });
          if (postSkills.status === 'hit' || postSkills.status === 'forged') {
            metadata._pandaPostSkills = postSkills;
            console.log(`   ✅ 后期技能注入: ${postSkills.skills?.length || 0} 个技能 | 来源: ${postSkills.source_layer}`);
          }
        } catch (err) {
          console.warn(`   ⚠️ PandaCineForge F7 失败: ${err.message}`);
        }
      }

      if (!options.skipPostProduction) {
        try {
          console.log('\n🎬 [Layer 4] 后期引擎 - 字幕/音乐/弹幕/多版本...');
          const stage4Start = Date.now();

          // 【2026-07-17 修复】Layer 4 创意指数配置下发（postProduce 无 options 参数，随 productionResult 携带）
          productionResult._creativeIntensity = metadata._creativeIntensity || null;

          const postResult = await this.postProductionEngine.postProduce(
            productionResult,
            scriptResult,
            renderResult || { success: false, results: [] }
          );

          result.stages.postProductionEngine = {
            success: postResult.success,
            versions: postResult.versions,
            stages: postResult.stages,
            report: this.postProductionEngine.generateReport(postResult)
          };
          result.stages.postProductionEngine.timing = Date.now() - stage4Start;

        console.log(`   ✅ 后期制作完成 (${result.stages.postProductionEngine.timing}ms)`);
        console.log(`      版本: ${Object.keys(postResult.versions).join(', ')}`);
        console.log(`      字幕: ${postResult.stages.subtitles?.count || 0}条 | 音乐: ${postResult.stages.music?.count || 0}段 | 弹幕: ${postResult.stages.danmaku?.count || 0}条`);
        } catch (error) {
          result.errors.push({ layer: 'post-production', error: error.message });
          console.warn(`\n⚠️ [Layer 4 失败] ${error.message}`);
          result.stages.postProductionEngine = { error: error.message, skipped: false };
        }
      } else {
        console.log('\n⚠️ [后期制作] 跳过(调试模式)');
        result.stages.postProductionEngine = { skipped: true };
      }

      // ========== 汇总 ==========
      // 【P0-8 修复】result.success 不再无条件置 true,基于各阶段实际状态聚合
      const hasRenderError = result.stages.renderingEngine?.error || (result.stages.renderingEngine?.render?.success === false && !result.stages.renderingEngine?.skipped);
      const hasPostProdError = result.stages.postProductionEngine?.error || (result.stages.postProductionEngine?.success === false && !result.stages.postProductionEngine?.skipped);
      const hasProductionError = productionResult?.success === false;
      result.success = result.errors.length === 0 && !hasRenderError && !hasPostProdError && !hasProductionError;
      if (result.errors.length > 0 || hasRenderError || hasPostProdError || hasProductionError) {
        result.degraded = true;
      }
      result.timing.total = Date.now() - totalStart;
      result.timing.effective = result.timing.total - result.totalWaitTimeMs; // 【v2.1.10-hotfix】有效时间 = 总时间 - 等待时间

      console.log(`\n🏁 [完成] 总耗时: ${result.timing.total}ms`);
      console.log(`   ⏱️ 等待确认时间: ${result.totalWaitTimeMs}ms (${Math.round(result.totalWaitTimeMs/60000)}分钟) — 不计入有效时间`);
      console.log(`   ⏱️ 有效处理时间: ${result.timing.effective}ms (${Math.round(result.timing.effective/60000)}分钟)`);
      console.log(`   状态: ${result.success ? '✅ 成功' : '❌ 失败'}`);

      // 生成最终报告
      result.finalReport = this._generateFinalReport(scriptResult, productionResult, result.stages.renderingEngine, result.stages.postProductionEngine, result.timing.total, result.confirmations);

      // ========== 🆕 最终导出前字段标准化(专家诊断建议)==========
      if (productionResult && productionResult.shots) {
        // v2.0.6: 先在FieldGuard之前处理片头字段(避免校验失败阻断)
        const adapter = result.stages?.adapter || {};
        // 【审计修复】统一片头判定,兼容 SC00/S00
        let openingShot = productionResult.shots.find(s => isOpeningShot(s));
        // 【v2.1.22-fix 片头字段丢失】兜底：isOpeningShot 识别不到时取第一个镜头，
        // 保证下方 OpeningTitleOptimizer 一定执行，片头 5 专属字段不再整体缺失
        if (!openingShot && productionResult.shots.length > 0) {
          openingShot = productionResult.shots[0];
          openingShot.sceneType = 'opening';
          console.warn(`⚠️ [FieldGuard] 未识别到片头镜头，兜底使用第一个镜头 ${openingShot.shotId || openingShot.shot_id} 作为片头`);
        }
        const openingShotId = openingShot ? (openingShot.shotId || openingShot.shot_id) : null; // 【v2.1.6-fix-bug40】缓存片头shotId
        if (openingShot) {
          // 如果片头缺少title/subtitle,先用adapter标题兜底
          if (!openingShot.title || openingShot.title === '未命名') {
            openingShot.title = adapter.title || '未命名';
          }
          if (!openingShot.subtitle) {
            const epNum = adapter._metadata?.episodeNumber || adapter._metadata?.series?.currentEpisode || 1;
            openingShot.subtitle = `第${epNum}集`;
          }
        }

        console.log('\n🛡️ [FieldGuard] 最终导出前标准化...');
        try {
          // 【v2.1.4-fix11-F】最终导出前严格检查:标记上下文
          productionResult.shots.forEach(s => s._context = 'Final-Export');

          // 【v2.1.4-fix11-G】片头优化必须在FieldGuard之前执行,确保片头字段被正确添加
          // 【审计修复】统一片头判定,兼容 SC00/S00
          // 【v2.1.6-fix-bug40】使用缓存的shotId重新查找，避免FieldGuard修改sceneType后选中不同shot
          openingShot = openingShotId
            ? productionResult.shots.find(s => (s.shotId || s.shot_id) === openingShotId)
            : productionResult.shots.find(s => isOpeningShot(s));
          // 【v2.2.1-fix】幂等守卫：审核前已完成片头优化则跳过，避免元数据污染
          if (openingShot && !openingShot.title_content) {
            console.log('\n🎬 [OpeningTitleOptimizer] 片头专属字段优化...');
            try {
              const optimizer = new OpeningTitleOptimizer({
                llmTimeout: 120000,
                llmMaxRetries: 2,
                llmModel: process.env.STORMAXE_LLM_FAST_MODEL || process.env.STORMAXE_LLM_MODEL || 'kimi-k2p6'
              });
              // 【P2-10 修复】下发 deadline,防止不受控挂起
              optimizer.setDeadline(Date.now() + 180000); // 3分钟总体预算
              const blueprint = result.stages?.adapter || { title: result.title || '未命名' };
              const optimized = await optimizer.optimize(openingShot, blueprint);

              if (!optimized.degraded) {
                // 【v2.1.4-fix12】直接修改 openingShot 的顶层属性(standardOutput 是扁平结构)
                openingShot.title_content = optimized.title_content;
                openingShot.subtitle_content = optimized.subtitle_content;
                openingShot.title_animation = optimized.title_animation;
                openingShot.title_font_design = optimized.title_font_design;
                openingShot.opening_audio_design = optimized.opening_audio_design;

                openingShot.title = optimized.title_content || openingShot.title;
                openingShot.subtitle = optimized.subtitle_content || openingShot.subtitle;

                // v2.1.5-fix: 同步到 prompts[0],确保双数组一致
                if (productionResult.prompts && productionResult.prompts.length > 0) {
                  const promptOpening = productionResult.prompts.find(p => isOpeningShot(p)) || productionResult.prompts[0]; // 【v2.1.22-fix】兜底取第一个 prompt，保证片头字段同步不丢失
                  if (promptOpening) {
                    promptOpening.title_content = optimized.title_content;
                    promptOpening.subtitle_content = optimized.subtitle_content;
                    promptOpening.title_animation = optimized.title_animation;
                    promptOpening.title_font_design = optimized.title_font_design;
                    promptOpening.opening_audio_design = optimized.opening_audio_design;
                    promptOpening.title = optimized.title_content || promptOpening.title;
                    promptOpening.subtitle = optimized.subtitle_content || promptOpening.subtitle;
                  }
                }

                console.log('   ✅ 片头优化完成');
                console.log('   主标题:', optimized.title_content);
                console.log('   副标题:', optimized.subtitle_content);
              } else {
                // 【v2.1.4-fix13】降级时也要补全全部 5 个字段(用 optimized 返回的 fallback 值)
                console.warn('   ⚠️ 片头优化降级,使用 fallback 值补全全部5字段');
                openingShot.title_content = optimized.title_content || openingShot.title_content || result.title || '未命名';
                openingShot.subtitle_content = optimized.subtitle_content || openingShot.subtitle_content || '第1集';
                // 【v2.1.4-fix13】补全剩余 3 个字段(之前被丢弃)
                openingShot.title_animation = optimized.title_animation || '主标题淡入入场,副标题延迟0.5秒跟随淡入,整体2秒';
                openingShot.title_font_design = optimized.title_font_design || '粗体无衬线字体,白色,带微阴影';
                openingShot.opening_audio_design = optimized.opening_audio_design || '环境音渐起,配合标题入场';

                openingShot.title = openingShot.title_content;
                openingShot.subtitle = openingShot.subtitle_content;

                // v2.1.5-fix: 降级分支也同步到 prompts
                if (productionResult.prompts && productionResult.prompts.length > 0) {
                  const promptOpening = productionResult.prompts.find(p => isOpeningShot(p)) || productionResult.prompts[0]; // 【v2.1.22-fix】兜底取第一个 prompt，保证片头字段同步不丢失
                  if (promptOpening) {
                    promptOpening.title_content = openingShot.title_content;
                    promptOpening.subtitle_content = openingShot.subtitle_content;
                    promptOpening.title_animation = openingShot.title_animation;
                    promptOpening.title_font_design = openingShot.title_font_design;
                    promptOpening.opening_audio_design = openingShot.opening_audio_design;
                    promptOpening.title = openingShot.title;
                    promptOpening.subtitle = openingShot.subtitle;
                  }
                }
              }
            } catch (e) {
              console.warn('   ⚠️ 片头优化失败:', e.message);
              // 【v2.1.4-fix13】异常时也要补全全部 5 个字段,不能留空
              openingShot.title_content = openingShot.title_content || result.title || '未命名';
              openingShot.subtitle_content = openingShot.subtitle_content || '第1集';
              openingShot.title_animation = openingShot.title_animation || '主标题淡入入场,副标题延迟0.5秒跟随淡入,整体2秒';
              openingShot.title_font_design = openingShot.title_font_design || '粗体无衬线字体,白色,带微阴影';
              openingShot.opening_audio_design = openingShot.opening_audio_design || '环境音渐起,配合标题入场';

              // v2.1.5-fix: 异常分支也同步到 prompts
              if (productionResult.prompts && productionResult.prompts.length > 0) {
                const promptOpening = productionResult.prompts.find(p => isOpeningShot(p)) || productionResult.prompts[0]; // 【v2.1.22-fix】兜底取第一个 prompt，保证片头字段同步不丢失
                if (promptOpening) {
                  promptOpening.title_content = openingShot.title_content;
                  promptOpening.subtitle_content = openingShot.subtitle_content;
                  promptOpening.title_animation = openingShot.title_animation;
                  promptOpening.title_font_design = openingShot.title_font_design;
                  promptOpening.opening_audio_design = openingShot.opening_audio_design;
                }
              }
            }
          }

          // 【审计修复】无论优化成功/降级/异常,进入 FieldGuard 前强制确保5字段非空,防止严格校验 throw 丢字段
          if (openingShot) {
            const openingDefaults = {
              title_content: openingShot.title_content || openingShot.title || result.title || '未命名',
              subtitle_content: openingShot.subtitle_content || openingShot.subtitle || '第1集',
              title_animation: openingShot.title_animation || '主标题淡入入场,副标题延迟0.5秒跟随淡入,整体2秒',
              title_font_design: openingShot.title_font_design || '粗体无衬线字体,白色,带微阴影',
              opening_audio_design: openingShot.opening_audio_design || '环境音渐起,配合标题入场'
            };
            Object.assign(openingShot, openingDefaults);
            // 同步 title/subtitle 顶层字段
            openingShot.title = openingShot.title || openingShot.title_content;
            openingShot.subtitle = openingShot.subtitle || openingShot.subtitle_content;
            openingShot.sceneType = 'opening'; // 【v2.1.22-fix】强制修正：已选定它就是片头，旧值（如 hook）一律覆盖
          }

          // v1.2.6-fix5: 只对 shots 做标准化,不要用 normalized.shots 覆盖 prompts          // v1.2.6-fix5: 只对 shots 做标准化,不要用 normalized.shots 覆盖 prompts          // v1.2.6-fix5: 只对 shots 做标准化,不要用 normalized.shots 覆盖 prompts
          const normalized = this.fieldGuard.normalizeAndValidate(productionResult.shots, 'Final-Export');
          productionResult.shots = normalized.shots;

          // v1.2.6-fix5: prompts 保持原样(它们已经是标准输出对象),不再被 shots 覆盖
          // productionResult.prompts = normalized.shots; // ❌ 删除此行

          // v1.2.6-fix5: shots 摘要改用标准输出字段(duration 而非 timing)
          // v2.0.6: 包含片头专属字段
          result.stages.productionEngine.shots = normalized.shots.map(s => ({
            shotId: s.shotId,
            sceneType: s.sceneType || '',
            duration: s.duration || s.timing?.duration || 0,
            promptLength: typeof s.prompt === 'string' ? s.prompt.length : (s.promptCharCount || 0),
            status: s.status || 'completed',
            // v2.0.6: 片头专属字段(从顶层属性提取,OpeningTitleOptimizer写入)
            ...(s.title_content ? {
              title_content: s.title_content,
              subtitle_content: s.subtitle_content,
              title_animation: s.title_animation,
              title_font_design: s.title_font_design,
              opening_audio_design: s.opening_audio_design
            } : {}),
            // v2.0.6: 包含fields中的标准字段
            ...(s.fields || {})
          }));
          console.log('   ✅ 最终导出字段标准化通过');
          this.fieldGuard.printShotSummary(normalized.shots, 'Final-Export');

        } catch (err) {
          console.error(`   ❌ 最终字段校验失败: ${err.message}`);
          result.errors.push({ stage: 'FieldGuard-Final', message: err.message });
        }
      }

    } catch (error) {
      result.success = false;
      result.errors.push({
        stage: 'HYPERREALITY_SYSTEM',
        message: error.message,
        stack: error.stack
      });
      console.error(`\n❌ [系统错误] ${error.message}`);
    } finally {
      // 【v2.1.6-fix】关闭长时间任务模式
      this.stabilityShield.setLongTaskMode('ProductionEngine', false);
      // 【v2.1.6-fix】清理 EventBus 会话监听器，防止内存泄漏
      if (this.eventBus && typeof this.eventBus.clearSessionListeners === 'function') {
        this.eventBus.clearSessionListeners();
      }
      // 【v2.1.12-fix 多进程竞态修复】结束运行身份并释放单实例锁
      try {
        if (this._runId) runCoordinator.finishRun(this._runId);
        this._runId = null;
        this._activeRun = null;
        runCoordinator.releaseLock();
      } catch (_) { /* 收尾阶段静默 */ }
    }

    // 【v2.1.4-fix13-审计修复】将完整 shots/prompts/opening 挂到 result,供调用方获取完整数据
    if (typeof productionResult !== 'undefined' && productionResult) {
      result.shots = productionResult.shots || [];
      result.prompts = productionResult.prompts || [];
      result.opening = productionResult.opening || null;
      result.degraded = productionResult.degraded || false;
    }

    // ========== P1-5: Pipeline Logger 全链路日志留档 ==========
    if (this.pipelineLogger.enabled) {
      try {
        const sessionDir = this.pipelineLogger.save(result, {
          title: metadata.title || 'untitled',
          version: this.version,
          intent,
          timestamp: new Date().toISOString()
        });
        console.log(`\n💾 [PipelineLogger] 结果已保存: ${sessionDir}`);
        // 【2026-07-17 清理】_sessionDir 写后无人读，删除
      } catch (err) {
        console.warn(`   ⚠️ PipelineLogger 失败: ${err.message}`);
        result.errors.push({ stage: 'PipelineLogger', message: err.message });
      }
    }

    // ========== P2-4: Requirement Alignment Gate 需求对齐闸机 ==========
    if (this.requirementAlignmentGate.enabled) {
      console.log('\n🔍 [RequirementAlignmentGate] 需求对齐验证...');
      try {
        const alignmentResult = this.requirementAlignmentGate.validate(intent, metadata, result);

        result.stages.requirementAlignment = {
          pass: alignmentResult.pass,
          score: alignmentResult.score,
          missing: alignmentResult.missing,
          report: alignmentResult.report
        };

        if (!alignmentResult.pass) {
          console.warn(`   ⚠️ 需求对齐未通过: ${(alignmentResult.score * 100).toFixed(0)}%`);
          if (alignmentResult.missing.length > 0) {
            console.warn(`   缺失: ${alignmentResult.missing.slice(0, 3).join(' | ')}`);
          }

          if (this.requirementAlignmentGate.strictMode) {
            console.error('   ⛔ 严格模式已启用,阻止最终返回');
            result.success = false;
            result.errors.push({ stage: 'RequirementAlignmentGate', message: `需求对齐未通过: ${(alignmentResult.score * 100).toFixed(0)}%` });
          }
        } else {
          console.log(`   ✅ 需求对齐通过: ${(alignmentResult.score * 100).toFixed(0)}%`);
        }

        // P1-4: EventBus 记录
        this.eventBus.emit('requirementAlignment.completed', {
          layerId: 'final-gate',
          pass: alignmentResult.pass,
          score: alignmentResult.score,
          timing: Date.now()
        });
      } catch (err) {
        console.warn(`   ⚠️ RequirementAlignmentGate 失败: ${err.message}`);
        result.errors.push({ stage: 'RequirementAlignmentGate', message: err.message });

        this.eventBus.emit('requirementAlignment.failed', {
          layerId: 'final-gate',
          error: err.message,
          timing: Date.now()
        });
      }
    }

    // 🐼 [PandaCineForge] Phase 5: 反馈飞轮 — 驱动技能成熟度进化
    if (this.pandaAdapter.enabled) {
      try {
        const outcome = result.success ? 'success' : 'failed';
        const qualityScore = result.success ? 85 : 40;
        const failureReasons = result.errors.length > 0 ? result.errors.map(e => e.message || e.error || String(e)) : undefined;
        
        // 对本次注入的技能进行反馈回传
        const skillsToFeedback = [
          (metadata._pandaSkillHints?.skills || [])[0]?.skill_id,
          (metadata._pandaScriptSkills?.skills || [])[0]?.skill_id,
          (metadata._pandaVisualSkills?.skills || [])[0]?.skill_id,
          (metadata._pandaPostSkills?.skills || [])[0]?.skill_id,
          (metadata._pandaDirectorSkills?.skills || [])[0]?.skill_id,
          (metadata._pandaEmotionSkills?.skills || [])[0]?.skill_id,
          (metadata._pandaVerticalSkills?.skills || [])[0]?.skill_id,
        ].filter(Boolean);

        if (skillsToFeedback.length > 0) {
          console.log(`\n🐼 [PandaCineForge] 反馈飞轮: ${skillsToFeedback.length} 个技能`);
          for (const skillId of skillsToFeedback) {
            // 【v2.1.6-fix】包装为 Promise 防止同步抛出未被捕获
            Promise.resolve()
              .then(() => this.pandaAdapter.reportFeedback(skillId, outcome, qualityScore, failureReasons))
              .then(fb => {
                if (fb.status === 'feedback_recorded') {
                  console.log(`   ✅ 技能反馈: ${skillId.substring(0, 20)}... | maturity: ${fb.maturity}`);
                }
              })
              .catch(err => {
                // 静默失败，不影响主流程
              });
          }
        }
      } catch (err) {
        // 反馈失败不影响主流程
      }
    }

    // 清除长时间任务模式
    this.stabilityShield.setLongTaskMode('ProductionEngine', false);

    return result;
  }

  /**
   * ⭐ v2.1.7: 创意主题确认环节(Layer -1)
   * 类似需求清单确认，但针对创意主题
   */
  async _confirmCreativeTheme(themeResult) {
    console.log('\n--- 🎨 创意主题确认 ---');
    
    const task = themeResult.tasks[0];
    const summary = this.creativeThemeGenerator.generateConfirmationSummary(themeResult);
    console.log(summary);
    console.log('\n---');

    // 写入文件并等待外部确认
    const confirmPath = await this._waitForExternalConfirmation('creative-theme', summary);

    if (confirmPath.approved) {
      console.log('   ✅ 创意主题已确认');
    } else {
      console.log('   ❌ 创意主题被拒绝:', confirmPath.reason);
    }

    return {
      approved: confirmPath.approved,
      reviewedAt: new Date().toISOString(),
      theme: task,
      reason: confirmPath.reason,
      suggestions: confirmPath.suggestions,
      adjustments: confirmPath.adjustments,
      waitTimeMs: confirmPath.waitTimeMs // 【v2.1.10-hotfix】传递等待时间
    };
  }

  /**
   * 🆕 v2.1.8: 将需求洞察结果转换为 RequirementList 格式（兼容下游）
   * 【v2.1.11-重构】类型字段双轨化：
   * - genre：开放题材，原样透传（不再被映射表圈死/掉EDU）
   * - profile：生产画像，由 ProfileResolver 生成，驱动下游决策
   * - videoType：降级为"展示用预设标签"（closestPreset 推导，仅用于日志/报告/旧链路兼容）
   */
  async _convertDiscoveryToRequirementList(discoveryResult, upstreamFields) {
    const { audienceProfile, sceneStructure, riskAssessment, referenceCases } = discoveryResult;

    // 生成生产画像（三级兜底，永不失败）
    if (!this._profileResolver) {
      const { ProfileResolver } = require('./engines/script-engine/core/profile-resolver');
      // 【v2.1.11-fix】llmEngine 从 options 或 productionEngine 获取（非 this.llmEngine）
      const llmEngine = this.options?.productionEngine?.agentConfig?.llmEngine 
        || this.options?.llmEngine 
        || null;
      this._profileResolver = new ProfileResolver({ llmEngine });
    }
    const resolved = await this._profileResolver.resolve({
      theme: upstreamFields.theme,
      description: upstreamFields.description,
      type: upstreamFields.type // 用户声明的题材（含自定义类型），原样保留
    });

    return {
      // 【新】双轨字段
      genre: resolved.genre, // 开放题材（'宠物殡葬纪实'原样保留）
      genreConfidence: resolved.genreConfidence,
      productionProfile: resolved.profile, // 生产画像（下游决策唯一依据）

      // 【旧字段保留，但语义降级】仅用于展示/旧链路兼容，不再做决策
      videoType: resolved.presetRef, // 最接近的预设标签（展示用）
      videoTypeName: resolved.genre, // 展示名直接用 genre
      videoTypeInferred: resolved.profileSource !== 'llm',

      title: upstreamFields.theme || '未命名项目',
      // 【v2.1.10-fix 时长断层】创意主题已人工确认的 duration_sec 是时长唯一权威来源，
      // 必须优先于 ProfileResolver 的推断值（LLM 画像会自由发挥，本次事故即把 45s 改成 120s）
      targetDuration: (() => {
        const confirmed = Number(upstreamFields.duration_sec);
        if (Number.isFinite(confirmed) && confirmed > 0) return confirmed;
        return resolved.profile.duration_target;
      })(),
      durationRange: (() => {
        const base = Number(upstreamFields.duration_sec) > 0
          ? Number(upstreamFields.duration_sec)
          : resolved.profile.duration_target;
        return [Math.round(base * 0.8), Math.round(base * 1.2)];
      })(),
      style: {
        primary: 'CINE',
        secondary: [],
        description: upstreamFields.visual_style || '电影级质感'
      },
      aspectRatio: resolved.profile.aspect_ratio,
      // 【审计修复】platform 此前硬编码, 改为从受众兴趣标签推断(无命中时保持默认)
      platform: (() => {
        const tags = (audienceProfile?.primaryAudience?.interestTags || []).join(',');
        const hits = ['抖音', 'B站', '小红书', '视频号', '快手', 'YouTube'].filter(p => tags.includes(p));
        return hits.length ? hits.join('/') : '视频号/抖音';
      })(),
      // 【2026-07-17 修复】worldSetting 显式透传（原只藏在 _analysis 且该键不存在，桥接恒失效）
      worldSetting: resolved.profile?.world_setting || upstreamFields.world_setting || 'default',
      creativeIntensity: upstreamFields.creative_style || 0.72,
      // 【审计修复】narrativeMode 此前硬编码 'dialogue', 无台词类主题会被误导
      narrativeMode: resolved.profile.dialogue_density === 'none' || /无台词|无对白|旁白|纯画面|narration|voiceover/i.test(upstreamFields.dialogue_requirement || '')
        ? 'narration'
        : 'dialogue',
      characters: [],
      structure: {
        opening: sceneStructure?.opening?.purpose || '开场引入',
        scenes: sceneStructure?.scenes?.map(s => s.purpose) || ['主体内容'],
        ending: sceneStructure?.ending?.purpose || '总结收尾'
      },
      keyPoints: [
        upstreamFields.description || '',
        upstreamFields.special_notes || ''
      ].filter(Boolean),
      // 【审计修复】以下 4 个创意主题字段此前在转换中被丢弃, 导致下游无法感知情绪/难度/受众/台词要求
      tone: upstreamFields.tone || null,
      difficulty: upstreamFields.difficulty || null,
      targetAudience: upstreamFields.target_audience || null,
      dialogueRequirement: upstreamFields.dialogue_requirement || null,
      contentConstraints: riskAssessment?.businessConstraints || [],
      specialConstraints: resolved.profile.special_constraints,
      uncertainties: [],
      _analysis: {
        confidence: 0.8,
        source: 'requirementDiscoveryEngine'
      }
    };
  }

  /**
   * 🆕 需求清单确认(Layer 0)
   * v1.2.5: 支持外部确认--输出文件后等待队长确认
   */
  async _confirmRequirementList(markdown, requirementList) {
    console.log('\n--- 📋 需求清单确认 ---');
    console.log(markdown);
    console.log('\n---');

    // v1.2.5: 写入文件并等待外部确认
    const confirmPath = await this._waitForExternalConfirmation('requirement', markdown);

    if (confirmPath.approved) {
      console.log('   ✅ 需求清单已确认');
    } else {
      console.log('   ❌ 需求清单被拒绝:', confirmPath.reason);
    }

    return {
      approved: confirmPath.approved,
      reviewedAt: new Date().toISOString(),
      requirementList: requirementList,
      reason: confirmPath.reason,
      suggestions: confirmPath.suggestions,
      waitTimeMs: confirmPath.waitTimeMs // 【v2.1.10-hotfix】传递等待时间
    };
  }

  /**
   * PRD 产品需求文档确认环节
   * v2.1.9: 新增 Step 3.5 确认
   */
  async _confirmPRD(markdown, prd) {
    console.log('\n--- 📋 PRD 产品需求文档确认 ---');
    console.log(markdown);
    console.log('\n---');

    // 写入文件并等待外部确认
    const confirmPath = await this._waitForExternalConfirmation('prd', markdown);

    if (confirmPath.approved) {
      console.log('   ✅ PRD 已确认');
    } else {
      console.log('   ❌ PRD 被拒绝:', confirmPath.reason);
    }

    return {
      approved: confirmPath.approved,
      reviewedAt: new Date().toISOString(),
      prd: prd,
      reason: confirmPath.reason,
      suggestions: confirmPath.suggestions,
      waitTimeMs: confirmPath.waitTimeMs // 【v2.1.10-hotfix】传递等待时间
    };
  }

  /**
   * 提示词确认环节
   * v1.2.5: 支持外部确认
   */

  /**
   * ⭐ v2.2.1-fix: 审核前片头专属5字段优化（此前仅调用未定义，导致标题动画字段停留占位符）
   * 幂等：5 字段齐全且非占位符则跳过
   */
  async _optimizeOpeningTitle(productionResult, result, metadata) {
    const shots = productionResult?.shots || [];
    const isOpening = (s) => s && (s.sceneType === 'opening' || /^(S?C?00($|-|_)|OP|opening|intro)/i.test(String(s.shotId || s.shot_id || '')));
    const openingShot = shots.find(isOpening) || shots[0];
    if (!openingShot) return;
    const hasReal = (v) => typeof v === 'string' && v.length > 0 && !v.includes('待片头优化器生成') && !v.includes('需单独配置');
    if (hasReal(openingShot.title_animation) && hasReal(openingShot.title_content) && hasReal(openingShot.subtitle_content)
      && hasReal(openingShot.title_font_design) && hasReal(openingShot.opening_audio_design)) {
      return; // 已完整，幂等跳过
    }
    console.log('\n🎬 [OpeningTitleOptimizer] 审核前片头专属字段优化...');
    const optimizer = new OpeningTitleOptimizer({
      llmTimeout: 120000,
      llmMaxRetries: 2,
      llmModel: process.env.STORMAXE_LLM_FAST_MODEL || process.env.STORMAXE_LLM_MODEL || 'kimi-k2p6'
    });
    optimizer.setDeadline(Date.now() + 180000);
    const themeMeta = metadata?._creativeTheme || {};
    const blueprint = (result?.stages?.adapter && Object.keys(result.stages.adapter).length > 0)
      ? result.stages.adapter
      : { title: result?.title || metadata?.title || themeMeta.theme || '未命名',
          type: metadata?.type || themeMeta.type,
          target_audience: metadata?.target_audience || themeMeta.target_audience };
    const optimized = await optimizer.optimize(openingShot, blueprint);
    if (optimized && !optimized.degraded) {
      openingShot.title_content = optimized.title_content;
      openingShot.subtitle_content = optimized.subtitle_content;
      openingShot.title_animation = optimized.title_animation;
      openingShot.title_font_design = optimized.title_font_design;
      openingShot.opening_audio_design = optimized.opening_audio_design;
      openingShot.title = optimized.title_content || openingShot.title;
      openingShot.subtitle = optimized.subtitle_content || openingShot.subtitle;
      if (productionResult.prompts && productionResult.prompts.length > 0) {
        const promptOpening = productionResult.prompts.find(isOpening) || productionResult.prompts[0];
        if (promptOpening) {
          promptOpening.title_content = optimized.title_content;
          promptOpening.subtitle_content = optimized.subtitle_content;
          promptOpening.title_animation = optimized.title_animation;
          promptOpening.title_font_design = optimized.title_font_design;
          promptOpening.opening_audio_design = optimized.opening_audio_design;
          promptOpening.title = optimized.title_content || promptOpening.title;
          promptOpening.subtitle = optimized.subtitle_content || promptOpening.subtitle;
          // 【fix】回写已固化的 prompt 文本，保证5字段与优化器结果一致
          if (typeof promptOpening.prompt === 'string') {
            const fieldMap = [
              ['主标题内容', optimized.title_content],
              ['副标题内容', optimized.subtitle_content],
              ['标题动画设计', optimized.title_animation],
              ['标题字体设计', optimized.title_font_design],
              ['开场音频设计', optimized.opening_audio_design]
            ];
            for (const [label, value] of fieldMap) {
              if (!value) continue;
              const re = new RegExp(`【${label}】[^|【]*`);
              if (re.test(promptOpening.prompt)) {
                promptOpening.prompt = promptOpening.prompt.replace(re, `【${label}】${value} `);
              } else {
                promptOpening.prompt += ` | 【${label}】${value}`;
              }
            }
          }
        }
      }
      console.log(' ✅ 审核前片头优化完成 | 主标题:', optimized.title_content);
    } else {
      console.warn(' ⚠️ 审核前片头优化降级，使用 fallback 补全5字段');
      openingShot.title_content = openingShot.title_content || result?.title || '未命名';
      openingShot.subtitle_content = openingShot.subtitle_content || '第1集';
      openingShot.title_animation = optimized?.title_animation || '主标题以动效模式入场（0-20% 钩子悬念 → 20-60% 标题成型为情绪峰值 → 60-100% 定格收束），副标题延迟 0.5 秒跟进，整体 3-5 秒';
      openingShot.title_font_design = openingShot.title_font_design || '粗体无衬线字体,白色,带微阴影';
      openingShot.opening_audio_design = openingShot.opening_audio_design || '环境音渐起,配合标题入场';
    }
  }

  /**
   * ⭐ v2.2.1-fix: LLM 引擎自动接线 —— 禁止静默降级为本地规则
   */
  _resolveLLMEngine(options = {}) {
    const injected = options.llmEngine || options.productionEngine?.agentConfig?.llmEngine;
    if (injected) {
      console.log('[LLM接线] 使用调用方注入的 LLM 引擎');
      return injected;
    }
    try {
      const { LLMEngine } = require('../systems/llm-reasoning-engine');
      const fs = require('fs');
      const hasKey = !!(process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY
        || process.env.KIMI_PLUGIN_API_KEY || process.env.OPENCLAW_CONFIG
        || fs.existsSync('/root/.openclaw/openclaw.json'));
      if (!hasKey) {
        console.warn('⚠️ [LLM接线] 未检测到任何 LLM 凭据，LLM 驱动环节将显式降级');
        return null;
      }
      const engine = new LLMEngine({
        model: process.env.STORMAXE_LLM_MODEL || 'kimi-k2p6',
        maxTokens: 32000,
        timeoutMs: 600000
      });
      console.log(`[LLM接线] 已按环境配置自动创建 LLM 引擎 | model=${engine.model}`);
      return engine;
    } catch (e) {
      console.warn(`⚠️ [LLM接线] LLM 引擎自动创建失败: ${e.message}`);
      return null;
    }
  }

  /**
   * 生成最小可用 PRD(fallback)
   * v2.1.9: 当 PRD 生成失败时提供兜底
   */
  _generateMinimalPRD(discoveryResult) {
    const { upstreamFields } = discoveryResult;
    const type = upstreamFields?.type || '通用';
    const theme = upstreamFields?.theme || '未指定';
    const duration = upstreamFields?.duration_sec || 52;
    
    return {
      projectDefinition: {
        projectId: 'fallback_' + Date.now(),
        projectName: theme,
        version: '1.0.0',
        createdAt: new Date().toISOString(),
        sourceIntent: theme
      },
      productPositioning: {
        productType: '剧情短片',
        genre: type,
        targetPlatform: '通用',
        targetDuration: duration,
        aspectRatio: '16:9',
        resolution: '1080p',
        frameRate: 24
      },
      creativeCore: {
        coreTheme: theme,
        creativeHook: `${theme} - 前3秒视觉抓眼`,
        emotionalArc: 'setup→rising→climax→falling→resolution',
        keyMessages: ['核心信息'],
        twistPoint: '',
        endingType: '闭合式'
      },
      visualSpecification: {
        primaryStyle: '电影级写实',
        colorPalette: { dominant: '自然色调', accent: '暖色', mood: '中性' },
        lightingDirection: '自然光',
        cameraLanguage: '稳定运镜',
        visualReferences: [theme],
        textureQuality: '写实',
        specialVisualEffects: []
      },
      audioSpecification: {
        musicStyle: '环境音乐',
        soundDesign: '环境音效',
        voicePolicy: '环境音为主',
        audioMood: '中性',
        audioReferences: []
      },
      characterSystem: { characters: [] },
      scenePlan: { scenes: [], shotMapping: [] },
      productionConstraints: {
        technicalConstraints: ['保持视觉一致性'],
        businessConstraints: ['符合平台规范'],
        forbiddenElements: ['低质量'],
        qualityThresholds: { visual: 0.75, audio: 0.70, narrative: 0.75, consistency: 0.70 },
        modelCapabilityBounds: {
          maxPromptComplexity: 'moderate',
          supportedEffects: ['基础调色'],
          consistencyStrategy: 'textual-description'
        }
      },
      audienceProfile: {
        primaryAudience: { ageRange: '25-30', gender: 'all', interests: ['通用'], consumptionLevel: 'medium' },
        emotionTriggers: ['好奇心'],
        contentExpectations: ['高质量内容']
      },
      referenceCases: {
        filmReferences: [theme],
        adReferences: [],
        styleReferences: ['通用风格']
      },
      deliveryStandard: {
        deliverables: [{ item: 'video_master', spec: 'MP4/H.264, 1080p', priority: 'required' }],
        acceptanceCriteria: { visual: 0.75, audio: 0.70, narrative: 0.75, consistency: 0.70 },
        outputFormat: { videoCodec: 'H.264', audioCodec: 'AAC', container: 'MP4' },
        revisionPolicy: { maxRevisions: 1, revisionScope: ['visual'] },
        fallbackPlan: { trigger: '质量低于阈值', action: '降低复杂度', expectedOutput: '保证可交付' },
        continuityCheckpoints: [{ checkpoint: 'scene-logic', validationMethod: '场景逻辑检查' }]
      },
      budgetProfile: {
        qualityTier: 'standard',
        computeBudget: { maxCalls: 5, estimatedCost: 1.0 },
        tokenBudget: { maxTokens: 5000, allocatedAgents: { creativeDirection: 1000, productionSpecification: 2000, promptFusion: 1500, qualityCheck: 500 } },
        apiCallBudget: { totalCalls: 8, services: [{ service: 'video_generation', maxCalls: 5 }, { service: 'llm_text', maxCalls: 3 }] },
        degradationPath: [{ trigger: '算力超支', action: '降低质量', impact: '视觉下降15%' }]
      },
      prdSummary: {
        title: theme,
        type: '剧情短片 | ' + type,
        duration: duration + '秒',
        scenes: '0 场景 / 0 预估镜头',
        characters: '无角色',
        qualityTier: 'standard',
        keyHook: theme.slice(0, 30) + '...',
        deliverables: ['video_master'],
        humanReadable: `${theme} (剧情短片/${type}, ${duration}秒) - 0场景/0镜头, 0角色, 品质档:standard, 核心钩子:${theme.slice(0, 30)}...`
      }
    };
  }
  async _confirmPrompts(prompts) {
    // 生成提示词报告供审阅
    const promptReport = this._generatePromptsReport(prompts);

    // v1.2.5: 写入文件并等待外部确认
    const confirmPath = await this._waitForExternalConfirmation('prompt', promptReport);

    if (confirmPath.approved) {
      console.log('   ✅ 提示词已确认');
    } else {
      console.log('   ❌ 提示词被拒绝:', confirmPath.reason);
    }

    return {
      approved: confirmPath.approved,
      reviewedAt: new Date().toISOString(),
      report: promptReport,
      reason: confirmPath.reason,
      suggestions: confirmPath.suggestions,
      waitTimeMs: confirmPath.waitTimeMs // 【v2.1.16-fix】透传等待时间用于全局截止补偿
    };
  }

  async _confirmPreproductionResult(productionResult, scriptResult, timing, confirmations) {
    // Step 6: 预生产结果最终确认
    const report = this._generatePreproductionReport(productionResult, scriptResult, timing, confirmations);

    const confirmPath = await this._waitForExternalConfirmation('preproduction', report);

    if (confirmPath.approved) {
      console.log('   ✅ 预生产结果已确认,进入渲染阶段');
    } else {
      console.log('   ❌ 预生产结果被拒绝:', confirmPath.reason);
    }

    return {
      approved: confirmPath.approved,
      reviewedAt: new Date().toISOString(),
      report,
      reason: confirmPath.reason,
      suggestions: confirmPath.suggestions,
      waitTimeMs: confirmPath.waitTimeMs
    };
  }

  _generatePreproductionReport(productionResult, scriptResult, timing, confirmations) {
    const lines = [];
    lines.push('# 🎬 预生产结果报告');
    lines.push('');
    lines.push(`**镜头总数**: ${productionResult.shots?.length || 0}`);
    lines.push(`**总时长**: ${productionResult.shots?.reduce((s, sh) => s + (sh.duration || 0), 0) || 0} 秒`);
    lines.push(`**角色数**: ${scriptResult?.blueprint?.character_system?.characters?.length || scriptResult?.blueprint?.characters?.length || 0}`);
    lines.push(`**提示词数**: ${productionResult.prompts?.length || 0}`);
    lines.push(`**有效处理时间**: ${Math.round((timing?.effective || 0) / 60000)} 分钟`);
    lines.push('');
    lines.push('## 镜头列表');
    lines.push('');
    lines.push('| 镜头 | 时长 | 类型 | 场景描述 |');
    lines.push('|------|------|------|----------|');
    for (const sh of (productionResult.shots || [])) {
      lines.push(`| ${sh.shotId || sh.shot_id || '?'} | ${sh.duration || '?'}s | ${sh.sceneType || '?'} | ${(sh.scene || sh.description || '').slice(0, 40)}... |`);
    }
    lines.push('');
    lines.push('## 确认记录');
    lines.push('');
    for (const [k, v] of Object.entries(confirmations || {})) {
      lines.push(`- ${k}: ${v.approved ? '✅ 通过' : '❌ 未通过'}${v.skipped ? ' (跳过)' : ''}`);
    }
    lines.push('');
    lines.push('## 下一步');
    lines.push('');
    lines.push('确认后，系统将进入渲染管线（PipelineGuard → RenderingEngine → PostProductionEngine）。');
    lines.push('');
    lines.push('**请回复 "确认" 提交预生产结果并进入渲染,或 "修改" 并指出问题**');
    lines.push('');
    return lines.join('\n');
  }

  /**
   * v1.2.5: 等待外部确认
   * 将内容写入文件,轮询等待确认文件
   * 【v2.1.8-强制流程】禁止预置确认文件，必须等待真实人工确认
   */
  async _waitForExternalConfirmation(type, content) {
    // 【v2.1.8-强制流程】禁止预置确认文件，必须等待真实人工确认（规则保持）
    // 【v2.1.12-fix 多进程竞态修复】实现抽离至 scripts/confirmation-waiter.js：
    //  - 验证通过的消费方式由 unlinkSync 删除改为"归档"（archive/consumed/），
    //    多进程场景下另一个进程不会再"等到一半文件被删"而无限空转
    //  - 确认文件需通过 run_id + 时间戳双重绑定，上一轮残留的合法确认
    //    （如事故中的 confirmation-portraits.json）永不自动放行新内容
    //  - nonce 重放（确认已被其他实例消费/复制攻击）时明确终止流程，
    //    不再无限循环等待（即 2026-07-18 事故的根因修复）
    const { waitForExternalConfirmation } = require('../scripts/confirmation-waiter');
    return waitForExternalConfirmation({
      type,
      content,
      runId: this._runId || null,
      shouldAbort: () => this._shutdownRequested === true,
      onPoll: () => {
        // 【fix】确认等待期间喂 HealthMonitor 心跳，防止误判死亡
        if (this.stabilityShield?.updateHeartbeat) {
          this.stabilityShield.updateHeartbeat('ProductionEngine');
        }
      }
    });
  }

  /**
   * 生成提示词报告(供审阅)
   */
  /**
   * 【v2.1.4-fix13-队长优化】格式化提示词:序号+换行+情绪增强
   */
  _formatPromptWithSequenceNumbers(promptText, isOpening = false, shotData = null) {
    if (!promptText || typeof promptText !== 'string') return '(空)';

    // 情绪关键词扩展映射
    const emotionMap = {
      'neutral': '情绪克制内敛,面无多余表情,眼神沉稳专注,面部肌肉放松自然,传递专业冷静的气场',
      'calm': '神态安详从容,呼吸平稳,眉头舒展,嘴角自然闭合,整体氛围宁静平和,无焦虑紧张感',
      'positive': '面部微微放松,眼神温和带光,嘴角自然上扬约5度,传递乐观自信与亲和感',
      'high energy': '精神状态饱满,眼神明亮有神,身体姿态挺拔舒展,动作利落有力,充满积极活力',
      'serene': '神态宁静悠远,目光柔和涣散,面部线条放松,仿佛沉浸在平和的思绪中',
      'professional': '表情严肃专注,目光坚定直视,肩背挺直,手势精准克制,展现职业权威感',
      'hopeful': '眼神向上微抬,瞳孔有光,嘴角轻微上扬,面部肌肉放松,传递对未来的期许',
      'concerned': '眉头微蹙,眼神专注关切,嘴角微微下沉,面部肌肉轻微紧绷,传递担忧与责任感',
      'tense': '眉头紧锁,眼神锐利聚焦,下颌微收,面部肌肉紧绷,身体姿态僵硬,传递紧张压迫感',
      'warm': '面部柔和放松,眼神温和亲切,嘴角自然上扬,传递温暖关怀与信任感'
    };

    // 解析字段
    const fields = [];
    const regex = /【([^】]+)】([^【]*)/g;
    let match;
    const safeRegex = require('./utils/safe-regex');
    const safeText = promptText.length > 10000 ? promptText.substring(0, 10000) : promptText;
    while ((match = regex.exec(safeText)) !== null) {
      fields.push({ name: match[1], content: match[2].trim() });
    }

    // 如果没有解析到字段,返回原文
    if (fields.length === 0) return promptText;

    // 格式化输出
    const lines = [];
    let seq = 1;

    for (const field of fields) {
      const seqStr = String(seq).padStart(2, '0');

      // 情绪字段增强
      if (field.name === '情绪') {
        let enhanced = field.content;
        // 如果已经有面部/眼神详细描述,不再增强
        if (!enhanced.includes('面部') && !enhanced.includes('眼神') && !enhanced.includes('神态')) {
          const keywords = enhanced.split(/[,,]/).map(k => k.trim().toLowerCase()).filter(k => k);
          const details = [];
          for (const kw of keywords) {
            for (const [key, detail] of Object.entries(emotionMap)) {
              if (kw.includes(key.toLowerCase()) && !details.includes(detail)) {
                details.push(detail);
              }
            }
          }
          if (details.length > 0) {
            enhanced = details.join(',');
          } else if (enhanced.length < 30) {
            // 无匹配关键词且太短,补充默认描述
            enhanced = `情绪基调为${enhanced},面部微表情自然真实,眼神聚焦有神采,符合场景氛围与角色身份`;
          }
        }
        lines.push(`${seqStr}.【${field.name}】${enhanced}`);
      } else {
        lines.push(`${seqStr}.【${field.name}】${field.content}`);
      }

      seq++;
    }

    // 片头额外字段(如果是片头)
    // 【v2.2.1-fix】避免占位符重复：PromptFusion 已写入真实字段，仅当缺失时补真实值或待生成标记
    if (isOpening) {
      const openingFields = [
        { name: 'title_content', label: '主标题内容' },
        { name: 'subtitle_content', label: '副标题内容' },
        { name: 'title_animation', label: '标题动画设计' },
        { name: 'title_font_design', label: '标题字体设计' },
        { name: 'opening_audio_design', label: '开场音频设计' }
      ];
      for (const of of openingFields) {
        // 如果 prompt 文本中已有该字段（PromptFusion 已写入真实值），跳过
        if (promptText.includes(`【${of.label}】`)) continue;
        // 尝试从 shotData 取真实值
        const realValue = shotData && shotData[of.name];
        const seqStr = String(seq).padStart(2, '0');
        if (realValue && String(realValue).trim()) {
          lines.push(`${seqStr}.【${of.label}】${realValue}`);
        } else {
          lines.push(`${seqStr}.【${of.label}】(待片头优化器生成)`);
        }
        seq++;
      }
    }

    return lines.join('\n');
  }

  _generatePromptsReport(prompts) {
    const lines = [];

    lines.push('# 📝 提示词审核报告');
    lines.push('');
    lines.push(`**镜头数**: ${prompts.length}`);
    // v2.0.4-fix: 使用 promptCharCount 替代 prompt.length,确保中英文混合计数准确
    const totalLen = prompts.reduce((s, p) => s + (p.promptCharCount || (typeof p.prompt === 'string' ? p.prompt.length : 0)), 0);
    lines.push(`**平均长度**: ${prompts.length > 0 ? Math.round(totalLen / prompts.length) : 0} 字符`);
    lines.push('');
    lines.push('## 镜头总览');
    lines.push('');
    // v2.0.4-fix: 增加时间轴字符串和字符数统计列
    lines.push('| 镜头 | 时长 | 字符数 | 字段数 | 技能命中 | 有定妆照 | 有时间轴 | 有约束 |');
    lines.push('|------|------|--------|--------|----------|----------|----------|--------|');

    for (const p of prompts) {
      const promptText = typeof p.prompt === 'string' ? p.prompt : '';
      const hasImages = (p.characterRef && p.characterRef !== 'NONE')
        || (promptText.includes('【定妆照】') && !/【定妆照】\s*[，。]/.test(promptText));
      const hasTimeline = !!(p.timelineString && p.timelineString.length > 3)
        || promptText.includes('【时间轴】');
      const hasConstraints = typeof p.prompt === 'string' && p.prompt.includes('角色一致性') || false;
      const charCount = p.promptCharCount || (typeof p.prompt === 'string' ? p.prompt.length : 0);
      // 【v2.2.1-fix】统计字段数（片头5专属字段计入）
      const isOpening = p.shotId === 'SC00' || p.shotId === 'S00' || p.sceneType === 'opening';
      const baseFieldCount = (promptText.match(/【/g) || []).length;
      const openingExtra = isOpening
        ? ['title_content','subtitle_content','title_animation','title_font_design','opening_audio_design']
          .filter(k => p[k] && String(p[k]).trim()).length : 0;
      const fieldCount = baseFieldCount + openingExtra;
      // 【v2.2.0】片头30字段(25标准+5片头专属), 内容镜头25字段
      const expectedFields = isOpening ? 30 : 25;
      const fieldStatus = fieldCount >= expectedFields ? '✅' : (fieldCount >= expectedFields - 3 ? '⚠️' : '❌');
      // 【fix-3C】技能命中列：从 shot._skillMatched 或 shot._appliedSkills 读取
      const skillInfo = (p._skillMatched || p._appliedSkills || [])
        .map(m => (m.file || '').replace('.md',''))
        .filter(Boolean)
        .join('、') || '—';
      lines.push(`| ${p.shotId} | ${p.duration || '?'}s | ${charCount} | ${fieldStatus} ${fieldCount}/${expectedFields} | ${skillInfo} | ${hasImages ? '✓' : '✗'} | ${hasTimeline ? '✓' : '✗'} | ${hasConstraints ? '✓' : '✗'} |`);
    }

    lines.push('');
    lines.push('## 完整提示词');
    lines.push('');

    for (const p of prompts) {
      const isOpening = p.shotId === 'SC00' || p.sceneType === 'opening';
      lines.push(`### ${p.shotId}${isOpening ? '(片头·30字段)' : '(内容·25字段)'}`);
      const charCount = p.promptCharCount || (typeof p.prompt === 'string' ? p.prompt.length : 0);
      const _promptText = typeof p.prompt === 'string' ? p.prompt : '';
      const _hasImg = (p.characterRef && p.characterRef !== 'NONE') || _promptText.includes('【定妆照】');
      const _tlMatch = _promptText.match(/【时间轴】([^，。\n]{0,80})/);
      lines.push(`**长度**: ${charCount} 字符 | **定妆照**: ${_hasImg ? '有' : '无'} | **时间轴**: ${p.timelineString || (_tlMatch ? _tlMatch[1].trim().slice(0, 60) + '…' : '无')}`);
      lines.push('');
      // v2.0.4-fix: 显示人物介绍卡片
      if (p.characterCards && p.characterCards.length > 0) {
        lines.push('**人物卡片**:');
        for (const card of p.characterCards) {
          lines.push(`- ${card.name} (${card.role}): ${card.description || '无描述'}`);
        }
        lines.push('');
      }
      // 【v2.1.4-fix13】使用新格式:序号+换行+情绪增强
      lines.push('```markdown');
      lines.push(this._formatPromptWithSequenceNumbers(p.prompt, isOpening, p));
      lines.push('```');
      lines.push('');
      lines.push('---');
      lines.push('');
    }

    lines.push('## ⚠️ 审核须知');
    lines.push('');
    lines.push(`1. 【内容镜头】字段数达到审核标准(≥${AUDIT_STANDARDS.CONTENT_MIN},以镜头总览实测数为准)`);
    lines.push(`2. 【片头镜头】字段数达到审核标准(≥${AUDIT_STANDARDS.OPENING_MIN},含片头专属字段,以镜头总览实测数为准)`);
    lines.push('3. 确认【情绪】字段有具体面部/眼神描述,不是简单关键词');
    lines.push('4. 确认角色定妆照引用正确');
    lines.push('5. 确认负面约束(暗黑风/金属光泽)已包含');
    lines.push('6. 确认角色一致性约束已包含');
    lines.push('7. 确认 Prompt 长度在限制以内');
    lines.push('');
    lines.push('**请回复 "确认" 继续渲染,或 "修改" 并指出问题**');
    lines.push('');

    return lines.join('\n');
  }

  /**
   * 生成最终报告(含确认环节 + 渲染结果 + 后期制作)
   */
  _generateFinalReport(scriptResult, productionResult, renderResult, postResult, totalTime, confirmations) {
    const blueprint = scriptResult.blueprint;
    const validation = scriptResult.validation;
    const report = scriptResult.report;
    const production = productionResult;
    const render = renderResult?.render || { submitted: 0, failed: 0 };

    const lines = [];

    lines.push('# 超级小香宝 - 生产报告');
    lines.push(`**版本**: v${this.version}  |  **总耗时**: ${totalTime}ms`);
    lines.push('');

    // 确认状态
    lines.push('## ✅ 确认状态');
    lines.push('');
    lines.push(`| 环节 | 状态 | 时间 |`);
    lines.push(`|------|------|------|`);
    if (confirmations?.prompts) {
      lines.push(`| 提示词审核 | ${confirmations.prompts.approved ? '✅ 通过' : '❌ 未通过'} ${confirmations.prompts.skipped ? '(跳过)' : ''} | ${confirmations.prompts.reviewedAt || 'N/A'} |`);
    }
    lines.push('');

    // 项目信息
    lines.push('## 📋 项目信息');
    lines.push(`| 字段 | 值 |`);
    lines.push(`|------|------|`);
    lines.push(`| 标题 | ${blueprint.meta.title || '未命名'} |`);
    lines.push(`| 叙事模式 | ${blueprint.meta.narrative_mode || 'default'} |`);
    lines.push(`| 目标时长 | ${blueprint.meta.target_duration || 120}s |`);
    lines.push(`| 场景数 | ${report.scenes_count} |`);
    lines.push(`| 角色数 | ${report.characters_count} |`);
    lines.push(`| 台词数 | ${report.dialogues_count} |`);
    lines.push('');

    // 剧本校验
    lines.push('## ✅ 剧本校验');
    lines.push(`**状态**: ${validation.passed ? '通过 ✓' : '未通过 ✗'} | **综合评分**: ${validation.overall_score}/100`);
    lines.push('');
    lines.push(`| 维度 | 评分 |`);
    lines.push(`|------|------|`);
    for (const [dim, score] of Object.entries(validation.scores?.detailed || {})) {
      lines.push(`| ${dim} | ${score} |`);
    }
    lines.push('');

    // 镜头总览
    lines.push('## 🎬 镜头总览');
    // v2.0.4-fix: 增加时间轴和字符数统计列
    lines.push(`| 镜头ID | 类型 | 时长 | 字符数 | 字段数 | 时间轴 | 状态 |`);
    lines.push(`|--------|------|------|--------|--------|--------|------|`);
    for (const shot of production.shots) {
      const charCount = shot.promptCharCount || (typeof shot.prompt === 'string' ? shot.prompt.length : 0);
      // 【v2.3.1-fix】补字段数列：与 SPEC-AUTHORITY 核验口径对齐，按【】标签实测
      const fieldCount = (String(shot.prompt || '').match(/【/g) || []).length;
      const timelineStr = shot.timelineString || '无';
      lines.push(`| ${shot.shotId} | ${shot.sceneType} | ${shot.duration || shot.timing?.duration || 0}s | ${charCount} | ${fieldCount} | ${timelineStr} | ${shot.status || 'ok'} |`);
    }
    lines.push('');

    // 渲染结果
    if (renderResult && !renderResult.skipped) {
      lines.push('## 🎨 渲染结果');
      lines.push(`| 提交 | 成功 | 失败 | 成功率 |`);
      lines.push(`|------|------|------|--------|`);
      lines.push(`| ${render.results.length} | ${render.submitted} | ${render.failed} | ${render.results.length > 0 ? Math.round((render.submitted / render.results.length) * 100) : 0}% |`);
      lines.push('');
    }

    // 完整 Prompts
    lines.push('## 📝 完整 Prompts');
    lines.push('');
    for (const p of production.prompts) {
      lines.push(`### ${p.shotId}`);
      const charCount = p.promptCharCount || (typeof p.prompt === 'string' ? p.prompt.length : 0);
      lines.push(`**长度**: ${charCount} 字符 | **定妆照**: ${p.characterRef && p.characterRef !== 'NONE' ? p.characterRef : '无'} | **时间轴**: ${p.timelineString || '无'}`);
      lines.push('');
      // v2.0.4-fix: 显示人物介绍卡片
      if (p.characterCards && p.characterCards.length > 0) {
        lines.push('**人物卡片**:');
        for (const card of p.characterCards) {
          lines.push(`- ${card.name} (${card.role}): ${card.description || '无描述'}`);
        }
        lines.push('');
      }
      lines.push('```');
      lines.push(p.prompt);
      lines.push('```');
      lines.push('');
    }

    // 质量门
    const qg = production.stages?.qualityGate;
    if (qg) {
      lines.push('## 🛡️ 质量门检查');
      lines.push(`**状态**: ${qg.passed ? '通过 ✓' : '失败 ✗'} (${qg.passedCount}/${qg.totalPrompts})`);
      lines.push('');
      lines.push(`| 镜头 | 有镜头时间轴 | 有角色 | 长度合规 | 状态 |`);
      lines.push(`|------|------------|--------|----------|------|`);
      for (const check of (qg.checks || [])) {
        lines.push(`| ${check.shotId} | ${check.hasTimeline ? '✓' : '✗'} | ${check.hasCharacters ? '✓' : '✗'} | ${check.withinLimit ? '✓' : '✗'} | ${check.passed ? '✓' : '✗'} |`);
      }
      lines.push('');
    }

    // 后期制作结果
    if (postResult && !postResult.skipped) {
      const post = postResult;
      lines.push('## 🎬 后期制作');
      lines.push(`**状态**: ${post.success ? '通过 ✓' : '未通过 ✗'}`);
      lines.push('');

      // 版本列表
      lines.push('### 输出版本');
      lines.push(`| 版本 | 字幕 | 音乐 | 弹幕 | 转场 | 片头 |`);
      lines.push(`|------|------|------|------|------|------|`);
      for (const [version, data] of Object.entries(post.versions || {})) {
        const f = data.features || {};
        lines.push(`| ${version} | ${f.subtitles ? '✓' : '✗'} | ${f.music ? '✓' : '✗'} | ${f.danmaku ? '✓' : '✗'} | ${f.transitions ? '✓' : '✗'} | ${f.titleCard ? '✓' : '✗'} |`);
      }
      lines.push('');

      // 字幕预览
      if (post.stages?.subtitles?.tracks?.length > 0) {
        lines.push('### 身份介绍字幕');
        lines.push(`| 角色 | 场景 | 时长 | 内容 |`);
        lines.push(`|------|------|------|------|`);
        for (const sub of post.stages.subtitles.tracks.slice(0, 3)) {
          lines.push(`| ${sub.characterName} | ${sub.sceneId} | ${sub.duration}s | ${sub.content.title} |`);
        }
        lines.push('');
      }

      // 音乐预览
      if (post.stages?.music?.tracks?.length > 0) {
        lines.push('### 无版权音乐配置');
        lines.push(`| 场景 | 风格 | 情绪 | 音量 |`);
        lines.push(`|------|------|------|------|`);
        for (const track of post.stages.music.tracks.slice(0, 3)) {
          lines.push(`| ${track.sceneId} | ${track.searchParams.genre} | ${track.searchParams.mood} | ${track.config.volume} |`);
        }
        lines.push('');
      }

      // 弹幕预览
      if (post.stages?.danmaku?.list?.length > 0) {
        lines.push('### 弹幕预览');
        lines.push(`| 内容 | 场景 | 颜色 |`);
        lines.push(`|------|------|------|`);
        for (const dm of post.stages.danmaku.list.slice(0, 3)) {
          lines.push(`| ${dm.text} | ${dm.sceneId} | ${dm.color} |`);
        }
        lines.push('');
      }
    }

    // 时序分析
    lines.push('## ⏱️ 时序分析');
    lines.push('');
    lines.push(`| 阶段 | 耗时 | 占比 |`);
    lines.push(`|------|------|------|`);
    lines.push(`| 剧本引擎 | ${scriptResult.timing || 'N/A'} | - |`);
    lines.push(`| 制作引擎 | ${production.timing?.total || 'N/A'} | - |`);
    lines.push(`| 渲染引擎 | ${renderResult?.timing?.total || 'N/A'} | - |`);
    lines.push(`| 后期引擎 | ${postResult?.timing?.total || 'N/A'} | - |`);
    lines.push(`| 总耗时 | ${totalTime}ms | 100% |`);
    lines.push('');

    lines.push('---');
    lines.push(`*生成时间: ${new Date().toISOString()}*`);

    return lines.join('\n');
  }

  /**
   * 保存完整结果到文件
   */
  async save(result, outputDir) {
    const fs = require('fs').promises;
    const fsSync = require('fs');
    const path = require('path');

    await fs.mkdir(outputDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const basePath = path.join(outputDir, `super-mickey-${timestamp}`);

    // v2.1.22-fix: 深度清洗——移除内部调试字段（以 _ 开头），不污染最终提示词
    const cleanForExport = (obj) => {
      if (Array.isArray(obj)) {
        return obj.map(cleanForExport);
      }
      if (obj && typeof obj === 'object') {
        const cleaned = {};
        for (const [k, v] of Object.entries(obj)) {
          if (k.startsWith('_') && k !== '_id') continue; // 保留 _id，剔除其余内部标记
          cleaned[k] = cleanForExport(v);
        }
        return cleaned;
      }
      return obj;
    };

    // v2.1.5-fix: 安全写入函数(带验证)
    const safeWrite = async (filePath, content, label) => {
      await fs.writeFile(filePath, content);
      // 写入验证
      if (!fsSync.existsSync(filePath)) {
        throw new Error(`${label} 写入后文件不存在: ${filePath}`);
      }
      const stats = fsSync.statSync(filePath);
      if (stats.size === 0) {
        throw new Error(`${label} 写入后文件大小为0: ${filePath}`);
      }
    };

    // 保存完整结果 JSON（清洗后，移除内部调试字段）
    await safeWrite(
      `${basePath}-result.json`,
      JSON.stringify(cleanForExport(result), null, 2),
      '结果JSON'
    );

    // 保存 Markdown 报告
    if (result.finalReport) {
      await safeWrite(
        `${basePath}-report.md`,
        result.finalReport,
        '报告MD'
      );
    }

    // 保存提示词审核报告
    if (result.confirmations?.prompts?.report) {
      await safeWrite(
        `${basePath}-prompt-review.md`,
        result.confirmations.prompts.report,
        '提示词审核'
      );
    }

    // 保存后期制作报告
    if (result.stages?.postProductionEngine?.report) {
      await safeWrite(
        `${basePath}-post-production.md`,
        result.stages.postProductionEngine.report,
        '后期制作报告'
      );
    }

    // 保存 Prompts 单独文件
    if (result.stages?.productionEngine?.prompts) {
      const promptsMD = this._generatePromptsOnlyMD(result.stages.productionEngine.prompts);
      await safeWrite(
        `${basePath}-prompts.md`,
        promptsMD,
        'Prompts清单'
      );
    }

    console.log(`\n💾 结果已保存到: ${outputDir}`);
    return outputDir;
  }

  /**
   * 生成纯 Prompts MD
   */
  _generatePromptsOnlyMD(prompts) {
    const lines = [];
    lines.push('# 镜头 Prompts 清单');
    lines.push('');

    for (const p of prompts) {
      lines.push(`## ${p.shotId}`);
      lines.push('');
      lines.push(p.prompt);
      lines.push('');
      lines.push('---');
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * 【2026-07-17 新增】回填生产结果，形成创意指数反馈闭环
   * 用法：视频发布后拿到完播率/互动率，调用 system.recordCreativeFeedback({...})
   */
  recordCreativeFeedback({ videoType, intensity, completionRate, engagementRate }) {
    return this.creativeRecommender.record({ videoType, intensity, completionRate, engagementRate });
  }
}

module.exports = { HyperrealitySystem };
