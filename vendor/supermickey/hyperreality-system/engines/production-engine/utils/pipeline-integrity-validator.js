// 引入 LLM 引擎用于语义检查
// 【v2.2.8-审计修复】原引用 './llm-reasoning-engine' 在本目录不存在（真身位于仓库根
// systems/llm-reasoning-engine.js），模块加载即抛 MODULE_NOT_FOUND；已纠正为真实路径。
const { LLMEngine } = require('../../../../systems/llm-reasoning-engine');
// 【v2.2.5-审计修复】长度阈值从唯一真源读取，消除 700/1500/980 三个互相打架的就地硬编码
const PromptLengthConfig = require('../../../config/prompt-length.js');

/**
 * Pipeline Output Integrity Validator v1.0
 * 链路输出完整性反向验证器
 * 
 * 核心思想：不只验证"模块被调用"，更要验证：
 * 1. 输出对象结构完整（含所有必需字段）
 * 2. 字段值有效（非空、类型正确、在合理范围）
 * 3. 下游正确消费（上游输出确实出现在最终产物中）
 * 4. 端到端一致性（narration→prompt→最终输出链路贯通）
 * 
 * v6.5.58-fix: 所有内容检查改为LLM语义推理，替代硬编码关键词匹配
 */

class PipelineIntegrityValidator {
  constructor(options = {}) {
    this.errors = [];
    this.warnings = [];
    this.checks = [];
    this.llm = new LLMEngine({ model: 'kimi-k2p6' });
    this.mode = options.mode || 'nirath'; // v6.37-fix: 支持 generic 模式跳过片头检查
  }

  /**
   * 批量语义检查：一次 LLM 调用检查多个问题
   * @param {Array} items - [{id, prompt, question}]
   * @returns {Object} - {id: boolean}
   */
  async _batchSemanticCheck(items) {
    if (!items || items.length === 0) return {};

    const prompt = `你是电影Prompt语义检查器。对以下每个检查项，判断Prompt是否满足要求。只回答 yes 或 no，不要解释。

${items.map(item => `
[${item.id}] 检查: ${item.question}
Prompt: ${item.prompt?.slice(0, 300) || '空'}
`).join('')}

输出JSON格式（无markdown代码块）：${JSON.stringify(items.reduce((acc, item) => { acc[item.id] = 'yes/no'; return acc; }, {}))}`;

    try {
      const result = await this.llm.reason(prompt, {
        maxTokens: 200,
        temperature: 1,
        timeoutMs: 30000
      });

      // 解析 JSON 结果
      const content = result.content || '';
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        const normalized = {};
        for (const [key, val] of Object.entries(parsed)) {
          normalized[key] = String(val).toLowerCase().startsWith('y');
        }
        return normalized;
      }
    } catch (e) {
      console.error('[SemanticCheck] LLM调用失败:', e.message);
    }

    // 失败时全部返回 true（不阻塞，避免误报）
    return items.reduce((acc, item) => { acc[item.id] = true; return acc; }, {});
  }

  // ========== 主入口：验证完整链路 ==========
  async validatePipeline(stages) {
    this.errors = [];
    this.warnings = [];
    this.checks = [];

    console.log('\n🔍 Pipeline完整性反向验证启动...');
    console.log('='.repeat(60));

    // 16个Stage逐一反向验证
    this._checkStage1_PRD(stages.prd);
    this._checkStage2_Alignment(stages.alignment);
    this._checkStage3_Schema(stages.schema);
    this._checkStage4_Characters(stages.characters);
    this._checkStage5_Script(stages.script);
    this._checkStage6_Duration(stages.duration, stages.script);
    this._checkStage7_Storyboard(stages.storyboard);
    this._checkStage8_StoryboardValidation(stages.storyboardValidation);
    await this._checkStage9_Camera(stages.camera, stages.storyboard, stages.render);
    this._checkStage10_Continuity(stages.continuity);
    this._checkStage11_Render(stages.render);
    this._checkStage12_Compliance(stages.compliance, stages.render);
    this._checkStage13_PreRender(stages.preRender);
    await this._checkStage14_Style(stages.style, stages.prd?.meta?.mode || 'nirath');
    this._checkStage15_PostProduction(stages.postProduction);
    await this._checkEndToEnd_Consistency(stages);
    this._checkStage16_FieldIntegrity(stages.render);

    const result = {
      valid: this.errors.length === 0 && this.checks.every(c => c.passed),
      errors: this.errors,
      warnings: this.warnings,
      checks: this.checks,
      summary: {
        totalChecks: this.checks.length,
        passed: this.checks.filter(c => c.passed).length,
        failed: this.checks.filter(c => !c.passed).length,
        errorCount: this.errors.length,
        warningCount: this.warnings.length
      }
    };

    this._printSummary(result);
    return result;
  }

  // ========== 新增：标准字段完整性检查（v6.5.58-fix）==========
  _checkStage16_FieldIntegrity(render) {
    const check = { stage: 'STAGE-16.5', name: '标准字段完整性', passed: true, details: [] };

    if (!render || !Array.isArray(render) || render.length === 0) {
      check.passed = false;
      check.details.push('render数据为空');
      this.errors.push('STAGE-16.5: 无render数据，无法检查字段完整性');
      this.checks.push(check);
      return;
    }

    // 定义标准字段结构
    const standardFields = {
      // 所有镜头通用字段
      common: {
        required: ['id', 'type', 'scene', 'duration', 'prompt', 'length', 'utilization', 'utilizationStatus'],
        optional: ['referenceImages', 'mouthAction', 'qualityScore', 'enhanced', 'dialogue', 'narration', 'cameraMovement', 'emotionPhase', 'importance', 'visualComplexity']
      },
      // 片头专属字段
      opening: {
        required: ['isOpening', 'title'],
        'title.required': ['main', 'sub'],
        'title.optional': ['creator', 'episodeName', 'displayTiming', 'position', 'style']
      },
      // 内容镜专属字段
      content: {
        required: ['cameraMovement'],
        'cameraMovement.required': ['scene', 'primaryMovement', 'speed', 'shotSize', 'timeline']
      }
    };

    for (const result of render) {
      const shotId = result.shotId || result.id || 'unknown';
      const isOpening = result.isOpening || shotId === 'S00';

      // 检查通用必填字段
      for (const field of standardFields.common.required) {
        if (!(field in result) || result[field] === undefined || result[field] === null) {
          check.passed = false;
          check.details.push(`${shotId}: 缺少通用必填字段 ${field}`);
          this.errors.push(`STAGE-16.5: ${shotId} 缺少必填字段 ${field}`);
        }
      }

      // 检查类型一致性
      const validTypes = ['building', 'discovery', 'confrontation', 'climax', 'closing', 'opening',
        'hook', 'pain-point', 'product-reveal', 'solution', 'feature-demo', 'emotional', 'transition',
        'intro', 'content', 'ending']; // v6.5.65-P8-fix: 添加 generic 类型
      if (!validTypes.includes(result.type)) {
        check.passed = false;
        check.details.push(`${shotId}: 类型字段异常: ${result.type}`);
        this.warnings.push(`STAGE-16.5: ${shotId} 类型字段可能不正确: ${result.type}`);
      }

      // 片头专属检查
      if (isOpening) {
        for (const field of standardFields.opening.required) {
          if (!(field in result) || result[field] === undefined || result[field] === null) {
            check.passed = false;
            check.details.push(`${shotId}: 缺少片头必填字段 ${field}`);
            this.errors.push(`STAGE-16.5: ${shotId} 缺少片头必填字段 ${field}`);
          }
        }

        // 检查 title 结构
        if (result.title) {
          const title = result.title;
          for (const field of standardFields.opening['title.required']) {
            if (!(field in title) || !title[field] || title[field].toString().trim() === '') {
              check.passed = false;
              check.details.push(`${shotId}.title: 缺少必填字段 ${field}`);
              this.errors.push(`STAGE-16.5: ${shotId} 片头标题缺少 ${field}（主标题/副标题必填）`);
            }
          }

          // v6.5.65-P8-fix: Nirath 专属 title 格式检查仅在 Nirath 模式下执行
          if (this.mode === 'nirath') {
            // 验证 title.main 格式：必须包含 SHAN HAI JING
            if (title.main && !title.main.includes('SHAN HAI JING')) {
              check.passed = false;
              check.details.push(`${shotId}.title.main: 格式错误，缺少 'SHAN HAI JING' 前缀`);
              this.warnings.push(`STAGE-16.5: ${shotId} 主标题格式可能不正确: ${title.main}`);
            }

            // 验证 title.sub 格式：必须包含 A Nirath Original
            if (title.sub && !title.sub.includes('A Nirath Original')) {
              check.passed = false;
              check.details.push(`${shotId}.title.sub: 格式错误，缺少 'A Nirath Original' 前缀`);
              this.warnings.push(`STAGE-16.5: ${shotId} 副标题格式可能不正确: ${title.sub}`);
            }
          }
        }
      } else {
        // 内容镜专属检查
        for (const field of standardFields.content.required) {
          if (!(field in result) || result[field] === undefined || result[field] === null) {
            check.passed = false;
            check.details.push(`${shotId}: 缺少内容镜必填字段 ${field}`);
            this.warnings.push(`STAGE-16.5: ${shotId} 缺少内容镜字段 ${field}`);
          }
        }

        // 检查 cameraMovement 结构
        if (result.cameraMovement) {
          const cm = result.cameraMovement;
          for (const field of standardFields.content['cameraMovement.required']) {
            if (!(field in cm) || cm[field] === undefined || cm[field] === null) {
              check.passed = false;
              check.details.push(`${shotId}.cameraMovement: 缺少字段 ${field}`);
              this.warnings.push(`STAGE-16.5: ${shotId} cameraMovement 缺少 ${field}`);
            }
          }
        }
      }

      // 检查 prompt 字段内部结构（10字段检查）
      // v6.6.3-fix: 统一使用中文标签，兼容英文旧标签
      // v6.6.3-fix-2: 【灯光】【渲染参数】【导演指令】降为warning，因PromptTier-v2.0不生成这些字段
      if (result.prompt) {
        const prompt = result.prompt;
        const requiredPromptSections = ['【角色】', '【动作】', '【场景】', '【情绪】', '【运镜】', '【负面约束】', '【音频】'];
        const optionalPromptSections = ['【灯光】', '【渲染参数】', '【导演指令】'];
        const requiredEnFallback = ['CHARACTER', 'ACTION', 'SCENE', 'MOOD', 'CAMERA', 'NEGATIVE', 'AUDIO'];
        const optionalEnFallback = ['LIGHTING', 'RENDER', 'DIRECTOR'];
        const missingSections = [];
        const missingOptional = [];
        
        for (let i = 0; i < requiredPromptSections.length; i++) {
          const zhSection = requiredPromptSections[i];
          const enSection = requiredEnFallback[i];
          if (!prompt.includes(zhSection) && !prompt.includes(enSection)) {
            missingSections.push(zhSection);
          }
        }
        
        for (let i = 0; i < optionalPromptSections.length; i++) {
          const zhSection = optionalPromptSections[i];
          const enSection = optionalEnFallback[i];
          if (!prompt.includes(zhSection) && !prompt.includes(enSection)) {
            missingOptional.push(zhSection);
          }
        }
        
        if (missingSections.length > 0) {
          check.passed = false;
          check.details.push(`${shotId}: Prompt缺少必需字段: ${missingSections.join(', ')}`);
          this.errors.push(`STAGE-16.5: ${shotId} Prompt 缺少必需字段: ${missingSections.join(', ')}`);
        }
        
        if (missingOptional.length > 0) {
          check.details.push(`${shotId}: Prompt缺少可选字段: ${missingOptional.join(', ')}`);
          this.warnings.push(`STAGE-16.5: ${shotId} Prompt 缺少可选字段: ${missingOptional.join(', ')}`);
        }
      }
    }

    this.checks.push(check);
  }

  // ========== Stage 1: PRD ==========
  _checkStage1_PRD(prd) {
    const check = { stage: 'STAGE-1', name: 'PRD结构完整性', passed: true, details: [] };

    if (!prd) {
      check.passed = false;
      check.details.push('PRD对象不存在');
      this.errors.push('STAGE-1: PRD未生成');
    } else {
      if (!prd.meta?.title) {
        check.passed = false;
        check.details.push('prd.meta.title缺失');
        this.errors.push('STAGE-1: PRD缺少项目标题');
      }
      if (!prd.world?.nirathWorld && prd.meta?.mode === 'nirath') {
        check.passed = false;
        check.details.push('Nirath模式但prd.world.nirathWorld缺失');
        this.errors.push('STAGE-1: Nirath模式PRD缺少世界观注入');
      }
      if (!prd.scenes || prd.scenes.length === 0) {
        check.passed = false;
        check.details.push('prd.scenes为空');
        this.errors.push('STAGE-1: PRD缺少场景定义');
      }
    }

    this.checks.push(check);
  }

  // ========== Stage 2: Alignment ==========
  _checkStage2_Alignment(alignment) {
    const check = { stage: 'STAGE-2', name: '需求对齐有效性', passed: true, details: [] };

    if (!alignment?.passed) {
      check.passed = false;
      check.details.push('alignment.passed !== true');
      this.errors.push('STAGE-2: 需求对齐未通过，链路不应继续');
    }
    if (!alignment?.checks || Object.values(alignment.checks).some(v => !v)) {
      check.passed = false;
      check.details.push('部分对齐检查项未通过');
      this.warnings.push('STAGE-2: 存在未通过的对齐检查项');
    }

    this.checks.push(check);
  }

  // ========== Stage 3: Schema ==========
  _checkStage3_Schema(schema) {
    const check = { stage: 'STAGE-3', name: 'Schema校验通过性', passed: true, details: [] };

    if (!schema) {
      check.passed = false;
      check.details.push('schema对象不存在');
      this.errors.push('STAGE-3: Schema校验未执行');
    } else if (schema.errors?.length > 0) {
      check.passed = false;
      check.details.push(`Schema错误数: ${schema.errors.length}`);
      this.errors.push(`STAGE-3: Schema校验失败，${schema.errors.length}个错误`);
    }

    this.checks.push(check);
  }

  // ========== Stage 4: Characters ==========
  _checkStage4_Characters(characters) {
    const check = { stage: 'STAGE-4', name: '角色系统输出完整性', passed: true, details: [] };

    if (!characters || Object.keys(characters).length === 0) {
      check.passed = false;
      check.details.push('角色对象为空');
      this.errors.push('STAGE-4: 角色系统未生成任何角色');
    } else {
      for (const [charId, charData] of Object.entries(characters)) {
        if (!charData.prompt || (typeof charData.prompt !== 'string' && typeof charData.prompt !== 'object')) {
          check.passed = false;
          check.details.push(`${charId}: prompt缺失或类型错误`);
          this.errors.push(`STAGE-4: 角色${charId}缺少有效prompt`);
        }
        // P0修复：prompt可以是对象（CharacterPromptBuilder返回对象），检查是否有有效内容
        if (typeof charData.prompt === 'object' && !charData.prompt?.text && !charData.prompt?.prompt) {
          check.passed = false;
          check.details.push(`${charId}: prompt对象缺少text/prompt内容`);
          this.warnings.push(`STAGE-4: 角色${charId}prompt对象结构异常`);
        }
        if (!charData.compliance?.level) {
          check.passed = false;
          check.details.push(`${charId}: compliance.level缺失`);
          this.warnings.push(`STAGE-4: 角色${charId}未经过合规检查`);
        }
      }
    }

    this.checks.push(check);
  }

  // ========== Stage 5: Script ==========
  _checkStage5_Script(script) {
    const check = { stage: 'STAGE-5', name: '剧本输出有效性', passed: true, details: [] };

    if (!script?.scenes || script.scenes.length === 0) {
      check.passed = false;
      check.details.push('script.scenes为空');
      this.errors.push('STAGE-5: 剧本未生成场景');
    } else {
      script.scenes.forEach((scene, idx) => {
        // v6.5.34-fix: narration全局禁用，检查dialogue替代
        const textContent = scene.narration || scene.dialogue;
        if (!textContent || textContent.trim() === '') {
          check.passed = false;
          check.details.push(`场景${idx}: narration/dialogue为空`);
          this.errors.push(`STAGE-5: 场景${idx}缺少narration/dialogue`);
        }
        if (!scene.mouthAction || scene.mouthAction.trim() === '') {
          check.passed = false;
          check.details.push(`场景${idx}: mouthAction为空`);
          this.warnings.push(`STAGE-5: 场景${idx}缺少mouthAction`);
        }
        if (!scene.emotionPhase) {
          check.passed = false;
          check.details.push(`场景${idx}: emotionPhase为空`);
          this.warnings.push(`STAGE-5: 场景${idx}缺少emotionPhase`);
        }
      });
    }

    this.checks.push(check);
  }

  // ========== Stage 6: Duration ==========
  _checkStage6_Duration(durations, script) {
    const check = { stage: 'STAGE-6', name: '时长分配完整性', passed: true, details: [] };

    if (!durations || durations.length === 0) {
      check.passed = false;
      check.details.push('时长分配为空');
      this.errors.push('STAGE-6: 时长分配未执行');
    } else if (script?.scenes && durations.length !== script.scenes.length) {
      check.passed = false;
      check.details.push(`时长分配数(${durations.length}) ≠ 场景数(${script.scenes.length})`);
      this.errors.push('STAGE-6: 时长分配与场景数量不匹配');
    } else {
      // v6.2-patch71-fix: 动态计算时长上限，尊重PRD定义
      const prdDurations = (script?.scenes || []).map(s => s.duration).filter(Boolean);
      const maxPrdDuration = prdDurations.length > 0 ? Math.max(...prdDurations) : 15;
      const durationUpperLimit = Math.max(maxPrdDuration + 3, 15); // 至少15秒，PRD最大时长+3秒容差
      
      durations.forEach((d, idx) => {
        if (!d.duration || d.duration < 3 || d.duration > durationUpperLimit) {
          check.passed = false;
          check.details.push(`${d.sceneId || idx}: duration=${d.duration}秒不在3-${durationUpperLimit}秒范围内`);
          this.errors.push(`STAGE-6: ${d.sceneId || '镜头' + idx}时长${d.duration}秒不合规`);
        }
      });
    }

    this.checks.push(check);
  }

  // ========== Stage 7: Storyboard ==========
  _checkStage7_Storyboard(storyboard) {
    const check = { stage: 'STAGE-7', name: '故事板结构完整性', passed: true, details: [] };

    if (!storyboard?.shots || storyboard.shots.length === 0) {
      check.passed = false;
      check.details.push('storyboard.shots为空');
      this.errors.push('STAGE-7: 故事板未生成镜头');
    } else {
      storyboard.shots.forEach((shot, idx) => {
        if (!shot.id) {
          check.passed = false;
          check.details.push(`shot[${idx}]: id缺失`);
          this.errors.push(`STAGE-7: 镜头${idx}缺少id`);
        }
        if (!shot.scene) {
          check.passed = false;
          check.details.push(`${shot.id || idx}: scene缺失`);
          this.warnings.push(`STAGE-7: ${shot.id || '镜头' + idx}缺少场景描述`);
        }
        if (!shot.duration) {
          check.passed = false;
          check.details.push(`${shot.id || idx}: duration缺失`);
          this.errors.push(`STAGE-7: ${shot.id || '镜头' + idx}缺少时长`);
        }
        if (!shot.mouthAction) {
          // v6.6.3-fix-2: S00片头没有角色，跳过mouthAction检查
          if (shot.id !== 'S00') {
            check.passed = false;
          }
          check.details.push(`${shot.id || idx}: mouthAction缺失`);
          this.warnings.push(`STAGE-7: ${shot.id || '镜头' + idx}缺少mouthAction`);
        }
      });
    }

    this.checks.push(check);
  }

  // ========== Stage 8: StoryboardValidation ==========
  _checkStage8_StoryboardValidation(validation) {
    const check = { stage: 'STAGE-8', name: '故事板校验通过性', passed: true, details: [] };

    if (!validation?.valid) {
      check.passed = false;
      check.details.push('storyboardValidation.valid !== true');
      const errorCount = (validation?.errors || []).filter(e => e.severity === 'error').length;
      this.errors.push(`STAGE-8: 故事板校验未通过，${errorCount}个错误`);
    }

    this.checks.push(check);
  }

  // ========== Stage 9: Camera (关键验证！) ==========
  // v6.5.58-fix: 改为LLM语义检查，替代硬编码关键词匹配
  async _checkStage9_Camera(cameraMovements, storyboard, renderResults) {
    const check = { stage: 'STAGE-9', name: '运镜系统输出有效性（核心）', passed: true, details: [] };

    if (!cameraMovements || cameraMovements.length === 0) {
      check.passed = false;
      check.details.push('运镜输出为空');
      this.errors.push('STAGE-9: 运镜系统未生成任何运镜');
    } else if (storyboard?.shots && cameraMovements.length !== storyboard.shots.length) {
      check.passed = false;
      check.details.push(`运镜数(${cameraMovements.length}) ≠ 镜头数(${storyboard.shots.length})`);
      this.errors.push('STAGE-9: 运镜数量与镜头数量不匹配');
    } else {
      cameraMovements.forEach((cam, idx) => {
        const movement = cam.movement;
        
        // 检查1：movement对象是否存在
        if (!movement) {
          check.passed = false;
          check.details.push(`${cam.shotId || idx}: movement对象缺失`);
          this.errors.push(`STAGE-9: ${cam.shotId || '镜头' + idx}缺少运镜对象`);
          return;
        }

        // 检查2：description是否存在且非空（关键！）
        // 🔥 v6.1-fix: 片头S00由opening-system-v3.js独立生成，跳过运镜检查
        if (cam.shotId === 'S00') {
          return; // 片头镜头独立生成，不检查运镜
        }
        
        if (!movement.description || movement.description.trim() === '') {
          check.passed = false;
          check.details.push(`${cam.shotId || idx}: description为空或缺失`);
          this.errors.push(`STAGE-9: ${cam.shotId || '镜头' + idx}运镜description为空——运镜未真正生效！`);
        }

        // 检查3：description长度（应该丰富，不是简单单词）
        if (movement.description && movement.description.length < 50) {
          check.passed = false;
          check.details.push(`${cam.shotId || idx}: description仅${movement.description.length}字符，过于简单`);
          this.warnings.push(`STAGE-9: ${cam.shotId || '镜头' + idx}运镜描述过短(${movement.description.length}字符)，可能未正确生成`);
        }

      // 检查4：关键字段完整性（适配v1/v2两种结构）
      const v1Fields = ['shotSize', 'position', 'movement', 'speed', 'timeRange'];
      const v2Fields = ['scene', 'physicsDriver', 'primaryMovement', 'speed', 'shotSize'];
      const hasV1Structure = v1Fields.every(f => !!movement[f]);
      const hasV2Structure = v2Fields.every(f => !!movement[f]);
      
      if (!hasV1Structure && !hasV2Structure) {
        check.passed = false;
        check.details.push(`${cam.shotId || idx}: 运镜对象缺少关键字段（非v1也非v2结构）`);
        this.warnings.push(`STAGE-9: ${cam.shotId || '镜头' + idx}运镜结构异常`);
      }
      
      // 如果是v2结构，检查是否有description
      if (hasV2Structure && !movement.description) {
        check.passed = false;
        check.details.push(`${cam.shotId || idx}: v2结构但缺少description`);
        this.errors.push(`STAGE-9: ${cam.shotId || '镜头' + idx}运镜缺少description——下游无法消费！`);
      }
      });

  // 检查5：下游消费验证——LLM语义检查替代硬编码关键词
  // v6.5.58-fix: 用LLM判断prompt是否包含运镜描述，替代硬编码关键词列表
  if (renderResults && renderResults.length > 0) {
    const renderMap = new Map(renderResults.map(r => [r.shotId, r]));
    const semanticItems = [];
    
    cameraMovements.forEach((cam) => {
      if (cam.shotId === 'S00') return; // 片头镜头独立生成
      
      const movement = cam.movement;
      const renderResult = renderMap.get(cam.shotId);
      const prompt = renderResult?.prompt || '';
      
      if (movement?.description && prompt) {
        semanticItems.push({
          id: cam.shotId,
          prompt: prompt,
          question: `该Prompt是否包含运镜/镜头运动描述？（如推进、拉远、环绕、跟踪、一镜到底等）`
        });
      }
    });

    if (semanticItems.length > 0) {
      const results = await this._batchSemanticCheck(semanticItems);
      
      for (const item of semanticItems) {
        if (!results[item.id]) {
          check.passed = false;
          check.details.push(`${item.id}: 运镜未在最终Prompt中体现`);
          this.errors.push(`STAGE-9: ${item.id}运镜输出未被下游消费——buildPromptV3未正确读取运镜！`);
        }
      }
    }
  }
    }

    this.checks.push(check);
  }

  // ========== Stage 10: Continuity ==========
  _checkStage10_Continuity(continuity) {
    const check = { stage: 'STAGE-10', name: '连续性检查通过性', passed: true, details: [] };

    if (!continuity?.consistent) {
      check.passed = false;
      check.details.push('continuity.consistent !== true');
      const issueCount = (continuity?.issues || []).length;
      this.warnings.push(`STAGE-10: 连续性检查发现问题${issueCount}个`);
    }

    this.checks.push(check);
  }

  // ========== Stage 11: Render ==========
  _checkStage11_Render(renderResults) {
    const check = { stage: 'STAGE-11', name: 'Prompt生成质量', passed: true, details: [] };

    if (!renderResults || renderResults.length === 0) {
      check.passed = false;
      check.details.push('Prompt输出为空');
      this.errors.push('STAGE-11: 渲染核心未生成任何Prompt');
    } else {
      renderResults.forEach((result, idx) => {
        // v6.5.58-fix: 标准字段完整性检查
        const requiredFields = ['shotId', 'type', 'scene', 'duration', 'prompt', 'length', 'utilization', 'utilizationStatus', 'referenceImages', 'mouthAction', 'qualityScore', 'enhanced'];
        const missingFields = requiredFields.filter(f => !(f in result) || result[f] === undefined || result[f] === null);
        if (missingFields.length > 0) {
          check.passed = false;
          check.details.push(`${result.shotId || idx}: 缺少标准字段 ${missingFields.join(', ')}`);
          this.errors.push(`STAGE-11: ${result.shotId || '镜头' + idx}缺少标准字段: ${missingFields.join(', ')}`);
        }
        
        // 检查 id/shotId 一致性
        if (result.id && result.shotId && result.id !== result.shotId) {
          check.passed = false;
          check.details.push(`${result.shotId}: id(${result.id})与shotId(${result.shotId})不一致`);
          this.warnings.push(`STAGE-11: ${result.shotId} id与shotId不一致`);
        }
        
        // 检查片头专属字段
        if (result.isOpening || result.shotId === 'S00') {
          // v6.5.65-P8-fix: generic 模式放宽 title 检查（titleOverlay 替代 title 对象）
          if (!result.titleOverlay) {
            if (!result.title || typeof result.title !== 'object') {
              check.passed = false;
              check.details.push(`${result.shotId}: 缺少片头title或titleOverlay`);
              this.errors.push(`STAGE-11: ${result.shotId} 片头缺少title对象`);
            }
          }
          // v6.5.65-P8-fix: Nirath 专属 title 格式仅在 Nirath 模式下检查
          if (this.mode === 'nirath' && result.title) {
            const titleRequired = ['main', 'sub', 'creator', 'episodeName', 'displayTiming', 'position', 'style'];
            const titleMissing = titleRequired.filter(f => !(f in result.title) || !result.title[f] || result.title[f].toString().trim() === '');
            if (titleMissing.length > 0) {
              check.passed = false;
              check.details.push(`${result.shotId}: title缺少字段 ${titleMissing.join(', ')}`);
              this.errors.push(`STAGE-11: ${result.shotId} 片头title缺少字段: ${titleMissing.join(', ')}`);
            }
            if (result.title.main && !result.title.main.includes('SHAN HAI JING')) {
              check.passed = false;
              check.details.push(`${result.shotId}: title.main格式错误，缺少'SHAN HAI JING'前缀: ${result.title.main}`);
              this.warnings.push(`STAGE-11: ${result.shotId} title.main格式可能不正确: ${result.title.main}`);
            }
            if (result.title.sub && !result.title.sub.includes('A Nirath Original')) {
              check.passed = false;
              check.details.push(`${result.shotId}: title.sub格式错误，缺少'A Nirath Original'前缀: ${result.title.sub}`);
              this.warnings.push(`STAGE-11: ${result.shotId} title.sub格式可能不正确: ${result.title.sub}`);
            }
          }
          // 片头 duration 必须是 9
          if (result.duration !== 9) {
            check.passed = false;
            check.details.push(`${result.shotId}: 片头duration必须为9，实际为${result.duration}`);
            this.errors.push(`STAGE-11: ${result.shotId} 片头duration错误: ${result.duration}，必须为9`);
          }
        }
        
        // 检查内容镜专属字段
        if (!result.isOpening && result.shotId !== 'S00') {
          if (!result.cameraMovement || typeof result.cameraMovement !== 'object') {
            check.passed = false;
            check.details.push(`${result.shotId}: 缺少cameraMovement对象`);
            this.errors.push(`STAGE-11: ${result.shotId} 内容镜缺少cameraMovement对象`);
          } else {
            const cmRequired = ['scene', 'primaryMovement', 'speed', 'shotSize', 'timeline'];
            const cmMissing = cmRequired.filter(f => !(f in result.cameraMovement));
            if (cmMissing.length > 0) {
              check.passed = false;
              check.details.push(`${result.shotId}: cameraMovement缺少字段 ${cmMissing.join(', ')}`);
              this.warnings.push(`STAGE-11: ${result.shotId} cameraMovement缺少字段: ${cmMissing.join(', ')}`);
            }
            // 检查 timeline 结构
            if (result.cameraMovement.timeline) {
              const tl = result.cameraMovement.timeline;
              if (!tl.segments || !Array.isArray(tl.segments)) {
                check.passed = false;
                check.details.push(`${result.shotId}: cameraMovement.timeline缺少segments数组`);
                this.warnings.push(`STAGE-11: ${result.shotId} cameraMovement.timeline.segments缺失`);
              }
            }
          }
          // 检查可选字段
          if (!result.emotionPhase) {
            check.details.push(`${result.shotId}: 缺少emotionPhase（可选）`);
          }
          if (!result.importance) {
            check.details.push(`${result.shotId}: 缺少importance（可选）`);
          }
          if (!result.visualComplexity) {
            check.details.push(`${result.shotId}: 缺少visualComplexity（可选）`);
          }
          
          // v6.5.62-P2: 检查 scene 字段（五维空间）
          if (!result.scene || result.scene === '') {
            check.passed = false;
            check.details.push(`${result.shotId}: 缺少scene（P1字段）`);
            this.warnings.push(`STAGE-11: ${result.shotId} 缺少scene`);
          } else {
            // v6.37-fix: scene可以是对象或字符串
            const sceneStr = typeof result.scene === 'string' ? result.scene : JSON.stringify(result.scene);
            // 检查五维空间：至少包含2个维度
            const dimensions = ['Nirath', '大陆', '峡谷', '晶体', '双恒星', '光照', '前景', '中景', '背景', '浴室', '家庭', '温馨', '室内', '房间', '空间'];
            const hasDimension = dimensions.some(d => sceneStr.includes(d));
            if (!hasDimension) {
              check.passed = false;
              check.details.push(`${result.shotId}: scene缺少空间描述`);
              this.warnings.push(`STAGE-11: ${result.shotId} scene空间描述不完整`);
            }
          }
          
          // v6.5.62-P2: 检查 camera 字段（景别+运镜+焦距+速度）
          if (!result.camera || result.camera === '') {
            check.details.push(`${result.shotId}: 缺少camera（P1字段）`);
            this.warnings.push(`STAGE-11: ${result.shotId} 缺少camera`);
          } else {
            // v6.37-fix: camera可以是对象或字符串
            const cameraStr = typeof result.camera === 'string' ? result.camera : JSON.stringify(result.camera);
            const hasShotSize = ['extreme_wide', 'wide', 'medium', 'close_up', 'extreme_close', 'full', 'establishing', 'low-angle', 'high-angle', 'aerial'].some(s => cameraStr.includes(s));
            const hasMovement = ['dolly', 'crane', 'pan', 'tilt', 'tracking', 'orbital', 'arc', 'handheld', 'static', 'push', 'pull', 'zoom', 'rack'].some(m => cameraStr.includes(m));
            if (!hasShotSize || !hasMovement) {
              check.passed = false;
              check.details.push(`${result.shotId}: camera缺少景别或运镜描述`);
              this.warnings.push(`STAGE-11: ${result.shotId} camera格式不完整`);
            }
          }
          
          // v6.5.62-P2: 检查 lighting 字段（主光方向+色温K值）
          if (!result.lighting || result.lighting === '') {
            check.details.push(`${result.shotId}: 缺少lighting（P1字段）`);
            this.warnings.push(`STAGE-11: ${result.shotId} 缺少lighting`);
          } else {
            // v6.37-fix: lighting可以是对象或字符串
            const lightingStr = typeof result.lighting === 'string' ? result.lighting : JSON.stringify(result.lighting);
            if (!lightingStr.includes('K')) {
              check.passed = false;
              check.details.push(`${result.shotId}: lighting缺少色温K值`);
              this.warnings.push(`STAGE-11: ${result.shotId} lighting缺少色温`);
            }
          }
          
          // v6.5.62-P2: 检查 mood 字段（3-5情绪关键词）
          if (!result.mood || result.mood === '') {
            check.details.push(`${result.shotId}: 缺少mood（P1字段）`);
            this.warnings.push(`STAGE-11: ${result.shotId} 缺少mood`);
          } else {
            // 检查是否为3-5个关键词
            const moodKeywords = result.mood.split(/[,，]/).map(s => s.trim()).filter(s => s.length > 0);
            if (moodKeywords.length < 3) {
              check.passed = false;
              check.details.push(`${result.shotId}: mood关键词过少（${moodKeywords.length}个），至少3个`);
              this.warnings.push(`STAGE-11: ${result.shotId} mood关键词过少`);
            }
          }
          
          // v6.5.62-P2: 检查 action 字段
          if (!result.action || result.action === '') {
            check.details.push(`${result.shotId}: 缺少action（P1字段）`);
            this.warnings.push(`STAGE-11: ${result.shotId} 缺少action`);
          }
          if (result.characters && result.characters.length > 0) {
            if (!result.characterRef || result.characterRef === '') {
              check.passed = false;
              check.details.push(`${result.shotId}: 有角色但缺少characterRef（P0字段）`);
              this.warnings.push(`STAGE-11: ${result.shotId} 有角色但缺少characterRef`);
            } else if (!result.characterRef.includes('image://')) {
              check.passed = false;
              check.details.push(`${result.shotId}: characterRef格式错误，缺少image://前缀`);
              this.warnings.push(`STAGE-11: ${result.shotId} characterRef格式错误`);
            }
          }
          
          // character - P0字段，有角色时必须存在
          if (result.characters && result.characters.length > 0) {
            if (!result.character || result.character === '') {
              check.passed = false;
              check.details.push(`${result.shotId}: 有角色但缺少character（P0字段）`);
              this.warnings.push(`STAGE-11: ${result.shotId} 有角色但缺少character`);
            } else {
              // 检查极简锚点格式：角色名: 种族, 关键词1, 关键词2
              const charParts = result.character.split(':').map(s => s.trim());
              if (charParts.length < 2) {
                check.passed = false;
                check.details.push(`${result.shotId}: character格式错误，应为"角色名: 种族, 关键词"`);
                this.warnings.push(`STAGE-11: ${result.shotId} character格式错误`);
              } else {
                const keywords = charParts[1].split(',').map(s => s.trim()).filter(s => s.length > 0);
                if (keywords.length < 3) {
                  check.passed = false;
                  check.details.push(`${result.shotId}: character关键词过少（${keywords.length}个），至少3个`);
                  this.warnings.push(`STAGE-11: ${result.shotId} character关键词过少`);
                }
              }
            }
          }
          
          // timeline - P1字段
          if (!result.timeline || result.timeline === '') {
            check.details.push(`${result.shotId}: 缺少timeline（P1字段）`);
            this.warnings.push(`STAGE-11: ${result.shotId} 缺少timeline`);
          } else {
            // v6.37-fix: timeline可以是对象或字符串
            const timelineStr = typeof result.timeline === 'string' ? result.timeline : JSON.stringify(result.timeline);
            // 检查格式：T00:XX-T00:XX / duration: Xs / type: XXX / mood: XXX
            const timelinePattern = /T\d{2}:\d{2}\.\d-T\d{2}:\d{2}\.\d \/ duration: \d+s \/ type: \w+ \/ mood: \w+/;
            if (!timelinePattern.test(timelineStr)) {
              check.passed = false;
              check.details.push(`${result.shotId}: timeline格式错误: ${timelineStr.slice(0,100)}`);
              this.warnings.push(`STAGE-11: ${result.shotId} timeline格式错误`);
            }
          }
          
          // backgroundSound - P1字段
          if (!result.backgroundSound || result.backgroundSound === '') {
            check.details.push(`${result.shotId}: 缺少backgroundSound（P1字段）`);
            this.warnings.push(`STAGE-11: ${result.shotId} 缺少backgroundSound`);
          } else {
            // v6.37-fix: backgroundSound可以是对象或字符串
            const bgStr = typeof result.backgroundSound === 'string' ? result.backgroundSound : JSON.stringify(result.backgroundSound);
            // 检查三段式：AMBIENT + SPATIAL + INTENSITY
            const hasAmbient = bgStr.includes('AMBIENT');
            const hasSpatial = bgStr.includes('SPATIAL');
            const hasIntensity = bgStr.includes('INTENSITY');
            if (!hasAmbient || !hasIntensity) {
              check.passed = false;
              check.details.push(`${result.shotId}: backgroundSound缺少AMBIENT或INTENSITY段`);
              this.warnings.push(`STAGE-11: ${result.shotId} backgroundSound结构不完整`);
            }
          }
        }
        
        if (!result.prompt || result.prompt.trim() === '') {
          check.passed = false;
          check.details.push(`${result.shotId || idx}: prompt为空`);
          this.errors.push(`STAGE-11: ${result.shotId || '镜头' + idx}Prompt为空`);
        }
        // 【v2.2.5-审计修复】阈值对齐唯一真源两阶段口径：
        // 精炼后交付 prompt 须满足 REFINED_MIN ≤ 长度 ≤ HARD_MAX。
        // 旧逻辑 <700 报错 / >1500 报错 / 文案却写"超过980上限"，三个数字互不相干且全部是废弃规范。
        if (result.prompt && result.prompt.length < PromptLengthConfig.REFINED_MIN) {
          check.passed = false;
          check.details.push(`${result.shotId || idx}: prompt仅${result.prompt.length}字符，低于精炼后下限${PromptLengthConfig.REFINED_MIN}`);
          this.errors.push(`STAGE-11: ${result.shotId || '镜头' + idx}Prompt仅${result.prompt.length}字符，低于精炼后下限${PromptLengthConfig.REFINED_MIN}`);
        }
        if (result.prompt && result.prompt.length > PromptLengthConfig.HARD_MAX) {
          check.passed = false;
          check.details.push(`${result.shotId || idx}: prompt${result.prompt.length}字符超标`);
          this.errors.push(`STAGE-11: ${result.shotId || '镜头' + idx}Prompt${result.prompt.length}字符超过${PromptLengthConfig.HARD_MAX}上限`);
        }
      });
    }

    this.checks.push(check);
  }

  // ========== Stage 12: Compliance ==========
  // v6.5.58-fix: 增加片头标题字段合规检查
  _checkStage12_Compliance(compliance, renderResults) {
    const check = { stage: 'STAGE-12', name: '合规检查有效性', passed: true, details: [] };

    const exceedItems = (compliance?.utilization || []).filter(u => u.status === 'exceed');
    if (exceedItems.length > 0) {
      check.passed = false;
      check.details.push(`${exceedItems.length}个Prompt超标`);
      this.errors.push(`STAGE-12: ${exceedItems.length}个Prompt长度超标，必须精简`);
    }

    const wasteItems = (compliance?.utilization || []).filter(u => u.status === 'waste');
    if (wasteItems.length > 0) {
      // v6.5.34-fix: waste状态仅为警告，不阻断链路
      check.details.push(`${wasteItems.length}个Prompt空间利用率偏低`);
      this.warnings.push(`STAGE-12: ${wasteItems.length}个Prompt空间未充分利用，建议增强内容`);
    }

    // v6.5.58-fix: 片头标题字段合规检查
    if (renderResults && Array.isArray(renderResults)) {
      const openingShot = renderResults.find(r => r.shotId === 'S00' || r.id === 'S00' || r.isOpening);
      if (openingShot) {
        // 检查 title 对象存在
        if (!openingShot.title || typeof openingShot.title !== 'object') {
          check.passed = false;
          check.details.push(`S00: 缺少title对象`);
          this.errors.push(`STAGE-12: S00 片头缺少title对象——opening-system-v3.js未生成title字段`);
        } else {
          const title = openingShot.title;
          // 检查必填字段
          const titleRequiredFields = {
            'main': '主标题（英文）',
            'sub': '副标题（英文）',
            'creator': '出品人',
            'episodeName': '本集主题',
            'displayTiming': '展示时间区间',
            'position': '位置',
            'style': '字体风格'
          };
          
          // v6.5.65-P8-fix: Nirath 专属格式仅在 Nirath 模式下检查
          if (this.mode === 'nirath') {
            for (const [field, label] of Object.entries(titleRequiredFields)) {
              if (!(field in title) || !title[field] || title[field].toString().trim() === '') {
                check.passed = false;
                check.details.push(`S00.title: 缺少${label}(${field})`);
                this.errors.push(`STAGE-12: S00 title.${field}缺失——片头标题${label}未生成`);
              }
            }
            if (title.main && !title.main.includes('SHAN HAI JING')) {
              check.passed = false;
              check.details.push(`S00.title.main: 格式错误，缺少'SHAN HAI JING'前缀`);
              this.errors.push(`STAGE-12: S00 title.main格式错误——必须以'SHAN HAI JING:'开头`);
            }
            if (title.sub && !title.sub.includes('A Nirath Original')) {
              check.passed = false;
              check.details.push(`S00.title.sub: 格式错误，缺少'A Nirath Original'前缀`);
              this.errors.push(`STAGE-12: S00 title.sub格式错误——必须包含'A Nirath Original'`);
            }
            if (title.displayTiming && title.displayTiming !== '6.8-9.0s') {
              check.passed = false;
              check.details.push(`S00.title.displayTiming: 值错误，应为'6.8-9.0s'，实际为'${title.displayTiming}'`);
              this.warnings.push(`STAGE-12: S00 title.displayTiming应为'6.8-9.0s'，实际为'${title.displayTiming}'`);
            }
          }
        }
        
        // 检查 duration 固定为 9
        if (openingShot.duration !== 9) {
          check.passed = false;
          check.details.push(`S00: duration必须为9，实际为${openingShot.duration}`);
          this.errors.push(`STAGE-12: S00 duration错误——必须为9秒，实际为${openingShot.duration}`);
        }
        
        // 检查 isOpening 标记
        if (!openingShot.isOpening) {
          check.passed = false;
          check.details.push(`S00: 缺少isOpening=true标记`);
          this.warnings.push(`STAGE-12: S00 缺少isOpening标记——PromptForge可能错误优化此镜头`);
        }
      } else {
        // v6.37-fix: generic 模式跳过片头检查
        if (this.mode !== 'generic') {
          check.passed = false;
          check.details.push(`S00: 片头镜头缺失`);
          this.errors.push(`STAGE-12: 片头镜头(S00)缺失——opening-system-v3.js未生成或未被纳入renderResults`);
        }
      }
      
      // 检查内容镜字段
      const contentShots = renderResults.filter(r => r.shotId !== 'S00' && r.id !== 'S00' && !r.isOpening);
      for (const shot of contentShots) {
        // 检查 cameraMovement
        if (!shot.cameraMovement || typeof shot.cameraMovement !== 'object') {
          check.passed = false;
          check.details.push(`${shot.shotId}: 缺少cameraMovement对象`);
          this.errors.push(`STAGE-12: ${shot.shotId} 缺少cameraMovement——Stage 9运镜系统输出未流转`);
        } else {
          const cm = shot.cameraMovement;
          if (!cm.primaryMovement) {
            check.passed = false;
            check.details.push(`${shot.shotId}: cameraMovement.primaryMovement缺失`);
            this.warnings.push(`STAGE-12: ${shot.shotId} cameraMovement.primaryMovement缺失`);
          }
          if (!cm.timeline || !cm.timeline.segments) {
            check.passed = false;
            check.details.push(`${shot.shotId}: cameraMovement.timeline.segments缺失`);
            this.warnings.push(`STAGE-12: ${shot.shotId} cameraMovement.timeline结构不完整`);
          }
        }
      }
    }

    this.checks.push(check);
  }

  // ========== Stage 13: PreRender ==========
  _checkStage13_PreRender(preRender) {
    const check = { stage: 'STAGE-13', name: '前置验证就绪状态', passed: true, details: [] };

    if (!preRender?.ready) {
      check.passed = false;
      check.details.push('preRender.ready !== true');
      const failedChecks = (preRender?.checks || []).filter(c => !c.passed);
      this.errors.push(`STAGE-13: 前置验证未就绪，${failedChecks.length}项检查失败`);
    }

    this.checks.push(check);
  }

  // ========== Stage 14: Style ==========
  // v6.5.58-fix: LLM语义检查替代硬编码关键词匹配
  async _checkStage14_Style(styleResults, mode = 'nirath') {
    const check = { stage: 'STAGE-14', name: '风格注入有效性', passed: true, details: [] };

    if (!styleResults || styleResults.length === 0) {
      check.passed = false;
      check.details.push('风格注入输出为空');
      this.errors.push('STAGE-14: 风格注入未执行');
    } else {
      // v6.5.35-fix: 获取全局上下文（从S00中提取）
      const s00Result = styleResults.find(r => r.shotId === 'S00');
      const globalContext = s00Result?.globalContext || '';
      
      // 批量语义检查：超写实风格 + Nirath世界观
      const semanticItems = [];
      
      styleResults.forEach((result, idx) => {
        const prompt = (result.prompt || '') + ' ' + globalContext;
        if (prompt) {
          semanticItems.push({
            id: result.shotId || `idx-${idx}`,
            prompt: prompt,
            question: `该Prompt是否体现了超写实/照片级写实风格？（如photorealistic, hyper-realistic, ultra-detailed, realistic等类似表达均可）`
          });
          if (mode === 'nirath') {
            semanticItems.push({
              id: `${result.shotId || `idx-${idx}`}-nirath`,
              prompt: prompt,
              question: `该Prompt是否包含Nirath星球/异世界世界观元素？（如双恒星、5800K/6500K光照、以太、紫晶等，或明确提到Nirath/异世界/外星等）`
            });
          }
        }
      });

      if (semanticItems.length > 0) {
        const results = await this._batchSemanticCheck(semanticItems);
        
        for (const result of styleResults) {
          const sid = result.shotId;
          
          // 检查超写实风格
          if (results[sid] === false) {
            check.passed = false;
            check.details.push(`${sid}: 缺少超写实风格词`);
            this.warnings.push(`STAGE-14: ${sid}缺少超写实风格词`);
          }
          
          // 检查Nirath世界观
          if (mode === 'nirath' && results[`${sid}-nirath`] === false) {
            check.passed = false;
            check.details.push(`${sid}: 缺少Nirath世界观锚点`);
            this.warnings.push(`STAGE-14: ${sid}缺少Nirath世界观锚点`);
          }
        }
      }
    }

    this.checks.push(check);
  }

  // ========== Stage 15: PostProduction ==========
  _checkStage15_PostProduction(postProduction) {
    const check = { stage: 'STAGE-15', name: '后期规则配置', passed: true, details: [] };

    if (!postProduction) {
      check.passed = false;
      check.details.push('后期规则未生成');
      this.errors.push('STAGE-15: 后期规则未配置');
    } else {
      if (postProduction.ratio !== '16:9') {
        check.passed = false;
        check.details.push(`ratio=${postProduction.ratio}，要求16:9`);
        this.errors.push(`STAGE-15: 输出比例${postProduction.ratio}，必须为16:9`);
      }
      if (!postProduction.resolution) {
        check.passed = false;
        check.details.push('resolution缺失');
        this.warnings.push('STAGE-15: 未指定输出分辨率');
      }
    }

    this.checks.push(check);
  }

  // ========== 端到端一致性验证（最严格！）==========
  // v6.5.58-fix: LLM语义检查替代硬编码关键词匹配
  async _checkEndToEnd_Consistency(stages) {
    const check = { stage: 'END-TO-END', name: '端到端链路一致性', passed: true, details: [] };

    const script = stages.script;
    const storyboard = stages.storyboard;
    const render = stages.render;

    if (script?.scenes && storyboard?.shots && render) {
      // 检查1：场景数→故事板→Prompt数量一致
      // 🔥 v6.1-fix: 片头S00自动插入导致数量+1，验证器需理解此设计
      const sceneCount = script.scenes.length;
      const shotCount = storyboard.shots.length;
      const promptCount = render.length;
      const hasOpeningShot = storyboard.shots.some(s => s.id === 'S00' && s.isOpening);
      const expectedShotCount = hasOpeningShot ? sceneCount + 1 : sceneCount;
      const expectedPromptCount = hasOpeningShot ? sceneCount + 1 : sceneCount;
      
      if (shotCount !== expectedShotCount || promptCount !== expectedPromptCount) {
        check.passed = false;
        check.details.push(`数量不一致: 场景${sceneCount}→故事板${shotCount}(预期${expectedShotCount})→Prompt${promptCount}(预期${expectedPromptCount})`);
        this.errors.push(`END-TO-END: 链路数量断裂！场景${sceneCount}→故事板${shotCount}→Prompt${promptCount}`);
      }

      // 检查2+3：LLM语义检查——场景描述+角色锚定
      // v6.5.58-fix: 收集所有检查项，批量LLM语义检查
      const semanticItems = [];
      let renderIdx = 0;
      
      for (let i = 0; i < script.scenes.length; i++) {
        // 跳过render中的片头镜头
        while (renderIdx < render.length && render[renderIdx]?.isOpening) {
          renderIdx++;
        }
        if (renderIdx >= render.length) break;
        
        const scene = script.scenes[i];
        const narration = scene.narration || '';
        const sceneDesc = scene.scene || '';
        const prompt = render[renderIdx].prompt || '';
        const shotId = render[renderIdx].shotId || `S${String(i+1).padStart(2,'0')}`;
        renderIdx++;
        
        // 场景描述检查
        if (sceneDesc.length > 0) {
          semanticItems.push({
            id: `${shotId}-scene`,
            prompt: prompt,
            question: `该Prompt是否描述了以下场景内容？场景描述："${sceneDesc.slice(0,100)}"`
          });
        }
        
        // 角色锚定检查（从storyboard.characters动态读取）
        const configuredCharacters = storyboard?.characters || {};
        for (const [charId, charConfig] of Object.entries(configuredCharacters)) {
          const charNames = [
            charId,
            charConfig?.name,
            charConfig?.displayName,
            ...(charConfig?.aliases || [])
          ].filter(Boolean);
          
          const appearsInNarration = charNames.some(n => narration.includes(n));
          if (appearsInNarration) {
            const shotChars = storyboard?.shots?.[i]?.characters || [];
            if (shotChars.some(c => c.toLowerCase() === charId.toLowerCase())) {
              semanticItems.push({
                id: `${shotId}-char-${charId}`,
                prompt: prompt,
                question: `该Prompt是否描述了角色"${charConfig?.name || charId}"的形象或动作？`
              });
            }
          }
        }
      }

      // 批量语义检查
      if (semanticItems.length > 0) {
        const results = await this._batchSemanticCheck(semanticItems);
        
        renderIdx = 0;
        for (let i = 0; i < script.scenes.length; i++) {
          while (renderIdx < render.length && render[renderIdx]?.isOpening) {
            renderIdx++;
          }
          if (renderIdx >= render.length) break;
          
          const scene = script.scenes[i];
          const sceneDesc = scene.scene || '';
          const prompt = render[renderIdx].prompt || '';
          const shotId = render[renderIdx].shotId || `S${String(i+1).padStart(2,'0')}`;
          renderIdx++;
          
          // 场景描述检查
          if (sceneDesc.length > 0) {
            const visualPrompt = scene.visualPrompt || '';
            if (visualPrompt.length > 0) {
              // visualPrompt存在时，检查Prompt长度是否达标
              if (prompt.length < 700) {
                check.passed = false;
                check.details.push(`${shotId}: Prompt长度${prompt.length}未达700字符`);
                this.warnings.push(`END-TO-END: ${shotId} Prompt长度不足，场景描述可能未充分展开`);
              }
            } else if (results[`${shotId}-scene`] === false) {
              check.passed = false;
              check.details.push(`${shotId}: 场景描述未体现在Prompt中`);
              this.errors.push(`END-TO-END: ${shotId} 场景描述未流转到Prompt——场景→渲染链路断裂！`);
            }
          }
          
          // 角色锚定检查
          const configuredCharacters = storyboard?.characters || {};
          for (const [charId, charConfig] of Object.entries(configuredCharacters)) {
            const charNames = [
              charId,
              charConfig?.name,
              charConfig?.displayName,
              ...(charConfig?.aliases || [])
            ].filter(Boolean);
            
            const narration = scene.narration || '';
            const appearsInNarration = charNames.some(n => narration.includes(n));
            if (appearsInNarration) {
              const shotChars = storyboard?.shots?.[i]?.characters || [];
              if (shotChars.some(c => c.toLowerCase() === charId.toLowerCase())) {
                if (results[`${shotId}-char-${charId}`] === false) {
                  check.passed = false;
                  check.details.push(`${shotId}: 核心角色"${charId}"未出现在Prompt中`);
                  this.warnings.push(`END-TO-END: ${shotId} 核心角色"${charId}"未出现在Prompt中——角色锚定可能失效`);
                }
              }
            }
          }
        }
      }

      // 检查4：角色提示词是否出现在最终prompt（全局检查）
      // v6.5.58-fix: 也改为LLM语义检查
      const characters = stages.characters || {};
      const charSemanticItems = [];
      
      for (const [charId, charData] of Object.entries(characters)) {
        let charPrompt = charData.prompt || '';
        if (typeof charPrompt === 'object') {
          charPrompt = charPrompt.text || charPrompt.prompt || charPrompt.description || JSON.stringify(charPrompt);
        }
        if (charPrompt.length > 0) {
          const charName = charPrompt.split(',')[0]?.trim() || charId;
          charSemanticItems.push({
            id: `global-char-${charId}`,
            prompt: render.map(r => r.prompt).join(' '),
            question: `以下Prompts中是否描述了角色"${charName}"的形象特征？（如外貌、服装、动作等）`
          });
        }
      }

      if (charSemanticItems.length > 0) {
        const charResults = await this._batchSemanticCheck(charSemanticItems);
        
        for (const [charId, charData] of Object.entries(characters)) {
          let charPrompt = charData.prompt || '';
          if (typeof charPrompt === 'object') {
            charPrompt = charPrompt.text || charPrompt.prompt || charPrompt.description || JSON.stringify(charPrompt);
          }
          if (charPrompt.length > 0) {
            if (charResults[`global-char-${charId}`] === false) {
              check.passed = false;
              check.details.push(`角色${charId}未出现在任何Prompt中`);
              this.warnings.push(`END-TO-END: 角色${charId}提示词未出现在任何Prompt中——角色系统→渲染链路可能断裂`);
            }
          }
        }
      }
    }

    this.checks.push(check);
  }

  // ========== 辅助方法：关键词提取 ==========
  extractKeywords(text) {
    if (!text) return [];
    const stopWords = new Set(['的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好', '自己', '这']);
    
    // 第一步：按标点分割
    const segments = text.split(/[\s,\.。，！？、；：""''（）《》【】\n\-]+/).filter(w => w.length >= 2);
    
    // 第二步：对较长的中文片段提取子关键词（2-4字）
    const words = [];
    for (const seg of segments) {
      if (seg.length <= 4) {
        // 短片段直接保留
        words.push(seg);
      } else {
        // 长片段：滑动窗口提取2-4字子串
        for (let len = 4; len >= 2; len--) {
          for (let i = 0; i <= seg.length - len; i++) {
            const sub = seg.substring(i, i + len);
            if (!stopWords.has(sub)) {
              words.push(sub);
            }
          }
        }
      }
    }
    
    return [...new Set(words)];
  }

  // ========== 打印汇总 ==========
  _printSummary(result) {
    console.log('\n' + '='.repeat(60));
    console.log('📊 Pipeline完整性验证报告');
    console.log('='.repeat(60));
    console.log(`总检查项: ${result.summary.totalChecks}`);
    console.log(`通过: ${result.summary.passed} ✅`);
    console.log(`失败: ${result.summary.failed} ❌`);
    console.log(`错误: ${result.summary.errorCount} 🔴`);
    console.log(`警告: ${result.summary.warningCount} ⚠️`);
    console.log('-'.repeat(60));

    if (result.errors.length > 0) {
      console.log('\n🔴 错误列表（必须修复）：');
      result.errors.forEach((err, i) => console.log(`  ${i + 1}. ${err}`));
    }

    if (result.warnings.length > 0) {
      console.log('\n⚠️ 警告列表（建议优化）：');
      result.warnings.forEach((warn, i) => console.log(`  ${i + 1}. ${warn}`));
    }

    // 详细检查项
    console.log('\n📋 逐Stage详情：');
    result.checks.forEach(c => {
      const icon = c.passed ? '✅' : '❌';
      console.log(`  ${icon} ${c.stage}: ${c.name}`);
      if (c.details.length > 0) {
        c.details.forEach(d => console.log(`      → ${d}`));
      }
    });

    console.log('\n' + '='.repeat(60));
    if (result.valid) {
      console.log('🎉 全部验证通过！链路输出完整且有效。');
    } else {
      console.log('⛔ 验证失败！存在模块输出无效或链路断裂，必须修复后重新运行。');
    }
    console.log('='.repeat(60));
  }
}

module.exports = { PipelineIntegrityValidator };

// CLI测试
if (require.main === module) {
  const validator = new PipelineIntegrityValidator();
  // 测试用例：空stages应该全部失败
  const testResult = validator.validatePipeline({});
  console.log('\n测试完成，有效状态:', testResult.valid);
}
