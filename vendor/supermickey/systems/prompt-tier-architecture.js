/**
 * Prompt七层架构 v2.0 (方案B+：激进式重构)
 * 七层构建体系：约束层 → 基础层 → 空间层 → 主体层 → 动态层 → 风格层 → 音频层 → 质控层
 * 
 * 基于《AI视频生成提示词工程方法论——通用系统级规范 v1.0》
 * 核心命题：提示词是视觉执行指令集（Visual Execution Brief），非自然语言描述
 * 
 * P0（缺失则输出不可控）：约束层 + 基础层 + 质控层
 * P1（缺失则画面平庸）：空间层 + 动态层
 * P2（缺失则风格漂移）：主体层 + 风格层 + 音频层
 * 
 * @version v2.0-B+
 * @author 小G
 */

class PromptTierArchitecture {
  constructor(options = {}) {
    this.maxLength = options.maxLength || 1500;
    this.optimalLength = options.optimalLength || 1470;
    
    // 七层预算分配（按优先级和重要性）
    this.layerBudgets = {
      constraint: Math.floor(this.maxLength * 0.05),   // 5%  ~75
      foundation: Math.floor(this.maxLength * 0.10),   // 10% ~150
      space: Math.floor(this.maxLength * 0.15),        // 15% ~225
      subject: Math.floor(this.maxLength * 0.20),      // 20% ~300
      dynamic: Math.floor(this.maxLength * 0.15),       // 15% ~225
      style: Math.floor(this.maxLength * 0.15),        // 15% ~225
      audio: Math.floor(this.maxLength * 0.10),        // 10% ~150 (新增)
      quality: Math.floor(this.maxLength * 0.10)       // 10% ~150
    };
    
    // 技术规格词汇库
    this.techSpecs = {
      effective: [
        '电影级光影', '体积雾', '大气透视', '景深', '微距摄影细节', 'IMAX画幅'
      ],
      ineffective: [
        '虚幻引擎5', 'Lumen全局光照', 'Nanite几何', '超写实3D数字人渲染', '8K分辨率'
      ],
      nirathEffective: [
        'dual-sunset lighting with rose-gold tones',
        'bioluminescent ecosystem fill light',
        '5800K warm gold + 6500K cool white'
      ]
    };
    
    // 音频场景映射（新增）- 支持中英文关键词
    this.audioSceneMap = {
      'beach': { env: '海浪轻拍沙滩的白噪音，海鸟远处鸣叫', action: '白沙从指缝流下沙沙声', emotion: '温暖治愈的氛围音' },
      'forest': { env: '风吹树叶沙沙声，远处溪流潺潺', action: '脚步声踩落叶', emotion: '宁静安详的自然氛围' },
      'city': { env: '车流白噪音，远处鸣笛', action: '快门声、键盘敲击', emotion: '都市节奏感' },
      'home': { env: '室内温暖环境音', action: '婴儿咯咯笑声', emotion: '温馨家庭氛围' },
      'ocean': { env: '海浪拍打礁石，海风呼啸', action: '水花溅起声', emotion: '自由辽阔的海洋气息' },
      'mountain': { env: '山风呼啸，远处鸟鸣', action: '雪粉飞扬声', emotion: '壮丽寂静的高山氛围' },
      'studio': { env: '摄影棚安静环境', action: '快门咔嚓声', emotion: '专业专注的工作氛围' },
      // 中文场景映射
      '椰': { env: '海风吹拂椰树叶沙沙声，海浪轻拍沙滩', action: '椰树叶随风摇曳声', emotion: '热带海岛的轻松氛围' },
      '海边': { env: '海浪轻拍沙滩的白噪音，海鸟远处鸣叫', action: '白沙从指缝流下沙沙声', emotion: '温暖治愈的氛围音' },
      '沙滩': { env: '海浪轻拍沙滩的白噪音，海鸟远处鸣叫', action: '白沙从指缝流下沙沙声', emotion: '温暖治愈的氛围音' },
      '海滩': { env: '海浪轻拍沙滩的白噪音，海鸟远处鸣叫', action: '白沙从指缝流下沙沙声', emotion: '温暖治愈的氛围音' },
      '椰树': { env: '海风吹拂椰树叶沙沙声，海浪轻拍沙滩', action: '椰树叶随风摇曳声', emotion: '热带海岛的轻松氛围' },
      '森林': { env: '风吹树叶沙沙声，远处溪流潺潺', action: '脚步声踩落叶', emotion: '宁静安详的自然氛围' },
      '城市': { env: '车流白噪音，远处鸣笛', action: '快门声、键盘敲击', emotion: '都市节奏感' },
      '家庭': { env: '室内温暖环境音', action: '婴儿咯咯笑声', emotion: '温馨家庭氛围' },
      '家': { env: '室内温暖环境音', action: '婴儿咯咯笑声', emotion: '温馨家庭氛围' },
      '室内': { env: '室内温暖环境音', action: '轻柔脚步声', emotion: '温馨室内氛围' }
    };
    
    // 色彩方案词库
    this.colorSchemes = {
      'teal_orange': { shadows: 'deep teal', highlights: 'warm amber', accent: 'subtle gold' },
      'warm': { shadows: 'warm brown', highlights: 'golden', accent: 'soft orange' },
      'cool': { shadows: 'cool blue', highlights: 'silver white', accent: 'pale cyan' },
      'natural': { shadows: 'natural earth', highlights: 'daylight', accent: 'green foliage' },
      'monochrome': { shadows: 'rich black', highlights: 'bright white', accent: 'gray gradient' }
    };
    
    // 写实度分级
    this.realismLevels = {
      0: 'abstract, non-representational',
      1: 'stylized, illustration-like',
      2: 'painterly realism, artistic',
      3: 'photorealistic, realistic',
      4: 'hyperrealistic, ultra-detailed',
      5: 'indistinguishable from real footage, documentary'
    };
  }

  /**
   * 主入口：七层分层构建Prompt
   * @param {Object} params - 构建参数
   * @returns {Object} { prompt, rawPrompt, tiers, metrics, layers }
   */
  build(params) {
    const startTime = Date.now();
    console.log(`[PromptTier-v2.0] 🔧 七层架构构建开始 | 场景: ${params.sceneName || 'unknown'} | 模式: ${params.mode || 'generic'}`);
    
    // Step 1-8: 构建七层
    const layers = {
      constraint: this._buildConstraintLayer(params),
      foundation: this._buildFoundationLayer(params),
      space: this._buildSpaceLayer(params),
      subject: this._buildSubjectLayer(params),
      dynamic: this._buildDynamicLayer(params),
      style: this._buildStyleLayer(params),
      audio: this._buildAudioLayer(params),  // 🔊 新增音频层
      quality: this._buildQualityLayer(params)
    };
    
    // Step 9: 导演风格注入（如果有）
    let directorStyleText = '';
    if (params.directorStyle) {
      const ds = params.directorStyle;
      directorStyleText = `Director style: ${ds.primaryDirector} + ${ds.secondaryDirector}, ${ds.directorTags.join(', ')}`;
      console.log(`[PromptTier-v2.0] 🎬 导演风格注入: ${ds.sceneType} | ${ds.primaryDirector} + ${ds.secondaryDirector}`);
    }
    
    // Step 10: 智能组装（按P0>P1>P2优先级）
    const assembled = this._assembleSevenLayers(layers, directorStyleText);
    
    // Step 11: 质量验证
    const metrics = this._calculateMetrics(assembled, layers);
    
    const duration = Date.now() - startTime;
    console.log(`[PromptTier-v2.0] ✅ 七层构建完成 | 总长度: ${assembled.prompt.length} | 七层完整 | 耗时: ${duration}ms`);
    
    return {
      prompt: assembled.prompt,
      rawPrompt: assembled.raw,
      raw: assembled.raw, // 兼容旧调用
      tiers: this._mapToLegacyTiers(layers), // 兼容旧结构
      metrics,
      layers, // 新增七层详情
      duration
    };
  }

  // ==================== 七层构建方法 ====================

  /**
   * L1: 约束层（P0必加）
   * 功能：技术参数锁定 — 画幅比、帧率、时长、无字幕
   */
  _buildConstraintLayer(params) {
    const parts = [];
    
    // 画幅比
    const ratio = params.aspectRatio || '16:9';
    parts.push(`${ratio} cinematic`);
    
    // 无字幕/文字
    parts.push('no text, no subtitle, no caption, no watermark');
    
    // 帧率（电影级）
    parts.push('24fps cinematic');
    
    // 时长约束（如果指定）
    if (params.duration) {
      parts.push(`${params.duration}s`);
    }
    
    return parts.join(', ');
  }

  /**
   * L2: 基础层（P0必加）
   * 功能：全局风格锚定 — 写实度、动态范围、画面质感
   */
  _buildFoundationLayer(params) {
    const parts = [];
    
    // 写实度（默认超写实等级4）
    const realismLevel = params.realismLevel || 4;
    const realismDesc = this.realismLevels[realismLevel] || this.realismLevels[4];
    parts.push(realismDesc);
    
    // 动态范围（HDR或标准）
    parts.push('high dynamic range, detail in highlights and shadows');
    
    // 画面质感（默认电影级）
    const texture = params.texture || 'film grain, 35mm texture, cinematic film';
    parts.push(texture);
    
    // 电影参考（可选）
    if (params.cinematicReference) {
      parts.push(`${params.cinematicReference} style`);
    }
    
    return parts.join(', ');
  }

  /**
   * L3: 空间层（P1防平庸）
   * 功能：三维坐标系建立 — 地理环境、空间纵深、天气时间
   */
  _buildSpaceLayer(params) {
    const parts = [];
    
    // 宏观地理
    const macroGeo = params.macroGeo || params.location || '';
    if (macroGeo) parts.push(macroGeo);
    
    // 中观地貌
    const midGeo = params.midGeo || params.landscape || '';
    if (midGeo) parts.push(midGeo);
    
    // 微观材质
    const microTexture = params.microTexture || params.surfaceDetail || '';
    if (microTexture) parts.push(microTexture);
    
    // 天气时间
    const timeOfDay = params.timeOfDay || 'golden hour';
    const weather = params.weather || 'clear sky';
    parts.push(`${timeOfDay}, ${weather}`);
    
    // 空间纵深（大气透视）
    parts.push('atmospheric haze, depth layers, foreground to background');
    
    // 空间关系（前景-中景-背景）
    if (params.depthLayers) {
      parts.push(params.depthLayers);
    }
    
    return parts.join(', ');
  }

  /**
   * L4: 主体层（P2防漂移）
   * 功能：视觉焦点定义 — 人物/物体的形态、材质、状态、关系
   * 四维模型：形态 + 材质 + 状态 + 关系
   */
  _buildSubjectLayer(params) {
    const parts = [];
    
    if (!params.subject) return '';
    
    const subject = params.subject;
    
    // 形态维度（Form）
    if (subject.form) {
      parts.push(subject.form);
    } else if (typeof subject === 'string') {
      parts.push(subject);
    } else if (subject.description) {
      parts.push(subject.description);
    }
    
    // 材质维度（Material）
    if (subject.material) {
      parts.push(subject.material);
    }
    
    // 状态维度（State）
    if (subject.state) {
      parts.push(subject.state);
    }
    
    // 关系维度（Relation）
    if (subject.relation) {
      parts.push(subject.relation);
    }
    
    // 主体占比（构图策略）
    if (subject.composition) {
      parts.push(subject.composition);
    }
    
    return parts.join(', ');
  }

  /**
   * L5: 动态层（P1防平庸）
   * 功能：时间轴上的变化 — 主体动作、环境动作、镜头动作
   * 三层模型：主体动作 + 环境动作 + 镜头动作
   */
  _buildDynamicLayer(params) {
    const parts = [];
    
    // 主体动作（Action）
    if (params.action) {
      const actionStr = typeof params.action === 'string' ? params.action : 
        (params.action?.description || params.action?.type || String(params.action));
      parts.push(actionStr);
    }
    
    // 环境动作（环境动态）
    if (params.environmentAction) {
      parts.push(params.environmentAction);
    }
    
    // 镜头动作（Camera Movement）- 跳过，由 toStandardPrompt 统一注入【运镜】标记
    // 避免双重注入导致 prompt 中出现重复运镜描述
    // if (params.cameraMovement) {
    //   const camCore = this._extractCameraCore(params.cameraMovement);
    //   parts.push(camCore);
    // }
    
    // 动作速度
    if (params.speed) {
      parts.push(`${params.speed} pace`);
    }
    
    return parts.join(', ');
  }

  /**
   * L6: 风格层（P2防漂移）
   * 功能：美学参数锁定 — 色彩系统、光学参数、情绪调性
   */
  _buildStyleLayer(params) {
    const parts = [];
    
    // 色彩方案
    const colorScheme = params.colorScheme || 'natural';
    const cs = this.colorSchemes[colorScheme] || this.colorSchemes['natural'];
    parts.push(`color palette: ${cs.shadows} shadows + ${cs.highlights} highlights + ${cs.accent} accents`);
    
    // 色温
    if (params.colorTemp) {
      parts.push(`${params.colorTemp}K color temperature`);
    }
    
    // 光学参数
    if (params.lens) {
      parts.push(`${params.lens}mm lens`);
    }
    if (params.aperture) {
      parts.push(`f/${params.aperture}`);
    }
    if (params.depthOfField) {
      parts.push(`${params.depthOfField} depth of field`);
    }
    
    // 情绪调性
    const emotionPhase = params.emotionPhase || 'neutral';
    const emotionMap = {
      'establishing': 'serene, awe-inspiring',
      'rising': 'growing tension, anticipation',
      'building': 'intensifying drama',
      'climax': 'peak emotional intensity',
      'resolve': 'peaceful resolution',
      'opening': 'epic grandeur',
      'warm': 'warm, healing, tender',
      'joy': 'joyful, bright, energetic'
    };
    parts.push(emotionMap[emotionPhase] || 'cinematic atmosphere');
    
    // 导演风格（融入）
    if (params.directorStyle) {
      const ds = params.directorStyle;
      parts.push(`${ds.primaryDirector} aesthetic`);
    }
    
    return parts.join(', ');
  }

  /**
   * L7: 音频层（🔊 新增 — P2防漂移）
   * 功能：声音设计 — 环境音、动作音、情绪音、音乐线索
   * 四层模型：L1环境音 + L2动作音 + L3情绪音 + L4音乐线索
   */
  _buildAudioLayer(params) {
    const parts = [];
    
    // 按场景类型匹配音频模板
    // 🔊 v2.0-B+-fix: 优先使用 sceneName（具体场景）而非 sceneType（generic等抽象类型）
    const sceneName = (params.sceneName || '').toLowerCase();
    const sceneType = (params.sceneType || '').toLowerCase();
    let audioTemplate = null;
    
    // 匹配场景名称（优先）
    if (sceneName) {
      for (const [key, template] of Object.entries(this.audioSceneMap)) {
        if (sceneName.includes(key)) {
          audioTemplate = template;
          break;
        }
      }
    }
    
    // 回退：匹配场景类型
    if (!audioTemplate && sceneType) {
      for (const [key, template] of Object.entries(this.audioSceneMap)) {
        if (sceneType.includes(key)) {
          audioTemplate = template;
          break;
        }
      }
    }
    
    // 回退：基于环境特征推断
    if (!audioTemplate && params.environmentFeatures) {
      const env = params.environmentFeatures.join(' ').toLowerCase();
      if (env.includes('海') || env.includes('沙滩') || env.includes('海岸')) {
        audioTemplate = this.audioSceneMap['beach'];
      } else if (env.includes('森林') || env.includes('树')) {
        audioTemplate = this.audioSceneMap['forest'];
      } else if (env.includes('城') || env.includes('街道')) {
        audioTemplate = this.audioSceneMap['city'];
      } else if (env.includes('家') || env.includes('室内')) {
        audioTemplate = this.audioSceneMap['home'];
      }
    }
    
    // 回退：基于时间推断
    if (!audioTemplate && params.timeOfDay) {
      const tod = params.timeOfDay.toLowerCase();
      if (tod.includes('night') || tod.includes('dusk')) {
        audioTemplate = { env: '夜晚虫鸣，远处低语', action: '轻柔脚步声', emotion: '神秘宁静的夜晚氛围' };
      } else {
        audioTemplate = { env: '白天环境音', action: '自然动作声', emotion: '明亮日常氛围' };
      }
    }
    
    // 默认回退
    if (!audioTemplate) {
      audioTemplate = { env: '自然环境音', action: '动作反馈声', emotion: '真实氛围' };
    }
    
    // L1: 环境音（建立空间定位）- 自然语言格式，Seedance更易理解
    parts.push(`伴随${audioTemplate.env}`);
    
    // L2: 动作音（物理真实感）- 自然语言格式
    if (params.actionSound || audioTemplate.action) {
      parts.push(`动作产生${params.actionSound || audioTemplate.action}`);
    }
    
    // L3: 情绪音（心理氛围）- 自然语言格式
    if (params.emotionSound || audioTemplate.emotion) {
      parts.push(`氛围弥漫${params.emotionSound || audioTemplate.emotion}`);
    }
    
    // L4: 音乐线索（可选，如果指定）- 自然语言格式
    if (params.musicCue) {
      parts.push(`音乐线索${params.musicCue}`);
    }
    
    // 声画同步标记 - 自然语言格式
    if (params.lipSync || params.mouthAction) {
      parts.push('声画精准同步，嘴型与发音对齐');
    }
    
    return parts.join(', ');
  }

  /**
   * L8: 质控层（P0必加）
   * 功能：负面约束与质量控制 — 排除项、质量底线、一致性要求
   */
  _buildQualityLayer(params) {
    const parts = [];
    
    // 基础质量排除
    parts.push('blurry, low resolution, pixelated, compression artifacts');
    
    // 风格排除
    parts.push('cartoon, anime, illustration, 3D render look, CGI appearance, plastic look');
    
    // 结构排除
    parts.push('distorted perspective, impossible geometry, floating objects, inconsistent scale');
    
    // 光影排除
    parts.push('flat lighting, overexposed, crushed blacks, double shadows, wrong light direction');
    
    // 人物专项（如果含人物）
    if (params.hasCharacters || params.subject) {
      parts.push('distorted face, deformed face, extra fingers, plastic skin, waxy skin, unnatural pose');
    }
    
    // 物理排除
    parts.push('unnatural physics, fake water, static water, cardboard texture, plastic foliage');
    
    // 模式专属排除
    if (params.mode === 'nirath') {
      parts.push('no metallic shine, no traditional Chinese symbols, natural eye colors only');
    }
    
    return parts.join(', ');
  }

  // ==================== 组装与裁剪 ====================

  /**
   * 七层智能组装
   * 优先级：P0(约束+基础+质控) > P1(空间+动态) > P2(主体+风格+音频)
   * 超长时从P2开始裁剪，必要时压缩P1，P0绝对保留
   */
  _assembleSevenLayers(layers, directorStyleText) {
    // P0层（绝对保留）
    const p0Layers = [layers.constraint, layers.foundation, layers.quality];
    let prompt = p0Layers.filter(Boolean).join(', ');
    
    // P1层（优先保留）
    const p1Layers = [layers.space, layers.dynamic];
    const p1Text = p1Layers.filter(Boolean).join(', ');
    if (p1Text) {
      const combined = `${prompt}, ${p1Text}`;
      if (combined.length <= this.maxLength) {
        prompt = combined;
      } else {
        const remaining = this.maxLength - prompt.length - 2;
        if (remaining > 30) {
          prompt = `${prompt}, ${this._smartTrim(p1Text, remaining)}`;
        }
      }
    }
    
    // P2层（按需保留）
    const p2Layers = [layers.subject, layers.style, layers.audio];
    const p2Text = p2Layers.filter(Boolean).join(', ');
    if (p2Text) {
      const combined = `${prompt}, ${p2Text}`;
      if (combined.length <= this.maxLength) {
        prompt = combined;
      } else {
        const remaining = this.maxLength - prompt.length - 2;
        if (remaining > 30) {
          // 优先保留音频层（🔊 新增策略：声音描述优先）
          const audioPriority = layers.audio && remaining > 50;
          if (audioPriority) {
            const audioTrimmed = this._smartTrim(layers.audio, Math.min(remaining * 0.4, 150));
            const otherTrimmed = this._smartTrim(`${layers.subject || ''}, ${layers.style || ''}`, remaining * 0.6);
            prompt = `${prompt}, ${otherTrimmed}, ${audioTrimmed}`;
          } else {
            prompt = `${prompt}, ${this._smartTrim(p2Text, remaining)}`;
          }
        }
      }
    }
    
    // 导演风格（融入风格层位置）
    if (directorStyleText) {
      const combined = `${prompt}, ${directorStyleText}`;
      if (combined.length <= this.maxLength) {
        prompt = combined;
      } else {
        const remaining = this.maxLength - prompt.length - 2;
        if (remaining > 20) {
          prompt = `${prompt}, ${directorStyleText.substring(0, remaining)}`;
        }
      }
    }
    
    // 最终截断（保险）
    if (prompt.length > this.maxLength) {
      prompt = this._trimAtPunctuation(prompt, this.maxLength);
    }
    
    // 构建 raw 视图（七层分隔）
    const raw = [
      '【约束】' + layers.constraint,
      '【基础】' + layers.foundation,
      '【空间】' + layers.space,
      '【主体】' + layers.subject,
      '【动态】' + layers.dynamic,
      '【风格】' + layers.style,
      '【音频】' + layers.audio,  // 🔊
      '【质控】' + layers.quality
    ].filter(s => s.length > 3).join(' | ');
    
    return { prompt, raw };
  }

  // ==================== 辅助方法 ====================

  _extractCameraCore(movement) {
    if (typeof movement === 'string') {
      const words = movement.split(/[\s,]+/).filter(w => w.length > 0);
      return words.slice(0, 5).join(' ');
    }
    return movement.type || movement.movementType || movement.movement || 'static shot';
  }

  _smartTrim(text, maxLen) {
    if (text.length <= maxLen) return text;
    const trimmed = text.substring(0, maxLen);
    
    // 优先在标点处截断
    const lastPunct = Math.max(
      trimmed.lastIndexOf('.'), trimmed.lastIndexOf(','), trimmed.lastIndexOf(';')
    );
    if (lastPunct > maxLen * 0.7) return trimmed.substring(0, lastPunct + 1);
    
    // 其次在空格
    const lastSpace = trimmed.lastIndexOf(' ');
    if (lastSpace > maxLen * 0.7) return trimmed.substring(0, lastSpace);
    
    return trimmed;
  }

  _trimAtPunctuation(text, maxLen) {
    if (text.length <= maxLen) return text;

    let trimmed = text.substring(0, maxLen);

    // 1. 保护未闭合的【】标记
    const lastOpen = trimmed.lastIndexOf('【');
    const lastClose = trimmed.lastIndexOf('】');
    if (lastOpen > lastClose) {
      trimmed = trimmed.substring(0, lastOpen);
    }

    // 2. 优先在中文标点处截断
    const cnPuncts = ['。', '，', '；', '！', '？'];
    for (const p of cnPuncts) {
      const idx = trimmed.lastIndexOf(p);
      if (idx > trimmed.length * 0.8) {
        return trimmed.substring(0, idx + 1);
      }
    }

    // 3. 英文标点
    const enPuncts = ['.', ',', ';', '!', '?'];
    for (const p of enPuncts) {
      const idx = trimmed.lastIndexOf(p);
      if (idx > trimmed.length * 0.8) {
        return trimmed.substring(0, idx + 1);
      }
    }

    // 4. 空格
    const lastSpace = trimmed.lastIndexOf(' ');
    if (lastSpace > trimmed.length * 0.8) {
      return trimmed.substring(0, lastSpace);
    }

    return trimmed.trim();
  }

  _mapToLegacyTiers(layers) {
    // 兼容旧 tiers 结构（tier1/tier2/tier3）
    return {
      tier1: {
        text: [layers.subject, layers.dynamic].filter(Boolean).join(', '),
        budget: this.layerBudgets.subject + this.layerBudgets.dynamic,
        actual: (layers.subject?.length || 0) + (layers.dynamic?.length || 0)
      },
      tier2: {
        text: [layers.space, layers.style, layers.audio].filter(Boolean).join(', '),
        budget: this.layerBudgets.space + this.layerBudgets.style + this.layerBudgets.audio,
        actual: (layers.space?.length || 0) + (layers.style?.length || 0) + (layers.audio?.length || 0)
      },
      tier3: {
        text: [layers.constraint, layers.foundation, layers.quality].filter(Boolean).join(', '),
        budget: this.layerBudgets.constraint + this.layerBudgets.foundation + this.layerBudgets.quality,
        actual: (layers.constraint?.length || 0) + (layers.foundation?.length || 0) + (layers.quality?.length || 0)
      }
    };
  }

  _calculateMetrics(assembled, layers) {
    const totalLength = assembled.prompt.length;
    const layerLengths = {};
    for (const [key, text] of Object.entries(layers)) {
      layerLengths[key] = text?.length || 0;
    }
    
    return {
      totalLength,
      utilizationRate: Math.round((totalLength / this.maxLength) * 100),
      utilization: Math.round((totalLength / this.maxLength) * 100), // 兼容旧字段
      layerLengths,
      audioIncluded: !!(layers.audio && layers.audio.length > 0), // 🔊
      tier1Retention: 100, // P0始终保留
      hasDirectorStyle: assembled.raw.includes('Director style')
    };
  }
}

module.exports = PromptTierArchitecture;
