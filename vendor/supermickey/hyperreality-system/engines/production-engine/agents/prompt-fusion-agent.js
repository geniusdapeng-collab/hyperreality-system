/**
 * PromptFusionAgent - Prompt融合Agent(核心)
 * 负责: 将L3-L7元素创造性融合成导演分镜脚本
 * 策略: L1/L2/L9硬约束走规则,L3-L7走LLM融合
 * v2.1.4-fix8: LLM输出标准字段格式(【约束】【基础】【场景】等)
 */
const { BaseAgent } = require('./base-agent');
const { FieldContentRefiner } = require('./field-content-refiner');
const { SemanticRefinementPass } = require('./semantic-refinement-pass');
const { OnscreenTextDesigner } = require('./onscreen-text-designer');
const { ProductHeroDesigner } = require('./product-hero-designer');
const { BgmStrategyDesigner } = require('./bgm-strategy-designer');
const { resolveProfile, isSocialCommerce, constraintTemplateOf } = require('../../../config/platform-profiles.js');
const { normalizeFields, makeGetter } = require('../../field-standardizer');
const { FieldConsistencyChecker } = require('../../field-consistency-checker');
const { FALLBACK_SCENES, renderFallbackAction } = require('../../../config/neutral-fallbacks');

// 【v2.1.4-fix10-P25-fix3】外部专家建议:填满 schema 解决 LLM 字段缺失问题
// 25 个标准字段的 schema 模板:键名 + 类型提示
// 这是给 LLM 看的"结构契约",绝不能再传 fields: {}
// ⚠️ value 使用空字符串占位,避免 LLM 把描述当输出值(风险5)
const STANDARD_FIELDS_SCHEMA = {
  director_instruction: '',
  constraint: '',
  baseline: '',
  scene: '',
  lighting: '',
  composition: '',
  color_palette: '',
  depth_of_field: '',
  camera_movement: '',
  character: '',
  costume: '',
  makeup: '',
  action: '',
  props: '',
  portraits: '',
  dialogue: '',
  timeline: '',
  mood: '',
  pacing: '',
  transition: '',
  audio: '',
  negative: '',
  bright_constraint: '',
  character_constraint: '',
  consistency: ''
};

// 字段描述表(仅用于补齐 prompt,不放入 schema)
const FIELD_DESCS = {
  director_instruction: 'string,≥80字符,导演整体质感指令',
  constraint: 'string,画幅/分辨率/帧率/格式/禁用项',
  baseline: 'string,8K/电影级/写实等基础画质词',
  scene: 'string,≥120字符,场景空间细节',
  lighting: 'string,≥150字符,主光/辅光/色温/方向',
  composition: 'string,≥100字符,景别/主体位置/线条/留白',
  color_palette: 'string,≥80字符,主色/辅色/肤色/饱和度/对比度',
  depth_of_field: 'string,≥80字符,焦点/景深/前景背景虚化',
  camera_movement: 'string,≥100字符,分时间段运镜',
  character: 'string,角色外貌与姿态',
  costume: 'string,服装材质款式',
  makeup: 'string,妆造',
  action: 'string,≥120字符,肢体动作与走位',
  props: 'string,道具',
  portraits: 'string,定妆照引用 image://...',
  dialogue: 'string,台词/旁白原文',
  timeline: 'string或object,分镜时间轴。支持两种格式:\n1. 纯文本: T00:00 - 描述;T00:XX - 描述(≥3段)\n2. 结构化: {"totalDuration":10,"beats":[{"time":0,"label":"开场","description":"...","cameraHint":"..."},{"time":3,"label":"推进","description":"...","cameraHint":"..."}],"sync":{"cameraMovement":"...","audio":"..."}}',
  mood: 'string,情绪基调',
  pacing: 'string,节奏',
  transition: 'string,转场方式',
  audio: 'string,≥100字符,环境音/配乐/音效',
  negative: 'string,负面约束',
  bright_constraint: 'string,明亮约束',
  character_constraint: 'string,角色一致性约束',
  consistency: 'string,跨镜头一致性'
};

// 【P1-PROMPT-02 修复】动态必填字段：根据场景类型决定哪些字段必须
const OPTIONAL_BY_SCENE_TYPE = {
  // 空景/环境镜头：不需要角色相关字段
  'empty': ['character', 'costume', 'makeup', 'action', 'portraits', 'dialogue'],
  'landscape': ['character', 'costume', 'makeup', 'action', 'portraits', 'dialogue'],
  'aerial': ['character', 'costume', 'makeup', 'action', 'portraits', 'dialogue'],
  // 角色特写：不需要大场景描述
  'portrait': ['scene'],
  // 对话场景：更强调角色和台词
  'dialogue': ['props'],
  // 动作场景：强调动作和道具
  'action': ['dialogue'],
  // 过渡镜头：只需要基础视觉字段
  'transition': ['character', 'costume', 'makeup', 'action', 'dialogue', 'portraits', 'props', 'audio'],
  // 片头/片尾：只需要基础字段
  'opening': ['character', 'costume', 'makeup', 'action', 'dialogue', 'portraits'],
  'closing': ['character', 'costume', 'makeup', 'action', 'dialogue', 'portraits']
};

// 判断镜头是否为空景（无角色）
function _isEmptyScene(shot) {
  const emptyIndicators = ['空景', '环境', '全景', '航拍', '俯视', 'establishing'];
  const scene = (shot.scene || '').toLowerCase();
  const action = (shot.action || '').toLowerCase();
  const noCharacters = !shot.characters || shot.characters.length === 0;
  const hasEmptyKeyword = emptyIndicators.some(kw => scene.includes(kw) || action.includes(kw));
  return noCharacters && hasEmptyKeyword;
}

// 25 字段标准名称列表(用于校验) - 前置定义，避免TDZ风险
const REQUIRED_FIELDS = Object.keys(STANDARD_FIELDS_SCHEMA);

/**
 * 获取镜头所需的必填字段
 * 【P1-PROMPT-02 修复】空景不需要character/costume/makeup等字段
 * 【v2.1.8-审计修复】REQUIRED_FIELDS 已在上方定义，消除TDZ风险
 */
function _getRequiredFieldsForShot(shot) {
  const baseFields = [...REQUIRED_FIELDS];
  
  // 检测场景类型
  let sceneType = shot.sceneType;
  if (!sceneType && _isEmptyScene(shot)) {
    sceneType = 'empty';
  }
  
  // 获取该场景类型的可选字段
  const optionalFields = OPTIONAL_BY_SCENE_TYPE[sceneType] || [];
  
  // 从必填列表中移除可选字段
  return baseFields.filter(f => !optionalFields.includes(f));
}

// 字段最低字符数要求
const MIN_LEN = {
  scene: 120, lighting: 150, composition: 100, action: 120,
  camera_movement: 100, timeline: 200, director_instruction: 80,
  color_palette: 80, depth_of_field: 80, audio: 100
};

function buildFullSchema(shotId) {
  // 用真实字段键填充,让 LLM 在 JSON 模式下有明确的 key 列表
  // value 使用空字符串,避免描述污染(风险5)
  return { shotId, fields: { ...STANDARD_FIELDS_SCHEMA } };
}

class PromptFusionAgent extends BaseAgent {
  constructor(options = {}) {
    super({
      name: 'PromptFusionAgent',
      enabled: true,
      ...options,
      // 【修复】llmTimeout/llmMaxRetries 写到 ...options 之后，
      // 未显式传入时落类内默认，不再被 base 配置静默腰斩
      llmTimeout: options.llmTimeout ?? 300000,
      llmMaxRetries: options.llmMaxRetries ?? 5
    });
    const PromptLengthConfig = require('../../../config/prompt-length.js');
    // ...
    // 【审计修复】从配置文件读取,不再硬编码
    this.maxPromptLength = options.maxPromptLength || PromptLengthConfig.HARD_MAX || 12000;
    // 【v2.2.5-审计新增】精炼后交付口径下限，从唯一真源读取（两阶段口径②）
    this.refinedMinLength = options.refinedMinLength || PromptLengthConfig.REFINED_MIN;
    this.llmTimeout = options.llmTimeout || this.llmTimeout || 300000;
    this.llmMaxRetries = options.llmMaxRetries || 2;
    // v2.1.7: 新增跨字段一致性校验器
    this.consistencyChecker = new FieldConsistencyChecker({ strict: true, logLevel: 'warn' });
    // 【v2.2-refine】25字段内容精炼器: 拼接完成后做内容级精炼(不改字段结构)
    // 【v2.4.5-fix】注入模板分辨率对齐【基础】8K 锚点，消除"基础8K vs 约束4K"自相矛盾
    this._contentRefiner = new FieldContentRefiner({
      constraintTemplate: '16:9画幅，8K分辨率，24fps，MP4格式'
    });

    // 【v2.4.5 新增】三段式混合生产·阶段3：语义精炼层（转正）
    // LLM 输出 → PromptDeliveryGuard 硬闸机 → 不过自动回退规则精炼结果
    this._semanticPass = new SemanticRefinementPass({
      callLLM: (prompt, schema, fallbackFn, opts) => this._callLLM(prompt, schema, fallbackFn, opts),
      enabled: options.semanticRefinement !== false
    });

    // 【v2.5.0 新增】社媒营销包：画面文字设计器（三层文字体系）
    this._onscreenTextDesigner = new OnscreenTextDesigner();
    // 【v2.6.0 新增】社媒营销包：商品定妆照设计器 + 配乐策略设计器
    this._productHeroDesigner = new ProductHeroDesigner();
    this._bgmStrategyDesigner = new BgmStrategyDesigner();

    // 【v2.1.11-重构】保存生产画像，用于写实校验强度分级
    this.productionProfile = options.productionProfile || null;

    // 【P0-PERF-01 修复】单镜头降级预算控制,防止降级螺旋
    this.MAX_DEGRADE_BUDGET_PER_SHOT = options.maxDegradeBudgetPerShot || 600000; // 10分钟硬上限
    this.DEGRADE_BUDGET_RATIOS = {
      primary: 0.40,      // 主调用 + 重试
      fillRetry: 0.35,    // 补齐重试
      batchDegrade: 0.20, // 批量降级
      fallback: 0.05      // 规则兜底
    };
    this._callBudget = new Map(); // shotId -> remaining calls
  }

  _getSystemPrompt() {
    return `你是一位资深电影导演和摄影师。根据镜头信息,生成结构化的导演分镜提示词。

【输出格式】
输出严格JSON:{"shots":[{"shotId":"SC01","fields":{...}}]}

【25个字段】按此顺序:
1. constraint: 技术参数(画幅/分辨率/格式/帧率)
2. baseline: 画质基础(8K/cinematic/photorealistic)
3. scene: 场景环境(地点/时间/空间/材质)
4. lighting: 灯光设计(主光方向+色温K值+光质+补光)
5. composition: 构图(景别+主体位置+线条引导)
6. color_palette: 色彩方案(主色调+辅助色+饱和度+对比度)
7. depth_of_field: 景深(焦点+光圈+前景/背景虚化)
8. camera_movement: 运镜(运动方式+速度+时间分布)
9. character: 角色身份/姿态/表情
10. costume: 服装(颜色/款式/质地/配饰)
11. makeup: 妆容发型
12. action: 具体动作(手势/步伐/视线)
13. props: 关键道具
14. portraits: 定妆照路径(image://characters/...)
15. dialogue: 角色台词(纯台词,不要旁白)
16. timeline: 时间轴(T00:XX格式,≥3段,每段画面+动作)
17. mood: 情绪关键词(1-2个,如tense/epic)
18. pacing: 节奏(五段式:整体/开头/中段/高潮/结尾)
19. transition: 转场(类型+持续时间+方向)
20. audio: 音频(环境音+音乐风格+BPM)
21. negative: 负面约束(no text/watermark/blurry等)
22. consistency: 跨镜头一致性
23. bright_constraint: 明亮约束(well-lit/clear visibility)
24. character_constraint: 角色约束(只出现指定角色,禁止分身)
25. director_instruction: 导演指令(风格定位+质感要求)

【最低字符数要求】
scene≥120, lighting≥150, composition≥100, action≥120, camera_movement≥100, timeline≥200, director_instruction≥80, color_palette≥80, depth_of_field≥80, audio≥100

【禁止词汇】全息/虚拟/投影/抽象/光影场域/数据空间/元宇宙/时间操控/霓虹/微观世界/宏观/抽象几何/流动光影/色彩对冲/空间扭曲/时间残影/数据流/光即角色/梦境流动性/湿版摄影/AI瑕疵

【关键约束】
- 不要照搬示例,根据真实场景和角色创作
- 每个字段独立,不要混成一段narrative
- 场景必须写实,禁止科幻/抽象元素
- 动作必须是真实物理动作,禁止全息/空间扭曲等
- 场景中不得出现含文字的物品描述
- 台词必须是角色直接对话,不要画外音/旁白
- 只描述当前镜头内容,严禁预告后续
- 保持角色视觉锚点一致`;
  }

  async process(shots, blueprint, options = {}) {
    console.log(`[PromptFusionAgent] 开始处理 ${shots.length} 个镜头(串行模式,避免并发超时)| 单镜头预算=${this.MAX_DEGRADE_BUDGET_PER_SHOT}ms`);

    const ratio = blueprint.config?.aspectRatio || '16:9';
    const characters = blueprint.character_system?.characters || [];

    const results = new Array(shots.length);
    let failed = 0;

    // 【v2.1.8-fix】镜头级断点续跑：检查子 checkpoint
    const checkpointMgr = options.checkpointManager;
    const blueprintHash = options.blueprintHash || '';
    let resumeIndex = 0;
    let resumeResults = [];
    if (checkpointMgr && blueprintHash) {
      try {
        const subCkpt = this._loadSubCheckpoint(checkpointMgr, blueprintHash);
        if (subCkpt && subCkpt.results && subCkpt.results.length > 0) {
          resumeIndex = subCkpt.results.length;
          resumeResults = subCkpt.results;
          console.log(`[PromptFusionAgent] 🔄 断点续跑: 从镜头 ${resumeIndex + 1}/${shots.length} 继续 (${resumeIndex} 个已恢复)`);
          for (let j = 0; j < resumeResults.length; j++) {
            results[j] = resumeResults[j];
          }
        }
      } catch (e) {
        console.warn(`[PromptFusionAgent] 断点续跑检查失败: ${e.message}`);
      }
    }

    // 【P0-PERF-01 修复】计算每个镜头的总时间预算
    // 【v2.1.8-fix】llmTimeout 是单镜头 LLM 调用超时，不是总预算
    // 串行处理时，每个镜头可以使用完整的 llmTimeout
    const PER_SHOT_BUDGET = Math.min(
      this.llmTimeout || 180000,
      this.MAX_DEGRADE_BUDGET_PER_SHOT || 180000
    );
    console.log(`[PromptFusionAgent] 每个镜头预算: ${PER_SHOT_BUDGET}ms (串行模式，不除以镜头数)`);

    // 【2026-07-17 camera-coherence】预构建全片邻镜上下文（景别/运镜/转场摘要）
    // 【v2.2.8-审计修复】原路径 '../../../systems/camera-coherence' 少一级（指向不存在的
    // hyperreality-system/systems/），try/catch 吞错导致邻镜协调功能静默失效；已纠正。
    this._cameraPlans = null;
    try {
      const { extractLightPlans } = require('../../../../systems/camera-coherence');
      this._cameraPlans = extractLightPlans(shots);
    } catch (e) { this._cameraPlans = null; }

    // 【审计修复】串行处理,避免并发导致API超时
    for (let i = resumeIndex; i < shots.length; i++) {
      const shotStartTime = Date.now();
      const shot = shots[i];
      this._currentShotIdx = i; // 【camera-coherence】当前镜索引，供邻镜上下文定位
      // 【P0-PERF-01 修复】设置镜头级截止时间
      const shotDeadline = shotStartTime + Math.min(PER_SHOT_BUDGET, this.MAX_DEGRADE_BUDGET_PER_SHOT);
      this._callBudget.set(shot.shotId, 5); // 单镜头最多5次LLM调用

      // 每3个镜头检查一次内存,启发式GC(P0-PERF-04 修复)
      if (i % 3 === 0) {
        const mem = process.memoryUsage();
        const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
        const heapTotalMB = Math.round(mem.heapTotal / 1024 / 1024);
        const heapLimitMB = Math.round(mem.heapTotalLimit / 1024 / 1024) || heapTotalMB * 1.5; // 兼容不同Node版本
        const usageRatio = heapMB / heapLimitMB;

        // 【P0-PERF-04 修复】动态阈值:80%堆限制时告警,不再强制GC(让V8自主管理)
        if (usageRatio > 0.8) {
          console.warn(`[PromptFusionAgent] ⚠️ 内存告警: ${heapMB}MB / ${heapLimitMB}MB (${(usageRatio*100).toFixed(1)}%)`);
          // 移除强制 global.gc(),避免停顿;只建议外部监控
          if (usageRatio > 0.95) {
            console.error(`[PromptFusionAgent] 🔴 内存临界: 建议降低并发数或增加堆限制`);
          }
        }
      }

      // 【P0-ARCH-03 修复】降级路径调用计数器,防止重试风暴
      const callCounter = { count: 0, max: 8 }; // 单镜头最多8次LLM调用
      const trackCall = () => {
        callCounter.count++;
        if (callCounter.count > callCounter.max) {
          throw new Error(`RETRY_STORM: 单镜头LLM调用次数超过上限(${callCounter.max})`);
        }
      };

      console.log(`\n🎬 处理镜头 ${i + 1}/${shots.length}: ${shot.shotId} | 截止时间=${new Date(shotDeadline).toISOString()}`);
      try {
        // 【P0-PERF-01 修复】检查截止时间
        if (Date.now() > shotDeadline) {
          throw new Error('Shot deadline exceeded');
        }
        const fused = await this._fuseSingleShotWithDeadline(shot, ratio, characters, blueprint, shotDeadline, trackCall);
        results[i] = fused;
        console.log(`  ✅ ${shot.shotId} 完成 | 调用次数=${callCounter.count}`);
      } catch (e) {
        failed++;
        console.warn(`  ❌ ${shot.shotId} 融合失败: ${e.message}`);

        // 【P0-ARCH-03 修复】重试风暴检测:如果已超过上限,直接兜底
        if (callCounter.count >= callCounter.max) {
          console.error(`  🔴 ${shot.shotId} 重试风暴保护触发,强制兜底`);
          results[i] = this._fastFallback(shot, ratio);
          results[i].degradeReason = `RETRY_STORM: ${callCounter.count}次调用后强制兜底`;
          continue;
        }

        // 【P0-PERF-01 修复】根据剩余预算决定降级路径
        const remainingBudget = shotDeadline - Date.now();
        if (remainingBudget < 30000) {
          console.warn(`  ⏰ 预算不足(${remainingBudget}ms),快速兜底`);
          results[i] = this._fastFallback(shot, ratio);
          results[i].degradeReason = `BUDGET_EXHAUSTED: 剩余${remainingBudget}ms`;
          continue;
        }

        // 【P0-PERF-01 修复】有限重试:最多1次快速重试
        let fused = null;
        if (remainingBudget > 60000 && callCounter.count < callCounter.max) {
          try {
            console.log(`  🔄 快速重试 1/1...`);
            await new Promise(r => setTimeout(r, 2000));
            fused = await this._fuseSingleShotWithDeadline(shot, ratio, characters, blueprint, shotDeadline, trackCall);
            console.log(`  ✅ ${shot.shotId} 重试成功`);
          } catch (retryErr) {
            console.warn(`  ❌ 重试失败: ${retryErr.message}`);
          }
        }

        if (fused) {
          results[i] = fused;
          continue;
        }

        // 主调用彻底失败,尝试有限补全
        try {
          if (Date.now() > shotDeadline - 30000) {
            throw new Error('Budget insufficient for fill');
          }
          console.log(`  🔄 尝试补全缺失字段...`);
          const filled = await this._fillMissingFieldsWithRetry(shot, ratio, characters, shotDeadline, trackCall);
          results[i] = filled;
          console.log(`  ✅ ${shot.shotId} 补全完成 | 总调用=${callCounter.count}`);
        } catch (fillError) {
          console.warn(`  ❌ ${shot.shotId} 补全也失败: ${fillError.message}`);
          // 【修复】不直接规则兜底,而是尝试用已有数据组装
          const shotFields = this._extractFieldsFromShot(shot);
          if (Object.keys(shotFields).some(k => shotFields[k])) {
            console.log(`  ⚠️ 使用已有字段组装 prompt(非降级)`);
            results[i] = await this._buildShotResult(shot, shotFields, false, '使用已有字段组装');
          } else {
            console.warn(`  ❌ ${shot.shotId} 无任何可用数据,规则兜底`);
            results[i] = this._fallbackSingleShot(shot, ratio);
          }
        }
      }
      // 【v2.1.8-fix】镜头级断点续跑：每完成一个镜头保存子 checkpoint
      if (checkpointMgr && blueprintHash && results[i]) {
        try {
          this._saveSubCheckpoint(checkpointMgr, blueprintHash, results.slice(0, i + 1), i + 1, shots.length);
        } catch (e) {
          console.warn(`[PromptFusionAgent] 子 checkpoint 保存失败: ${e.message}`);
        }
      }
    }

    if (failed > 0) {
      console.warn(`[PromptFusionAgent] ⚠️ ${failed}/${shots.length} 镜头需要补全/兜底`);
    }
    console.log(`[PromptFusionAgent] 完成 ✓ | 降级: ${failed}/${shots.length}`);

    // 【v2.1.10-fix 提示词融合断点】全部镜头完成后显式清理子 checkpoint，避免残留文件累积
    if (checkpointMgr && blueprintHash) {
      try { this._clearSubCheckpoint(checkpointMgr, blueprintHash); } catch (_) {}
    }

    return {
      shots: results,
      degraded: failed > 0,
      degradeReason: failed > 0 ? `${failed}个镜头降级(调用次数受限或预算耗尽)` : null,
      stats: { total: shots.length, failed, success: shots.length - failed }
    };
  }

  /**
   * 【v2.1.4-fix11】构建shot结果(用于补全后的组装)
   * @param {Object} shot - 镜头数据
   * @param {Object} fields - 字段数据
   * @param {boolean} isDegraded - 是否降级（默认true）
   * @param {string} degradeReason - 降级原因
   */
  _buildShotResult(shot, fields, isDegraded = true, degradeReason = '主LLM超时,通过重试补全生成') {
    const expandedFields = { ...fields };
    const fullPrompt = this._assembleStandardPrompt(shot, fields, shot.ratio || '16:9');

    // 【P2-PROMPT-01 修复】校验promptBase字符数：约束+基础层不应超过总prompt的30%
    const baseParts = fullPrompt.split(/ \| |\n(?=\d{2}\.【)/).slice(0, 3); // 约束+基础层+导演指令（兼容 ' | ' 与序号独立行两种排版）
    const promptBase = baseParts.join(' | ');
    const baseRatio = this._countChars(promptBase) / this._countChars(fullPrompt);
    if (baseRatio > 0.5) {
      console.warn(`[PromptFusionAgent] ⚠️ 镜头 ${shot.shotId} promptBase占比过高(${ (baseRatio * 100).toFixed(1) }%), 可能影响场景描述质量`);
    }

    return this._finalizeShotResult(shot, {
      ...shot,
      ...expandedFields,
      fields,
      fusionText: fields.scene || '',
      prompt: fullPrompt,
      promptCharCount: this._countChars(fullPrompt),
      degraded: isDegraded,
      degradeReason: isDegraded ? degradeReason : null
    });
  }

  /**
   * 【v2.4.5 新增】三段式混合生产·阶段3挂载点（转正）
   * 语义精炼层在规则精炼之后执行：LLM 输出 → PromptDeliveryGuard 硬闸机 →
   * 任一不过自动回退到规则精炼结果。语义动作日志挂到 shot.semanticRefinement。
   */
  async _finalizeShotResult(shot, result) {
    if (!this._semanticPass || !this._semanticPass.enabled) return result;
    try {
      const r = await this._semanticPass.refine(result.prompt, shot);
      if (r.applied) {
        result.prompt = r.prompt;
        result.promptCharCount = this._countChars(r.prompt);
      } else if (r.fallbackReason && r.fallbackReason !== 'disabled') {
        console.warn(`[PromptFusionAgent] ${shot.shotId} 语义精炼回退: ${r.fallbackReason}`);
      }
      result.semanticRefinement = {
        applied: r.applied,
        actions: r.actions || [],
        fallbackReason: r.fallbackReason || null
      };
    } catch (e) {
      console.warn(`[PromptFusionAgent] ${shot.shotId} 语义精炼异常，保持规则精炼结果: ${e.message}`);
      result.semanticRefinement = { applied: false, actions: [], fallbackReason: `异常:${e.message}` };
    }
    return result;
  }

  /**
   * 【v2.1.8-fix】镜头级断点续跑：保存子 checkpoint
   */
  _saveSubCheckpoint(checkpointMgr, blueprintHash, results, completed, total) {
    const fs = require('fs');
    const path = require('path');
    const subCkptPath = path.join(checkpointMgr.baseDir || './checkpoints', `checkpoint-phase3-${blueprintHash}.json`);
    const data = {
      phase: 'phase3-incremental',
      blueprintHash,
      completed,
      total,
      results: JSON.parse(JSON.stringify(results)),
      savedAt: new Date().toISOString()
    };
    fs.writeFileSync(subCkptPath + '.tmp', JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(subCkptPath + '.tmp', subCkptPath);
    console.log(`[PromptFusionAgent] 💾 子 checkpoint 已保存: ${completed}/${total} 镜头 | ${subCkptPath}`);
  }

  /**
   * 【v2.1.10-fix 提示词融合断点】加载子 checkpoint（加载后不删除，防止进程崩溃丢失进度）
   * 清理时机：全部镜头完成后由 process() 末尾统一调用 _clearSubCheckpoint。
   */
  _loadSubCheckpoint(checkpointMgr, blueprintHash) {
    const fs = require('fs');
    const path = require('path');
    const subCkptPath = path.join(checkpointMgr.baseDir || './checkpoints', `checkpoint-phase3-${blueprintHash}.json`);
    if (!fs.existsSync(subCkptPath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(subCkptPath, 'utf8'));
      if (data.blueprintHash !== blueprintHash) {
        console.warn(`[PromptFusionAgent] 子 checkpoint hash 不匹配，忽略`);
        return null;
      }
      console.log(`[PromptFusionAgent] 📂 子 checkpoint 已加载: ${data.completed}/${data.total} 镜头`);
      // 【v2.1.10-fix】加载后保留文件，供后续增量写入覆盖；仅在全部完成后清理
      return data;
    } catch (e) {
      console.warn(`[PromptFusionAgent] 子 checkpoint 加载失败: ${e.message}`);
      return null;
    }
  }

  /**
   * 【v2.1.10-fix 提示词融合断点】清理子 checkpoint（全部镜头完成后调用）
   */
  _clearSubCheckpoint(checkpointMgr, blueprintHash) {
    const fs = require('fs');
    const path = require('path');
    const subCkptPath = path.join(checkpointMgr.baseDir || './checkpoints', `checkpoint-phase3-${blueprintHash}.json`);
    if (fs.existsSync(subCkptPath)) {
      try { fs.unlinkSync(subCkptPath); } catch (_) {}
    }
  }

  async _fuseSingleShot(shot, ratio, characters, blueprint, shotBudget = null) {
    const prompt = this._buildBatchPrompt([shot], ratio, characters, blueprint);
    // 【v2.1.4-fix10-P25-fix3】把空 schema 换成带 25 字段键名的完整模板
    // 【P1-4 修复】schema 加 required/requiredArrays/rejectEmptyArray,让质量门真正生效
    const schema = {
      required: ['shots'],
      requiredArrays: ['shots'],
      rejectEmptyArray: true,
      shots: [buildFullSchema(shot.shotId)]
    };

    // 【P1-PROMPT-08 修复】传递镜头级独立预算
    // 【2026-07-17】关键环节标记：PromptFusion 必须 LLM 驱动，不降级到规则
    const llmResult = await this._callLLM(prompt, schema, () => {
      throw new Error('LLM fallback');
    }, { shotBudget, critical: true });

    const fusionEntry = llmResult.result?.shots?.find(s => s.shotId === shot.shotId);
    let fields = fusionEntry?.fields || {};

    // 【v2.1.8-fix】如果LLM返回的fields为空或所有值为空，直接走降级
    const fieldValues = Object.values(fields).filter(v => v !== undefined && v !== null && String(v).trim() !== '');
    if (fieldValues.length === 0) {
      console.warn(`[PromptFusion] ${shot.shotId} LLM返回字段全空,直接降级`);
      return this._fastFallback(shot, ratio);
    }

    // 【v2.1.4-fix10】在 LLM 输出入口统一标准化为 snake_case
    fields = normalizeFields(fields);

    // 【P1-4 修复】根据LLM结果和字段完整性标记降级状态
    const usedFallback = llmResult.degraded || Object.keys(fields).length === 0;
    const completeness = await this._ensureFieldCompleteness(shot, fields, ratio, characters);
    fields = completeness.fields;
    const finalDegraded = usedFallback || completeness.usedRuleFallback;
    const finalDegradeReason = finalDegraded
      ? (usedFallback ? '主LLM失败,规则兜底' : '部分字段规则补齐')
      : null;

    // 【v2.1.4-fix9-P25-fix7】将 fields 中的关键字段展开到 shot 顶层
    const expandedFields = { ...fields };

    // v2.1.7: 跨字段一致性校验 + 自动修复
    const shotWithBlueprint = { ...shot, fields, blueprint: shot.blueprint || blueprint };
    // 【P1-ARCH-07 修复】清理blueprint引用，防止内存泄漏
    if (shotWithBlueprint.blueprint) {
      delete shotWithBlueprint.blueprint;
    }
    const checkResult = this.consistencyChecker.check(shotWithBlueprint);
    if (!checkResult.valid || checkResult.warningCount > 0) {
      console.log(`[PromptFusionAgent] ${shot.shotId} 字段一致性: ${checkResult.issues.length} issues, 自动修复中...`);
      const fixed = this.consistencyChecker.autoFix(shotWithBlueprint);
      if (fixed.fields) {
        Object.assign(fields, fixed.fields);
      }
    }

    // 【P0-PROMPT-05 修复】autoFix 修改 fields 后,重新组装 prompt,确保 prompt 反映修复后的字段
    const fullPrompt = this._assembleStandardPrompt(shot, fields, ratio);

    // 【v2.4.5】三段式·阶段3：语义精炼（守卫回退保护在 _finalizeShotResult 内）
    return this._finalizeShotResult(shot, {
      ...shot,
      ...expandedFields,
      fields,
      fusionText: fields.scene || '',
      prompt: fullPrompt, // 【P0-PROMPT-05 修复】现在包含 autoFix 的修改
      promptCharCount: this._countChars(fullPrompt),
      degraded: finalDegraded, // 【P1-4 修复】真实降级标记
      degradeReason: finalDegradeReason
    });
  }

  /**
   * 【v2.1.4-fix10-P25-fix3】字段完整性校验 + 定向补齐
   * 先校验,缺哪些就只让 LLM 补哪些,一次轻量调用搞定
   */
  async _ensureFieldCompleteness(shot, fields, ratio, characters, trackCall = null) {
    let usedRuleFallback = false;
    // 1. 找出缺失或过短字段
    const missing = _getRequiredFieldsForShot(shot).filter(f => {
      const v = fields[f];
      if (!v || String(v).trim() === '') return true;
      const min = MIN_LEN[f] || 0;
      return min > 0 && this._countChars(String(v)) < min;
    });

    if (missing.length === 0) return { fields, usedRuleFallback: false }; // 全齐,无需补

    console.log(`[PromptFusion] ${shot.shotId} 缺失/过短字段 ${missing.length} 个: ${missing.join(',')} → 定向补齐`);

    // 2. 只补缺失字段,给 LLM 一个极简、聚焦的 prompt
    const fillPrompt = this._buildFillPrompt(shot, missing, fields, ratio, characters);
    const fillSchema = { shotId: shot.shotId, fields: Object.fromEntries(missing.map(k => [k, STANDARD_FIELDS_SCHEMA[k]])) };

    try {
      // 【P1-2 修复】fill调用用小预算,不占用主调用时间
  // 【修复】提升重试和超时,给补齐更多机会
      const fillResult = await this._callLLM(fillPrompt, fillSchema, () => null, {
        maxRetries: 2,
        maxTokens: 4096,
        timeoutMs: 180000 // 【v2.1.8-fix10】fill 180s,避免批量补齐超时
      });
      const fillFields = fillResult?.result?.fields || fillResult?.result?.[shot.shotId] || {};
      const normalized = normalizeFields(fillFields);
      for (const k of missing) {
        if (normalized[k]) {
          // 【P0-PROMPT-04 修复】安全赋值:对象类型字段序列化为字符串
          let value = normalized[k];
          if (typeof value === 'object' && value !== null) {
            // timeline 支持结构化对象,需要特殊处理
            // 【P1-DATA-01 修复】统一为对象数组格式，提取 beats 为文本格式
            if (k === 'timeline' && value && value.beats) {
              const beatsText = value.beats.map(b => `T${String(Math.floor(b.time / 60)).padStart(2, '0')}:${String(b.time % 60).padStart(2, '0')} - ${b.description || b.label || ''}`).join('; ');
              value = beatsText || this._renderStructuredTimeline(value);
            } else {
              // 其他对象字段安全序列化
              try {
                value = JSON.stringify(value);
              } catch {
                value = String(value);
              }
            }
          }
          if (String(value).trim() !== '' && !String(value).startsWith('[object ')) {
            fields[k] = value;
          }
        }
      }
    } catch (e) {
      console.warn(`[PromptFusion] ${shot.shotId} 补齐失败,保留已有: ${e.message}`);
    }

    // 3. 仍缺的字段,先尝试从 shotData 提取,然后批量 LLM 补齐(而非逐个),失败再用固定模板兜底
    const stillMissing = _getRequiredFieldsForShot(shot).filter(f => !fields[f] || String(fields[f]).trim() === '');
    if (stillMissing.length > 0) {
      usedRuleFallback = true;
      const shotData = this._extractFieldsFromShot(shot);

      // 先从 shotData 填充
      const stillNeedLLM = [];
      for (const f of stillMissing) {
        if (shotData[f]) {
          fields[f] = shotData[f];
        } else {
          stillNeedLLM.push(f);
        }
      }

      // 【v2.1.8-fix4】批量 LLM 降级:一次调用补齐所有缺失字段
      if (stillNeedLLM.length > 0) {
        console.log(`[PromptFusion] ${shot.shotId} 批量降级 ${stillNeedLLM.length} 个字段 → 单次 LLM 调用`);
        const batchValues = await this._batchMinimalLLMDegradation(stillNeedLLM, shot, ratio, characters, trackCall);
        for (const f of stillNeedLLM) {
          fields[f] = batchValues[f] || this._defaultFieldValue(f, shot);
        }
      }

      console.warn(`[PromptFusion] ${shot.shotId} 兜底 ${stillMissing.length} 字段(批量 LLM + 规则兜底)`);
    }

    return { fields, usedRuleFallback };
  }

  /**
   * 【P0-PERF-01 修复】带截止时间的单镜头融合
   * 【P0-ARCH-03 修复】trackCall: 降级路径调用计数器
   */
  async _fuseSingleShotWithDeadline(shot, ratio, characters, blueprint, deadline, trackCall = null) {
    if (trackCall) trackCall();
    const remainingMs = () => deadline - Date.now();

    // 主调用(仅1次重试,不再3次)
    for (let attempt = 0; attempt <= 1; attempt++) {
      if (remainingMs() < 30000) throw new Error('预算不足');
      try {
        // 【P1-PROMPT-08 修复】计算并传递镜头级独立预算
        const shotBudget = remainingMs();
        return await this._fuseSingleShot(shot, ratio, characters, blueprint, shotBudget);
      } catch (e) {
        if (attempt === 0 && remainingMs() > 60000) {
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        throw e;
      }
    }
  }

  /**
   * 【P0-PERF-01 修复】快速兜底:不调用任何LLM,纯规则生成
   */
  _fastFallback(shot, ratio) {
    const fields = {};
    for (const f of _getRequiredFieldsForShot(shot)) {
      fields[f] = this._dynamicDefaultValue(f, shot);
    }
    // 【v2.4.5】快速兜底是无 LLM 紧急路径：跳过语义精炼层（LLM 不可用），保持同步直接组装
    const fullPrompt = this._assembleStandardPrompt(shot, fields, shot.ratio || '16:9');
    return {
      ...shot,
      ...fields,
      fields,
      fusionText: fields.scene || '',
      prompt: fullPrompt,
      promptCharCount: this._countChars(fullPrompt),
      degraded: true,
      degradeReason: '主LLM超时,通过重试补全生成',
      semanticRefinement: { applied: false, actions: [], fallbackReason: 'fastFallback路径跳过' }
    };
  }

  /**
   * 【P0-PERF-01 修复】动态默认值:基于镜头上下文生成参数化模板
   */
  _dynamicDefaultValue(field, shot) {
    const shotIndex = parseInt(shot.shotId?.replace(/\D/g, '') || '0');
    const sceneType = shot.sceneType || 'standard';
    const character = shot.character || '主角';
    const scene = shot.scene || '';

    const variations = {
      director_instruction: [
        '电影级写实风格,专业摄影布光,细腻质感,自然光效',
        '好莱坞质感纪录片摄影,真实环境光线,专业调色',
        'IMAX级别画面精度,写实主义美学,电影级色彩管理'
      ],
      lighting: [
        `主光:侧向自然光5600K漫射,补光:左前方反光板,${character}面部清晰明亮`,
        `顶光+环境反射光混合照明,${scene ? String(scene).split(/[，。；]/)[0].slice(0, 20) : '室内'}空间均匀明亮`, // 【v2.1.15-fix】场景取首子句，不腰斩
        `窗光为主光源,漫反射柔光填充,${character}轮廓分明`
      ],
      scene: [
        scene || `${sceneType}场景,室内写实环境,自然光线,真实材质质感`,
        scene || `专业${sceneType}空间,顶灯照明,墙面材质真实,环境细节丰富`
      ]
    };

    const varList = variations[field];
    if (varList) {
      return varList[shotIndex % varList.length];
    }
    return this._defaultFieldValue(field, shot);
  }

  /**
   * 【v2.1.4-fix13-审计修复】降为1次重试,去掉指数退避等待,失败后直接规则兜底
   * 【P0-ARCH-03 修复】trackCall: 降级路径调用计数器
   */
  async _fillMissingFieldsWithRetry(shot, ratio, characters, deadline = null, trackCall = null) {
    if (trackCall) trackCall();
    // 【修复】从 1 次提升到 2 次重试，但受全局计数器限制
    const maxRetries = 2; // 【P0-PERF-01 修复】减少重试次数
    
    // 先从shot中提取已有数据，保留上游内容（【P1-ARCH-06 修复】降级时保留原始fields，仅补齐缺失）
    // 【P1-DATA-02 修复】清理顶层冗余字段，统一使用fields对象
    // 【v2.1.8-审计修复】深拷贝避免修改原始 shot
    const shotClone = JSON.parse(JSON.stringify(shot));
    if (shotClone.fields && typeof shotClone.fields === 'object') {
      for (const key of Object.keys(shotClone)) {
        if (!['shotId', 'sceneType', 'timing', 'fields', 'blueprint'].includes(key)) {
          delete shotClone[key]; // 删除顶层重复字段，统一使用fields
        }
      }
    }
    const fields = {};
    const shotData = this._extractFieldsFromShot(shotClone);
    // 优先保留shot中已有的原始字段，不覆盖
    for (const f of _getRequiredFieldsForShot(shotClone)) {
      // 保留原始值：如果shot已有且非空，则保留；否则使用提取的shotData或空字符串
      const originalValue = shotClone[f] || shotData[f] || '';
      fields[f] = originalValue;
    }
    
    const fillDeadline = deadline || (Date.now() + 120000); // 默认2分钟补齐预算
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      // 【P0-PERF-01 修复】检查截止时间
      if (Date.now() > fillDeadline - 10000) {
        console.warn(`  ⏰ 补齐预算不足，中止重试`);
        break;
      }
      
      const remaining = this._remainingMs ? this._remainingMs() : Infinity;
      if (remaining < 10000) {
        console.warn(`  ⏰ 剩余预算不足(${remaining}ms),中止补全重试`);
        break;
      }

      try {
        console.log(`  🔄 补全尝试 ${attempt}/${maxRetries}...`);
        if (trackCall) trackCall();
        // 【v2.1.8-审计修复】传递 trackCall 到 _ensureFieldCompleteness
        const completeness = await this._ensureFieldCompleteness(shotClone, fields, ratio, characters, trackCall);

        // 【审计修复】更新 fields,让下次重试基于最新状态
        Object.assign(fields, completeness.fields);

        // 检查是否还有空字段
        const stillEmpty = _getRequiredFieldsForShot(shotClone).filter(f => !fields[f] || String(fields[f]).trim() === '');
        if (stillEmpty.length === 0) {
          console.log(`  ✅ 补全成功,所有字段已填充`);
          return await this._buildShotResult(shotClone, fields);
        }
        console.log(`  ⚠️ 仍有 ${stillEmpty.length} 字段为空,继续重试...`);
      } catch (e) {
        console.warn(`  ❌ 补全尝试 ${attempt} 失败: ${e.message}`);
      }
    }

    // 【修复】重试用完仍有缺失,返回当前已填充的字段(不强制兜底为默认值)
    // 原因:部分字段有值比全部模板化更好,保留 LLM 已生成的内容
    console.warn(`  ⚠️ 补全重试耗尽,返回已有字段(${Object.keys(fields).filter(k => fields[k]).length}/${_getRequiredFieldsForShot(shotClone).length} 已填充)`);
    return await this._buildShotResult(shotClone, fields);
  }

  // 【v2.1.0】最小 LLM 降级:用缩短的 prompt + 剧本上下文推断字段,保留创作灵气
  async _minimalLLMDegradation(field, shot, ratio, characters) {
    try {
      const ctx = this._buildMinimalContext(shot, ratio, characters);
      const prompt = `根据以下镜头上下文,生成 "${field}" 字段的值。只输出该字段的值,不要解释。

镜头上下文:
${ctx}

字段要求:${FIELD_DESCS[field] || '无特殊要求'}

注意:
- 必须与镜头上下文(角色、场景、情绪)匹配
- 拒绝通用模板(如"好莱坞电影级质感")
- 保持创作灵气,个性化描述`;

      const schema = { [field]: STANDARD_FIELDS_SCHEMA[field] || '' };
      const result = await this._callLLM(prompt, schema, () => null, {
        maxRetries: 2,
        maxTokens: 2048,
        timeoutMs: 180000, // 【v2.1.8-fix12】最小降级超时 60s→180s
        shotBudget: 180000 // 镜头级独立预算 180s
      });

      if (result?.result?.[field] && String(result.result[field]).trim()) {
        const value = String(result.result[field]).trim();
        // 过滤掉明显的模板文本
        if (value.length > 10 && !value.includes('好莱坞') && !value.includes('室内写实')) {
          console.log(`[PromptFusion] ${shot.shotId} ${field} 最小降级成功 ✓`);
          return value;
        }
      }
      return null;
    } catch (e) {
      console.warn(`[PromptFusion] ${shot.shotId} ${field} 最小降级失败: ${e.message}`);
      return null;
    }
  }

  /**
   * 【v2.1.8-fix5】分组批量 LLM 降级:按逻辑分组,每组一次调用
   * 分组策略:
   * - 视觉组:lighting, composition, color_palette, depth_of_field, camera_movement
   * - 角色组:character, costume, makeup, action, props
   * - 叙事组:timeline, mood, pacing, transition, audio
   * - 技术组:constraint, baseline, negative, bright_constraint, character_constraint, consistency
   * - 指令组:director_instruction, scene
   *
   * 相比 v2.1.8-fix4 的全批量:字段间上下文更聚焦,质量接近逐个
   * 相比逐个:速度提升 5-6 倍(25 次 → 4-5 次调用)
   */
  async _batchMinimalLLMDegradation(fields, shot, ratio, characters, trackCall = null) {
    if (trackCall) trackCall();
    if (fields.length === 0) return {};

    // 字段分组定义
    const FIELD_GROUPS = {
      visual: ['lighting', 'composition', 'color_palette', 'depth_of_field', 'camera_movement'],
      character: ['character', 'costume', 'makeup', 'action', 'props'],
      narrative: ['timeline', 'mood', 'pacing', 'transition', 'audio'],
      technical: ['constraint', 'baseline', 'negative', 'bright_constraint', 'character_constraint', 'consistency'],
      instruction: ['director_instruction', 'scene']
    };

    // 将缺失字段映射到对应组
    const groupAssignments = {};
    for (const f of fields) {
      let assigned = false;
      for (const [groupName, groupFields] of Object.entries(FIELD_GROUPS)) {
        if (groupFields.includes(f)) {
          groupAssignments[groupName] = groupAssignments[groupName] || [];
          groupAssignments[groupName].push(f);
          assigned = true;
          break;
        }
      }
      if (!assigned) {
        // 未匹配的字段归入 instruction 组
        groupAssignments['instruction'] = groupAssignments['instruction'] || [];
        groupAssignments['instruction'].push(f);
      }
    }

    const ctx = this._buildMinimalContext(shot, ratio, characters);
    const allResults = {};

    // 【P0-PROMPT-03 修复】组间并行执行,最多2组并发(避免API限流)
    const groupEntries = Object.entries(groupAssignments).filter(([_, gfs]) => gfs.length > 0);
    const CONCURRENCY = 2; // 最多2组同时调用

    for (let i = 0; i < groupEntries.length; i += CONCURRENCY) {
      const batch = groupEntries.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.allSettled(
        batch.map(async ([groupName, groupFields]) => {
          try {
            const fieldDescs = groupFields.map(f => `- ${f}: ${FIELD_DESCS[f] || '无特殊要求'}`).join('\n');
            const groupContext = this._buildGroupContext(groupName, shot, ratio, characters);

            const prompt = `根据以下镜头上下文,生成 ${groupFields.length} 个字段的值。以 JSON 格式输出所有字段。

${groupContext}

镜头上下文:
${ctx}

需要生成的字段:
${fieldDescs}

注意:
- 每个字段必须与镜头上下文(角色、场景、情绪)匹配
- 拒绝通用模板(如"好莱坞电影级质感")
- 保持创作灵气,个性化描述
- 直接返回 JSON 对象,不要包裹在 code block 中`;

            const schema = { fields: Object.fromEntries(groupFields.map(f => [f, STANDARD_FIELDS_SCHEMA[f] || ''])) };
            const result = await this._callLLM(prompt, schema, () => null, {
              maxRetries: 2,
              maxTokens: 4096,
              timeoutMs: 180000,
              shotBudget: 180000
            });

            const batchFields = result?.result?.fields || result?.result || {};
            const normalized = normalizeFields(batchFields);
            const groupResults = {};

            for (const f of groupFields) {
              const value = normalized[f];
              if (value && String(value).trim().length > 10
                  && !String(value).includes('好莱坞')
                  && !String(value).includes('室内写实')) {
                groupResults[f] = String(value).trim();
              }
            }

            console.log(`[PromptFusion] ${shot.shotId} ${groupName}组(${groupFields.length}字段)降级成功 ✓`);
            return { groupName, results: groupResults };
          } catch (e) {
            console.warn(`[PromptFusion] ${shot.shotId} ${groupName}组降级失败: ${e.message}`);
            return { groupName, results: {}, error: e.message };
          }
        })
      );

      // 合并结果
      for (const r of batchResults) {
        if (r.status === 'fulfilled') {
          Object.assign(allResults, r.value.results);
        }
      }
    }

    return allResults;
  }

  /**
   * 为不同字段组构建针对性上下文
   */
  _buildGroupContext(groupName, shot, ratio, characters) {
    const contexts = {
      visual: `你是资深电影摄影师。请从摄影、光影、构图、色彩角度描述镜头。`,
      character: `你是角色造型设计师。请从人物造型、服装、妆容、动作角度描述。`,
      narrative: `你是剪辑师/声音设计师。请从节奏、情绪、时间线、转场角度描述。`,
      technical: `你是技术总监。请提供精确的格式约束和技术规范。`,
      instruction: `你是导演。请给出高层次的视觉指导和场景描述。`
    };
    return contexts[groupName] || contexts['instruction'];
  }

  _buildMinimalContext(shot, ratio, characters) {
    const parts = [];
    parts.push(`场景: ${shot.scene || shot.sceneDescription || '未知'}`);
    parts.push(`情绪: ${shot.mood || shot.emotional_target || '未知'}`);
    parts.push(`动作: ${shot.action || '未知'}`);

    if (shot.characters && shot.characters.length > 0) {
      parts.push(`角色: ${shot.characters.map(c => c.name || c).join(', ')}`);
    }
    if (characters && characters.length > 0) {
      const charNames = characters.map(c => c.name || c.character?.name || c).join(', ');
      if (charNames) parts.push(`角色系统: ${charNames}`);
    }

    if (shot.dialogue) {
      const dialogue = typeof shot.dialogue === 'string' ? shot.dialogue :
        (shot.dialogue.lines || []).map(l => l.content).join('; ');
      if (dialogue) parts.push(`台词: ${dialogue}`);
    }

    parts.push(`时长: ${shot.duration || '?'}s`);
    parts.push(`画幅: ${ratio || '16:9'}`);

    if (shot.timeOfDay) parts.push(`时间: ${shot.timeOfDay}`);
    if (shot.location) parts.push(`地点: ${shot.location}`);
    if (shot.sceneType) parts.push(`场景类型: ${shot.sceneType}`);

    return parts.join('\n');
  }

  // 【v2.1.4-fix11】规则兜底默认值 - 25字段完整默认值,确保绝不返回空字符串
  // 【v2.1.0】注意:此方法仅在最小 LLM 降级失败后才调用,作为最终底线
  /**
   * 【P1-PROMPT-03 修复】动态默认值：基于镜头索引和场景类型选择变体模板
   */
  _defaultFieldValue(field, shot) {
    const ratio = shot.ratio || '16:9';
    const sceneType = shot.sceneType || 'standard';
    const character = shot.character || '主角';
    const shotIndex = parseInt(shot.shotId?.replace(/\D/g, '') || '0');

    // 变体模板池（按场景类型分类）
    const variations = {
      director_instruction: [
        '好莱坞电影级质感,写实风格,专业摄影布光,8K超高清',
        'IMAX级别画面精度,写实主义美学,电影级色彩管理,细腻纹理',
        '欧洲艺术电影质感,自然光效,柔和色调,真实情感表达',
        '新现实主义风格,手持摄影质感,环境光主导,生活化真实感'
      ],
      lighting: [
        '主光:右侧45度自然光 5600K柔光漫射;补光:左前侧反光板填充阴影;背景光:轮廓光分离层次;光比3:1,整体明亮清晰',
        '顶光+环境反射光混合照明,漫射柔光,面部阴影柔和自然,整体明亮通透',
        '窗光为主光源,侧向入射,漫反射柔光填充,人物轮廓分明,层次感强',
        '逆光+正面补光,人物边缘有轮廓光,面部受光均匀,背景适度虚化'
      ],
      composition: [
        '景别:中景(膝上);主体位置:画面黄金分割点;线条引导:纵深层次感;画框边缘:适度留白',
        '景别:近景(胸上);主体面部清晰;背景适度虚化;焦点精准;画面紧凑有力',
        '景别:全景;展示完整人物与环境关系;空间纵深感;环境细节丰富',
        '景别:特写(面部);情绪表达为核心;浅景深;背景完全虚化;眼神光清晰'
      ],
      color_palette: [
        '主色调:自然偏暖;辅助色:环境本色;肤色:自然健康;饱和度:中等自然;对比度:中高清晰',
        '主色调:冷色偏蓝;辅助色:灰色调;肤色:冷白自然;饱和度:低;对比度:高冷峻',
        '主色调:暖色偏金;辅助色:琥珀色;肤色:暖健康;饱和度:中高;对比度:中等',
        '主色调:中性自然;辅助色:原色真实;肤色:标准自然;饱和度:真实;对比度:自然'
      ],
      camera_movement: [
        '0-3s:固定机位稳定构图;3-6s:缓慢推近或平移;6-10s:回到固定机位',
        '0-3s:缓慢拉远展示环境;3-6s:固定机位;6-10s:轻微横移增加动感',
        '0-3s:低角度固定;3-6s:缓慢升起;6-10s:高角度俯瞰',
        '全程固定机位,画面绝对稳定,无抖动,专业三脚架效果'
      ],
      mood: [
        'calm, professional, natural',
        'tense, dramatic, focused',
        'warm, intimate, peaceful',
        'energetic, dynamic, vibrant'
      ]
    };

    // 根据镜头索引选择变体（循环使用）
    const varList = variations[field];
    if (varList) {
      return varList[shotIndex % varList.length];
    }

    // 无变体的字段使用原始静态默认值
    const defaults = {
      constraint: `Aspect ratio: ${ratio}, Resolution: 1920x1080, Format: MP4, Frame rate: 24fps, no text anywhere in frame, no subtitle, no caption, no watermark, no logo, no readable characters`,
      baseline: '8K resolution, cinematic quality, highly detailed, photorealistic, hyperrealistic, sharp focus, ultra high definition, lifelike textures, professional color grading',
      scene: `${sceneType}场景,室内写实环境,自然光线照射,真实材质质感,空间层次分明,环境细节丰富`,
      character: `${character},写实人物形象,自然姿态,真实表情,符合场景身份`,
      costume: '符合角色身份的写实服装,面料质感真实,颜色自然,款式简洁大方',
      makeup: '素颜或淡妆,妆容自然真实,发型整洁,符合日常生活场景',
      action: `${character}自然站立或行走,手部自然动作,眼神交流,真实肢体语言`,
      props: '场景中必要的写实道具,材质真实,无文字标识,符合场景功能',
      portraits: 'image://characters/default/portrait.png',
      dialogue: '',
      timeline: 'T00:00 - 开场构图,环境展示;T00:03 - 主体进入画面;T00:06 - 核心动作或对白;T00:09 - 收尾定格',
      pacing: '整体:沉稳中等节奏;开头:平缓引入;中段:自然推进;结尾:平稳收尾',
      transition: '自然切换,无特效转场,直接硬切或微淡入淡出',
      audio: '环境底噪真实自然,无明显配乐干扰,人声音量适中清晰,空间感真实',
      negative: 'no text anywhere in frame, no watermark, no logo, no subtitle, no caption, no blur, no distortion, no extra limbs, no deformed features, no cartoon style, no anime, no illustration, no painting, no 3D render, no CGI, no special effects, no abstract, no surreal',
      bright_constraint: 'bright lighting, well-lit scene, clear visibility, natural illumination, avoid dark shadows',
      character_constraint: '只出现指定角色一人,禁止其他人物入镜,禁止同一角色重复出现,禁止角色分身或克隆,保持角色形象一致',
      consistency: '保持角色面部特征、服装造型、发型妆容跨镜头一致,场景光线连续,色调统一'
    };

    const value = defaults[field];
    if (!value) {
      console.warn(`[PromptFusionAgent] 未知字段的默认值: ${field}`);
      return `[规则兜底] ${field} 默认值`;
    }
    return value;
  }

  // ==================== v2.1.7: 动态字段生成 ====================

  /**
   * 从blueprint动态生成导演指令
   */
  _generateDirectorInstruction(blueprint, mood) {
    const style = blueprint.style || blueprint.config?.style || 'cinematic';
    const creativeIntensity = blueprint.creativeIntensity || blueprint.config?.creativeIntensity || 0.7;
    const genre = blueprint.genre || blueprint.config?.genre || '';

    const styleTemplates = {
      cinematic: {
        low: '电影级写实风格,专业摄影布光,细腻质感,自然光效',
        medium: '好莱坞电影级质感,写实风格,专业摄影布光,8K超高清, cinematic color grading',
        high: '史诗电影级大制作,IMAX质感,专业电影摄影,极致细节,戏剧化布光,8K超高清'
      },
      documentary: {
        low: '纪录片风格,自然光,真实记录,手持摄影质感',
        medium: '纪实电影风格,自然光效,真实环境,专业纪录片摄影',
        high: '沉浸式纪录片,电影级纪实摄影,环境光主导,真实质感'
      },
      animation: {
        low: '柔和动画风格,温暖色调,简洁线条,清晰画面',
        medium: '精品动画风格,丰富色彩,流畅动作,专业动画摄影',
        high: '顶级动画电影风格,极致色彩表现,复杂场景,电影级动画摄影'
      }
    };

    const intensity = creativeIntensity < 0.4 ? 'low' : creativeIntensity < 0.8 ? 'medium' : 'high';
    const template = styleTemplates[style]?.[intensity] || styleTemplates.cinematic[intensity];

    // 根据情绪微调
    const moodModifiers = {
      tense: ',紧张氛围,高对比布光,强化戏剧张力',
      sad: ',忧郁基调,低饱和色调,柔光处理',
      epic: ',史诗气势,宏大构图,金色光线,戏剧化阴影',
      warm: ',温馨氛围,暖色调,柔和光线',
      calm: ',宁静基调,均匀布光,自然色调'
    };

    const moodStr = this._extractMoodFromString(mood);
    const modifier = moodModifiers[moodStr] || '';

    return `${template}${modifier}`;
  }

  /**
   * 从blueprint动态生成画质基础
   */
  _generateBaseline(blueprint, duration) {
    const style = blueprint.style || blueprint.config?.style || 'cinematic';
    const resolution = duration <= 30 ? '4K' : duration <= 60 ? '6K' : '8K';

    const styleWords = {
      cinematic: 'cinematic quality, film grain, professional color grading',
      documentary: 'documentary realism, natural textures, authentic lighting',
      animation: 'vivid colors, smooth gradients, clean lines, vibrant animation'
    };

    return `${resolution} resolution, ${styleWords[style] || styleWords.cinematic}, highly detailed, photorealistic, sharp focus, ultra high definition, lifelike textures`;
  }

  /**
   * 从lighting动态推导明亮约束
   */
  /**
   * 【v2.2-refine 重写】从lighting动态推导明亮约束 — 中文短句, 不复述灯光细节
   * 原实现返回英文长句(60-120字符), 与灯光正文80%重复且中英混排
   */
  _generateBrightConstraint(lighting, mood) {
    const lightingStr = String(lighting || '').toLowerCase();
    const moodStr = this._extractMoodFromString(mood);

    if (lightingStr.includes('night') || lightingStr.includes('moon') || lightingStr.includes('dark') || lightingStr.includes('夜')) {
      return '低照度氛围光，主体轮廓清晰可辨不死黑';
    }
    if (moodStr === 'sad') {
      return '柔光低照度，主体可见无强烈亮部';
    }
    if (moodStr === 'epic') {
      return '强光比戏剧性照明，主体明亮突出';
    }
    return '主体明亮清晰，阴影保留层次不死黑';
  }

  /**
   * 提取情绪关键词
   */
  _extractMoodFromString(moodStr) {
    if (!moodStr) return null;
    const str = String(moodStr).toLowerCase();
    const moodMap = {
      tense: ['tense', '紧张', '紧迫', '悬疑', 'anxious', 'nervous'],
      sad: ['sad', '悲伤', '忧郁', 'melancholy', 'sorrow', 'grief'],
      epic: ['epic', '史诗', '宏大', '壮丽', 'grand', 'majestic'],
      warm: ['warm', '温馨', '温暖', 'cozy', 'gentle', 'tender'],
      calm: ['calm', '平静', '宁静', 'peaceful', 'serene', 'tranquil']
    };
    for (const [mood, markers] of Object.entries(moodMap)) {
      if (markers.some(m => str.includes(m))) return mood;
    }
    return null;
  }

  /**
   * ⭐ v2.1.7: 渲染结构化时间轴对象为文本
   */
  _renderStructuredTimeline(timelineObj) {
    if (!timelineObj || !timelineObj.beats || !Array.isArray(timelineObj.beats)) {
      return '';
    }
    const beats = timelineObj.beats;
    const duration = timelineObj.totalDuration || 10;

    return beats.map(b => {
      const timeStr = `T00:${String(b.time || 0).padStart(2, '0')}`;
      const label = b.label || '';
      const desc = b.description || '';
      const cameraHint = b.cameraHint ? ` [运镜:${b.cameraHint}]` : '';
      return `${timeStr} - ${label}${desc ? ',' + desc : ''}${cameraHint}`;
    }).join(';');
  }

  /**
   * ⭐ v2.1.7: 按镜头时长动态生成时间轴节拍
   * 5秒→3节拍, 8秒→5节拍, 12秒→6节拍, 15秒+→7节拍
   */
  _generateTimelineBeats(duration) {
    const d = duration || 10;
    if (d <= 5) {
      return 'T00:00 - 全景establishing,环境展示;T00:02 - 主体动作,情绪推进;T00:04 - 收尾定格,情绪落定';
    } else if (d <= 8) {
      const s2 = Math.floor(d * 0.25);
      const s3 = Math.floor(d * 0.5);
      const s4 = Math.floor(d * 0.75);
      return `T00:00 - 全景establishing,环境展示;T00:${String(s2).padStart(2, '0')} - 主体入画,动作开始;T00:${String(s3).padStart(2, '0')} - 情绪推进,动作展开;T00:${String(s4).padStart(2, '0')} - 动作高潮,情绪升温;T00:${String(d-1).padStart(2, '0')} - 收尾定格,情绪落定`;
    } else if (d <= 12) {
      const s2 = Math.floor(d * 0.2);
      const s3 = Math.floor(d * 0.4);
      const s4 = Math.floor(d * 0.6);
      const s5 = Math.floor(d * 0.8);
      return `T00:00 - 全景establishing,环境展示,冷静氛围;T00:${String(s2).padStart(2, '0')} - 中景推进,主体动作;T00:${String(s3).padStart(2, '0')} - 情绪升温,动作展开;T00:${String(s4).padStart(2, '0')} - 动作高潮,情绪顶点;T00:${String(s5).padStart(2, '0')} - 情绪回落,光线平复;T00:${String(d-1).padStart(2, '0')} - 收尾定格`;
    } else {
      const s2 = Math.floor(d * 0.15);
      const s3 = Math.floor(d * 0.3);
      const s4 = Math.floor(d * 0.45);
      const s5 = Math.floor(d * 0.6);
      const s6 = Math.floor(d * 0.75);
      const s7 = Math.floor(d * 0.9);
      return `T00:00 - 全景establishing,环境展示,冷静氛围;T00:${String(s2).padStart(2, '0')} - 主体入画,动作开始;T00:${String(s3).padStart(2, '0')} - 中景推进,情绪升温;T00:${String(s4).padStart(2, '0')} - 动作展开,情绪推进;T00:${String(s5).padStart(2, '0')} - 情绪顶点,动作高潮;T00:${String(s6).padStart(2, '0')} - 情绪回落,光线变化;T00:${String(s7).padStart(2, '0')} - 收尾定格,情绪落定`;
    }
  }

  // ==================== 原有方法 ====================
  _buildFillPrompt(shot, missing, existingFields, ratio, characters) {
    const ctx = Object.entries(existingFields)
      .filter(([k, v]) => v && String(v).trim())
      .map(([k, v]) => `${k}: ${String(v).slice(0, 80)}`)
      .join('\n');
    return `## 镜头补齐任务
镜头ID:${shot.shotId}(时长 ${shot.duration || '?'}s)
场景:${shot.scene || ''}
情绪:${shot.mood || ''}
台词:${(shot.dialogue?.lines?.map(l => l.content).join('; ') || shot.dialogue || '')}

## 已生成字段(保持风格一致)
${ctx}

## 本次只补齐以下字段,每个必须达到最低字符数
${missing.map(f => `- ${f}:${FIELD_DESCS[f]}`).join('\n')}

只输出 JSON,不要解释。`;
  }

  /**
   * 【v2.1.4-fix10-fix1】从 shot 对象提取字段数据,用于补充 LLM 缺失字段
   */
  _extractFieldsFromShot(shot) {
    const result = {};
    if (!shot) return result;

    // === 25 字段完整提取 ===
    // 1. director_instruction
    const directorInstruction = this._resolveField(shot, 'director_instruction', 'directorInstruction');
    if (directorInstruction) result.director_instruction = directorInstruction;

    // 2. constraint
    const constraint = this._resolveField(shot, 'constraint');
    if (constraint) result.constraint = constraint;

    // 3. baseline
    const baseline = this._resolveField(shot, 'baseline');
    if (baseline) result.baseline = baseline;

    // 4. scene
    const scene = this._resolveField(shot, 'scene');
    if (scene) result.scene = scene;

    // 5. lighting
    const lighting = this._resolveField(shot, 'lightingString', 'lighting');
    if (lighting) result.lighting = lighting;

    // 6. composition
    const composition = this._resolveField(shot, 'composition');
    if (composition) result.composition = composition;

    // 7. color_palette
    const colorPalette = this._resolveField(shot, 'color_palette', 'colorPalette');
    if (colorPalette) result.color_palette = colorPalette;

    // 8. depth_of_field
    const depthOfField = this._resolveField(shot, 'depth_of_field', 'depthOfField');
    if (depthOfField) result.depth_of_field = depthOfField;

    // 9. camera_movement
    const cameraMovement = this._resolveField(shot, 'cameraString', 'cameraMovement', 'camera', 'camera_movement');
    if (cameraMovement) result.camera_movement = cameraMovement;

    // 10. character
    const character = this._resolveField(shot, 'character');
    if (character) result.character = typeof character === 'string' ? character : character?.name || '';

    // 11. costume
    const costume = this._resolveField(shot, 'costume');
    if (costume) result.costume = costume;

    // 12. makeup
    const makeup = this._resolveField(shot, 'makeup');
    if (makeup) result.makeup = makeup;

    // 13. action
    const action = this._resolveField(shot, 'action');
    if (action) result.action = action;

    // 14. props
    const props = this._resolveField(shot, 'props');
    if (props) result.props = props;

    // 15. portraits
    const portraits = this._resolveField(shot, 'portraits', 'characterRef');
    if (portraits) result.portraits = portraits;

    // 16. dialogue
    if (shot.dialogue) {
      const pureDialogue = shot.dialogueText || this._extractPureDialogue(shot.dialogue);
      if (pureDialogue) result.dialogue = `"${pureDialogue}"`;
    }

    // 17. timeline
    if (shot.duration) {
      const d = shot.duration;
      const seg1 = Math.floor(d * 0.3);
      const seg2 = Math.floor(d * 0.6);
      result.timeline = `T00:00 - 全景establishing,环境展示;T00:${String(seg1).padStart(2, '0')} - 中景推进,人物动作;T00:${String(seg2).padStart(2, '0')} - 情绪收尾,光线平复`;
    }

    // 18. mood
    const mood = this._resolveField(shot, 'mood');
    if (mood) result.mood = mood;
    const emotionalTarget = this._resolveField(shot, 'emotionalTarget', 'emotional_target');
    if (emotionalTarget) {
      const et = emotionalTarget;
      result.mood = `${et.valence > 0.5 ? 'positive' : 'neutral'}, ${et.arousal > 0.5 ? 'high energy' : 'calm'}`;
    }

    // 19. pacing
    const pacing = this._resolveField(shot, 'pacing');
    if (pacing) result.pacing = pacing;

    // 20. transition
    const transition = this._resolveField(shot, 'transition');
    if (transition) result.transition = transition;

    // 21. audio
    const audio = this._resolveField(shot, 'backgroundSoundString', 'backgroundSound', 'audio');
    if (audio) result.audio = audio;

    // 22. negative
    const negative = this._resolveField(shot, 'negative');
    if (negative) result.negative = negative;

    // 23. bright_constraint
    const brightConstraint = this._resolveField(shot, 'bright_constraint', 'brightConstraint');
    result.bright_constraint = brightConstraint || 'bright lighting, well-lit scene, clear visibility, no dark shadows on face, adequate illumination';

    // 24. character_constraint
    const characterNames = shot.characters?.map(c => c.name || c).join('、')
      || shot.character?.name
      || '指定角色';
    result.character_constraint = `只出现${characterNames},禁止其他未指定人物入镜,禁止同一角色重复出现,禁止角色分身或克隆`;

    // 25. consistency
    result.consistency = '保持角色形象一致,造型不变,面部特征与体型每帧统一';

    return result;
  }

  _fallbackSingleShot(shot, ratio) {
    const fallbackPrompt = this._assembleFullPrompt(shot, '', ratio);
    // 【v2.1.4-fix13-审计修复】保留原始 fields,避免降级时丢失所有字段
    const preservedFields = shot.fields && typeof shot.fields === 'object' && Object.keys(shot.fields).length > 0
      ? shot.fields
      : this._extractFieldsFromShot(shot);
    return {
      ...shot,
      fields: preservedFields,
      fusionText: '',
      prompt: fallbackPrompt,
      promptCharCount: this._countChars(fallbackPrompt),
      degraded: true,
      degradeReason: '单镜头 LLM 融合失败,规则兜底',
      _pf_fallback: true
    };
  }

  /**
   * 组装标准格式Prompt(按之前正常版本的字段格式)
   */
  /**
   * 【v2.3.1-排版】交付层字段格式化：序号 + 独立行
   * 最终交付 Prompt 由 ' | ' 单行连接改为 "01.【字段】内容" 逐行排列，便于人工审核与渲染排查。
   * 说明：内部组装/精炼/截断链路仍以 ' | ' 为机器分隔符，仅在 return 前做展示层转换；
   * 字段计数按【】标签进行（match(/【/g)），与分隔符无关，审核口径不变。
   */
  _formatNumberedFields(prompt) {
    if (!prompt || typeof prompt !== 'string') return prompt;
    const segs = prompt.split(' | ').map(s => s.trim()).filter(Boolean);
    return segs.map((s, i) => `${String(i + 1).padStart(2, '0')}.${s}`).join('\n');
  }

  _assembleStandardPrompt(shot, fields, ratio) {
    const parts = [];
    // 【v2.2.7-fix】函数级 duration 定义：_generateBaseline 等处直接引用 duration，
    // 旧代码依赖 fields.baseline 真值短路才侥幸不炸——fields.baseline 为空的镜头
    // 会以 ReferenceError 崩掉整个组装。属于长期潜伏bug。
    const duration = shot.duration || 10;

    // 【语言约束】⭐ 新增:强制中文输出
    parts.push('【语言约束】全部字段必须使用中文输出,禁止出现英文单词、英文短语、英文描述。');

    // 辅助函数:获取字段值(支持驼峰和下划线命名)
    const getField = (...names) => {
      for (const name of names) {
        if (fields[name] !== undefined && fields[name] !== null && fields[name] !== '') {
          return fields[name];
        }
      }
      return undefined;
    };

    // 【导演意图】拆分为独立字段
    const directorInstruction = getField('director_instruction', 'directorInstruction')
      || this._generateDirectorInstruction(shot.blueprint || {}, fields.mood);
    if (directorInstruction) parts.push(`【导演意图】${directorInstruction}`);

    // 【基础】独立输出
    const baseline = fields.baseline || this._generateBaseline(shot.blueprint || {}, duration);
    if (baseline) parts.push(`【基础】${baseline}`);

    // 【约束】独立输出
    const constraint = fields.constraint || '16:9画幅，4K分辨率，24fps，MP4格式';
    if (constraint) parts.push(`【约束】${constraint}`);

    // 【场景】
    // 【v2.1.11-重构】写实校验强度分级：按 visual_register 决定禁用词范围
    const { getRealismForbidden } = require('../../../config/production-profile');
    const visualRegister = this.productionProfile?.visual_register || 'realistic';
    const forbiddenWords = getRealismForbidden(visualRegister);
    let sceneDesc = fields.scene || shot.scene || '';
    const hasForbidden = forbiddenWords.scene.some(w => sceneDesc.includes(w));
    if (hasForbidden) {
      console.warn(`[PromptFusionAgent] ⚠️ 镜头 ${shot.shotId} 场景含禁止词汇(校验强度=${visualRegister}): "${sceneDesc.substring(0, 50)}...",强制替换为写实场景`);
      // 【修复 P0-1】领域中立兜底场景：从唯一真源读取，不含任何项目特定元素
      const fallbackScenes = FALLBACK_SCENES;
      // 使用sceneType和shotId哈希选择，避免简单轮询
      const sceneType = shot.sceneType || 'standard';
      const shotNum = parseInt(shot.shotId.replace(/\D/g, '')) || 0;
      const hash = this._simpleHash(sceneType + shotNum);
      sceneDesc = fallbackScenes[hash % fallbackScenes.length];
    }
    if (sceneDesc) parts.push(`【场景】${sceneDesc}`);

    // 【灯光设计】只输出 lighting，bright_constraint 拆为独立标签
    const lightingField = getField('lighting');
    if (lightingField) parts.push(`【灯光设计】${lightingField}`);

    // 【明亮约束】独立输出
    const brightConstraint = getField('bright_constraint', 'brightConstraint')
      || this._generateBrightConstraint(fields.lighting, fields.mood);
    if (brightConstraint) parts.push(`【明亮约束】${brightConstraint}`);

    // 【构图】⭐ 新增:景别+画面比例+主体位置+线条引导
    const compositionField = getField('composition');
    if (compositionField) parts.push(`【构图】${compositionField}`);

    // 【色彩/色调】⭐ 新增:调色方案+色温倾向+饱和度
    const colorPalette = getField('color_palette', 'colorPalette');
    if (colorPalette) parts.push(`【色彩/色调】${colorPalette}`);

    // 【景深】⭐ 新增:焦点控制+虚化程度+前景/背景层次
    const depthOfField = getField('depth_of_field', 'depthOfField');
    if (depthOfField) parts.push(`【景深】${depthOfField}`);

    // 【运镜】⭐ 新增:镜头运动方式(从【动作】拆分)
    const cameraMovement = getField('camera_movement', 'cameraMovement');
    if (cameraMovement) parts.push(`【运镜】${cameraMovement}`);

    // 【角色】
    // 【v2.1.4-fix9-P4】角色服装锁定:强制使用原始角色设定中的服装
    let characterDesc = fields.character || '';
    if (characterDesc && shot.character) {
      // 如果LLM输出的角色描述中没有"警"字,但原始角色设定有,则强制替换
      const originalChar = shot.character || '';
      if (originalChar.includes('警') && !characterDesc.includes('警')) {
        // LLM擅自改了服装,从原始角色描述中提取姓名+服装
        const nameMatch = originalChar.match(/([^,,]+警[^,,]+)/);
        if (nameMatch) {
          characterDesc = characterDesc.replace(/(身着|穿着|身穿|着)[^,]+/, nameMatch[1]);
          // 如果没替换成功,直接在描述开头插入正确服装
          if (!characterDesc.includes('警')) {
            characterDesc = originalChar + ',' + characterDesc;
          }
        }
      }
    }
    if (characterDesc) parts.push(`【角色】${characterDesc}`);

    // 【服装】⭐ 新增:详细服装描述(从【角色】拆分)
    const costumeField = getField('costume');
    if (costumeField) parts.push(`【服装】${costumeField}`);

    // 【化妆】⭐ 新增:妆容、发型细节
    const makeupField = getField('makeup');
    if (makeupField) parts.push(`【化妆】${makeupField}`);

    // 【动作】
    // 【v2.1.11-重构】写实校验强度分级：按 visual_register 决定禁用词范围
    let actionDesc = getField('action') || shot.action || '';
    const actionHasForbidden = forbiddenWords.action.some(w => actionDesc.includes(w));
    if (actionHasForbidden) {
      console.warn(`[PromptFusionAgent] ⚠️ 镜头 ${shot.shotId} 动作含禁止词汇(校验强度=${visualRegister}): "${actionDesc.substring(0, 50)}...",强制替换为写实动作`);
      // 提取角色名
      const charName = shot.character?.name || shot.character || '人物';
      // 【v2.1.11-P1 修复】兜底动作用真实角色名插值，"示例角色"占位符不得进入生产 prompt
      const idx = parseInt(shot.shotId.replace(/\D/g, '')) || 0;
      actionDesc = renderFallbackAction(charName, idx);
    }
    if (actionDesc) parts.push(`【动作】${actionDesc}`);

    // 【道具】⭐ 新增:关键道具(手持物、桌面物品、背景物件)
    const propsField = getField('props');
    if (propsField) parts.push(`【道具】${propsField}`);

    // 【定妆照】
    const portraitsField = getField('portraits');
    if (portraitsField) parts.push(`【定妆照】${portraitsField}`);

    // 【商品锚点】【商品一致性】⭐ v2.6.0 社媒营销包 P1-4：商品英雄照实拍绑定
    const _socialProfile = resolveProfile(shot, shot.blueprint || {});
    if (isSocialCommerce(_socialProfile) && shot.sceneType !== 'opening') {
      const brief = shot.marketingBrief || {};
      const heroAnchorField = getField('product_anchor', 'productAnchor', 'productHeroAnchor');
      if (heroAnchorField) {
        parts.push(`【商品锚点】${heroAnchorField}`);
      } else {
        const anchor = this._productHeroDesigner.designAnchor(shot, brief);
        if (anchor.fieldText) parts.push(`【商品锚点】${anchor.fieldText}`);
      }
      const heroConsistencyField = getField('product_consistency', 'productConsistency');
      if (heroConsistencyField) {
        parts.push(`【商品一致性】${heroConsistencyField}`);
      } else {
        parts.push(`【商品一致性】${this._productHeroDesigner.designConsistency(brief)}`);
      }
    }

    // 台词
    // 【v2.1.6】优先使用 dialogueBlocks 渲染为 Seedance 2.0 内联格式
    if (shot.dialogueBlocks && Array.isArray(shot.dialogueBlocks) && shot.dialogueBlocks.length > 0) {
      const renderedDialogue = this._renderDialogueBlocks(shot.dialogueBlocks, shot.duration || 10);
      if (renderedDialogue) {
        parts.push(renderedDialogue);
      }
    } else {
      // 回退:使用旧的 dialogue 字段
      let dialogueField = getField('dialogue');
      // 【v2.2.7-fix】台词丢失根因修复：归一化链路把台词写在 shot.dialogue
      // （SPEAKER|TYPE|EMOTION|TEXT|LIP_SYNC:YES 格式，' || ' 连接）与
      // shot.dialogueText 顶层，而非 fields.dialogue——旧回退只读 fields，
      // LLM 未把台词放进 fields 时，台词字段在最终 Prompt 中整体丢失且全程无告警。
      if (!dialogueField) dialogueField = shot.dialogue || shot.dialogueText || '';
      if (dialogueField) {
        // 【v2.2.7-fix】统一格式串（含竖杠，直接进渲染会乱码）→ 转 blocks 渲染为内联格式
        if (typeof dialogueField === 'string' && dialogueField.includes('|')) {
          const blocks = this._parseUnifiedDialogueString(dialogueField);
          if (blocks.length > 0) {
            const rendered = this._renderDialogueBlocks(blocks, shot.duration || 10);
            if (rendered) { parts.push(rendered); dialogueField = null; }
          }
          if (dialogueField) {
            // 解析失败则提取纯台词文本，绝不把含竖杠的统一格式串透传到渲染层
            dialogueField = this._extractPureDialogue(dialogueField);
          }
        }
        if (dialogueField) {
          // 【v2.1.4-fix13】确保台词有【台词】前缀
          const dialogueText = String(dialogueField).startsWith('【台词】') ? String(dialogueField) : `【台词】${dialogueField}`;
          parts.push(dialogueText);
        }
      }
    }

    // 【时间轴】镜头内部微观导演调度
    const timelineField = getField('timeline');
    if (timelineField) {
      // ⭐ v2.1.7: 支持结构化时间轴对象
      if (typeof timelineField === 'object' && timelineField.beats) {
        const rendered = this._renderStructuredTimeline(timelineField);
        parts.push(`【时间轴】${rendered}`);
      } else {
        parts.push(`【时间轴】${timelineField}`);
      }
    } else {
      // ⭐ v2.1.7: 按镜头时长动态生成时间轴节拍
      const duration = shot.duration || 10;
      const beats = this._generateTimelineBeats(duration);
      parts.push(`【时间轴】${beats}`);
    }

    // 【情绪】
    const moodField = getField('mood');
    if (moodField) parts.push(`【情绪】${moodField}`);

    // 【节奏】⭐ 新增:镜头速度+紧迫感+舒缓度
    const pacingField = getField('pacing');
    if (pacingField) parts.push(`【节奏】${pacingField}`);

    // 【转场】⭐ 新增:与下一镜头的衔接方式
    const transitionField = getField('transition');
    if (transitionField) parts.push(`【转场】${transitionField}`);

    // 【音频】
    const audioField = getField('audio');
    if (audioField) parts.push(`【音频】${audioField}`);

    // 【配乐】⭐ v2.6.0 社媒营销包 P1-6：BGM 策略（卡点映射/人声配比/高潮对齐/版权红线）
    if (isSocialCommerce(_socialProfile) && shot.sceneType !== 'opening') {
      const bgmField = getField('bgm', 'music', 'soundtrack');
      if (bgmField) {
        parts.push(`【配乐】${bgmField}`);
      } else {
        const bgm = this._bgmStrategyDesigner.design(shot, _socialProfile, shot.marketingBrief || {});
        if (bgm.fieldText) parts.push(`【配乐】${bgm.fieldText}`);
      }
    }

    // 【画面文字设计】⭐ v2.5.0 社媒营销包：营销镜头强制三层文字（字幕条/卖点花字/CTA）
    const _platformProfile = resolveProfile(shot, shot.blueprint || {});
    if (isSocialCommerce(_platformProfile) && shot.sceneType !== 'opening') {
      const textDesignField = getField('onscreen_text', 'textDesign', 'onscreenTextDesign', 'onscreenText');
      if (textDesignField) {
        parts.push(`【画面文字设计】${textDesignField}`);
      } else {
        const designed = this._onscreenTextDesigner.design(shot, _platformProfile, shot.marketingBrief || {});
        if (designed.fieldText) parts.push(`【画面文字设计】${designed.fieldText}`);
      }
    }

    // 【负面约束】⭐ v2.1.7: 从style动态选择负面约束
    const negativeField = getField('negative');
    if (negativeField) {
      parts.push(`【负面约束】${negativeField}`);
    } else if (isSocialCommerce(_platformProfile)) {
      // 【v2.5.0 社媒营销包】放行设计化画面文字，仅禁水印/乱码/平台UI文字/低质
      parts.push(`【负面约束】no watermark, no platform UI, no garbled text, no distorted typography, no blurry, no low resolution, no pixelated, no distorted, no artifacts, no compression noise, no extra limbs, no deformed hands, no malformed fingers, no extra fingers, no fused fingers; 禁止系统水印，禁止乱码与扭曲文字，禁止平台界面元素入画`);
    } else {
      const style = shot.blueprint?.style || shot.blueprint?.config?.style || 'cinematic';
      const baseNegative = 'no text, no watermark, no caption, no subtitle, no logo, no blurry, no low resolution, no pixelated, no distorted, no artifacts, no compression noise, no extra limbs, no deformed hands, no malformed fingers, no extra fingers, no fused fingers';
      const styleNegative = style === 'cinematic'
        ? 'no cartoon style, no flat lighting, no text anywhere in frame, no readable characters, no alphabets, no Chinese characters, no text on walls, no text on objects, no text on documents, no text on signs, no text on labels, no text on screens, no text on clothing, no text in background, no brand logos with text, no text on posters, no text on billboards, no text on packaging, no handwritten text, no printed text, no signage text, no text overlays, no UI elements with text'
        : style === 'animation'
        ? 'no photorealistic, no live-action, no realistic textures, no film grain'
        : 'no cartoon style, no flat lighting, no text anywhere in frame';
      parts.push(`【负面约束】${baseNegative}; ${styleNegative}`);
    }

    // 【角色约束】⭐ 新增:防止多角色/分身
    const characterConstraint = getField('character_constraint', 'characterConstraint');
    if (characterConstraint) {
      parts.push(`【角色约束】${characterConstraint}`);
    } else if (shot.character && shot.character !== 'NONE') {
      // 兜底:根据角色名自动生成
      const charName = shot.character.name || shot.character;
      parts.push(`【角色约束】只出现${charName}一人,禁止其他人物入镜,禁止同一角色重复出现,禁止角色分身或克隆`);
    }

    // 【角色一致性】
    const consistencyField = getField('consistency');
    if (consistencyField) parts.push(`【角色一致性】${consistencyField}`);

    // 【P1-PROMPT-05 修复】统一字段分隔符：使用' | '替代'，'，避免中英文标点混用
    let fullPrompt = parts.join(' | ');

    // 【v2.2-refine】先做内容精炼: 剥英文前缀/去同义堆叠/分句去重/矛盾仲裁/碎片清理/句级闭合
    fullPrompt = this._contentRefiner.refinePrompt(fullPrompt, shot);

    // 【v2.2-refine】fields 回写: 保证 shot.prompt 与 shot.fields 内容一致
    if (shot.fields && typeof shot.fields === 'object') {
      Object.assign(shot.fields, this._contentRefiner.refineFields(shot.fields, shot));
    }

    // 截断(精炼后仍超长的极端情况)
    if (this._countChars(fullPrompt) > this.maxPromptLength) {
      fullPrompt = this._truncateStandardPrompt(fullPrompt);
      // 截断可能产生新的断句, 再过一次精炼器的闭合修复
      fullPrompt = this._contentRefiner.refinePrompt(fullPrompt, shot);
    }

    // 【v2.2.5-审计新增】精炼后下限校验（两阶段口径的②阶段闭环）
    // 组装阶段目标 2470-3000 在生成侧保证；此处守住精炼后交付口径的地板，
    // 低于 REFINED_MIN 说明有效细节被过度压缩，记警告但不改写内容（精炼器权威）。
    if (this._countChars(fullPrompt) < this.refinedMinLength) {
      console.warn(`[PromptFusionAgent] ⚠️ 镜头 ${shot.shotId} 精炼后仅 ${this._countChars(fullPrompt)} 字符，低于精炼后下限 ${this.refinedMinLength}，请检查上游字段是否过薄`);
    }

    // 【v2.2.0】语言检查:检测英文输出并警告
    // 【P2-PROMPT-03 修复】语言检查不再只做警告，主动修正英文输出
    const chineseCharCount = (fullPrompt.match(/[\u4e00-\u9fa5]/g) || []).length;
    const totalCharCount = this._countChars(fullPrompt);
    const chineseRatio = chineseCharCount / totalCharCount;
    if (chineseRatio < 0.3 && totalCharCount > 500) {
      console.warn(`[PromptFusionAgent] ⚠️ 镜头 ${shot.shotId} 中文占比过低(${(chineseRatio * 100).toFixed(1)}%), 尝试修正为中文输出`);
      // 【P2-PROMPT-03 修复】添加中文标记强制中文输出
      fullPrompt = '【强制中文输出】' + fullPrompt;
    }

    // 【v2.2.0】片头专属字段(30字段体系): 片头镜头追加5个独立标签
    const isOpening = shot.sceneType === 'opening' || shot.shotId === 'SC00' || shot.shotId === 'S00';
    if (isOpening) {
      const openingFields = [
        { key: 'title_content', label: '主标题内容' },
        { key: 'subtitle_content', label: '副标题内容' },
        { key: 'title_animation', label: '标题动画设计' },
        { key: 'title_font_design', label: '标题字体设计' },
        { key: 'opening_audio_design', label: '开场音频设计' }
      ];
      for (const of of openingFields) {
        let value = getField(of.key) || shot[of.key] || fields?.[of.key];
        // 【v2.2.1-fix】title_animation 在优化器运行前可能为空，从片头设计的 beats 节拍表兜底生成
        if ((!value || !String(value).trim()) && of.key === 'title_animation') {
          const beats = shot.opening?.beats || shot._openingDesign?.beats || shot.blueprint?.opening?.beats;
          if (Array.isArray(beats) && beats.length > 0) {
            value = beats.map(b => `${b.tStart || b.t_start || 0}-${b.tEnd || b.t_end || 0}s ${b.phase || ''}: ${b.visual || b.camera || ''}`).join('；');
          }
        }
        if (value && String(value).trim()) {
          fullPrompt += ` | 【${of.label}】${value}`;
        }
      }
    }

    // 【v2.3.1-排版】交付前统一转换为"序号+独立行"格式（替代 ' | ' 单行连接）
    fullPrompt = this._formatNumberedFields(fullPrompt);

    return fullPrompt;
  }

  /**
   * 组装完整Prompt(降级路径,保留原有逻辑)
   */
  _assembleFullPrompt(shot, fusionText, ratio) {
    const parts = [];

    // L1: 约束层
    // 【v2.1.4-fix9-P25】约束字段:画幅+分辨率+格式+帧率+禁止项
    parts.push(`Aspect ratio: ${ratio}, Resolution: 1920x1080, Format: MP4, Frame rate: 24fps, no text, no subtitle, no caption, no watermark, no text anywhere in frame, no readable characters, no alphabets, no Chinese characters, no text on walls, no text on objects, no text on documents, no text on signs, no text on labels, no text on screens, no text on clothing, no text in background`);

    // L2: 基础层
    // 【v2.1.4-fix9-P25】基础字段:分辨率锚定+风格质量+细节增强
    parts.push('8K resolution, cinematic quality, highly detailed, photorealistic, intricate textures, sharp focus');

    // L3-L7: 融合段
    if (fusionText) {
      parts.push(fusionText);
    } else {
      // 【v2.1.11-重构】降级路径按 visual_register 分级校验
      let sceneDesc = shot.scene || '';
      const forbiddenWords = getRealismForbidden(visualRegister);
      if (forbiddenWords.scene.some(w => sceneDesc.includes(w))) {
        // 【修复 P0-1】领域中立兜底场景：从唯一真源读取
        const fallbackScenes = FALLBACK_SCENES;
        const idx = parseInt(shot.shotId?.replace(/\D/g, '') || '0') || 0;
        sceneDesc = fallbackScenes[idx % fallbackScenes.length];
      }
      parts.push(sceneDesc);

      if (shot.character && shot.character !== 'NONE') parts.push(shot.character);

      let actionDesc = shot.action || '';
      if (forbiddenWords.action.some(w => actionDesc.includes(w))) {
        // 【v2.1.11-P1 修复】兜底动作用真实角色名插值
        const charName = (typeof shot.character === 'string' && shot.character !== 'NONE') ? shot.character : '人物';
        const idx = parseInt(shot.shotId?.replace(/\D/g, '') || '0') || 0;
        actionDesc = renderFallbackAction(charName, idx);
      }
      if (actionDesc) parts.push(actionDesc);

      const pureDialogue = shot.dialogueText || this._extractPureDialogue(shot.dialogue);
      if (pureDialogue && pureDialogue !== '') parts.push(`"${pureDialogue}"`);
      if (shot.cameraString) parts.push(shot.cameraString);
      if (shot.lightingString) parts.push(shot.lightingString);
      if (shot.mood) parts.push(`mood: ${shot.mood}`);
      if (shot.backgroundSoundString) parts.push(`audio: ${shot.backgroundSoundString}`);
    }

    // L9: 质控层
    // 【v2.1.4-fix9-P14】全局禁止文字:详细负面约束覆盖所有可能含文字的位置
    parts.push('no voiceover, no narration, no metal_gloss, no unnatural_eye_color, no text anywhere in frame, no readable characters, no alphabets, no Chinese characters');
    parts.push('no text on walls, no text on objects, no text on documents, no text on signs, no text on labels, no text on screens, no text on clothing, no text in background');
    parts.push('no brand logos with text, no text in medical charts, no text on posters, no text on billboards, no text on packaging, no handwritten text, no printed text, no signage text');
    parts.push('no text overlays, no UI elements with text, no text on book covers, no text on medicine bottles, no text on report forms, no text on devices, no text on badges, no text on nameplates');
    parts.push('no text on doors, no text on windows, no text on floors, no text on ceilings');

    let fullPrompt = parts.filter(p => p).join(', ');
    if (this._countChars(fullPrompt) > this.maxPromptLength) {
      fullPrompt = this._truncateWithPriority(fullPrompt, parts);
    }

    return fullPrompt;
  }

  /**
   * 【v2.2-refine 重写】按字段压缩而非整段砍除: 保留全部25个【字段】标签
   * 与原实现差异:
   * 1) 语言约束/台词 设为不可截断段(原实现把语言约束砍成"禁止。"残句、台词砍成半行)
   * 2) 段内截断从"每次砍10字符"改为"句级安全截断"(在闭合标点处收束+括号配平)
   * 3) 重组时保留 ' | ' 分隔符(原实现 join('') 丢分隔符, 导致段间粘连)
   */
  _truncateStandardPrompt(fullPrompt) {
    if (this._countChars(fullPrompt) <= this.maxPromptLength) return fullPrompt;

    const segments = fullPrompt.split(/(?=【)/).filter(s => s.trim());
    if (segments.length <= 1) return fullPrompt.substring(0, this.maxPromptLength);

    const NO_TRUNCATE = new Set(['【语言约束】', '【台词】', '【强制中文输出】']);

    const FIELD_WEIGHTS = {
      '【语言约束】': 99, '【台词】': 99,
      '【导演意图】': 1.5, '【场景】': 1.4, '【角色】': 1.4, '【动作】': 1.3,
      '【灯光设计】': 1.3, '【灯光/照明】': 1.3, '【运镜】': 1.2,
      '【色彩/色调】': 1.1, '【景深】': 1.1, '【时间轴】': 1.1,
      '【服装】': 1.0, '【化妆】': 1.0, '【道具】': 1.0, '【情绪】': 1.0,
      '【定妆照】': 0.9, '【构图】': 0.9,
      '【节奏】': 0.8, '【转场】': 0.7, '【音频】': 0.6,
      '【负面约束】': 0.5, '【角色约束】': 0.5, '【角色一致性】': 0.5, '【明亮约束】': 0.5
    };

    const target = this.maxPromptLength;

    const protectedSegs = segments.filter(seg => {
      const m = seg.match(/^(【[^】]+】)/);
      return m && NO_TRUNCATE.has(m[1]);
    });
    const compressibleSegs = segments.filter(seg => {
      const m = seg.match(/^(【[^】]+】)/);
      return !m || !NO_TRUNCATE.has(m[1]);
    });
    const protectedLen = protectedSegs.reduce((sum, s) => sum + this._countChars(s) + 3, 0);
    const compressTarget = Math.max(200, target - protectedLen);

    let totalWeighted = 0;
    const segInfos = compressibleSegs.map(seg => {
      const segLen = this._countChars(seg);
      const headMatch = seg.match(/^(【[^】]+】)/);
      const head = headMatch ? headMatch[1] : '';
      const weight = FIELD_WEIGHTS[head] || 1.0;
      totalWeighted += segLen * weight;
      return { seg, segLen, head, weight };
    });

    const compressed = segInfos.map(({ seg, segLen, head, weight }) => {
      const weightedRatio = (compressTarget / totalWeighted) * weight;
      const want = Math.max(40, Math.floor(segLen * weightedRatio));
      if (segLen <= want) return seg;
      const body = seg.slice(head.length);
      return head + this._safeTruncateSentence(body, want);
    });

    return [...protectedSegs, ...compressed].map(s => s.trim()).filter(Boolean).join(' | ');
  }

  /**
   * 【v2.2-refine 新增】句级安全截断: 在闭合标点处收束, 括号/引号配平
   * 替代原 kept.substring(0, kept.length - 10) 的暴力砍尾
   */
  _safeTruncateSentence(text, maxChars) {
    if (!text || text.length <= maxChars) return text || '';
    let cut = text.substring(0, maxChars);
    const closers = ['。', '；', ';'];
    let lastClose = -1;
    for (const c of closers) {
      const idx = cut.lastIndexOf(c);
      if (idx > lastClose) lastClose = idx;
    }
    if (lastClose > maxChars * 0.5) {
      cut = cut.substring(0, lastClose + 1);
    }
    for (const [open, close] of [['（', '）'], ['“', '”'], ['「', '」'], ['[', ']']]) {
      const openCount = (cut.match(new RegExp('\\' + open, 'g')) || []).length;
      const closeCount = (cut.match(new RegExp('\\' + close, 'g')) || []).length;
      if (openCount > closeCount) {
        const lastOpen = cut.lastIndexOf(open);
        if (lastOpen > 0) cut = cut.substring(0, lastOpen);
      }
    }
    cut = cut.replace(/[、，,]\s*$/, '');
    return cut;
  }

  _truncateWithPriority(fullPrompt, parts) {
    // 复用相同的按字段压缩逻辑
    return this._truncateStandardPrompt(fullPrompt);
  }

  // 【P2-PERF-02 修复】批量truncate：一次处理多个prompt，减少重复计算
  _truncateBatch(prompts) {
    return prompts.map(p => {
      if (typeof p === 'string') {
        return this._truncateStandardPrompt(p);
      }
      if (p && p.prompt) {
        p.prompt = this._truncateStandardPrompt(p.prompt);
        p.promptCharCount = this._countChars(p.prompt);
      }
      return p;
    });
  }

  _countChars(str) {
    // 【P2-13 修复】使用真实字符数,中文不再按1.5计
    return str ? String(str).length : 0;
  }

  // 【P2-PROMPT-02 修复】简单哈希函数：根据字符串生成确定性哈希值
  _simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash);
  }

  _extractPureDialogue(dialogue) {
    if (!dialogue || typeof dialogue !== 'string') return dialogue;
    const parts = dialogue.split(/[|;]/);
    if (parts.length >= 5) {
      return parts[3].trim();
    }
    return dialogue.trim();
  }

  /**
   * 【v2.2.7-fix】解析 v6.37 统一对话格式串为 DIALOGUE_BLOCK 数组
   * 输入: "SPEAKER|TYPE|EMOTION|TEXT|LIP_SYNC:YES || SPEAKER2|TYPE2|EMOTION2|TEXT2|LIP_SYNC:YES"
   * 输出: [{ speaker, emotion, line, trigger }]（trigger 缺省由渲染函数兜底）
   * 解析不出任何一段时返回空数组，调用方回退到纯文本提取。
   */
  _parseUnifiedDialogueString(dialogueStr) {
    if (!dialogueStr || typeof dialogueStr !== 'string') return [];
    const blocks = [];
    for (const seg of dialogueStr.split(' || ')) {
      const parts = seg.split('|').map(s => s.trim());
      // 标准五段式: SPEAKER|TYPE|EMOTION|TEXT|LIP_SYNC:YES
      if (parts.length >= 4 && parts[3]) {
        blocks.push({ speaker: parts[0] || '角色', emotion: parts[2] || 'neutral', line: parts[3] });
      }
    }
    return blocks;
  }

  /**
   * 【v2.1.6】将 DIALOGUE_BLOCK 数组渲染为 Seedance 2.0 内联对话格式
   * 格式:【台词】[时间戳] 角色 trigger, emotion 说:"line"
   */
  _renderDialogueBlocks(blocks, duration) {
    if (!blocks || blocks.length === 0) return '';

    const lines = [];
    const segmentDuration = duration / blocks.length;

    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      const startTime = Math.round(i * segmentDuration);
      const endTime = Math.round((i + 1) * segmentDuration);
      const timeStr = `[${String(startTime).padStart(2, '0')}s-${String(endTime).padStart(2, '0')}s]`;

      // 构建内联格式
      // 【v2.3.1-fix】默认值中文化：英文默认值与【语言约束】同文冲突，
      // 上游缺 trigger/emotion 时英文会直接进入最终 Prompt 且整体占比告警拦不住局部注入
      const trigger = b.trigger || '看向对方';
      const emotion = b.emotion || '平静';
      const line = b.line || '';
      const speaker = b.speaker || '角色';

      // Seedance 2.0 格式:时间戳 + 动作触发 + 情绪副词 + 说:"台词"
      lines.push(`${timeStr} ${speaker} ${trigger}, ${emotion} 说:"${line}"`);
    }

    return '【台词】' + lines.join('\n');
  }

  _buildBatchPrompt(shots, ratio, characters, blueprint) {
    const characterInfo = characters.map(c => `- ${c.name}: ${c.description || ''}`).join('\n');

    const shotsInfo = shots.map(s => {
      const pureDialogue = s.dialogue?.lines?.map(l => l.content).join('; ') ||
                          (s.dialogue ? this._extractPureDialogue(s.dialogue) : '');
      let info = `${s.shotId}(${s.duration || '?'}s): ${s.scene || ''} | ${s.mood || ''} | ${pureDialogue} | 运镜:${s.cameraString || ''} | 灯光:${s.lightingString || ''}`;
      // 【架构-L3】技能上下文注入本镜头指令区（LLM 生成 25 字段时原生吸收）【fix-3A2】
      if (s._skillContext) {
        info += `\n## 🎬 好莱坞技能增强（必须融入 25 字段，不是附加说明）\n${s._skillContext}\n要求：【导演意图】【运镜】【灯光设计】【情绪】字段必须体现上述技法的具体手法；技能禁止词并入【负面约束】字段。`;
      }
      return info;
    }).join('\n');

    // 【v2.1.4-fix9-P1】构建导演上下文
    const directorContext = this._buildDirectorContext(shots, blueprint);

    const sufficiency = [
      '【字段最低字符数 - 硬性要求,不达标会被打回重写】',
      ' scene ≥ 100 | lighting ≥ 100 | composition ≥ 80 | action ≥ 100',
      ' camera_movement ≥ 60 | timeline ≥ 100 | director_instruction ≥ 60',
      ' color_palette ≥ 60 | depth_of_field ≥ 60 | audio ≥ 60',
      ' 其余字段 ≥ 30 字符',
      ' 全部 25 个字段必须全部输出,禁止省略任何一个。',
      '',
      '【精炼要求 - 与字符数同等重要,违反同样打回】',
      ' 1. 每个字段只写中文正文,禁止"英文标签;中文正文"双段式(错误示范: hard directional lighting; 主光为…)',  // 允许摄影师部分但声明不嵌套代码块
      ' 2. 同一信息只写一次: 明亮约束不得复述灯光内容,节奏不得复述时间轴的逐秒分布,道具不得重复场景已提及的陈设',
      ' 3. 运镜只写一种方式且与景别匹配,禁止同时出现"固定机位"和"手持晃动/推轨"',
      ' 4. 景深只写一个光圈值',
      ' 5. 空镜(无角色)时: 服装/化妆/定妆照写"无角色出场,不适用",禁止编写服装模板,角色字段不得出现角色名锚定',
      ' 6. 负面约束8-12条: 必须含 no text 和 no watermark,"禁止文字"类同义条不超过3条,其余按本镜头内容定制(如年代不符物/现代设备/特效感/多余肢体)',
      ' 7. 技术规格统一写法: constraint 固定为"16:9画幅，4K分辨率，24fps，MP4格式"(竖屏项目为9:16),禁止出现编码/采样率/色域等下游参数',
      '',
      '【字段内容规范 - 必须包含的子要素】',
      ' director_instruction: 风格定位(电影/纪录片/广告风格) + 写实要求(真实感/无特效) + 情绪基调(冷静/紧张/温馨等)',
      ' constraint: 按第7条统一写法',
      ' lighting: 主光描述(位置/方向) + 色温参数(5600K/3200K等) + 光质定义(柔光/硬光/漫射)',
      ' camera_movement: 运动方式(推/拉/摇/移/跟/固定) + 速度参数 + 起幅落幅',
      ' negative: 按第6条',
      ' composition: 景别等级(远景/全景/中景/近景/特写) + 主体位置(三分法/中心/对称)',
      ' bright_constraint: 一句定性要求(如"主体面部明亮,阴影不死黑"),不超过40字符,不复述灯光细节',
      ' 每个字段内容必须体现上述子要素,缺失会被标记为不合格。'
    ].join('\n');

    // 【2026-07-17 camera-coherence】注入邻镜协调上下文（上一镜/下一镜的景别+运镜+转场）
    let neighborContext = '';
    try {
      if (this._cameraPlans && typeof this._currentShotIdx === 'number') {
        const { buildNeighborContext } = require('../../../../systems/camera-coherence');
        neighborContext = '\n' + buildNeighborContext(this._cameraPlans, this._currentShotIdx) + '\n';
      }
    } catch (e) { /* 不影响主流程 */ }

    return `${directorContext}
画幅:${ratio}
角色:${characterInfo || '无'}
镜头:\n${shotsInfo}
${neighborContext}
${sufficiency}

任务:为每个镜头生成标准字段格式的导演分镜提示词。

【融合心法——25字段是一支交响乐队，不是25个独奏】
1. 先定本镜的'一句话戏核'（如：绝境处传承显形），然后 25 个字段全部服务这一句——scene/lighting/composition/action/audio 说的是同一件事的不同侧面，任何字段与戏核无关就是噪音。
2. action 是皇冠字段：写'可拍摄的物理动作链'（咬绳→穿引→回绕→收紧→手腕一翻），每一步有先后有受力，禁止'表情坚定'这类演不出来的词。手背老年斑与旧茧这类视觉锚点必须进 action 或 composition 的画面中心。
3. lighting 四要素锁死：真实光源名+色温K值+方向+光比。光是情绪不是照明——高潮镜光比拉大（4:1），喘息镜光比收平（1.5:1）。
4. timeline 是导演的分镜表：≥3段，每段=时间+画面+动作+目的，切分点跟着情绪转折走，总时长与镜头时长严格一致。
5. dialogue 字段只放角色嘴里的台词（原样保留钉子台词），情绪用副词，触发用物理动作；旁白出现即废稿。
6. negative 必须含 10+ 条全局排除项；bright_constraint/character_constraint/consistency 三字段是本镜与前镜的'焊接点'，视觉锚点逐字对齐前镜用词。
7. director_instruction 是本镜的创作宣言：先点美学谱系（是枝裕和式克制/小津式静观），再给本镜唯一的执行准则（'凝视即尊重'/'安静就是设计'），最后给质感要求（胶片颗粒/绳纤维微距）。≤150字，字字可执行。
8. 写完自检：随机抽三个字段，它们是否在讲同一个情绪？不是就重写。

【角色服装锁定 - 强制不可修改】
角色服装必须与角色设定完全一致,禁止根据场景修改:
- 正确:"示例角色女士,穿[角色设定服装]的[角色名],[角色身份],短发,站姿挺拔"
- 错误:"与角色档案不一致的服装"(禁止根据场景更换服装,服装必须以角色档案为准)
【角色】字段必须严格使用角色设定中的原始服装描述,不可自由发挥。

【动作写实锁定 - 强制不可修改】
【动作】字段必须是真实物理动作和镜头运动,严禁使用任何科幻/抽象/超现实词汇:
- 正确:"镜头缓慢推近,示例角色站立讲台前,自然手势讲解"
- 错误:"全息投影"、"空间扭曲"、"时间残影"、"霓虹色数据流"、"抽象构图"、"梦境流动性"、"湿版摄影"、"光即角色"
- 正确运镜:推近、跟拍、手持、稳定器、缓慢后拉、固定机位
- 错误运镜:无人机穿越微观世界、时间操控慢动作、宏大比例展示

要求:
1. 【语言约束 - 强制】所有字段内容必须使用中文输出,禁止出现英文(技术参数如8K/MP4/24fps/5600K等除外)。mood字段可用英文单词(如tense/epic)。
2. 按标准字段输出:【约束】【基础】【场景】【灯光/照明】【构图】【色彩/色调】【景深】【运镜】【角色】【服装】【化妆】【动作】【道具】【定妆照】【台词】【时间轴】【情绪】【节奏】【转场】【音频】【负面约束】【明亮约束】【角色约束】【导演指令】【角色一致性】
3. 【台词】字段必须独立,角色直接对镜头说话,不要写"画外音""旁白"
3. 场景要具体专业(门诊室、宣教室、检查室),不要写"社区健身区"。场景中不得出现含文字的物品:如"有文字的报告单"、"标牌上的文字"、"商标"、"有字的海报"等。可以描述"空白报告单"、"无文字标识牌"、"图形海报"等不含文字的物品
4. 负面约束要完整,包含10+条排除项,必须包含全局禁止文字:no text anywhere in frame, no readable characters, no alphabets, no Chinese characters, no text on walls objects documents signs labels screens clothing packaging, no handwritten text, no printed text, no signage text, no text overlays, no UI elements with text
5. 只输出JSON,不要解释

输出:{"shots":[{"shotId":"SC01","fields":{...}}]}`;
  }

  /**
   * 【v2.1.4-fix9-P1】构建导演上下文
   * 【方案A-fix】增加原始故事文本直通
   */
  _buildDirectorContext(shots, blueprint) {
    // 从第一个 shot 的 blueprint 引用中提取上下文
    const firstShot = shots[0];
    const bp = blueprint || firstShot?._blueprint || {};
    const config = bp.config || {};
    const meta = bp.metadata || bp.meta || {};
    const _metadata = config._metadata || bp._metadata || {};

    const title = bp.title || config.title || _metadata.title || '未命名';
    const contentTheme = config.content_theme || _metadata.content_theme || '';
    const sceneRequirement = config.scene_requirement || _metadata.scene_requirement || '';
    const characterDescription = config.character_description || _metadata.character_description || '';
    const forbiddenScenes = config.forbidden_scenes || _metadata.forbidden_scenes || [];
    const keyMessages = config.key_messages || _metadata.key_messages || [];
    
    // 【方案A-fix】原始故事文本直通
    const originalStory = bp._originalStoryText || _metadata._originalStoryText || meta._originalStoryText || '';
    const storySection = originalStory ? `
## 📖 原始故事文本（PromptFusion核心依据，必须忠实还原每个细节）
${originalStory}
` : '';

    return `## 🎬 导演指令上下文
视频标题:${title}
内容主题:${contentTheme}
场景要求:${sceneRequirement}
角色设定:${characterDescription}
关键信息:${keyMessages.join(';') || '无'}
禁止场景:${forbiddenScenes.join('、') || '无'}
${storySection}
`;
  }

  _fallbackBatch(shots, ratio) {
    console.log(`[PromptFusionAgent] 批量降级...`);
    return {
      shots: shots.map(shot => ({
        shotId: shot.shotId,
        fields: {}
      }))
    };
  }

  /**
   * 【审计修复】多名字段解析:支持多种命名风格读取同一字段
   * 解决 Phase 2 输出的 camera/cameraMovement/cameraString 等字段
   * PromptFusion 只认 camera_movement 的问题
   */
  _resolveField(shot, ...names) {
    for (const name of names) {
      if (shot[name] !== undefined && shot[name] !== null && shot[name] !== '') {
        return shot[name];
      }
    }
    return undefined;
  }
}

module.exports = { PromptFusionAgent };