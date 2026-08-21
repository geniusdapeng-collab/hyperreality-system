/**
 * P1-6 + P1-7 合并模块：世界观相关性过滤 + 场景主数据管理
 * 
 * P1-6: 世界观分层注入，相关性过滤，减少重复
 * P1-7: 场景枚举表，主数据管理，数据一致性
 * 
 * @version v1.0
 * @author 小G
 */

class WorldviewAndSceneManager {
  constructor(options = {}) {
    this.mode = options.mode || 'nirath';
    
    // ===== P1-6: 世界观分层知识库 =====
    this.worldviewLayers = {
      // Layer-Global: 仅在Opening/首镜注入（一次性）
      global: {
        items: [
          'Nirath is Earth\'s predecessor planet',
          '20亿年前小行星撞击导致地质重构',
          'dual-star system with rose-gold light',
          'bioluminescent ecosystem evolved independently'
        ],
        injectRule: 'first-shot-only',
        relevanceScore: 0.3  // 低相关（通用背景）
      },
      // Layer-Scene: 场景首次出现时注入
      scene: {
        items: [
          '钩吾山: 远古火山活动形成的黑曜石山峰',
          '青丘灵原: 孢子生物播撒种子的草原',
          '钟山之巅: 热液喷口创造赤红光芒',
          '银色湖泊: 重金属沉积形成的液态汞表面'
        ],
        injectRule: 'scene-first-appearance',
        relevanceScore: 0.7  // 中高相关（场景专属）
      },
      // Layer-Shot: 镜头级动态注入（仅当内容相关时）
      shot: {
        items: [
          '双恒星光照: 5800K warm + 6500K cool creating layered shadows',
          '孢子发光: microscopic organisms producing ambient glow',
          '磁丝藤蔓: metallic-organic hybrid plant structures',
          '液态汞: reflective surface properties'
        ],
        injectRule: 'content-relevant-only',
        relevanceScore: 0.9  // 高相关（直接影响画面）
      }
    };
    
    // 场景→世界观相关性映射
    this.sceneWorldviewRelevance = {
      '钩吾山': ['钩吾山: 黑曜石山峰', '双恒星光照', '磁丝藤蔓'],
      '青丘灵原': ['青丘灵原: 草原', '孢子发光', '双恒星光照'],
      '钟山之巅': ['钟山之巅: 热液喷口', '双恒星光照'],
      '银色湖泊': ['银色湖泊: 液态汞', '双恒星光照', '孢子发光'],
      '建木林': ['磁丝藤蔓', '孢子发光', '双恒星光照'],
      '不周山脉': ['双恒星光照', '磁丝藤蔓']
    };
    
    // 已注入跟踪（防止重复）
    this.injectedGlobal = false;
    this.injectedScenes = new Set();
    
    // ===== P1-7: 场景主数据 =====
    this.sceneMasterData = {
      'gouwu_mountain': {
        displayName: '钩吾山',
        englishName: 'Gouwu Mountain',
        type: 'mountain',
        lightingPreset: 'dual-star-obsidian',
        environmentTags: ['obsidian', 'volcanic', 'bioluminescent-veins', 'magnetic-silk-trees'],
        colorPalette: ['#1a1a2e', '#16213e', '#e94560', '#0f3460'],
        atmosphere: 'mysterious-ominous',
        defaultShotType: 'wide-establishing',
        lore: 'Ancient volcanic peaks where taotie dwells'
      },
      'qingqiu_plains': {
        displayName: '青丘灵原',
        englishName: 'Qingqiu Spirit Plains',
        type: 'plains',
        lightingPreset: 'soft-diffused-spore',
        environmentTags: ['jade-grass', 'floating-spores', 'gentle-bioluminescence'],
        colorPalette: ['#2d6a4f', '#40916c', '#52b788', '#74c69d'],
        atmosphere: 'peaceful-ethereal',
        defaultShotType: 'wide-panoramic',
        lore: 'Sacred grasslands where spirit beasts roam'
      },
      'zhongshan_peak': {
        displayName: '钟山之巅',
        englishName: 'Zhongshan Peak',
        type: 'volcanic',
        lightingPreset: 'thermal-crimson',
        environmentTags: ['magma-flows', 'thermal-vents', 'crimson-light'],
        colorPalette: ['#8b0000', '#cd5c5c', '#ff4500', '#4a0000'],
        atmosphere: 'intense-dangerous',
        defaultShotType: 'dramatic-reveal',
        lore: 'Volcanic crater home of the candle dragon'
      },
      'silver_lake': {
        displayName: '银色湖泊',
        englishName: 'Silver Lake',
        type: 'lake',
        lightingPreset: 'mirror-reflective',
        environmentTags: ['liquid-mercury', 'mirror-surface', 'heavy-metal-deposits'],
        colorPalette: ['#c0c0c0', '#e8e8e8', '#a8a8a8', '#d3d3d3'],
        atmosphere: 'mystical-reflective',
        defaultShotType: 'serene-mirror',
        lore: 'Ancient mercury lake with reflective properties'
      },
      'jianmu_forest': {
        displayName: '建木林',
        englishName: 'Jianmu Forest',
        type: 'forest',
        lightingPreset: 'canopy-dappled',
        environmentTags: ['bio-mechanical-trees', 'copper-lichen', 'spore-filaments'],
        colorPalette: ['#2f4f4f', '#556b2f', '#8fbc8f', '#6b8e23'],
        atmosphere: 'ancient-mechanical',
        defaultShotType: 'towering-lookup',
        lore: 'Forest of bio-mechanical world trees'
      }
    };
    
    // 场景别名映射（解决"不周山脉"vs"钩吾山"矛盾）
    this.sceneAliases = {
      '钩吾山': 'gouwu_mountain',
      'gouwu': 'gouwu_mountain',
      '不周山脉': 'gouwu_mountain',  // 数据一致化
      '不周山': 'gouwu_mountain',
      '青丘': 'qingqiu_plains',
      '青丘灵原': 'qingqiu_plains',
      'qingqiu': 'qingqiu_plains',
      '钟山': 'zhongshan_peak',
      'zhongshan': 'zhongshan_peak',
      '银色湖泊': 'silver_lake',
      'silver_lake': 'silver_lake',
      '建木': 'jianmu_forest',
      'jianmu': 'jianmu_forest'
    };
  }

  /**
   * P1-6: 获取当前镜头应注入的世界观内容
   * @param {Object} shotContext - 镜头上下文
   * @returns {Object} { global, scene, shot, totalChars }
   */
  getWorldviewInjection(shotContext) {
    const { sceneName, shotIndex, isOpening, sceneFirstAppearance } = shotContext;
    
    const result = {
      global: [],
      scene: [],
      shot: [],
      totalChars: 0,
      injectLog: []
    };
    
    // Layer-Global: 仅首镜
    if ((isOpening || shotIndex === 0) && !this.injectedGlobal) {
      result.global = this.worldviewLayers.global.items.slice(0, 2); // 最多2条
      this.injectedGlobal = true;
      result.injectLog.push('global: 首镜注入');
    }
    
    // Layer-Scene: 场景首次出现
    const sceneId = this.resolveSceneId(sceneName);
    if (sceneFirstAppearance && !this.injectedScenes.has(sceneId)) {
      const sceneItems = this._getSceneWorldview(sceneId);
      result.scene = sceneItems.slice(0, 1); // 最多1条
      this.injectedScenes.add(sceneId);
      result.injectLog.push(`scene: ${sceneId} 首次注入`);
    }
    
    // Layer-Shot: 内容相关动态注入
    const shotItems = this._getShotRelevantWorldview(sceneId, shotContext);
    result.shot = shotItems.slice(0, 2); // 最多2条
    if (shotItems.length > 0) {
      result.injectLog.push(`shot: ${shotItems.length}条相关注入`);
    }
    
    // 计算总字符
    result.totalChars = [
      ...result.global,
      ...result.scene,
      ...result.shot
    ].join(', ').length;
    
    return result;
  }

  /**
   * P1-6: 重置注入状态（新Episode开始时调用）
   */
  resetInjectionState() {
    this.injectedGlobal = false;
    this.injectedScenes.clear();
  }

  /**
   * P1-7: 解析场景ID（统一别名）
   * @param {string} sceneName - 场景名（可能含别名）
   * @returns {string} 标准化的scene_id
   */
  resolveSceneId(sceneName) {
    if (!sceneName) return 'unknown';
    
    const normalized = sceneName.trim();
    
    // 直接匹配
    if (this.sceneAliases[normalized]) {
      return this.sceneAliases[normalized];
    }
    
    // 模糊匹配（简化版）
    for (const [alias, id] of Object.entries(this.sceneAliases)) {
      if (normalized.includes(alias) || alias.includes(normalized)) {
        return id;
      }
    }
    
    // 英文直接匹配
    const lower = normalized.toLowerCase().replace(/\s+/g, '_');
    if (this.sceneMasterData[lower]) return lower;
    
    return 'unknown';
  }

  /**
   * P1-7: 获取场景主数据
   * @param {string} sceneId - 场景ID
   * @returns {Object} 场景完整数据
   */
  getSceneData(sceneId) {
    const resolvedId = this.resolveSceneId(sceneId);
    return this.sceneMasterData[resolvedId] || null;
  }

  /**
   * P1-7: 获取场景视觉核心描述
   * 用于Tier-1场景描述生成
   * v6.5.31-fix: 增加 mode 参数，防止 Nirath 元素泄漏到 generic 模式
   */
  getSceneVisualCore(sceneId, options = {}) {
    const mode = options.mode || this.mode || 'generic';
    const data = this.getSceneData(sceneId);
    
    // generic/social 模式：返回真实场景描述
    if (mode === 'generic' || mode === 'social') {
      if (!data) return `${sceneId}, realistic scene`;
      
      // 过滤掉 Nirath 科幻关键词
      const nirathKeywords = ['发光毯', '磁场脉动', '矿物结晶', '异星', '双恒星', 
                            '外星', '原始单细胞', 'Nirath', '磁场', '脉动', '孢子', '菌丝'];
      
      const displayName = data.displayName || '';
      const envTags = (data.environmentTags || []).slice(0, 3);
      
      // 检查是否包含 Nirath 关键词
      const allText = `${displayName} ${envTags.join(' ')}`;
      const hasNirath = nirathKeywords.some(kw => allText.includes(kw));
      
      if (hasNirath) {
        console.warn(`[WorldviewSceneManager] ${mode} 模式检测到 Nirath 关键词，使用 fallback: "${allText}"`);
        return `${sceneId}, realistic scene`;
      }
      
      const parts = [displayName, ...envTags];
      return parts.join(', ');
    }
    
    // Nirath 模式：返回科幻场景描述
    if (!data) return `${sceneId}, Nirath alien landscape`;
    
    const parts = [
      data.displayName,
      data.environmentTags.slice(0, 3).join(', ')
    ];
    
    return parts.join(', ');
  }

  /**
   * P1-7: 获取场景光照预设
   */
  getSceneLighting(sceneId) {
    const data = this.getSceneData(sceneId);
    if (!data) return '电影级光影';
    
    const presetMap = {
      'dual-star-obsidian': 'dual-starlight casting warm gold and cool silver on obsidian',
      'soft-diffused-spore': 'soft diffused light from gentle bioluminescent spores',
      'thermal-crimson': 'crimson-amber lighting from thermal vents and magma',
      'mirror-reflective': 'reflected dual-starlight on mirror-like mercury surface',
      'canopy-dappled': 'dappled dual-starlight filtering through towering canopy'
    };
    
    return presetMap[data.lightingPreset] || '电影级光影';
  }

  /**
   * P1-7: 验证场景数据一致性
   * 检查是否存在矛盾定义
   */
  validateSceneConsistency(sceneId) {
    const data = this.getSceneData(sceneId);
    if (!data) return { valid: false, error: 'Scene not found' };
    
    const issues = [];
    
    // 检查1: 中英文名称对应
    if (!data.displayName || !data.englishName) {
      issues.push('Missing display or English name');
    }
    
    // 检查2: 环境标签非空
    if (!data.environmentTags || data.environmentTags.length === 0) {
      issues.push('No environment tags');
    }
    
    // 检查3: 色板完整
    if (!data.colorPalette || data.colorPalette.length < 3) {
      issues.push('Incomplete color palette');
    }
    
    // 检查4: 光照预设有效
    const validPresets = ['dual-star-obsidian', 'soft-diffused-spore', 'thermal-crimson', 'mirror-reflective', 'canopy-dappled'];
    if (!validPresets.includes(data.lightingPreset)) {
      issues.push(`Unknown lighting preset: ${data.lightingPreset}`);
    }
    
    return {
      valid: issues.length === 0,
      sceneId: this.resolveSceneId(sceneId),
      issues: issues.length > 0 ? issues : null,
      issueCount: issues.length
    };
  }

  // ===== 内部辅助方法 =====
  
  _getSceneWorldview(sceneId) {
    const items = this.worldviewLayers.scene.items;
    return items.filter(item => {
      const itemLower = item.toLowerCase();
      const sceneData = this.getSceneData(sceneId);
      if (!sceneData) return false;
      return itemLower.includes(sceneData.displayName) || 
             itemLower.includes(sceneData.englishName.toLowerCase());
    });
  }
  
  _getShotRelevantWorldview(sceneId, shotContext) {
    const relevance = this.sceneWorldviewRelevance;
    const sceneName = this.getSceneData(sceneId)?.displayName || sceneId;
    
    const relevantItems = relevance[sceneName] || [];
    
    // 根据镜头内容进一步过滤
    const shotLower = JSON.stringify(shotContext).toLowerCase();
    return relevantItems.filter(item => {
      // 如果镜头内容明确提到相关元素，则注入
      const keywords = item.toLowerCase().split(/[\s:]+/).filter(w => w.length > 3);
      return keywords.some(kw => shotLower.includes(kw));
    });
  }
}

module.exports = { WorldviewAndSceneManager };
