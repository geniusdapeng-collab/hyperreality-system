/**
 * 【v6.2-patch51】主角主动性自动注入器
 * ProactiveProtagonistInjector
 * 
 * v6.5.34-fix: 全局禁用narration，只注入visualPrompt/prompt，不再污染narration
 * 
 * 产品机制：在故事板生成后、Prompt构建前，自动检测并注入主角主动动作。
 * 解决五要素「小G冒险主动性不足」的系统性问题。
 * 
 * 挂载点：NirathMasterPipeline Stage 7之后（故事板校验后）
 * 
 * 核心逻辑：
 * 1. 扫描故事板中主角（默认xiaoG）的所有镜头
 * 2. 检测被动描述关键词（旁观/注视/后退等）
 * 3. 自动替换/追加主动动作描述（主动接近/伸出手/直视等）
 * 4. 确保每镜至少有1个主动动作，关键镜有2个
 * 5. ⚠️ v6.5.34: 只注入visualPrompt/prompt，绝不注入narration（已全局禁用）
 */

class ProactiveProtagonistInjector {
  constructor(config = {}) {
    this.config = {
      protagonistId: config.protagonistId || 'xiaoG',
      protagonistName: config.protagonistName || '小G',
      // 主动性动作词库（按优先级排序）
      initiativeActions: [
        // 核心主动动作（高权重，优先注入）
        '主动向前迈出一步', '主动伸出手', '直视对方眼睛', '主动靠近',
        '不退缩', '不逃避', '迎上去', '坚定地走向',
        '主动选择', '做出决定', '主动触碰', '主动沟通',
        // 探索类
        '主动探索', '仔细观察', '小心接近', '试探性地伸手',
        // 勇气类
        '鼓起勇气', '深吸一口气', '挺直腰杆', '抬起头',
        // 回应类
        '主动回应', '点头示意', '伸出手掌', '张开双臂'
      ],
      // 被动描述关键词（需要被替换或对冲）
      passivePatterns: [
        '旁观', '远远看着', '站着看', '不敢动', '僵在原地',
        '退缩', '后退', '犹豫', '等待', '被动',
        '不知所措', '一动不动', '只是看着', '默默注视'
      ],
      // 每镜最少主动动作数
      minInitiativesPerShot: 1,
      // 关键镜（开场、高潮、结尾）最少主动动作数
      minInitiativesForKeyShots: 2,
      // 关键镜类型
      keyShotTypes: ['opening', 'climax', 'closing', 'hook', 'twist', 'resolution'],
      // v6.5.34-fix: 全局禁用narration，只注入visualPrompt或prompt，绝不注入narration
      injectTargets: ['visualPrompt', 'prompt'],
      // 最大注入次数（避免过度）
      maxInjectionsPerShot: 2,
      ...config
    };
    
    this.injectionLog = [];
  }

  /**
   * 主入口：注入主动性
   * @param {Object} storyboard - 故事板对象
   * @param {Object} options - 配置选项
   * @returns {Object} 注入后的故事板 + 报告
   */
  inject(storyboard, options = {}) {
    const shots = storyboard.shots || [];
    const protagonistId = options.protagonistId || this.config.protagonistId;
    const protagonistName = options.protagonistName || this.config.protagonistName;
    
    this.injectionLog = [];
    let totalInjections = 0;
    let passiveDetections = 0;
    
    for (const shot of shots) {
      // 跳过片头
      if (shot.isOpening || shot.type === 'opening') continue;
      
      // 检查镜头是否包含主角
      const hasProtagonist = this.shotHasProtagonist(shot, protagonistId, protagonistName);
      if (!hasProtagonist) continue;
      
      // 检测当前主动性水平
      const initiativeLevel = this.detectInitiativeLevel(shot);
      const isKeyShot = this.config.keyShotTypes.includes(shot.type);
      const requiredMin = isKeyShot ? this.config.minInitiativesForKeyShots : this.config.minInitiativesPerShot;
      
      // 如果主动性不足，进行注入
      if (initiativeLevel.count < requiredMin) {
        const injectionsNeeded = Math.min(
          requiredMin - initiativeLevel.count,
          this.config.maxInjectionsPerShot
        );
        
        for (let i = 0; i < injectionsNeeded; i++) {
          const action = this.selectInitiativeAction(shot, initiativeLevel.foundKeywords);
          const target = this.selectInjectTarget(shot);
          const result = this.injectAction(shot, target, action, protagonistName);
          
          if (result.success) {
            totalInjections++;
            this.injectionLog.push({
              shotId: shot.id,
              action: action,
              target: target,
              position: result.position,
              before: result.before?.substring(0, 80),
              after: result.after?.substring(0, 80)
            });
          }
        }
      }
      
      // 检测被动描述
      const passiveCount = this.detectPassivePatterns(shot);
      if (passiveCount > 0) {
        passiveDetections += passiveCount;
        // 对冲被动描述：额外注入1个主动动作
        if (initiativeLevel.count < this.config.maxInjectionsPerShot) {
          const action = this.selectInitiativeAction(shot, initiativeLevel.foundKeywords, true);
          const target = this.selectInjectTarget(shot);
          const result = this.injectAction(shot, target, action, protagonistName);
          if (result.success) {
            totalInjections++;
            this.injectionLog.push({
              shotId: shot.id,
              action: action,
              target: target,
              position: result.position,
              note: '被动描述对冲'
            });
          }
        }
      }
    }
    
    return {
      storyboard,
      report: {
        totalShots: shots.length,
        protagonistShots: shots.filter(s => this.shotHasProtagonist(s, protagonistId, protagonistName)).length,
        totalInjections,
        passiveDetections,
        injections: this.injectionLog,
        success: totalInjections > 0 || passiveDetections === 0
      }
    };
  }

  /**
   * 检测镜头是否包含主角
   */
  shotHasProtagonist(shot, protagonistId, protagonistName) {
    const text = JSON.stringify(shot).toLowerCase();
    const idMatch = text.includes(protagonistId.toLowerCase());
    const nameMatch = text.includes(protagonistName);
    const charList = (shot.characters || []).some(
      c => c.toLowerCase() === protagonistId.toLowerCase() || 
           c.toLowerCase() === protagonistName.toLowerCase()
    );
    return idMatch || nameMatch || charList;
  }

  /**
   * v6.5.34-fix: 检测当前主动性水平（排除narration，只检查visualPrompt/prompt）
   */
  detectInitiativeLevel(shot) {
    const texts = [
      shot.visualPrompt || '',
      shot.prompt || ''
    ].join(' ');
    
    let count = 0;
    const foundKeywords = [];
    
    for (const action of this.config.initiativeActions) {
      if (texts.includes(action)) {
        count++;
        foundKeywords.push(action);
      }
    }
    
    return { count, foundKeywords };
  }

  /**
   * v6.5.34-fix: 检测被动描述模式（排除narration）
   */
  detectPassivePatterns(shot) {
    const texts = [
      shot.visualPrompt || '',
      shot.prompt || ''
    ].join(' ');
    
    let count = 0;
    for (const pattern of this.config.passivePatterns) {
      if (texts.includes(pattern)) {
        count++;
      }
    }
    return count;
  }

  /**
   * 选择主动性动作（避免重复）
   */
  selectInitiativeAction(shot, foundKeywords, forceDifferent = false) {
    const available = this.config.initiativeActions.filter(
      a => !foundKeywords.includes(a)
    );
    
    if (available.length === 0) {
      return this.config.initiativeActions[
        Math.floor(Math.random() * this.config.initiativeActions.length)
      ];
    }
    
    // 根据镜头类型选择最合适的动作
    const shotType = shot.type || 'default';
    const typeMatched = available.filter(a => {
      if (['opening', 'hook'].includes(shotType)) return a.includes('迈出') || a.includes('走向');
      if (['climax', 'twist'].includes(shotType)) return a.includes('直视') || a.includes('勇气');
      if (['closing', 'resolution'].includes(shotType)) return a.includes('触碰') || a.includes('回应');
      return true;
    });
    
    const pool = typeMatched.length > 0 ? typeMatched : available;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  /**
   * v6.5.34-fix: 全局禁用narration，只注入visualPrompt或prompt
   * 选择注入目标字段（优先visualPrompt > prompt）
   */
  selectInjectTarget(shot) {
    // v6.5.34: 排除narration，只选visualPrompt或prompt
    if (shot.visualPrompt && shot.visualPrompt.length < 800) return 'visualPrompt';
    return 'prompt';
  }

  /**
   * 执行注入
   */
  injectAction(shot, target, action, protagonistName) {
    const original = shot[target] || '';
    if (!original) {
      return { success: false, reason: 'target字段为空' };
    }
    
    // 如果已经包含这个动作，跳过
    if (original.includes(action)) {
      return { success: false, reason: '已存在该动作' };
    }
    
    // 在合适的位置插入
    // 策略：在主角名字后面插入，或在句首/句末
    let modified = original;
    let position = 'append';
    
    // 尝试在主角名字后插入
    const nameIndex = original.indexOf(protagonistName);
    if (nameIndex >= 0 && nameIndex < original.length - 10) {
      // 在主角名字后找到下一个标点或空格
      const afterName = original.substring(nameIndex + protagonistName.length);
      const punctMatch = afterName.match(/[，,。.;；]/);
      if (punctMatch) {
        const insertPos = nameIndex + protagonistName.length + punctMatch.index + 1;
        modified = original.substring(0, insertPos) + action + '，' + original.substring(insertPos);
        position = `after_${protagonistName}`;
      } else {
        modified = original + '，' + action;
        position = 'append';
      }
    } else {
      // 默认追加到末尾
      modified = original + '，' + action;
      position = 'append';
    }
    
    shot[target] = modified;
    
    return {
      success: true,
      position,
      before: original,
      after: modified
    };
  }
}

module.exports = { ProactiveProtagonistInjector };
