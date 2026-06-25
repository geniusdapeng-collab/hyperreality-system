// hyperreality-system/index.js
// Hyperreality System - 超现实工业创作系统统一入口
// 深度融合:剧本引擎 → 适配层 → 制作引擎 → 完整镜头
// 版本:v1.2.5 | 日期:2026-06-19

require('./engines/process-guard'); // 【审计修复】全局崩溃防护,必须最先加载

const { isOpeningShot } = require('./engines/field-standardizer');

const { ScriptEngine } = require('./engines/script-engine');
const { ProductionEngine } = require('./engines/production-engine/production-engine');
const { RenderingEngine } = require('./engines/rendering-engine/rendering-engine');
const { PostProductionEngine } = require('./engines/post-production-engine/post-production-engine');
const { RequirementListBuilder } = require('./engines/script-engine/core/requirement-list-builder');
const { CreativeIntensityEngine } = require('./engines/script-engine/core/creative-intensity-engine');
const { OpeningTitleOptimizer } = require('./engines/production-engine/agents/opening-title-optimizer');
const { routeAndEnhance } = require('../skills/hollywood-cinematography/cinematography-skill-router');
const { FieldGuard } = require('./engines/field-guard');
const fs = require('fs');
const path = require('path');

class HyperrealitySystem {
  constructor(options = {}) {
    this.requirementListBuilder = new RequirementListBuilder(options.requirementListBuilder);
    this.creativeIntensityEngine = new CreativeIntensityEngine(options.creativeIntensityEngine);
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
    this.version = '2.0.5';
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
    console.log(`\n🔥 [HyperrealitySystem v${this.version}] 开始创作`);
    console.log(`   意图: ${intent}`);
    console.log(`   项目: ${metadata.title || '未命名'}`);
    console.log(`   流程: 需求确认 → ${options.skipPromptReview ? '跳过' : '含'}提示词审核 → ${options.skipRender ? '跳过' : '含'}渲染 → ${options.skipPostProduction ? '跳过' : '含'}后期`);
    console.log('');

    const result = {
      success: false,
      stages: {},
      errors: [],
      timing: {},
      confirmations: {} // 记录确认状态
    };

    const totalStart = Date.now();

    try {
      // ========== 🆕 Layer 0: 需求清单生成确认 ==========
      if (!options.skipRequirementList) {
        console.log('📋 [Layer 0] 需求清单生成 - 解析用户意图...');
        const stage0Start = Date.now();

        const requirementList = await this.requirementListBuilder.build(intent, metadata);

        result.stages.requirementList = {
          data: requirementList,
          timing: Date.now() - stage0Start
        };

        console.log(`   ✅ 需求清单生成完成 (${result.stages.requirementList.timing}ms)`);
        console.log(`      类型: ${requirementList.videoTypeName} | 时长: ${requirementList.targetDuration}s | 风格: ${requirementList.style.primary}`);
        console.log(`      角色: ${requirementList.characters.length}个 | 置信度: ${(requirementList._analysis.confidence * 100).toFixed(0)}%`);

        // 生成 Markdown 供人工确认 - 需求清单确认不可跳过!
        console.log('\n📋 [需求清单确认] 等待人工确认...');

        const markdown = this.requirementListBuilder.generateMarkdown(requirementList);
        const requirementConfirmation = await this._confirmRequirementList(markdown, requirementList);
        result.confirmations.requirementList = requirementConfirmation;

        if (!requirementConfirmation.approved) {
          console.log('   ❌ 需求清单未确认,流程中止');
          result.success = false;
          result.stages.requirementReview = {
            status: 'rejected',
            reason: requirementConfirmation.reason || '用户未确认需求清单',
            suggestions: requirementConfirmation.suggestions || []
          };
          return result;
        }

        console.log('   ✅ 需求清单已确认,继续创作');

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
          // 显式保留 characters:用户传入的优先(含 portraitPaths 等详细信息)
          characters: metadata.characters || scriptEngineMeta.characters || [],
          // 【v2.1.4】保留原始metadata中的系列信息(用户传入的优先)
          series: metadata.series || scriptEngineMeta.series || null,
          seriesContentPlan: metadata.seriesContentPlan || scriptEngineMeta.seriesContentPlan || null
        };
        metadata = enhancedMetadata;

        // ========== 🆕 创意指数解析与配置注入 ==========
        const intensity = this.creativeIntensityEngine.parse(requirementList);
        const narrativeMode = requirementList.narrativeMode || 'dialogue';
        const worldSetting = requirementList._analysis?.worldSetting || 'default';

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
      } else {
        console.log('\n⚠️ [Layer 0] 需求清单生成跳过(调试模式)');
        result.stages.requirementList = { skipped: true };
      }

      // ========== Layer 1: 剧本引擎 ==========
      let scriptResult;
      try {
        console.log('📖 [Layer 1] 剧本引擎 - 生成结构化剧本...');
        const stage1Start = Date.now();

        scriptResult = await this.scriptEngine.process(intent, metadata);

        // 【审计修复·P0】校验 adapted 存在且非空
        if (!scriptResult || !scriptResult.adapted) {
          throw new Error('scriptEngine 未产出 adapted Blueprint');
        }
        if (!Array.isArray(scriptResult.adapted.scenes) || scriptResult.adapted.scenes.length === 0) {
          throw new Error('Blueprint scenes 为空，无法继续生产');
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
      } catch (error) {
        result.success = false;
        result.errors.push({ layer: 'script-engine', error: error.message });
        console.error(`\n❌ [Layer 1 失败] ${error.message}`);
        return result;
      }

      // ========== 适配层 ==========
      console.log('\n🔗 [Adapter] 适配层 - 转换数据格式...');
      const adapted = scriptResult.adapted;

      // ========== Layer 2: 制作引擎 ==========
      console.log('\n🎬 [Layer 2] 制作引擎 - 生成镜头...');
      const stage2Start = Date.now();

      // 【修复】应用运行时 agentConfig(解决配置不生效问题)
      if (options.productionEngine?.agentConfig) {
        this.productionEngine.updateAgentConfig(options.productionEngine.agentConfig);
      }

      const productionResult = await this.productionEngine.produce(adapted, options.productionEngine?.agentConfig);

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
        // prompts 数组也要同步
        for (const p of (productionResult.prompts || [])) {
          const shot = productionResult.shots.find(s => s.shotId === p.shotId);
          if (shot) { p.prompt = shot.prompt; p.promptCharCount = shot.promptCharCount; }
        }

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

      // ========== 🆕 好莱坞导演技能注入 ==========
      console.log('\n🎬 [Director Skills] 好莱坞导演技能注入...');
      try {
        const { routeAndEnhance } = require('../skills/hollywood-cinematography/cinematography-skill-router');
        const { enhancedShots, report } = routeAndEnhance(productionResult.shots, {
          minScore: 5,
          maxSkillsPerShot: 2
        });

        // 更新 shots
        productionResult.shots = enhancedShots;

        // 将导演风格同步到 prompts
        for (let i = 0; i < productionResult.prompts.length; i++) {
          const shot = enhancedShots.find(s => s.shotId === productionResult.prompts[i].shotId);
          if (shot && shot._appliedSkills) {
            productionResult.prompts[i].directorStyle = shot._appliedSkills
              .map(s => `${s.type}_${s.director}_${s.emotion}`)
              .join(', ');
            productionResult.prompts[i]._appliedSkills = shot._appliedSkills;
          }
        }

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

      // ========== 🆕 提示词审核确认环节 ==========
      if (!options.skipPromptReview) {
        console.log('\n📝 [提示词审核] 等待人工确认...');

        const promptConfirmation = await this._confirmPrompts(productionResult.prompts);
        result.confirmations.prompts = promptConfirmation;

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

      // ========== Layer 3: 渲染引擎 ==========
      let renderResult = null;

      if (!options.skipRender) {
        try {
          console.log('\n🎨 [Layer 3] 渲染引擎 - 提交 Seedance...');
          const stage3Start = Date.now();

          renderResult = await this.renderingEngine.render(productionResult.prompts, {
            dryRun: options.dryRun || !this.renderingEngine.config.apiKey
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
      if (!options.skipPostProduction) {
        try {
          console.log('\n🎬 [Layer 4] 后期引擎 - 字幕/音乐/弹幕/多版本...');
          const stage4Start = Date.now();

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
      result.success = true;
      result.timing.total = Date.now() - totalStart;

      console.log(`\n🏁 [完成] 总耗时: ${result.timing.total}ms`);
      console.log(`   状态: ${result.success ? '✅ 成功' : '❌ 失败'}`);

      // 生成最终报告
      result.finalReport = this._generateFinalReport(scriptResult, productionResult, result.stages.renderingEngine, result.stages.postProductionEngine, result.timing.total, result.confirmations);

      // ========== 🆕 最终导出前字段标准化(专家诊断建议)==========
      if (productionResult && productionResult.shots) {
        // v2.0.6: 先在FieldGuard之前处理片头字段(避免校验失败阻断)
        const adapter = result.stages?.adapter || {};
        // 【审计修复】统一片头判定,兼容 SC00/S00
        const openingShot = productionResult.shots.find(s => isOpeningShot(s));
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
          const openingShot = productionResult.shots.find(s => isOpeningShot(s));
          if (openingShot) {
            console.log('\n🎬 [OpeningTitleOptimizer] 片头专属字段优化...');
            try {
              const optimizer = new OpeningTitleOptimizer({
                llmTimeout: 120000,
                llmMaxRetries: 2,
                // 【v2.1.4-fix13-审计修复】从环境变量读取模型,消除硬编码
                llmModel: process.env.STORMAXE_LLM_FAST_MODEL || process.env.STORMAXE_LLM_MODEL || 'kimi-k2p6'
              });
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
              }
            } catch (e) {
              console.warn('   ⚠️ 片头优化失败:', e.message);
              // 【v2.1.4-fix13】异常时也要补全全部 5 个字段,不能留空
              openingShot.title_content = openingShot.title_content || result.title || '未命名';
              openingShot.subtitle_content = openingShot.subtitle_content || '第1集';
              openingShot.title_animation = openingShot.title_animation || '主标题淡入入场,副标题延迟0.5秒跟随淡入,整体2秒';
              openingShot.title_font_design = openingShot.title_font_design || '粗体无衬线字体,白色,带微阴影';
              openingShot.opening_audio_design = openingShot.opening_audio_design || '环境音渐起,配合标题入场';
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
            openingShot.sceneType = openingShot.sceneType || 'opening'; // 兜底 sceneType
          }

          // v1.2.6-fix5: 只对 shots 做标准化,不要用 normalized.shots 覆盖 prompts          // v1.2.6-fix5: 只对 shots 做标准化,不要用 normalized.shots 覆盖 prompts          // v1.2.6-fix5: 只对 shots 做标准化，不要用 normalized.shots 覆盖 prompts
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
    }

    // 【v2.1.4-fix13-审计修复】将完整 shots/prompts/opening 挂到 result,供调用方获取完整数据
    if (typeof productionResult !== 'undefined' && productionResult) {
      result.shots = productionResult.shots || [];
      result.prompts = productionResult.prompts || [];
      result.opening = productionResult.opening || null;
      result.degraded = productionResult.degraded || false;
    }

    return result;
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
      suggestions: confirmPath.suggestions
    };
  }

  /**
   * 提示词确认环节
   * v1.2.5: 支持外部确认
   */
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
      suggestions: confirmPath.suggestions
    };
  }

  /**
   * v1.2.5: 等待外部确认
   * 将内容写入文件,轮询等待确认文件
   */
  async _waitForExternalConfirmation(type, content) {
    const outputDir = './output/confirmations';
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // 写入待确认内容
    const contentPath = path.join(outputDir, `confirmation-${type}.md`);
    fs.writeFileSync(contentPath, content, 'utf8');

    const confirmPath = path.join(outputDir, `confirmation-${type}.json`);

    // 【v2.1.4-fix10】检查是否已有预置的确认文件(队长已确认过)
    if (fs.existsSync(confirmPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(confirmPath, 'utf8'));
        if (data.status === 'approved' || data.approved === true) {
          console.log(`   ✅ 检测到已预置确认文件: ${confirmPath},直接通过`);
          return { approved: true, reason: 'pre-approved' };
        }
      } catch (e) {
        // 忽略解析错误,继续等待
      }
    }

    console.log(`\n⏳ [等待确认] ${type} 已输出到: ${contentPath}`);
    console.log(`   请审阅内容后,创建确认文件: ${confirmPath}`);
    console.log('   格式: {"approved": true} 或 {"approved": false, "reason": "..."}');

    // 轮询等待确认文件(最多30分钟)
    const maxWait = 30 * 60 * 1000; // 30分钟
    const checkInterval = 3000; // 3秒
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      if (fs.existsSync(confirmPath)) {
        try {
          const confirmData = JSON.parse(fs.readFileSync(confirmPath, 'utf8'));
          console.log(`   ✅ 收到确认: approved=${confirmData.approved}`);
          return {
            approved: confirmData.approved === true || confirmData.approved === 'true' || confirmData.approved === 1,
            reason: confirmData.reason || '',
            suggestions: confirmData.suggestions || []
          };
        } catch (e) {
          console.log('   ⚠️ 确认文件解析失败,继续等待...');
        }
      }

      // 每10秒打印一次等待提示
      const elapsed = Date.now() - startTime;
      if (elapsed % 10000 < checkInterval) {
        const mins = Math.floor(elapsed / 60000);
        console.log(`   ⏳ 等待确认中... (${mins}分钟)`);
      }

      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }

    // 超时
    console.log('   ⏰ 确认超时,默认拒绝');
    return { approved: false, reason: '等待确认超时', suggestions: [] };
  }

  /**
   * 生成提示词报告(供审阅)
   */
  /**
   * 【v2.1.4-fix13-队长优化】格式化提示词:序号+换行+情绪增强
   */
  _formatPromptWithSequenceNumbers(promptText, isOpening = false) {
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
    while ((match = regex.exec(promptText)) !== null) {
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
    if (isOpening) {
      const openingFields = [
        { name: 'title_content', label: '主标题内容' },
        { name: 'subtitle_content', label: '副标题内容' },
        { name: 'title_animation', label: '标题动画设计' },
        { name: 'title_font_design', label: '标题字体设计' },
        { name: 'opening_audio_design', label: '开场音频设计' }
      ];
      for (const of of openingFields) {
        const seqStr = String(seq).padStart(2, '0');
        lines.push(`${seqStr}.【${of.label}】(片头专属字段,需单独配置)`);
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
    lines.push('| 镜头 | 时长 | 字符数 | 字段数 | 有定妆照 | 有时间轴 | 有约束 |');
    lines.push('|------|------|--------|--------|----------|----------|--------|');

    for (const p of prompts) {
      const hasImages = p.characterRef && p.characterRef !== 'NONE';
      // v2.0.4-fix: 检查 timelineString 是否存在
      const hasTimeline = !!(p.timelineString && p.timelineString.length > 3);
      const hasConstraints = typeof p.prompt === 'string' && p.prompt.includes('角色一致性') || false;
      const charCount = p.promptCharCount || (typeof p.prompt === 'string' ? p.prompt.length : 0);
      // 【v2.1.4-fix13】统计字段数
      const fieldCount = (p.prompt?.match(/【/g) || []).length;
      const isOpening = p.shotId === 'SC00' || p.sceneType === 'opening';
      const expectedFields = isOpening ? 30 : 25;
      const fieldStatus = fieldCount >= expectedFields ? '✅' : (fieldCount >= expectedFields - 3 ? '⚠️' : '❌');
      lines.push(`| ${p.shotId} | ${p.duration || '?'}s | ${charCount} | ${fieldStatus} ${fieldCount}/${expectedFields} | ${hasImages ? '✓' : '✗'} | ${hasTimeline ? '✓' : '✗'} | ${hasConstraints ? '✓' : '✗'} |`);
    }

    lines.push('');
    lines.push('## 完整提示词');
    lines.push('');

    for (const p of prompts) {
      const isOpening = p.shotId === 'SC00' || p.sceneType === 'opening';
      lines.push(`### ${p.shotId}${isOpening ? '(片头·30字段)' : '(内容·25字段)'}`);
      const charCount = p.promptCharCount || (typeof p.prompt === 'string' ? p.prompt.length : 0);
      lines.push(`**长度**: ${charCount} 字符 | **定妆照**: ${p.characterRef && p.characterRef !== 'NONE' ? '有' : '无'} | **时间轴**: ${p.timelineString || '无'}`);
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
      lines.push(this._formatPromptWithSequenceNumbers(p.prompt, isOpening));
      lines.push('```');
      lines.push('');
      lines.push('---');
      lines.push('');
    }

    lines.push('## ⚠️ 审核须知');
    lines.push('');
    lines.push('1. 【内容镜头】确认有 25 个字段(序号01-25)');
    lines.push('2. 【片头镜头】确认有 30 个字段(序号01-30,含5个片头专属字段)');
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

    lines.push('# 超现实工业创作系统 - 生产报告');
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
    lines.push(`| 镜头ID | 类型 | 时长 | 字符数 | 时间轴 | 状态 |`);
    lines.push(`|--------|------|------|--------|--------|------|`);
    for (const shot of production.shots) {
      const charCount = shot.promptCharCount || (typeof shot.prompt === 'string' ? shot.prompt.length : 0);
      const timelineStr = shot.timelineString || '无';
      lines.push(`| ${shot.shotId} | ${shot.sceneType} | ${shot.duration || shot.timing?.duration || 0}s | ${charCount} | ${timelineStr} | ${shot.status || 'ok'} |`);
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
    const path = require('path');

    await fs.mkdir(outputDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const basePath = path.join(outputDir, `hyperreality-${timestamp}`);

    // 保存完整结果 JSON
    await fs.writeFile(
      `${basePath}-result.json`,
      JSON.stringify(result, null, 2)
    );

    // 保存 Markdown 报告
    if (result.finalReport) {
      await fs.writeFile(
        `${basePath}-report.md`,
        result.finalReport
      );
    }

    // 保存提示词审核报告
    if (result.confirmations?.prompts?.report) {
      await fs.writeFile(
        `${basePath}-prompt-review.md`,
        result.confirmations.prompts.report
      );
    }

    // 保存后期制作报告
    if (result.stages?.postProductionEngine?.report) {
      await fs.writeFile(
        `${basePath}-post-production.md`,
        result.stages.postProductionEngine.report
      );
    }

    // 保存 Prompts 单独文件
    if (result.stages?.productionEngine?.prompts) {
      const promptsMD = this._generatePromptsOnlyMD(result.stages.productionEngine.prompts);
      await fs.writeFile(
        `${basePath}-prompts.md`,
        promptsMD
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
}

module.exports = { HyperrealitySystem };
