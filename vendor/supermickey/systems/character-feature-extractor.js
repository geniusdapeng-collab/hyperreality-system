/**
 * 【角色特征提炼Agent】Character Feature Extraction Agent v3.0
 * 
 * v3.0 重大升级：
 * - 支持三大类场景的通用定妆照生成
 *   1. 主题驱动：用户只给主题/角色名 → 知识库查找/LLM推理
 *   2. 描述驱动：用户给详细描述 → 严格遵从
 *   3. 知识驱动：用户给耳熟能详角色 → 知识库加载默认形象
 * - 陷阱词"事前清理"：提取前先扫描替换，避免矛盾指令
 * - 中文数字转换支持复杂数字（十六、二十四）
 * - 增强"形如X"理解：X如果是陷阱词，展开为安全形态描述
 * 
 * 职责：
 * - 输入：角色设定文档（Markdown/纯文本）或主题词
 * - 输出：标准化character-card.json + 优化Prompt
 */

const InputSceneClassifier = require('./input-scene-classifier');
const IntentPriorityLayer = require('./intent-priority-layer');
const ConstraintArbitrationEngine = require('./constraint-arbitration-engine');
const fs = require('fs').promises;
const fss = require('fs');
const path = require('path');

class CharacterFeatureExtractor {
  constructor(config = {}) {
    this.config = {
      // 陷阱词库：AI容易误解的词汇 → 替换策略
      trapWordLibrary: config.trapWordLibrary || this.getDefaultTrapWords(),
      // 禁止清单模板：按角色类型
      forbiddenTemplates: config.forbiddenTemplates || this.getDefaultForbiddenTemplates(),
      // 技术规格模板
      technicalTemplate: config.technicalTemplate || this.getDefaultTechnicalTemplate(),
      // v8.0 输入理解层
      enableSceneClassifier: config.enableSceneClassifier ?? true,
      enableIntentLayer: config.enableIntentLayer ?? true,
      enableArbitration: config.enableArbitration ?? true,
      // 知识库路径
      knowledgeBasePath: config.knowledgeBasePath || './characters',
      // 事前清理开关
      enablePreClean: config.enablePreClean ?? true,
      ...config
    };
    
    // v8.0 新增组件
    this.sceneClassifier = new InputSceneClassifier();
    this.intentLayer = new IntentPriorityLayer();
    this.arbitrationEngine = new ConstraintArbitrationEngine();
    
    // 加载知识库缓存
    this.knowledgeBaseCache = new Map();
  }

  /**
   * 主入口：通用角色特征提取（支持三大类场景）
   * 
   * 场景1（主题驱动）：sourceText是主题词/角色名 → 知识库查找/推理
   * 场景2（描述驱动）：sourceText含详细描述 → 正则提取+遵从
   * 场景3（知识驱动）：sourceText是耳熟能详角色 → 知识库加载默认形象
   * 
   * @param {string} sourceText - 角色设定原文或主题词
   * @param {string} roleType - 角色类型（beast/human/narrator）
   * @param {string} roleId - 角色ID
   * @param {string} roleName - 角色名称
   * @returns {Object} { characterCard, prompt, analysis, scene, priorities, profile }
   */
  extract(sourceText, roleType, roleId, roleName) {
    console.log(`🔍 开始提炼角色特征: ${roleName} (${roleType})`);
    
    // === Step 0: 场景分类 ===
    const scene = this.config.enableSceneClassifier 
      ? this.sceneClassifier.classify(sourceText)
      : { scene: 'B_DESCRIPTIVE', confidence: 1.0 };
    console.log(`🔍 场景检测: ${scene.scene} (置信度: ${scene.confidence})`);
    
    // === 分场景处理 ===
    let baseProfile = null;
    let features = null;
    let priorities = null;
    let arbitrationResult = null;
    
    switch (scene.scene) {
      case 'A_SPARSE':
        // 场景1/3：信息稀疏 → 知识库查找/推理
        const knowledgeResult = this.handleSparseInput(sourceText, roleType, roleId, roleName);
        baseProfile = knowledgeResult.profile;
        features = knowledgeResult.features;
        console.log(`📚 知识库加载: ${knowledgeResult.source}`);
        break;
        
      case 'B_CONSTRAINT_RICH':
      case 'B_DESCRIPTIVE':
      case 'MIXED':
        // 场景2：约束丰富/描述性文本 → 意图分层+特征提取+约束仲裁
        if (this.config.enableIntentLayer) {
          priorities = this.intentLayer.parse(sourceText);
          console.log(`📊 意图分层: P0=${priorities.metadata.p0Count}, P1=${priorities.metadata.p1Count}, P2=${priorities.metadata.p2Count}`);
        }
        
        // 事前清理陷阱词（v3.0新增）
        let cleanText = sourceText;
        if (this.config.enablePreClean) {
          cleanText = this.preCleanTrapWords(sourceText);
          if (cleanText !== sourceText) {
            console.log(`🧹 事前清理: 已替换陷阱词`);
          }
        }
        
        // 特征提取（使用清理后的文本）
        features = this.extractFeatures(cleanText);
        console.log(`✅ 基础特征提取: ${Object.keys(features).filter(k => features[k].length > 0).join(', ')}`);
        
        // 如果特征很少，补充知识库/主题推断（v3.0增强）
        const featureCount = Object.values(features).flat().length;
        if (featureCount < 2) {
          console.log(`⚠️ 特征稀疏(${featureCount}项)，补充知识库/主题推断...`);
          const supplement = this.handleSparseInput(sourceText, roleType, roleId, roleName);
          
          // 合并特征：用户输入的特征优先
          for (const key of Object.keys(features)) {
            if (features[key].length === 0 && supplement.features[key]?.length > 0) {
              features[key] = supplement.features[key];
            }
          }
          
          // 使用补充的Profile增强基础档案
          if (supplement.profile) {
            baseProfile = this.mergeProfiles(supplement.profile, baseProfile);
          }
        }
        
        // 如果仍然没有Profile，从特征构建
        if (!baseProfile) {
          baseProfile = this.buildCharacterCard(features, roleId, roleName, roleType);
        }
        
        // 约束仲裁
        if (this.config.enableArbitration && priorities && 
            (priorities.P0_HARD.length > 0 || priorities.P1_FACT.length > 0)) {
          console.log(`⚖️ 启动约束仲裁引擎...`);
          arbitrationResult = this.arbitrationEngine.arbitrate(priorities, baseProfile);
          baseProfile = arbitrationResult.profile;
          console.log(`⚠️ 仲裁冲突: ${arbitrationResult.conflicts.length}个`);
        }
        break;
        
      default:
        // 默认走描述驱动
        features = this.extractFeatures(sourceText);
        baseProfile = this.buildCharacterCard(features, roleId, roleName, roleType);
    }
    
    // === Step 3: 陷阱词识别（基于最终Profile）===
    const traps = this.identifyTrapsFromProfile(baseProfile);
    if (traps.length > 0) {
      console.log(`⚠️ 识别陷阱词: ${traps.map(t => t.word).join(', ')}`);
    }
    
    // === Step 4: 生成角度特异性描述 ===
    const angleSpecs = this.generateAngleSpecs(baseProfile);
    
    // === Step 5: 生成三层Prompt ===
    const prompt = this.buildThreeLayerPrompt(features, traps, roleType, baseProfile);
    
    // === 输出 ===
    return {
      characterCard: baseProfile,
      prompt: prompt,
      angleSpecs,
      analysis: {
        features,
        traps,
        suggestions: this.generateSuggestions(traps),
        scene,
        priorities,
        arbitration: arbitrationResult
      },
      metadata: {
        roleId,
        roleName,
        roleType,
        promptEngine: 'character-feature-extractor-v3.0',
        method: 'universal-scene-aware + knowledge-base + pre-clean'
      }
    };
  }

  /**
   * 合并两个Profile（supplement优先，base兜底）
   */
  mergeProfiles(supplement, base) {
    if (!base) return JSON.parse(JSON.stringify(supplement));
    if (!supplement) return JSON.parse(JSON.stringify(base));
    
    const merged = JSON.parse(JSON.stringify(base));
    const supVI = supplement.visualIdentity || {};
    const baseVI = merged.visualIdentity || {};
    
    // 合并visualIdentity字段：supplement的非空字段覆盖base
    for (const key of Object.keys(supVI)) {
      if (supVI[key] !== undefined && supVI[key] !== null && supVI[key] !== '') {
        // 数组字段：合并（去重）
        if (Array.isArray(supVI[key]) && Array.isArray(baseVI[key])) {
          baseVI[key] = [...new Set([...baseVI[key], ...supVI[key]])];
        } else if (Array.isArray(supVI[key]) && !baseVI[key]) {
          baseVI[key] = supVI[key];
        } else if (typeof supVI[key] === 'string' && (!baseVI[key] || baseVI[key] === '')) {
          // 字符串字段：supplement非空则覆盖
          baseVI[key] = supVI[key];
        } else if (typeof supVI[key] === 'object' && !Array.isArray(supVI[key])) {
          // 对象字段：递归合并
          baseVI[key] = { ...baseVI[key], ...supVI[key] };
        }
      }
    }
    
    return merged;
  }

  /**
   * 【场景1/3】处理信息稀疏输入
   * 策略：知识库查找 → 默认模板 → 主题推断
   */
  handleSparseInput(sourceText, roleType, roleId, roleName) {
    let profile = null;
    let features = null;
    let source = 'none';
    
    // 策略1：尝试从知识库加载（角色名匹配）
    const knowledgeProfile = this.loadFromKnowledgeBase(roleId, roleName, sourceText);
    if (knowledgeProfile) {
      profile = knowledgeProfile;
      source = 'knowledge-base';
      
      // 从Profile反向生成features（用于Prompt构建）
      features = this.profileToFeatures(profile);
    }
    
    // 策略2：如果是主题描述（非角色名），使用主题推断
    if (!profile && sourceText.length > 3) {
      const inferred = this.inferFromTheme(sourceText, roleType);
      profile = inferred.profile;
      features = inferred.features;
      source = 'theme-inference';
    }
    
    // 策略3：基础模板兜底
    if (!profile) {
      profile = this.buildBasicTemplate(roleId, roleName, roleType);
      features = this.profileToFeatures(profile);
      source = 'basic-template';
    }
    
    return { profile, features, source };
  }

  /**
   * 从知识库加载角色档案
   */
  async loadFromKnowledgeBase(roleId, roleName, sourceText) {
    // 检查缓存
    const cacheKey = roleId || roleName;
    if (this.knowledgeBaseCache.has(cacheKey)) {
      return JSON.parse(JSON.stringify(this.knowledgeBaseCache.get(cacheKey)));
    }
    
    // 尝试加载角色档案文件
    const possiblePaths = [
      path.join(this.config.knowledgeBasePath, roleId, 'character-card.json'),
      path.join(this.config.knowledgeBasePath, roleName, 'character-card.json'),
      path.join(this.config.knowledgeBasePath, sourceText, 'character-card.json')
    ];
    
    for (const filePath of possiblePaths) {
      try {
        if (fss.existsSync(filePath)) {
          const data = JSON.parse(await fs.promises.readFile(filePath, 'utf-8'));
          // 深拷贝并存入缓存
          const profile = JSON.parse(JSON.stringify(data));
          this.knowledgeBaseCache.set(cacheKey, profile);
          console.log(`📚 从知识库加载: ${filePath}`);
          return profile;
        }
      } catch (e) {
        // 继续尝试下一个路径
      }
    }
    
    return null;
  }

  /**
   * 主题推断：从主题词推断角色基本特征
   */
  inferFromTheme(themeText, roleType) {
    // 基于主题词推断角色类型和基本特征
    const inferences = {
      // 山海经相关
      '山海': { species: '上古异兽', style: '东方奇幻', texture: ['神秘', '古老'] },
      '异兽': { species: '奇幻生物', style: '神话风格', texture: ['超现实'] },
      // 科幻相关
      '科幻': { species: '未知生物', style: '科幻写实', texture: ['未来感', '科技感'] },
      '未来': { species: '未来生物', style: '科幻风格', texture: ['机械感', '流线型'] },
      // 童话相关
      '童话': { species: '魔法生物', style: '童话风格', texture: ['柔软', '温暖'] },
      '魔法': { species: '魔法生物', style: '奇幻风格', texture: ['发光', '神秘'] }
    };
    
    // 匹配主题词
    let matchedInference = null;
    for (const [keyword, inference] of Object.entries(inferences)) {
      if (themeText.includes(keyword)) {
        matchedInference = inference;
        break;
      }
    }
    
    // 构建基础Profile（确保baseIdentity包含主题信息）
    const baseIdentity = matchedInference 
      ? `基于"${themeText}"主题推断的${matchedInference.species}`
      : `基于"${themeText}"主题推断的${roleType === 'beast' ? '奇幻生物' : '角色'}`;
    
    const profile = {
      id: 'inferred-' + Date.now(),
      name: themeText.substring(0, 10),
      roleType,
      visualIdentity: {
        baseIdentity: baseIdentity,
        species: matchedInference?.species || '未知生物',
        style: matchedInference?.style || '写实风格',
        texture: matchedInference?.texture || ['写实'],
        count: []
      }
    };
    
    const features = {
      color: [],
      shape: matchedInference ? [matchedInference.species] : [],
      count: [],
      texture: matchedInference?.texture || [],
      size: [],
      function: [],
      face: [],
      special: [],
      personality: [],
      symbolism: [themeText],
      origin: ['主题推断']
    };
    
    return { profile, features };
  }

  /**
   * 基础模板兜底
   */
  buildBasicTemplate(roleId, roleName, roleType) {
    const templates = {
      beast: {
        id: roleId,
        name: roleName,
        roleType: 'beast',
        visualIdentity: {
          baseIdentity: `${roleName}（奇幻生物）`,
          species: '未知奇幻生物',
          style: '超写实3D数字渲染，虚幻引擎5体积光散射',
          texture: ['写实'],
          count: []
        }
      },
      human: {
        id: roleId,
        name: roleName,
        roleType: 'human',
        visualIdentity: {
          baseIdentity: `${roleName}（人类角色）`,
          species: '人类',
          style: '超写实3D数字渲染，虚幻引擎5体积光散射',
          texture: ['写实'],
          count: []
        }
      },
      narrator: {
        id: roleId,
        name: roleName,
        roleType: 'narrator',
        visualIdentity: {
          baseIdentity: `${roleName}（叙述者）`,
          species: '人类',
          style: '超写实3D数字渲染',
          texture: ['写实'],
          count: []
        }
      }
    };
    
    return templates[roleType] || templates.beast;
  }

  /**
   * 【v3.0核心】事前清理陷阱词
   * 在特征提取前，先将陷阱词替换为安全描述
   */
  preCleanTrapWords(text) {
    let cleaned = text;
    const replacements = [];
    
    for (const trap of this.config.trapWordLibrary) {
      for (const pattern of trap.patterns) {
        // 使用正则全局替换
        const regex = new RegExp(pattern, 'g');
        if (regex.test(cleaned)) {
          cleaned = cleaned.replace(regex, (match) => {
            replacements.push({
              original: match,
              replaced: trap.safeDesc || trap.suggestion,
              type: trap.type
            });
            return trap.safeDesc || trap.suggestion;
          });
        }
      }
    }
    
    return cleaned;
  }

  /**
   * 从Profile反向生成features（用于Prompt构建）
   */
  profileToFeatures(profile) {
    const vi = profile.visualIdentity || {};
    
    // 处理count字段：支持数组和对象两种格式
    let countArray = [];
    if (vi.count) {
      if (Array.isArray(vi.count)) {
        countArray = vi.count;
      } else if (typeof vi.count === 'object') {
        // 对象格式 { legs: 6, wings: 4 }
        for (const [key, value] of Object.entries(vi.count)) {
          countArray.push({
            number: String(value),
            unit: key === 'legs' ? '足' : key === 'wings' ? '翼' : key,
            context: ''
          });
        }
      }
    }
    
    const features = {
      color: Array.isArray(vi.color) ? vi.color : (vi.color ? [vi.color] : []),
      shape: Array.isArray(vi.shape) ? vi.shape : (vi.shape ? [vi.shape] : []),
      count: countArray,
      texture: Array.isArray(vi.texture) ? vi.texture : (vi.texture ? [vi.texture] : []),
      size: Array.isArray(vi.size) ? vi.size : (vi.size ? [vi.size] : []),
      function: vi.function || [],
      face: Array.isArray(vi.face) ? vi.face : (vi.face ? [vi.face] : []),
      special: vi.special || [],
      personality: vi.personality || [],
      symbolism: vi.symbolism || [],
      origin: vi.origin ? [vi.origin] : []
    };
    
    return features;
  }

  /**
   * Step 1: 特征提取（使用清理后的文本）
   */
  extractFeatures(text) {
    const features = {
      color: [],
      shape: [],
      count: [],
      texture: [],
      size: [],
      function: [],
      face: [],
      special: [],
      personality: [],
      symbolism: [],
      origin: []
    };
    
    // 颜色提取
    const colorPatterns = [
      /([赤红黄白黑青蓝紫橙绿金银]色?)/g,
      /如丹火/g,
      /如黄金/g,
      /金色/g,
      /银色/g,
      /半透明/g
    ];
    colorPatterns.forEach(pattern => {
      const matches = text.match(pattern);
      if (matches) features.color.push(...matches);
    });
    features.color = [...new Set(features.color)];
    
    // 形态提取（增强：形如X → 展开安全描述）
    const shapePatterns = [
      /形如([^，。]+)/g,
      /状如([^，。]+)/g,
      /像([^，。]+)/g
    ];
    shapePatterns.forEach(pattern => {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const shapeDesc = match[1];
        // 检查是否是陷阱词，如果是则跳过（已经事前清理）
        const isTrap = this.config.trapWordLibrary.some(trap => 
          trap.patterns.some(p => shapeDesc.includes(p))
        );
        if (!isTrap) {
          features.shape.push(shapeDesc);
        }
      }
    });
    features.shape = [...new Set(features.shape)];
    
    // 数量提取（支持复杂中文数字）
    const countPatterns = [
      /([一二三四五六七八九十百千万亿]+)(?:足|翼|翅|腿|脚|臂|手|头|尾|角)/g,
      /(\d+)(?:足|翼|翅|腿|脚|臂|手|头|尾|角)/g
    ];
    countPatterns.forEach(pattern => {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        features.count.push({
          number: match[1],
          unit: match[0].replace(match[1], ''),
          context: text.substring(Math.max(0, match.index - 20), match.index + match[0].length + 20)
        });
      }
    });
    
    // 面部特征
    const facePatterns = [
      /无面目/g, /无头/g, /无脸/g, /没有五官/g, /没有眼睛/g,
      /光滑的?曲面/g, /平坦的?曲面/g
    ];
    facePatterns.forEach(pattern => {
      const matches = text.match(pattern);
      if (matches) features.face.push(...matches);
    });
    features.face = [...new Set(features.face)];
    
    // 大小
    const sizePatterns = [
      /(?:大|小|约|直径|长|高)([^，。]{0,10})/g,
      /(?:如|像)([^，。]{0,5})大小/g
    ];
    sizePatterns.forEach(pattern => {
      const matches = text.match(pattern);
      if (matches) features.size.push(...matches);
    });
    features.size = [...new Set(features.size)];
    
    // 质感
    const texturePatterns = [
      /半透明/g, /发光/g, /薄壁/g, /柔软/g, /浑圆/g, /中空/g
    ];
    texturePatterns.forEach(pattern => {
      const matches = text.match(pattern);
      if (matches) features.texture.push(...matches);
    });
    features.texture = [...new Set(features.texture)];
    
    return features;
  }

  /**
   * 陷阱词识别（基于Profile）
   */
  identifyTrapsFromProfile(profile) {
    const traps = [];
    const vi = profile.visualIdentity || {};
    
    // 检查所有文本字段
    const allTexts = [
      vi.baseIdentity,
      vi.species,
      ...(Array.isArray(vi.color) ? vi.color : (vi.color ? [vi.color] : [])),
      ...(Array.isArray(vi.shape) ? vi.shape : (vi.shape ? [vi.shape] : [])),
      ...(Array.isArray(vi.texture) ? vi.texture : (vi.texture ? [vi.texture] : [])),
      ...(Array.isArray(vi.face) ? vi.face : (vi.face ? [vi.face] : [])),
      ...(Array.isArray(vi.size) ? vi.size : (vi.size ? [vi.size] : []))
    ].filter(Boolean).join(' ');
    
    for (const trap of this.config.trapWordLibrary) {
      for (const pattern of trap.patterns) {
        if (allTexts.includes(pattern) || new RegExp(pattern).test(allTexts)) {
          traps.push({
            word: pattern,
            type: trap.type,
            risk: trap.risk,
            suggestion: trap.suggestion,
            example: trap.example
          });
        }
      }
    }
    
    return traps;
  }

  /**
   * 统一字段访问：将可能是字符串或数组的字段转换为数组
   */
  _asArray(field) {
    if (!field) return [];
    if (Array.isArray(field)) return field;
    if (typeof field === 'string') return field ? [field] : [];
    return [];
  }

  /**
   * 生成三层Prompt（v3.0增强：支持冲突标记和动态禁止清单）
   */
  buildThreeLayerPrompt(features, traps, roleType, profile = null) {
    const lines = [];
    const vi = profile?.visualIdentity || {};
    
    // 统一字段类型
    const faceField = this._asArray(vi.face);
    const textureField = this._asArray(vi.texture);
    const colorField = this._asArray(vi.color);
    const shapeField = this._asArray(vi.shape);
    const sizeField = this._asArray(vi.size);
    
    // === 第一层：禁止清单 ===
    lines.push('【第一层：禁止清单——绝对不可出现】');
    
    const baseForbidden = this.config.forbiddenTemplates[roleType] || this.config.forbiddenTemplates.default;
    lines.push(...baseForbidden);
    
    // 基于Profile特征动态生成
    const faceHasNoFeatures = faceField.some(f => f.includes('无') || f.includes('没有'));
    
    if (faceHasNoFeatures) {
      lines.push('绝对禁止面部有任何凸起、凹陷、鼓包、裂缝');
      lines.push('面部区域必须是绝对平坦光滑的纯色曲面');
    }
    
    const hasHollowTexture = textureField.some(t => t.includes('中空') || t.includes('薄壁'));
    
    if (hasHollowTexture) {
      lines.push('绝对禁止生成内部有实体核心或实体器官');
      lines.push('必须是中空、薄壁、可透光的结构');
    }
    
    if (profile?._removedByConstraint) {
      for (const removed of profile._removedByConstraint) {
        lines.push(`绝对禁止生成任何${removed.unit}结构`);
        lines.push(`该角色完全没有${removed.unit}【用户明确去除】`);
      }
    }
    
    // === 第二层：形态定义 ===
    lines.push('\n【第二层：形态定义——必须是什么】');
    
    if (vi.baseIdentity) {
      lines.push(`主体：${vi.baseIdentity}`);
    }
    
    if (vi.species) {
      lines.push(`物种：${vi.species}`);
    }
    
    // 颜色
    if (vi._colorForced && colorField.length > 0) {
      lines.push(`颜色：${colorField.join('、')}【用户强制指定】`);
    } else if (colorField.length > 0) {
      lines.push(`颜色：${colorField.join('、')}`);
    }
    
    // 形态
    if (vi._shapeForced && shapeField.length > 0) {
      lines.push(`形态：${shapeField.join('、')}【用户指定】`);
    } else if (shapeField.length > 0) {
      lines.push(`形态：${shapeField.join('、')}`);
    }
    
    // 面部
    if (faceField.some(f => f.includes('无'))) {
      lines.push('面部：完全没有五官，面部区域是绝对平坦光滑的曲面，没有任何凸起凹陷鼓包裂缝');
    }
    
    // 质感
    if (textureField.length > 0) {
      lines.push(`质感：${textureField.join('、')}`);
    }
    
    // === 第三层：数量确认 ===
    const countSource = vi.count || [];
    
    if (countSource.length > 0) {
      lines.push('\n【第三层：数量确认——空间分布描述】');
      
      for (const limb of countSource) {
        const isModified = limb.modifiedBy === 'P0_HARD';
        const isNew = limb.isNew;
        const marker = isModified ? '【用户修改】' : (isNew ? '【用户添加】' : '');
        
        if (limb.unit.includes('足') || limb.unit.includes('脚') || limb.unit.includes('腿')) {
          lines.push(`底部均匀分布${limb.number}条${limb.unit}${marker}，呈放射状对称排列，每条都清晰可见，不得相互遮挡`);
        } else if (limb.unit.includes('翼') || limb.unit.includes('翅')) {
          lines.push(`身体两侧各有${limb.number}片${limb.unit}${marker}，翼膜透明，边缘散发柔和光晕`);
        } else {
          lines.push(`身体上有${limb.number}个${limb.unit}${marker}，清晰可见`);
        }
      }
    }
    
    // 被移除的肢体
    if (profile?._removedByConstraint) {
      for (const removed of profile._removedByConstraint) {
        lines.push(`绝对禁止生成任何${removed.unit}，该角色没有${removed.unit}【用户明确去除】`);
      }
    }
    
    // === 技术规格 ===
    lines.push('\n【技术规格】');
    lines.push(this.config.technicalTemplate);
    
    return lines.join('\n');
  }

  /**
   * 生成角度特异性描述
   */
  generateAngleSpecs(profile) {
    const vi = profile.visualIdentity || {};
    const baseDesc = vi.baseIdentity || '';
    
    return {
      front: `${baseDesc}，正面全身，站立标准姿态，所有肢体清晰可见`,
      threeQuarter: `${baseDesc}，3/4侧面，经典人像角度，展示侧面轮廓`,
      topDown: `${baseDesc}，俯视角度，从上方拍摄，展示顶部形态和肢体分布`,
      side: `${baseDesc}，侧面90度，展示侧面轮廓和深度`
    };
  }

  /**
   * 构建角色档案
   */
  buildCharacterCard(features, roleId, roleName, roleType) {
    const card = {
      id: roleId,
      name: roleName,
      roleType,
      visualIdentity: {
        baseIdentity: `${roleName}（${roleType === 'beast' ? '奇幻生物' : '角色'}）`,
        species: roleType === 'beast' ? '未知奇幻生物' : '人类',
        color: features.color || [],
        shape: features.shape || [],
        count: (features.count || []).map(c => ({
          number: this.chineseToArabic(c.number),
          unit: c.unit,
          distribution: '用户指定'
        })),
        texture: features.texture || [],
        size: features.size || [],
        face: features.face || [],
        style: '超写实3D数字渲染，虚幻引擎5体积光散射'
      }
    };
    
    return card;
  }

  /**
   * 中文数字转阿拉伯数字（支持复杂数字）
   */
  chineseToArabic(str) {
    if (/^\d+$/.test(str)) {
      return parseInt(str);
    }
    
    const chineseMap = {
      '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5,
      '六': 6, '七': 7, '八': 8, '九': 9, '十': 10,
      '百': 100, '千': 1000, '万': 10000, '亿': 100000000
    };
    
    let result = 0;
    let temp = 0;
    let lastUnit = 1;
    
    for (let i = 0; i < str.length; i++) {
      const char = str[i];
      const value = chineseMap[char];
      
      if (value === undefined) continue;
      
      if (value >= 10) {
        // 单位词（十、百、千等）
        if (temp === 0) temp = 1;
        result += temp * value;
        temp = 0;
        lastUnit = value;
      } else {
        // 数字词
        temp = temp * 10 + value;
      }
    }
    
    return result + temp;
  }

  /**
   * 生成建议
   */
  generateSuggestions(traps) {
    return traps.map(t => ({
      issue: t.word,
      fix: t.suggestion,
      example: t.example
    }));
  }

  // ===== 默认配置 =====

  getDefaultTrapWords() {
    return [
      {
        type: 'shape',
        patterns: ['黄囊', '气囊', '口袋'],
        risk: 'high',
        safeDesc: '中空囊状结构',
        suggestion: '改为"中空囊状结构，薄壁半透明"',
        example: '帝江："形如黄囊"→"形如中空囊状结构，薄壁半透明"'
      },
      {
        type: 'shape',
        patterns: ['核心', '太阳', '发光点', '能量集中'],
        risk: 'high',
        safeDesc: '发光均匀分布',
        suggestion: '改为"发光均匀分布，无实体凸起"',
        example: '帝江：去除"身体中央有小太阳"'
      },
      {
        type: 'count',
        patterns: ['编号', '标注', '序号'],
        risk: 'high',
        safeDesc: '均匀分布',
        suggestion: '改为"均匀分布，清晰可见"',
        example: '帝江：去除"编号1-2-3-4-5-6"'
      },
      {
        type: 'shape',
        patterns: ['球体', '圆球'],
        risk: 'medium',
        safeDesc: '浑圆中空形态',
        suggestion: '增加否定锚定"绝不是实心球体"',
        example: '帝江："浑圆"→"浑圆中空形态，绝非实心"'
      }
    ];
  }

  getDefaultForbiddenTemplates() {
    return {
      beast: [
        '绝对禁止生成任何凸起的头部结构',
        '绝对禁止生成哺乳动物特征（毛发、兽耳、尾巴）',
        '绝对禁止生成昆虫特征（复眼、触角、外骨骼）',
        '绝对禁止生成实心球体或实心物体',
        '绝对禁止在画面上标数字、编号、序号或文字',
        '绝对禁止生成科技元素（电路板、天线、机械结构）'
      ],
      human: [
        '绝对禁止生成西方面孔特征',
        '绝对禁止生成卡通动漫风格',
        '绝对禁止在画面上标数字、编号、序号或文字'
      ],
      default: [
        '绝对禁止生成与角色设定不符的元素',
        '绝对禁止在画面上标数字、编号、序号或文字'
      ]
    };
  }

  getDefaultTechnicalTemplate() {
    return '超写实3D数字渲染，虚幻引擎5体积光散射，CG角色设计，摄影棚三点布光，2K分辨率，毛孔级纹理，次表面散射';
  }
}

module.exports = CharacterFeatureExtractor;
