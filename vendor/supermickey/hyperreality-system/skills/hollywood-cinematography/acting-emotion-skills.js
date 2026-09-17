/**
 * Acting Emotion Skills - 表演情绪技能库
 * 将技能文件中的情绪指导转化为 shots 的 emotion 字段
 * 独立于技能路由文件，提供可扩展的情绪表演工具
 */

const EMOTION_KEYWORDS = {
  // 情绪关键词 → 表演指导模板
  'lonely': {
    facial: '面部线条柔和放松，眼神略微涣散，嘴角自然下垂，传递内心的孤独与疏离',
    body: '身体姿态轻微蜷缩，肩膀微微下沉，动作缓慢而克制',
    eyeContact: false,
    intensity: 3
  },
  'emotional': {
    facial: '面部肌肉微微颤动，眼眶湿润，嘴角轻微颤抖，传递强烈的情感波动',
    body: '身体姿态开放但紧绷，手势有节制但有力，呼吸略微急促',
    eyeContact: true,
    intensity: 7
  },
  'tense': {
    facial: '眉头紧锁，下颌微收，面部肌肉紧绷，眼神锐利专注',
    body: '身体姿态僵硬，肩膀微耸，动作精准克制，充满紧张感',
    eyeContact: false,
    intensity: 8
  },
  'tender': {
    facial: '面部柔和放松，眼神温暖亲切，嘴角微微上扬，传递温柔与关怀',
    body: '身体姿态舒展优雅，动作轻柔缓慢，姿态开放亲和',
    eyeContact: true,
    intensity: 4
  },
  'epic': {
    facial: '面部坚毅沉稳，眼神深邃而坚定，下巴微抬，传递英雄气概与宏大感',
    body: '身体姿态挺拔有力，动作沉稳大气，姿态充满力量与自信',
    eyeContact: true,
    intensity: 9
  },
  'romantic': {
    facial: '面部柔和放松，眼神温柔含情，嘴角微扬，传递浪漫与爱意',
    body: '身体姿态优雅舒展，动作轻柔细腻，姿态充满优雅与温存',
    eyeContact: true,
    intensity: 5
  },
  'mysterious': {
    facial: '面部表情内敛克制，眼神深邃但略显疏离，嘴角若隐若现',
    body: '身体姿态放松但警觉，动作轻盈，姿态充满神秘感与不可知性',
    eyeContact: false,
    intensity: 6
  },
  'suspenseful': {
    facial: '面部紧张但克制，眼神警觉环顾，眉头微蹙，传递悬疑与不安',
    body: '身体姿态半蜷缩，动作轻微但警觉，姿态充满不确定感',
    eyeContact: false,
    intensity: 7
  },
  'absurd': {
    facial: '面部表情夸张但控制，眼神略带戏谑，嘴角弧度夸张，传递荒诞感',
    body: '身体姿态不协调但有意，动作夸张但节奏不对，姿态充满戏剧性',
    eyeContact: true,
    intensity: 6
  },
  'oppressive': {
    facial: '面部沉重压抑，眼神向下，嘴角紧绷，传递压迫与无助',
    body: '身体姿态被压缩，肩膀下沉，动作受限制，姿态充满压抑感',
    eyeContact: false,
    intensity: 8
  }
};

/**
 * 根据情绪类型为 shot 添加表演指导
 * @param {object} shot - 镜头对象
 * @param {string} emotion - 情绪关键词（如 'lonely', 'tense'）
 * @returns {object} 带有表演增强的 shot
 */
function injectEmotionToShot(shot, emotion) {
  if (!shot || !emotion) return shot;

  const config = EMOTION_KEYWORDS[emotion.toLowerCase()] || EMOTION_KEYWORDS['emotional'];
  const result = { ...shot };

  // 创建表演指导字段
  const emotionGuidance = [];
  if (config.facial) {
    emotionGuidance.push(`【面部表演】${config.facial}`);
  }
  if (config.body) {
    emotionGuidance.push(`【身体语言】${config.body}`);
  }
  if (config.eyeContact !== undefined) {
    emotionGuidance.push(`【眼神交流】${config.eyeContact ? '保持眼神接触，传递情感连接' : '避免直接眼神交流，传递疏离或内省'}`);
  }
  emotionGuidance.push(`【情绪强度】${config.intensity}/10`);

  // 注入到 shot 的 emotion 字段或扩展字段
  result.emotion = emotionGuidance.join('。');
  result._emotionConfig = config;
  result._emotionApplied = true;

  return result;
}

/**
 * 批量注入情绪到所有 shots
 * @param {array} shots - 镜头数组
 * @param {object} emotionMap - { shotId: emotion } 映射
 * @returns {array} 增强后的 shots
 */
function injectEmotionsToShots(shots, emotionMap) {
  if (!shots || !Array.isArray(shots)) return shots;
  return shots.map(shot => {
    if (emotionMap && emotionMap[shot.shotId]) {
      return injectEmotionToShot(shot, emotionMap[shot.shotId]);
    }
    return shot;
  });
}

/**
 * 从提示词中推断情绪类型
 * @param {string} prompt - 镜头提示词
 * @returns {string|null} 推断的情绪关键词
 */
function inferEmotionFromPrompt(prompt) {
  if (!prompt || typeof prompt !== 'string') return null;
  const promptLower = prompt.toLowerCase();
  
  const emotionMap = {
    'lonely': ['孤独', '孤寂', 'alone', 'lonely', 'isolated'],
    'tense': ['紧张', 'tense', '紧张', 'anxious', 'stress'],
    'emotional': ['情感', '情感', 'emotional', 'touching', 'moving'],
    'tender': ['温柔', '温情', 'tender', 'gentle', 'warm'],
    'epic': ['史诗', '宏大', 'epic', 'grand', 'heroic'],
    'romantic': ['浪漫', '浪漫', 'romantic', 'love', 'passionate'],
    'mysterious': ['神秘', '神秘', 'mysterious', 'enigmatic', 'mystery'],
    'suspenseful': ['悬疑', '悬疑', 'suspenseful', 'suspense', 'thriller'],
    'absurd': ['荒诞', '荒诞', 'absurd', 'comic', 'ridiculous'],
    'oppressive': ['压迫', '压抑', 'oppressive', 'pressured', 'suppressed']
  };

  for (const [emotion, keywords] of Object.entries(emotionMap)) {
    if (keywords.some(kw => promptLower.includes(kw.toLowerCase()))) {
      return emotion;
    }
  }

  return null;
}

module.exports = {
  injectEmotionToShot,
  injectEmotionsToShots,
  inferEmotionFromPrompt,
  EMOTION_KEYWORDS
};
