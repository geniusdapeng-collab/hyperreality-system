// engines/script-engine/core/requirement-list-builder.js
// RequirementListBuilder - 需求清单生成确认模块 (Layer 0)
// 适配超现实系统四层架构,在 IntentParser 和 ScriptEngine 之间
// 版本: v1.0.0 | 日期: 2026-06-18

const { IntentParser } = require('./intent-parser');

// v2.0.2-fix: 安全数值解析工具，防止NaN污染后续计算
function safeParseInt(str, defaultValue = 0) {
  const val = parseInt(str, 10);
  return Number.isNaN(val) ? defaultValue : val;
}

function safeParseFloat(str, defaultValue = 0) {
  const val = parseFloat(str);
  return Number.isNaN(val) ? defaultValue : val;
}

/**
 * 超现实系统风格编码展开器
 * 适配超现实系统的电影级质感需求
 */
const StyleEncoder = {
  primaryStyles: {
    'REAL': { name: '写实纪实', description: '自然光、真实场景、手持感', context: { EDU: '真实可信的纪实风格,增强专业信任感', default: '写实纪实的真实质感' }},
    'CINE': { name: '电影质感', description: '戏剧性光影、宽画幅、景深', context: { DRAMA: '电影级叙事质感,增强戏剧张力', EDU: '电影级纪录片质感,提升专业度', default: '电影级的戏剧质感' }},
    'POL': { name: '精致商业', description: '高饱和、精致布光、产品特写', context: { ADV: '精致商业广告质感', default: '精致商业的高品质呈现' }},
    'MINI': { name: '极简现代', description: 'clean背景、大留白、几何构图', context: { default: '极简现代的设计美学' }},
    'RET': { name: '复古怀旧', description: '暖色调、胶片颗粒、年代感', context: { default: '复古怀旧的温暖质感' }},
    'FUT': { name: '科幻未来', description: '冷色调、霓虹光、科技感UI', context: { default: '科幻未来的科技美学' }},
    'ART': { name: '艺术实验', description: '非常规构图、抽象视觉、强烈色彩', context: { default: '艺术实验的独特美学' }},
    'WARM': { name: '温暖治愈', description: '柔和光线、暖色调、慢节奏', context: { EDU: '温暖治愈的亲和风格,降低知识门槛', default: '温暖治愈的情感氛围' }},
    'STREET': { name: '街头潮流', description: '快速剪辑、涂鸦元素、动感运镜', context: { default: '街头潮流的动感风格' }},
    'FAIRY': { name: '梦幻童话', description: '柔光、仙气、超现实元素', context: { default: '梦幻童话的超现实美感' }}
  },

  secondaryStyles: {
    'LUX': { name: '奢华感', effect: '金色/暗调、高级质感、慢镜头' },
    'VIV': { name: '活力感', effect: '高饱和、快节奏、动感音乐' },
    'EMO': { name: '情绪感', effect: '低饱和、慢节奏、叙事性强' },
    'NAT': { name: '自然感', effect: '户外、自然光、绿意/蓝天' },
    'GRI': { name: '粗粝感', effect: '高对比、暗部细节、纪实感' },
    'SWE': { name: '甜美感', effect: '粉色/马卡龙、柔光、可爱元素' },
    'DAR': { name: '暗黑感', effect: '低key布光、阴影、神秘氛围' },
    'NOS': { name: '怀旧感', effect: '胶片色、颗粒、老电视效果' }
  },

  expandPrimary(code, videoType = 'default') {
    const style = this.primaryStyles[code];
    if (!style) return code;
    const ctx = style.context[videoType] || style.context.default;
    return `${style.name}风格,${ctx},${style.description}`;
  },

  expandSecondary(code) {
    const clean = code.replace(/^\+/, '');
    const style = this.secondaryStyles[clean];
    if (!style) return code;
    return `${style.name}(${style.effect})`;
  },

  expandStyle(primary, secondary = [], videoType = 'default') {
    const primaryDesc = this.expandPrimary(primary, videoType);
    if (!secondary.length) return primaryDesc;
    const secondaryDescs = secondary.map(s => this.expandSecondary(s));
    return `${primaryDesc},叠加${secondaryDescs.join('、')}`;
  }
};

/**
 * 规则库 - 快速确定性解析
 */
const ParserRules = {
  videoTypeRules: [
    { keywords: ['科普', '讲解', '知识', '教学', '课程', '教育', '健康科普'], type: 'EDU', name: '教育科普' },
    { keywords: ['短剧', '剧情', '故事', '角色', '集', '微电影'], type: 'DRAMA', name: '短剧/微电影' },
    { keywords: ['广告', '宣传', '推广', '品牌', '产品', '宣传片'], type: 'ADV', name: '商业广告' },
    { keywords: ['纪录片', '记录', '纪实', '真实'], type: 'DOC', name: '纪录片' },
    { keywords: ['vlog', '日常', '记录生活', '跟我'], type: 'VLOG', name: 'Vlog/记录' },
    { keywords: ['抖音', '快手', '小红书', 'viral', '短视频'], type: 'SOC', name: '社媒短视频' },
    { keywords: ['企业', '公司', '工厂', '实力'], type: 'COR', name: '企业宣传' },
    { keywords: ['活动', '现场', '会议', '庆典'], type: 'EVT', name: '活动记录' },
    { keywords: ['mv', '音乐', '歌曲'], type: 'MV', name: '音乐视频' }
  ],

  styleRules: [
    { keywords: ['写实', '真实', '纪实', '纪录片感'], style: 'REAL' },
    { keywords: ['电影感', '大片', '质感', 'cinematic'], style: 'CINE' },
    { keywords: ['精致', '高级', '商业', '产品'], style: 'POL' },
    { keywords: ['极简', '现代', '科技', 'clean'], style: 'MINI' },
    { keywords: ['复古', '怀旧', '年代', '老'], style: 'RET' },
    { keywords: ['科幻', '未来', '科技', '赛博'], style: 'FUT' },
    { keywords: ['艺术', '实验', '前卫', '独特'], style: 'ART' },
    { keywords: ['温暖', '治愈', '柔和', '温情'], style: 'WARM' },
    { keywords: ['街头', '潮流', '潮', '涂鸦'], style: 'STREET' },
    { keywords: ['梦幻', '童话', '仙气', '唯美'], style: 'FAIRY' }
  ],

  modifierRules: [
    { keywords: ['奢华', 'luxury', '高端', '金色'], modifier: 'LUX' },
    { keywords: ['活力', '动感', '快节奏', '年轻'], modifier: 'VIV' },
    { keywords: ['情绪', '情感', '叙事', '深沉'], modifier: 'EMO' },
    { keywords: ['自然', '户外', '绿色', '阳光'], modifier: 'NAT' },
    { keywords: ['粗粝', 'gritty', '纪实', '真实'], modifier: 'GRI' },
    { keywords: ['甜美', '可爱', '粉色', '马卡龙'], modifier: 'SWE' },
    { keywords: ['暗黑', '神秘', '阴影', '低key'], modifier: 'DAR' },
    { keywords: ['怀旧', '胶片', '颗粒', '老'], modifier: 'NOS' }
  ],

  platformRules: [
    { keywords: ['抖音'], platform: '抖音', defaultRatio: '9:16' },
    { keywords: ['快手'], platform: '快手', defaultRatio: '9:16' },
    { keywords: ['小红书'], platform: '小红书', defaultRatio: '9:16' },
    { keywords: ['视频号'], platform: '视频号', defaultRatio: '9:16' },
    { keywords: ['b站', 'bilibili', 'youtube'], platform: 'B站/YouTube', defaultRatio: '16:9' },
    { keywords: ['朋友圈'], platform: '朋友圈', defaultRatio: '9:16' },
    { keywords: ['大屏', '户外'], platform: '户外大屏', defaultRatio: '16:9' }
  ],

  durationDefaults: {
    'EDU': { default: 90, range: [60, 120] },
    'SOC': { default: 30, range: [15, 60] },
    'ADV': { default: 30, range: [15, 60] },
    'DOC': { default: 150, range: [60, 180] },
    'DRAMA': { default: 150, range: [60, 180] },
    'COR': { default: 90, range: [60, 120] },
    'EVT': { default: 120, range: [60, 180] },
    'VLOG': { default: 90, range: [60, 120] },
    'MV': { default: 150, range: [60, 180] }
  },

  constraints: {
    maxSingleDuration: 180,
    maxTotalDuration: 1200,
    maxShotDuration: 15,
    maxEpisodes: 7,
    recommendedMaxEpisodes: 5,
    recommendedMaxTotalDuration: 900
  }
};

/**
 * RequirementListBuilder - 需求清单生成确认器
 * 超现实系统 Layer 0:在 IntentParser (Layer 1前) 运行
 */
class RequirementListBuilder {
  constructor(options = {}) {
    this.intentParser = new IntentParser(options.intentParser);
    this.rules = ParserRules;
    this.styleEncoder = StyleEncoder;
    this.options = {
      maxIterations: 2,
      confidenceThreshold: 0.6,
      useLLM: options.useLLM !== false,
      llmEngine: options.llmEngine || null,
      ...options
    };
  }

  /**
   * 主入口:生成需求清单
   * @param {string} userInput - 用户自然语言输入
   * @param {Object} metadata - 附加元数据(如标题、时长等)
   * @returns {RequirementList} 结构化需求清单
   */
  async build(userInput, metadata = {}) {
    console.log(`\n📋 [Layer 0] 需求清单生成 - 解析用户意图...`);
    const startTime = Date.now();

    // 1. IntentParser 快速分类(复用超现实系统已有能力)
    const intentResult = this.intentParser.parse(userInput, metadata);
    console.log(`   ✅ IntentParser 分类: ${intentResult.parsed.narrative_mode} (置信度: ${intentResult.analysis.confidence})`);

    // 2. 规则库快速解析(确定性提取)
    const ruleBasedResult = this._ruleBasedParse(userInput, metadata);
    console.log(`   ✅ 规则库解析: 类型=${ruleBasedResult.videoType || '未识别'}, 时长=${ruleBasedResult.duration || '默认'}`);

    // 3. LLM 深度解析(语义理解)
    let llmResult = {};
    if (this.options.useLLM && this.options.llmEngine) {
      try {
        llmResult = await this._llmParse(userInput, ruleBasedResult, intentResult, metadata);
        console.log(`   ✅ LLM 深度解析完成`);
      } catch (e) {
        console.warn(`   ⚠️ LLM 解析失败: ${e.message},回退到规则库`);
      }
    }

    // 4. 合并结果
    const merged = this._mergeResults(ruleBasedResult, llmResult, intentResult);

    // 5. 推断补全
    const completed = this._inferCompletion(merged);

    // 6. 约束检查
    const constrained = this._applyConstraints(completed);

    // 7. 生成需求清单
    const requirementList = this._buildRequirementList(constrained, userInput, metadata);

    console.log(`   ✅ 需求清单生成完成 (${Date.now() - startTime}ms)`);
    console.log(`      类型: ${requirementList.videoType} | 时长: ${requirementList.targetDuration}s | 风格: ${requirementList.style.primary}`);
    console.log(`      角色: ${requirementList.characters.length}个 | 结构: ${requirementList.structure.scenes.length}段`);

    return requirementList;
  }

  /**
   * 规则库解析 - 快速确定性提取
   */
  _ruleBasedParse(input, metadata) {
    // v2.1.4-fix8: 防御性处理 - input可能是对象
    let text = '';
    if (typeof input === 'string') {
      text = input.toLowerCase();
    } else if (input && typeof input === 'object') {
      // 尝试从对象中提取文本
      text = (input.text || input.content || input.description || input.title || '').toString().toLowerCase();
    } else {
      text = (input || '').toString().toLowerCase();
    }
    
    const result = {
      videoType: null,
      platform: null,
      style: { primary: null, secondary: [] },
      duration: metadata.target_duration || null,  // 优先使用metadata
      title: metadata.title || null,
      creativeIntensity: null,
      characters: [],
      isSeries: false,
      totalEpisodes: null,
      currentEpisode: null,
      keyPoints: [],
      uncertainties: []
    };

    // 推断视频类型
    for (const rule of this.rules.videoTypeRules) {
      for (const keyword of rule.keywords) {
        if (text.includes(keyword.toLowerCase())) {
          result.videoType = rule.type;
          result.videoTypeName = rule.name;
          break;
        }
      }
      if (result.videoType) break;
    }

    // 推断平台
    for (const rule of this.rules.platformRules) {
      for (const keyword of rule.keywords) {
        if (text.includes(keyword.toLowerCase())) {
          result.platform = rule.platform;
          result.defaultRatio = rule.defaultRatio;
          break;
        }
      }
      if (result.platform) break;
    }

    // 推断风格(优先使用metadata)
    if (metadata.style) {
      result.style.primary = metadata.style;
    } else {
      for (const rule of this.rules.styleRules) {
        for (const keyword of rule.keywords) {
          if (text.includes(keyword.toLowerCase())) {
            result.style.primary = rule.style;
            break;
          }
        }
        if (result.style.primary) break;
      }
    }

    // 推断辅助风格
    for (const rule of this.rules.modifierRules) {
      for (const keyword of rule.keywords) {
        if (text.includes(keyword.toLowerCase())) {
          if (!result.style.secondary.includes(rule.modifier)) {
            result.style.secondary.push(rule.modifier);
          }
        }
      }
    }

    // 提取时长
    const durationMatch = text.match(/(\d+)\s*(秒|分钟|分|s|sec|min)/i);
    if (durationMatch) {
      let value = safeParseInt(durationMatch[1]);
      const unit = durationMatch[2];
      if (unit.includes('分') || unit.includes('min')) {
        value *= 60;
      }
      result.duration = value;
    }

    // 提取时长范围(如 59~65秒)-- 如果metadata没有提供
    if (!result.duration) {
      const rangeMatch = text.match(/(\d+)\s*[~~-]\s*(\d+)\s*(秒|分钟|分|s)/i);
      if (rangeMatch) {
        let min = safeParseInt(rangeMatch[1]);
        let max = safeParseInt(rangeMatch[2]);
        const unit = rangeMatch[3];
        if (unit.includes('分')) { min *= 60; max *= 60; }
        result.durationRange = [min, max];
        result.duration = Math.round((min + max) / 2);
      }
    }

    // 提取创意指数（优先使用metadata传入的值）
    if (metadata.creativeIntensity !== undefined && metadata.creativeIntensity !== null) {
      result.creativeIntensity = safeParseFloat(metadata.creativeIntensity);
    } else {
      const intensityMatch = text.match(/创意指数\s*[::]?\s*(0?\.\d+|\d+)/i);
      if (intensityMatch) {
        result.creativeIntensity = safeParseFloat(intensityMatch[1]);
      }
    }
    // 检测"天花板般的创造力"等描述
    if (text.includes('天花板') || text.includes('顶级') || text.includes('极致')) {
      result.creativeIntensity = 1.0;
    }

    // 提取系列信息（从文本和metadata）
    const seriesMatch = text.match(/(\d+)\s*集/);
    if (seriesMatch) {
      result.totalEpisodes = safeParseInt(seriesMatch[1]);
      result.isSeries = true;
    }
    // 【v2.1.4】优先从metadata提取系列信息
    if (metadata.series) {
      result.isSeries = true;
      result.totalEpisodes = metadata.series.totalEpisodes || result.totalEpisodes;
      result.currentEpisode = metadata.series.currentEpisode || metadata.series.episode || result.currentEpisode;
      if (metadata.series.episodeTitles) {
        result.episodeTitles = metadata.series.episodeTitles;
      }
    } else if (metadata.total_episodes) {
      result.isSeries = true;
      result.totalEpisodes = metadata.total_episodes;
    }
    const episodeMatch = text.match(/第\s*(\d+)\s*集/);
    if (episodeMatch) {
      result.currentEpisode = safeParseInt(episodeMatch[1]);
    }
    // metadata中的episode优先
    if (metadata.episode || metadata.currentEpisode) {
      result.currentEpisode = metadata.episode || metadata.currentEpisode;
    }

    // 提取角色信息
    const characterMatches = text.match(/([^,。]+?)女士|([^,。]+?)先生|主角([^,。]+)|([^,。]+?)穿/);
    if (characterMatches) {
      const name = characterMatches[1] || characterMatches[2] || characterMatches[3] || characterMatches[4];
      if (name && name.length < 10) {
        result.characters.push({ name: name.trim(), description: '待补充' });
      }
    }

    // 提取关键需求点(简单分句)
    const sentences = text.split(/[。!;\n]/).filter(s => s.trim().length > 5);
    result.keyPoints = sentences.slice(0, 5);

    return result;
  }

  /**
   * LLM 深度解析 - 生成完整需求清单字段
   */
  async _llmParse(userInput, ruleResult, intentResult, metadata) {
    const prompt = this._buildLLMPrompt(userInput, ruleResult, intentResult, metadata);

    // 【v2.1.4-fix13-审计修复】适配多种 LLM 引擎接口
    let responseText = '';
    const llmEngine = this.options.llmEngine;
    const timeoutMs = 300000; // 5分钟

    if (!llmEngine) {
      throw new Error('LLM引擎未初始化');
    }

    // 超时保护
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`RequirementListBuilder LLM 超时(${timeoutMs}ms)`)), timeoutMs);
    });

    try {
      if (typeof llmEngine.generate === 'function') {
        // 方式1: .generate({prompt, maxTokens, temperature}) - 兼容旧接口
        const response = await Promise.race([
          llmEngine.generate({
            prompt: prompt,
            maxTokens: 2500,
            temperature: 1
          }),
          timeoutPromise
        ]).finally(() => clearTimeout(timer));
        responseText = response.success ? (response.content || '') : '';
      } else if (typeof llmEngine.chat === 'function') {
        // 方式2: .chat(systemPrompt, userPrompt, temperature) - BaseAgent 标准接口
        const result = await Promise.race([
          llmEngine.chat('你是一位专业的视频需求分析师。只输出严格格式的JSON，不要markdown代码块。', prompt, 1),
          timeoutPromise
        ]).finally(() => clearTimeout(timer));
        responseText = result?.content || result?.data || '';
      } else if (typeof llmEngine.reasonStructured === 'function') {
        // 方式3: .reasonStructured(prompt, schema, options)
        const result = await Promise.race([
          llmEngine.reasonStructured(prompt, null, { maxTokens: 2500, timeoutMs }),
          timeoutPromise
        ]).finally(() => clearTimeout(timer));
        responseText = result?.data ? JSON.stringify(result.data) : (result?.content || '');
      } else {
        throw new Error('LLM引擎无可用的调用方法');
      }
    } catch (error) {
      console.error('[RequirementListBuilder] LLM调用失败:', error.message);
      throw error;
    }

    if (!responseText) {
      throw new Error('LLM返回空内容');
    }

    // 解析 JSON
    const jsonMatch = responseText.match(/```json\n?([\s\S]*?)\n?```/) ||
                      responseText.match(/\{[\s\S]*\}/);

    if (jsonMatch) {
      return JSON.parse(jsonMatch[1] || jsonMatch[0]);
    }

    throw new Error('LLM输出格式不匹配');
  }

  /**
   * 构建 LLM 提示词 - 超现实系统专用
   */
  _buildLLMPrompt(userInput, ruleResult, intentResult, metadata) {
    return `你是一位资深AI视频制片人,擅长将用户的粗略需求转化为专业的视频制作方案。

## 用户输入
"""${userInput}"""

## 规则库初步解析(供参考)
${JSON.stringify(ruleResult, null, 2)}

## 系统硬约束(不可违反)
- 单次最长时长: 180秒
- 单个镜头最长: 15秒
- 单集最长: 180秒
- 总时长上限: 20分钟(1200秒)
- 系列最多7集,推荐最多5集
- 画幅比例: 9:16(竖屏) / 16:9(横屏) / 1:1(方形)

## 视频类型
EDU=教育科普, SOC=社媒短视频, ADV=商业广告, DOC=纪录片, DRAMA=短剧/微电影, COR=企业宣传, EVT=活动记录, VLOG=Vlog/记录, MV=音乐视频

## 风格编码
主风格: REAL=写实纪实, CINE=电影质感, POL=精致商业, MINI=极简现代, RET=复古怀旧, FUT=科幻未来, ART=艺术实验, WARM=温暖治愈, STREET=街头潮流, FAIRY=梦幻童话
辅助风格: +LUX=奢华感, +VIV=活力感, +EMO=情绪感, +NAT=自然感, +GRI=粗粝感, +SWE=甜美感, +DAR=暗黑感, +NOS=怀旧感

## 任务
请分析用户需求,输出JSON格式的完整需求清单:

{
  "videoType": "类型编码",
  "videoTypeName": "中文类型名",
  "title": "视频主题",
  "seriesTitle": "系列名称(如有)",
  "targetAudience": "目标受众描述(年龄/性别/兴趣/职业)",
  "platform": "投放平台",
  "aspectRatio": "画幅比例",
  "duration": 目标时长数字,
  "durationRange": [最小值, 最大值],
  "style": {
    "primary": "主风格编码",
    "secondary": ["辅助风格编码"]
  },
  "styleDescription": "完整风格中文描述",
  "creativeIntensity": 0.0到1.0,
  "narrativeMode": "叙事模式: dialogue(角色独白) / voiceover(旁白) / mixed(混合)",
  "characters": [
    {
      "id": "角色ID(小写英文+连字符)",
      "name": "角色名",
      "description": "角色描述(年龄/性别/服装/气质)",
      "role": "角色定位: protagonist(主角) / supporting(配角) / narrator(解说员)"
    }
  ],
  "structure": {
    "opening": "开场风格描述",
    "scenes": ["场景1描述", "场景2描述"],
    "ending": "结尾风格描述"
  },
  "isSeries": true/false,
  "totalEpisodes": 集数,
  "currentEpisode": 当前集数,
  "keyPoints": ["关键需求点1", "关键需求点2"],
  "contentConstraints": ["内容限制1", "内容限制2"],
  "uncertainties": ["不确定项1"]
}

只输出JSON,不要其他内容。`;
  }

  /**
   * 合并三种解析结果
   */
  _mergeResults(ruleResult, llmResult, intentResult) {
    const merged = {
      ...ruleResult,
      ...llmResult,
      narrativeMode: intentResult.parsed?.narrative_mode || llmResult.narrativeMode || 'dialogue',
      worldSetting: intentResult.metadata?.world_setting || llmResult.worldSetting || 'default',
      confidence: intentResult.analysis?.confidence || 0.5
    };

    // 规则库结果优先(确定性更高),除非LLM明确提供了非推断值
    if (ruleResult.videoType) {
      merged.videoType = ruleResult.videoType;
      merged.videoTypeName = ruleResult.videoTypeName;
    }
    if (ruleResult.duration) {
      merged.duration = ruleResult.duration;
      merged.durationRange = ruleResult.durationRange;
    }
    // 风格:如果规则库有明确值,优先使用;否则用LLM的
    if (ruleResult.style?.primary) {
      merged.style = merged.style || {};
      merged.style.primary = ruleResult.style.primary;
    }
    if (ruleResult.style?.secondary?.length) {
      merged.style = merged.style || {};
      merged.style.secondary = ruleResult.style.secondary;
    }

    return merged;
  }

  /**
   * 推断补全 - 填充缺失字段
   */
  _inferCompletion(result) {
    const completed = { ...result };

    // 补全视频类型(默认EDU)
    if (!completed.videoType) {
      completed.videoType = 'EDU';
      completed.videoTypeName = '教育科普';
      completed.videoTypeInferred = true;
    }

    // 补全时长
    if (!completed.duration) {
      const defaults = this.rules.durationDefaults[completed.videoType];
      if (defaults) {
        completed.duration = defaults.default;
        completed.durationRange = defaults.range;
        completed.durationInferred = true;
      }
    }

    // 补全时长范围
    if (!completed.durationRange && completed.duration) {
      completed.durationRange = [Math.max(15, completed.duration - 10), Math.min(180, completed.duration + 10)];
    }

    // 补全风格(强制根据视频类型设置默认风格,覆盖LLM的错误推断)
    const typeToStyle = {
      'EDU': 'REAL', 'DOC': 'REAL', 'VLOG': 'REAL',
      'DRAMA': 'CINE', 'MV': 'ART',
      'ADV': 'POL', 'COR': 'POL',
      'SOC': 'STREET', 'EVT': 'REAL'
    };
    const defaultStyle = typeToStyle[completed.videoType] || 'REAL';
    // 如果当前风格与默认不符,且是推断的,强制覆盖
    if (completed.style?.primary !== defaultStyle) {
      console.log(`[RequirementListBuilder] 风格强制修正: ${completed.style?.primary} → ${defaultStyle} (视频类型: ${completed.videoType})`);
      completed.style = completed.style || {};
      completed.style.primary = defaultStyle;
      completed.styleInferred = true;
    }

    // 补全风格描述
    if (!completed.styleDescription) {
      completed.styleDescription = this.styleEncoder.expandStyle(
        completed.style.primary,
        completed.style.secondary || [],
        completed.videoType
      );
    }

    // 补全创意指数
    if (completed.creativeIntensity === undefined || completed.creativeIntensity === null) {
      const typeToIntensity = {
        'EDU': 0.5, 'DOC': 0.5, 'VLOG': 0.4,
        'DRAMA': 0.65, 'MV': 0.7,
        'ADV': 0.7, 'COR': 0.6,
        'SOC': 0.8, 'EVT': 0.5
      };
      completed.creativeIntensity = typeToIntensity[completed.videoType] || 0.5;
      completed.creativeIntensityInferred = true;
    }

    // 补全平台
    if (!completed.platform) {
      completed.platform = '视频号/抖音';
      completed.platformInferred = true;
    }

    // 补全画幅
    if (!completed.aspectRatio) {
      const platformToRatio = {
        '抖音': '9:16', '快手': '9:16', '小红书': '9:16', '视频号': '9:16',
        'B站/YouTube': '16:9', '朋友圈': '9:16', '户外大屏': '16:9'
      };
      // v1.2.5-fix: 默认横屏16:9,队长明确要求所有内容为横屏
      completed.aspectRatio = platformToRatio[completed.platform] || '16:9';
      completed.aspectRatioInferred = true;
    }

    // 补全叙事模式
    if (!completed.narrativeMode) {
      completed.narrativeMode = 'dialogue';
    }

    // 补全结构
    if (!completed.structure) {
      completed.structure = this._inferStructure(completed);
    }

    // 补全角色
    if (!completed.characters || completed.characters.length === 0) {
      completed.characters = this._inferCharacters(completed);
    }

    return completed;
  }

  /**
   * 根据视频类型推断默认结构
   */
  _inferStructure(result) {
    const typeToStructure = {
      'EDU': {
        opening: '开场引入(问题/场景/数据)',
        scenes: ['核心知识点讲解', '案例/演示说明', '重点强调'],
        ending: '总结回顾 + 行动号召'
      },
      'DRAMA': {
        opening: '开场建立角色与场景',
        scenes: ['冲突发展', '情感高潮', '转折/解决'],
        ending: '结局/开放式结尾'
      },
      'ADV': {
        opening: '吸引注意力的钩子',
        scenes: ['产品展示', '卖点阐述', '场景应用'],
        ending: 'CTA + 品牌露出'
      },
      'DOC': {
        opening: '背景介绍与主题引入',
        scenes: ['事件展开', '多角度叙述', '关键证据'],
        ending: '总结与思考'
      },
      'VLOG': {
        opening: '日常开场/问候',
        scenes: ['活动记录', '体验分享', '感受表达'],
        ending: '结束语 + 互动'
      }
    };

    const defaultStructure = {
      opening: '开场引入',
      scenes: ['主体内容', '展开说明'],
      ending: '总结收尾'
    };

    return typeToStructure[result.videoType] || defaultStructure;
  }

  /**
   * 根据输入推断角色信息
   */
  _inferCharacters(result) {
    const characters = [];

    // 从用户输入中提取角色名
    const text = result.raw_input || '';
    // 修复:支持 "穿警服的示例警官女士" 这种格式,正确提取名字
    const nameMatches = text.match(/([^,。\s]{1,6})女士|([^,。\s]{1,6})先生|([^,。\s]{1,6})讲解|([^,。\s]{1,6})介绍/);
    if (nameMatches) {
      const name = (nameMatches[1] || nameMatches[2] || nameMatches[3] || nameMatches[4]).trim();
      if (name && name.length < 10 && name.length > 1) {
        characters.push({
          id: name.toLowerCase().replace(/\s+/g, '-'),
          name: name,
          description: '待补充详细描述',
          role: 'protagonist'
        });
      }
    }

    return characters;
  }

  /**
   * 应用系统约束
   */
  _applyConstraints(result) {
    const constrained = { ...result };
    const c = this.rules.constraints;

    // 时长约束
    if (constrained.duration > c.maxSingleDuration) {
      constrained.duration = c.maxSingleDuration;
      constrained.durationClamped = true;
    }
    if (constrained.durationRange) {
      constrained.durationRange[0] = Math.max(15, constrained.durationRange[0]);
      constrained.durationRange[1] = Math.min(c.maxSingleDuration, constrained.durationRange[1]);
    }

    // 系列约束
    if (constrained.totalEpisodes > c.maxEpisodes) {
      constrained.totalEpisodes = c.maxEpisodes;
      constrained.episodesClamped = true;
    }

    // 创意指数约束
    if (constrained.creativeIntensity !== undefined) {
      constrained.creativeIntensity = Math.max(0, Math.min(1, constrained.creativeIntensity));
    }

    return constrained;
  }

  /**
   * 构建最终需求清单对象
   */
  _buildRequirementList(result, rawInput, metadata) {
    return {
      // 元信息
      version: '1.0.0',
      system: 'hyperreality',
      generatedAt: new Date().toISOString(),
      rawInput,

      // 基础信息
      videoType: result.videoType,
      videoTypeName: result.videoTypeName || '教育科普',
      title: result.title || metadata.title || '未命名项目',
      seriesTitle: result.seriesTitle || metadata.seriesTitle || '',
      episode: result.currentEpisode || metadata.episode || 1,
      totalEpisodes: result.totalEpisodes || metadata.totalEpisodes || 1,
      isSeries: result.isSeries || (result.totalEpisodes > 1),

      // 风格与质感
      style: {
        primary: result.style.primary,
        secondary: result.style.secondary || [],
        description: result.styleDescription
      },
      aspectRatio: result.aspectRatio || '16:9',
      platform: result.platform || '视频号/抖音',
      creativeIntensity: result.creativeIntensity,

      // 目标与受众
      targetDuration: result.duration,
      durationRange: result.durationRange || [result.duration - 5, result.duration + 5],
      targetAudience: result.targetAudience || '通用受众',
      language: result.language || 'zh-CN',

      // 叙事
      narrativeMode: result.narrativeMode || 'dialogue',

      // 角色
      characters: result.characters || [],
      protagonist: result.characters?.find(c => c.role === 'protagonist') || result.characters?.[0] || null,

      // 结构规划
      structure: result.structure || {
        opening: '开场引入',
        scenes: ['主体内容'],
        ending: '总结收尾'
      },

      // 内容约束
      keyPoints: result.keyPoints || [],
      contentConstraints: result.contentConstraints || [],
      forbiddenElements: result.forbiddenElements || ['voiceover', 'metal_gloss', 'unnatural_eye_color'],

      // 技术参数
      constraints: {
        maxPromptLength: result.maxPromptLength || 12000,
        referenceImageCount: result.referenceImageCount || 2,
        maxShotDuration: 15
      },

      // 不确定项(需要用户确认)
      uncertainties: result.uncertainties || [],

      // 推断标记
      _inferred: {
        videoType: !!result.videoTypeInferred,
        duration: !!result.durationInferred,
        style: !!result.styleInferred,
        platform: !!result.platformInferred,
        aspectRatio: !!result.aspectRatioInferred,
        creativeIntensity: !!result.creativeIntensityInferred,
        structure: !result.structure
      },

      // 分析元数据
      _analysis: {
        confidence: result.confidence || 0.5,
        parsingLayers: ['intent_parser', 'rule_based', 'llm_deep'],
        worldSetting: result.worldSetting || 'default'
      }
    };
  }

  /**
   * 生成 Markdown 格式的需求清单(供用户确认)
   */
  generateMarkdown(requirementList) {
    const r = requirementList;
    const inferred = (field) => r._inferred[field] ? ' *(推断)*' : '';

    return `# 视频需求要点清单

> 系统: 超现实系统 v${r.version}
> 生成时间: ${r.generatedAt}
> 置信度: ${(r._analysis.confidence * 100).toFixed(0)}%

---

## 一、基础信息

- **视频类型**: ${r.videoTypeName}${inferred('videoType')}
- **标题**: ${r.title}
${r.seriesTitle ? `- **系列名称**: ${r.seriesTitle}` : ''}
${r.isSeries ? `- **集数**: 第${r.episode}集 / 共${r.totalEpisodes}集` : ''}
- **目标时长**: ${r.targetDuration}秒${inferred('duration')}
${r.durationRange ? `- **时长范围**: ${r.durationRange[0]}~${r.durationRange[1]}秒` : ''}
- **画幅比例**: ${r.aspectRatio}${inferred('aspectRatio')}
- **投放平台**: ${r.platform}${inferred('platform')}

## 二、风格与质感

- **主风格**: ${r.style.primary}${inferred('style')}
${r.style.secondary.length ? `- **辅助风格**: ${r.style.secondary.join('、')}` : ''}
- **风格描述**: ${r.style.description}
- **创意指数**: ${r.creativeIntensity}${inferred('creativeIntensity')}
- **叙事模式**: ${r.narrativeMode === 'dialogue' ? '角色独白' : r.narrativeMode === 'voiceover' ? '旁白' : '混合'}

## 三、目标受众

${r.targetAudience}

## 四、角色设定

${r.characters.map(c => `- **${c.name}** (${c.role === 'protagonist' ? '主角' : c.role === 'supporting' ? '配角' : '解说员'}): ${c.description}`).join('\n') || '(待补充)'}

## 五、结构规划

- **开场**: ${r.structure.opening}
${r.structure.scenes.map((s, i) => `- **场景${i + 1}**: ${s}`).join('\n')}
- **结尾**: ${r.structure.ending}

## 六、关键需求点

${r.keyPoints.map((p, i) => `${i + 1}. ${p}`).join('\n') || '(无)'}

## 七、内容约束

${r.contentConstraints.map((c, i) => `${i + 1}. ${c}`).join('\n') || '(无)'}

${r.uncertainties.length ? `## ⚠️ 待确认项\n\n${r.uncertainties.map((u, i) => `${i + 1}. ${u}`).join('\n')}` : ''}

---

**请确认以上清单,或提出修改意见。确认后进入预生产流程。**`;
  }

  /**
   * 生成适合下游 ScriptEngine 的 metadata 格式
   */
  toScriptEngineMetadata(requirementList) {
    return {
      title: requirementList.title,
      target_duration: requirementList.targetDuration,
      target_platform: requirementList.platform.split('/'),
      language: requirementList.language,
      style_tags: [
        requirementList.style.primary.toLowerCase(),
        ...requirementList.style.secondary.map(s => s.toLowerCase())
      ],
      world_setting: requirementList._analysis.worldSetting,
      protagonist: requirementList.protagonist?.id || 'default',
      featured_beast_id: requirementList._analysis.worldSetting === 'Nirath' ?
        requirementList._analysis.featuredBeastId : null,
      max_prompt_length: requirementList.constraints.maxPromptLength,
      reference_image_count: requirementList.constraints.referenceImageCount,
      // 超现实系统扩展字段
      creative_intensity: requirementList.creativeIntensity,
      narrative_mode: requirementList.narrativeMode,
      aspect_ratio: requirementList.aspectRatio,
      series: requirementList.isSeries ? {
        title: requirementList.seriesTitle,
        name: requirementList.seriesTitle,                    // 【v2.1.4-fix13-审计修复】增加 name 别名
        currentEpisode: requirementList.episode,               // 【修复】episode → currentEpisode
        episode: requirementList.episode,                      // 【修复】保留 episode 向后兼容
        totalEpisodes: requirementList.totalEpisodes,          // 【修复】total_episodes → totalEpisodes
        total_episodes: requirementList.totalEpisodes,         // 【修复】保留 total_episodes 向后兼容
        episodeTitles: requirementList.episodeTitles || []
      } : null,
      // 【v2.1.4】传递系列内容规划
      seriesContentPlan: requirementList.seriesContentPlan || null,
      // 🆕 v1.2.6-fix4b: 传递 characters 数组（角色覆盖的前置条件）
      characters: requirementList.characters || []
    };
  }
}

module.exports = { RequirementListBuilder, StyleEncoder, ParserRules };
