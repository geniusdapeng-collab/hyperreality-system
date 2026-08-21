/**
 * Pipeline Schema Validation Injector v1.0
 * 在现有Pipeline阶段边界注入Schema验证（警告模式，不阻断）
 * 
 * 注入点：
 * - Stage 5→6: Shot数组验证（验证剧本生成的场景数据）
 * - Stage 7→8: Storyboard验证（故事板生成后）
 * - Stage 10.5→11: Render Prompt Input验证（渲染前安全检查）
 * 
 * 模式: warn（记录日志，不抛异常，不阻断链路）
 * 渐进策略：收集2轮预生产数据后评估是否切换strict
 */

'use strict';

const { PipelineSchemaValidator } = require('./schemas/pipeline-schemas.js');

class PipelineValidationInjector {
  constructor(options = {}) {
    this.validator = new PipelineSchemaValidator();
    this.mode = options.mode || 'warn'; // 'warn' | 'strict'
    this.enabled = options.enabled !== false;
    this.logFn = options.logFn || console.log;
    this.stats = {
      totalChecks: 0,
      warnings: 0,
      errors: 0,
      stageChecks: {}
    };
  }

  log(level, message) {
    this.logFn(`[SchemaValidation:${level}] ${message}`);
  }

  /**
   * 注入验证到Pipeline实例
   * @param {NirathMasterPipeline} pipeline - 现有Pipeline实例
   */
  inject(pipeline) {
    if (!this.enabled) {
      this.log('INFO', 'Schema验证已禁用，跳过注入');
      return;
    }

    // 保存原始方法引用（检查存在性）
    const originalExecute = pipeline.execute ? pipeline.execute.bind(pipeline) : null;
    const originalStageScriptGeneration = pipeline.stageScriptGeneration ? pipeline.stageScriptGeneration.bind(pipeline) : null;
    const originalStageStoryboard = pipeline.stageStoryboard ? pipeline.stageStoryboard.bind(pipeline) : null;
    const originalStageRender = pipeline.stageRender ? pipeline.stageRender.bind(pipeline) : null;
    const originalStageSafetyGate = pipeline.stageSafetyGate ? pipeline.stageSafetyGate.bind(pipeline) : null;

    // === 注入点1: Stage 5 输出验证 (Shot数组验证) ===
    pipeline.stageScriptGeneration = async function(input, prd) {
      const result = await originalStageScriptGeneration(input, prd);
      
      // 验证 scenes 数组（转换为Shot Schema兼容格式）
      if (result && result.scenes && Array.isArray(result.scenes)) {
        const shots = result.scenes.map((scene, idx) => ({
          id: scene.id || `S${String(idx + 1).padStart(2, '0')}`,
          sequence: idx + 1,
          scene: scene.scene || scene.beatName || 'unknown',
          narration: scene.narration || '',
          characters: Array.isArray(scene.characters) ? scene.characters.map(c => 
            typeof c === 'string' ? { id: c } : c
          ) : [],
          emotionPhase: scene.emotionPhase || 'exposition',
          duration: scene.duration || scene.estimatedDuration || 0,
          type: scene.type || 'establishing',
          visualPrompt: scene.visualPrompt || ''
        }));
        
        const validation = this.validator.validateShots(shots, { strict: false });
        this.recordValidation('STAGE-5→6', validation);
        
        if (!validation.valid) {
          this.log('WARN', `Stage 5 输出验证发现 ${validation.errors.length} 个错误:`);
          for (const err of validation.errors.slice(0, 5)) {
            this.log('WARN', `  - ${err}`);
          }
          if (validation.warnings.length > 0) {
            this.log('WARN', `  还有 ${validation.warnings.length} 个警告`);
          }
          // 将验证结果附加到stage输出，供后续Stage参考
          result._schemaValidation = {
            valid: false,
            errors: validation.errors,
            warnings: validation.warnings,
            checkedAt: Date.now()
          };
        } else {
          this.log('INFO', `Stage 5 输出验证通过 | ${shots.length} 个场景`);
          result._schemaValidation = { valid: true, checkedAt: Date.now() };
        }
      }
      
      return result;
    }.bind(this);

    // === 注入点2: Stage 7 输出验证 (Storyboard验证) ===
    pipeline.stageStoryboard = async function(script, durations, input = {}) {
      const result = await originalStageStoryboard(script, durations, input);
      
      // 验证 storyboard 结构
      if (result && result.shots && Array.isArray(result.shots)) {
        const storyboardData = {
          title: result.title || input.projectName || 'untitled',
          totalShots: result.shots.length,
          shots: result.shots,
          totalDuration: result.totalDuration || durations?.totalDuration || 0
        };
        
        const validation = this.validator.validateStageInput('STAGE-7', storyboardData, 'Storyboard');
        this.recordValidation('STAGE-7→8', validation);
        
        if (!validation.valid) {
          this.log('WARN', `Stage 7 Storyboard验证发现 ${validation.errors.length} 个错误:`);
          for (const err of validation.errors.slice(0, 5)) {
            this.log('WARN', `  - ${err}`);
          }
          result._schemaValidation = {
            stage: 'STAGE-7',
            valid: false,
            errors: validation.errors,
            warnings: validation.warnings,
            checkedAt: Date.now()
          };
        } else {
          this.log('INFO', `Stage 7 Storyboard验证通过 | ${result.shots.length} 个镜头`);
          result._schemaValidation = { stage: 'STAGE-7', valid: true, checkedAt: Date.now() };
        }
        
        // 额外：逐个验证Shot
        const shotValidation = this.validator.validateShots(result.shots, { strict: false });
        if (!shotValidation.valid) {
          this.log('WARN', `Stage 7 Shot级验证发现 ${shotValidation.errors.length} 个错误`);
          for (const err of shotValidation.errors.slice(0, 3)) {
            this.log('WARN', `  - ${err}`);
          }
          if (result._schemaValidation) {
            result._schemaValidation.shotErrors = shotValidation.errors;
          }
        }
      }
      
      return result;
    }.bind(this);

    // === 注入点3: Stage 10.5 前置检查增强 (Render Prompt Input验证) ===
    if (originalStageSafetyGate) {
      pipeline.stageSafetyGate = async function(stages) {
        const result = await originalStageSafetyGate(stages);
        
        // 增强：验证每个渲染镜头的Prompt输入
        const renderData = stages.render;
        if (renderData && Array.isArray(renderData)) {
          let promptIssues = 0;
          for (let i = 0; i < renderData.length; i++) {
            const renderItem = renderData[i];
            if (renderItem.prompt) {
              const promptValidation = this.validator.validateRenderPrompt({
                shotId: renderItem.shotId || renderItem.id || `shot-${i}`,
                prompt: renderItem.prompt,
                negativePrompt: renderItem.negativePrompt || '',
                duration: renderItem.duration || renderItem.shotDuration || 10,
                style: renderItem.style || {}
              });
              
              if (!promptValidation.valid) {
                promptIssues++;
                if (promptIssues <= 3) {
                  this.log('WARN', `Stage 10.5 Render Prompt[${i}]验证失败: ${promptValidation.errors.join('; ')}`);
                }
              }
            }
          }
          
          if (promptIssues > 0) {
            this.log('WARN', `Stage 10.5 共发现 ${promptIssues} 个镜头Prompt验证失败`);
            result._schemaValidation = {
              promptIssues,
              checkedAt: Date.now()
            };
          } else {
            this.log('INFO', `Stage 10.5 所有 ${renderData.length} 个镜头Prompt验证通过`);
          }
        }
        
        return result;
      }.bind(this);
    }

    this.log('INFO', 'Schema验证注入完成 | 模式: warn | 注入点: Stage5→6, Stage7→8, Stage10.5→11');
  }

  recordValidation(boundary, validation) {
    this.stats.totalChecks++;
    if (!validation.valid) {
      this.stats.errors += validation.errors?.length || 0;
      this.stats.warnings += validation.warnings?.length || 0;
    }
    
    if (!this.stats.stageChecks[boundary]) {
      this.stats.stageChecks[boundary] = { checks: 0, failures: 0 };
    }
    this.stats.stageChecks[boundary].checks++;
    if (!validation.valid) {
      this.stats.stageChecks[boundary].failures++;
    }
  }

  getStats() {
    return {
      ...this.stats,
      failureRate: this.stats.totalChecks > 0 ? 
        (this.stats.stageChecks[Object.keys(this.stats.stageChecks)[0]]?.failures || 0) / this.stats.totalChecks : 0
    };
  }

  /**
   * 渐进切换模式（收集足够数据后）
   */
  evaluateModeSwitch(minSamples = 2) {
    const totalChecks = this.stats.totalChecks;
    const totalFailures = Object.values(this.stats.stageChecks).reduce((sum, s) => sum + s.failures, 0);
    
    if (totalChecks >= minSamples) {
      const failureRate = totalFailures / totalChecks;
      if (failureRate < 0.1) {
        this.log('INFO', `验证失败率 ${(failureRate * 100).toFixed(1)}% < 10%，建议切换 strict 模式`);
        return { recommend: 'strict', current: this.mode, failureRate };
      } else {
        this.log('WARN', `验证失败率 ${(failureRate * 100).toFixed(1)}% >= 10%，保持 warn 模式`);
        return { recommend: 'warn', current: this.mode, failureRate };
      }
    }
    
    return { recommend: 'wait', current: this.mode, samples: totalChecks, minSamples };
  }
}

module.exports = { PipelineValidationInjector };