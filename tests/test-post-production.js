// hyperreality-system/tests/test-post-production.js
// 后期引擎测试 - 验证字幕、音乐、弹幕、多版本输出

const { PostProductionEngine } = require('../engines/post-production-engine/post-production-engine');
const fs = require('fs');

console.log('========================================');
console.log('  超现实系统 - 后期引擎测试 v1.0');
console.log('========================================');
console.log();

// 模拟数据
const mockProductionResult = {
  shots: [
    { shotId: 'SC00', sceneType: 'opening', timing: { duration: 31, start_time: 0 } },
    { shotId: 'SC01', sceneType: 'establishing', timing: { duration: 25, start_time: 31 } },
    { shotId: 'SC02', sceneType: 'conflict', timing: { duration: 33, start_time: 56 } },
    { shotId: 'SC03', sceneType: 'emotional_climax', timing: { duration: 38, start_time: 89 } },
    { shotId: 'SC04', sceneType: 'resolution', timing: { duration: 25, start_time: 127 } }
  ],
  prompts: [
    { shotId: 'SC00', prompt: '电影级镜头...', length: 198, imageRefs: [{characterId: 'exampleCharacter'}] },
    { shotId: 'SC01', prompt: '电影级镜头...', length: 196, imageRefs: [{characterId: 'exampleCharacter'}] },
    { shotId: 'SC02', prompt: '电影级镜头...', length: 198, imageRefs: [{characterId: 'exampleCharacter'}] },
    { shotId: 'SC03', prompt: '电影级镜头...', length: 208, imageRefs: [{characterId: 'exampleCharacter'}] },
    { shotId: 'SC04', prompt: '电影级镜头...', length: 194, imageRefs: [{characterId: 'exampleCharacter'}] }
  ]
};

const mockScriptResult = {
  blueprint: {
    meta: { title: '神话项目：异兽志 EP01 示例神兽', target_duration: 120 },
    structure: {
      scenes: [
        {
          scene_id: 'SC00',
          scene_type: 'opening',
          scene_name: '片头',
          setting: '示例世界 硅晶草原，双月当空',
          timing: { duration: 31, start_time: 0 },
          characters: ['exampleCharacter'],
          dialogue: {
            lines: [{ speaker: 'exampleCharacter', text: '我是示例角色，这是 示例世界。', emotion: 'curious' }]
          }
        },
        {
          scene_id: 'SC01',
          scene_type: 'establishing',
          scene_name: '探索',
          setting: '晶体森林深处',
          timing: { duration: 25, start_time: 31 },
          characters: ['exampleCharacter'],
          dialogue: {
            lines: [{ speaker: 'exampleCharacter', text: '这里的晶体在发光。', emotion: 'wonder' }]
          }
        },
        {
          scene_id: 'SC02',
          scene_type: 'conflict',
          scene_name: '遭遇',
          setting: '示例神兽领地',
          timing: { duration: 33, start_time: 56 },
          characters: ['exampleCharacter', 'example-creature'],
          dialogue: {
            lines: [
              { speaker: 'exampleCharacter', text: '小心！', emotion: 'alert' },
              { speaker: 'example-creature', text: '吼——', emotion: 'aggressive' }
            ]
          }
        },
        {
          scene_id: 'SC03',
          scene_type: 'emotional_climax',
          scene_name: '共鸣',
          setting: '记忆之河',
          timing: { duration: 38, start_time: 89 },
          characters: ['exampleCharacter', 'example-creature'],
          dialogue: {
            lines: [
              { speaker: 'exampleCharacter', text: '你不是怪物，你是记忆。', emotion: 'empathy' }
            ]
          }
        },
        {
          scene_id: 'SC04',
          scene_type: 'resolution',
          scene_name: '启程',
          setting: '等离子河边',
          timing: { duration: 25, start_time: 127 },
          characters: ['exampleCharacter'],
          dialogue: {
            lines: [{ speaker: 'exampleCharacter', text: '下一站，刑天。', emotion: 'determined' }]
          }
        }
      ],
      characters: [
        { id: 'exampleCharacter', name: '示例角色', role: 'protagonist', visuals: { color: '银灰' } },
        { id: 'example-creature', name: '示例神兽', role: 'featured_beast', tags: ['beast'] }
      ]
    }
  }
};

const mockRenderResult = {
  success: true,
  results: [
    { success: true, shotId: 'SC00', taskId: 'task-001' },
    { success: true, shotId: 'SC01', taskId: 'task-002' },
    { success: true, shotId: 'SC02', taskId: 'task-003' },
    { success: true, shotId: 'SC03', taskId: 'task-004' },
    { success: true, shotId: 'SC04', taskId: 'task-005' }
  ]
};

async function runTest() {
  console.log('🔥 [测试] 后期引擎全流程');
  console.log('----------------------------------------');
  console.log();

  const engine = new PostProductionEngine({
    outputDir: '/tmp/hyperreality-test-post',
    enableSubtitles: true,
    enableDanmaku: true,
    enableMusic: true,
    subtitleStyle: 'identity-card',
    versions: ['standard', 'clean', 'subtitled', 'danmaku', 'raw'],
    musicSource: 'pixabay'
  });

  const result = await engine.postProduce(
    mockProductionResult,
    mockScriptResult,
    mockRenderResult
  );

  console.log();
  console.log('----------------------------------------');
  console.log('📊 结果验证');
  console.log('----------------------------------------');

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✅ ${message}`);
      passed++;
    } else {
      console.log(`  ❌ ${message}`);
      failed++;
    }
  }

  // 1. 整体成功
  assert(result.success, '后期制作成功');
  assert(result.timing.total > 0, '有耗时记录');

  // 2. 字幕
  assert(result.stages.subtitles?.count > 0, '生成了字幕');
  assert(result.stages.subtitles?.tracks?.length > 0, '有字幕轨道');
  
  const firstSubtitle = result.stages.subtitles.tracks[0];
  assert(firstSubtitle.type === 'identity_card', '字幕类型为身份卡');
  assert(firstSubtitle.duration > 0, '字幕有持续时间');
  assert(firstSubtitle.content?.name, '字幕有角色名');
  assert(firstSubtitle.content?.title?.includes('示例世界'), '字幕标题包含 示例世界');
  assert(firstSubtitle.content?.species, '字幕有物种信息');
  assert(firstSubtitle.content?.trait, '字幕有特征信息');
  assert(firstSubtitle.style?.position === 'bottom-left', '字幕位置在左下角');
  assert(firstSubtitle.style?.borderLeft?.includes('00ff88'), '字幕有绿色边框');

  // 3. 音乐
  assert(result.stages.music?.count > 0, '匹配了音乐');
  assert(result.stages.music?.tracks?.length > 0, '有音乐轨道');
  
  const firstMusic = result.stages.music.tracks[0];
  assert(firstMusic.searchParams?.mood, '音乐有情绪标签');
  assert(firstMusic.searchParams?.genre, '音乐有风格标签');
  assert(firstMusic.searchParams?.tags?.length > 0, '音乐有搜索标签');
  assert(firstMusic.config?.volume <= 0.5, '背景音乐音量 <= 50%');
  assert(firstMusic.config?.fadeIn > 0, '音乐有淡入');
  assert(firstMusic.source?.platform === 'pixabay', '音乐来源为 Pixabay');
  assert(firstMusic.source?.license?.includes('Free'), '音乐有免费许可');

  // 4. 弹幕
  assert(result.stages.danmaku?.count > 0, '生成了弹幕');
  assert(result.stages.danmaku?.list?.length > 0, '有弹幕列表');
  
  const firstDanmaku = result.stages.danmaku.list[0];
  assert(firstDanmaku.text, '弹幕有内容');
  assert(firstDanmaku.color, '弹幕有颜色');
  assert(firstDanmaku.position === 'top', '弹幕在顶部');
  assert(firstDanmaku.duration > 0, '弹幕有持续时间');

  // 5. 多版本
  assert(Object.keys(result.versions).length === 5, '生成了 5 个版本');
  assert(result.versions.standard, '有标准版');
  assert(result.versions.clean, '有纯净版');
  assert(result.versions.subtitled, '有字幕版');
  assert(result.versions.danmaku, '有弹幕版');
  assert(result.versions.raw, '有原始版');

  // 6. 版本特征检查
  assert(result.versions.standard.features.subtitles === true, '标准版有字幕');
  assert(result.versions.standard.features.music === true, '标准版有音乐');
  assert(result.versions.clean.features.subtitles === false, '纯净版无字幕');
  assert(result.versions.clean.features.music === false, '纯净版无音乐');
  assert(result.versions.danmaku.features.danmaku === true, '弹幕版有弹幕');
  assert(result.versions.raw.features.subtitles === false, '原始版无字幕');

  // 7. 版本文件
  assert(result.versions.standard.htmlPath, '标准版有 HTML 文件');
  assert(result.versions.standard.configPath, '标准版有配置文件');
  assert(result.versions.standard.renderCommand?.includes('hyperframes'), '有渲染命令');

  // 8. HyperFrames HTML 检查
  if (fs.existsSync(result.versions.standard.htmlPath)) {
    const html = fs.readFileSync(result.versions.standard.htmlPath, 'utf8');
    assert(html.includes('data-composition-id'), 'HTML 包含合成 ID');
    assert(html.includes('data-start'), 'HTML 包含时间数据');
    assert(html.includes('data-duration'), 'HTML 包含持续时间');
    assert(html.includes('identity-card'), 'HTML 包含身份卡样式');
    assert(html.includes('gsap'), 'HTML 包含 GSAP');
    assert(html.includes('window.__timelines'), 'HTML 包含时间线注册');
  } else {
    console.log('  ⚠️ HTML 文件尚未生成（检查文件系统权限）');
  }

  // 9. 质量检查
  assert(result.stages.quality?.passed === true, '质量检查通过');
  assert(result.stages.quality?.issues?.length === 0, '无质量问题');

  // 10. 报告生成
  const report = engine.generateReport(result);
  assert(report.includes('后期制作报告'), '报告标题正确');
  assert(report.includes('字幕预览'), '报告包含字幕信息');
  assert(report.includes('音乐配置'), '报告包含音乐信息');
  assert(report.includes('版本详情'), '报告包含版本信息');

  console.log();
  console.log('========================================');
  console.log('  测试完成');
  console.log('========================================');
  console.log(`  ✅ 通过: ${passed}`);
  console.log(`  ❌ 失败: ${failed}`);
  console.log(`  📊 总计: ${passed + failed}`);
  console.log(`  🎯 成功率: ${Math.round((passed / (passed + failed)) * 100)}%`);
  console.log('========================================');

  if (failed === 0) {
    console.log('\n🎉 后期引擎测试全部通过！');
  }

  // 保存测试报告
  const reportPath = '/tmp/hyperreality-test-post/report.md';
  fs.writeFileSync(reportPath, report);
  
  // v2.1.5-fix: 写入验证
  if (!fs.existsSync(reportPath)) {
    console.error(`❌ 测试报告写入后不存在: ${reportPath}`);
  } else {
    const stats = fs.statSync(reportPath);
    if (stats.size === 0) {
      console.error(`❌ 测试报告写入后大小为0: ${reportPath}`);
    } else {
      console.log(`\n💾 测试报告已保存到: ${reportPath} (${stats.size} bytes)`);
    }
  }
}

runTest().catch(err => {
  console.error('❌ 测试失败:', err);
  process.exit(1);
});
