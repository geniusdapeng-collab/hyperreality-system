/**
 * 全局中文字段标准规范机制
 * 文件: systems/unified-shot-schema-zh.js
 *
 * 目标：
 * 1. 统一片头/内容镜头字段为中文
 * 2. 吸收现有英文字段/旧字段
 * 3. 强制补齐关键字段
 * 4. 提供归一化 / 校验 / 修复能力
 */

function 深拷贝(obj) {
  return JSON.parse(JSON.stringify(obj || {}));
}

function 是非空字符串(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function 转数组(v) {
  if (Array.isArray(v)) return v;
  if (v == null) return [];
  return [v];
}

function 安全取(obj, keys = [], fallback = '') {
  for (const key of keys) {
    const val = obj?.[key];
    if (val !== undefined && val !== null && val !== '') return val;
  }
  return fallback;
}

function 格式化时间轴(startSec, durationSec) {
  const s = Number(startSec || 0);
  const d = Number(durationSec || 0);
  const e = s + d;
  const fmt = (n) => {
    const mm = String(Math.floor(n / 60)).padStart(2, '0');
    const ss = String(Math.floor(n % 60)).padStart(2, '0');
    return `${mm}:${ss}`;
  };
  return `${fmt(s)}-${fmt(e)} / 时长:${d}s`;
}

const 片头字段模板 = {
  镜头编号: '',
  镜头类型: '片头',
  场景名称: '片头-开场',
  主标题: '',
  副标题: '',
  // === 新增：导演指令层（P0）===
  导演指令: '',
  // === 新增：画面基底（P0）===
  约束: '',
  基础: '',
  // === 空间层（P0）===
  场景: '',
  灯光: {
    主光: '',
    补光: '',
    氛围光: '',
    描述: ''
  },
  // === 镜头语言层（P1）===
  构图: {
    景别: '',
    主体位置: '',
    线条引导: ''
  },
  色彩: {
    主色调: '',
    辅助色: '',
    饱和度: '',
    对比度: ''
  },
  景深: {
    焦点位置: '',
    虚化程度: '',
    清晰范围: ''
  },
  运镜: {
    描述: '',
    景别: '',
    运动: '',
    镜头参数: ''
  },
  // === 人物层（P0/P1/P2）===
  角色: '',
  服装: {
    外套上装: '',
    内搭: '',
    下装: '',
    鞋履配饰: ''
  },
  化妆: {
    面部妆容: '',
    发型: '',
    整体造型: ''
  },
  动作: '',
  道具: [],
  // === 质量层（P0）===
  定妆照: [],
  台词: '',
  时间轴: '',
  情绪: '',
  // === 渲染/调度层（P1/P2）===
  节奏: {
    整体: '',
    开头: '',
    中段: '',
    高潮: '',
    结尾: ''
  },
  转场: '',
  音频: {
    环境音效: '',
    音乐: '',
    人声处理: ''
  },
  // === 约束层（P0/P1）===
  负面约束: '',
  明亮约束: '',
  角色约束: '',
  角色一致性: [],
  // === 保留旧字段（兼容）===
  旁白: '',
  画面提示词: '',
  时长: 0,
  人物列表: [],
  原始字段: {}
};

const 内容字段模板 = {
  镜头编号: '',
  镜头类型: '内容',
  场景名称: '',
  主标题: '',
  副标题: '',
  // === 新增：导演指令层（P0）===
  导演指令: '',
  // === 新增：画面基底（P0）===
  约束: '',
  基础: '',
  // === 空间层（P0）===
  场景: '',
  灯光: {
    主光: '',
    补光: '',
    氛围光: '',
    描述: ''
  },
  // === 镜头语言层（P1）===
  构图: {
    景别: '',
    主体位置: '',
    线条引导: ''
  },
  色彩: {
    主色调: '',
    辅助色: '',
    饱和度: '',
    对比度: ''
  },
  景深: {
    焦点位置: '',
    虚化程度: '',
    清晰范围: ''
  },
  运镜: {
    描述: '',
    景别: '',
    运动: '',
    镜头参数: ''
  },
  // === 人物层（P0/P1/P2）===
  角色: '',
  服装: {
    外套上装: '',
    内搭: '',
    下装: '',
    鞋履配饰: ''
  },
  化妆: {
    面部妆容: '',
    发型: '',
    整体造型: ''
  },
  动作: '',
  道具: [],
  // === 质量层（P0）===
  定妆照: [],
  台词: '',
  时间轴: '',
  情绪: '',
  // === 渲染/调度层（P1/P2）===
  节奏: {
    整体: '',
    开头: '',
    中段: '',
    高潮: '',
    结尾: ''
  },
  转场: '',
  音频: {
    环境音效: '',
    音乐: '',
    人声处理: ''
  },
  // === 约束层（P0/P1）===
  负面约束: '',
  明亮约束: '',
  角色约束: '',
  角色一致性: [],
  // === 保留旧字段（兼容）===
  旁白: '',
  画面提示词: '',
  嘴部动作: '',
  时长: 0,
  人物列表: [],
  原始字段: {}
};

function 构建角色一致性(rawShot = {}, charactersMap = {}) {
  const 人物列表 = 转数组(rawShot.characters || rawShot.人物列表 || []);
  return 人物列表.map((id) => {
    const c = charactersMap?.[id] || charactersMap?.[String(id).toLowerCase()] || {};
    const profile = c.profile || c;
    return {
      角色ID: id,
      角色名: 安全取(profile, ['name', '名称'], id),
      角色定位: 安全取(profile?.baseIdentity || profile, ['role', '角色'], ''),
      年龄: 安全取(profile?.baseIdentity || profile, ['age', '年龄'], ''),
      性别: 安全取(profile?.baseIdentity || profile, ['gender', '性别'], ''),
      外观特征: 安全取(profile?.visualIdentity || profile, ['distinguishingMarks', 'appearance', '外观特征'], ''),
      // v6.7.0: 新增三段式锚定词
      面部特征: 安全取(profile?.visualAnchors || profile, ['face', '面部特征'], ''),
      服装特征: 安全取(profile?.visualAnchors || profile, ['costume', '服装特征'], ''),
      体型特征: 安全取(profile?.visualAnchors || profile, ['body', '体型特征'], '')
    };
  });
}

// 保留旧函数名向后兼容
const 构建人物介绍卡片 = 构建角色一致性;

function 构建定妆照(rawShot = {}, charactersMap = {}) {
  const out = [];
  const 人物列表 = 转数组(rawShot.characters || rawShot.人物列表 || []);
  const 已有 = Array.isArray(rawShot.referenceImages) ? rawShot.referenceImages : [];
  for (const ref of 已有) {
    out.push({
      角色ID: ref.character || ref.characterId || '',
      角度: ref.angle || '',
      路径: ref.image_url?.url || ref.url || ''
    });
  }

  for (const id of 人物列表) {
    const c = charactersMap?.[id] || {};
    const portraits = c.portraits || {};
    for (const [角度, 路径] of Object.entries(portraits)) {
      if (!out.find(x => x.角色ID === id && x.路径 === 路径)) {
        out.push({ 角色ID: id, 角度, 路径 });
      }
    }
  }

  return out;
}

// 保留旧函数名向后兼容
const 构建绑定定妆照 = 构建定妆照;

function 归一化镜头(rawShot = {}, options = {}) {
  const { charactersMap = {}, globalStartSec = 0, isOpening = false } = options;
  const base = 深拷贝(isOpening ? 片头字段模板 : 内容字段模板);

  const 时长 = Number(安全取(rawShot, ['duration', '时长'], 0)) || 0;
  const 镜头编号 = 安全取(rawShot, ['shotId', 'id', '镜头编号'], isOpening ? 'S00' : '');
  const 场景名称 = 安全取(rawShot, ['scene', '场景名称', 'name'], isOpening ? '片头-开场' : '');
  const 台词 = 安全取(rawShot, ['dialogue', '台词'], '');
  const 旁白 = 安全取(rawShot, ['narration', '旁白'], '');
  const 主标题 = 安全取(rawShot.title || {}, ['main', '主标题'], 安全取(rawShot, ['主标题'], ''));
  const 副标题 = 安全取(rawShot.title || {}, ['sub', '副标题'], 安全取(rawShot, ['副标题'], ''));

  base.镜头编号 = 镜头编号;
  base.镜头类型 = isOpening ? '片头' : '内容';
  base.场景名称 = 场景名称;
  base.主标题 = 主标题;
  base.副标题 = 副标题;
  base.台词 = 台词;
  base.旁白 = 旁白;
  base.时长 = 时长;
  base.人物列表 = 转数组(rawShot.characters || rawShot.人物列表 || []);
  base.时间轴 = 安全取(
    rawShot,
    ['timelineString', '时间轴', '镜头时间轴'],
    格式化时间轴(globalStartSec, 时长)
  );

  // v6.7.0: 角色一致性（原人物介绍卡片）
  base.角色一致性 = 构建角色一致性(rawShot, charactersMap);
  // 保留旧字段兼容
  base.人物介绍卡片 = base.角色一致性;

  // v6.7.0: 定妆照（原绑定定妆照）
  base.定妆照 = 构建定妆照(rawShot, charactersMap);
  // 保留旧字段兼容
  base.绑定定妆照 = base.定妆照;

  // v6.7.0: 导演指令（从渲染参数/导演指令拆分）
  base.导演指令 = 安全取(rawShot, ['directorInstruction', 'director_instruction', '导演指令'], '');

  // v6.7.0: 约束（硬编码注入，此处预留）
  base.约束 = 安全取(rawShot, ['constraint', '约束'], '');

  // v6.7.0: 基础（从负面约束/画质词拆分）
  base.基础 = 安全取(rawShot, ['baseline', '基础'], '');

  // v6.7.0: 场景（三维度描述：空间类型+环境特征+时代背景）
  base.场景 = 安全取(rawShot, ['sceneDescription', 'scene_description', '场景'], base.场景名称);

  // 灯光
  base.灯光 = {
    主光: 安全取(rawShot.lighting?.keyLight || {}, ['effect', '主光'], ''),
    补光: 安全取(rawShot.lighting?.fillLight || {}, ['effect', '补光'], ''),
    氛围光: 安全取(rawShot.lighting || {}, ['special', '氛围光'], ''),
    描述: 安全取(rawShot, ['lightingString', '灯光描述'], 安全取(rawShot.lighting || {}, ['description', '描述'], ''))
  };

  // v6.7.0: 构图（新增：景别+主体位置+线条引导）
  base.构图 = {
    景别: 安全取(rawShot.composition || {}, ['shotSize', '景别'], 安全取(rawShot.camera || {}, ['shotSize', '景别'], '')),
    主体位置: 安全取(rawShot.composition || {}, ['subjectPosition', '主体位置'], ''),
    线条引导: 安全取(rawShot.composition || {}, ['leadingLines', '线条引导'], '')
  };

  // v6.7.0: 色彩/色调（从风格拆分）
  base.色彩 = {
    主色调: 安全取(rawShot.colorPalette || rawShot.style || {}, ['dominantColor', '主色调'], ''),
    辅助色: 安全取(rawShot.colorPalette || rawShot.style || {}, ['accentColor', '辅助色'], ''),
    饱和度: 安全取(rawShot.colorPalette || rawShot.style || {}, ['saturation', '饱和度'], ''),
    对比度: 安全取(rawShot.colorPalette || rawShot.style || {}, ['contrast', '对比度'], '')
  };

  // v6.7.0: 景深（新增）
  base.景深 = {
    焦点位置: 安全取(rawShot.depthOfField || {}, ['focusPoint', '焦点位置'], ''),
    虚化程度: 安全取(rawShot.depthOfField || {}, ['bokehQuality', '虚化程度'], ''),
    清晰范围: 安全取(rawShot.depthOfField || {}, ['depthRange', '清晰范围'], '')
  };

  base.运镜 = {
    描述: 安全取(rawShot.cameraMovement || rawShot.camera || {}, ['description', 'string', '描述'], 安全取(rawShot, ['cameraString'], '')),
    景别: 安全取(rawShot.camera || {}, ['shotSize', '景别'], ''),
    运动: 安全取(rawShot.camera || rawShot.cameraMovement || {}, ['movement', 'primaryMovement', '运动'], ''),
    镜头参数: 安全取(rawShot.camera || {}, ['lens', '镜头参数'], '')
  };

  // v6.7.0: 角色（三维度描述：身份+姿态+表情）
  base.角色 = 安全取(rawShot, ['character', '角色'], '');

  // v6.7.0: 服装（新增：分层描述）
  base.服装 = {
    外套上装: 安全取(rawShot.costume || {}, ['outerwear', '外套上装'], ''),
    内搭: 安全取(rawShot.costume || {}, ['innerwear', '内搭'], ''),
    下装: 安全取(rawShot.costume || {}, ['bottoms', '下装'], ''),
    鞋履配饰: 安全取(rawShot.costume || {}, ['footwear', '鞋履配饰'], '')
  };

  // v6.7.0: 化妆（新增）
  base.化妆 = {
    面部妆容: 安全取(rawShot.makeup || {}, ['face', '面部妆容'], ''),
    发型: 安全取(rawShot.makeup || {}, ['hair', '发型'], ''),
    整体造型: 安全取(rawShot.makeup || {}, ['overall', '整体造型'], '')
  };

  // v6.7.0: 道具（新增：位置标注）
  base.道具 = 转数组(rawShot.props || rawShot.道具 || []);

  base.画面提示词 = 安全取(rawShot, ['prompt', 'visualPrompt', '画面提示词'], '');
  base.音频 = {
    环境音效: 安全取(rawShot.backgroundSound || {}, ['ambient', '环境音效'], ''),
    音乐: 安全取(rawShot.audioLayer || {}, ['string', '音乐'], ''),
    人声处理: 安全取(rawShot, ['mouthAction', '嘴部动作'], '')
  };
  base.负面约束 = 安全取(rawShot, ['negativePrompt', 'negative', '负面约束'], '');

  // v6.7.0: 节奏（新增：五段式）
  base.节奏 = {
    整体: 安全取(rawShot.pacing || {}, ['overall', '整体'], ''),
    开头: 安全取(rawShot.pacing || {}, ['opening', '开头'], ''),
    中段: 安全取(rawShot.pacing || {}, ['middle', '中段'], ''),
    高潮: 安全取(rawShot.pacing || {}, ['climax', '高潮'], ''),
    结尾: 安全取(rawShot.pacing || {}, ['ending', '结尾'], '')
  };

  // v6.7.0: 转场（新增）
  base.转场 = 安全取(rawShot, ['transition', '转场'], '');

  // v6.7.0: 情绪（原情绪阶段）
  base.情绪 = 安全取(rawShot, ['emotion', 'mood', '情绪', '情绪阶段'], '');

  if (!isOpening) {
    base.动作 = 安全取(rawShot, ['action', '动作'], '');
    base.嘴部动作 = 安全取(rawShot, ['mouthAction', 'mouth_action', '嘴部动作'], '');
  }

  base.原始字段 = 深拷贝(rawShot);
  return base;
}

function 校验镜头字段(shotZh) {
  const errors = [];
  const warnings = [];

  if (!是非空字符串(shotZh.镜头编号)) errors.push('缺少【镜头编号】');
  if (!是非空字符串(shotZh.场景名称)) errors.push('缺少【场景名称】');
  if (typeof shotZh.时长 !== 'number' || shotZh.时长 <= 0) errors.push('缺少或非法【时长】');
  if (!是非空字符串(shotZh.时间轴)) errors.push('缺少【时间轴】');
  if (!Array.isArray(shotZh.定妆照)) errors.push('缺少【定妆照】');
  if (!Array.isArray(shotZh.角色一致性)) errors.push('缺少【角色一致性】');

  // v6.7.0: P0致命级检查
  if (!是非空字符串(shotZh.导演指令)) warnings.push('缺少【导演指令】');
  if (!是非空字符串(shotZh.约束)) warnings.push('缺少【约束】');
  if (!是非空字符串(shotZh.基础)) warnings.push('缺少【基础】');
  if (!是非空字符串(shotZh.场景)) warnings.push('缺少【场景】');
  if (!是非空字符串(shotZh.灯光?.描述)) warnings.push('缺少【灯光描述】');
  if (!是非空字符串(shotZh.运镜?.描述)) warnings.push('缺少【运镜描述】');
  if (!是非空字符串(shotZh.角色)) warnings.push('缺少【角色】');
  if (!是非空字符串(shotZh.动作) && shotZh.镜头类型 !== '片头') warnings.push('缺少【动作】');
  if (!是非空字符串(shotZh.负面约束)) warnings.push('缺少【负面约束】');

  // v6.7.0: P1核心级检查
  if (!是非空字符串(shotZh.构图?.景别)) warnings.push('缺少【构图-景别】');
  if (!是非空字符串(shotZh.色彩?.主色调)) warnings.push('缺少【色彩-主色调】');
  if (!是非空字符串(shotZh.景深?.焦点位置)) warnings.push('缺少【景深-焦点位置】');
  if (!是非空字符串(shotZh.情绪)) warnings.push('缺少【情绪】');
  if (!是非空字符串(shotZh.明亮约束)) warnings.push('缺少【明亮约束】');
  if (!是非空字符串(shotZh.角色约束)) warnings.push('缺少【角色约束】');

  if (shotZh.镜头类型 === '片头') {
    if (!是非空字符串(shotZh.主标题)) errors.push('片头缺少【主标题】');
    if (!('副标题' in shotZh)) errors.push('片头缺少【副标题】字段');
    if (!('台词' in shotZh) && !('对话指令' in shotZh)) errors.push('片头缺少【对话指令】或【台词】字段');
  } else {
    if (!('台词' in shotZh) && !('对话指令' in shotZh)) errors.push('内容镜头缺少【对话指令】或【台词】字段');
    if (!('动作' in shotZh)) errors.push('内容镜头缺少【动作】字段');
    if (!('嘴部动作' in shotZh)) warnings.push('内容镜头缺少【嘴部动作】');
  }

  if (!是非空字符串(shotZh.画面提示词)) warnings.push('缺少【画面提示词】');
  if ((shotZh.人物列表 || []).length > 0 && (shotZh.定妆照 || []).length === 0) {
    warnings.push('存在人物但【定妆照】为空');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

function 修复镜头字段(shotZh, options = {}) {
  const fixed = 深拷贝(shotZh);
  const {
    默认主标题 = '',
    默认副标题 = '',
    默认台词 = '',
    默认场景名称 = '未命名场景',
    默认导演指令 = '',
    默认约束 = '',
    默认基础 = '',
    默认场景 = '',
    默认明亮约束 = 'bright lighting, well-lit scene, clear visibility, no dark shadows on face, adequate illumination, face clearly lit',
    默认角色约束 = '',
    默认负面约束 = 'no text, no watermark, no blurry, no extra limbs, deformed, distorted, low quality'
  } = options;

  if (!是非空字符串(fixed.场景名称)) fixed.场景名称 = 默认场景名称;
  if (!是非空字符串(fixed.时间轴)) fixed.时间轴 = 格式化时间轴(0, fixed.时长 || 0);
  if (!Array.isArray(fixed.定妆照)) fixed.定妆照 = [];
  if (!Array.isArray(fixed.角色一致性)) fixed.角色一致性 = [];
  if (!Array.isArray(fixed.人物列表)) fixed.人物列表 = [];

  // v6.7.0: P0字段兜底
  if (!是非空字符串(fixed.导演指令)) fixed.导演指令 = 默认导演指令;
  if (!是非空字符串(fixed.约束)) fixed.约束 = 默认约束;
  if (!是非空字符串(fixed.基础)) fixed.基础 = 默认基础;
  if (!是非空字符串(fixed.场景)) fixed.场景 = 默认场景 || fixed.场景名称 || '';
  if (!是非空字符串(fixed.负面约束)) fixed.负面约束 = 默认负面约束;
  if (!是非空字符串(fixed.明亮约束)) fixed.明亮约束 = 默认明亮约束;
  if (!是非空字符串(fixed.角色约束)) fixed.角色约束 = 默认角色约束;

  // 保留旧字段兼容
  fixed.镜头时间轴 = fixed.时间轴 || fixed.镜头时间轴 || 格式化时间轴(0, fixed.时长 || 0);
  fixed.绑定定妆照 = fixed.定妆照 || fixed.绑定定妆照 || [];
  fixed.人物介绍卡片 = fixed.角色一致性 || fixed.人物介绍卡片 || [];

  if (fixed.镜头类型 === '片头') {
    if (!是非空字符串(fixed.主标题)) fixed.主标题 = 默认主标题;
    if (!('副标题' in fixed) || fixed.副标题 == null) fixed.副标题 = 默认副标题;
    if (!('台词' in fixed) || fixed.台词 == null) fixed.台词 = 默认台词;
  } else {
    if (!('台词' in fixed) || fixed.台词 == null) fixed.台词 = 默认台词;
    if (!('动作' in fixed) || fixed.动作 == null) fixed.动作 = '';
    if (!('嘴部动作' in fixed) || fixed.嘴部动作 == null) fixed.嘴部动作 = '';
  }

  return fixed;
}

function 归一化全片镜头({ openingShot, contentShots = [], charactersMap = {}, defaultTitle = '', defaultSubtitle = '' }) {
  const normalized = [];
  let current = 0;

  if (openingShot) {
    let s00 = 归一化镜头(openingShot, {
      charactersMap,
      globalStartSec: current,
      isOpening: true
    });
    s00 = 修复镜头字段(s00, {
      默认主标题: defaultTitle,
      默认副标题: defaultSubtitle,
      默认台词: ''
    });
    normalized.push(s00);
    current += Number(s00.时长 || 0);
  }

  for (const shot of contentShots) {
    let s = 归一化镜头(shot, {
      charactersMap,
      globalStartSec: current,
      isOpening: false
    });
    s = 修复镜头字段(s, {
      默认台词: '',
      默认场景名称: '内容镜头'
    });
    normalized.push(s);
    current += Number(s.时长 || 0);
  }

  return normalized;
}

// v6.7.0: 新增字段优先级常量
const 字段优先级 = {
  P0: ['导演指令', '约束', '基础', '场景', '灯光', '运镜', '角色', '动作', '台词', '负面约束', '定妆照', '角色一致性'],
  P1: ['构图', '色彩', '景深', '时间轴', '情绪', '明亮约束', '角色约束'],
  P2: ['服装', '道具', '节奏', '音频'],
  P3: ['化妆', '转场']
};

// v6.7.0: 新增字符预算常量
const 字符预算 = {
  导演指令: { min: 50, max: 80, 可压缩: false },
  约束: { min: 100, max: 150, 可压缩: false },
  基础: { min: 80, max: 100, 可压缩: false },
  场景: { min: 150, max: 200, 可压缩: true },
  灯光: { min: 100, max: 150, 可压缩: true },
  运镜: { min: 80, max: 120, 可压缩: true },
  角色: { min: 50, max: 80, 可压缩: true },
  动作: { min: 100, max: 150, 可压缩: true },
  台词: { min: 0, max: 0, 可压缩: false }, // 按实际
  负面约束: { min: 200, max: 300, 可压缩: false },
  定妆照: { min: 0, max: 0, 可压缩: false }, // 系统注入
  角色一致性: { min: 50, max: 80, 可压缩: false },
  构图: { min: 80, max: 120, 可压缩: true },
  色彩: { min: 80, max: 120, 可压缩: true },
  景深: { min: 60, max: 100, 可压缩: true },
  时间轴: { min: 150, max: 200, 可压缩: true },
  情绪: { min: 30, max: 50, 可压缩: true },
  明亮约束: { min: 50, max: 80, 可压缩: false },
  角色约束: { min: 50, max: 80, 可压缩: false },
  服装: { min: 60, max: 100, 可压缩: true },
  道具: { min: 40, max: 80, 可压缩: true },
  节奏: { min: 60, max: 100, 可压缩: true },
  音频: { min: 60, max: 100, 可压缩: true },
  化妆: { min: 40, max: 60, 可压缩: true },
  转场: { min: 30, max: 50, 可压缩: true }
};

const PROMPT_MAX_CHARS = 3000; // v6.7.0: 从1500扩展到3000

module.exports = {
  片头字段模板,
  内容字段模板,
  归一化镜头,
  校验镜头字段,
  修复镜头字段,
  归一化全片镜头,
  // v6.7.0: 新增导出
  字段优先级,
  字符预算,
  PROMPT_MAX_CHARS,
  // 保留旧函数名向后兼容
  构建人物介绍卡片: 构建角色一致性,
  构建绑定定妆照: 构建定妆照
};
