// engines/script-engine/tests/test-script-engine.js
// 剧本引擎测试脚本 - 验证核心模块
// 运行: node engines/script-engine/tests/test-script-engine.js

const { IntentParser } = require('../core/intent-parser');
const { ScriptBlueprint } = require('../core/script-blueprint');
const { ScriptValidator } = require('../core/script-validator');
const { ScriptBlueprintAdapter } = require('../core/adapter');
const { 示例世界Extension } = require('../extensions/nirath-extension');

console.log('========================================');
console.log('  Script Engine 测试套件 v1.0');
console.log('========================================\n');

// 测试数据
const testIntents = [
  {
    name: '示例世界 示例神兽 EP01',
    raw: '创作神话项目异兽志第一集，主角示例神兽，120秒，示例世界星球，示例角色探索',
    metadata: {
      title: '神话项目：异兽志 EP01 示例神兽',
      target_duration: 120,
      world_setting: '示例世界',
      featured_beast_id: 'taotie',
      protagonist: '示例角色'
    }
  },
  {
    name: '科普短剧',
    raw: '做一个剧情式科普视频，讲解量子力学，要有故事感',
    metadata: {
      title: '量子力学科普',
      target_duration: 180
    }
  }
];

// 测试结果统计
const results = {
  passed: 0,
  failed: 0,
  tests: []
};

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ ${message}`);
    results.passed++;
  } else {
    console.log(`  ❌ ${message}`);
    results.failed++;
  }
}

// ========== 测试 1: IntentParser ==========
console.log('\n📋 测试 1: IntentParser（意图解析）');
console.log('----------------------------------------');

const intentParser = new IntentParser();

for (const test of testIntents) {
  console.log(`\n  测试用例: ${test.name}`);
  const intent = intentParser.parse(test.raw, test.metadata);
  
  assert(intent.intent_id, '生成 intent_id');
  assert(intent.raw_input === test.raw, '保留原始输入');
  assert(intent.parsed.primary_mode, '识别主叙事模式');
  assert(intent.metadata.title === test.metadata.title, '保留元数据标题');
  assert(intent.metadata.target_duration === test.metadata.target_duration, '保留目标时长');
  
  if (test.metadata.world_setting === '示例世界') {
    assert(intent.parsed.world_setting === '示例世界' || intent.metadata.world_setting === '示例世界', '识别 示例世界 世界观');
  }
  
  console.log(`  解析结果: ${intent.parsed.primary_mode} ${intent.parsed.hybrid_config ? '+ hybrid' : ''}`);
}

// ========== 测试 2: ScriptBlueprint ==========
console.log('\n📋 测试 2: ScriptBlueprint（数据模型）');
console.log('----------------------------------------');

const blueprint = new ScriptBlueprint({
  meta: {
    title: '测试剧本',
    narrative_mode: 'dramatic',
    target_duration: 120
  },
  structure: {
    acts: [
      { act_id: 'ACT-1', act_name: '第一幕', act_function: 'establish', start_time: 0, end_time: 40, beats: [] },
      { act_id: 'ACT-2', act_name: '第二幕', act_function: 'confront', start_time: 40, end_time: 80, beats: [] },
      { act_id: 'ACT-3', act_name: '第三幕', act_function: 'resolve', start_time: 80, end_time: 120, beats: [] }
    ],
    scenes: [
      {
        scene_id: 'SC00',
        scene_name: '片头',
        scene_type: 'opening',
        act_id: 'ACT-1',
        timing: { start: 0, duration: 15, end: 15 },
        characters: ['示例角色'],
        setting: '示例世界硅晶草原，双月当空',
        dialogue: {
          has_dialogue: true,
          lines: [{ speaker: '示例角色', text: '原来这就是示例世界...', emotion: 'awe' }]
        }
      },
      {
        scene_id: 'SC01',
        scene_name: '初遇',
        scene_type: 'conflict',
        act_id: 'ACT-1',
        timing: { start: 15, duration: 25, end: 40 },
        characters: ['示例角色', 'taotie'],
        setting: '等离子河流旁，硅晶岩石',
        dialogue: {
          has_dialogue: true,
          lines: [
            { speaker: '示例角色', text: '那是什么？', emotion: 'surprise' },
            { speaker: 'taotie', text: '（能量涡流轰鸣）', emotion: 'neutral' }
          ]
        }
      },
      {
        scene_id: 'SC02',
        scene_name: '探索',
        scene_type: 'establishing',
        act_id: 'ACT-2',
        timing: { start: 40, duration: 30, end: 70 },
        characters: ['示例角色'],
        setting: '晶体森林深处，荧光闪烁',
        dialogue: {
          has_dialogue: true,
          lines: [{ speaker: '示例角色', text: '这里的能量...好强大', emotion: 'wonder' }]
        }
      },
      {
        scene_id: 'SC03',
        scene_name: '高潮',
        scene_type: 'emotional_climax',
        act_id: 'ACT-2',
        timing: { start: 70, duration: 30, end: 100 },
        characters: ['示例角色', 'taotie'],
        setting: '等离子河流交汇处，能量风暴',
        dialogue: {
          has_dialogue: true,
          lines: [
            { speaker: '示例角色', text: '我明白了，你是守护者！', emotion: 'realization' },
            { speaker: 'taotie', text: '（能量涡流平息）', emotion: 'calm' }
          ]
        }
      },
      {
        scene_id: 'SC04',
        scene_name: '结尾',
        scene_type: 'resolution',
        act_id: 'ACT-3',
        timing: { start: 100, duration: 20, end: 120 },
        characters: ['示例角色'],
        setting: '硅晶草原，双月落下',
        dialogue: {
          has_dialogue: true,
          lines: [{ speaker: '示例角色', text: '记忆即存在...我会记住的', emotion: 'determined' }]
        }
      }
    ]
  },
  character_system: {
    characters: [
      {
        character_id: '示例角色',
        name: '示例角色',
        role: 'protagonist',
        visual_anchor: {
          core_features: ['银灰装甲', '东亚面孔短发', '年轻男性'],
          reference_images: ['characters/示例角色/front.jpg']
        }
      },
      {
        character_id: 'taotie',
        name: '示例神兽',
        role: 'featured_beast',
        visual_anchor: {
          core_features: ['碳化硅质甲壳', '腋下双眼', '巨口能量涡流'],
          reference_images: ['characters/tao-tie/front.jpg']
        }
      }
    ]
  },
  world_setting: {
    world_id: 'nirath',
    world_name: '示例世界星球',
    era: '上古纪元',
    core_rules: ['示例世界是地球前身'],
    environment_tags: ['硅晶草原', '双月当空']
  }
});

assert(blueprint.blueprint_id, '生成 blueprint_id');
assert(blueprint.meta.title === '测试剧本', '设置标题');
assert(blueprint.structure.scenes.length === 5, '5个场景');
assert(blueprint.getScene('SC00').scene_name === '片头', '获取指定场景');
assert(blueprint.getCharacter('示例角色').role === 'protagonist', '获取指定角色');
assert(blueprint.getScenesWithDialogue().length === 5, '5个场景有台词');
assert(blueprint.getTotalDuration() === 120, '总时长 120s');

// 验证
const validation = blueprint.validate();
assert(validation.valid, '剧本验证通过');
assert(validation.errors.length === 0, '无错误');

// JSON 序列化
const json = blueprint.toJSON();
assert(json.includes('测试剧本'), 'JSON 包含标题');

const cloned = ScriptBlueprint.fromJSON(json);
assert(cloned.meta.title === '测试剧本', 'JSON 反序列化');

console.log(`\n  Blueprint 测试通过 ✓`);

// ========== 测试 3: ScriptValidator ==========
console.log('\n📋 测试 3: ScriptValidator（剧本校验）');
console.log('----------------------------------------');

const validator = new ScriptValidator();
const report = validator.validate(blueprint);

assert(report.passed, '校验通过');
assert(report.overall_score > 0, '有评分');
assert(report.checks.length > 0, '有检查项');
assert(report.issues.length === 0, '无问题');
assert(report.scores.detailed.structural_integrity > 0, '结构评分');

console.log(`  综合评分: ${report.overall_score}`);
console.log(`  检查项: ${report.checks.length}`);
console.log(`  通过项: ${report.checks.filter(c => c.passed).length}`);

// 调试：打印失败项
const failedChecks = report.checks.filter(c => !c.passed);
if (failedChecks.length > 0) {
  console.log('  失败项详情:');
  for (const fc of failedChecks) {
    console.log(`    ❌ ${fc.category}.${fc.name}: ${fc.message} [${fc.severity}]`);
    console.log(`       建议: ${fc.suggestion}`);
  }
}

// 测试修复计划生成
const repairPlan = validator.generateRepairPlan(report);
assert(repairPlan.repairs.length === 0, '无修复需求（因为剧本通过）');

console.log(`  修复计划: 无需修复 ✓`);

// ========== 测试 4: 示例世界Extension ==========
console.log('\n📋 测试 4: 示例世界Extension（世界观扩展）');
console.log('----------------------------------------');

const nirath = new 示例世界Extension();

assert(nirath.getWorldInfo().world_id === 'nirath', '获取世界观');
assert(nirath.getBeastArchive('taotie').name === '示例神兽', '获取异兽档案');
assert(nirath.getBeastVisualAnchor('taotie').core_features.length > 0, '获取视觉锚点');
assert(nirath.getProtagonist().character_id === '示例角色', '获取主角设定');

const visualConstraints = nirath.getVisualConstraints();
assert(visualConstraints.must_have.length > 0, '有必须元素');
assert(visualConstraints.forbidden.length > 0, '有禁止元素');

// 验证场景
const sceneValidation = nirath.validateScene(blueprint.structure.scenes[0]);
assert(sceneValidation.valid, '场景符合世界观');

const setting = nirath.generateSceneSetting('测试场景');
assert(setting.includes('示例世界') || setting.includes('硅') || setting.includes('双月'), '生成场景设定');

const charAnchor = nirath.generateCharacterVisualAnchor('示例角色');
assert(charAnchor.includes('银灰装甲'), '生成角色视觉锚点');

console.log(`  示例世界 扩展测试通过 ✓`);

// ========== 测试 5: Adapter ==========
console.log('\n📋 测试 5: ScriptBlueprintAdapter（适配层）');
console.log('----------------------------------------');

const adapter = new ScriptBlueprintAdapter();
const adapted = adapter.adapt(blueprint);

assert(adapted.config.title === '测试剧本', '适配配置');
assert(adapted.scenes.length === 5, '适配场景');
assert(adapted.characters.length === 2, '适配角色');
assert(adapted.dialogues.length === 7, '适配台词（7句）');
assert(adapted.worldSetting.world_id === 'nirath', '适配世界观');

// 检查场景 Prompt 基础
assert(adapted.scenes[0].prompt_base.includes('电影级'), 'Prompt 包含电影级');
assert(adapted.scenes[0].prompt_base.includes('示例世界'), 'Prompt 包含 示例世界');

// 检查视觉方向
assert(adapted.scenes[0].visual_direction.shot_type, '有镜头类型');
assert(adapted.scenes[0].visual_direction.camera_movement, '有运镜');
assert(adapted.scenes[0].visual_direction.lighting, '有布光');

// 生成报告
const adaptReport = adapter.generateReport(adapted);
assert(adaptReport.adaptation_status === 'success', '适配成功');
assert(adaptReport.scenes_count === 5, '报告场景数');

console.log(`  适配报告:`);
console.log(`    场景: ${adaptReport.scenes_count}`);
console.log(`    角色: ${adaptReport.characters_count}`);
console.log(`    台词: ${adaptReport.dialogues_count}`);
console.log(`    时长: ${adaptReport.total_duration}s`);
console.log(`    警告: ${adaptReport.warnings.length}`);

console.log(`  适配层测试通过 ✓`);

// ========== 汇总 ==========
console.log('\n========================================');
console.log('  测试完成');
console.log('========================================');
console.log(`  ✅ 通过: ${results.passed}`);
console.log(`  ❌ 失败: ${results.failed}`);
console.log(`  📊 总计: ${results.passed + results.failed}`);
console.log(`  🎯 成功率: ${Math.round((results.passed / (results.passed + results.failed)) * 100)}%`);
console.log('========================================');

if (results.failed > 0) {
  process.exit(1);
} else {
  console.log('\n🎉 所有测试通过！剧本引擎 MVP 就绪。\n');
  process.exit(0);
}
