/**
 * 导演风格库 (Director Style Library) v1.0
 * Phase 2: 好莱坞大片导演AI风格档案库挂载
 * 
 * 核心设计：
 * - 提取20位导演的核心视觉标签（2-3个/人），不全部照搬
 * - 设计 Nirath 专属融合风格（卡梅隆生态 + 维伦纽瓦史诗 + 杰克逊奇幻 + 斯皮尔伯格生物出场）
 * - 提供场景类型→导演风格推荐映射
 * - 提供风格一致性检查接口（供导演优化调用）
 * 
 * 参考文档：《好莱坞大片导演AI风格档案库.md》v1.0
 * 提取原则：吸收精华，不照搬全部，结合Nirath世界观定制
 * 
 * @version v1.0 (v6.2-patch69)
 * @author 小G
 */

class DirectorStyleLibrary {
  constructor(options = {}) {
    this.mode = options.mode || 'nirath';
    
    // Nirath 默认融合风格权重
    this.defaultBlend = {
      cameron: 0.35,    // 卡梅隆：异世界生态、生物荧光
      villeneuve: 0.25, // 维伦纽瓦：宏大史诗、极简构图
      jackson: 0.20,    // 杰克逊：奇幻世界、中土生态
      spielberg: 0.20   // 斯皮尔伯格：生物出场、情感优先
    };
    
    // 风格档案库（精简版，每位导演提取2-3个核心标签）
    this.STYLE_ARCHIVE = this._buildStyleArchive();
    
    // 场景类型→导演风格推荐映射
    this.SCENE_STYLE_MAP = this._buildSceneStyleMap();
  }

  /**
   * 构建风格档案库
   * 每位导演仅保留2-3个对Nirath最有价值的核心标签
   */
  _buildStyleArchive() {
    return {
      // ===== Part 1: 科幻/太空史诗 =====
      cameron: {
        name: '詹姆斯·卡梅隆 (James Cameron)',
        films: ['阿凡达', '终结者2', '泰坦尼克号'],
        coreTags: [
          { tag: 'bioluminescent_ecosystem', desc: '生物荧光生态系统', weight: 1.0 },
          { tag: 'imax_epic_scale', desc: 'IMAX史诗尺度+渺小人物对比', weight: 0.9 },
          { tag: 'physical_simulation', desc: '物理仿真驱动的真实感', weight: 0.8 }
        ],
        colorPalette: ['bioluminescent_blue_purple', 'neon_cyan', 'deep_indigo', 'teal_gradient'],
        lighting: ['underwater_caustics', 'volumetric_light_rays', 'subsurface_scattering', 'naturalistic_environmental'],
        composition: ['vast_landscape_tiny_figure', 'strong_z_axis_depth', 'vertical_scale_emphasis'],
        mood: ['immersive_wonder', 'physically_accurate_environment', 'awe_at_natural_forces'],
        nirathRelevance: 5 // ★★★★★
      },
      
      villeneuve: {
        name: '丹尼斯·维伦纽瓦 (Denis Villeneuve)',
        films: ['沙丘', '银翼杀手2049', '降临'],
        coreTags: [
          { tag: 'monumental_scale', desc: '巨物尺度+人类渺小敬畏感', weight: 1.0 },
          { tag: 'minimalist_composition', desc: '极简构图+负空间', weight: 0.9 },
          { tag: 'slow_reveal', desc: '缓慢揭示+克制的视觉叙事', weight: 0.8 }
        ],
        colorPalette: ['desert_orange_ochre', 'cold_blue_techno', 'dust_atmosphere', 'copper_metallic'],
        lighting: ['silhouette_rim_light', 'volumetric_dust_beams', 'practical_sources_only', 'hazy_atmosphere'],
        composition: ['static_monumental_objects', 'symmetrical_frames', 'negative_space_dominant'],
        mood: ['contemplative_unease', 'scale_induced_awe', 'religious_grandeur'],
        nirathRelevance: 5 // ★★★★★
      },
      
      jackson: {
        name: '彼得·杰克逊 (Peter Jackson)',
        films: ['指环王', '霍比特人', '金刚'],
        coreTags: [
          { tag: 'fantasy_world_building', desc: '奇幻世界构建+史诗全景', weight: 1.0 },
          { tag: 'natural_epic_landscape', desc: '自然史诗地貌+微缩模型质感', weight: 0.9 },
          { tag: 'heroic_journey_visuals', desc: '英雄旅程视觉弧线', weight: 0.7 }
        ],
        colorPalette: ['new_zealand_emerald', 'golden_hour_sunset', 'misty_blue_mountain', 'lush_forest_green'],
        lighting: ['magic_hour_glow', 'natural_light_priority', 'atmospheric_perspective'],
        composition: ['aerial_epic_panorama', 'forced_perspective_miniature', 'sweeping_establishing_shots'],
        mood: ['epic_fantasy_wonder', 'heroic_destiny', 'nature_majesty'],
        nirathRelevance: 5 // ★★★★★
      },
      
      spielberg: {
        name: '史蒂文·斯皮尔伯格 (Steven Spielberg)',
        films: ['侏罗纪公园', 'E.T.', '第三类接触'],
        coreTags: [
          { tag: 'creature_reveal_ritual', desc: '生物出场三段式：环境暗示→部分展示→全貌揭示', weight: 1.0 },
          { tag: 'emotional_priority', desc: '情感优先+技术隐形', weight: 0.9 },
          { tag: 'childlike_wonder', desc: '儿童视角+金色怀旧光晕', weight: 0.7 }
        ],
        colorPalette: ['tropical_green_gold', 'stormy_gray_blue', 'warm_amber_nostalgia', 'desaturated_cool_danger'],
        lighting: ['golden_hour_amber', 'soft_warm_key_light', 'practical_sources', 'lens_flare_emotional'],
        composition: ['spielberg_face_reaction', 'child_eye_level_pov', 'partial_creature_reveal', 'clean_spatial_geography'],
        mood: ['childhood_wonder', 'awe_through_empathy', 'suspense_through_restraint'],
        nirathRelevance: 5 // ★★★★★
      },
      
      lucas: {
        name: '乔治·卢卡斯 (George Lucas)',
        films: ['星球大战'],
        coreTags: [
          { tag: 'used_future_aesthetic', desc: '二手未来+磨损做旧质感', weight: 0.8 },
          { tag: 'space_opera_grandeur', desc: '太空歌剧宏大叙事', weight: 0.7 }
        ],
        colorPalette: ['warm_orange_desert', 'cold_steel_blue', 'silver_metallic_patina'],
        lighting: ['practical_panel_lights', 'warm_amber_cockpit', 'volumetric_smoke'],
        composition: ['motion_control_precision', 'clear_spatial_geography', 'cross_cutting_battle'],
        mood: ['epic_space_opera', 'heroic_adventure', 'vintage_film_grain'],
        nirathRelevance: 3 // ★★★☆☆
      },
      
      deltoro: {
        name: '吉尔莫·德尔·托罗 (Guillermo del Toro)',
        films: ['环太平洋', '水形物语', '潘神的迷宫'],
        coreTags: [
          { tag: 'creature_aesthetic', desc: '怪兽美学+生物机械融合', weight: 0.9 },
          { tag: 'dark_fantasy', desc: '黑暗童话质感', weight: 0.7 }
        ],
        colorPalette: ['deep_crimson', 'oceanic_teal', 'gothic_shadow', 'amber_warmth'],
        lighting: ['chiaroscuro_dramatic', 'practical_magic_sources', 'underwater_glow'],
        composition: ['creature_scale_drama', 'ornate_baroque_detail', 'symmetrical_monster_frames'],
        mood: ['dark_fairy_tale', 'romantic_monstrosity', 'melancholic_wonder'],
        nirathRelevance: 4 // ★★★★☆
      },
      
      // v6.6.4-root-fix: 新增纪录片/教育片导演风格
      herzog: {
        name: '沃纳·赫尔佐格 (Werner Herzog)',
        films: ['灰熊人', '在世界尽头相遇', '洞穴中被遗忘的梦'],
        coreTags: [
          { tag: 'contemplative_observation', desc: '沉思式观察+诗意旁白', weight: 1.0 },
          { tag: 'landscape_as_character', desc: '风景即角色+自然力量', weight: 0.9 },
          { tag: 'existential_gaze', desc: '存在主义凝视+人类渺小', weight: 0.8 }
        ],
        colorPalette: ['cold_arctic_blue', 'volcanic_amber', 'misty_gray', 'deep_forest_green'],
        lighting: ['natural_available_light', 'dramatic_contrast', 'golden_hour_contemplation'],
        composition: ['vast_landscape_tiny_figure', 'static_contemplation', 'intense_close_up'],
        mood: ['existential_wonder', 'nature_indifference', 'poetic_melancholy'],
        nirathRelevance: 4 // ★★★★☆
      },
      
      burns: {
        name: '肯·伯恩斯 (Ken Burns)',
        films: ['南北战争', '爵士', '越南战争'],
        coreTags: [
          { tag: 'archival_immersion', desc: '档案影像沉浸+历史质感', weight: 1.0 },
          { tag: 'slow_zoom_pan', desc: '缓慢缩放平移+照片活化', weight: 0.9 },
          { tag: 'narrative_archaeology', desc: '叙事考古+多层时间线', weight: 0.8 }
        ],
        colorPalette: ['sepia_warmth', 'archival_brown', 'faded_color', 'monochrome_dignity'],
        lighting: ['soft_diffused_historical', 'natural_window_light', 'candle_warmth'],
        composition: ['photograph_within_frame', 'intimate_portrait', 'documentary_detail'],
        mood: ['historical_gravity', 'nostalgic_reverence', 'quiet_authority'],
        nirathRelevance: 3 // ★★★☆☆
      },
      
      morris: {
        name: '埃罗尔·莫里斯 (Errol Morris)',
        films: ['细蓝线', '战争之雾', '标准作业程序'],
        coreTags: [
          { tag: 'direct_address', desc: '直视镜头+访谈者直面观众', weight: 1.0 },
          { tag: 'interrotron', desc: 'Interrotron设备+眼神接触', weight: 0.9 },
          { tag: 'reconstruction_drama', desc: '重构戏剧+事实与记忆交织', weight: 0.8 }
        ],
        colorPalette: ['clinical_white', 'deep_shadow', 'neutral_gray', 'accent_blue'],
        lighting: ['dramatic_side_light', 'high_contrast_interview', 'theatrical_spotlight'],
        composition: ['direct_to_camera', 'extreme_close_up', 'isolated_subject'],
        mood: ['intellectual_intensity', 'truth_seeking', 'psychological_exposure'],
        nirathRelevance: 3 // ★★★☆☆
      }
    };
  }

  /**
   * 构建场景类型→导演风格推荐映射
   */
  _buildSceneStyleMap() {
    return {
      // Nirath 核心场景类型
      'alien_ecosystem': {        // 异星生态展示
        primary: 'cameron',
        secondary: 'jackson',
        tertiary: 'villeneuve',
        tags: ['bioluminescent_ecosystem', 'natural_epic_landscape', 'monumental_scale']
      },
      'creature_first_encounter': { // 异兽首次登场
        primary: 'spielberg',
        secondary: 'villeneuve',
        tertiary: 'deltoro',
        tags: ['creature_reveal_ritual', 'slow_reveal', 'creature_aesthetic']
      },
      'epic_landscape': {         // 史诗地貌/全景
        primary: 'villeneuve',
        secondary: 'jackson',
        tertiary: 'cameron',
        tags: ['monumental_scale', 'fantasy_world_building', 'imax_epic_scale']
      },
      'emotional_climax': {        // 情感高潮/理解达成
        primary: 'spielberg',
        secondary: 'cameron',
        tertiary: 'jackson',
        tags: ['emotional_priority', 'immersive_wonder', 'heroic_journey_visuals']
      },
      'action_confrontation': {    // 动作/对抗场面
        primary: 'cameron',
        secondary: 'jackson',
        tertiary: 'lucas',
        tags: ['physical_simulation', 'heroic_journey_visuals', 'space_opera_grandeur']
      },
      'mystery_discovery': {       // 神秘发现/探索
        primary: 'villeneuve',
        secondary: 'spielberg',
        tertiary: 'cameron',
        tags: ['slow_reveal', 'emotional_priority', 'bioluminescent_ecosystem']
      },
      'opening_hook': {           // 开场钩子
        primary: 'villeneuve',
        secondary: 'spielberg',
        tertiary: 'jackson',
        tags: ['monumental_scale', 'creature_reveal_ritual', 'fantasy_world_building']
      },
      
      // v6.6.4-root-fix: 新增教育/纪录片场景类型
      'educational_explanation': {  // 教育讲解/知识传授
        primary: 'herzog',
        secondary: 'burns',
        tertiary: 'morris',
        tags: ['contemplative_observation', 'archival_immersion', 'direct_address']
      },
      'medical_interview': {        // 医疗访谈/专业对话
        primary: 'morris',
        secondary: 'herzog',
        tertiary: 'spielberg',
        tags: ['direct_address', 'intellectual_intensity', 'emotional_priority']
      },
      'health_demonstration': {     // 健康演示/实操展示
        primary: 'burns',
        secondary: 'herzog',
        tertiary: 'villeneuve',
        tags: ['slow_zoom_pan', 'contemplative_observation', 'minimalist_composition']
      },
      'documentary_narration': {    // 纪录片旁白/叙事
        primary: 'herzog',
        secondary: 'burns',
        tertiary: 'villeneuve',
        tags: ['landscape_as_character', 'narrative_archaeology', 'monumental_scale']
      }
    };
  }

  /**
   * 根据场景类型推荐导演风格
   * @param {String} sceneType - 场景类型
   * @returns {Object} 风格推荐
   */
  recommendStyleForScene(sceneType) {
    const recommendation = this.SCENE_STYLE_MAP[sceneType] || this.SCENE_STYLE_MAP['alien_ecosystem'];
    
    const result = {
      sceneType,
      primary: this.STYLE_ARCHIVE[recommendation.primary],
      secondary: this.STYLE_ARCHIVE[recommendation.secondary],
      tertiary: this.STYLE_ARCHIVE[recommendation.tertiary],
      recommendedTags: recommendation.tags,
      blendWeights: {
        [recommendation.primary]: 0.5,
        [recommendation.secondary]: 0.3,
        [recommendation.tertiary]: 0.2
      }
    };
    
    return result;
  }

  /**
   * 融合多导演风格为 Nirath 专属风格
   * @param {Object} weights - 导演权重（如 {cameron: 0.35, villeneuve: 0.25}）
   * @returns {Object} 融合后的Nirath风格
   */
  blendStyles(weights = this.defaultBlend) {
    const blend = {
      name: 'Nirath专属融合风格',
      description: '卡梅隆生态 + 维伦纽瓦史诗 + 杰克逊奇幻 + 斯皮尔伯格情感',
      directors: [],
      colorPalette: new Set(),
      lighting: new Set(),
      composition: new Set(),
      mood: new Set(),
      coreTags: [],
      weights
    };
    
    // 按权重排序，取前3位导演
    const sortedDirectors = Object.entries(weights)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);
    
    for (const [directorKey, weight] of sortedDirectors) {
      const director = this.STYLE_ARCHIVE[directorKey];
      if (!director) continue;
      
      blend.directors.push({
        key: directorKey,
        name: director.name,
        weight,
        relevance: director.nirathRelevance
      });
      
      // 按权重融合各维度
      const tagCount = Math.ceil(director.coreTags.length * weight * 2);
      const selectedTags = director.coreTags.slice(0, Math.max(1, tagCount));
      
      for (const tag of selectedTags) {
        blend.coreTags.push({
          ...tag,
          source: directorKey,
          blendedWeight: tag.weight * weight
        });
      }
      
      // 融合色彩/光影/构图/氛围
      const paletteCount = Math.ceil(director.colorPalette.length * weight * 2);
      const lightingCount = Math.ceil(director.lighting.length * weight * 2);
      const compositionCount = Math.ceil(director.composition.length * weight * 2);
      const moodCount = Math.ceil(director.mood.length * weight * 2);
      
      director.colorPalette.slice(0, Math.max(1, paletteCount)).forEach(p => blend.colorPalette.add(p));
      director.lighting.slice(0, Math.max(1, lightingCount)).forEach(l => blend.lighting.add(l));
      director.composition.slice(0, Math.max(1, compositionCount)).forEach(c => blend.composition.add(c));
      director.mood.slice(0, Math.max(1, moodCount)).forEach(m => blend.mood.add(m));
    }
    
    // 转换为数组
    blend.colorPalette = Array.from(blend.colorPalette);
    blend.lighting = Array.from(blend.lighting);
    blend.composition = Array.from(blend.composition);
    blend.mood = Array.from(blend.mood);
    
    // 按融合权重排序标签
    blend.coreTags.sort((a, b) => b.blendedWeight - a.blendedWeight);
    
    return blend;
  }

  /**
   * 生成风格提示词片段（供Prompt注入使用）
   * @param {Object} blend - 融合风格对象（由 blendStyles 生成）
   * @param {String} sceneContext - 场景上下文（简短描述）
   * @returns {String} 风格提示词片段（控制在200字符以内）
   */
  generateStylePrompt(blend, sceneContext = '') {
    const topTags = blend.coreTags.slice(0, 3).map(t => t.tag.replace(/_/g, ' '));
    const topColors = blend.colorPalette.slice(0, 2).map(c => c.replace(/_/g, ' '));
    const topLighting = blend.lighting.slice(0, 2).map(l => l.replace(/_/g, ' '));
    const topMood = blend.mood.slice(0, 2).map(m => m.replace(/_/g, ' '));
    
    const prompt = `
Director Style: ${blend.directors.map(d => d.name.split(' ')[0]).join(' + ')} fusion
${topTags.join(', ')}, ${topColors.join('/')} palette,
${topLighting.join(', ')} lighting,
${topMood.join(' + ')} atmosphere,
电影级大片品质
    `.trim().replace(/\n/g, ' ').replace(/\s+/g, ' ');
    
    // 控制长度
    return prompt.substring(0, 200);
  }

  /**
   * 检查镜头风格一致性（供导演优化调用）
   * @param {Object} shot - 镜头对象（含 prompt, shotType, emotionPhase 等字段）
   * @param {Object} expectedStyle - 期望风格（由 recommendStyleForScene 或 blendStyles 生成）
   * @returns {Object} 风格一致性检查结果
   */
  checkStyleConsistency(shot, expectedStyle) {
    const prompt = shot.prompt || '';
    const result = {
      shotId: shot.shotId || shot.id || 'unknown',
      score: 0,
      maxScore: 100,
      matchedTags: [],
      missingTags: [],
      issues: [],
      suggestions: []
    };
    
    // 检查核心标签在Prompt中的体现
    const allTags = expectedStyle.coreTags || [];
    let matchedCount = 0;
    
    for (const tag of allTags) {
      const tagKeywords = tag.tag.split('_');
      const tagDesc = tag.desc;
      
      // 检查Prompt中是否包含标签关键词或描述词
      const found = tagKeywords.some(kw => prompt.toLowerCase().includes(kw.toLowerCase())) ||
                    tagDesc.split(/[\s，]/).some(word => prompt.includes(word));
      
      if (found) {
        matchedCount++;
        result.matchedTags.push({
          tag: tag.tag,
          desc: tag.desc,
          weight: tag.blendedWeight || tag.weight
        });
      } else {
        result.missingTags.push({
          tag: tag.tag,
          desc: tag.desc,
          weight: tag.blendedWeight || tag.weight
        });
      }
    }
    
    // 计算分数（基于匹配率+权重）
    if (allTags.length > 0) {
      const matchedWeight = result.matchedTags.reduce((sum, t) => sum + (t.weight || 1), 0);
      const totalWeight = allTags.reduce((sum, t) => sum + (t.blendedWeight || t.weight || 1), 0);
      result.score = Math.round((matchedWeight / totalWeight) * 100);
    }
    
    // 生成建议
    if (result.missingTags.length > 0) {
      const topMissing = result.missingTags
        .sort((a, b) => (b.weight || 0) - (a.weight || 0))
        .slice(0, 3);
      
      result.suggestions.push({
        category: 'style',
        message: `缺少风格标签: ${topMissing.map(t => t.desc).join('、')}`,
        fix: `在Prompt中注入相关视觉元素: ${topMissing.map(t => t.tag.replace(/_/g, ' ')).join(', ')}`
      });
    }
    
    // 低分警告
    if (result.score < 50) {
      result.issues.push({
        severity: 'medium',
        category: 'style',
        message: `风格一致性评分仅${result.score}/100，镜头视觉风格偏离Nirath融合风格`,
        fix: '参考导演风格库推荐标签，在Prompt中增加核心视觉元素'
      });
    } else if (result.score < 75) {
      result.issues.push({
        severity: 'low',
        category: 'style',
        message: `风格一致性评分${result.score}/100，有提升空间`,
        fix: `补充缺失风格标签: ${result.missingTags.slice(0, 2).map(t => t.desc).join('、')}`
      });
    }
    
    return result;
  }

  /**
   * 批量检查全片风格一致性
   * @param {Array} shots - 镜头数组
   * @param {Object} options - 配置（可自定义融合权重）
   * @returns {Object} 全片风格一致性报告
   */
  analyzeFullFilmStyle(shots, options = {}) {
    console.log(`\n[DirectorStyleLibrary] 🎨 导演风格一致性分析 | 镜头数: ${shots.length}`);
    
    // 使用默认Nirath融合风格或自定义
    const blend = options.customBlend || this.blendStyles(options.weights || this.defaultBlend);
    
    const result = {
      score: 0,
      maxScore: 100,
      shotResults: [],
      overallBlend: blend,
      summary: {}
    };
    
    let totalScore = 0;
    
    for (const shot of shots) {
      // 根据镜头类型选择推荐风格
      const sceneType = this._inferSceneType(shot);
      const recommended = this.recommendStyleForScene(sceneType);
      
      // 使用推荐风格或整体融合风格进行检查
      const checkStyle = options.useSceneSpecific ? recommended : blend;
      const checkResult = this.checkStyleConsistency(shot, checkStyle);
      
      result.shotResults.push({
        shotId: shot.shotId,
        sceneType,
        ...checkResult
      });
      
      totalScore += checkResult.score;
    }
    
    result.score = shots.length > 0 ? Math.round(totalScore / shots.length) : 0;
    result.summary = {
      totalShots: shots.length,
      averageScore: result.score,
      passLine: 60,
      status: result.score >= 60 ? 'PASS' : 'NEEDS_IMPROVEMENT',
      styleBlend: blend.directors.map(d => `${d.name.split(' ')[0]}(${Math.round(d.weight * 100)}%)`).join(' + '),
      lowScoreShots: result.shotResults.filter(s => s.score < 50).map(s => s.shotId),
      highScoreShots: result.shotResults.filter(s => s.score >= 80).map(s => s.shotId)
    };
    
    this._printStyleReport(result);
    return result;
  }

  /**
   * 推断镜头场景类型
   */
  _inferSceneType(shot) {
    const prompt = shot.prompt || '';
    const shotType = shot.shotType || '';
    const emotionPhase = shot.emotionPhase || '';
    
    // v6.6.4-root-fix: 新增教育/纪录片场景类型检测
    // 基于 shotType 和 emotionPhase 推断
    if (shot.isOpening || shot.shotId === 'S00') return 'opening_hook';
    
    // 教育/医疗/健康类内容检测
    if (prompt.includes('科普') || prompt.includes('讲解') || prompt.includes('知识') || 
        prompt.includes('健康') || prompt.includes('医疗') || prompt.includes('教育') ||
        prompt.includes('护士') || prompt.includes('医生') || prompt.includes('患者') ||
        prompt.includes('医院') || prompt.includes('病症') || prompt.includes('治疗') ||
        prompt.includes('预防') || prompt.includes('介绍') || prompt.includes('说明')) {
      return 'educational_explanation';
    }
    
    // 访谈/对话类检测
    if (prompt.includes('访谈') || prompt.includes('对话') || prompt.includes('采访') ||
        prompt.includes('交流') || prompt.includes('咨询') || prompt.includes('问诊')) {
      return 'medical_interview';
    }
    
    // 演示/展示类检测
    if (prompt.includes('演示') || prompt.includes('展示') || prompt.includes('操作') ||
        prompt.includes('示范') || prompt.includes('实验') || prompt.includes('检查')) {
      return 'health_demonstration';
    }
    
    // Nirath 原有场景类型检测
    if (emotionPhase === 'climax' || prompt.includes('高潮') || prompt.includes('爆发')) return 'emotional_climax';
    if (emotionPhase === 'building' || prompt.includes('冲突') || prompt.includes('对抗')) return 'action_confrontation';
    if (prompt.includes('登场') || prompt.includes('现身') || prompt.includes('出场') || prompt.includes('出现')) return 'creature_first_encounter';
    if (prompt.includes('森林') || prompt.includes('生态') || prompt.includes('植物') || prompt.includes('环境')) return 'alien_ecosystem';
    if (prompt.includes('全景') || prompt.includes('远景') || prompt.includes('地貌') || prompt.includes('山脉')) return 'epic_landscape';
    if (emotionPhase === 'rising' || prompt.includes('发现') || prompt.includes('探索') || prompt.includes('神秘')) return 'mystery_discovery';
    
    // 默认：如果是纪录片类型，返回纪录片旁白类型
    return 'documentary_narration';
  }

  /**
   * 输出风格报告
   */
  _printStyleReport(result) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🎨 导演风格一致性报告`);
    console.log(`${'='.repeat(60)}`);
    console.log(`融合风格: ${result.summary.styleBlend}`);
    console.log(`平均分: ${result.score}/100`);
    console.log(`状态: ${result.score >= 60 ? '✅ 通过' : '⚠️ 需改进'} (通过线: 60)`);
    console.log(`镜头数: ${result.summary.totalShots}`);
    
    if (result.summary.lowScoreShots.length > 0) {
      console.log(`\n低分镜头(<50): ${result.summary.lowScoreShots.join(', ')}`);
    }
    if (result.summary.highScoreShots.length > 0) {
      console.log(`高分镜头(≥80): ${result.summary.highScoreShots.join(', ')}`);
    }
    
    console.log(`${'='.repeat(60)}\n`);
  }

  /**
   * 获取Nirath默认融合风格的Prompt注入片段
   * 供 Stage 11 Prompt生成时调用
   */
  getNirathStylePrompt() {
    const blend = this.blendStyles(this.defaultBlend);
    return this.generateStylePrompt(blend, 'Nirath异世界电影级');
  }
}

module.exports = { DirectorStyleLibrary };
// v6.2-patch69: 导演风格库 — Phase 2 好莱坞大片导演AI风格档案库挂载
// 参考文档: 《好莱坞大片导演AI风格档案库.md》v1.0
// 设计原则: 吸收精华，不全部照搬，结合Nirath世界观定制
