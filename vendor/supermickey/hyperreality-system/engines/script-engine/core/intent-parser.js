// engines/script-engine/core/intent-parser.js
// Intent Parser - 解析用户意图，识别叙事模式，提取元数据
// 版本：v1.0 | 日期：2026-06-07

class IntentParser {
  constructor(options = {}) {
    this.config = {
      // 快速分类器：关键词匹配
      // v1.2.7-fix-A8: 移除神话项目特定词，保留通用剧情词
      keywordDict: {
        dramatic: ['短剧', '剧情', '故事', '角色', '冲突', '反转', '结局', '情感', '感动', '逆袭', '人设', '剧本', '台词', '音乐', '舞蹈', '编舞', '歌舞', 'MV', '电影级', '叙事', '浪漫', '梦幻'],
        educational: ['科普', '讲解', '知识', '教程', '学会', '原理', '什么是', '如何', '为什么'],
        documentary: ['纪录片', '纪实', '采访', '调查'],
        lifelog: ['家庭', '聚会', '旅行', '回忆', 'Vlog', '日常', '记录生活'],
        commercial: ['广告', '品牌', '营销', '推广', '产品', '转化', '带货', 'CTA', '宣传片', '介绍']
      },
      // 混合模式信号
      hybridSignals: {
        '知识营销': { primary: 'educational', secondary: 'commercial', keywords: ['科普种草', '知识带货', '专业测评'] },
        '品牌叙事': { primary: 'dramatic', secondary: 'commercial', keywords: ['品牌故事', '情感广告', '微电影广告'] },
        '纪实营销': { primary: 'documentary', secondary: 'commercial', keywords: ['品牌纪录片', '真实故事广告'] },
        '科普短剧': { primary: 'educational', secondary: 'dramatic', keywords: ['剧情科普', '故事学习'] }
      },
      // v1.2.7-fix-A8: 示例世界 世界观检测（仅神话项目项目触发，不影响通用性）
      nirathSignals: ['示例世界', 'nirath', '神话项目', '神兽', '示例神兽', '虚构', '碳化硅'],
      // 默认配置
      defaultMode: 'dramatic',
      confidenceThreshold: 0.85,
      ...options
    };
  }

  /**
   * 主入口：解析用户意图
   * @param {string|object} rawInput - 用户原始输入
   * @param {object} metadata - 附加元数据
   * @returns {object} UserIntent 对象
   */
  parse(rawInput, metadata = {}) {
    // 【v2.1.8-fix】优先信任用户结构化数据
    // 如果用户提供了完整的结构化主题定义，直接使用，跳过推断
    if (this._isStructuredTheme(rawInput)) {
      console.log('[IntentParser] 检测到用户结构化主题定义，直接信任');
      return this._buildUserIntentFromStructuredTheme(rawInput, metadata);
    }
    
    // v2.1.4-fix8: 防御性处理 - rawInput可能是对象
    let text = '';
    if (typeof rawInput === 'string') {
      text = rawInput;
    } else if (rawInput && typeof rawInput === 'object') {
      text = (rawInput.text || rawInput.content || rawInput.description || rawInput.title || '').toString();
    } else {
      text = (rawInput || '').toString();
    }
    
    // 【v2.1.5-fix-C】支持显式传入 narrativeMode，绕过自动分类
    if (metadata && metadata.narrativeMode) {
      const explicitMode = metadata.narrativeMode.toLowerCase();
      const validModes = ['dramatic', 'educational', 'documentary', 'lifelog', 'commercial'];
      if (validModes.includes(explicitMode)) {
        console.log(`[IntentParser] 使用显式 narrativeMode: ${explicitMode}`);
        return this._buildUserIntent({
          primary_type: explicitMode,
          confidence: 1.0,
          scores: { [explicitMode]: 99 },
          layer: 'explicit_metadata'
        }, metadata, 'explicit_metadata', text);
      }
    }
    
    // 第一层：快速分类器
    const fastResult = this._fastClassify(text);
    
    // 如果置信度足够高，直接返回
    if (fastResult.confidence >= 0.90) {
      return this._buildUserIntent(fastResult, metadata, 'fast_classifier', text);
    }

    // 第二层：深度分析（检测混合模式、示例世界世界观等）
    const deepResult = this._deepAnalysis(text, fastResult);
    
    return this._buildUserIntent(deepResult, metadata, 'deep_analysis', text);
  }
  
  /**
   * 【v2.1.8-fix】检测是否是用户提供的结构化主题定义
   */
  _isStructuredTheme(rawInput) {
    if (!rawInput || typeof rawInput !== 'object') return false;
    
    // 检查是否包含明确的主题定义字段
    const requiredFields = ['theme', 'description'];
    const hasRequired = requiredFields.every(f => rawInput[f] !== undefined && rawInput[f] !== '');
    
    // 检查是否包含类型定义
    const hasType = rawInput.type !== undefined && rawInput.type !== '';
    
    // 如果同时有 type 和 theme/description，视为结构化主题
    return hasRequired && hasType;
  }
  
  /**
   * 【v2.1.8-fix】从用户结构化主题构建 UserIntent
   */
  _buildUserIntentFromStructuredTheme(themeData, metadata) {
    // 将用户定义映射到内部类型
    const typeMapping = {
      '传统戏曲·程式化表演': 'dramatic',
      '传统戏曲': 'dramatic',
      '戏曲': 'dramatic',
      '京剧': 'dramatic',
      '戏剧': 'dramatic',
      '音乐剧': 'dramatic',
      '音乐MV': 'dramatic',
      '舞蹈': 'dramatic',
      '艺术实验': 'dramatic',
      '硬科幻': 'dramatic',
      '武侠动作': 'dramatic',
      '恐怖悬疑': 'dramatic',
      '历史战争': 'dramatic',
      '浪漫爱情': 'dramatic',
      '家庭温情': 'dramatic',
      '喜剧荒诞': 'dramatic',
      '社会现实': 'documentary',
      '自然纪录片': 'documentary',
      '文化遗产': 'documentary',
      '美食文化': 'documentary',
      '科普教育': 'educational',
      '商业广告': 'commercial',
      '运动竞技': 'dramatic'
    };
    
    const userType = themeData.type || '';
    const mappedMode = typeMapping[userType] || 'dramatic';
    
    return {
      intent_id: this._generateUUID(),
      raw_input: metadata.raw_input || themeData.description || '',
      parsed: {
        narrative_mode: mappedMode,
        primary_mode: mappedMode,
        secondary_modes: [],
        hybrid_config: null
      },
      metadata: {
        // 【v2.1.10-fix 时长断层】先展开 metadata，再显式赋值关键字段。
        // 原实现把 ...metadata 放在最后，metadata.target_duration 会静默覆盖
        // 用户结构化主题中已确认的 duration_sec，造成时长链路断裂。
        ...metadata,
        title: themeData.theme || metadata.title || '未命名项目',
        // 优先级：用户结构化主题已确认时长 > metadata 确认时长 > 默认 60s
        target_duration: themeData.duration_sec || metadata.target_duration || 60,
        target_platform: metadata.target_platform || ['general'],
        language: metadata.language || 'zh-CN',
        style_tags: metadata.style_tags || ['hyper-realistic', 'cinematic', 'epic'],
        world_setting: metadata.world_setting || 'default',
        featured_beast_id: metadata.featured_beast_id || null,
        protagonist: metadata.protagonist || 'protagonist',
        // 【v2.1.8-fix】保留用户的结构化主题定义
        _userStructuredTheme: themeData,
      },
      constraints: {
        max_prompt_length: metadata.max_prompt_length || 3000,
        reference_image_count: metadata.reference_image_count || 2,
        forbidden_elements: metadata.forbidden_elements || ['voiceover', 'metal_gloss', 'unnatural_eye_color']
      },
      analysis: {
        layer: 'structured_theme',
        confidence: 1.0,
        scores: { [mappedMode]: 99 }
      }
    };
  }

  /**
   * 快速分类器：基于关键词匹配
   */
  _fastClassify(text) {
    const scores = {};
    let totalMatches = 0;

    // 统计各类型关键词命中数
    // 【v2.1.5-fix-C】高权重关键词：命中时加2分而非1分
    const highWeightKeywords = {
      commercial: ['宣传片', '品牌故事', '广告片']
    };
    
    for (const [type, keywords] of Object.entries(this.config.keywordDict)) {
      let matches = 0;
      for (const keyword of keywords) {
        if (text.includes(keyword)) {
          // 检查是否高权重关键词
          const isHighWeight = highWeightKeywords[type]?.includes(keyword);
          matches += isHighWeight ? 2 : 1;
        }
      }
      scores[type] = matches;
      totalMatches += matches;
    }

    // 计算置信度
    let maxScore = 0;
    let primaryType = this.config.defaultMode;

    for (const [type, score] of Object.entries(scores)) {
      // 【P0-6 修复】平分时 commercial 优先（宣传片强信号不应被 EDU 覆盖）
      const tiePriority = { commercial: 5, dramatic: 4, documentary: 3, lifelog: 2, educational: 1 };
      if (score > maxScore || (score === maxScore && (tiePriority[type] || 0) > (tiePriority[primaryType] || 0))) {
        maxScore = score;
        primaryType = type;
      }
    }

    const confidence = totalMatches > 0 ? maxScore / totalMatches : 0;

    return {
      primary_type: primaryType,
      confidence: Math.min(confidence, 1.0),
      scores,
      layer: 'fast_classifier'
    };
  }

  /**
   * 深度分析：检测混合模式、世界观、元数据提取
   */
  _deepAnalysis(text, fastResult) {
    let result = { ...fastResult };

    // 检测混合模式
    const hybridMode = this._detectHybridMode(text);
    if (hybridMode) {
      result.primary_type = hybridMode.primary;
      result.secondary_type = hybridMode.secondary;
      result.hybrid_mode = hybridMode.name;
      result.confidence = 0.88; // 混合模式默认置信度
    }

    // 检测 示例世界 世界观
    const is示例世界 = this._detect示例世界(text);
    if (is示例世界) {
      result.world_setting = '示例世界';
      result.nirath_signals = is示例世界.matches;
    }

    // 提取时长信息
    const duration = this._extractDuration(text);
    if (duration) {
      result.target_duration = duration;
    }

    // 提取神兽 ID
    const beastId = this._extractBeastId(text);
    if (beastId) {
      result.featured_beast_id = beastId;
    }

    return result;
  }

  /**
   * 检测混合模式
   */
  _detectHybridMode(text) {
    for (const [name, config] of Object.entries(this.config.hybridSignals)) {
      for (const keyword of config.keywords) {
        if (text.includes(keyword)) {
          return {
            name,
            primary: config.primary,
            secondary: config.secondary
          };
        }
      }
    }
    return null;
  }

  /**
   * 检测 示例世界 世界观
   */
  _detect示例世界(text) {
    const matches = [];
    for (const signal of this.config.nirathSignals) {
      if (text.includes(signal)) {
        matches.push(signal);
      }
    }
    return matches.length > 0 ? { matches } : null;
  }

  /**
   * 提取时长（秒）
   */
  _extractDuration(text) {
    // 【P2-5 修复】显式单位映射，避免 toString().includes 脆弱判断
    const patterns = [
      { regex: /(\d+)\s*秒/, unit: 'second' },
      { regex: /(\d+)\s*分钟/, unit: 'minute' },
      { regex: /(\d+)\s*s/i, unit: 'second' },
      { regex: /(\d+)\s*min/i, unit: 'minute' }
    ];

    for (const { regex, unit } of patterns) {
      const match = text.match(regex);
      if (match) {
        let value = parseInt(match[1]);
        if (unit === 'minute') value *= 60;
        return value;
      }
    }
    return null;
  }

  /**
   * 提取神兽 ID
   */
  _extractBeastId(text) {
    const beastPatterns = {
      'taotie': ['示例神兽', 'tao-tie', 'taotie'],
      'qilin': ['麒麟', 'qilin'],
      'fenghuang': ['凤凰', '凤凰', 'fenghuang'],
      'xiezhi': ['獬豸', 'xiezhi'],
      'bixie': ['辟邪', 'bixie']
    };

    for (const [id, keywords] of Object.entries(beastPatterns)) {
      for (const keyword of keywords) {
        if (text.includes(keyword)) {
          return id;
        }
      }
    }
    return null;
  }

  /**
   * 构建 UserIntent 对象
   */
  _buildUserIntent(analysis, metadata, layer, rawInput) {
    const isHybrid = !!analysis.hybrid_mode;
    
    return {
      intent_id: this._generateUUID(),
      raw_input: metadata.raw_input || rawInput || '',
      parsed: {
        narrative_mode: isHybrid ? 'hybrid' : analysis.primary_type,
        primary_mode: analysis.primary_type,
        secondary_modes: analysis.secondary_type ? [analysis.secondary_type] : [],
        hybrid_config: isHybrid ? {
          mode_weights: { [analysis.primary_type]: 0.6, [analysis.secondary_type]: 0.4 },
          handover_points: ['climax', 'resolution'],
          hybrid_mode_name: analysis.hybrid_mode
        } : null
      },
      metadata: {
        // 【v2.1.10-fix 时长断层】先展开 metadata，再显式赋值关键字段。
        // 原实现把 ...metadata 放在最后，且优先级为"文本提取 > metadata 确认值"，
        // 已被人工确认的 target_duration 可能被文本正则提取值静默覆盖。
        ...metadata,
        title: metadata.title || '未命名项目',
        // 优先级：metadata 已确认时长 > 文本提取时长 > 默认 60s
        target_duration: metadata.target_duration || analysis.target_duration || 60,
        // 【v2.1.4-fix13-审计修复】不硬编码平台，从 metadata 获取或设为通用
        target_platform: metadata.target_platform || ['general'],
        language: metadata.language || 'zh-CN',
        style_tags: metadata.style_tags || ['hyper-realistic', 'cinematic', 'epic'],
        world_setting: analysis.world_setting || metadata.world_setting || 'default',
        featured_beast_id: analysis.featured_beast_id || metadata.featured_beast_id || null,
        // v1.2.7-fix-A8: 移除 示例角色 硬编码，改为通用默认值
        protagonist: metadata.protagonist || 'protagonist',
        // 【方案A-fix】原始故事文本直通下游，保留用户完整输入
        _originalStoryText: metadata._originalStoryText || metadata._creativeTheme?._originalStoryText || ''
      },
      constraints: {
        // v2.1.4-fix13-审计修复: 超级小香宝标准 3000
        max_prompt_length: metadata.max_prompt_length || 3000,
        reference_image_count: metadata.reference_image_count || 2,
        forbidden_elements: metadata.forbidden_elements || ['voiceover', 'metal_gloss', 'unnatural_eye_color']
      },
      analysis: {
        layer,
        confidence: analysis.confidence,
        scores: analysis.scores
      }
    };
  }

  _generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }
}

module.exports = { IntentParser };