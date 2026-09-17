
/**
 * ProfileResolver - 生产画像解析器
 *
 * 输入：用户原始意图（任意文本/结构化主题）
 * 输出：{ genre, profile } —— genre 开放保留用户题材，profile 结构化驱动生产
 *
 * 三级兜底：LLM 生成 → 关键词粗推 → 全默认安全落地。任何情况下不中断流程。
 * （取代 DynamicTypeResolver 的生产管控职责；主题生成器侧的动态类型配置可继续用它）
 */

const { normalizeProfile, closestPreset } = require('../../../config/production-profile');

class ProfileResolver {
  constructor(options = {}) {
    this.llmEngine = options.llmEngine || null;
    this.timeoutMs = options.timeoutMs || 60000;
    this._cache = new Map(); // 进程内缓存：意图哈希 → profile
  }

  /**
   * 主入口
   * @param {string|object} intent - 用户意图（文本或结构化主题对象）
   * @returns {Promise<{genre: string, genreConfidence: string, profile: object, profileSource: string, presetRef: string}>}
   */
  async resolve(intent) {
    const { text, genreHint } = this._extractIntent(intent);
    const cacheKey = this._hash(text + '|' + (genreHint || ''));
    if (this._cache.has(cacheKey)) {
      console.log('[ProfileResolver] ✅ 缓存命中');
      return this._cache.get(cacheKey);
    }

    let result = null;

    // 第一级：LLM 生成
    if (this.llmEngine) {
      try {
        result = await this._resolveWithLLM(text, genreHint);
      } catch (e) {
        console.warn(`[ProfileResolver] ⚠️ LLM 画像生成失败: ${e.message}，降级关键词粗推`);
      }
    }

    // 第二级：关键词粗推（无 LLM 或 LLM 失败）
    if (!result) {
      result = this._resolveWithKeywords(text, genreHint);
    }

    // 第三级：normalizeProfile 保证任何残缺都安全落地（永不出错）
    result.profile = normalizeProfile(result.profile);
    result.presetRef = closestPreset(result.profile);
    this._cache.set(cacheKey, result);

    console.log(`[ProfileResolver] 🎯 genre="${result.genre}" | mode=${result.profile.narrative_mode} dialogue=${result.profile.dialogue_density} safety=${result.profile.safety_level} factual=${result.profile.factual_accuracy} | source=${result.profileSource}`);
    return result;
  }

  _extractIntent(intent) {
    if (typeof intent === 'string') return { text: intent, genreHint: null };
    if (intent && typeof intent === 'object') {
      return {
        text: [intent.theme, intent.description, intent.text, intent.title].filter(Boolean).join('。'),
        genreHint: intent.type || intent.genre || null
      };
    }
    return { text: String(intent || ''), genreHint: null };
  }

  async _resolveWithLLM(text, genreHint) {
    const prompt = `你是一位视频制作总监。根据用户的创作意图，输出"题材(genre)"和"制作画像(profile)"。

【用户意图】
${text || '未明确'}
${genreHint ? `【用户声明的题材】${genreHint}（原样保留，不要改写）` : ''}

【输出要求】只输出合法 JSON：
{
  "genre": "用户题材的原样保留或精准概括（如'儿童财商动画短剧'、'宠物殡葬纪实'，不要套用既有类型名）",
  "profile": {
    "narrative_mode": "dramatic(讲故事)|educational(教知识)|documentary(做记录)|lifelog(生活流)|commercial(卖东西) 五选一",
    "dialogue_density": "none(无台词)|low(极少)|medium(适中)|high(台词驱动)",
    "factual_accuracy": "strict(事实必须准确,如科普/新闻/医疗)|normal|free(虚构创作)",
    "safety_level": "kids(儿童向)|strict(强审核)|moderate|free",
    "visual_register": "realistic(写实)|stylized(风格化)|abstract(抽象)",
    "pacing": "slow|medium|fast",
    "duration_target": 目标时长秒数(数字),
    "audience": "目标受众一句话",
    "special_constraints": ["该题材专属的硬性约束，如'不出现品牌logo'，没有就空数组"]
  }
}

判断准则：
- 题材千变万化，genre 必须忠于用户原意，禁止向既有类型表靠拢
- profile 是对"这个片子该怎么制作"的专业判断，不是对题材的分类`;

    if (typeof this.llmEngine.reasonStructured === 'function') {
      const result = await this.llmEngine.reasonStructured(prompt, {
        required: ['genre', 'profile']
      }, { maxTokens: 2000, temperature: 1, timeoutMs: this.timeoutMs });
      if (result && result.success && result.data && result.data.genre) {
        return {
          genre: String(result.data.genre).trim(),
          genreConfidence: genreHint ? 'user_explicit' : 'llm_inferred',
          profile: result.data.profile || {},
          profileSource: 'llm'
        };
      }
      throw new Error(result?.error || 'LLM 返回无效');
    }
    throw new Error('LLM 引擎不支持 reasonStructured');
  }

  /**
   * 关键词粗推（保守版：只推高置信度信号，其余交给默认值）
   */
  _resolveWithKeywords(text, genreHint) {
    const t = (text || '').toLowerCase();
    const has = (...words) => words.some(w => t.includes(w));

    const profile = {};
    // 叙事模式
    if (has('科普', '教程', '讲解', '知识', '原理', '学会')) profile.narrative_mode = 'educational';
    else if (has('纪录', '纪实', '采访', '真实')) profile.narrative_mode = 'documentary';
    else if (has('广告', '品牌', '营销', '带货', '宣传')) profile.narrative_mode = 'commercial';
    else if (has('日常', 'vlog', '记录生活', '聚会')) profile.narrative_mode = 'lifelog';
    // 安全级别
    if (has('孩子', '儿童', '宝宝', '幼儿', '小学生', '少儿')) profile.safety_level = 'kids';
    // 事实要求
    if (has('科普', '医疗', '健康', '财经', '新闻', '法律', '教程')) profile.factual_accuracy = 'strict';
    // 台词密度
    if (has('无台词', '纯画面', 'mv', '歌舞')) profile.dialogue_density = 'low';
    else if (has('脱口秀', '访谈', '对话', '剧情', '短剧')) profile.dialogue_density = 'high';
    // 视觉语域
    if (has('动画', '动漫', '卡通', '二次元', '风格化')) profile.visual_register = 'stylized';
    else if (has('抽象', '意识流', '实验')) profile.visual_register = 'abstract';
    // 时长
    const durMatch = t.match(/(\d+)\s*(秒|s\b)/);
    if (durMatch) profile.duration_target = parseInt(durMatch[1]);

    // 【v2.1.15-fix 主题漂移】genre 兜底取第一个语义完整子句（≤20字符），
    // 不再硬 slice(0,20) 腰斩句子丢失核心信息
    const genreFallback = (() => {
      const t = String(text || '').trim();
      if (!t) return '通用主题';
      const clause = t.split(/[，。！？；：:]/)[0].trim();
      return (clause.length <= 20 ? clause : clause.slice(0, 20)) || '通用主题';
    })();

    return {
      genre: genreHint || genreFallback,
      genreConfidence: genreHint ? 'user_explicit' : 'fallback',
      profile,
      profileSource: 'keywords'
    };
  }

  _hash(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
    return String(h);
  }
}

module.exports = { ProfileResolver };