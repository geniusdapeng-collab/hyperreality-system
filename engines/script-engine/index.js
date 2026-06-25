// engines/script-engine/index.js
// Script Engine - 剧本引擎入口
// 版本：v1.0 | 日期：2026-06-07

const { IntentParser } = require('./core/intent-parser');
const { ScriptBlueprint } = require('./core/script-blueprint');
const { ScriptGenerator } = require('./core/script-generator');
const { ScriptValidator } = require('./core/script-validator');
const { ScriptBlueprintAdapter } = require('./core/adapter');
const { NirathExtension } = require('./extensions/nirath-extension');

class ScriptEngine {
  constructor(options = {}) {
    this.intentParser = new IntentParser(options.intentParser);
    this.scriptGenerator = new ScriptGenerator(options.scriptGenerator);
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
    const userIntent = this.intentParser.parse(rawInput, metadata);
    console.log(`[ScriptEngine] 意图解析完成: ${userIntent.parsed.primary_mode}`);

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
    const duration = meta.target_duration || 120;
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
