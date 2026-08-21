/**
 * 通用角色入场编舞引擎 v1.0 — opening-cinematic
 *
 * 泛化自 beast-entrance-agent（原 Agent 锁死山海经异兽档案）。
 * 面向任意主角类型（人类/动物/幻想生物/团队/产品），提供三阶段入场编舞：
 * foreshadow（前兆 0-30%）：环境先反应，角色未现身，制造悬念
 * emerge（登场 30-70%）：角色以个性化方式进入画面，情绪峰值
 * settle（定格 70-100%）：姿态/视线/与标题的关系确立，过渡到正片
 *
 * 设计哲学（继承自原版）：
 * 1. 每个角色都是独一无二的，出场方式也应独一无二
 * 2. 身体特征即出场语言，性格即出场节奏
 * 3. 第一眼钩子：观众的第一帧注意力必须被锁住
 *
 * @module opening-cinematic/character-entrance-designer
 * @version 1.0.0
 */

// ============================================================
// 登场方式库（emerge 阶段）
// ============================================================
const EMERGE_STYLES = {
  walk_in: {
    name: '步入画面',
    desc: '角色从景深中/画面侧缘自然步入，步伐节奏匹配性格',
    camera: '固定或缓慢横移跟拍，保持角色全身在黄金分割点',
    applicableArchetypes: ['human_adult', 'human_child', 'elder', 'team'],
    energy: 'low'
  },
  descend: {
    name: '降临',
    desc: '角色从上方降临（落下/飞落/缓降），带气流与光影变化',
    camera: '仰拍迎接降临，落地瞬间镜头轻微震动',
    applicableArchetypes: ['fantasy_creature', 'hero', 'animal_flying'],
    energy: 'high'
  },
  burst_in: {
    name: '冲入',
    desc: '角色高速冲入画面，带运动模糊与物理痕迹（尘/水/光尾）',
    camera: '快速横摇追随，入画后急停，冲击感强',
    applicableArchetypes: ['animal', 'fantasy_creature', 'human_child', 'hero'],
    energy: 'high'
  },
  materialize: {
    name: '凝聚显现',
    desc: '角色由粒子/雾气/光影凝聚成形，从虚到实',
    camera: '缓慢环绕，见证成形过程，微距到全身',
    applicableArchetypes: ['fantasy_creature', 'mystery', 'product'],
    energy: 'medium'
  },
  reveal_turn: {
    name: '转身揭示',
    desc: '角色背对镜头，关键环节转身/回头，面部或标志性特征揭示',
    camera: '先拍背影中景，转身瞬间推近到特写',
    applicableArchetypes: ['human_adult', 'hero', 'mystery', 'elder'],
    energy: 'medium'
  },
  rise_up: {
    name: '升起',
    desc: '角色从下方升起（跃出/浮出/站起），背景铺开',
    camera: '俯拍转平视，升起过程中景别放大',
    applicableArchetypes: ['animal', 'fantasy_creature', 'hero', 'product'],
    energy: 'high'
  },
  step_close: {
    name: '逼近特写',
    desc: '角色主动向镜头走来，景别从全身逐步压到面部特写',
    camera: '低机位固定，角色走近产生压迫感/亲切感',
    applicableArchetypes: ['human_adult', 'hero', 'animal', 'fantasy_creature'],
    energy: 'medium'
  }
};

// ============================================================
// 前兆方式库（foreshadow 阶段）
// ============================================================
const FORESHADOW_STYLES = {
  env_react: { name: '环境反应', desc: '环境先动起来（草叶摇动/水面涟漪/尘埃震起/灯火摇曳），暗示某物接近', energy: 'low' },
  sound_first: { name: '先声夺人', desc: '角色的声音先于形象出现（脚步/呼吸/吼鸣/笑声），画面保持空镜', energy: 'medium' },
  shadow_cast: { name: '影子先行', desc: '角色的影子先投射进画面，本体未现，影子透露体型与气质', energy: 'medium' },
  light_shift: { name: '光影异动', desc: '光线突然变化（遮蔽/染上色温/出现光晕），预示存在', energy: 'low' },
  ground_tremor: { name: '地面震颤', desc: '地面/镜头轻微震颤，小物件跳动，暗示重量级接近', energy: 'high' },
  gaze_pull: { name: '视线牵引', desc: '画面中的其他元素（人/动物/物件）齐刷刷看向同一方向', energy: 'medium' }
};

// ============================================================
// 角色原型 → 编舞偏好
// ============================================================
const ARCHETYPE_PRESETS = {
  human_child: {
    name: '人类儿童',
    foreshadow: ['sound_first', 'env_react'],
    emerge: ['burst_in', 'walk_in'],
    settleNotes: '定格要有童真细节（好奇的眼神/小动作/与自然互动），避免摆拍感',
    pacing: 'light'
  },
  human_adult: {
    name: '成年人类',
    foreshadow: ['shadow_cast', 'sound_first', 'env_react'],
    emerge: ['walk_in', 'reveal_turn', 'step_close'],
    settleNotes: '定格建立人物气质与职业/身份暗示，视线方向指向正片',
    pacing: 'steady'
  },
  elder: {
    name: '长者',
    foreshadow: ['sound_first', 'env_react'],
    emerge: ['walk_in', 'reveal_turn'],
    settleNotes: '定格突出岁月质感（手部/面部纹理），节奏从容',
    pacing: 'slow'
  },
  hero: {
    name: '英雄型主角',
    foreshadow: ['ground_tremor', 'light_shift', 'gaze_pull'],
    emerge: ['descend', 'rise_up', 'step_close'],
    settleNotes: '定格要有标志性姿态与光影加持，情绪达到峰值',
    pacing: 'strong'
  },
  animal: {
    name: '动物',
    foreshadow: ['env_react', 'sound_first'],
    emerge: ['burst_in', 'rise_up', 'walk_in'],
    settleNotes: '定格保留动物天性瞬间（甩毛/嗅探/鸣叫），避免拟人摆拍',
    pacing: 'natural'
  },
  animal_flying: {
    name: '飞行动物',
    foreshadow: ['shadow_cast', 'env_react'],
    emerge: ['descend', 'burst_in'],
    settleNotes: '定格带气流余韵（草伏/水纹/尘扬）',
    pacing: 'swift'
  },
  fantasy_creature: {
    name: '幻想生物',
    foreshadow: ['ground_tremor', 'light_shift', 'env_react', 'sound_first'],
    emerge: ['materialize', 'descend', 'burst_in', 'rise_up'],
    settleNotes: '定格展现体型对比与能力暗示（发光部位/元素余韵）',
    pacing: 'dramatic'
  },
  team: {
    name: '团队/群像',
    foreshadow: ['env_react', 'sound_first'],
    emerge: ['walk_in', 'rise_up'],
    settleNotes: '定格注意群像层次（前中后景错落），主从关系一目了然',
    pacing: 'steady'
  },
  product: {
    name: '产品/物体主角',
    foreshadow: ['light_shift', 'env_react'],
    emerge: ['materialize', 'rise_up', 'reveal_turn'],
    settleNotes: '定格在产品 hero shot（最佳角度+材质高光），logo 区域预留',
    pacing: 'precise'
  },
  mystery: {
    name: '神秘角色',
    foreshadow: ['sound_first', 'shadow_cast', 'light_shift'],
    emerge: ['materialize', 'reveal_turn'],
    settleNotes: '定格保留部分未知（逆光/遮挡/只露局部）',
    pacing: 'slow'
  }
};

// ============================================================
// 编舞生成
// ============================================================

/**
 * 推断角色原型
 * @param {Object} character - { name, type, description, age, species }
 * @returns {string} archetype id
 */
function inferArchetype(character = {}) {
  const t = String(character.type || character.species || '').toLowerCase();
  const d = String(character.description || '').toLowerCase();
  if (t.includes('child') || character.age === 'child' || /孩子|儿童|男孩|女孩|宝宝/.test(d)) return 'human_child';
  if (t.includes('elder') || /老人|爷爷|奶奶|长者/.test(d)) return 'elder';
  if (t.includes('fantasy') || t.includes('beast') || t.includes('creature') || /神兽|异兽|龙|凤|妖/.test(d)) return 'fantasy_creature';
  if (t.includes('animal') || /猫|狗|熊猫|动物/.test(d)) return /鸟|鹰|飞/.test(d) ? 'animal_flying' : 'animal';
  if (t.includes('team') || /团队|群像|兄弟|伙伴/.test(d)) return 'team';
  if (t.includes('product') || /产品|汽车|手机|手表/.test(d)) return 'product';
  if (t.includes('hero') || /英雄|侠|战士/.test(d)) return 'hero';
  if (t.includes('mystery') || /神秘|隐者/.test(d)) return 'mystery';
  return 'human_adult';
}

/**
 * 生成角色入场编舞方案
 * @param {Object} character - 角色信息 { name, type, description, signatureFeature }
 * @param {Object} ctx - { mood, durationSec, hasTitle }
 * @returns {Object} entrance plan
 */
function designEntrance(character = {}, ctx = {}) {
  const archetype = inferArchetype(character);
  const preset = ARCHETYPE_PRESETS[archetype];
  const mood = ctx.mood || 'epic';

  // 情绪调整选择
  const highEnergy = ['epic', 'exciting', 'tense'].includes(mood);
  const foreshadowId = preset.foreshadow[0];
  let emergeId = preset.emerge[0];
  if (highEnergy && preset.emerge.length > 1) {
    // 高能量情绪优先选库里能量更高的登场方式
    const candidates = preset.emerge
      .map(id => ({ id, energy: EMERGE_STYLES[id].energy }))
      .sort((a, b) => ({ high: 3, medium: 2, low: 1 }[b.energy] - { high: 3, medium: 2, low: 1 }[a.energy]));
    emergeId = candidates[0].id;
  }

  const foreshadow = FORESHADOW_STYLES[foreshadowId];
  const emerge = EMERGE_STYLES[emergeId];
  const name = character.name || '主角';
  const feature = character.signatureFeature || character.description || '';

  const dur = Math.max(3, Math.min(15, ctx.durationSec || 8));

  return {
    archetype,
    archetypeName: preset.name,
    stages: [
      {
        stage: 'foreshadow',
        tStart: 0,
        tEnd: +(dur * 0.3).toFixed(1),
        style: foreshadowId,
        name: foreshadow.name,
        description: `${foreshadow.desc}。${feature ? `暗示线索与「${feature}」相关` : ''}`,
        audio: foreshadow.energy === 'high' ? '低频震颤+环境音骤停' : '环境音变化+悬念铺底'
      },
      {
        stage: 'emerge',
        tStart: +(dur * 0.3).toFixed(1),
        tEnd: +(dur * 0.7).toFixed(1),
        style: emergeId,
        name: emerge.name,
        description: `${name}以「${emerge.name}」方式登场：${emerge.desc}${feature ? `，重点呈现${feature}` : ''}`,
        camera: emerge.camera,
        audio: emerge.energy === 'high' ? '登场瞬间重低音+主题动机奏响' : '主题动机渐强'
      },
      {
        stage: 'settle',
        tStart: +(dur * 0.7).toFixed(1),
        tEnd: dur,
        style: 'settle',
        name: '定格',
        description: `${preset.settleNotes}${ctx.hasTitle ? '；角色与标题形成构图关系（角色让出标题视觉重心或与之互动）' : ''}`,
        audio: '音乐收束，保留角色环境声作为过渡'
      }
    ],
    pacing: preset.pacing,
    notes: preset.settleNotes
  };
}

/** 供 LLM prompt 注入的编舞库摘要 */
function buildEntranceSummary() {
  const emerge = Object.entries(EMERGE_STYLES)
    .map(([id, v]) => `${id}(${v.name}): ${v.desc}｜运镜: ${v.camera}`).join('\n ');
  const foreshadow = Object.entries(FORESHADOW_STYLES)
    .map(([id, v]) => `${id}(${v.name}): ${v.desc}`).join('\n ');
  return `前兆方式:\n ${foreshadow}\n登场方式:\n ${emerge}`;
}

module.exports = {
  EMERGE_STYLES,
  FORESHADOW_STYLES,
  ARCHETYPE_PRESETS,
  inferArchetype,
  designEntrance,
  buildEntranceSummary
};
