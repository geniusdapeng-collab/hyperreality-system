
// 简单 UUID 生成（不依赖外部包）
function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

/**
 * Agent 1: ProductDefinitionAgent
 * 产品定义 Agent - 规则引擎，无需 LLM
 * 职责：从需求洞察结果中提取/映射产品定义字段
 * 耗时：< 100ms
 */
class ProductDefinitionAgent {
  constructor(options = {}) {
    this.config = options;
  }

  process(discoveryResult) {
    const { upstreamFields, audienceProfile, sceneStructure } = discoveryResult;
    const { type, theme, duration_sec, target_audience, description } = upstreamFields;

    // 1. 项目定义
    // ⭐ v2.2.1-fix: 原始故事文本作为最高事实源注入 PRD
    const originalStory = upstreamFields._originalStoryText || upstreamFields.original_story_text || '';
    const projectDefinition = {
      projectId: uuidv4(),
      projectName: this._extractProjectName(theme),
      version: '1.0.0',
      createdAt: new Date().toISOString(),
      sourceIntent: originalStory || description || theme,
      _originalStoryText: originalStory
    };

    // 2. 产品定位
    const productPositioning = this._mapProductPositioning(type, target_audience, duration_sec, audienceProfile, sceneStructure, discoveryResult.budgetProfile);

    return { projectDefinition, productPositioning };
  }

  _extractProjectName(theme) {
    // 【v2.1.15-fix】取主题第一个语义完整子句作为项目名称（≤20字符，标点边界）
    const t = String(theme || '').trim();
    const clause = t.split(/[，。！？；：:]/)[0].trim();
    if (clause && clause.length <= 20) return clause;
    return (clause || t).slice(0, 20);
  }

  _mapProductPositioning(type, target_audience, duration_sec, audienceProfile, sceneStructure, budgetProfile) {
    const TYPE_TO_PRODUCT_TYPE = {
      '硬科幻': '剧情短片', '赛博朋克': '剧情短片', '武侠动作': '剧情短片',
      '恐怖悬疑': '剧情短片', '自然纪录片': '纪录片', '商业广告': '商业广告',
      '科普教育': '科普教育', '音乐MV': '音乐MV', '家庭温情': '剧情短片',
      '浪漫爱情': '剧情短片', '喜剧荒诞': '剧情短片', '历史战争': '剧情短片',
      '社会现实': '纪录片', '艺术实验': '艺术实验', '运动竞技': '社交媒体内容',
      '美食文化': '社交媒体内容', '文化遗产': '纪录片', '旅游推广': '品牌宣传',
      '通用': '剧情短片'
    };

    const AUDIENCE_TO_PLATFORM = {
      '抖音用户': '抖音', '年轻人': '抖音', 'B站用户': 'B站',
      '小红书用户': '小红书', '国际用户': 'YouTube', '通用': '通用'
    };

    const productType = TYPE_TO_PRODUCT_TYPE[type] || '剧情短片';
    
    // 平台推断：优先从 target_audience 映射，其次从 audienceProfile 推断
    let targetPlatform = '通用';
    if (target_audience && AUDIENCE_TO_PLATFORM[target_audience]) {
      targetPlatform = AUDIENCE_TO_PLATFORM[target_audience];
    } else if (audienceProfile?.primaryAudience?.interestTags) {
      const interests = audienceProfile.primaryAudience.interestTags.join('');
      if (interests.includes('抖音') || interests.includes('短视频')) targetPlatform = '抖音';
      else if (interests.includes('B站') || interests.includes('哔哩')) targetPlatform = 'B站';
      else if (interests.includes('小红书') || interests.includes('RED')) targetPlatform = '小红书';
      else if (interests.includes('YouTube') || interests.includes('油管')) targetPlatform = 'YouTube';
      else if (interests.includes('TikTok') || interests.includes('国际版抖音')) targetPlatform = 'TikTok';
      else if (interests.includes('Instagram') || interests.includes('INS')) targetPlatform = 'Instagram';
    }

    // 画幅推断：短视频平台默认 9:16
    const aspectRatio = (targetPlatform === '抖音' || targetPlatform === '小红书') ? '9:16' : '16:9';

    // 分辨率：premium/film 档位用 4K，其他 1080p
    const resolution = (productType === '商业广告' || productType === '品牌宣传') ? '4K' : 
      (budgetProfile?.qualityTier === 'premium' || budgetProfile?.qualityTier === 'film') ? '4K' : '1080p';

    // 帧率：默认 24fps（电影感），MV/广告用 30fps
    const frameRate = (productType === '音乐MV' || productType === '商业广告') ? 30 : 24;

    return {
      productType,
      genre: type || '通用',
      targetPlatform,
      targetDuration: duration_sec || (sceneStructure?.totalDuration || 52),
      aspectRatio,
      resolution,
      frameRate
    };
  }

  // 极速 fallback（Agent 2/3 超时时使用）
  fallback(discoveryResult) {
    return this.process(discoveryResult);
  }
}

module.exports = { ProductDefinitionAgent };