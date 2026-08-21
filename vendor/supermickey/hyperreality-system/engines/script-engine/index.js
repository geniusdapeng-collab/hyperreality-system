// engines/script-engine/index.js
// Script Engine - 剧本引擎入口
// 版本：v1.0 | 日期：2026-06-07

const { IntentParser } = require('./core/intent-parser');
const { ScriptBlueprint } = require('./core/script-blueprint');
const { ScriptGenerator } = require('./core/script-generator');
const { ScriptValidator } = require('./core/script-validator');
const { ScriptBlueprintAdapter } = require('./core/adapter');
const { CreativeIntensityEngine } = require('./core/creative-intensity-engine');
const { 示例世界Extension: NirathExtension } = require('./extensions/nirath-extension');

class ScriptEngine {
  constructor(options = {}) {
    this.intentParser = new IntentParser(options.intentParser);
    this.scriptGenerator = new ScriptGenerator({
      ...options.scriptGenerator,
      model: options.scriptGenerator?.model || process.env.STORMAXE_LLM_MODEL || 'kimi-k2p6'
    });
    this.scriptValidator = new ScriptValidator(options.scriptValidator);
    this.adapter = new ScriptBlueprintAdapter(options.adapter);
    this.nirathExtension = new NirathExtension();
    
    this.version = '1.0.0';
  }

  /**
   * 主入口：从用户意图到适配后的剧本
   * @param {string} rawInput - 用户原始输入
   * @param {object} metadata - 附加元数据
   * @returns {object} { blueprint, adapted, validation, report }
   */
  async process(rawInput, metadata = {}) {
    console.log(`[ScriptEngine v${this.version}] 开始处理: ${metadata.title || '未命名'}`);

    // 1. 解析意图
    // 【v2.1.8-fix】如果 metadata 包含 CreativeTheme 信息，优先使用其类型/情绪
    if (metadata._creativeTheme && metadata._creativeTheme.type) {
      metadata.narrativeMode = metadata._creativeTheme.type.toLowerCase().replace(/[^a-z]/g, '');
      metadata._creativeThemeTone = metadata._creativeTheme.tone;
      metadata._creativeThemeVisualStyle = metadata._creativeTheme.visual_style;
      metadata._creativeThemeTargetAudience = metadata._creativeTheme.target_audience;
      // 【方案A-fix】原始故事文本从 CreativeTheme 传递到 metadata，供下游消费
      if (metadata._creativeTheme._originalStoryText) {
        metadata._originalStoryText = metadata._creativeTheme._originalStoryText;
        console.log(`[ScriptEngine] 📖 原始故事文本已接入，长度: ${metadata._originalStoryText.length}字符`);
      }
      // 【2026-07-17 清理】_creativeThemeDescription 写后无人读，删除
      console.log(`[ScriptEngine] 使用 CreativeTheme 类型: ${metadata._creativeTheme.type}`);
    }
    const userIntent = this.intentParser.parse(rawInput, metadata);
    console.log(`[ScriptEngine] 意图解析完成: ${userIntent.parsed.primary_mode}`);

    // 【P0-7 修复】接入 CreativeIntensityEngine，创意指数影响"怎么拍"
    // 【2026-07-17 修复】统一唯一真源结构，不再用变形结构覆盖上游结果：
    // 原实现把 metadata._creativeIntensity 覆盖为 { instructions: Layer1返回对象 }，
    // 导致 script-generator 读取 instructions.script/production/rendering 全部为空。
    // 统一唯一真源结构：
    // { intensity, level, engineConfigs, instructions: {script,production,rendering,postProduction} }
    try {
      const ciEngine = new CreativeIntensityEngine();
      let ci = metadata._creativeIntensity;
      const ciValue = (ci && typeof ci.intensity === 'number' ? ci.intensity : null)
        ?? metadata.creativeIntensity
        ?? metadata.creative_intensity
        ?? 0.7;

      if (!ci || typeof ci.intensity !== 'number' || !ci.instructions?.script) {
        // 上游未计算或结构不完整 → 本地重建（与上游完全同构）
        const narrativeMode = userIntent.parsed?.narrative_mode || 'dialogue';
        const worldSetting = metadata.world_setting || metadata._metadata?.world_setting || 'default';
        const engineConfigs = ciEngine.generateEngineConfigs(ciValue, narrativeMode, worldSetting);
        ci = {
          intensity: ciValue,
          level: ciEngine.getLevel(ciValue).key,
          engineConfigs,
          instructions: {
            script: engineConfigs.scriptEngine?.creativeInstructions || '',
            production: engineConfigs.productionEngine?.creativeInstructions || '',
            rendering: engineConfigs.renderingEngine?.creativeInstructions || '',
            postProduction: engineConfigs.postProductionEngine?.creativeInstructions || ''
          }
        };
      }

      userIntent.metadata = userIntent.metadata || {};
      userIntent.metadata._creativeIntensity = ci;
      userIntent.metadata.creativeIntensity = ci.intensity; // camelCase 兜底
      console.log(`[ScriptEngine] CreativeIntensity 接入完成: intensity=${ci.intensity} (${ci.level || 'unknown'})`);
    } catch (e) {
      console.warn('[ScriptEngine] CreativeIntensity 接入失败:', e.message);
    }

    // 2. 生成剧本（需要 LLM）
    let blueprint;
    let degraded = false;
    let degradeReason = '';
    
    // v1.1: 检查LLMEngine是否可用（复用现有引擎）
    const hasLLM = this.scriptGenerator.llmEngine || this.scriptGenerator.config.apiKey;
    
    if (hasLLM) {
      blueprint = await this.scriptGenerator.generate(userIntent);
    } else {
      console.log('[ScriptEngine] 无 LLM 可用，使用模板生成');
      console.log('[ScriptEngine] ⚠️ 降级标记: LLM不可用，回退到模板生成');
      blueprint = this._generateFromTemplate(userIntent);
      degraded = true;
      degradeReason = 'LLM API unavailable, fallback to template generation';
    }

    // 3. 校验剧本
    const validation = this.scriptValidator.validate(blueprint);
    console.log(`[ScriptEngine] 剧本校验: ${validation.passed ? '通过' : '失败'} (${validation.overall_score}分)`);
    
    // 【v2.1.10-fix】保存详细校验报告，便于分析扣分项
    try {
      const fs = require('fs');
      const path = require('path');
      const reportPath = path.join(__dirname, '..', '..', 'output', 'script-validation-report.json');
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      fs.writeFileSync(reportPath, JSON.stringify(validation, null, 2));
      console.log(`[ScriptEngine] 校验报告已保存: ${reportPath}`);
    } catch (e) {
      console.warn(`[ScriptEngine] 保存校验报告失败: ${e.message}`);
    }

    // 4. 适配到现有系统格式
    const adapted = this.adapter.adapt(blueprint);
    const report = this.adapter.generateReport(adapted);

    // 5. 如果校验失败，生成修复计划
    let repairPlan = null;
    if (!validation.passed) {
      repairPlan = this.scriptValidator.generateRepairPlan(validation);
      console.log(`[ScriptEngine] 修复计划: ${repairPlan.repairs.length} 项`);
    }

    console.log(`[ScriptEngine] 处理完成: ${adapted.scenes.length} 场景, ${adapted.characters.length} 角色`);

    return {
      userIntent,
      blueprint,
      validation,
      adapted,
      report,
      repairPlan,
      degraded,
      degradeReason
    };
  }

  /**
   * 从模板生成剧本（无需 LLM）
   */
  /**
   * 从模板生成剧本（无需 LLM）
   * v1.2.7-fix-A9: 通用化降级模板，移除神话项目硬编码
   */
  _generateFromTemplate(userIntent) {
    const meta = userIntent.metadata;
    const { SafeCast } = require('../../utils/safe-cast');
    // 【v2.1.10-fix 时长断层】兜底与 production-profile 唯一真源对齐(60s)，消除 120s 测试残留
    const duration = SafeCast.number(meta.target_duration, 60);
    const sceneCount = 5;
    const sceneDuration = Math.floor(duration / sceneCount);

    // v1.2.7-fix-A9: 从 metadata 获取角色，而非硬编码 example-role
    const characters = meta.characters || [];
    const protagonist = characters[0] || { name: '主讲人', description: '主讲人' };
    const protagonistId = protagonist.id || protagonist.name || 'protagonist';
    const protagonistName = protagonist.name || '主讲人';

    // v1.2.7-fix-A9: 通用场景设定（非神话项目特定）
    const worldSetting = meta.world_setting || 'default';
    const settings = [
      '开场建立氛围，远景展开',
      '主体场景，中景展示',
      '冲突场景，近景聚焦',
      '高潮场景，特写强化',
      '结尾场景，远景收束'
    ];

    const scenes = [];
    const sceneTypes = ['opening', 'establishing', 'conflict', 'emotional_climax', 'resolution'];
    const sceneNames = ['片头', '展开', '冲突', '高潮', '结尾'];

    for (let i = 0; i < sceneCount; i++) {
      const start = i * sceneDuration;
      const end = (i === sceneCount - 1) ? duration : start + sceneDuration;

      scenes.push({
        scene_id: `SC0${i}`,
        scene_name: sceneNames[i],
        scene_type: sceneTypes[i],
        scene_function: i === 0 ? 'establish' : i === 3 ? 'climax' : i === 4 ? 'resolve' : 'advance',
        act_id: i < 2 ? 'ACT-1' : i < 4 ? 'ACT-2' : 'ACT-3',
        timing: { start, duration: end - start, end },
        characters: [protagonistId],
        setting: settings[i],
        dialogue: {
          has_dialogue: true,
          lines: [{
            speaker: protagonistName,
            text: `${meta.title || '本集'}第${i + 1}段内容...`,
            emotion: 'neutral'
          }]
        }
      });
    }

    return new ScriptBlueprint({
      intent_ref: userIntent.intent_id,
      meta: {
        title: meta.title,
        narrative_mode: userIntent.parsed?.primary_mode || 'dramatic',
        target_duration: duration,
        acts_count: 3,
        scenes_count: sceneCount,
        _metadata: meta._metadata || {}
      },
      structure: {
        acts: [
          { act_id: 'ACT-1', act_name: '第一幕', act_function: 'establish', start_time: 0, end_time: Math.floor(duration * 0.4), beats: [] },
          { act_id: 'ACT-2', act_name: '第二幕', act_function: 'confront', start_time: Math.floor(duration * 0.4), end_time: Math.floor(duration * 0.8), beats: [] },
          { act_id: 'ACT-3', act_name: '第三幕', act_function: 'resolve', start_time: Math.floor(duration * 0.8), end_time: duration, beats: [] }
        ],
        scenes
      },
      character_system: {
        characters: [{
          character_id: protagonistId,
          name: protagonistName,
          role: 'protagonist',
          visual_anchor: {
            core_features: protagonist.description ? protagonist.description.split(/[,，、]/) : ['写实人物'],
            reference_images: protagonist.portraitPaths || []
          }
        }]
      },
      world_setting: {
        world_id: worldSetting,
        world_name: worldSetting === 'default' ? '现实世界' : worldSetting,
        era: '现代',
        core_rules: [],
        environment_tags: []
      }
    });
  }

  /**
   * 保存完整工作流结果
   */
  async saveResult(result, outputDir) {
    const fs = require('fs');
    const path = require('path');
    
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    
    // 保存用户意图
    fs.writeFileSync(
      path.join(outputDir, `intent-${timestamp}.json`),
      JSON.stringify(result.userIntent, null, 2)
    );

    // 保存剧本蓝图
    fs.writeFileSync(
      path.join(outputDir, `blueprint-${timestamp}.json`),
      result.blueprint.toJSON()
    );

    // 保存校验报告
    fs.writeFileSync(
      path.join(outputDir, `validation-${timestamp}.json`),
      JSON.stringify(result.validation, null, 2)
    );

    // 保存适配结果
    fs.writeFileSync(
      path.join(outputDir, `adapted-${timestamp}.json`),
      JSON.stringify(result.adapted, null, 2)
    );

    console.log(`[ScriptEngine] 结果已保存到: ${outputDir}`);
    return outputDir;
  }
}

module.exports = {
  ScriptEngine,
  IntentParser,
  ScriptBlueprint,
  ScriptGenerator,
  ScriptValidator,
  ScriptBlueprintAdapter,
  NirathExtension
};