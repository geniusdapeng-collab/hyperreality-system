/**
 * VisualLanguageAgent - 视觉语言Agent v2.1.8 (专家修复版)
 *
 * 修复内容:
 * 1. llmTimeout 从 300s → 450s
 * 2. 新增镜头分批处理: 超过 3 个镜头自动拆分为多批独立调用
 * 3. 精简 Prompt，降低 LLM 处理负担
 * 4. 单批失败 catch 处理，不导致整体失败
 * 5. 每批使用独立预算
 *
 * 替换路径: hyperreality-system/engines/production-engine/agents/visual-language-agent.js
 */
const { BaseAgent } = require('./base-agent');

class VisualLanguageAgent extends BaseAgent {
  constructor(options = {}) {
    super({
      name: 'VisualLanguageAgent',
      ...options,
      // 【修复】llmTimeout 默认值必须写在 ...options 之后，否则会被 base 配置静默覆盖
      llmTimeout: options.llmTimeout ?? 450000
    });
    this.batchSize = options.batchSize || 3; // 【修复】每批最多 3 个镜头（已验证）
  }

  _getSystemPrompt() {
    return `你是一位专业的电影摄影师和灯光师。根据剧本和场景信息，为每个镜头设计运镜方案、灯光方案、构图方案、色彩方案和景深方案。

输出JSON格式:
{
  "shots": [
    {
      "shotId": "SC01",
      "camera": {
        "shot_size": "wide/medium/close_up/extreme_close_up",
        "movement": "dolly_in/static/handheld/push_in/pull_back",
        "angle": "eye_level/low/high",
        "lens": "35mm/50mm/85mm",
        "speed": "slow/normal/fast"
      },
      "cameraString": "运镜描述文本",
      "lighting": {
        "key_light": "主光描述",
        "fill_light": "辅光描述",
        "time_of_day": "golden_hour/midday/blue_hour/night",
        "atmosphere": "氛围光描述"
      },
      "lightingString": "灯光描述文本",
      "composition": "构图描述（景别+主体位置+线条引导+留白）",
      "color_palette": "色彩方案（主色+辅色+肤色+饱和度+对比度）",
      "depth_of_field": "景深方案（焦点+光圈+前景背景虚化）",
      "timeline": [
        { "segment": 1, "timeRange": "0s-3s", "cameraMovement": "缓推全景", "shotType": "wide", "purpose": "建立空间" }
      ]
    }
  ]
}

设计原则:
1. 运镜要服务叙事：情绪紧张用手持晃动，情绪平和用稳定机位
2. 构图要服务情绪：紧张→对称/居中，自由→三分法/对角线
3. 色彩要服务情绪：紧张→冷色/高对比，温馨→暖色/低对比
4. 景深要服务景别：特写→浅景深(f/2.8)，全景→深景深(f/8)
5. 时间轴动态切分：根据台词密度和情绪变化切分3-4段，不等分
6. 灯光要场景化：不用技术术语，用自然描述
7. 考虑镜头间衔接：相邻镜头的景别和运动要有逻辑过渡;`;
  }

  async process(shots, blueprint) {
    console.log(`[VisualLanguageAgent] 开始处理 ${shots.length} 个镜头，批次大小 ${this.batchSize}...`);
    // 【2026-07-17 camera-coherence】暂存全片镜头，供全局编排指导注入
    this._allShots = shots;

    // 【修复】分批处理：超过 batchSize 个镜头自动拆分
    if (shots.length > this.batchSize) {
      return this._processBatched(shots, blueprint);
    }
    return this._processSingle(shots, blueprint);
  }

  /**
   * 【新增】分批处理逻辑
   */
  async _processBatched(shots, blueprint) {
    const batches = [];
    for (let i = 0; i < shots.length; i += this.batchSize) {
      batches.push(shots.slice(i, i + this.batchSize));
    }
    console.log(`[VisualLanguageAgent] 拆分为 ${batches.length} 批: [${batches.map(b => b.length).join('+')}]`);

    const allResults = [];
    let hasDegraded = false;
    let degradeReason = null;

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      console.log(`[VisualLanguageAgent] 处理第 ${i + 1}/${batches.length} 批 (${batch.length} 镜头)...`);

      try {
        const result = await this._processSingle(batch, blueprint, { batchIndex: i, totalBatches: batches.length });
        allResults.push(...result.shots);
        if (result.degraded) {
          hasDegraded = true;
          degradeReason = result.degradeReason;
        }
      } catch (err) {
        console.error(`[VisualLanguageAgent] 第 ${i + 1} 批失败: ${err.message}，使用降级`);
        const fallbackResult = this._fallback(batch);
        allResults.push(...fallbackResult.shots);
        hasDegraded = true;
        degradeReason = `Batch ${i + 1} failed: ${err.message}`;
      }

      // 批次间短暂暂停，避免触发限流
      if (i < batches.length - 1) {
        console.log(`[VisualLanguageAgent] 批次间暂停 2s...`);
        await this._sleep(2000);
      }
    }

    // 合并结果（保持原始顺序）
    const shotMap = new Map(allResults.map(s => [s.shotId, s]));
    const mergedShots = shots.map(original => {
      const designed = shotMap.get(original.shotId);
      return designed ? this._mergeShot(original, designed) : original;
    });

    console.log(`[VisualLanguageAgent] 分批处理完成 ✓ ${hasDegraded ? '(有降级)' : ''}`);
    return {
      shots: mergedShots,
      degraded: hasDegraded,
      degradeReason
    };
  }

  /**
   * 【提取】单批处理逻辑（原 process 核心）
   */
  async _processSingle(shots, blueprint, options = {}) {
    const prompt = this._buildPrompt(shots, blueprint, options);

    const schema = {
      required: ['shots'],
      requiredArrays: ['shots'],
      rejectEmptyArray: true,
    };

    // 【修复】每批使用独立预算，避免单批耗尽全部时间
    const batchBudget = Math.min(this.llmTimeout, 420000); // 每批最多 7 分钟

    // 【2026-07-17】关键环节标记：镜头设计必须 LLM 驱动
    const llmResult = await this._callLLM(prompt, schema, () => {
      return this._fallback(shots);
    }, { shotBudget: batchBudget, critical: true });

    if (llmResult.degraded) {
      return {
        shots: llmResult.result?.shots || shots,
        degraded: true,
        degradeReason: llmResult.degradeReason
      };
    }

    // 合并LLM结果
    const designedShots = shots.map((shot) => {
      const designed = llmResult.result?.shots?.find(s => s.shotId === shot.shotId) || {};
      return this._mergeShot(shot, designed);
    });

    console.log(`[VisualLanguageAgent] 单批处理完成 ✓`);
    return { shots: designedShots, degraded: false, degradeReason: null };
  }

  /**
   * 【新增】合并单个镜头字段（兜底保护）
   */
  _mergeShot(original, designed) {
    return {
      ...original,
      camera: designed.camera || original.camera,
      cameraString: designed.cameraString || original.cameraString || '',
      lighting: designed.lighting || original.lighting,
      lightingString: designed.lightingString || original.lightingString || '',
      composition: designed.composition || original.composition || '',
      color_palette: designed.color_palette || original.color_palette || '',
      depth_of_field: designed.depth_of_field || original.depth_of_field || '',
      timeline: designed.timeline || original.timeline,
      cameraMovement: {
        ...original.cameraMovement,
        ...(designed.timeline ? { timeline: designed.timeline } : {})
      }
    };
  }

  /**
   * 【优化】精简 Prompt，降低 LLM 处理负担
   * 【接线1 修复】注入 PRD visualSpecification 到视觉设计 prompt
   */
  _buildPrompt(shots, blueprint, options = {}) {
    const shotsInfo = shots.map(s => {
      const dialogue = s.dialogue?.lines?.map(l => `"${l.content}"`).join('; ') || s.dialogue || '';
      return `镜头 ${s.shotId}: ${s.duration || '?'}s; 情绪: ${s.mood || ''}; 台词: ${dialogue.substring(0, 60)}`;
    }).join('\n');

    const batchHint = options.batchIndex !== undefined
      ? `\n【注意】这是第 ${options.batchIndex + 1}/${options.totalBatches} 批，仅处理上面列出的 ${shots.length} 个镜头。`
      : '';

    // 【接线1 修复】提取 PRD 视觉规格并注入 prompt
    const prd = blueprint?._prd || blueprint?.meta?._prd || null;
    const visualSpec = prd?.productionSpecification?.visualSpecification || prd?.visualSpecification || null;
    
    let visualSpecSection = '';
    if (visualSpec) {
      const refs = (visualSpec.visualReferences || []).slice(0, 3).join(', ');
      visualSpecSection = `\n## PRD 视觉规格（必须遵循）\n` +
        `- 主风格: ${visualSpec.primaryStyle || '未指定'}\n` +
        `- 色彩方案: 主色调=${visualSpec.colorPalette?.dominant || '未指定'}, 强调色=${visualSpec.colorPalette?.accent || '未指定'}, 情绪=${visualSpec.colorPalette?.mood || '未指定'}\n` +
        `- 光照方向: ${visualSpec.lightingDirection || '未指定'}\n` +
        `- 镜头语言: ${visualSpec.cameraLanguage || '未指定'}\n` +
        `- 质感等级: ${visualSpec.textureQuality || '未指定'}\n` +
        (refs ? `- 视觉参考: ${refs}\n` : '') +
        (visualSpec.specialVisualEffects?.length ? `- 特效需求: ${visualSpec.specialVisualEffects.join(', ')}\n` : '');
    }

    // 【2026-07-17 camera-coherence】注入全片运镜编排指导
    let choreographyGuide = '';
    try {
      const { buildGlobalChoreographyGuide } = require('../../../../systems/camera-coherence');
      choreographyGuide = '\n' + buildGlobalChoreographyGuide(this._allShots || shots) + '\n';
    } catch (e) { /* 库缺失不影响主流程 */ }

    return `## 镜头信息 (${shots.length}个)
${shotsInfo}
${batchHint}${choreographyGuide}${visualSpecSection}

## 任务
为每个镜头设计:
1. camera: {shot_size, movement, angle, lens, speed}
 - shot_size 从七级中选择: ELS/LS/FS/MS/MCU/CU/ECU，选择必须遵守上方编排指导的景别节奏
 - movement 必须有叙事动机（角色动→跟；揭示→推；情绪外化→手持；客观陈述→固定）
2. cameraString: 运镜描述文本（20-30字，动态描述）
3. lighting: {key_light, fill_light, time_of_day, atmosphere}
4. lightingString: 灯光场景化描述（20-30字）
5. composition: 构图方案（景别+主体位置+线条引导+留白，40-50字）
6. color_palette: 色彩方案（主色调+辅助色+肤色+饱和度+对比度，40-50字）
7. depth_of_field: 景深方案（焦点+光圈+前景背景虚化，40-50字）
8. timeline: 运镜时间轴（3-4段，根据台词节奏设计，每段含时间范围、运镜动作、画面目的）
 - 相邻镜头 timeline 的末段（落幅）状态需考虑与下一镜起幅的衔接

原则: 运镜服务叙事,构图服务情绪,色彩服务情绪,景深服务景别,时间轴动态切分${visualSpec ? '\n【强制】以上设计方案必须严格遵循 PRD 视觉规格中的风格、色彩、光照和镜头语言要求。' : ''}

【摄影心法——给每个镜头一个人格】
1. 运镜即情绪：克制=固定或极缓慢推；凝重=手持呼吸感微晃；决绝=极端特写紧贴主体不放；释放=先扬后落（大场面→大特写收束）。先问'这镜是什么情绪'，再问'什么运镜'。
2. 高潮镜头特权：全片情绪峰值的那颗镜头，给最长的凝视（extreme close_up + 最小移动），让观众无处可逃地盯着那个动作。
3. 构图的'空'是一种表达：师徒之间的空距、留白的天空——压抑与喘息都靠'不填满'来传递。每镜回答：本镜的空在哪里？
4. timeline 切分跟着情绪转折走，不按秒数均分：转折发生在哪一秒，段就切在哪一秒。
5. lightingString 必须含：真实光源名+色温K值+方向+光比（如4:1低调/1.5:1高调），光比即情绪烈度。
6. 首尾呼应检查：结尾镜头的景别/构图是否与开头形成呼应或对撞（开场大全景悬念→结尾大特写收束）？
输出JSON: {"shots": [{"shotId":"...","camera":{},"cameraString":"...","lighting":{},"lightingString":"...","composition":"...","color_palette":"...","depth_of_field":"...","timeline":[]}]};`;
  }

  /**
   * 降级处理（保持与 v2.1.7 一致）
   */
  _fallback(shots) {
    console.log(`[VisualLanguageAgent] 使用降级规则...`);
    return {
      shots: shots.map(shot => ({
        ...shot,
        shotId: shot.shotId,
        camera: shot.camera || {
          shot_size: 'medium',
          movement: 'static',
          angle: 'eye_level',
          lens: '35mm',
          speed: 'normal'
        },
        cameraString: shot.cameraString || '中景静态镜头，35mm焦段，平视角度，平稳拍摄',
        lighting: shot.lighting || {
          key_light: '柔和顶光',
          fill_light: '自然补光',
          time_of_day: '白天',
          atmosphere: '自然明亮'
        },
        lightingString: shot.lightingString || '柔和顶光照明，自然补光填充，白天室内明亮氛围',
        composition: shot.composition || '景别：中景（膝上）；主体位置：画面黄金分割点右侧；线条引导：纵深层次；画框边缘：适度留白，呼吸空间充足',
        color_palette: shot.color_palette || '主色调：自然偏暖；辅助色：环境本色；肤色：自然健康；饱和度：中等自然；对比度：中高清晰',
        depth_of_field: shot.depth_of_field || '焦点：主体面部或动作中心；景深：中等（f/4），背景适度虚化；前景：轻微虚化增加层次；层次：前景-中景-背景三层分离',
        timeline: shot.timeline || [
          { segment: 1, timeRange: '0s-3s', cameraMovement: '镜头稳定，角色入画', shotType: 'wide', purpose: '建立场景' },
          { segment: 2, timeRange: '3s-6s', cameraMovement: '保持构图，角色开始动作', shotType: 'medium', purpose: '推进叙事' }
        ]
      }))
    };
  }

  _sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
}

module.exports = { VisualLanguageAgent };
