'use strict';

/**
 * SemanticRefinementPass（语义精炼层）
 * ------------------------------------------------------------
 * 【v2.4.5 新增】三段式混合生产的阶段3：FieldContentRefiner（规则）之后的
 * LLM 语义精炼，直接转正为生产环节。
 *
 * 设计依据（2026-07-28《草原教了我十四年》实测）：
 * 规则精炼器只能删"完全重复/枚举残留/碎片"，以下四类问题永远需要语义判断：
 *   A. 跨字段非完全重复（同义改写、部分重叠、信息分布错位）
 *   B. 跨字段矛盾（情绪描写与角色约束冲突、灯光与色彩打架、时长与动作量不符）
 *   C. 机器环节误伤巡检（规则/截断/标准化对创作内容的误删误改）
 *   D. 水分压缩（空泛总结句、同义堆叠、无信息修饰——规则按"有效细节保留"不删，靠语义压缩）
 *
 * 安全结构（转正的核心依据）：
 *   语义层输出 → PromptDeliveryGuard 硬性终验 → 任一不过 → 自动回退到
 *   规则精炼结果。LLM 犯错的代价为零，质量的底线由结构保证。
 *
 * 可观测性：每次运行返回 actions 语义动作日志（类型/字段/动作描述），
 * 由调用方挂到 shot.semanticRefinement 供审计查看。
 */

const { PromptDeliveryGuard } = require('./prompt-delivery-guard');

const ACTION_TYPES = ['跨字段合并', '矛盾仲裁', '误伤修复', '水分压缩'];

class SemanticRefinementPass {
  /**
   * @param {object} options
   * @param {function} options.callLLM - 形如 (prompt, schema, fallbackFn, opts) => Promise<{result}>
   * @param {PromptDeliveryGuard} [options.guard]
   * @param {boolean} [options.enabled=true]
   * @param {number} [options.maxTokens=8192]
   * @param {number} [options.timeoutMs=180000]
   */
  constructor(options = {}) {
    if (typeof options.callLLM !== 'function') {
      throw new Error('[SemanticRefinementPass] 必须注入 callLLM（LLM 驱动环节，禁止无 LLM 实例化）');
    }
    this.callLLM = options.callLLM;
    this.guard = options.guard || new PromptDeliveryGuard();
    this.enabled = options.enabled !== false;
    this.maxTokens = options.maxTokens || 8192;
    this.timeoutMs = options.timeoutMs || 180000;
  }

  /**
   * 对单镜头提示词执行语义精炼。
   * @param {string} ruleRefinedPrompt 规则精炼后的提示词（' | ' 分隔）
   * @param {object} shot 镜头数据
   * @returns {Promise<{prompt:string, actions:Array, applied:boolean, fallbackReason:string|null, guard:object}>}
   */
  async refine(ruleRefinedPrompt, shot = {}) {
    const base = String(ruleRefinedPrompt || '');
    if (!this.enabled) {
      return { prompt: base, actions: [], applied: false, fallbackReason: 'disabled', guard: null };
    }

    const schema = {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        actions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ACTION_TYPES },
              field: { type: 'string' },
              description: { type: 'string' }
            },
            required: ['type', 'field', 'description']
          }
        }
      },
      required: ['prompt', 'actions']
    };

    let llmOut = null;
    let failure = null;
    try {
      const r = await this.callLLM(this._buildPrompt(base, shot), schema, () => null, {
        maxTokens: this.maxTokens,
        timeoutMs: this.timeoutMs,
        maxRetries: 2
      });
      llmOut = r && r.result ? r.result : null;
    } catch (e) {
      failure = `LLM调用异常:${e.message}`;
    }

    if (!llmOut || typeof llmOut.prompt !== 'string' || !llmOut.prompt.trim()) {
      return { prompt: base, actions: [], applied: false, fallbackReason: failure || 'LLM返回为空', guard: null };
    }

    const actions = Array.isArray(llmOut.actions) ? llmOut.actions.filter(a => a && ACTION_TYPES.includes(a.type)) : [];
    const refined = llmOut.prompt.trim();

    // 硬性闸机：不过守卫一律回退
    const guardResult = this.guard.verify(refined, shot);
    if (!guardResult.pass) {
      return {
        prompt: base,
        actions,
        applied: false,
        fallbackReason: `守卫拦截(${guardResult.issues.length}项):${guardResult.issues.slice(0, 3).join(';')}`,
        guard: guardResult
      };
    }

    return { prompt: refined, actions, applied: true, fallbackReason: null, guard: guardResult };
  }

  _buildPrompt(ruleRefinedPrompt, shot) {
    const duration = Number(shot.duration) || 0;
    const expectsDialogue = (() => {
      const b = shot.dialogueBlocks || shot.dialogues || shot.dialogue || [];
      return Array.isArray(b) ? b.length > 0 : !!b;
    })();
    const isOpening = shot.sceneType === 'opening' || shot.shotId === 'SC00' || shot.shotId === 'S00';

    return [
      '你是电影级提示词语义精炼师。下面的镜头提示词已经过规则精炼（机械残留/固定字段已标准化），',
      '你的任务是做规则做不到的语义级精炼，让有效信息密度最大化。',
      '',
      '【允许的四类动作】（除此之外一字不改）',
      '1. 跨字段合并：不同字段间同义改写、部分重叠、信息分布错位的合并归位（如"搪瓷水杯"同时出现在场景与道具）。',
      '2. 矛盾仲裁：字段间直接冲突的修正（如情绪字段的面部描写与角色约束"仅手部入画"冲突；两处对同一时刻的肌肉动作描述互相矛盾）。',
      '3. 误伤修复：明显的机器截断/标准化误伤（如台词引号缺失、半句话），按上下文补全。',
      '4. 水分压缩：删除空泛总结句、同义堆叠、无信息修饰；保留一切具体的摄影/表演/光影细节。',
      '',
      '【硬性纪律】',
      `- 字段结构一字不动：不增删【字段】标签，不改动字段顺序${isOpening ? '，片头 5 个专属字段保留' : ''}。`,
      `- 【语言约束】【基础】【约束】【明亮约束】【负面约束】为标准化字段，禁止改写。`,
      `- 【台词】字段${expectsDialogue ? '逐字保留，时间戳不动' : '不存在则禁止虚构添加'}。`,
      `- 【时间轴】拍点只合并不删除，时长标签与镜头总时长 ${duration}s 保持一致。`,
      '- 输出必须比输入更短或等长，不得注水。',
      '- 全部中文（负面约束固定英文短语与基础质量锚点词除外）。',
      '',
      '【输出格式】',
      '返回 JSON：{"prompt": "精炼后的完整提示词", "actions": [{"type": "四类动作之一", "field": "字段名", "description": "一句话动作描述"}]}',
      'actions 必须如实记录每一处改动；没有改动则 actions 为空数组、prompt 原样返回。',
      '',
      '【待精炼提示词】',
      ruleRefinedPrompt
    ].join('\n');
  }
}

module.exports = { SemanticRefinementPass, ACTION_TYPES };
