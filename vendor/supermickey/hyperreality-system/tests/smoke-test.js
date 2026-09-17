/**
 * 全链路烟雾测试 - 快速验证集成
 * 不调用LLM，只验证各模块加载和链路连通性
 */

const path = require('path');
const fs = require('fs');

// 基于测试文件位置的路径
const baseDir = path.join(__dirname, '..');

const errors = [];
const warnings = [];

function check(label, fn) {
  try {
    const result = fn();
    console.log(`   ✅ ${label}`);
    return result;
  } catch (err) {
    console.log(`   ❌ ${label}: ${err.message}`);
    errors.push({ label, error: err.message });
    return null;
  }
}

function warn(label, fn) {
  try {
    fn();
    console.log(`   ✅ ${label}`);
  } catch (err) {
    console.log(`   ⚠️  ${label}: ${err.message}`);
    warnings.push({ label, error: err.message });
  }
}

async function checkAsync(label, fn) {
  try {
    const result = await fn();
    console.log(`   ✅ ${label}`);
    return result;
  } catch (err) {
    console.log(`   ❌ ${label}: ${err.message}`);
    errors.push({ label, error: err.message });
    return null;
  }
}

async function runSmokeTest() {
  console.log('🚀 全链路烟雾测试开始');
  console.log('版本: v2.1.7 | 模式: 快速集成验证 (无LLM调用)');
  console.log('基础目录:', baseDir);
  console.log('');

  // 1. 检查核心模块加载
  console.log('📦 模块加载检查');
  const { HyperrealitySystem } = check('HyperrealitySystem', () => require(path.join(baseDir, 'index')));
  const { CreativeThemeGenerator } = check('CreativeThemeGenerator', () => require(path.join(baseDir, 'skills/creative-theme-generator')));
  const { ScriptEngine } = check('ScriptEngine', () => require(path.join(baseDir, 'engines/script-engine')));
  const { ProductionEngine } = check('ProductionEngine', () => require(path.join(baseDir, 'engines/production-engine/production-engine')));
  const { RenderingEngine } = check('RenderingEngine', () => require(path.join(baseDir, 'engines/rendering-engine/rendering-engine')));
  const { PostProductionEngine } = check('PostProductionEngine', () => require(path.join(baseDir, 'engines/post-production-engine/post-production-engine')));

  console.log('');

  // 2. 检查创意主题生成器
  console.log('🎨 创意主题生成器检查');
  if (CreativeThemeGenerator) {
    const generator = check('实例化', () => new CreativeThemeGenerator());
    
    if (generator) {
      await checkAsync('生成主题(关键词)', async () => {
        const result = await generator.generate('火星沙尘暴');
        if (!result || !result.tasks || result.tasks.length === 0) {
          throw new Error('生成结果为空');
        }
        return result;
      });
      
      await checkAsync('生成主题(自然语言)', async () => {
        const result = await generator.generate('我想拍一个医疗急救视频，50秒');
        if (!result.tasks[0].type || !result.tasks[0].theme) {
          throw new Error('字段缺失');
        }
        return result;
      });
      
      await checkAsync('确认摘要生成', async () => {
        const result = await generator.generate('测试');
        const summary = generator.generateConfirmationSummary(result);
        if (!summary || !summary.includes('创意主题')) {
          throw new Error('摘要格式错误');
        }
        return summary;
      });
    }
  }

  console.log('');

  // 3. 检查HyperrealitySystem初始化
  console.log('🔧 HyperrealitySystem初始化检查');
  if (HyperrealitySystem) {
    const system = check('实例化', () => {
      const s = new HyperrealitySystem({
        scriptEngine: { charactersDir: path.join(baseDir, 'characters') },
        productionEngine: { charactersDir: path.join(baseDir, 'characters') },
        renderingEngine: { charactersDir: path.join(baseDir, 'characters') }
      });
      return s;
    });
    
    if (system) {
      check('creativeThemeGenerator挂载', () => {
        if (!system.creativeThemeGenerator) {
          throw new Error('creativeThemeGenerator未挂载');
        }
      });
      
      check('eventBus挂载', () => {
        if (!system.eventBus) {
          throw new Error('eventBus未挂载');
        }
      });
      
      check('stabilityShield挂载', () => {
        if (!system.stabilityShield) {
          throw new Error('stabilityShield未挂载');
        }
      });
    }
  }

  console.log('');

  // 4. 检查文件系统
  console.log('📁 文件系统检查');
  check('characters目录', () => {
    const charDir = path.join(baseDir, 'characters');
    if (!fs.existsSync(charDir)) {
      fs.mkdirSync(charDir, { recursive: true });
      console.log('      (已自动创建)');
    }
  });

  check('output目录', () => {
    if (!fs.existsSync(path.join(baseDir, 'output'))) {
      fs.mkdirSync(path.join(baseDir, 'output'), { recursive: true });
    }
  });

  check('skills/creative-theme-generator', () => {
    if (!fs.existsSync(path.join(baseDir, 'skills/creative-theme-generator'))) {
      throw new Error('creative-theme-generator目录不存在');
    }
    if (!fs.existsSync(path.join(baseDir, 'skills/creative-theme-generator/index.js'))) {
      throw new Error('index.js不存在');
    }
  });

  console.log('');

  // 5. 检查关键路径
  console.log('🔗 关键路径检查');
  warn('剧本引擎模板', () => {
    if (!fs.existsSync(path.join(baseDir, 'engines/script-engine/templates'))) {
      throw new Error('模板目录不存在');
    }
  });

  warn('渲染引擎', () => {
    if (!fs.existsSync(path.join(baseDir, 'engines/rendering-engine/rendering-engine.js'))) {
      throw new Error('rendering-engine.js不存在');
    }
  });

  console.log('');

  // 6. 输出报告
  console.log('══════════════════════════════════════════');
  console.log('📊 烟雾测试报告');
  console.log('══════════════════════════════════════════');
  console.log(`错误: ${errors.length}个`);
  console.log(`警告: ${warnings.length}个`);

  if (errors.length > 0) {
    console.log('');
    console.log('❌ 错误详情:');
    errors.forEach((e, i) => {
      console.log(`   ${i+1}. [${e.label}] ${e.error}`);
    });
  }

  if (warnings.length > 0) {
    console.log('');
    console.log('⚠️  警告详情:');
    warnings.forEach((w, i) => {
      console.log(`   ${i+1}. [${w.label}] ${w.error}`);
    });
  }

  console.log('');
  console.log('══════════════════════════════════════════');
  console.log(errors.length === 0 ? '✅ 烟雾测试通过' : '❌ 烟雾测试失败');
  console.log('══════════════════════════════════════════');

  return errors.length === 0;
}

runSmokeTest().then(passed => {
  process.exit(passed ? 0 : 1);
}).catch(err => {
  console.error('💥 测试异常:', err);
  process.exit(1);
});
