/**
 * 规则降级引擎 (Rule Fallback Engine)
 * 
 * 职责：
 * - LLM 禁用时的规则模式生产路径
 * - LLM 失败时的兜底恢复
 * - 极简 Prompt 拼接
 */

class RuleFallbackEngine {
  constructor(options = {}) {
    this.log = options.logFn || console.log;
    this.config = options.config || { maxPromptLength: 2000 };
    this.agents = options.agents || {};
    this.llmModel = options.llmModel || 'kimi-k2p6';
  }

  /**
   * 规则模式完整生产路径(LLM 禁用时)
   */
  async produceViaRules(currentShots, adaptedBlueprint, result, startTime) {
    this.log('RULES', '启用规则引擎模式(LLM 已禁用)');
    
    // 这些需要在 ProductionEngine 中执行，这里返回标记让调用方处理
    return {
      mode: 'rules',
      shots: currentShots,
      needsQualityGate: true,
      needsOpening: this._shouldGenerateOpening(adaptedBlueprint),
      needsContinuity: true
    };
  }

  /**
   * 规则 Prompt 工程兜底(LLM PromptFusion 失败时)
   */
  async engineerPromptsFallback(shots, blueprint) {
    if (typeof this._engineerPrompts === 'function') {
      try {
        const r = await this._engineerPrompts(shots, blueprint);
        if (r?.shots?.length) return r.shots;
      } catch (e) {
        this.log('FALLBACK', `_engineerPrompts 失败: ${e.message},使用极简拼接`);
      }
    }
    return shots.map(s => ({
      ...s,
      prompt: this.assemblePromptSimple(s),
      enhanced_prompt: this.assemblePromptSimple(s),
      negative_prompt: 'blurry, low quality, distorted, watermark, text, deformed, extra limbs'
    }));
  }

  /**
   * 极简 Prompt 拼接(最后兜底)
   * 【v2.1.4-fix9-P12】兜底路径也强制写实场景和动作
   */
  assemblePromptSimple(shot) {
    const parts = [];
    
    // 场景强制写实检查
    let sceneDesc = shot.scene || '';
    const sceneForbidden = ['全息', '虚拟', '投影', '抽象', '光影场域', '数据空间', '元宇宙', '时间操控', '霓虹', '微观世界', '宏观', '抽象几何', '流动光影', '交织光影', '色彩对冲'];
    if (sceneForbidden.some(w => sceneDesc.includes(w))) {
      const fallbackScenes = [
        '医院健康宣教室，白色荧光灯均匀照明，白墙面贴有无文字骨骼肌解剖图与运动损伤海报（纯图形版），木质讲台表面带有细微使用划痕，地面浅灰色防滑PVC地胶',
        '三甲医院检验科走廊，冷白色LED光源从走廊顶部连续排列向下照射，无文字箭头标识牌指向尿液检验窗口，地面浅色抛光瓷砖，墙面白色医用抗菌涂层',
        '医生诊室，白色墙面悬挂无文字人体解剖示意图（纯图形版），办公桌摆放听诊器与血压计，检查床铺有蓝色一次性床单，无影灯悬于上方，窗光透入',
        '医院健康管理中心，嵌入式LED灯带洒下柔和暖白光，接待台后方排列无文字健康宣传展板（纯图形版），前方皮质沙发与实木茶几，地面灰色哑光瓷砖'
      ];
      const idx = parseInt(shot.shotId?.replace(/\D/g, '') || '0') || 0;
      sceneDesc = fallbackScenes[idx % fallbackScenes.length];
    }
    if (sceneDesc) parts.push(sceneDesc);
    
    if (shot.visual_elements) parts.push(shot.visual_elements);
    if (shot.lighting) parts.push(shot.lighting);
    if (shot.camera_movement) parts.push(shot.camera_movement);
    
    // 动作强制写实检查
    let actionDesc = shot.action || '';
    const actionForbidden = ['全息', '虚拟', '投影', '空间扭曲', '时间残影', '霓虹', '数据流', '光即角色', '抽象构图', '梦境流动性', '手绘动画', '湿版摄影', '黑色电影'];
    if (actionForbidden.some(w => actionDesc.includes(w))) {
      const fallbackActions = [
        '镜头缓慢推近，示例角色站立讲台前，自然手势讲解，眼神注视镜头，警服在荧光灯下轮廓清晰',
        '稳定机位中景，示例角色沿走廊缓步前行，侧头指向检验窗口，白大褂医生从背景走过',
        '手持微晃跟拍，示例角色靠近检查床，手指轻触医学挂图，无影灯在头顶形成柔和光晕',
        '固定机位中景，示例角色坐于沙发边缘，双手交叠置于膝上，LED灯带在身后形成均匀轮廓光',
        '缓慢后拉全景，示例角色站立检验窗口前，转身面向镜头，不锈钢台面反射冷白色光源'
      ];
      const idx = parseInt(shot.shotId?.replace(/\D/g, '') || '0') || 0;
      actionDesc = fallbackActions[idx % fallbackActions.length];
    }
    if (actionDesc) parts.push(actionDesc);
    
    if (shot.mood) parts.push(`atmosphere: ${shot.mood}`);
    
    // v6.6.10-fix: 极简路径使用全局模块，区分片头/内容镜
    const globalNegativePromptInjector = require('../../prompt-negative');
    const isOpeningSimple = shot.type === 'opening' || shot.sceneType === 'opening';
    const negativeSimple = isOpeningSimple
      ? globalNegativePromptInjector.generateForOpeningShot({ maxLength: 200 }).replace('【负面约束】', '')
      : globalNegativePromptInjector.generateForContentShot({ maxLength: 250 }).replace('【负面约束】', '');
    parts.push(negativeSimple);
    
    return parts.filter(Boolean).join(', ').slice(0, this.config.maxPromptLength);
  }

  _shouldGenerateOpening(adaptedBlueprint) {
    const _meta = adaptedBlueprint.config?._metadata || adaptedBlueprint._metadata || {};
    return _meta.isSeries ? (_meta.episodeNumber === 1) : (_meta.hasOpening !== false);
  }
}

module.exports = { RuleFallbackEngine };
