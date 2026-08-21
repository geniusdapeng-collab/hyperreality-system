'use strict';

/**
 * PortraitStudio — 定妆照工作室引擎（主引擎）
 * ------------------------------------------------------------
 * SuperMickey 定妆照生成环节的编排者，整合进整体交付流程：
 *
 *   plan()      规划：角色分级定妆 + 商品分支链路定妆 + 视觉系统锚定
 *   execute()   执行：双后端可插拔
 *                 - api  生产渲染后端（外部图像服务真实出图）
 *                 - spec 规格后端（默认）：产出完整生成规格包，
 *                   由执行方（技能 Agent / 人工）逐张产出并回填
 *   finalize()  交付：构建"定妆照集"固定交付项（manifest.json + 定妆照集.md）
 *
 * 运行模式：
 *   interactive 交互模式 —— plan 后需人工确认才 execute
 *   auto        批量模式 —— 免询问，系统代替用户决策直接执行
 *
 * 设计目的：让用户在渲染前直观预览角色与商品最终形象，
 * 减少反复沟通成本，同时保持自动化流程的高效性。
 */

const path = require('path');
const { CharacterPortraitPlanner } = require('./character-planner');
const { ProductPortraitBranch } = require('./product-branch');
const { PortraitSetBuilder } = require('./portrait-set-builder');

class PortraitStudio {
  /**
   * @param {Object} options
   * @param {string} options.mode       interactive|auto（默认 interactive）
   * @param {string} options.executor   api|spec（默认 spec）
   * @param {string} options.outputDir  定妆照集输出目录
   * @param {Object} options.plannerOptions  透传给 CharacterPortraitPlanner
   */
  constructor(options = {}) {
    this.mode = options.mode || 'interactive';
    this.executorType = options.executor || 'spec';
    this.characterPlanner = new CharacterPortraitPlanner(options.plannerOptions || {});
    this.productBranch = new ProductPortraitBranch(options.productOptions || {});
    this.setBuilder = new PortraitSetBuilder({
      outputDir: options.outputDir || path.join(process.cwd(), 'deliverables', 'portraits')
    });
  }

  /**
   * 是否需要人工确认（交互模式 true / 批量模式 false）
   */
  needsConfirmation() {
    return this.mode !== 'auto';
  }

  /**
   * 规划定妆照任务
   * @param {Object} context
   * @param {Array}  context.characters 角色定义数组
   * @param {Array}  context.products   商品定义数组
   * @param {Array}  context.prompts    镜头提示词数组
   * @param {Object} context.prd        PRD 文档对象（提取视觉系统）
   * @param {Object} context.blueprint  适配层蓝图（视觉系统兜底来源）
   * @param {Object} context.sceneContext 场景上下文
   * @returns {Object} plan 定妆照计划
   */
  plan(context = {}) {
    const visualStyle = this._extractVisualStyle(context);
    const characterTasks = this.characterPlanner.plan({
      characters: context.characters,
      prompts: context.prompts,
      visualStyle
    });
    const productTasks = this.productBranch.plan({
      products: context.products,
      visualStyle,
      sceneContext: context.sceneContext || {}
    });

    const plan = {
      mode: this.mode,
      executor: this.executorType,
      visualStyle,
      characterTasks,
      productTasks,
      summary: this._buildSummary(characterTasks, productTasks)
    };
    return plan;
  }

  /**
   * 构建计划摘要（供人工确认审阅 / 日志输出）
   */
  _buildSummary(characterTasks, productTasks) {
    const tierName = { lead: '主角', supporting: '配角', cameo: '客串' };
    const lines = [];
    lines.push('# 定妆照生成计划');
    lines.push('');
    if (characterTasks.length > 0) {
      lines.push('## 角色定妆照');
      characterTasks.forEach(t => {
        lines.push(`- ${t.characterName}（${tierName[t.tier] || t.tier}）：${t.angleCount} 角度 — ${t.portraits.map(p => p.angleName).join('、')}`);
      });
      lines.push('');
    }
    if (productTasks.length > 0) {
      lines.push('## 商品定妆照（分支链路：搜参考图 → 抠图/白底/光影 → 风格化）');
      productTasks.forEach(t => {
        lines.push(`- ${t.productName}：5 视角（主视觉45度/正面平视/侧面轮廓/细节特写/使用场景）`);
      });
      lines.push('');
    }
    const total = characterTasks.reduce((s, t) => s + t.angleCount, 0) + productTasks.length * 5;
    lines.push(`共 ${characterTasks.length} 个角色、${productTasks.length} 个商品、${total} 张定妆照。`);
    return lines.join('\n');
  }

  /**
   * 执行定妆照生成
   * @param {Object} plan     plan() 产出的计划
   * @param {Object} runtime  运行时能力 { apiRender?: Function, logger?: Object }
   * @returns {Object} 执行结果
   */
  async execute(plan, runtime = {}) {
    const result = {
      executor: this.executorType,
      executed: 0,
      pending: 0,
      failed: 0,
      errors: []
    };

    if (this.executorType === 'api' && typeof runtime.apiRender === 'function') {
      // ---- api 后端：真实渲染 ----
      for (const task of plan.characterTasks) {
        for (const p of task.portraits) {
          try {
            p.outputFile = await runtime.apiRender(p);
            p.status = 'completed';
            result.executed++;
          } catch (e) {
            p.status = 'failed';
            result.failed++;
            result.errors.push({ portraitId: p.portraitId, error: e.message });
          }
        }
      }
      for (const task of plan.productTasks) {
        // 商品链路的参考图搜索与处理亦由 runtime 提供的能力执行
        if (typeof runtime.searchReferences === 'function') {
          try {
            task.stages.referenceSearch.referenceImages = await runtime.searchReferences(task.stages.referenceSearch);
            task.stages.referenceSearch.status = 'completed';
          } catch (e) {
            task.stages.referenceSearch.status = 'failed';
            result.errors.push({ productId: task.productId, stage: 'reference-search', error: e.message });
          }
        }
        if (typeof runtime.processImage === 'function' && task.stages.referenceSearch.status === 'completed') {
          try {
            task.stages.processing.outputBaseImage = await runtime.processImage(task.stages.processing, task.stages.referenceSearch.referenceImages);
            task.stages.processing.status = 'completed';
          } catch (e) {
            task.stages.processing.status = 'failed';
            result.errors.push({ productId: task.productId, stage: 'processing', error: e.message });
          }
        }
        for (const p of task.stages.stylization.portraits) {
          try {
            p.outputFile = await runtime.apiRender(p, task.stages.processing.outputBaseImage);
            p.status = 'completed';
            result.executed++;
          } catch (e) {
            p.status = 'failed';
            result.failed++;
            result.errors.push({ portraitId: p.portraitId, error: e.message });
          }
        }
        task.status = task.stages.stylization.portraits.every(p => p.status === 'completed') ? 'completed' : 'partial';
      }
    } else {
      // ---- spec 后端（默认）：产出规格包，任务保持 pending 待外部执行 ----
      const allPortraits = plan.characterTasks.flatMap(t => t.portraits);
      const allProductPortraits = plan.productTasks.flatMap(t => t.stages.stylization.portraits);
      result.pending = allPortraits.length + allProductPortraits.length;
      result.specPackage = {
        instruction: '规格包模式：以下定妆照任务已生成完整 prompt 与一致性约束，由执行方逐张产出后将 outputFile/status 回填，再调用 finalize() 重建定妆照集',
        characterPortraits: allPortraits.map(p => p.portraitId),
        productPortraits: allProductPortraits.map(p => p.portraitId),
        productReferenceSearches: plan.productTasks.map(t => ({
          productId: t.productId,
          queries: t.stages.referenceSearch.queries,
          requirements: t.stages.referenceSearch.requirements
        }))
      };
    }

    return result;
  }

  /**
   * 交付：构建定妆照集固定交付项
   */
  finalize(plan, projectMeta = {}) {
    return this.setBuilder.build({
      characterTasks: plan.characterTasks,
      productTasks: plan.productTasks,
      visualStyle: plan.visualStyle,
      projectMeta
    });
  }

  // ========== 内部方法 ==========

  /**
   * 提取视觉系统锚点（PRD 优先，blueprint 兜底）
   */
  _extractVisualStyle(context = {}) {
    const prd = context.prd || {};
    const blueprint = context.blueprint || {};
    const vs = prd.visual_style || prd.visualStyle || prd.visualSystem || {};
    const bvs = blueprint.visual_style || blueprint.visualStyle || {};

    const pick = (...vals) => vals.find(v => typeof v === 'string' && v.trim()) || null;
    return {
      renderStyle: pick(vs.render_style, vs.renderStyle, vs.style, bvs.render_style, bvs.renderStyle, bvs.style),
      tone: pick(vs.tone, vs.color_tone, vs.colorTone, bvs.tone, bvs.color_tone),
      lighting: pick(vs.lighting, vs.light, bvs.lighting, bvs.light),
      atmosphere: pick(vs.atmosphere, vs.mood, bvs.atmosphere, bvs.mood),
      colorScript: pick(vs.color_script, vs.colorScript, bvs.color_script, bvs.colorScript)
    };
  }
}

module.exports = { PortraitStudio };
