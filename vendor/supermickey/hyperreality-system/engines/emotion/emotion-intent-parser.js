/**
 * Emotion Intent Parser — 情绪意图解析器 (SuperMickey)
 *
 * 融入点: Layer 0 (需求清单生成时)
 * 在 RequirementListBuilder 中集成，解析用户意图中的情绪维度
 *
 * 核心能力：
 * 1. 从用户意图文本中提取情绪关键词
 * 2. 推断情绪强度 (0.0-1.0)
 * 3. 识别情绪触发器（场景、动作、道具）
 * 4. 输出情绪档案：{ primary, secondary, intensity, triggers }
 */

class EmotionIntentParser {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;

    // 情绪关键词库（中文）
    this.emotionKeywords = {
      joy: ['喜悦', '开心', '欢乐', '愉快', '快乐', '欣喜', '兴奋', '狂喜', '幸福', '甜蜜', '温馨', '美好'],
      sadness: ['悲伤', '难过', '哀伤', '痛苦', '哭泣', '流泪', '心碎', '失落', '孤独', '寂寞', '凄凉'],
      anger: ['愤怒', '生气', '怒火', '暴怒', '愤慨', '仇恨', '愤恨', '怒气', '恼火', '气愤'],
      fear: ['恐惧', '害怕', '惊恐', '畏惧', '恐慌', '惊吓', '胆寒', '颤栗', '战栗', '不寒而栗'],
      surprise: ['惊讶', '震惊', '意外', '惊愕', '诧异', '惊奇', '惊喜', '惊异', '目瞪口呆'],
      nostalgia: ['怀旧', '回忆', '思念', '怀念', '追忆', '往昔', '旧时光', '乡愁', '往日'],
      tension: ['紧张', '焦虑', '不安', '紧绷', '悬疑', '压迫', '窒息', '危急', '惊险'],
      relief: ['放松', '释然', '安心', '解脱', '宽慰', '舒缓', '轻松', '平静', '宁静'],
      awe: ['震撼', '敬畏', ' awe', '壮丽', '宏伟', '磅礴', ' awe-inspiring', '叹为观止'],
      melancholy: ['忧郁', '惆怅', '忧伤', '感伤', ' melancholy', ' melancholic', '黯然', '神伤'],
      hope: ['希望', '期待', '憧憬', '盼望', '渴望', '向往', '希冀', '期许', '光明'],
      despair: ['绝望', '无望', '死心', '幻灭', '破灭', '深渊', '黑暗', '末路']
    };

    // 情绪强度推断词
    this.intensityModifiers = {
      high: ['非常', '极度', '极其', '强烈', '深深', '无比', '刻骨', '铭心', '滔天', '汹涌', '撕心裂肺', '肝肠寸断'],
      medium: ['比较', '有些', '略显', '微微', '淡淡的', '一丝', '几分', '些许', '轻微'],
      low: ['有点', '稍微', '略', '微微', ' faint', ' faintly', ' slight', ' slightly']
    };

    // 情绪触发器模式
    this.triggerPatterns = {
      rain: ['雨', '下雨', 'rain', 'rainy', 'drizzle', 'storm'],
      old_photo: ['老照片', '旧照片', '旧相片', '泛黄', 'old photo', 'vintage photo'],
      sunset: ['夕阳', '落日', '黄昏', 'sunset', 'dusk', 'twilight'],
      childhood: ['童年', '小时候', '儿时', 'childhood', 'youth', 'young'],
      music: ['音乐', '旋律', '歌曲', 'music', 'melody', 'song', 'piano', 'violin'],
      letter: ['信', '信件', '书信', 'letter', 'envelope', 'handwritten'],
      reunion: ['重逢', '相聚', '团圆', 'reunion', 'meet again', 'together again'],
      departure: ['离别', '分别', '分手', 'departure', 'farewell', 'goodbye', 'parting'],
      sacrifice: ['牺牲', '奉献', '付出', 'sacrifice', 'devotion', 'dedication'],
      victory: ['胜利', '成功', ' triumph', 'victory', 'win', 'success', 'achievement']
    };
  }

  /**
   * 主入口：解析情绪意图
   * @param {string} intent - 用户原始意图
   * @param {Object} metadata - 元数据
   * @returns {Object} 情绪档案 { primary, secondary, intensity, triggers, confidence }
   */
  parse(intent, metadata = {}) {
    if (!this.enabled || !intent) {
      return { primary: 'neutral', secondary: null, intensity: 0.5, triggers: [], confidence: 0 };
    }

    const text = intent.toLowerCase();

    // 1. 提取主要情绪
    const emotionScores = {};
    for (const [emotion, keywords] of Object.entries(this.emotionKeywords)) {
      for (const keyword of keywords) {
        if (text.includes(keyword.toLowerCase())) {
          emotionScores[emotion] = (emotionScores[emotion] || 0) + 1;
        }
      }
    }

    // 2. 推断情绪强度
    let intensity = 0.5; // 默认中等
    for (const [level, modifiers] of Object.entries(this.intensityModifiers)) {
      for (const modifier of modifiers) {
        if (text.includes(modifier.toLowerCase())) {
          intensity = level === 'high' ? 0.85 : level === 'medium' ? 0.6 : 0.3;
        }
      }
    }

    // 3. 提取情绪触发器
    const triggers = [];
    for (const [trigger, keywords] of Object.entries(this.triggerPatterns)) {
      for (const keyword of keywords) {
        if (text.includes(keyword.toLowerCase())) {
          if (!triggers.includes(trigger)) {
            triggers.push(trigger);
          }
        }
      }
    }

    // 4. 确定主要和次要情绪
    const sortedEmotions = Object.entries(emotionScores)
      .sort((a, b) => b[1] - a[1]);

    const primary = sortedEmotions.length > 0 ? sortedEmotions[0][0] : 'neutral';
    const secondary = sortedEmotions.length > 1 ? sortedEmotions[1][0] : null;
    const confidence = sortedEmotions.length > 0 ? Math.min(1.0, sortedEmotions[0][1] * 0.3) : 0;

    // 5. 从 metadata 风格补充情绪
    if (metadata.style?.primary) {
      const styleEmotion = this._mapStyleToEmotion(metadata.style.primary);
      if (styleEmotion && styleEmotion !== primary) {
        if (!secondary) {
          // 风格作为次要情绪
        }
      }
    }

    return {
      primary,
      secondary,
      intensity,
      triggers,
      confidence,
      allEmotions: emotionScores
    };
  }

  _mapStyleToEmotion(style) {
    const styleMap = {
      '悬疑': 'tension',
      '恐怖': 'fear',
      '治愈': 'relief',
      '热血': 'joy',
      '史诗': 'awe',
      '暗黑': 'despair',
      '温馨': 'joy',
      '感人': 'sadness',
      '悲壮': 'melancholy',
      '紧张': 'tension'
    };
    return styleMap[style] || null;
  }
}

module.exports = { EmotionIntentParser };
