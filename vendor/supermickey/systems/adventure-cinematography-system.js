/**
 * 冒险感运镜系统 v1.0
 * Adventure Cinematography System
 * 
 * 功能：为山海经视频注入冒险感运镜方案
 * 核心能力：
 * - 主动镜头：小G主观视角、跟拍、肩后视角
 * - 探索运镜：推近未知、环绕发现、穿越障碍
 * - 互动镜头：对话环绕、反应特写、双角色构图
 * - 魔幻揭示：能力绽放、形体变化、共鸣时刻
 * 
 * 注入点：camera-movement-system-v3.js（增强现有运镜库）
 */

class AdventureCinematographySystem {
  constructor(config = {}) {
    this.config = {
      // 冒险感强度（0-1）
      intensity: config.intensity ?? 0.7,
      // 默认小G角色ID
      protagonistId: config.protagonistId || 'xiaoG',
      // 异兽角色ID
      beastId: config.beastId || null,
      ...config
    };
  }

  /**
   * 主入口：为故事板生成冒险感运镜方案
   * @param {Array} shots - 故事板镜头数组
   * @param {Object} options - 场景配置
   * @returns {Array} 增强后的shots（添加adventureCamera字段）
   */
  enhanceShots(shots, options = {}) {
    const enhanced = shots.map((shot, index) => {
      const adventureCamera = this.generateAdventureCamera(shot, index, shots.length, options);
      return {
        ...shot,
        adventureCamera,
        // 如果主运镜为空，用冒险运镜填充
        camera: shot.camera || adventureCamera.primary,
        cameraMovement: shot.cameraMovement || adventureCamera.movement
      };
    });
    
    return enhanced;
  }

  /**
   * 根据镜头类型生成冒险感运镜
   */
  generateAdventureCamera(shot, index, totalShots, options) {
    const shotType = shot.type || 'standard';
    const tension = shot.tension || 0;
    const isOpening = index === 0;
    const isClimax = index === totalShots - 1 || shotType === 'climax' || tension > 80;
    const isInteraction = shotType === 'interaction' || shotType === 'dialogue';
    const isDiscovery = shotType === 'discovery' || shotType === 'reveal';
    
    // 选择运镜策略
    if (isOpening) {
      return this.generateOpeningCamera(shot, options);
    } else if (isClimax) {
      return this.generateClimaxCamera(shot, options);
    } else if (isInteraction) {
      return this.generateInteractionCamera(shot, options);
    } else if (isDiscovery) {
      return this.generateDiscoveryCamera(shot, options);
    } else {
      return this.generateExplorationCamera(shot, index, totalShots, options);
    }
  }

  // ====== 四类冒险运镜方案 ======

  /**
   * 开场镜头：主动建立
   * 小G主动走向未知，观众跟随
   */
  generateOpeningCamera(shot, options) {
    const protagonist = options.protagonistName || '小G';
    const habitat = options.habitat || '紫晶山脉';
    
    return {
      type: 'adventure_opening',
      primary: `肩后跟随视角，${protagonist}主动走向${habitat}深处，观众与${protagonist}同行，探索未知的Nirath世界`,
      movement: '缓慢推进 → 轻微上升 → 环境展开',
      shotSize: 'full → medium',
      speed: 'slow_push',
      emotion: '好奇+期待',
      seedanceCue: '肩后视角,主动前行,环境展开,好奇',
      // 具体段式时间轴
      segments: [
        { time: '0-2s', camera: '肩后跟随，缓慢推进', size: 'full', emotion: '同行感' },
        { time: '2-5s', camera: '轻微上升，环境展开', size: 'wide', emotion: '震撼' },
        { time: '5-8s', camera: '锁定主角侧脸，眼神坚定', size: 'medium', emotion: '决心' }
      ],
      // 冒险感标记
      adventureMarkers: ['主动', '探索', '未知', '同行']
    };
  }

  /**
   * 探索镜头：推进未知
   * 逐步揭示异兽栖息地的神秘
   */
  generateExplorationCamera(shot, index, totalShots, options) {
    const protagonist = options.protagonistName || '小G';
    const progress = index / totalShots; // 0-1 故事进度
    
    // 根据进度调整运镜复杂度
    if (progress < 0.3) {
      // 前期：建立环境，渐进揭示
      return {
        type: 'adventure_exploration_early',
        primary: `${protagonist}主观视角，首次探索未知环境，镜头随视线扫过奇特地貌`,
        movement: '缓慢平移 → 轻微推进 → 停留观察',
        shotSize: 'wide → medium',
        speed: 'slow_pan',
        emotion: '好奇+警觉',
        seedanceCue: '主观视角,环境扫描,好奇,警觉',
        segments: [
          { time: '0-2s', camera: '主观视角，环顾环境', size: 'wide', emotion: '进入感' },
          { time: '2-4s', camera: '发现异动，轻微推进', size: 'medium', emotion: '警觉' },
          { time: '4-6s', camera: '锁定异动来源，停留', size: 'close_up', emotion: '聚焦' }
        ],
        adventureMarkers: ['探索', '扫描', '发现', '聚焦']
      };
    } else if (progress < 0.7) {
      // 中期：深入互动，逼近核心
      return {
        type: 'adventure_exploration_mid',
        primary: `跟随${protagonist}穿越障碍，镜头穿越缝隙/绕过遮挡，逼近核心区域`,
        movement: '跟拍穿越 → 障碍绕过 → 核心揭示',
        shotSize: 'medium → close_up',
        speed: 'tracking',
        emotion: '紧张+期待',
        seedanceCue: '跟拍穿越,障碍绕行,逼近,紧张',
        segments: [
          { time: '0-2s', camera: '跟随主角穿越狭窄通道', size: 'full', emotion: '紧张' },
          { time: '2-4s', camera: '绕过障碍物，视野受限', size: 'medium', emotion: '未知' },
          { time: '4-6s', camera: '突破障碍，视野突然展开', size: 'wide', emotion: '震撼揭示' }
        ],
        adventureMarkers: ['穿越', '逼近', '障碍', '揭示']
      };
    } else {
      // 后期：直面核心，终极逼近
      return {
        type: 'adventure_exploration_late',
        primary: `${protagonist}直面异兽核心区域，镜头从低角度仰拍，强调渺小与伟大对比`,
        movement: '低角度仰拍 → 缓慢推进 → 环绕',
        shotSize: 'low_angle → extreme_wide',
        speed: 'slow_orbit',
        emotion: '敬畏+震撼',
        seedanceCue: '低角度仰拍,渺小伟大,敬畏,环绕',
        segments: [
          { time: '0-2s', camera: '低角度仰拍主角', size: 'low_angle', emotion: '渺小' },
          { time: '2-4s', camera: '缓慢推进，主角不后退', size: 'medium', emotion: '勇气' },
          { time: '4-6s', camera: '环绕展示环境宏伟', size: 'extreme_wide', emotion: '敬畏' }
        ],
        adventureMarkers: ['直面', '仰拍', '勇气', '敬畏']
      };
    }
  }

  /**
   * 互动镜头：双角色构图
   * 小G与异兽的情感交流
   */
  generateInteractionCamera(shot, options) {
    const protagonist = options.protagonistName || '小G';
    const beast = options.beastName || '异兽';
    
    return {
      type: 'adventure_interaction',
      primary: `双角色构图，${protagonist}与${beast}首次对视，镜头在两者之间缓慢移动，捕捉微表情`,
      movement: '双人中景 → 说话者特写 → 倾听者反应 → 双人',
      shotSize: 'medium → close_up → close_up → medium',
      speed: 'slow_shift',
      emotion: '试探+好奇',
      seedanceCue: '双角色构图,对视,微表情,试探',
      segments: [
        { time: '0-2s', camera: '双人中景，建立空间关系', size: 'medium', emotion: '对峙' },
        { time: '2-3s', camera: '推向说话者特写', size: 'close_up', emotion: '表达' },
        { time: '3-5s', camera: '切至倾听者反应特写', size: 'close_up', emotion: '反应' },
        { time: '5-6s', camera: '拉回双人，关系确立', size: 'medium', emotion: '连接' }
      ],
      adventureMarkers: ['对视', '微表情', '试探', '连接']
    };
  }

  /**
   * 发现镜头：揭示时刻
   * 异兽独特能力或形态首次展现
   */
  generateDiscoveryCamera(shot, options) {
    const beast = options.beastName || '异兽';
    const ability = options.ability || '独特能力';
    
    return {
      type: 'adventure_discovery',
      primary: `揭示运镜：${beast}${ability}首次展现，从遮挡物后缓慢推出，观众与主角同时发现`,
      movement: '遮挡 → 缓慢推出 → 能力展示 → 定格',
      shotSize: 'hidden → medium → close_up',
      speed: 'slow_reveal',
      emotion: '惊奇+震撼',
      seedanceCue: '揭示运镜,能力展现,惊奇,定格',
      segments: [
        { time: '0-1s', camera: '遮挡物/前景模糊', size: 'hidden', emotion: '未知' },
        { time: '1-3s', camera: '缓慢推出，主体渐显', size: 'medium', emotion: '发现' },
        { time: '3-5s', camera: '能力展现特写', size: 'close_up', emotion: '震撼' },
        { time: '5-6s', camera: '定格，观众消化', size: 'medium', emotion: '敬畏' }
      ],
      adventureMarkers: ['揭示', '发现', '能力', '定格']
    };
  }

  /**
   * 高潮镜头：情感/能力峰值
   */
  generateClimaxCamera(shot, options) {
    const protagonist = options.protagonistName || '小G';
    const beast = options.beastName || '异兽';
    
    return {
      type: 'adventure_climax',
      primary: `高潮复合运镜：${protagonist}与${beast}共鸣时刻，多轴运动+速度变化+景别跳跃，情感最大化`,
      movement: '环绕冻结 → 极速推进 → 定格特写',
      shotSize: 'wide → close_up → extreme_close',
      speed: 'freeze_orbit_fast_push',
      emotion: '终极震撼+温柔',
      seedanceCue: '环绕冻结,极速推进,定格,终极',
      segments: [
        { time: '0-2s', camera: '环绕冻结，时间凝滞', size: 'wide', emotion: '神圣' },
        { time: '2-4s', camera: '极速推向主角面部', size: 'close_up', emotion: '释放' },
        { time: '4-5s', camera: '定格在眼神/触碰特写', size: 'extreme_close', emotion: '永恒' }
      ],
      adventureMarkers: ['共鸣', '冻结', '释放', '永恒']
    };
  }

  // ====== 快捷注入方法 ======

  /**
   * 为单个镜头注入冒险感（用于存量升级）
   */
  injectAdventureToShot(shot, index, total, options) {
    const adventure = this.generateAdventureCamera(shot, index, total, options);
    
    // 合并到现有镜头
    return {
      ...shot,
      adventureCamera: adventure,
      // 智能合并：如果原运镜为空，用冒险运镜；如果原运镜存在，追加冒险标记
      camera: shot.camera || adventure.primary,
      cameraMovement: shot.cameraMovement || adventure.movement,
      // 注入冒险感关键词到prompt
      prompt: this.enhancePromptWithAdventure(shot.prompt || '', adventure.adventureMarkers)
    };
  }

  /**
   * 向Prompt注入冒险感关键词（不破坏原有内容）
   */
  enhancePromptWithAdventure(prompt, markers) {
    if (!prompt || markers.length === 0) return prompt;
    
    // 检查是否已含冒险标记
    const hasAdventure = markers.some(m => prompt.includes(m));
    if (hasAdventure) return prompt; // 已有则不加，避免重复
    
    // 在Prompt末尾追加冒险氛围（技术规格区之前）
    const adventurePhrase = `，${markers.join('、')}的冒险氛围`;
    
    // 找到技术规格区（通常以"UE5""超写实""Cinematic"开头），插入到前面
    const techMarkers = ['UE5', '超写实', 'Cinematic', 'Unreal Engine', '3D渲染'];
    let insertPos = prompt.length;
    for (const tech of techMarkers) {
      const pos = prompt.indexOf(tech);
      if (pos !== -1 && pos < insertPos) {
        insertPos = pos;
      }
    }
    
    return prompt.slice(0, insertPos) + adventurePhrase + prompt.slice(insertPos);
  }

  /**
   * 批量处理：为完整故事板注入冒险感
   */
  processStoryboard(storyboard, options = {}) {
    const shots = storyboard.shots || [];
    const enhanced = this.enhanceShots(shots, {
      protagonistName: options.protagonistName || '小G',
      beastName: options.beastName || storyboard.beast?.name,
      habitat: options.habitat || storyboard.habitat,
      ability: options.ability || storyboard.beast?.abilities?.[0],
      ...options
    });
    
    return {
      ...storyboard,
      shots: enhanced,
      adventureEnhanced: true,
      adventureIntensity: this.config.intensity
    };
  }

  /**
   * 验证冒险感是否充分
   */
  validateAdventure(shots) {
    let adventureScore = 0;
    let issues = [];
    
    // 检查是否有冒险运镜标记
    const hasAdventure = shots.some(s => s.adventureCamera || (s.camera || '').includes('跟随') || (s.camera || '').includes('主观'));
    if (!hasAdventure) {
      issues.push('故事板缺少冒险感运镜，所有镜头均为被动/静态视角');
    }
    
    // 检查小G主动性
    const protagonistActive = shots.some(s => {
      const text = (s.prompt || '') + (s.action || '') + (s.camera || '');
      return ['主动', '走向', '探索', '伸出手', '迈出'].some(kw => text.includes(kw));
    });
    if (!protagonistActive) {
      issues.push('小G全程被动，建议增加主动行动镜头');
    }
    
    // 检查是否有探索递进
    const hasDiscovery = shots.some(s => (s.camera || '').includes('揭示') || (s.camera || '').includes('发现'));
    if (!hasDiscovery) {
      issues.push('缺少发现/揭示类运镜，建议增加异兽能力展现镜头');
    }
    
    return {
      valid: issues.length === 0,
      issues,
      adventureScore: Math.max(0, 100 - issues.length * 30)
    };
  }
}

module.exports = { AdventureCinematographySystem };
