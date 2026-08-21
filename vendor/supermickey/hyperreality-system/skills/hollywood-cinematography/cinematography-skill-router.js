const path = require('path');
const fs = require('fs');

// 技能库根目录（可根据实际项目调整）
const SKILL_LIB_ROOT = path.join(__dirname, '..', '..', 'skills', '好莱坞工业电影技能工厂', '技能系列', '镜头级专项');

// 检查技能库是否存在（开源版本：技能文件可选）
const SKILL_LIB_AVAILABLE = fs.existsSync(SKILL_LIB_ROOT);

if (!SKILL_LIB_AVAILABLE) {
  console.log('[SkillRouter] 技能库未配置，运行在无技能增强模式（可通过添加技能文件到 skills/好莱坞工业电影技能工厂/技能系列/镜头级专项/ 启用）');
}

// ============================================================
// 【v2.3.2】导演/情绪词表模块级唯一真源（V1 路由与 V2 normalize 共用）
// ============================================================
const SKILL_DIRECTOR_MAP = {
  '维伦纽瓦': 'villeneuve', '诺兰': 'nolan', '卡梅隆': 'cameron',
  '卢卡斯': 'lucas', '库布里克': 'kubrick', '斯皮尔伯格': 'spielberg',
  '斯科塞斯': 'scorsese', '昆汀': 'tarantino', '达米恩': 'chazelle',
  '韦斯安德森': 'anderson', '索金': 'sorkin', '博伊尔': 'boyle',
  '大卫林奇': 'lynch', '芬奇': 'fincher', '希区柯克': 'hitchcock',
  '卡萨维茨': 'cassavetes', '德尼罗': 'deniro', '曼': 'mann',
  '斯派克琼斯': 'spike-jonze', '黑泽明': 'kurosawa', '奥卡萨姆': 'aucon'
};

const SKILL_EMOTION_MAP = {
  '史诗': 'epic', '孤独': 'lonely', '情感': 'emotional',
  '紧张': 'tense', '浪漫': 'romantic', '告别': 'farewell',
  '救赎': 'redemption', '温情': 'tender', '雨夜': 'rainy-night',
  '舞蹈': 'dance', '神秘': 'mysterious', '悬疑': 'suspenseful',
  '荒诞': 'absurd', '压迫': 'oppressive', '紧张追逐': 'chase-tense',
  '史诗航拍': 'epic-aerial', '史诗手持': 'epic-handheld',
  '史诗斯坦尼康': 'epic-steadicam', '史诗定场': 'epic-establishing',
  '紧张斯坦尼康': 'tense-steadicam', '紧张手持': 'tense-handheld',
  '浪漫斯坦尼康': 'romantic-steadicam', '浪漫手持': 'romantic-handheld',
  '舞蹈斯坦尼康': 'dance-steadicam', '舞蹈手持': 'dance-handheld',
  '恐怖斯坦尼康': 'horror-steadicam', '悬疑手持': 'suspense-handheld',
  '悬疑斯坦尼康': 'suspense-steadicam', '史诗手持': 'epic-handheld',
  '紧张定场': 'tense-establishing',
  '粗粝真实': 'raw-real', '压抑喜悦': 'suppressed-joy',
  '压抑悲伤': 'suppressed-sadness', '厌恶': 'disgust', '嫌弃': 'scorn',
  '复杂情绪': 'complex', '复古优雅': 'vintage-elegant',
  '无人回应': 'no-response', '灵魂独行': 'soul-alone',
  '喜悦': 'joy', '方法演技': 'method-acting', '恍惚': 'trance',
  '恐惧': 'fear', '惊恐': 'panic', '恐惧颤抖': 'fear-shake',
  '哀伤': 'grief', '惊讶凝固': 'frozen-shock', '震惊': 'shocked',
  '愤怒克制': 'anger-suppressed', '暴烈': 'violent',
  '战栗': 'shiver', '神经质幽默': 'neurotic-humor',
  '热情外放': 'outgoing', '紧张内敛': 'tense-reserved',
  '破碎': 'broken', '心碎时刻': 'heartbreak', '空洞': 'hollow',
  '灵魂出窍': 'out-of-body', '窒息': 'suffocating',
  '话唠爆发': 'talking-burst', '冷峻逼近': 'cold-approach',
  '蔑视': 'contempt', '冷嘲': 'sarcasm', '迷醉': 'intoxicated',
  '超然状态': 'trance-state', '瞬间启示': 'flash-enlightenment',
  '无尽雨幕': 'endless-rain', '东方克制': 'oriental-restraint',
  '热闹中的寂静': 'quiet-in-chaos', '镜子里的陌生人': 'stranger-in-mirror',
  '午夜独醒': 'midnight-awake'
};

// ============================================================
// 技能索引构建
// ============================================================

let _skillIndex = null;
let _skillIndexBuildTime = 0;

function parseSkillFilename(filename) {
  const name = filename.replace('.md', '');
  const parts = name.split('_');
  
  const TYPE_MAP = {
    '剧情': 'drama', '动作': 'action', '喜剧': 'comedy', '恐怖': 'horror',
    '悬疑': 'suspense', '惊悚': 'thriller', '战争': 'war', '科幻': 'sci-fi',
    '孤独': 'loneliness', '微表情': 'micro-expression',
    '纪录': 'documentary', '奇幻': 'fantasy' // 【v2.4.0】新赛道片种
  };
  
  const DIRECTOR_MAP = SKILL_DIRECTOR_MAP;
  
  const EMOTION_MAP = SKILL_EMOTION_MAP;
  
  const type = parts[0] || '';
  let director = parts[1] || '';
  let rest = parts.slice(2);
  // 【v2.3.2】槽位感知：第二槽未注册为导演时，它是情绪类别槽
  // （如 微表情_压抑悲伤_无声落泪 / 微表情_孤独_灵魂独行），
  // 情绪取第二槽，其后具象修饰记入 emotionDetail，导演置空。
  // 修复前此类文件被错解为"导演=压抑悲伤"，与编译索引口径分裂。
  let emotionDetail;
  if (director && !DIRECTOR_MAP[director]) {
    const TAXA = (typeof TAXONOMY !== 'undefined' ? TAXONOMY.emotion_alias : {}) || {};
    if (EMOTION_MAP[director] || TAXA[director] || rest.length === 0) {
      // 情绪类别槽（如 压抑悲伤/凝视）：情绪取第二槽
      emotionDetail = rest.length > 0 ? rest.join('_') : undefined;
      rest = [director];
    } else if (EMOTION_MAP[rest[0]] || TAXA[rest[0]]) {
      // 风格修饰槽（如 闪电）：情绪取第三槽，第二槽记为风格修饰
      emotionDetail = director;
    } else {
      emotionDetail = rest.length > 0 ? rest.join('_') : undefined;
      rest = [director];
    }
    director = '';
  }
  
  let tech = '';
  let shotType = '';
  let emotion = '';
  
  const SHOT_IN_EMOTION = ['航拍', '斯坦尼康', '手持', '定场'];
  const TECH_TAGS_SET = new Set(['IMAX', 'VR', '3D']);
  
  for (const r of rest) {
    if (TECH_TAGS_SET.has(r)) { tech = r; continue; }
    let matched = false;
    for (const st of SHOT_IN_EMOTION) {
      if (r.includes(st) || st.includes(r)) {
        shotType = st;
        const remaining = r.replace(st, '');
        if (remaining) emotion = emotion ? emotion + '_' + remaining : remaining;
        matched = true;
        break;
      }
    }
    if (!matched) {
      emotion = emotion ? emotion + '_' + r : r;
    }
  }
  
  return {
    filename,
    type: TYPE_MAP[type] || type,
    type_zh: type,
    director: DIRECTOR_MAP[director] || director,
    director_zh: director,
    emotion: EMOTION_MAP[emotion] || emotion,
    emotion_zh: emotion,
    emotionDetail,
    shotType,
    tech
  };
}

function buildSkillIndex() {
  if (_skillIndex && Date.now() - _skillIndexBuildTime < 60_000) {
    return _skillIndex;
  }
  
  if (!fs.existsSync(SKILL_LIB_ROOT)) {
    console.warn(`[SkillRouter] 技能库目录不存在: ${SKILL_LIB_ROOT}`);
    return {};
  }
  
  const files = fs.readdirSync(SKILL_LIB_ROOT).filter(f => f.endsWith('.md'));
  const index = {};
  
  for (const file of files) {
    const meta = parseSkillFilename(file);
    
    const key1 = `${meta.type}_${meta.director}`;
    const key2 = `${meta.type}_${meta.emotion}`;
    const key3 = `${meta.type}_${meta.shotType}`;
    const key4 = `${meta.director}_${meta.emotion}`;
    const key5 = `${meta.type}_${meta.director}_${meta.shotType}`;
    const key6 = `${meta.type}_${meta.director}_${meta.emotion}`;

    const keys = [key1, key2, key3, key4, key5, key6];
    // 【v2.3.2】canonical 情绪键：taxonomy alias 归一值同名注册，精细/canonical 双向可达
    const canon = (TAXONOMY.emotion_alias || {})[meta.emotion_zh] || null;
    if (canon && canon !== meta.emotion) {
      keys.push(`${meta.type}_${canon}`);
      keys.push(`${meta.director}_${canon}`);
      keys.push(`${meta.type}_${meta.director}_${canon}`);
    }
    // 【v2.3.2】跨片种情绪键：情绪优先于片种（解决"孤独/动作既是情绪又是片种"的错配）
    if (meta.emotion) keys.push(`*_${meta.emotion}`);
    if (canon && canon !== meta.emotion) keys.push(`*_${canon}`);

    keys.forEach(k => {
      if (!index[k]) index[k] = [];
      index[k].push({ file, meta });
    });
  }
  
  _skillIndex = index;
  _skillIndexBuildTime = Date.now();
  return index;
}

// ============================================================
// 技能内容解析
// ============================================================

function extractSection(content, startMarker, endMarker) {
  const lines = content.split('\n');
  let inSection = false;
  let sectionLines = [];
  
  for (const line of lines) {
    if (!inSection && line.includes(startMarker)) { inSection = true; continue; }
    if (inSection) {
      // 【修复】endMarker 命中即结束提取（原实现为 continue 跳过该行继续收集，
      // 语义错误：endMarker 名不副实，且提取范围强依赖下游恰好出现另一个标题）。
      // 新语义：endMarker 或任意 Markdown 标题行出现即终止本段。
      if (endMarker && line.includes(endMarker)) break;
      if (line.match(/^#{1,3} /)) break;
      sectionLines.push(line);
    }
  }
  
  return sectionLines.join('\n').trim();
}

function extractSkillEnhancement(skillPath) {
  try {
    let content = fs.readFileSync(skillPath, 'utf-8');
    // 【修复】剥离 YAML frontmatter：dimensions 行含"镜头类型="字样，
    // 会劫持 shotBlock 的起始标记（extractSection 从 frontmatter 即开始收集），
    // 导致所有导演摄影技能的 shotBlock 只剩 minimum_granularity 残片。
    const fmMatch = content.match(/^---\n[\s\S]*?\n---\n/);
    if (fmMatch) content = content.slice(fmMatch[0].length);
    
    const enhancement = {
      promptBlock: extractSection(content, 'AI提示词构建', '第五部分'),
      forbiddenBlock: extractSection(content, '禁止词清单', '禁止词'),
      shotBlock: extractSection(content, '镜头类型', '镜头设计'),
      emotionBlock: extractSection(content, '情绪设计', '第四部分'),
      raw: content
    };
    // 【修复】技能库149个文件原为20行骨架（frontmatter+技能概述+第一部分标题），
    // 四个增强块恒为空，技能注入"有形无实"。正文块全空时回退提取【技能概述】段的
    // "定位/核心功能"作为情绪与镜头手法增强源，并告警提示技能正文待补全。
    const allEmpty = !enhancement.promptBlock && !enhancement.forbiddenBlock
                  && !enhancement.shotBlock && !enhancement.emotionBlock;
    if (allEmpty) {
      const overview = extractSection(content, '## 技能概述', '## 第一部分');
      const positioning = (overview.match(/\*\*定位\*\*[:：]\s*(.+)/) || [])[1] || '';
      const coreFn = (overview.match(/\*\*核心功能\*\*[:：]\s*(.+)/) || [])[1] || '';
      if (positioning.trim()) enhancement.emotionBlock = positioning.trim();
      if (coreFn.trim()) enhancement.shotBlock = coreFn.trim();
      if (enhancement.emotionBlock || enhancement.shotBlock) {
        console.warn(`[SkillRouter] ⚠️ 技能 ${path.basename(skillPath)} 为骨架文件，已回退注入概述段内容，建议补全技能正文`);
      }
    }
    return enhancement;
  } catch (e) {
    return null;
  }
}


// ============================================================
// 【v2.3.2】情绪扫描表（库实况自维护）
// 合并 SKILL_EMOTION_MAP / TAXONOMY.emotion_alias / 技能库实况原生情绪词：
// 新技能携带新情绪标签入库即自动可检测，无需人工登记词表。
// ============================================================
let _emotionScanEntries = null;
let _emotionScanBuildTime = 0;
function buildEmotionScanEntries() {
  if (_emotionScanEntries && Date.now() - _emotionScanBuildTime < 60_000) return _emotionScanEntries;
  const entries = [];
  const seen = new Set();
  const push = (zh, en) => {
    if (!zh || seen.has(zh) || /手持|斯坦尼康|航拍|定场/.test(zh)) return;
    seen.add(zh); entries.push([zh, en || zh]);
  };
  for (const [zh, en] of Object.entries(SKILL_EMOTION_MAP)) push(zh, en);
  try {
    const TAX = require('./taxonomy.json');
    for (const [k, en] of Object.entries(TAX.emotion_alias || {})) { if (/[\u4e00-\u9fa5]/.test(k)) push(k, en); }
  } catch (e) {}
  try {
    const idx = buildSkillIndex();
    for (const items of Object.values(idx)) for (const it of items) {
      if (it.meta && it.meta.emotion_zh) push(it.meta.emotion_zh, it.meta.emotion);
    }
  } catch (e) {}
  entries.sort((a, b) => b[0].length - a[0].length);
  _emotionScanEntries = entries;
  _emotionScanBuildTime = Date.now();
  return entries;
}

// 【v2.3.2】导演中文名检测（V1/V2 共用）
function detectDirectorZh(text) {
  if (!text) return '';
  for (const zh of Object.keys(SKILL_DIRECTOR_MAP)) {
    if (text.includes(zh)) return zh;
  }
  return '';
}

// 【v2.3.2】情绪归一到 canonical（taxonomy alias 33 情绪集）：
// 精细情绪值经共享 zh 标签桥接映射为 canonical，索引侧同名注册，双向可达
function canonEmotion(en) {
  if (!en) return en;
  const TAX = TAXONOMY.emotion_alias || {};
  if (TAX[en]) return TAX[en];
  for (const [zh, fine] of Object.entries(SKILL_EMOTION_MAP)) {
    if (fine === en && TAX[zh]) return TAX[zh];
  }
  return en;
}

// ============================================================
// 镜头元数据提取
// ============================================================

function extractShotMetadata(shot) {
  const meta = {
    type: 'drama',
    director: '',
    emotion: '',
    shotType: '',
    lighting: '',
    hasAerial: false,
    hasRain: false,
    hasNight: false,
    isEpic: false,
    isLonely: false,
    isDance: false
  };
  
  const desc = (shot.description || shot.scene || shot.sceneDesc || shot.prompt || '').toLowerCase(); // 【fix-1A1】scene 入扫描
  // 【v2.1.4-fix9-P8】安全获取camera字符串：强制转换为字符串
  const cameraStr = String(shot.cameraString || '');
  const cameraMovementStr = String(shot.cameraMovement || '');
  const cameraObjStr = (typeof shot.camera === 'string' ? shot.camera : '');
  const camera = (cameraStr || cameraMovementStr || cameraObjStr).toLowerCase();
  const MOOD_SYNONYM_MAP = { 'sadness':'grief','sad':'grief','grief':'grief','heartbroken':'heartbreak','amazed':'joy','amazing':'joy','awe':'epic','serene':'oriental-restraint','calm':'oriental-restraint','quiet':'oriental-restraint','tender':'tender','tense':'tense','warm':'tender','nostalgic':'farewell','melancholy':'grief','lonely':'lonely','fear':'fear','scared':'fear','panic':'panic','suffocated':'suffocating','broken':'broken','hollow':'hollow','empty':'hollow','contempt':'contempt','disgusted':'disgust','sarcastic':'sarcasm','intoxicated':'intoxicated','trance':'trance','shocked':'shocked','furious':'violent','enlightened':'flash-enlightenment','outgoing':'outgoing','talkative':'talking-burst','shivering':'fear-shake' }; // 【fix-1A2】【v2.3.2 扩充】
  const rawMood = String(shot.mood || shot.emotion || (shot.emotional_target && shot.emotional_target.emotion) || '').toLowerCase().trim();
  const mood = (MOOD_SYNONYM_MAP[rawMood] || rawMood);
  // 【v2.1.4-patch2】兼容lighting对象/字符串两种格式
  const lighting = (shot.lightingString || (typeof shot.lighting === 'string' ? shot.lighting : '') || '').toLowerCase();
  
  // 检测影片类型
  if (/科幻|alien|space|planet|starship|robot/i.test(desc)) meta.type = 'sci-fi';
  else if (/战争|battle|army|soldier|war/i.test(desc)) meta.type = 'war';
  else if (/恐怖|horror|fear|monster/i.test(desc)) meta.type = 'horror';
  else if (/喜剧|comedy|funny|laugh/i.test(desc)) meta.type = 'comedy';
  else if (/悬疑|suspense|mystery/i.test(desc)) meta.type = 'suspense';
  else if (/惊悚|thriller/i.test(desc)) meta.type = 'thriller';
  // 【v2.3.2】补全片种枚举：此前 action/loneliness/micro-expression 永远无法产出，
  // 导致 10 个动作技能、3 个孤独技能团灭，36 个微表情技能只剩跨类型独木桥
  else if (/动作片|动作戏|动作场面|^动作|，动作，|追逐|追车|打斗|搏斗|爆炸|枪战|飞车|action|chase|gunfight|explosion/i.test(desc)) meta.type = 'action';
  else if (/微表情|面部特写|表情特写|大特写/.test(desc)) meta.type = 'micro-expression';
  else if (/独处|独居|孤身|独自一人|solitude/i.test(desc)) meta.type = 'loneliness';
  // 【v2.4.0】补全纪录/奇幻片种枚举：taxonomy 早有别名但 V1 检测链缺失，
  // 新赛道技能（纪录/奇幻）在 V1 链路团灭，与 v2.3.2 动作片修复同因
  else if (/纪录|纪实|田野|牧民|部落|迁徙|documentary/i.test(desc)) meta.type = 'documentary';
  else if (/奇幻|神话|神兽|异兽|fantasy/i.test(desc)) meta.type = 'fantasy';
  
  // 检测镜头类型
  if (/航拍|aerial|helicopter|drone/i.test(camera + desc)) meta.shotType = 'aerial';
  else if (/斯坦尼康|steadicam/i.test(camera)) meta.shotType = 'steadicam';
  else if (/手持|handheld/i.test(camera)) meta.shotType = 'handheld';
  else if (/定场|establishing/i.test(camera + desc)) meta.shotType = 'establishing';
  if (/IMAX|imax/i.test(camera + desc + lighting)) meta.tech = 'IMAX';
  
  // 【v2.3.2】技能情绪标签直通扫描：mood 字段优先、场景描述其次。
  // 修复前识别链仅输出 12 种情绪，技能库 52 个情绪标签中约 40 个永远无法命中
  if (!meta.emotion) {
    const moodText = String(shot.mood || shot.emotion || (shot.emotional_target && shot.emotional_target.emotion) || '');
    for (const [zh, en] of buildEmotionScanEntries()) {
      if (zh && moodText.includes(zh)) { meta.emotion = en; break; }
    }
    if (!meta.emotion) {
      for (const [zh, en] of buildEmotionScanEntries()) {
        if (zh && desc.includes(zh)) { meta.emotion = en; break; }
      }
    }
  }

  // 检测情绪（归一后的 mood 优先）【fix-1A3】
  if (!meta.emotion) {
  if (mood && MOOD_SYNONYM_MAP[rawMood]) { meta.emotion = mood; }
  else if (/哀伤|悲恸|悲伤|心碎|grief/i.test(mood + desc)) meta.emotion = 'grief';
  else if (/克制|静谧|安静|restraint/i.test(mood + desc)) meta.emotion = 'oriental-restraint';
  else if (/史诗|epic|grand/i.test(mood + desc)) { meta.emotion = 'epic'; meta.isEpic = true; }
  else if (/舞蹈|dance|dancing/i.test(desc + camera)) { meta.emotion = 'dance'; meta.isDance = true; }
  else if (/无人回应|no.response/i.test(mood + desc)) meta.emotion = 'lonely';
  else if (/灵魂独行|soul.alone/i.test(mood + desc)) { meta.emotion = 'lonely'; meta.isLonely = true; }
  else if (/孤独|lonely|solitude|alone/i.test(mood + desc)) { meta.emotion = 'lonely'; meta.isLonely = true; }
  else if (/紧张追逐|tense.chase/i.test(mood + desc)) meta.emotion = 'tense';
  else if (/紧张|tense|nervous/i.test(mood + desc)) meta.emotion = 'tense';
  else if (/浪漫|romantic|love/i.test(mood + desc)) meta.emotion = 'romantic';
  else if (/告别|farewell|depart/i.test(mood + desc)) meta.emotion = 'farewell';
  else if (/救赎|redemption/i.test(mood + desc)) meta.emotion = 'redemption';
  else if (/温情|tender|warm/i.test(mood + desc)) meta.emotion = 'tender';
  else if (/神秘|mysterious|mystery/i.test(mood + desc)) meta.emotion = 'mysterious';
  else if (/情感|emotional|feelings/i.test(mood + desc)) meta.emotion = 'emotional';
  }
  
  // 检测导演风格
  if (/维伦纽瓦|villeneuve|dune|arrival/i.test(desc)) meta.director = 'villeneuve';
  else if (/诺兰|nolan|inception|batman/i.test(desc)) meta.director = 'nolan';
  else if (/卡梅隆|cameron|avatar|terminator/i.test(desc)) meta.director = 'cameron';
  else if (/库布里克|kubrick|2001|shining/i.test(desc)) meta.director = 'kubrick';
  else if (/斯科塞斯|scorsese|departed/i.test(desc)) meta.director = 'scorsese';
  else if (/斯皮尔伯格|spielberg|jaws|et/i.test(desc)) meta.director = 'spielberg';
  else if (/昆汀|tarantino|pulp/i.test(desc)) meta.director = 'tarantino';
  else if (/韦斯安德森|anderson|budapest/i.test(desc)) meta.director = 'anderson';
  else if (/芬奇|fincher|social|dragon/i.test(desc)) meta.director = 'fincher';
  else if (/希区柯克|hitchcock|psycho/i.test(desc)) meta.director = 'hitchcock';
  else if (/达米恩|chazelle|lalaland/i.test(desc)) meta.director = 'chazelle';
  else if (/卢卡斯|lucas|starwars|graffiti/i.test(desc)) meta.director = 'lucas';
  else if (/索金|sorkin|westwing|social/i.test(desc)) meta.director = 'sorkin';
  else if (/博伊尔|boyle|trainspot|slumdog/i.test(desc)) meta.director = 'boyle';
  else if (/大卫林奇|lynch|mulholland/i.test(desc)) meta.director = 'lynch';
  else if (/卡萨维茨|cassavetes|faces|shadows/i.test(desc)) meta.director = 'cassavetes';
  else if (/德尼罗|deniro|raging|taxi/i.test(desc)) meta.director = 'deniro';
  else if (/曼|mann|heat|collateral/i.test(desc)) meta.director = 'mann';
  else if (/斯派克琼斯|spike-jonze|her|adaptation/i.test(desc)) meta.director = 'spike-jonze';
  else if (/黑泽明|kurosawa|seven|samurai|ran/i.test(desc)) meta.director = 'kurosawa';
  else if (/奥卡萨姆|aucon/i.test(desc)) meta.director = 'aucon';
  
  // 检测特殊元素
  if (/雨|rain|雨夜/i.test(desc + mood)) meta.hasRain = true;
  if (/夜|night|黑暗/i.test(desc + mood)) meta.hasNight = true;
  if (/航拍|aerial|helicopter/i.test(camera + desc)) meta.hasAerial = true;
  
  meta.rawCamera = cameraStr || cameraMovementStr || cameraObjStr; // 【fix-1A3】运镜原文透传评分器
  // 【v2.3.2】情绪末端归一到 canonical 33 集（精细值保留在 emotionFine）
  meta.emotionFine = meta.emotion;
  meta.emotion = canonEmotion(meta.emotion);

  return meta;
}

// ============================================================
// 技能匹配引擎
// ============================================================

function matchSkills(shotMeta, limit = 3) {
  const index = buildSkillIndex();
  if (Object.keys(index).length === 0) return [];
  
  const candidates = new Map();
  
  // 优先级1：类型+导演+情绪（最精确）
  if (shotMeta.type && shotMeta.director && shotMeta.emotion) {
    const key1 = `${shotMeta.type}_${shotMeta.director}`;
    const key2 = `${shotMeta.type}_${shotMeta.director}_${shotMeta.emotion}`;
    (index[key2] || index[key1] || []).forEach(item => {
      candidates.set(item.file, (candidates.get(item.file) || 0) + 30);
    });
  }
  
  // 优先级2：类型+导演
  if (shotMeta.type && shotMeta.director) {
    const key = `${shotMeta.type}_${shotMeta.director}`;
    (index[key] || []).forEach(item => {
      candidates.set(item.file, (candidates.get(item.file) || 0) + 20);
    });
  }
  
  // 优先级3：类型+情绪
  if (shotMeta.type && shotMeta.emotion) {
    const key = `${shotMeta.type}_${shotMeta.emotion}`;
    (index[key] || []).forEach(item => {
      candidates.set(item.file, (candidates.get(item.file) || 0) + 15);
    });
  }
  
  // 优先级3.5：微表情演技技能跨类型匹配（36 个 acting 技能 type=micro-expression，
  // 此前剧情片永远够不到；情绪命中时给独立通道）【fix-1A4】
  if (shotMeta.emotion) {
    const actingKey = 'micro-expression_' + shotMeta.emotion;
    (index[actingKey] || []).forEach(item => {
      candidates.set(item.file, (candidates.get(item.file) || 0) + 18);
    });
    // 兼容复合情绪键（如 微表情_tense-reserved）：包含即命中
    Object.keys(index).forEach(k => {
      if (k.startsWith('micro-expression_') && k.includes('_' + shotMeta.emotion)) {
        index[k].forEach(item => {
          candidates.set(item.file, (candidates.get(item.file) || 0) + 12);
        });
      }
    });
  }

  // 优先级3.6：跨片种情绪通道（+15）——情绪优先于片种，
  // 解决"孤独/动作既是情绪词又是片种"导致的类型错配死技能
  if (shotMeta.emotion) {
    (index[`*_${shotMeta.emotion}`] || []).forEach(item => {
      candidates.set(item.file, (candidates.get(item.file) || 0) + 15);
    });
  }

  // 优先级4：类型匹配
  if (shotMeta.type) {
    // 【fix-1A5】按文件去重后只加一次（+5→+1）：同一文件挂在 6 个索引键下，
    // 不去重会被重复加分，同类型技能集体灌水霸榜
    const blanketSeen = new Set();
    Object.keys(index).forEach(k => {
      if (k.startsWith(shotMeta.type + '_')) {
        index[k].forEach(item => {
          if (blanketSeen.has(item.file)) return;
          blanketSeen.add(item.file);
          candidates.set(item.file, (candidates.get(item.file) || 0) + 1);
        });
      }
    });
  }
  
  // 优先级5：航拍特殊处理
  if (shotMeta.shotType === 'aerial' || shotMeta.hasAerial) {
    if (shotMeta.type && shotMeta.director) {
      const key5 = `${shotMeta.type}_${shotMeta.director}_${shotMeta.shotType}`;
      const key5b = `${shotMeta.type}_${shotMeta.director}_航拍`;
      (index[key5] || index[key5b] || []).forEach(item => {
        candidates.set(item.file, (candidates.get(item.file) || 0) + 35);
      });
    }
    const key3 = `${shotMeta.type}_航拍`;
    (index[key3] || []).forEach(item => {
      candidates.set(item.file, (candidates.get(item.file) || 0) + 20);
    });
  }
  
  // 优先级6：IMAX技术标签
  if (shotMeta.tech === 'IMAX' || shotMeta.hasAerial) {
    const keyImax = `${shotMeta.type}_${shotMeta.director}_IMAX`;
    (index[keyImax] || []).forEach(item => {
      candidates.set(item.file, (candidates.get(item.file) || 0) + 40);
    });
  }
  
  // 优先级7：雨夜特殊处理
  if (shotMeta.hasRain && shotMeta.emotion) {
    const rainKey = `${shotMeta.type || 'drama'}_${shotMeta.director || ''}`;
    (index[rainKey] || []).forEach(item => {
      if (item.meta.filename.includes('雨夜')) {
        candidates.set(item.file, (candidates.get(item.file) || 0) + 20);
      }
    });
  }
  
  // 【fix-1A6】运镜冲突惩罚：定镜/缓推镜头配手持技能是反指导
  const FIXED_CAM = /static|固定机位|静置|push_in|缓推|dolly_in/i;
  if (FIXED_CAM.test(String(shotMeta.rawCamera || ''))) {
    for (const [file, score] of candidates.entries()) {
      if (/手持|handheld/i.test(file)) candidates.set(file, score - 15); // 手持与定镜直接冲突
      else if (/斯坦尼康|steadicam/i.test(file)) candidates.set(file, score - 6); // 斯坦尼康半兼容缓推，轻扣
    }
  }

  // 排序并返回top N
  const sorted = [...candidates.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
  
  return sorted.map(([file, score]) => {
    const skillPath = path.join(SKILL_LIB_ROOT, file);
    const meta = parseSkillFilename(file);
    const enhancement = extractSkillEnhancement(skillPath);
    return { skillPath, meta, score, enhancement };
  }).filter(r => r.enhancement);
}

// ============================================================
// 增强注入器
// ============================================================

function extractKeyTerms(blocks, maxTerms = 10) {
  if (!blocks || blocks.length === 0) return '';
  const allText = blocks.join(' ');
  
  const techTerms = allText.match(
    /\b(IMAX|aerial|steadicam|handheld|establishing|volumetric|god.?ray|deep.?focus|anamorphic|tungsten|during|dusk|golden.?hour|neon|noir|cinematic|epic|meditative|low.?key|high.?contrast|shallow.?depth|wide.?angle|telephoto|50mm|85mm|35mm|helicopter|drone|circular.?orbit|push.?in|pull.?out|track|pan|tilt|crane|fluid|smooth|handheld|shaky|steady)\b/gi
  ) || [];
  
  // 【修复】原写法为字符类（[...]+），会切出"斯/张/定/拍"等单字噪声；
  // 改为词级交替匹配，只产出完整术语。注意原字符类内的"|"是字面管道符，
  // 属于连带bug。
  const zhTerms = allText.match(
    /史诗|航拍|斯坦尼康|手持|定场|晨光|暮色|黄金时刻|霓虹|黑色电影|氛围|紧张|孤独|浪漫|沉默|宿命|环绕|推近|拉远|横移|凝视|剪影|逆光|深焦|浅景深|长镜头|悲伤|哀伤|温情|告别|救赎|雨夜|悬疑|神秘/g
  ) || [];
  
  const seen = new Set();
  const terms = [];
  for (const t of [...techTerms, ...zhTerms]) {
    const lower = t.toLowerCase();
    if (!seen.has(lower) && terms.length < maxTerms) {
      seen.add(lower);
      terms.push(t);
    }
  }
  
  return terms.join('; ');
}

function injectSkillEnhancement(shot, matchedSkills) {
  if (!matchedSkills || matchedSkills.length === 0) return shot;
  
  const enhanced = JSON.parse(JSON.stringify(shot));
  
  const forbiddenBlocks = matchedSkills
    .map(s => s.enhancement?.forbiddenBlock).filter(Boolean);
  
  // 【修复】禁止词精准提取：只取清单行（- 开头）的冒号/破折号前短语，
  // 避免把说明性文字与技法词（斯坦尼康/手持等）误并入负面约束。
  const extractForbiddenTerms = (blocks, maxTerms = 8) => {
    const TECH_WORDS = /斯坦尼康|手持|定场|航拍|运镜|镜头|推近|拉远|横移|环绕/;
    const seen = new Set();
    const terms = [];
    for (const b of blocks) {
      for (const line of b.split('\n')) {
        const m = line.match(/^\s*[-•]\s*([^：:——,，]+)/);
        if (!m) continue;
        const t = m[1].trim();
        // 排除纯符号行（如 --- 分隔线被误匹配为清单项）
        if (!t || t.length < 2 || !/[\u4e00-\u9fa5a-zA-Z]/.test(t) || TECH_WORDS.test(t) || seen.has(t)) continue;
        seen.add(t);
        terms.push(t);
        if (terms.length >= maxTerms) return terms.join('; ');
      }
    }
    return terms.join('; ');
  };
  const cameraBlocks = matchedSkills
    .map(s => s.enhancement?.shotBlock).filter(Boolean);
  const moodBlocks = matchedSkills
    .map(s => s.enhancement?.emotionBlock).filter(Boolean);
  
  const cameraTerms = extractKeyTerms(cameraBlocks, 8);
  const moodTerms = extractKeyTerms(moodBlocks, 6);
  const forbidTerms = extractForbiddenTerms(forbiddenBlocks, 8);
  
  enhanced._appliedSkills = matchedSkills.map((s, i) => ({
    file: path.basename(s.skillPath),
    score: s.score,
    role: i === 0 ? 'primary' : 'support', // 【v2.3.2】Top2 混合注入的主/辅标注
    type: s.meta.type_zh,
    director: s.meta.director_zh,
    emotion: s.meta.emotion_zh
  }));
  enhanced._skillForbidden = forbidTerms || ''; // 【fix-1B】供【负面约束】合并
  
  const skillTag = `[CINEMATIC_SKILL] ${matchedSkills.map(s => s.meta.type_zh + '_' + s.meta.director_zh + '_' + s.meta.emotion_zh).join(' | ')}`;
  const cameraLine = cameraTerms ? `Camera增强: ${cameraTerms}` : '';
  const moodLine = moodTerms ? `Mood增强: ${moodTerms}` : '';
  const forbidLine = forbidTerms ? `禁止词: ${forbidTerms}` : '';
  
  const skillBlock = [skillTag, cameraLine, moodLine, forbidLine]
    .filter(Boolean)
    .join(' | ');
  
  // 追加到 _generatedPrompt 或 prompt 末尾
  const targetPrompt = enhanced._generatedPrompt || enhanced.prompt || '';
  if (targetPrompt && skillBlock) {
    const promptField = enhanced._generatedPrompt ? '_generatedPrompt' : 'prompt';
    enhanced[promptField] = targetPrompt.trimEnd() + '\n' + skillBlock;
  }
  
  return enhanced;
}

// ============================================================
// 主入口：批量处理shots
// ============================================================

function routeAndEnhance(shots, options = {}) {
  const { minScore = 5, maxSkillsPerShot = 2, dryRun = false, diversityPenalty = 10 } = options;
  
  const report = {
    totalShots: shots.length,
    enhancedShots: 0,
    skippedShots: 0,
    skillsUsed: new Set(),
    details: []
  };
  
  // 【v2.3.2】同片多样性惩罚：本片已用过的技能按使用次数降权，
  // 避免单一技能在一部片子里重复霸榜（如斯皮尔伯格史诗斯坦尼康一片吃3镜）
  const useCount = {};

  const enhancedShots = shots.map((shot, idx) => {
    const meta = extractShotMetadata(shot);
    let matched = matchSkills(meta, maxSkillsPerShot + 4);
    if (diversityPenalty > 0) {
      matched = matched.map(s => {
        const f = path.basename(s.skillPath);
        const prior = useCount[f] || 0;
        return prior > 0 ? { ...s, score: s.score - diversityPenalty * prior, diversityPenalized: prior } : s;
      }).sort((a, b) => b.score - a.score);
    }
    matched = matched
      .filter(s => s.score >= minScore)
      .slice(0, maxSkillsPerShot);

    // 【fix-1A6】冲突惩罚把唯一匹配也扣死时，回退取原始最高分并标记 fallback
    if (matched.length === 0 && meta.rawCamera) {
      const relaxed = matchSkills({ ...meta, rawCamera: '' }, 1)
        .filter(s => s.score >= minScore);
      if (relaxed.length > 0) {
        relaxed[0].fallback = true;
        matched = relaxed;
      }
    }

    if (matched.length === 0) {
      report.skippedShots++;
      report.details.push({ shotIdx: idx, status: 'no_match', meta });
      return shot;
    }
    
    matched.forEach(s => { const f = path.basename(s.skillPath); useCount[f] = (useCount[f] || 0) + 1; report.skillsUsed.add(f); });
    
    if (dryRun) {
      report.details.push({
        shotIdx: idx,
        status: 'matched',
        score: matched[0].score,
        skills: matched.map(s => ({ file: path.basename(s.skillPath), score: s.score }))
      });
      return shot;
    }
    
    const newShot = injectSkillEnhancement(shot, matched);
    report.enhancedShots++;
    report.details.push({
      shotIdx: idx,
      status: 'enhanced',
      score: matched[0].score,
      skills: matched.map(s => ({ file: path.basename(s.skillPath), score: s.score }))
    });
    return newShot;
  });
  
  report.skillsUsed = [...report.skillsUsed];
  return { enhancedShots, report };
}

// ============================================================
// CLI 调试
// ============================================================

if (require.main === module) {
  const testShots = [
    {
      description: 'aerial shot of alien desert planet, vast sand dunes extending in IMAX frame, Villeneuve style',
      camera: 'aerial, helicopter, IMAX 1.90:1',
      mood: 'epic, vast, destiny approaching',
      lighting: 'golden hour, volumetric god rays'
    },
    {
      description: '角色在雨夜的城市街头，手持跟拍',
      camera: 'handheld, close follow',
      mood: 'tense, lonely, noir atmosphere',
      lighting: 'neon reflections on wet pavement'
    },
    {
      description: '舞蹈场景，斯坦尼康环绕拍摄',
      camera: 'steadicam, circular orbit',
      mood: 'romantic, tender',
      lighting: 'warm spotlight'
    }
  ];
  
  console.log('=== 技能路由测试 ===\n');
  const result = routeAndEnhance(testShots, { dryRun: true });
  console.log(JSON.stringify(result.report, null, 2));
}

// ============================================================
// 匹配引擎 2.0（Phase 2）：结构化双端标签 + 硬约束 + 多样性 + 回退链
// 优先读编译索引 skills-index.json，缺失时回退旧 buildSkillIndex()（双轨）
// ============================================================

const TAXONOMY = require('./taxonomy.json');
const COMPILED_INDEX_PATH = path.join(__dirname, 'skills-index.json');

// 【v2.4.0-B1】结构化编译产物优先（scripts/compile-skills.js 生成），
// 旧编译索引次之，文件名解析兜底。三级来源统一归一为运行形态。
const COMPILED_V2_PATH = path.join(__dirname, 'skills-compiled.json');

// 运镜模式归一（历史编译产物中 '定场' 为中文残留）
const CAMERA_MODE_NORM = { '定场': 'establishing', '航拍': 'aerial', '手持': 'handheld', '斯坦尼康': 'steadicam', '跟拍': 'tracking', '推近': 'push' };

function normalizeSkillEntry(s) {
 const triggers = s.triggers || {};
 return {
 file: s.file,
 skill_id: s.skill_id || (s.file || '').replace('.md', ''),
 domain: s.domain || (triggers.subjects && triggers.subjects.includes('person') ? 'acting' : 'cinematography'),
 type: s.type || (triggers.types || [])[0] || 'drama',
 director: s.director || '',
 emotions: (s.emotions && s.emotions.length ? s.emotions : (triggers.emotions || [])).filter(Boolean),
 camera_modes: (s.camera_modes && s.camera_modes.length ? s.camera_modes : (triggers.camera_modes || []))
 .map(m => CAMERA_MODE_NORM[m] || m).filter(Boolean),
 intensity_range: s.intensity_range || null,
 tier: s.tier || 'B',
 subjects: s.subjects || (triggers.subjects || ['any']),
 oneLiner: s.oneLiner || '',
 blocks: s.blocks || null // B1 起携带结构化块（含 qc 质检清单）
 };
}

// 【v2.4.0-B4】冷藏清单（scripts/skill-lifecycle-report.js 生成维护）
const QUARANTINE_PATH = path.join(__dirname, 'skills-quarantine.json');
let _quarantine = null;
function loadQuarantine() {
 if (_quarantine) return _quarantine;
 _quarantine = new Set();
 try {
 if (fs.existsSync(QUARANTINE_PATH)) {
 const q = JSON.parse(fs.readFileSync(QUARANTINE_PATH, 'utf8'));
 (q.quarantine || []).forEach(f => _quarantine.add(f));
 }
 } catch (e) { /* 冷藏清单损坏不阻断主流程 */ }
 return _quarantine;
}
const QUARANTINE = loadQuarantine();

function loadCompiledIndex() {
 try {
 if (fs.existsSync(COMPILED_V2_PATH)) {
 const data = JSON.parse(fs.readFileSync(COMPILED_V2_PATH, 'utf8'));
 if (Array.isArray(data.skills) && data.skills.length > 0) return data.skills.map(normalizeSkillEntry);
 }
 } catch (e) {
 console.warn(`[SkillRouter] 结构化编译产物读取失败，尝试旧索引: ${e.message}`);
 }
 try {
 if (fs.existsSync(COMPILED_INDEX_PATH)) {
 const data = JSON.parse(fs.readFileSync(COMPILED_INDEX_PATH, 'utf8'));
 if (Array.isArray(data.skills) && data.skills.length > 0) return data.skills.map(normalizeSkillEntry);
 }
 } catch (e) {
 console.warn(`[SkillRouter V2] 编译索引读取失败，回退文件名解析: ${e.message}`);
 }
 // 回退：从旧索引构建器重建为 V2 元数据形态
 const legacy = buildSkillIndex();
 const skills = new Map();
 for (const list of Object.values(legacy)) {
 for (const item of list) {
 if (skills.has(item.file)) continue;
 const m = item.meta;
 skills.set(item.file, {
 file: m.filename,
 skill_id: m.filename.replace('.md', ''),
 domain: m.type_zh === '微表情' ? 'acting' : 'cinematography',
 type: TAXONOMY.type_alias[m.type_zh] || m.type,
 director: m.director_zh || '',
 emotions: [TAXONOMY.emotion_alias[m.emotion_zh] || m.emotion].filter(Boolean),
 camera_modes: m.shotType ? [m.shotType] : []
 });
 }
 }
 return [...skills.values()].map(normalizeSkillEntry);
}

// ============================================================
// 【v2.3.3-A1】类型识别词表与归一
// 三级链：shot.genre 结构化字段（上游LLM产出）→ 全片类型先验（蓝图）
//        → 叙事实体词扫描 → 元关键词扫描（旧行为）→ 'drama' 兜底
// ============================================================

// genre 字段归一表：接受中英文、主题类型码（CINE/DOC）等多种来料
const GENRE_TO_SKILL_TYPE = {
 'drama': 'drama', '剧情': 'drama', 'cine': 'drama',
 'sci-fi': 'sci-fi', 'scifi': 'sci-fi', 'sci_fi': 'sci-fi', '科幻': 'sci-fi',
 'war': 'war', '战争': 'war',
 'horror': 'horror', '恐怖': 'horror',
 'comedy': 'comedy', '喜剧': 'comedy',
 'suspense': 'suspense', '悬疑': 'suspense',
 'thriller': 'thriller', '惊悚': 'thriller',
 'action': 'action', '动作': 'action',
 'loneliness': 'loneliness', '孤独': 'loneliness',
 'documentary': 'documentary', '纪录': 'documentary', 'doc': 'documentary',
 'fantasy': 'fantasy', '奇幻': 'fantasy',
 'micro-expression': 'micro-expression', '微表情': 'micro-expression'
};

function toSkillType(g) {
 if (!g) return '';
 const s = String(g).trim();
 return GENRE_TO_SKILL_TYPE[s.toLowerCase()] || GENRE_TO_SKILL_TYPE[s] || '';
}

// 叙事实体词表：真实镜头描述里"故事世界"的词，而非"科幻"这种元类型词
// （火星尘暴里没有"科幻"二字，但有"火星/尘暴/避难舱"）
// 顺序即优先级，越具体越靠前
const TYPE_ENTITY_PATTERNS = [
 ['sci-fi', /火星|月球|太空|星舰|外星|异星|宇航|空间站|避难舱|虫洞|星际|机器人|末世|废土|赛博|异形|飞碟|卫星|深空|行星|银河系|极地科考|飞船|alien|space|planet|starship|robot|sci-?fi|mars|lunar|spaceship/i],
 ['war', /战场|战壕|士兵|军队|冲锋|阵地|战火|战役|前线|硝烟|军演|抗战|碉堡|装甲|行军|battle|army|soldier|war|battlefield/i],
 ['horror', /灵异|闹鬼|诡异|古宅|怨灵|咒怨|鬼影|凶宅| horror |monster|haunted/i],
 ['comedy', /爆笑|搞笑|整蛊|滑稽|乌龙|段子|抖包袱|comedy|funny|laugh/i],
 ['suspense', /悬疑|谜案|失踪|线索|真凶|suspense|mystery/i],
 ['thriller', /惊悚|追杀|绑架|密室|thriller/i],
 ['action', /动作片|动作戏|动作场面|追逐|追车|打斗|搏斗|爆炸|枪战|飞车|跑酷|功夫|武侠|action|chase|gunfight|explosion/i],
 ['documentary', /纪录|纪实|田野|牧民|部落|迁徙|转场|documentary/i],
 ['fantasy', /奇幻|神话|神兽|异兽|精灵|魔法|仙侠|fantasy/i],
 ['micro-expression', /微表情|面部特写|表情特写|大特写/],
 ['loneliness', /独处|独居|孤身|独自一人|solitude/i]
];

function detectTypeByNarrative(desc) {
 for (const [t, re] of TYPE_ENTITY_PATTERNS) {
 if (re.test(desc)) return t;
 }
 return '';
}

// ============================================================
// 【v2.4.0-A4】主体检测：演技技能只对"有脸的镜头"开火
// 人化动物主体（企鹅/蝙蝠/异兽等）纳入演技适用范围——
// Nirath 内容体系里它们是角色；空镜/物体镜一律不注入面部表演。
// ============================================================
const SUBJECT_PERSON_RE = /他|她|老人|男孩|女孩|男人|女人|儿童|孩子|工人|工头|乐队|牧民|地质学家|游客|列车长|司机|医生|护士|士兵|父亲|母亲|爸爸|妈妈|演员|角色|人物|主角|少女|少年|夫妇|兄弟|姐妹|老师|学生|小贩|婴儿|宝宝|爷爷|奶奶|面部|脸|眼|手|指|笑容|眼泪|企鹅|蝙蝠|骆驼|异兽|神兽|狼|鹰|马|犬|猫|熊|鹿|狐/;
const SUBJECT_CLOSE_RE = /大特写|特写|近景|面部|微表情/;
const SUBJECT_WIDE_RE = /远景|全景|大全景|航拍|空镜|俯拍/;

function detectSubject(shot) {
 const text = `${shot.description || ''} ${shot.scene || ''} ${shot.action || ''} ${shot.character || ''} ${shot.角色 || ''}`;
 const hasPerson = SUBJECT_PERSON_RE.test(text) || !!shot.character || !!shot.portraits;
 const shotScale = SUBJECT_CLOSE_RE.test(text) ? 'close'
 : (SUBJECT_WIDE_RE.test(text) ? 'wide' : (hasPerson ? 'medium' : 'unknown'));
 return { hasPerson, shotScale };
}

// 【v2.4.0-A6】技能时间轴按镜头实际时长等比缩放：
// 技能正文的时间码以约10秒弧长为基准（如 0-3秒/3-5秒/5-7秒/7-10秒），
// 缩放后写入镜头时间轴，让技能节奏真正落到时长分配上。
function scaleSkillTimeline(timelineText, durationSec) {
 if (!timelineText || !durationSec || durationSec <= 0) return timelineText || '';
 const segs = [];
 const re = /(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*秒([^，。,；;]*)/g;
 let m, maxEnd = 0;
 while ((m = re.exec(timelineText)) !== null) {
 segs.push({ a: parseFloat(m[1]), b: parseFloat(m[2]), desc: m[3].trim() });
 if (m[2] > maxEnd) maxEnd = parseFloat(m[2]);
 }
 if (segs.length === 0 || maxEnd <= 0) return timelineText;
 const k = durationSec / maxEnd;
 return segs.map(s => `${(s.a * k).toFixed(1)}-${(s.b * k).toFixed(1)}秒${s.desc}`).join('，');
}

/** shot 侧结构化元数据（不再靠正则猜） */
function normalizeShotMeta(shot, opts = {}) {
 const rawMood = String(shot.mood || shot.emotion || shot.emotional_target?.emotion || '').toLowerCase().trim();
 const rawCam = String(shot.camera?.movement || shot.cameraString || shot.cameraMovement || '').toLowerCase();
 let cameraMode = 'any';
 for (const [alias, mode] of Object.entries(TAXONOMY.camera_alias)) {
 if (rawCam && rawCam.includes(alias.toLowerCase())) { cameraMode = mode; break; }
 }
 // 【v2.3.2】场景描述参与识别（此前仅 mood 单字段，大量镜头元数据被浪费）
 const desc = String(shot.description || shot.scene || shot.sceneDesc || shot.prompt || '');
 // 【v2.3.3-A1】类型三级链：结构化 genre 字段 → 全片先验 → 叙事实体词 → 元关键词 → drama
 let type = toSkillType(shot.genre || shot.题材 || (shot.fields && shot.fields.genre) || '');
 if (!type && opts.filmGenre) type = toSkillType(opts.filmGenre);
 if (!type) type = detectTypeByNarrative(desc);
 if (!type) {
 if (/科幻|alien|space|planet|starship|robot/i.test(desc)) type = 'sci-fi';
 else if (/战争|battle|army|soldier|war/i.test(desc)) type = 'war';
 else if (/恐怖|horror|monster/i.test(desc)) type = 'horror';
 else if (/喜剧|comedy|funny|laugh/i.test(desc)) type = 'comedy';
 else if (/悬疑|suspense|mystery/i.test(desc)) type = 'suspense';
 else if (/惊悚|thriller/i.test(desc)) type = 'thriller';
 else if (/动作片|动作戏|动作场面|^动作|，动作，|追逐|追车|打斗|搏斗|爆炸|枪战|飞车|action|chase|gunfight|explosion/i.test(desc)) type = 'action';
 else if (/微表情|面部特写|表情特写|大特写/.test(desc)) type = 'micro-expression';
 else if (/独处|独居|孤身|独自一人|solitude/i.test(desc)) type = 'loneliness';
 else if (/纪录|纪实|documentary/i.test(desc)) type = 'documentary';
 else if (/奇幻|神话|神兽|异兽|fantasy/i.test(desc)) type = 'fantasy';
 }
 if (!type) type = 'drama';
 // 【v2.3.2】情绪归一：alias 命中 → 技能情绪标签直通扫描（mood 优先、desc 其次）→ 原文兜底 → canonical 归一
 let emotion = TAXONOMY.emotion_alias[rawMood] || '';
 if (!emotion) {
 const moodText = String(shot.mood || shot.emotion || shot.emotional_target?.emotion || '');
 for (const [zh, en] of buildEmotionScanEntries()) {
 if (zh && moodText.includes(zh)) { emotion = en; break; }
 }
 if (!emotion) {
 for (const [zh, en] of buildEmotionScanEntries()) {
 if (zh && desc.includes(zh)) { emotion = en; break; }
 }
 }
 }
 if (!emotion) emotion = rawMood || '';
 emotion = canonEmotion(emotion);
 // 【v2.3.3-A2】导演三级链：镜头显式指定 → 全片蓝图选定（一部片一位导演）
 // → 描述检测（旧行为）；记录来源供遥测与一致性审计
 let director = '', directorSource = 'none';
 if (shot.director) {
 if (SKILL_DIRECTOR_MAP[shot.director]) {
 director = shot.director; directorSource = 'shot'; // 中文名直取
 } else {
 const zh = Object.keys(SKILL_DIRECTOR_MAP).find(k => SKILL_DIRECTOR_MAP[k] === String(shot.director).toLowerCase());
 if (zh) { director = zh; directorSource = 'shot'; } // 英文名转中文（技能索引统一中文口径）
 }
 }
 if (!director && opts.assignedDirector) {
 director = opts.assignedDirector;
 directorSource = 'assigned';
 }
 if (!director) {
 director = detectDirectorZh(desc);
 if (director) directorSource = 'detected';
 }
 return {
 shotId: shot.shotId || shot.shot_id,
 type,
 emotion,
 cameraMode,
 director,
 directorSource,
 subject: detectSubject(shot), // 【v2.4.0-A4】主体/景别，供演技技能门控与剂量分级
 intensity: shot._creativeIntensity || null
 };
}

// ============================================================
// 【v2.3.3-A2】全片导演选定（一部片一位导演，蓝图阶段确定）
// 导演从"每镜头的随机标签"升级为"全片的风格宪法"：
// 一致性（电影不会每镜头换导演）、可复现（重跑风格稳定）、
// 产品化（用户可指定风格档位）。
// ============================================================

// 片种 → 默认导演（该导演须在技能库中有作品）
const FILM_DIRECTOR_TABLE = {
 'sci-fi': '维伦纽瓦',
 'war': '斯皮尔伯格',
 'horror': '大卫林奇',
 'suspense': '希区柯克',
 'thriller': '芬奇',
 'comedy': '韦斯安德森',
 'action': '卡梅隆',
 'loneliness': '卡萨维茨',
 'documentary': '卡萨维茨',
 'fantasy': '卢卡斯'
};

// 剧情片按情绪基调细分导演
const DRAMA_MOOD_DIRECTOR = [
 [/史诗|宏大|悲壮|庄严|epic/i, '诺兰'],
 [/温情|感人|暖|治愈|tender|warm/i, '斯皮尔伯格'],
 [/哀伤|悲|grief|sad/i, '卡梅隆'],
 [/孤独|寂寞|lonely/i, '黑泽明'],
 [/浪漫|romantic/i, '斯派克琼斯'],
 [/紧张|压迫|tense/i, '芬奇']
];

/**
 * 为全片选定一位导演
 * @param {object} blueprint 蓝图（可含 genre/type/mood/tone/description/title/director）
 * @returns {{director: string, source: string}} 导演中文名与选定来源
 */
function assignFilmDirector(blueprint = {}) {
 // 1. 显式指定优先（用户风格档位的未来入口）
 const explicit = blueprint.director || (blueprint.config && blueprint.config.director) || blueprint._metadata && blueprint._metadata.director || '';
 if (explicit) {
 if (SKILL_DIRECTOR_MAP[explicit]) return { director: explicit, source: 'explicit' };
 const zh = Object.keys(SKILL_DIRECTOR_MAP).find(k => SKILL_DIRECTOR_MAP[k] === String(explicit).toLowerCase());
 if (zh) return { director: zh, source: 'explicit' };
 }
 // 2. 非剧情片种 → 片种默认导演
 const genreText = String(blueprint.genre || blueprint.type || '');
 let g = toSkillType(genreText);
 // 蓝图类型缺失/为主题码时，扫描标题与描述里的叙事实体词
 if (!g) g = detectTypeByNarrative(`${blueprint.title || ''} ${blueprint.description || ''} ${blueprint.theme || ''}`);
 if (g && g !== 'drama' && g !== 'micro-expression' && FILM_DIRECTOR_TABLE[g]) {
 return { director: FILM_DIRECTOR_TABLE[g], source: 'genre:' + g };
 }
 // 3. 剧情片 → 按情绪基调细分
 const mood = String(blueprint.mood || blueprint.tone || blueprint.description || blueprint.title || '');
 for (const [re, d] of DRAMA_MOOD_DIRECTOR) {
 if (re.test(mood)) return { director: d, source: 'mood' };
 }
 // 4. 兜底：斯皮尔伯格（剧情片最大公约数，技能覆盖最全）
 return { director: '斯皮尔伯格', source: 'default' };
}

function matchSkillsV2(shotMeta, opts = {}) {
 const { limit = 2, minScore = 5, usedSkillRatio = {} } = opts;
 const skills = loadCompiledIndex();

 const scored = [];
 for (const skill of skills) {
 let score = 0;
 const reasons = [];

 // 硬约束：运镜冲突直接排除（配回退链，见函数尾）
 const shotCam = shotMeta.cameraMode || 'any';
 const skillCams = skill.camera_modes.length ? skill.camera_modes : ['any'];
 const conflict = (TAXONOMY.camera_conflicts[shotCam] || []).some(c => skillCams.includes(c));
 if (conflict && !skillCams.includes('any')) {
 scored.push({ skill, score: -999, excluded: 'camera-conflict' });
 continue;
 }

 // 【v2.4.0-A4】主体门控：无人物主体的镜头不注入演技技能
 // （"无声落泪的面部图谱"不该注入拍乐器滑行的空镜）
 if (skill.domain === 'acting' && shotMeta.subject && !shotMeta.subject.hasPerson) {
 scored.push({ skill, score: -999, excluded: 'no-person-subject' });
 continue;
 }

 // 【v2.4.0-B4】冷藏技能默认排除（遥测连续零开火技能进入冷藏区）
 if (QUARANTINE.has(skill.file)) {
 scored.push({ skill, score: -998, excluded: 'quarantine' });
 continue;
 }

 // 情绪匹配（主信号）
 if (shotMeta.emotion && skill.emotions.includes(shotMeta.emotion)) { score += 30; reasons.push('emotion'); }
 // 类型匹配
 if (shotMeta.type && skill.type === shotMeta.type) { score += 10; reasons.push('type'); }
 // 跨域补偿：acting 技能适配所有类型
 if (skill.domain === 'acting' && shotMeta.emotion && skill.emotions.includes(shotMeta.emotion)) { score += 12; reasons.push('acting-cross-domain'); }
 // 运镜兼容加分
 if (shotCam !== 'any' && skillCams.includes(shotCam)) { score += 8; reasons.push('camera'); }
 // 导演亲和
 if (shotMeta.director && skill.director === shotMeta.director) { score += 15; reasons.push('director'); }
 // 创意档位（v2.4.0 修复：强度 0-1 浮点归一为 L0-L5 档位再比较，
 // 旧实现 'L0.92' 字符串比较恒不命中，该通道形同虚设）
 if (shotMeta.intensity != null && skill.intensity_range) {
 const [lo, hi] = skill.intensity_range;
 const lv = 'L' + Math.max(0, Math.min(5, Math.round(Number(shotMeta.intensity) * 5)));
 if (lv >= lo && lv <= hi) { score += 5; reasons.push('intensity'); }
 }
 // 【v2.4.0-B1】质量分级微调：S 级优先进、C 级（可疑组合/待重构）靠后
 if (skill.tier === 'S') score += 3;
 else if (skill.tier === 'C') score -= 3;
 // 多样性惩罚：本 run 内已被 >1/3 镜头使用的技能降权
 const ratio = usedSkillRatio[skill.file] || 0;
 if (ratio > 0.34) score -= 12;

 scored.push({ skill, score, reasons });
 }

 let top = scored.filter(s => s.score >= minScore && !s.excluded)
 .sort((a, b) => b.score - a.score).slice(0, limit);
 // 回退链：硬约束杀光时，放宽运镜约束取情绪最高分并标记 fallback
 if (top.length === 0) {
 const relaxed = scored.filter(s => s.reasons?.includes('emotion') && s.score > -999)
 .sort((a, b) => b.score - a.score).slice(0, 1);
 relaxed.forEach(r => { r.fallback = true; r.score = Math.max(r.score, minScore); });
 top = relaxed;
 }
 return top;
}

// 【v2.3.3-A3】按完整条目截取：bullet 要么整条保留，要么整条舍弃，
// 杜绝旧实现 slice(0,120) 把指令砍在句子中间（"插入特"/"- 配"）
function takeCompleteItems(text, budget) {
 if (!text) return '';
 const items = text.split(/\n(?=\s*(?:\*\*|[-•]))/).map(s => s.trim()).filter(Boolean);
 const picked = [];
 let used = 0;
 for (const it of items) {
 if (used + it.length > budget && picked.length > 0) break;
 picked.push(it);
 used += it.length + 1;
 if (used >= budget) break;
 }
 return picked.join('\n');
}

/** 技能上下文文本构建：供 PromptFusion 生成前注入（L3 主通道） */
function buildSkillContextText(matched, opts = {}) {
 const { shotScale = 'unknown', duration = 0 } = opts;
 // 【v2.3.3-A3】主辅剂量分级：主技能全量、辅技能半量（主/辅语义与总分控兼顾）
 const BUDGETS = [
 { shot: 500, emotion: 350, forbidden: 400 }, // 主技能
 { shot: 300, emotion: 200, forbidden: 250 } // 辅技能
 ];
 const parts = [];
 let idx = 0;
 for (const m of matched) {
 const skillPath = path.join(SKILL_LIB_ROOT, m.skill.file);
 const enh = extractSkillEnhancement(skillPath);
 if (!enh) continue;
 let budget = BUDGETS[Math.min(idx, BUDGETS.length - 1)];
 idx++;
 // 【v2.4.0-A4】剂量分级：远景里的演技技能降半量（脸都看不清，不给特写级指导）
 if (m.skill && m.skill.domain === 'acting' && shotScale === 'wide') {
 budget = BUDGETS[BUDGETS.length - 1];
 }
 // 【v2.3.3-A3】标签带文件名：两个不同技能不再共用同一归一化标签（撞车修复）
 const role = idx === 1 ? '主' : '辅';
 const tag = `${m.skill.file}（${m.skill.type}/${m.skill.director || '通用'}/${m.skill.emotions.join('/')}${m.fallback ? '，回退匹配' : ''}）`;
 const block = [`◆ 技能「${tag}」（${role}，匹配分 ${m.score}）`];
 if (enh.shotBlock) block.push(`镜头手法:\n${takeCompleteItems(enh.shotBlock, budget.shot)}`);
 if (enh.emotionBlock) block.push(`情绪设计:\n${takeCompleteItems(enh.emotionBlock, budget.emotion)}`);
 // 【v2.4.0-A6】时间轴按镜头实际时长缩放后入链：技能节奏正式落到时长分配
 const tlLine = (enh.promptBlock || '').split('\n').find(l => /时间轴/.test(l));
 if (tlLine) {
 let tl = tlLine.replace(/^\s*\*\*时间轴分配\*\*[:：]\s*/, '').trim();
 if (duration > 0) tl = scaleSkillTimeline(tl, duration);
 if (tl && tl.length <= 260) block.push(`时间轴: ${tl}`);
 }
 if (enh.forbiddenBlock) block.push(`禁止词:\n${takeCompleteItems(enh.forbiddenBlock, budget.forbidden)}`);
 parts.push(block.join('\n'));
 }
 // 单镜头技能上下文总长封顶 1800 字符（主技能约800 + 辅技能约800 均可整块保留）
 const out = [];
 let total = 0;
 for (const part of parts) {
 if (total + part.length > 1800 && out.length > 0) break;
 out.push(part);
 total += part.length + 2;
 }
 return out.join('\n\n');
}

/**
 * 批量预匹配（供 Phase 3 主通道调用）
 * @returns {Map} shotId → { matched, contextText }
 */
// 【v2.4.0-A4】双通道选编：演技技能与摄影技能分轨，互不挤占。
// 修复旧制"两个演技技能占满 Top2、摄影技能零注入"的编制事故。
function pickDualTrack(ranked, maxSkillsPerShot) {
 if (ranked.length === 0) return [];
 const picked = [ranked[0]];
 const wantDomain = ranked[0].skill.domain === 'acting' ? 'cinematography' : 'acting';
 const partner = ranked.find(s => (s.skill.domain || 'cinematography') === wantDomain);
 if (partner && picked.length < maxSkillsPerShot) picked.push(partner);
 for (const s of ranked) {
 if (picked.length >= maxSkillsPerShot) break;
 if (!picked.includes(s)) picked.push(s);
 }
 return picked.slice(0, maxSkillsPerShot);
}

function routeAndEnhanceV2(shots, opts = {}) {
 const { minScore = 5, maxSkillsPerShot = 2, assignedDirector = '', filmGenre = '' } = opts;
 const plan = new Map();
 const useCount = {};
 for (const shot of shots) {
 // 【v2.3.3】导演/类型三级链接入：assignedDirector 来自蓝图选定，filmGenre 为全片类型先验
 const meta = normalizeShotMeta(shot, { assignedDirector, filmGenre });
 const ratio = {};
 const total = Math.max(shots.length, 1);
 for (const [f, c] of Object.entries(useCount)) ratio[f] = c / total;
 const ranked = matchSkillsV2(meta, { limit: maxSkillsPerShot + 4, minScore, usedSkillRatio: ratio });
 const matched = pickDualTrack(ranked, maxSkillsPerShot);
 matched.forEach(m => { useCount[m.skill.file] = (useCount[m.skill.file] || 0) + 1; });
 plan.set(meta.shotId, {
 // 【v2.3.3-A7】遥测元数据透传：类型/导演/来源随 plan 落盘
 type: meta.type,
 director: meta.director,
 directorSource: meta.directorSource,
 subject: meta.subject,
 matched: matched.map(m => ({ file: m.skill.file, score: m.score, fallback: !!m.fallback, reasons: m.reasons || [], domain: m.skill.domain || 'cinematography' })),
 contextText: buildSkillContextText(matched, { shotScale: meta.subject.shotScale, duration: shot.duration || 0 })
 });
 }
 return plan;
}

// ============================================================
// 【v2.4.0-B2】LLM 语义路由 V3：结构化触发器粗筛 Top8 →
// LLM 读"镜头卡 + 候选技能一句话清单"精选并给出理由。
// llmCaller 为注入式依赖（生产环境由 phase-3 提供），
// 无 caller 或 LLM 异常时自动降级 V2 打分——语义层永不阻断生产。
// ============================================================

function buildSkillSelectionPrompt(shot, meta, candidates) {
 const roster = candidates.map((c, i) =>
 `${i + 1}. ${c.skill.file}｜类型=${c.skill.type}｜导演=${c.skill.director || '通用'}｜情绪=${(c.skill.emotions || []).join('/')}\n 简介: ${c.skill.oneLiner || '（无）'}`
 ).join('\n');
 return `你是电影摄影指导。为下面这个镜头从候选技能中精选最多 2 个最合适的电影技能。

【镜头】类型=${meta.type} 情绪=${meta.emotion || '未明'} 运镜=${meta.cameraMode} 导演风格=${meta.director || '未定'}
【画面】${String(shot.description || shot.scene || '').slice(0, 200)}

【候选技能】
${roster}

要求：
1. 只选真正服务这个镜头的技能，宁缺毋滥（可以只选 1 个）
2. 演技类技能只在镜头有人物面部时选择
3. 输出 JSON：{"picks":[{"file":"技能文件名","reason":"一句话理由"}]}`;
}

function parseLLMPicks(llmResult, candidates) {
 const files = new Set(candidates.map(c => c.skill.file));
 let obj = llmResult;
 if (typeof llmResult === 'string') {
 const m = llmResult.match(/\{[\s\S]*\}/);
 try { obj = m ? JSON.parse(m[0]) : null; } catch (e) { obj = null; }
 }
 if (!obj || !Array.isArray(obj.picks)) return [];
 return obj.picks
 .filter(p => p && files.has(p.file))
 .map(p => ({ file: p.file, reason: String(p.reason || '').slice(0, 120) }));
}

async function routeAndEnhanceV3(shots, opts = {}) {
 const { minScore = 5, maxSkillsPerShot = 2, assignedDirector = '', filmGenre = '', llmCaller = null } = opts;
 const plan = new Map();
 const useCount = {};
 for (const shot of shots) {
 const meta = normalizeShotMeta(shot, { assignedDirector, filmGenre });
 const ratio = {};
 const total = Math.max(shots.length, 1);
 for (const [f, c] of Object.entries(useCount)) ratio[f] = c / total;
 const ranked = matchSkillsV2(meta, { limit: 8, minScore, usedSkillRatio: ratio });

 let matched = null;
 let router = 'v2-score';
 // B2 语义精选：候选超过编制时交 LLM 裁决
 if (llmCaller && ranked.length > maxSkillsPerShot) {
 try {
 const llmResult = await llmCaller(buildSkillSelectionPrompt(shot, meta, ranked));
 const picks = parseLLMPicks(llmResult, ranked);
 if (picks.length > 0) {
 matched = picks.slice(0, maxSkillsPerShot).map(p => {
 const src = ranked.find(r => r.skill.file === p.file);
 return { ...src, llmReason: p.reason };
 });
 router = 'v3-llm';
 }
 } catch (e) {
 console.warn(`[SkillRouter V3] LLM 精选异常，降级 V2: ${e.message}`);
 }
 }
 if (!matched) matched = pickDualTrack(ranked, maxSkillsPerShot);

 matched.forEach(m => { useCount[m.skill.file] = (useCount[m.skill.file] || 0) + 1; });
 plan.set(meta.shotId, {
 type: meta.type,
 director: meta.director,
 directorSource: meta.directorSource,
 subject: meta.subject,
 router,
 matched: matched.map(m => ({ file: m.skill.file, score: m.score, fallback: !!m.fallback, reasons: m.reasons || [], domain: m.skill.domain || 'cinematography', llmReason: m.llmReason || null })),
 contextText: buildSkillContextText(matched, { shotScale: meta.subject.shotScale, duration: shot.duration || 0 })
 });
 }
 return plan;
}

// 【v2.4.0-B3】技能质检块读取：评审环节拉取命中技能的质检清单与禁止词
function getSkillQCBlocks(files) {
 const idx = loadCompiledIndex();
 return (files || [])
 .map(f => idx.find(s => s.file === f))
 .filter(Boolean)
 .map(s => ({
 file: s.file,
 qc: (s.blocks && s.blocks.qc) || [],
 forbidden: (s.blocks && s.blocks.forbidden) || []
 }));
}

// 机械合规检查：禁止词（冒号前短语）残留在最终提示词中即记违规
function checkSkillCompliance(text, qcEntry) {
 const violations = [];
 for (const f of (qcEntry.forbidden || [])) {
 const term = String(f).split(/[：:]/)[0].trim();
 if (term && term.length >= 2 && /[一-龥a-zA-Z]/.test(term) && text.includes(term)) violations.push(term);
 }
 return violations;
}

module.exports = {
  buildSkillIndex,
  extractShotMetadata,
  matchSkills,
  injectSkillEnhancement,
  routeAndEnhance,
  parseSkillFilename,
  SKILL_LIB_ROOT,
  matchSkillsV2,
  normalizeShotMeta,
  routeAndEnhanceV2,
  routeAndEnhanceV3,
  buildSkillContextText,
  assignFilmDirector,
  toSkillType,
  detectTypeByNarrative,
  detectSubject,
  scaleSkillTimeline,
  pickDualTrack,
  getSkillQCBlocks,
  checkSkillCompliance
};