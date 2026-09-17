/**
 * 【角色提示词构建器】Character Prompt Builder v3.0
 * 
 * 升级说明（v3.0）：
 * - 集成特征提炼Agent（CharacterFeatureExtractor）
 * - 新增Step 0：从素材文本自动提炼特征
 * - 新增禁止清单层（Layer 0）
 * - 新增数量确认机制（阿拉伯数字+空间分布，不写编号）
 * - 新增陷阱词识别与规避
 * 
 * 6层提示词结构体系 + 3层Prompt工程规范：
 * 层0：禁止清单（Forbidden）— 绝对不可出现
 * 层1：主体（Subject）— 角色基础身份
 * 层2：服装（Clothing）— 衣着描述
 * 层3：配饰（Accessories）— 随身物品
 * 层4：表情（Expression）— 面部情绪
 * 层5：环境（Environment）— 场景背景
 * 层6：技术（Technical）— 光影/质感/相机
 * 
 * 职责：
 * - 从角色档案构建结构化提示词
 * - 支持从素材文本自动提炼（集成Agent）
 * - 支持分层启用/禁用
 * - 自动字数控制（980英文字符上限）
 * - 支持角度/场景定制
 */

const CharacterFeatureExtractor = require('./character-feature-extractor');

class CharacterPromptBuilder {
  constructor(config = {}) {
    this.config = {
      maxChineseChars: config.maxChineseChars ?? 1500,  // 统一为980英文字符上限
      maxEnglishChars: config.maxEnglishChars ?? 1500,   // 统一为980英文字符上限
      defaultLayerWeights: config.defaultLayerWeights ?? {
        forbidden: 1.0,
        subject: 1.0,
        clothing: 1.0,
        accessories: 0.8,
        expression: 0.9,
        environment: 0.7,
        technical: 0.6
      },
      priorityOrder: config.priorityOrder ?? [
        'forbidden', 'subject', 'clothing', 'expression', 'accessories', 'technical', 'environment'
      ],
      enableAgent: config.enableAgent ?? true,  // 是否启用特征提炼Agent
      ...config
    };
    
    this.featureExtractor = new CharacterFeatureExtractor();
    
    // 层模板定义
    this.LAYER_TEMPLATES = {
      subject: {
        name: '主体',
        build: (character, angle, sceneType) => {
          const parts = [];
          const vi = character.visualIdentity;
          
          // v6.5.31-fix: 优先从完整角色档案提取差异化数据
          const baseId = character.baseIdentity || character.identity || {};
          const name = baseId.name || character.name || character.id || '角色';
          const age = baseId.age ?? character.age ?? vi?.age ?? null;
          const gender = baseId.gender || character.gender || vi?.gender || 'unknown';
          const role = baseId.role || character.role || baseId.occupation || character.occupation || '';
          
          // 1. 名字（必须保留）
          parts.push(name);
          
          // 2. 年龄 + 性别（差异化关键）
          const ageText = age !== null ? `${age}岁` : '';
          const genderMap = { male: '男性', female: '女性', boy: '男孩', girl: '女孩', unknown: '' };
          const genderText = genderMap[gender] || gender || '';
          if (ageText || genderText) {
            parts.push(`${ageText}${genderText}`);
          }
          
          // 3. 角色身份（根据 role 推断）
          const rolePrefix = this._getRolePrefix(role, name);
          if (rolePrefix) {
            parts.push(rolePrefix);
          }
          
          // 4. 原有 visualIdentity 数据（fallback）
          if (vi?.baseIdentity) {
            if (typeof vi.baseIdentity === 'string') {
              parts.push(vi.baseIdentity);
            } else if (typeof vi.baseIdentity === 'object') {
              const bi = vi.baseIdentity;
              const desc = [bi.name, bi.age ? `${bi.age}岁` : '', bi.gender, bi.species].filter(Boolean).join('，');
              if (desc) parts.push(desc);
            }
          }
          
          // 5. 物种/种族
          if (vi?.species && vi.species !== '人类') {
            parts.push(`${vi.species}`);
          }
          
          // 6. 核心外观（strict级别的）
          if (vi?.appearance) {
            const strictFeatures = Object.entries(vi.appearance)
              .filter(([_, data]) => data.consistency === 'strict')
              .map(([_, data]) => data.promptFragment)
              .filter(Boolean);
            parts.push(...strictFeatures);
          }
          
          // 7. 角度特定描述
          if (vi?.angles && vi.angles[angle]) {
            parts.push(vi.angles[angle].promptExtra);
          }
          
          return parts.join('，');
        }
      },
      
      clothing: {
        name: '服装',
        build: (character, angle, sceneType) => {
          const parts = [];
          const vi = character.visualIdentity;
          
          // v6.5.31-fix: 优先从角色档案提取服装信息
          const baseId = character.baseIdentity || character.identity || {};
          const role = baseId.role || character.role || '';
          const gender = baseId.gender || character.gender || vi?.gender || 'unknown';
          const age = baseId.age ?? character.age ?? vi?.age ?? null;
          const isChild = age !== null && age < 14;
          
          // 1. 从 appearance 提取服装
          const clothing = vi?.appearance?.clothing;
          if (clothing?.promptFragment) {
            parts.push(clothing.promptFragment);
          } else {
            // 2. 根据角色身份推断默认服装
            const defaultClothing = this._getDefaultClothing(role, gender, age, character.name);
            if (defaultClothing) {
              parts.push(`穿${defaultClothing}`);
            }
          }
          
          // 场景特定服装变化（如需要）
          if (sceneType === 'formal' && character.alternativeOutfits?.formal) {
            parts.push(`穿着${character.alternativeOutfits.formal}`);
          } else if (sceneType === 'action' && character.alternativeOutfits?.action) {
            parts.push(`穿着${character.alternativeOutfits.action}`);
          }
          
          return parts.join('，');
        }
      },
      
      accessories: {
        name: '配饰',
        build: (character, angle, sceneType) => {
          const parts = [];
          const accessories = character.visualIdentity?.appearance?.accessories;
          
          if (accessories?.promptFragment) {
            parts.push(accessories.promptFragment);
          }
          
          // 场景特定配饰
          if (sceneType === 'exploration' && character.props?.compass) {
            parts.push('手持指南针');
          }
          
          return parts.join('，');
        }
      },
      
      expression: {
        name: '表情',
        build: (character, angle, sceneType, customExpression) => {
          const parts = [];
          
          // v6.5.31-fix: 根据角色身份调整表情气质
          const baseId = character.baseIdentity || character.identity || {};
          const role = baseId.role || character.role || '';
          const gender = baseId.gender || character.gender || character.visualIdentity?.gender || 'unknown';
          const age = baseId.age ?? character.age ?? character.visualIdentity?.age ?? null;
          const isChild = age !== null && age < 14;
          
          // 使用自定义表情（如果提供）
          if (customExpression) {
            parts.push(customExpression);
          } else {
            // 根据角色身份推断默认表情
            const defaultExpressions = {
              opening: '友好微笑，眼神明亮',
              explanation: '专注认真，眉头微蹙思考',
              demonstration: '自信从容，手势配合讲解',
              interaction: '亲切温和，略带好奇',
              closing: '温暖满足，微微颔首',
              tense: '紧张担忧，抿紧嘴唇',
              happy: '开心兴奋，眼睛弯成月牙',
              sad: '忧伤沉思，眼尾微红'
            };
            
            // 根据角色身份调整表情
            let expr = defaultExpressions[sceneType] || defaultExpressions.interaction;
            
            if (isChild) {
              expr = '好奇活泼，眼睛睁大，充满求知欲';
            } else if (role === 'nurse' || role === 'doctor') {
              expr = '亲和专业，微笑自然，眼神温暖';
            } else if (role === 'coach') {
              expr = '沉稳干练，眼神坚定，自信从容';
            }
            
            parts.push(expr);
          }
          
          // 添加口播动作（如果角色有speechStyle）
          if (character.speechStyle?.habits && sceneType?.includes?.('dialogue')) {
            const habit = character.speechStyle.habits[0];
            if (habit) parts.push(habit);
          }
          
          // 嘴部动作（用于口播场景）
          if (sceneType === 'dialogue' || sceneType === 'explanation') {
            parts.push('嘴巴微张正在说话');
          }
          
          return parts.join('，');
        }
      },
      
      environment: {
        name: '环境',
        build: (character, angle, sceneType, customEnvironment) => {
          const parts = [];
          
          // v6.5.31-fix: 根据角色身份推断环境
          const baseId = character.baseIdentity || character.identity || {};
          const role = baseId.role || character.role || '';
          const lowerRole = (role || '').toLowerCase();
          
          // 使用自定义环境（如果提供）
          if (customEnvironment) {
            parts.push(customEnvironment);
          } else {
            // 根据角色身份推断环境
            const roleEnvMap = {
              'nurse': '健康科普演播室',
              'doctor': '医院门诊环境',
              'coach': '健身房或训练场',
              'host': '演播室主持场景',
              'expert': '讲座或访谈场景',
              'patient': '病房或休息区',
              'teacher': '教室或讲堂',
              'audience': '观众席'
            };
            
            const defaultEnvs = {
              opening: '明亮的室内环境，柔和自然光',
              explanation: '简洁背景，突出人物',
              demonstration: '与主题相关的场景背景',
              interaction: '自然生活化场景',
              closing: '温暖氛围，夕阳光线',
              portrait: '纯色背景，摄影棚布光'
            };
            
            const env = roleEnvMap[lowerRole] || defaultEnvs[sceneType] || defaultEnvs.explanation;
            parts.push(env);
          }
          
          return parts.join('，');
        }
      },
      
      technical: {
        name: '技术',
        build: (character, angle, sceneType) => {
          const parts = [];
          
          // 渲染风格（从角色档案）
          const style = character.visualIdentity?.style || character.portraitConfig?.style;
          if (style) {
            // 提取技术关键词
            const techKeywords = [
              '极致写实', '真实摄影质感', '电影级光影',
              '电影级光影', '8K品质', '极致细节',
              '次世代游戏角色级精度', '毛孔级纹理'
            ];
            
            const matched = techKeywords.filter(kw => style.includes(kw));
            if (matched.length > 0) {
              parts.push(...matched.slice(0, 3)); // 最多3个技术词
            }
          }
          
          // 默认技术增强
          const defaults = [
            '摄影棚三点布光',
            '背景虚化',
            '专业人像摄影'
          ];
          parts.push(...defaults);
          
          return parts.join('，');
        }
      }
    };
  }
  
  /**
   * 【v6.5.31-fix】角色前缀映射 — 根据身份推断角色类型
   */
  _getRolePrefix(role, name) {
    const roleMap = {
      'nurse': '护士',
      'doctor': '医生',
      'coach': '教练',
      'host': '主持人',
      'expert': '专家',
      'patient': '患者',
      'student': '学生',
      'teacher': '教师',
      'audience': '听众',
      'demonstrator': '演示者'
    };
    
    // 从 name 推断
    if (name.includes('教练') || name.includes('coach')) return '教练';
    if (name.includes('护士') || name.includes('nurse')) return '护士';
    if (name.includes('医生') || name.includes('doctor')) return '医生';
    if (name.includes('小') && name.includes('G')) return '男孩'; // 小G
    
    // 从 role 推断
    const lowerRole = (role || '').toLowerCase();
    return roleMap[lowerRole] || role || '';
  }

  /**
   * 【v6.5.31-fix】默认服装映射 — 根据角色身份推断
   */
  _getDefaultClothing(role, gender, age, name) {
    const isChild = age !== null && age < 14;
    const lowerRole = (role || '').toLowerCase();

    // 从名字推断（优先）
    if (name && (name.includes('小') || name.includes('G'))) {
      if (isChild) return '休闲运动童装';
    }
    if (name && name.includes('护士')) return '白色护士服';
    if (name && name.includes('教练')) return '专业运动教练服';

    // 儿童默认
    if (isChild) {
      if (gender === 'male' || gender === 'boy') return '休闲运动童装';
      if (gender === 'female' || gender === 'girl') return '可爱连衣裙';
      return '童装';
    }

    // 角色映射
    const clothingMap = {
      'nurse': '白色护士服',
      'doctor': '白大褂',
      'coach': '专业运动教练服',
      'host': '正装',
      'expert': '商务休闲装',
      'patient': '病号服',
      'teacher': '衬衫西裤',
      'student': isChild ? '童装' : '校服',
      'audience': '便装'
    };

    return clothingMap[lowerRole] || (
      gender === 'female' ? '职业套装' :
      gender === 'male' ? '衬衫' : '便装'
    );
  }

  /**
   * 构建完整角色提示词
   * @param {Object} character - 角色档案
   * @param {Object} options - 构建选项
   * @returns {Object} { prompt, layers, stats }
   */
  build(character, options = {}) {
    const {
      angle = 'threeQuarter',
      sceneType = 'interaction',
      expression,
      environment,
      enabledLayers = Object.keys(this.LAYER_TEMPLATES),
      layerWeights = {},
      maxChars = this.config.maxChineseChars
    } = options;
    
    // 合并权重
    const weights = { ...this.config.defaultLayerWeights, ...layerWeights };
    
    // 按优先级排序层
    const orderedLayers = this.config.priorityOrder
      .filter(l => enabledLayers.includes(l))
      .map(layerId => ({
        id: layerId,
        ...this.LAYER_TEMPLATES[layerId],
        weight: weights[layerId] || 1.0
      }));
    
    // 构建各层内容
    const layers = {};
    for (const layer of orderedLayers) {
      const content = layer.build(character, angle, sceneType, 
        layer.id === 'expression' ? expression : 
        layer.id === 'environment' ? environment : undefined);
      
      if (content && content.trim()) {
        layers[layer.id] = {
          name: layer.name,
          content,
          weight: layer.weight,
          charCount: this._countChineseChars(content)
        };
      }
    }
    
    // 字数控制：按权重分配空间，超限时从低权重层裁剪
    const finalLayers = this._allocateSpace(layers, maxChars);
    
    // 组装最终prompt
    const promptParts = orderedLayers
      .filter(l => finalLayers[l.id] && finalLayers[l.id].included)
      .map(l => finalLayers[l.id].content);
    
    const prompt = promptParts.join('，');
    
    // 统计
    const stats = {
      totalChars: this._countChineseChars(prompt),
      maxChars,
      utilization: (this._countChineseChars(prompt) / maxChars * 100).toFixed(1) + '%',
      layerCount: Object.values(finalLayers).filter(l => l.included).length,
      layerDetails: finalLayers
    };
    
    return {
      prompt,
      layers: finalLayers,
      stats,
      // 负面提示词（通用）
      negativePrompt: this._buildNegativePrompt(character)
    };
  }
  
  /**
   * 构建负面提示词
   */
  _buildNegativePrompt(character) {
    const defaults = [
      'western face', 'caucasian', 'european', 'american',
      'blonde hair', 'blue eyes', 'red eyes', 'yellow eyes', 'green eyes', 'purple eyes', 'orange eyes',
      'glowing eyes', 'fire in eyes', 'light beams from eyes', 'neon eyes', 'fluorescent eyes',
      'big round eyes', 'cat eyes with vertical slit pupils on humans',
      'cartoon style', 'anime style', '3D render',
      'plastic skin', 'doll-like', 'western nose',
      'high nose bridge', 'pointed chin', 'V-shaped face'
    ];
    
    // 根据角色类型添加特定负面词
    if (character.visualIdentity?.appearance?.hair?.promptFragment?.includes('黑色')) {
      defaults.push('blonde hair', 'brown hair', 'red hair', 'colorful hair');
    }
    
    return [...new Set(defaults)].join(', ');
  }
  
  /**
   * 字数分配算法
   */
  _allocateSpace(layers, maxChars) {
    const result = {};
    let remaining = maxChars;
    
    // 先标记所有层为待包含
    for (const [id, layer] of Object.entries(layers)) {
      result[id] = { ...layer, included: true, trimmed: false };
    }
    
    // 计算总预估字数
    const totalNeeded = Object.values(result)
      .filter(l => l.included)
      .reduce((sum, l) => sum + l.charCount, 0);
    
    if (totalNeeded <= maxChars) {
      // 空间充足，无需裁剪
      return result;
    }
    
    // 需要裁剪：按权重从低到高裁剪
    const sortedByWeight = Object.entries(result)
      .filter(([_, l]) => l.included)
      .sort((a, b) => a[1].weight - b[1].weight);
    
    for (const [id, layer] of sortedByWeight) {
      if (remaining <= 0) {
        result[id].included = false;
        continue;
      }
      
      // 按权重比例分配空间
      const weightRatio = layer.weight / 
        sortedByWeight.filter(([_, l]) => l.included).reduce((s, [_, l]) => s + l.weight, 0);
      
      const allocated = Math.floor(maxChars * weightRatio);
      
      if (layer.charCount > allocated) {
        // 裁剪内容（保留前半部分）
        result[id].content = this._trimToLength(layer.content, allocated);
        result[id].trimmed = true;
        result[id].originalCharCount = layer.charCount;
        result[id].charCount = this._countChineseChars(result[id].content);
      }
      
      remaining -= result[id].charCount;
    }
    
    return result;
  }
  
  /**
   * 裁剪文本到指定长度（尽量在标点处截断）
   */
  _trimToLength(text, maxLen) {
    if (this._countChineseChars(text) <= maxLen) return text;
    
    // 简单策略：截断到maxLen字符，找最近的标点
    let trimmed = text.substring(0, maxLen);
    const lastPunct = Math.max(
      trimmed.lastIndexOf('，'),
      trimmed.lastIndexOf('。'),
      trimmed.lastIndexOf('、')
    );
    
    if (lastPunct > maxLen * 0.7) {
      trimmed = trimmed.substring(0, lastPunct + 1);
    }
    
    return trimmed;
  }
  
  /**
   * 计算中文字符数（近似）
   */
  _countChineseChars(text) {
    if (!text) return 0;
    // 统计所有非ASCII字符 + 英文单词数（每个英文单词≈2个中文字）
    const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    const englishWords = (text.match(/[a-zA-Z]+/g) || []).length;
    return chineseChars + englishWords * 2;
  }
  
  /**
   * 【v6.2-patch88-fix】极简构建 — 保留核心视觉锚点 + 文字锚点防漂移
   * 
   * 用途：视频渲染 prompt 中角色描述
   * 原则：
   * 1. 保留名字
   * 2. 保留2-3个核心特征
   * 3. 【关键修复】对于神兽/特殊角色，额外保留≥30字符的特征描述作为文字锚点
   * 4. 文字锚点必须包含物种核心特征（如"羊身人面，腋下生双眼，巨口利齿"）
   * 5. 禁止词明确写入：禁止蜥蜴/恐龙/爬行动物特征
   * 
   * @param {Object} character - 角色档案
   * @param {Object} options - { maxChars: 40, preserveAnchors: true, anchorMinChars: 30 }
   * @returns {string} 精简描述 + 文字锚点（如 "tao-tie，羊身人面神话生物，腋下生双眼，巨口布满利齿，禁止蜥蜴特征"）
   */
  buildMinimal(character, options = {}) {
    const { maxChars = 40, preserveAnchors = true, anchorMinChars = 30 } = options;
    const vi = character.visualIdentity;
    const parts = [];
    
    // 1. 名字（必须保留）
    parts.push(character.name || character.id || '角色');
    
    // 2. 核心视觉锚点（最多2-3个，从 baseIdentity 或 appearance 提取）
    let coreFeatures = [];
    
    if (vi.baseIdentity) {
      // baseIdentity 是逗号分隔的描述，取前2-3个特征
      const features = vi.baseIdentity.split('，').filter(f => f.trim());
      // 过滤掉非视觉特征（如"来自Nirath"、"28岁"等）
      const visualFeatures = features.filter(f => 
        !f.includes('岁') && !f.includes('来自') && !f.includes('角色')
      );
      coreFeatures = visualFeatures.slice(0, 3);
    }
    
    // 如果 baseIdentity 没有视觉特征，从 appearance 的 strict 特征中提取
    if (coreFeatures.length === 0 && vi.appearance) {
      const strictFeatures = Object.entries(vi.appearance)
        .filter(([_, data]) => data && data.consistency === 'strict' && data.promptFragment)
        .map(([_, data]) => data.promptFragment)
        .filter(Boolean)
        .slice(0, 3);
      coreFeatures.push(...strictFeatures);
    }
    
    // 3. 组装基础极简描述：名字 + 核心特征
    let baseResult;
    if (coreFeatures.length > 0) {
      baseResult = `${parts[0]}(${coreFeatures.join('，')})`;
    } else {
      baseResult = parts[0];
    }
    
    // 4. 截断到 maxChars（优先保留特征，截断时保留括号内完整）
    if (this._countChineseChars(baseResult) > maxChars) {
      // 如果超限，只保留名字+1个最核心的特征
      const firstFeature = coreFeatures[0] || '';
      if (firstFeature) {
        baseResult = `${parts[0]}(${firstFeature})`;
      } else {
        baseResult = parts[0];
      }
    }
    
    // 5. 【v6.2-patch88-fix】文字锚点保留（关键修复）
    // 如果启用 preserveAnchors，为神兽/特殊角色追加文字锚点描述
    let anchorText = '';
    if (preserveAnchors) {
      anchorText = this._buildCharacterAnchor(character, anchorMinChars);
    }
    
    // 6. 最终组装
    if (anchorText) {
      return `${baseResult}，${anchorText}`;
    }
    return baseResult;
  }
  
  /**
   * 【v6.2-patch88-fix】构建角色文字锚点 — 防止Seedance忽略参考图
   * 
   * 核心原则：
   * 1. 多角色镜头中，每个角色必须有独立 ≥30字符的文字描述
   * 2. 文字锚点必须包含物种核心特征（如"羊身人面，腋下生双眼，巨口利齿"）
   * 3. 必须包含"禁止XX特征"来排除错误方向
   * 
   * @param {Object} character - 角色档案
   * @param {number} minChars - 最小字符数
   * @returns {string} 文字锚点描述
   */
  _buildCharacterAnchor(character, minChars = 30) {
    const vi = character.visualIdentity;
    const anchorParts = [];
    
    // 1. 物种/种族识别
    if (vi.species && vi.species !== '人类') {
      anchorParts.push(`${vi.species}`);
    }
    
    // 2. 从 appearance 提取严格级别的核心特征
    if (vi.appearance) {
      const strictFeatures = Object.entries(vi.appearance)
        .filter(([_, data]) => data && data.consistency === 'strict' && data.promptFragment)
        .map(([key, data]) => ({ key, fragment: data.promptFragment }));
      
      // 按重要性排序：面部 > 身体 > 其他
      const priorityOrder = ['face', 'head', 'body', 'skin', 'eyes', 'mouth', 'hair', 'ears', 'hands', 'feet', 'tail', 'wings'];
      strictFeatures.sort((a, b) => {
        const idxA = priorityOrder.indexOf(a.key);
        const idxB = priorityOrder.indexOf(b.key);
        if (idxA >= 0 && idxB >= 0) return idxA - idxB;
        if (idxA >= 0) return -1;
        if (idxB >= 0) return 1;
        return 0;
      });
      
      // 提取前3-4个关键特征
      const keyFragments = strictFeatures.slice(0, 4).map(f => f.fragment);
      anchorParts.push(...keyFragments);
    }
    
    // 3. 从 baseIdentity 补充物种特征
    if (vi.baseIdentity) {
      const identityFeatures = vi.baseIdentity.split('，').filter(f => {
        const trimmed = f.trim();
        // 保留物种特征词：羊身、人面、巨口、利齿、腋下等
        return trimmed.includes('羊') || trimmed.includes('人面') || 
               trimmed.includes('巨口') || trimmed.includes('利齿') ||
               trimmed.includes('腋下') || trimmed.includes('双眼') ||
               trimmed.includes('四足') || trimmed.includes('神兽');
      });
      anchorParts.push(...identityFeatures.slice(0, 2));
    }
    
    // 4. 去重
    const uniqueParts = [...new Set(anchorParts.filter(Boolean))];
    
    // 5. 组装锚点文本
    let anchorText = uniqueParts.join('，');
    
    // 6. 如果锚点文本太短，补充通用物种锚点
    if (this._countChineseChars(anchorText) < minChars) {
      // 根据角色类型补充
      const speciesAnchors = {
        'tao-tie': '羊身人面神话生物，腋下生双眼，巨口布满利齿，禁止蜥蜴/恐龙/爬行动物特征',
        'zhu-long': '人面蛇身赤色神兽，睁眼为昼闭眼为夜，禁止西方龙/蜥蜴特征',
        'jiu-wei': '九尾狐神兽，人面狐身，九条尾巴，禁止普通狐狸/犬科特征'
      };
      
      const speciesAnchor = speciesAnchors[character.id] || speciesAnchors[character.name];
      if (speciesAnchor) {
        anchorText = speciesAnchor;
      }
    }
    
    // 7. 最终检查：如果仍然太短，追加禁止词
    if (this._countChineseChars(anchorText) < minChars) {
      anchorText += '，禁止任何地球已知动物特征融合';
    }
    
    return anchorText;
  }
  
  /**
   * 快速构建（简化版，只返回prompt字符串）
   */
  buildQuick(character, options = {}) {
    return this.build(character, options).prompt;
  }
  
  /**
   * 【v3.0新增】从素材文本自动提炼并构建Prompt（Agent驱动）
   * 
   * 这是队长要求的核心升级：
   * - 输入角色素材文本
   * - 自动提炼特征 → 识别陷阱词 → 生成三层Prompt
   * - 输出可直接用于API调用的完整Prompt
   * 
   * @param {string} sourceText - 角色设定原文
   * @param {string} roleType - 角色类型（beast/human/narrator）
   * @param {string} roleId - 角色ID
   * @param {string} roleName - 角色名称
   * @param {string} angle - 角度（front/threeQuarter/topDown/side）
   * @returns {Object} { prompt, characterCard, analysis }
   */
  buildFromSource(sourceText, roleType, roleId, roleName, angle = 'front') {
    if (!this.config.enableAgent) {
      throw new Error('Agent模式未启用，请设置 enableAgent: true');
    }
    
    console.log(`🔍 [Agent] 从素材提炼角色: ${roleName}`);
    
    // Step 1: 使用特征提炼Agent分析素材（Agent提取角色特定内容）
    const extraction = this.featureExtractor.extract(sourceText, roleType, roleId, roleName);
    
    // Step 2: 生成角度特异性描述（Agent生成）
    const angleDesc = extraction.angleSpecs[angle] || `正面全身，站立标准姿态`;
    
    // Step 3: 系统层只提供技术前缀框架（通用）
    const technicalPrefix = `超写实3D数字渲染，虚幻引擎5体积光散射，CG幻想生物设计，`;
    
    // Step 4: 组装完整Prompt（通用框架 + Agent提取的角色特定内容）
    const fullPrompt = `${technicalPrefix}${angleDesc}，\n${extraction.prompt}`;
    
    // Step 5: 字数检查（通用规则）
    const charCount = this._countChineseChars(fullPrompt);
    const status = charCount <= this.config.maxChineseChars ? '✅' : '⚠️';
    console.log(`${status} Prompt字数: ${charCount}/${this.config.maxChineseChars}`);
    
    return {
      prompt: fullPrompt,
      characterCard: extraction.characterCard,
      angleSpecs: extraction.angleSpecs,
      analysis: extraction.analysis,
      metadata: {
        roleId,
        roleName,
        roleType,
        angle,
        charCount,
        promptEngine: 'character-feature-extractor-v1.0',
        method: 'agent-driven'
      }
    };
  }
  
  /**
   * 【v3.0新增】批量生成多角色定妆照Prompt
   * 
   * @param {Array} roles - [{ sourceText, roleType, roleId, roleName, angles }]
   * @returns {Array} 每个角色的Prompt列表
   */
  batchBuildFromSource(roles) {
    const results = [];
    
    for (const role of roles) {
      const roleResults = {
        roleId: role.roleId,
        roleName: role.roleName,
        prompts: []
      };
      
      const angles = role.angles || ['front', 'threeQuarter', 'topDown', 'side'];
      
      for (const angle of angles) {
        try {
          const result = this.buildFromSource(
            role.sourceText,
            role.roleType,
            role.roleId,
            role.roleName,
            angle
          );
          roleResults.prompts.push({
            angle,
            prompt: result.prompt,
            charCount: result.metadata.charCount,
            status: 'success'
          });
        } catch (error) {
          roleResults.prompts.push({
            angle,
            status: 'failed',
            error: error.message
          });
        }
      }
      
      results.push(roleResults);
    }
    
    return results;
  }
  
  /**
   * 分析现有prompt的层结构
   */
  analyze(prompt) {
    // 简单分析：按常见关键词归类
    const analysis = {
      detectedLayers: [],
      layerCoverage: {}
    };
    
    const layerKeywords = {
      subject: ['男孩', '女孩', '男人', '女人', '亚洲', '中国', '岁', '身高'],
      clothing: ['穿着', '外套', '衬衫', '裤子', '裙子', '鞋', '服装'],
      accessories: ['佩戴', '手持', '腰间', '背包', '帽子', '眼镜'],
      expression: ['表情', '微笑', '眼神', '皱眉', '开心', '严肃'],
      environment: ['背景', '场景', '室内', '室外', '房间', '森林'],
      technical: ['光影', '渲染', '摄影', '电影级', '灯光']
    };
    
    for (const [layer, keywords] of Object.entries(layerKeywords)) {
      const found = keywords.filter(kw => prompt.includes(kw));
      analysis.layerCoverage[layer] = {
        found: found.length > 0,
        keywords: found,
        coverage: found.length / keywords.length
      };
      if (found.length > 0) {
        analysis.detectedLayers.push(layer);
      }
    }
    
    return analysis;
  }
}

module.exports = { CharacterPromptBuilder };
