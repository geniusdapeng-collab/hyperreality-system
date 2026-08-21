/**
 * MYTHOS ENGINE — Beast + XiaoG Integration Module
 * ASTRALIS v3.0
 *
 * MYTHOS answers: "Who tells this story?"
 * - Beasts are walking manifestations of Nirath's natural forces
 * - XiaoG is the emotional anchor and scale reference
 * - Every ASTRALIS effect can be "initiated" or "witnessed" by a beast
 *
 * @module mythos-engine
 * @version 1.0
 */

// ─────────────────────────────────────────
// 10.2 异兽 Nirath 化档案
// ─────────────────────────────────────────

const BEAST_PROFILES = {
  nineTailedFox: {
    name: '九尾狐',
    title: '磁场编织者',
    description: '不是"有九条尾巴的狐狸"，它是Nirath磁场的活体显化',
    body: '身长4米，硅化碳纤维骨架，磁流体生物封装体肌肉',
    fur: '10纳米虚空丝编织层，磁场中对齐发出蓝紫微光',
    tails: '各对应磁场一个谐波频率，尾尖喷射8000-12000K等离子体',
    eyes: '琥珀色六边形瞳孔 = 双恒星光聚焦透镜',
    movement: '利用磁场线"滑行"，最高120km/h，看起来像漂移',
    ecology: '磁场调节者——它走到哪，磁场线就随它重组',
    materials: ['ferroflux', 'voidSilk', 'plasmaTendril'],
    bestKinetics: 'magnetic_storm_birth',
    altKinetics: 'spore_terraformation',
    paradigm: 'weaving',
    xiaoGPosition: 'cliffGaze',
    emotionalTone: '优雅、神秘',
    promptTemplate: `【MYTHOS异兽档案 — 九尾狐：磁场编织者】身长4米，硅化碳纤维骨架，磁流体生物封装体肌肉。"毛发"为10纳米虚空丝编织层，磁场中对齐发出蓝紫微光。九条尾巴各对应磁场一个谐波频率，尾尖喷射8000-12000K等离子体（磁场约束不灼伤友方）。琥珀色六边形瞳孔为双恒星光聚焦透镜，瞳孔中可反射对面景物影子。利用磁场线滑行，最高120km/h。生态位：磁场调节者。`
  },

  yingLong: {
    name: '应龙',
    title: '风暴驾驶员',
    description: '不是"有翅膀的龙"，它是Nirath大气系统的活体控制器',
    body: '翼展60米，体长25米，高密度气凝胶构成（0.82G下仅重200kg）',
    wings: '两片直径40米的旋转磁暴盘，边缘是电离气体发光环',
    appearance: '活体以太孢子群落 — 提供生物发光伪装',
    flight: '不拍翅膀——"驾驶"气流，利用磁场线作为航线',
    breath: '定向电磁脉冲——可"点燃"量子苔藓的发光反应',
    ecology: '大气操控者——唯一能在双恒星风暴中自由飞行的生物',
    materials: ['aetherSpore', 'plasmaTendril', 'voidSilk'],
    bestKinetics: 'aurora_weave',
    altKinetics: 'fractal_zoom',
    paradigm: 'weaving',
    xiaoGPosition: 'islandEdge',
    emotionalTone: '自由、宏大',
    promptTemplate: `【MYTHOS异兽档案 — 应龙：风暴驾驶员】翼展60米，体长25米，高密度气凝胶构成（0.82G下仅重200kg）。翅膀为两片直径40米的旋转磁暴盘，边缘是电离气体发光环。活体以太孢子群落提供生物发光伪装。不拍翅膀而"驾驶"气流，利用磁场线作为航线。定向电磁脉冲可"点燃"量子苔藓的发光反应。生态位：大气操控者。`
  },

  zhuLong: {
    name: '烛龙',
    title: '恒星凝视者',
    description: '不是"眼睛发光的龙"，它是Nirath上唯一直视双恒星而不致盲的生物',
    body: '体长200米，半透明等离子体约束管——可透过身体看到背后',
    leftEye: 'Aurelius之眼——金色等离子球，12000K，直径15米',
    rightEye: 'Silvana之眼——银白色等离子球，15000K，直径15米',
    scales: '微型引力透镜——每一片都是磁场微泡，可弯曲光线',
    ability: '睁眼/闭眼 = 局部地区进入白昼/暗夜——它是"移动日光灯"',
    ecology: '恒星能量调节者——双恒星与地表之间的"变压器"',
    materials: ['plasmaTendril', 'gravitationalLens'],
    bestKinetics: 'eclipse_corona',
    altKinetics: 'silence_impact',
    paradigm: 'summon',
    xiaoGPosition: 'crystalPeak',
    emotionalTone: '神圣、威严',
    promptTemplate: `【MYTHOS异兽档案 — 烛龙：恒星凝视者】体长200米，半透明等离子体约束管。左眼Aurelius之眼——金色等离子球12000K直径15米。右眼Silvana之眼——银白色等离子球15000K直径15米。鳞片为微型引力透镜，每一片都是磁场微泡。睁眼局部白昼，闭眼局部暗夜。生态位：恒星能量调节者。`
  },

  baiZe: {
    name: '白泽',
    title: '知识结晶体',
    description: '不是"通晓万物的神兽"，它是Nirath生态记忆的活体存储器',
    body: '身长3米，外形似鹿，表面覆盖活体水晶生长层',
    horns: 'Nirath最大晶质记忆体——内部封存着星球全部生态记录',
    eyes: '双折射水晶体——同时看到Aurelius和Silvana两个视角',
    ability: '蹄子接触地面时读取量子苔藓网络的记忆',
    emotion: '平静=水晶光滑，好奇=水晶分支生长，警觉=裂纹+压电火花',
    ecology: '记忆守护者——Nirath的"活图书馆"',
    materials: ['crystallineMemory', 'quantumMoss'],
    bestKinetics: 'crystal_cathedral',
    altKinetics: 'fractal_zoom',
    paradigm: 'weaving',
    xiaoGPosition: 'silverwoodForest',
    emotionalTone: '智慧、温柔',
    promptTemplate: `【MYTHOS异兽档案 — 白泽：知识结晶体】身长3米，外形似鹿，表面覆盖活体水晶生长层。角为Nirath最大晶质记忆体，内部封存星球全部生态记录。眼睛为双折射水晶体，同时看到Aurelius和Silvana两个视角。蹄子接触地面时读取量子苔藓网络记忆。生态位：记忆守护者。`
  },

  qiongQi: {
    name: '穷奇',
    title: '熵增化身',
    description: '不是"凶猛的怪兽"，它是Nirath热力学第二定律的活体显化',
    body: '没有固定形态——由色层流体构成，颜色时刻随机切换',
    core: '反磁性晶体——产生"磁场空洞"，周围10米磁场线被排斥',
    effect: '秩序真空——苔藓停止同步、磁流体坠落、水晶停止生长',
    movement: '不是"移动"是"扩散"——如墨水滴入水中',
    meaning: 'Nirath的"解构者"——防止星球陷入永恒的静态完美',
    ecology: '熵增执行者——破坏是另一种创造',
    materials: ['chromaFluid', 'gravitationalLens'],
    bestKinetics: 'silence_impact',
    altKinetics: 'probability_collapse',
    paradigm: 'witness',
    xiaoGPosition: 'ferrofluidPool',
    emotionalTone: '危险、迷幻',
    promptTemplate: `【MYTHOS异兽档案 — 穷奇：熵增化身】没有固定形态，由色层流体构成，颜色时刻随机切换。核心为反磁性晶体，产生"磁场空洞"，周围10米磁场线被排斥。存在效应：秩序真空——苔藓停止同步、磁流体坠落、水晶停止生长。生态位：熵增执行者。`
  },

  phoenix: {
    name: '凤凰',
    title: '等离子生命体',
    description: '没有实体。它是一团自持的等离子体反应',
    body: '纯等离子体——电离氢氦发光云，8000-15000K',
    feathers: '每根"羽毛"是一条独立等离子触须，张开=散热，收拢=蓄能',
    eyes: '两个磁场节点——温度最低（6000K），呈深邃量子青',
    lifecycle: '蛋→磁场骨架（不可见）→恒星风点燃→壮大→消散→骨架留存',
    reincarnation: 'Nirath上同时存在数百个不可见磁场骨架，恒星风到达阈值时点燃',
    ecology: '永恒轮回的象征——创世-毁灭-重生的活体寓言',
    materials: ['plasmaTendril', 'voidSilk', 'aetherSpore'],
    bestKinetics: 'phoenix_cycle',
    altKinetics: 'binary_convergence',
    paradigm: 'embodiment',
    xiaoGPosition: 'sporeMist',
    emotionalTone: '壮烈、轮回',
    promptTemplate: `【MYTHOS异兽档案 — 凤凰：等离子生命体】纯等离子体，电离氢氦发光云8000-15000K。每根"羽毛"是独立等离子触须。眼睛为两个磁场节点，温度最低6000K呈量子青。生命周期：蛋→磁场骨架→恒星风点燃→壮大→消散→骨架留存。生态位：永恒轮回的象征。`
  }
};

// ─────────────────────────────────────────
// 10.3 小G 观测者系统
// ─────────────────────────────────────────

const XIAO_G_PROFILE = {
  name: '小G',
  age: 8,
  height: '1.2米',
  appearance: '黑色短发，琥珀色眼睛（与九尾狐同色——暗示某种联系）',
  clothing: 'Nirath探险者服装（磁流体纤维编织，感应磁场发出微弱振动）',
  abilities: {
    magneticTouch: '皮肤能感知30Hz磁场共鸣——通过探险服的振动反馈',
    sporeAffinity: '以太孢子主动聚集在他周围，形成微弱发光雾',
    beastFriendly: '生物磁场频率恰好是异兽的"友好信号"——不会被攻击'
  }
};

const OBSERVATION_POSITIONS = {
  cliffGaze: {
    name: '悬崖仰望',
    location: '悬浮岛边缘，脚下数千米深渊',
    emotion: '敬畏（Awe）',
    scale: '极小人类 vs 极大天空',
    bestBeasts: ['nineTailedFox', 'zhuLong'],
    prompt: '悬崖边缘站立仰望，瞳孔放大，嘴角微微上扬，一只手不自觉地抬起。他是这个奇迹的见证者。'
  },
  silverwoodForest: {
    name: '银木林中',
    location: '发光银色树木环绕',
    emotion: '好奇（Curiosity）',
    scale: '亲密尺度，森林神秘生物',
    bestBeasts: ['baiZe', 'nineTailedFox'],
    prompt: '在银木林中站立，发光银色树木环绕，好奇地观察前方，身体微微前倾。'
  },
  ferrofluidPool: {
    name: '磁流体池畔',
    location: '液态镜面池边',
    emotion: '沉思（Contemplation）',
    scale: '实体+倒影双重存在',
    bestBeasts: ['qiongQi', 'phoenix'],
    prompt: '在磁流体池边蹲下，低头看着池中倒影，倒影中的标题是唯一稳定的东西。'
  },
  sporeMist: {
    name: '孢子雾中',
    location: '高密度孢子区，能见度<10米',
    emotion: '梦幻（Dreaminess）',
    scale: '亲密尺度，局部特写',
    bestBeasts: ['phoenix', 'nineTailedFox'],
    prompt: '在高密度孢子雾中站立，周围能见度极低，孢子主动聚集形成微弱发光雾。'
  },
  crystalPeak: {
    name: '水晶尖顶',
    location: '巨型紫水晶簇顶端',
    emotion: '兴奋（Excitement）',
    scale: '世界之巅的征服感',
    bestBeasts: ['zhuLong', 'yingLong'],
    prompt: '站在巨型紫水晶簇顶端，被光柱笼罩，双手张开迎接光芒。'
  },
  islandEdge: {
    name: '悬浮岛边缘',
    location: '岛屿下表面边缘',
    emotion: '冒险（Adventure）',
    scale: '反重力环境的刺激',
    bestBeasts: ['yingLong', 'phoenix'],
    prompt: '在悬浮岛边缘站立，看着应龙从下方掠过，头发被气流吹动。'
  }
};

const EMOTIONAL_CURVE = {
  '0-2s': { stage: '好奇启动', expression: '头微斜，眉毛上扬', bodyLanguage: '重心前移，脚尖朝向事件', narrative: '"发现"——引导观众注意' },
  '2-4s': { stage: '震撼升级', expression: '瞳孔放大，嘴巴微张', bodyLanguage: '后退半步，手抬起惊叹', narrative: '告诉观众"这很壮观"' },
  '4-6s': { stage: '融入沉浸', expression: '从震惊转微笑', bodyLanguage: '主动前进一步，伸手触碰', narrative: '从旁观者变为参与者' },
  '6-8s': { stage: '标题显现', expression: '恍然大悟的满足笑容', bodyLanguage: '双手自然下垂，身体放松', narrative: '标题是他"见证"诞生的' },
  '8-9s': { stage: '余韵回味', expression: '微笑持续，眼神环顾', bodyLanguage: '整理头发，或深吸一口气', narrative: '这个瞬间成为记忆' }
};

// ─────────────────────────────────────────
// 10.4 异兽-材质-动效 三位一体矩阵
// ─────────────────────────────────────────

const TRINITY_MATRIX = {
  nineTailedFox: {
    materials: ['ferroflux', 'voidSilk', 'plasmaTendril'],
    bestKinetics: 'magnetic_storm_birth',
    altKinetics: 'spore_terraformation',
    xiaoGPosition: 'cliffGaze',
    paradigm: 'weaving',
    emotionalTone: '优雅、神秘'
  },
  yingLong: {
    materials: ['plasmaTendril', 'aetherSpore', 'voidSilk'],
    bestKinetics: 'aurora_weave',
    altKinetics: 'fractal_zoom',
    xiaoGPosition: 'islandEdge',
    paradigm: 'weaving',
    emotionalTone: '自由、宏大'
  },
  zhuLong: {
    materials: ['plasmaTendril', 'gravitationalLens'],
    bestKinetics: 'eclipse_corona',
    altKinetics: 'silence_impact',
    xiaoGPosition: 'crystalPeak',
    paradigm: 'summon',
    emotionalTone: '神圣、威严'
  },
  baiZe: {
    materials: ['crystallineMemory', 'quantumMoss'],
    bestKinetics: 'crystal_cathedral',
    altKinetics: 'fractal_zoom',
    xiaoGPosition: 'silverwoodForest',
    paradigm: 'weaving',
    emotionalTone: '智慧、温柔'
  },
  qiongQi: {
    materials: ['chromaFluid', 'gravitationalLens'],
    bestKinetics: 'silence_impact',
    altKinetics: 'probability_collapse',
    xiaoGPosition: 'ferrofluidPool',
    paradigm: 'witness',
    emotionalTone: '危险、迷幻'
  },
  phoenix: {
    materials: ['plasmaTendril', 'voidSilk', 'aetherSpore'],
    bestKinetics: 'phoenix_cycle',
    altKinetics: 'binary_convergence',
    xiaoGPosition: 'sporeMist',
    paradigm: 'embodiment',
    emotionalTone: '壮烈、轮回'
  }
};

// ─────────────────────────────────────────
// 10.5 异兽参与标题的四种范式
// ─────────────────────────────────────────

const PARADIGMS = {
  weaving: {
    name: '编织型',
    description: '异兽主动用身体"编织"标题',
    examples: '九尾狐尾巴挥动/应龙飞行轨迹 = 笔画路径'
  },
  summon: {
    name: '召唤型',
    description: '异兽能力"召唤"出标题',
    examples: '烛龙睁眼释放光柱投射出标题'
  },
  witness: {
    name: '见证型',
    description: '天文事件自然形成，异兽共同见证',
    examples: '白泽、穷奇作为发现者'
  },
  embodiment: {
    name: '化身型',
    description: '标题直接就是异兽本身',
    examples: '凤凰飞行轨迹本身就是标题'
  }
};

// ─────────────────────────────────────────
// MYTHOS API
// ─────────────────────────────────────────

/**
 * 获取异兽档案
 * @param {string} beastKey - 异兽键名
 * @returns {Object|null} 完整档案
 */
function getBeastProfile(beastKey) {
  return BEAST_PROFILES[beastKey] || null;
}

/**
 * 获取所有异兽列表
 * @returns {Array} [{key, name, title, emotionalTone}]
 */
function getAllBeasts() {
  return Object.entries(BEAST_PROFILES).map(([key, profile]) => ({
    key,
    name: profile.name,
    title: profile.title,
    emotionalTone: profile.emotionalTone
  }));
}

/**
 * 三位一体推荐
 * @param {string} beastKey - 异兽键名
 * @param {string} mood - 情感基调
 * @returns {Object} { beast, materials, bestKinetics, altKinetics, xiaoGPosition, paradigm, emotionalTone }
 */
function recommendTrinity(beastKey, mood = 'epic') {
  const beast = BEAST_PROFILES[beastKey];
  if (!beast) return null;

  const trinity = TRINITY_MATRIX[beastKey];
  if (!trinity) return null;

  return {
    beast: {
      key: beastKey,
      name: beast.name,
      title: beast.title,
      description: beast.description
    },
    materials: trinity.materials,
    bestKinetics: trinity.bestKinetics,
    altKinetics: trinity.altKinetics,
    xiaoGPosition: trinity.xiaoGPosition,
    paradigm: trinity.paradigm,
    emotionalTone: trinity.emotionalTone,
    mood
  };
}

/**
 * 生成MYTHOS异兽段落Prompt
 * @param {string} beastKey - 异兽键名
 * @returns {string} 异兽档案Prompt段落
 */
function generateBeastSection(beastKey) {
  const beast = BEAST_PROFILES[beastKey];
  if (!beast) return '';
  return beast.promptTemplate;
}

/**
 * 生成小G角色段落Prompt
 * @param {string} positionKey - 观测位置键名
 * @param {Object} options - 选项
 * @returns {string} 小G角色Prompt段落
 */
function generateXiaoGSection(positionKey, options = {}) {
  const position = OBSERVATION_POSITIONS[positionKey];
  if (!position) return '';

  let prompt = `【角色 — 小G】${XIAO_G_PROFILE.age}岁男孩，身高${XIAO_G_PROFILE.height}，${XIAO_G_PROFILE.appearance}，${XIAO_G_PROFILE.clothing}。`;
  prompt += `${position.prompt}\n`;

  // 情感曲线
  if (options.includeEmotionalCurve) {
    prompt += '\n【小G情感曲线】\n';
    Object.entries(EMOTIONAL_CURVE).forEach(([time, data]) => {
      prompt += `${time} ${data.stage}：${data.expression}，${data.bodyLanguage}\n`;
    });
  }

  return prompt;
}

/**
 * 生成完整MYTHOS段落（异兽+小G+三位一体）
 * @param {Object} config - 配置
 * @param {string} config.beast - 异兽键名
 * @param {string} config.xiaoGPosition - 观测位置
 * @param {string} config.titleText - 标题文本
 * @param {boolean} config.includeEmotionalCurve - 包含情感曲线
 * @returns {string} 完整MYTHOS段落
 */
function generateMythosSection(config) {
  let prompt = '';

  // 异兽档案
  prompt += generateBeastSection(config.beast) + '\n\n';

  // 小G角色
  prompt += generateXiaoGSection(config.xiaoGPosition, {
    includeEmotionalCurve: config.includeEmotionalCurve
  }) + '\n';

  // 范式说明
  const beast = BEAST_PROFILES[config.beast];
  if (beast) {
    const paradigm = PARADIGMS[beast.paradigm];
    if (paradigm) {
      prompt += `【MYTHOS范式 — ${paradigm.name}】${paradigm.description}。${beast.name}以"${paradigm.name}"方式参与标题形成。\n`;
    }
  }

  return prompt;
}

/**
 * 获取观测位置列表
 * @returns {Array} [{key, name, emotion, scale}]
 */
function getObservationPositions() {
  return Object.entries(OBSERVATION_POSITIONS).map(([key, pos]) => ({
    key,
    name: pos.name,
    emotion: pos.emotion,
    scale: pos.scale,
    bestBeasts: pos.bestBeasts
  }));
}

/**
 * 获取情感曲线
 * @returns {Object} 情感曲线定义
 */
function getEmotionalCurve() {
  return EMOTIONAL_CURVE;
}

/**
 * 根据标题内容推荐异兽
 * @param {string} titleText - 标题文本
 * @returns {string} 推荐异兽键名
 */
function recommendBeastForTitle(titleText) {
  const lower = titleText.toLowerCase();
  if (lower.includes('fox') || lower.includes('狐')) return 'nineTailedFox';
  if (lower.includes('dragon') || lower.includes('龙')) return 'yingLong';
  if (lower.includes('candle') || lower.includes('烛')) return 'zhuLong';
  if (lower.includes('white') || lower.includes('白泽')) return 'baiZe';
  if (lower.includes('chaos') || lower.includes('穷奇')) return 'qiongQi';
  if (lower.includes('phoenix') || lower.includes('凤凰')) return 'phoenix';
  return 'nineTailedFox'; // default
}

module.exports = {
  BEAST_PROFILES,
  XIAO_G_PROFILE,
  OBSERVATION_POSITIONS,
  EMOTIONAL_CURVE,
  TRINITY_MATRIX,
  PARADIGMS,
  getBeastProfile,
  getAllBeasts,
  recommendTrinity,
  generateBeastSection,
  generateXiaoGSection,
  generateMythosSection,
  getObservationPositions,
  getEmotionalCurve,
  recommendBeastForTitle
};
