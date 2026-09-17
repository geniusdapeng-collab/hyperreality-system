/**
 * Beast Domain Model — 神兽统一数据模型
 * v1.0: 将分散的异兽数据收敛到单一可信源
 * 
 * 核心原则：
 * 1. 每个神兽必须有canonical ID（小写+下划线，无歧义）
 * 2. 视觉签名(visualSignature)一旦确认不可变
 * 3. 所有模块引用神兽必须通过此Repository
 * 4. 支持从现有数据自动迁移（兼容v23.2 bestiary）
 * 
 * 命名规范：
 * - canonical ID: taotie, qilin, fenghuang, taisu（小写+下划线）
 * - 内部别名: 中文名、拼音、英文名 → 统一映射到canonical ID
 * - 禁止: 大小写混用（TaoTie, Tao-Tie）、连字符（tao-tie）
 */

'use strict';

const { BeastSchema } = require('../schemas/pipeline-schemas.js');

// ============================================================
// 一、神兽数据（兼容现有 + 标准化）
// ============================================================

const BEAST_REGISTRY = {
  // 饕餮 — 永恒饥饿
  taotie: {
    id: 'taotie',
    canonicalName: {
      pinyin: 'taotie',
      chinese: '饕餮',
      english: 'Taotie'
    },
    aliases: ['tao-tie', 'taoTie', 'TaoTie', '饕餮', '贪食'],
    category: 'ferocious_beast',
    source: '《山海经·北次二经》',
    shanhaijingOriginal: '其状如羊身人面，其目在腋下，虎齿人爪，其音如婴儿',
    nirathCore: 'Nirath南半球钩吾废墟的远古战争遗留单位，"永恒饥饿"的法则具象化',
    description: '融合山海经"羊身人面/目在腋下/虎齿人爪"核心特征与Nirath科技废墟美学。肩高30米的巨兽，火山岩装甲覆盖全身，巨口占面部三分之二，双眼生于腋下呈硫磺黄色。不是邪恶，而是贪婪的极致化身。',
    appearance: {
      body: '羊身 — 肩高30米，火山岩装甲覆盖全身如远古战争遗留的单位，山海经羊身=Nirath火山岩装甲',
      head: '人面 — 面部是一张巨大的人脸，庄严而深沉，巨口占面部三分之二，利齿如白玉般交错排列，山海经人面=Nirath法则具象',
      eyes: '目在腋下 — 两团硫磺黄色的眼球在腋窝里缓缓转动，透出温和却令人不安的光芒，山海经目在腋下=Nirath能量传感器',
      legs: '虎齿人爪 — 前肢是人的手掌，五指修长，后肢如羊蹄但有抓握力，山海经虎齿人爪=Nirath多功能肢',
      special: '永恒饥饿的法则具象化，婴儿般的啼哭声既是诱惑也是警示，山海经音如婴儿=Nirath频率共鸣',
      colors: '暗红与硫磺黄交织，火山岩装甲呈黑曜石质感，双眼硫磺黄色如熔岩'
    },
    visualSignature: {
      description: 'Nirath原创异兽饕餮，融合《山海经》羊身人面目在腋下虎齿人爪特征与2147年科技废墟美学，肩高30米火山岩装甲覆盖全身，人面庄严巨口占面部三分之二利齿白玉交错，腋下两团硫磺黄色眼球缓缓转动，前肢人手掌五指修长，永恒饥饿法则具象化，暗红硫磺黄交织黑曜石质感，超写实CG渲染',
      keyFeatures: ['羊身', '人面', '目在腋下', '虎齿人爪', '巨口', '硫磺黄双眼', '火山岩装甲', '30米肩高'],
      colorPalette: ['暗红', '硫磺黄', '黑曜石黑', '白玉白'],
      negativePrompt: 'normal sheep, normal human, cartoon monster, Earth creature, western beast, anime, cute, pet, metal armor, metallic sheen'
    },
    promptTemplate: 'Nirath原创异兽饕餮，融合《山海经》羊身人面目在腋下虎齿人爪特征与2147年科技废墟美学，肩高30米火山岩装甲覆盖全身，人面庄严巨口占面部三分之二利齿白玉交错，腋下两团硫磺黄色眼球缓缓转动，前肢人手掌五指修长，永恒饥饿法则具象化，暗红硫磺黄交织黑曜石质感，超写实CG渲染，{scene}',
    negativePrompt: 'normal sheep, normal human, cartoon monster, Earth creature, western beast, anime, cute, pet, metal armor, metallic sheen',
    lore: {
      summary: '永恒饥饿的寓言——贪欲的极致与克制之道。不是邪恶，而是贪婪的化身。',
      abilities: ['吞噬一切物质与能量', '火山岩装甲免疫物理攻击', '硫磺视线引发恐惧', '婴儿啼哭频率干扰心神'],
      temperament: 'aggressive',
      associatedElements: ['火', '土', '能量吞噬'],
      symbolism: ['贪婪', '欲望', '克制', '警示']
    },
    habitat: {
      primary: 'Nirath南半球钩吾废墟',
      secondary: ['远古战争遗迹', '重金属矿藏区', '熔岩裂缝地带']
    },
    audioSignature: {
      description: '婴儿般的啼哭声，频率如频率共鸣般干扰心神，既像诱惑又像警示',
      suggestedFoley: ['低频震动', '火山岩摩擦声', '硫磺气泡破裂声']
    },
    version: '1.0.0',
    approved: true
  },

  // 旋龟"地图" — 旧世界城市交通网络的拓扑映射
  xuangui: {
    id: 'xuangui',
    canonicalName: {
      pinyin: 'xuangui',
      chinese: '旋龟',
      english: 'Xuan Gui'
    },
    aliases: ['xuan-gui', 'xuanGui', 'map', '地图', '旋龟'],
    category: 'spirit_beast',
    source: '《山海经·南山经》',
    shanhaijingOriginal: '其状如龟而鸟首虺尾，其名曰旋龟，其鸣自叫',
    nirathCore: '旧世界地铁网络拓扑映射，背甲纹路如全息地图',
    description: '融合山海经"龟身鸟首虺尾"特征与Nirath科技废墟美学。背甲上天然生长着复杂纹路——2147年城市交通网络的拓扑映射，旧世界记忆的活体载体。',
    appearance: {
      body: '巨龟身 — 背甲上天然生长着复杂纹路，像地铁线路图般精密交织，龟壳质感如高科技合金装甲，山海经龟身+Nirath科技纹理',
      head: '鸟首 — 尖锐鸟喙如精密探测仪器，头部有发光的导航标记，融合猛禽锋利感与科技感，山海经鸟首+Nirath导航仪器',
      tail: '虺尾 — 蛇形尾巴末端有微弱的光脉闪烁，如数据传输线般流动光芒，山海经虺尾+Nirath光脉',
      special: '旧世界记忆的活体载体，背甲纹路会随环境变化而重新排列，如实时更新的全息地图，山海经"其鸣自叫"对应Nirath导航系统的自动播报',
      colors: '深褐与青绿交织，背甲纹路发出幽蓝微光，如科技废墟中的荧光苔藓'
    },
    visualSignature: {
      description: 'Nirath原创异兽旋龟，融合《山海经》龟身鸟首虺尾特征与2147年科技废墟美学，巨龟身背甲生长复杂地铁网络拓扑纹路如全息地图，鸟首尖锐带发光导航标记如探测仪器，虺尾蛇形末端光脉闪烁如数据传输线，旧世界记忆活体载体，背甲纹路随环境重新排列，深褐青绿交织幽蓝微光',
      keyFeatures: ['龟身', '鸟首', '虺尾', '全息地图背甲', '光脉尾巴', '导航标记'],
      colorPalette: ['深褐', '青绿', '幽蓝'],
      negativePrompt: 'normal turtle, sea turtle, cartoon turtle, Earth turtle, dragon, western creature, cute animal, pet'
    },
    promptTemplate: 'Nirath原创异兽旋龟，融合《山海经》龟身鸟首虺尾特征与2147年科技废墟美学，巨龟身背甲生长复杂地铁网络拓扑纹路如全息地图，鸟首尖锐带发光导航标记如探测仪器，虺尾蛇形末端光脉闪烁如数据传输线，旧世界记忆活体载体，背甲纹路随环境重新排列，深褐青绿交织幽蓝微光，超写实CG渲染，{scene}',
    negativePrompt: 'normal turtle, sea turtle, cartoon turtle, Earth turtle, dragon, western creature, cute animal, pet',
    lore: {
      summary: '旧世界记忆的活体载体，能指引迷失者在Nirath废墟中找到方向。',
      abilities: ['全息地图背甲实时导航', '光脉尾巴数据传输', '旧世界记忆读取', '废墟环境适应'],
      temperament: 'benevolent',
      associatedElements: ['水', '土', '记忆'],
      symbolism: ['记忆', '指引', '历史', '方向']
    },
    habitat: {
      primary: 'Nirath旧世界城市废墟',
      secondary: ['地下地铁网络', '交通节点', '废墟广场']
    },
    version: '1.0.0',
    approved: true
  },

  // 帝江"暖暖" — 2147年巨型恒温系统的残留
  dijiang: {
    id: 'dijiang',
    canonicalName: {
      pinyin: 'dijiang',
      chinese: '帝江',
      english: 'Di Jiang'
    },
    aliases: ['di-jiang', 'diJiang', 'warm', '暖暖', '帝江', '混沌'],
    category: 'divine_beast',
    source: '《山海经·西山经》',
    shanhaijingOriginal: '其状如黄囊，赤如丹火，六足四翼，浑敦无面目，是识歌舞',
    nirathCore: '2147年巨型恒温系统残留，能量体形态',
    description: '融合山海经"黄囊/赤如丹火/无面目"核心特征与Nirath科技美学。暖黄色能量体如一团会呼吸的暖云，没有面孔但能感知情绪，身体温度恒定如旧世界供暖系统。',
    appearance: {
      body: '黄囊状 — 如《山海经》描述的黄色囊袋形态，由暖金色光雾与能量凝聚而成，非实体非生物，边缘半透明消散，山海经"黄囊"=Nirath能量囊',
      face: '无面目 — 浑敦无面目，没有任何五官，光滑能量曲面，身体正中央悬浮金色太阳核心，山海经"无面目"严格还原',
      legs: '六足 — 六条光带从能量体底部自然下垂，呈三排排列（每排2条），绝非腿部足肢，山海经"六足"=Nirath能量流',
      wings: '四翼 — 四片半透明能量翼膜呈十字交叉排列，翼脉如金色叶脉发光，绝非羽毛，山海经"四翼"=Nirath散热鳍片',
      special: '情绪共鸣者，身体温度恒定如旧世界供暖系统，能包裹住小G给予温暖，山海经"是识歌舞"=Nirath情绪共振频率',
      colors: '暖黄色为主（如黄囊），情绪波动时赤如丹火转橙红，金色太阳光芒四射，山海经"赤如丹火"=Nirath过热警报色'
    },
    visualSignature: {
      description: 'Nirath原创异兽帝江暖暖，融合《山海经》黄囊赤如丹火六足四翼浑敦无面目特征与2147年科技恒温系统美学，暖黄色发光能量体如呼吸暖云，无面目光滑能量曲面，六条光带底部下垂三排排列，四片透明能量翼膜十字交叉翼脉金色发光，身体中央金色太阳核心，情绪共鸣温度恒定',
      keyFeatures: ['黄囊状', '无面目', '六足光带', '四翼能量膜', '金色太阳核心', '能量体'],
      colorPalette: ['暖黄', '橙红', '金色', '透明能量'],
      negativePrompt: 'monster with face, creature with eyes, beast with mouth, animal face, sheep, turtle, cartoon cloud, western creature, Earth creature, cute, fluffy'
    },
    promptTemplate: 'Nirath原创异兽帝江暖暖，融合《山海经》黄囊赤如丹火六足四翼浑敦无面目特征与2147年科技恒温系统美学，暖黄色发光能量体如呼吸暖云，无面目光滑能量曲面，六条光带底部下垂三排排列，四片透明能量翼膜十字交叉翼脉金色发光，身体中央金色太阳核心，情绪共鸣温度恒定，超写实CG渲染，{scene}',
    negativePrompt: 'monster with face, creature with eyes, beast with mouth, animal face, sheep, turtle, cartoon cloud, western creature, Earth creature, cute, fluffy',
    lore: {
      summary: '情绪共鸣者，旧世界温暖的最后残留。能感知并回应小G的情绪。',
      abilities: ['情绪共鸣', '温度恒定', '能量包裹', '情绪共振频率'],
      temperament: 'benevolent',
      associatedElements: ['火', '能量', '温暖'],
      symbolism: ['温暖', '陪伴', '情绪', '记忆']
    },
    habitat: {
      primary: 'Nirath废墟中的温暖节点',
      secondary: ['旧世界供暖系统遗迹', '能量富集区', '避难所']
    },
    version: '1.0.0',
    approved: true
  },

  // 白泽"老师" — 人类文明记忆的意识化身
  baize: {
    id: 'baize',
    canonicalName: {
      pinyin: 'baize',
      chinese: '白泽',
      english: 'Bai Ze'
    },
    aliases: ['bai-ze', 'baiZe', 'teacher', '老师', '白泽'],
    category: 'divine_beast',
    source: '《山海经》白泽传说',
    shanhaijingOriginal: '通万物之情，能说人话，王者有德则出',
    nirathCore: '人类文明"记忆雾"凝聚体，数据意识的具象化',
    description: '融合山海经"通万物之情/能说人话"智慧特征与Nirath科技美学。通体雪白，鹿身狮鬃山羊角，双瞳重明。人类文明的全部数据弥散成的"记忆雾"的意识化身。',
    appearance: {
      body: '鹿身 — 优雅鹿形身体，肌肉线条流畅，通体雪白如月光凝成，毛发边缘散发银蓝光晕',
      head: '山羊头 — 头部如山羊，两角弯曲如旧世界天线，角上刻有数据流光纹路',
      mane: '狮鬃 — 颈部环绕浓密雪白鬃毛，如光纤束般发光，每一根都承载记忆片段',
      eyes: '双瞳重明 — 能看穿物质表象直达本质，瞳孔中偶尔闪过数据流光，如两个微型全息投影屏',
      special: '能说人话教小G万物有灵与记录的方法，人类文明记忆雾凝聚体，通万物之情',
      colors: '通体雪白，鬃毛边缘散发银蓝光晕，双瞳中数据流光呈淡金色'
    },
    visualSignature: {
      description: 'Nirath原创异兽白泽老师，融合《山海经》通万物之情能说人话智慧特征与人类文明记忆雾凝聚体，鹿身优雅雪白如月光，山羊头双角弯曲如天线带数据纹路，狮鬃雪白如光纤束发光，双瞳重明瞳孔闪过数据流光如全息屏，教导小G万物有灵，通体雪白银蓝光晕',
      keyFeatures: ['鹿身', '山羊头', '狮鬃', '双瞳重明', '数据流光', '记忆雾'],
      colorPalette: ['雪白', '银蓝', '淡金', '月光白'],
      negativePrompt: 'normal deer, normal goat, normal lion, cartoon creature, Earth animal, western unicorn, western creature, anime, cute pet'
    },
    promptTemplate: 'Nirath原创异兽白泽老师，融合《山海经》通万物之情能说人话智慧特征与人类文明记忆雾凝聚体，鹿身优雅雪白如月光，山羊头双角弯曲如天线带数据纹路，狮鬃雪白如光纤束发光，双瞳重明瞳孔闪过数据流光如全息屏，教导小G万物有灵，通体雪白银蓝光晕，超写实CG渲染，{scene}',
    negativePrompt: 'normal deer, normal goat, normal lion, cartoon creature, Earth animal, western unicorn, western creature, anime, cute pet',
    lore: {
      summary: '人类文明记忆雾凝聚体，教导小G万物有灵与记录的方法。',
      abilities: ['通万物之情', '记忆读取', '数据流光通讯', '知识传授'],
      temperament: 'benevolent',
      associatedElements: ['光', '记忆', '智慧'],
      symbolism: ['智慧', '记忆', '传承', '教导']
    },
    habitat: {
      primary: 'Nirath文明数据中心',
      secondary: ['图书馆废墟', '记忆节点', '知识圣殿']
    },
    version: '1.0.0',
    approved: true
  },

  // 九尾狐长老"奶奶" — 基因库释放的基因样本与植物融合
  jiuweihu: {
    id: 'jiuweihu',
    canonicalName: {
      pinyin: 'jiuweihu',
      chinese: '九尾狐',
      english: 'Jiu Wei Hu'
    },
    aliases: ['jiu-wei-hu', 'jiuWeiHu', 'granny', '奶奶', '九尾狐', '长老'],
    category: 'spirit_beast',
    source: '《山海经·南山经》',
    shanhaijingOriginal: '其状如狐而九尾，其音如婴儿',
    nirathCore: '中央公园基因库释放样本与植物融合的生命',
    description: '融合山海经"狐身九尾"核心特征与Nirath科技美学。九尾狐最古老的智慧种族长老，九条尾巴中三条已变银白。基因库爆炸释放的样本与植物融合诞生的生命。',
    appearance: {
      body: '狐身 — 优雅狐形身体，毛发如发光丝线般柔顺，绝非地球狐狸，山海经狐身+Nirath基因改造',
      head: '狐首 — 尖耳竖立，面部有发光的智慧纹路如电路板图腾，双瞳呈现数据流金色，山海经狐首+Nirath智慧标记',
      tails: '九尾 — 九条尾巴蓬松如发光植物藤蔓，三条已变银白色记载着古老记忆，每条尾巴都有独特光纹，山海经"九尾"=Nirath基因表达',
      special: '最古老智慧种族长老，用尾巴为小G编织光环宣布他为山海之民，山海经"其音如婴儿"=Nirath频率共鸣的空灵声波',
      colors: '银白与深红交织，尾巴如发光藤蔓，老年三条银白尾散发月白光晕'
    },
    visualSignature: {
      description: 'Nirath原创异兽九尾狐长老奶奶，融合《山海经》狐身九尾其音如婴儿特征与基因库样本植物融合生命，狐身优雅毛发如发光丝线，尖耳竖立面部发光智慧纹路如电路板图腾，九尾蓬松如发光藤蔓三条已变银白记载古老记忆，古老智慧种族长老，银白深红交织月白光晕',
      keyFeatures: ['狐身', '狐首', '九尾', '发光藤蔓尾', '银白老年尾', '智慧纹路'],
      colorPalette: ['银白', '深红', '月白', '金色'],
      negativePrompt: 'normal fox, cartoon fox, Earth fox, western kitsune, anime fox, cute furry, pet animal'
    },
    promptTemplate: 'Nirath原创异兽九尾狐长老奶奶，融合《山海经》狐身九尾其音如婴儿特征与基因库样本植物融合生命，狐身优雅毛发如发光丝线，尖耳竖立面部发光智慧纹路如电路板图腾，九尾蓬松如发光藤蔓三条已变银白记载古老记忆，古老智慧种族长老，银白深红交织月白光晕，超写实CG渲染，{scene}',
    negativePrompt: 'normal fox, cartoon fox, Earth fox, western kitsune, anime fox, cute furry, pet animal',
    lore: {
      summary: '最古老智慧种族长老，用尾巴为小G编织光环宣布他为山海之民。',
      abilities: ['九尾编织光环', '基因记忆读取', '频率共鸣', '智慧传承'],
      temperament: 'benevolent',
      associatedElements: ['木', '基因', '记忆'],
      symbolism: ['智慧', '传承', '认可', '长者']
    },
    habitat: {
      primary: 'Nirath中央公园基因库',
      secondary: ['基因富集区', '植物融合带', '古老森林']
    },
    version: '1.0.0',
    approved: true
  },

  // 烛龙"太素之眼" — 太素机制的直接显化
  zhulong: {
    id: 'zhulong',
    canonicalName: {
      pinyin: 'zhulong',
      chinese: '烛龙',
      english: 'Zhu Long'
    },
    aliases: ['zhu-long', 'zhuLong', 'taisu', '太素', '烛龙', '烛阴'],
    category: 'divine_beast',
    source: '《山海经·大荒北经》',
    shanhaijingOriginal: '钟山之神，名曰烛阴，视为昼，瞑为夜',
    nirathCore: '太素机制的直接显化，宇宙法则的具象',
    description: '融合山海经"烛阴/视为昼瞑为夜"核心特征与Nirath科技美学。幽蓝色蛇身无翼无爪，表面星尘纹理与电路板纹路交织。双瞳奇点：左眼睁开时光子风暴照亮Nirath，右眼闭合时黑暗降临。太素机制的直接显化——不是生物，是宇宙法则的具象。',
    appearance: {
      body: '幽蓝色蛇身 — 无翼无爪如《山海经》烛阴，表面星尘纹理与电路板纹路交织如宇宙法则具象化，山海经蛇身+Nirath法则纹理',
      eyes: '双瞳奇点 — 左眼睁开时光子风暴照亮Nirath（视为昼），右眼闭合时黑暗降临（瞑为夜），瞳孔如黑洞般深邃，山海经"烛阴"=Nirath太素之眼',
      special: '太素机制直接显化，宇宙法则具象，不食不寝不息，钟山之神威压震慑万物，山海经"钟山之神"=Nirath太素核心',
      colors: '幽蓝色为主，纹理散发银白光晕，双瞳睁开时呈炽白，闭合时呈绝对漆黑，山海经"视为昼瞑为夜"=Nirath光暗双态'
    },
    visualSignature: {
      description: 'Nirath原创异兽烛龙太素之眼，融合《山海经》钟山之神烛阴视为昼瞑为夜特征与太素机制显化，幽蓝色蛇身无翼无爪，表面星尘纹理电路板纹路交织，双瞳奇点左眼睁开光子风暴照亮Nirath右眼闭合黑暗降临，宇宙法则具象不食不寝不息，钟山之神威压，幽蓝银白炽白绝对漆黑',
      keyFeatures: ['蛇身', '无翼无爪', '双瞳奇点', '星尘纹理', '电路板纹路', '太素机制'],
      colorPalette: ['幽蓝', '银白', '炽白', '绝对漆黑'],
      negativePrompt: 'normal dragon, western dragon, western creature, Earth creature, cartoon dragon, anime dragon, cute, wings, claws'
    },
    promptTemplate: 'Nirath原创异兽烛龙太素之眼，融合《山海经》钟山之神烛阴视为昼瞑为夜特征与太素机制显化，幽蓝色蛇身无翼无爪，表面星尘纹理电路板纹路交织，双瞳奇点左眼睁开光子风暴照亮Nirath右眼闭合黑暗降临，宇宙法则具象不食不寝不息，钟山之神威压，幽蓝银白炽白绝对漆黑，超写实CG渲染，{scene}',
    negativePrompt: 'normal dragon, western dragon, western creature, Earth creature, cartoon dragon, anime dragon, cute, wings, claws',
    lore: {
      summary: '太素机制的直接显化，不是生物，是宇宙法则的具象。钟山之神威压震慑万物。',
      abilities: ['视为昼瞑为夜', '光子风暴', '黑暗降临', '太素法则', '宇宙法则具象'],
      temperament: 'unpredictable',
      associatedElements: ['太素', '光', '暗', '宇宙法则'],
      symbolism: ['法则', '秩序', '宇宙', '威压', '神性']
    },
    habitat: {
      primary: 'Nirath钟山（太素核心）',
      secondary: ['宇宙法则节点', '太素能量源', '维度边界']
    },
    version: '1.0.0',
    approved: true
  }
};

// ============================================================
// 二、Beast Repository — 统一访问接口
// ============================================================

class BeastRepository {
  constructor() {
    this.beasts = new Map();     // canonicalId -> beastData
    this.indexByName = new Map(); // 所有名字变体 -> canonicalId
    this.indexByCategory = new Map(); // category -> Set<canonicalId>
    this.indexByAlias = new Map(); // alias -> canonicalId
    
    this.init();
  }

  init() {
    // 加载注册表
    for (const [id, beast] of Object.entries(BEAST_REGISTRY)) {
      this.register(beast);
    }
    console.log(`[BeastRepository] 初始化完成，已注册 ${this.beasts.size} 只神兽`);
  }

  /**
   * 注册神兽（带验证）
   */
  register(beastData) {
    // 验证
    const result = BeastSchema.validate(beastData);
    if (!result.valid) {
      console.warn(`[BeastRepository] 注册警告 ${beastData.id}: ${result.errors.join('; ')}`);
      // 不阻断，记录警告
    }

    const id = beastData.id;
    this.beasts.set(id, beastData);

    // 索引所有名字变体
    this.indexByName.set(id, id); // canonical ID
    this.indexByName.set(beastData.canonicalName.pinyin.toLowerCase(), id);
    if (beastData.canonicalName.chinese) {
      this.indexByName.set(beastData.canonicalName.chinese, id);
    }
    this.indexByName.set(beastData.canonicalName.english.toLowerCase(), id);

    // 索引别名
    for (const alias of (beastData.aliases || [])) {
      this.indexByAlias.set(alias.toLowerCase(), id);
    }

    // 索引分类
    const category = beastData.category;
    if (!this.indexByCategory.has(category)) {
      this.indexByCategory.set(category, new Set());
    }
    this.indexByCategory.get(category).add(id);

    return beastData;
  }

  /**
   * 通过canonical ID查找（O(1)）
   */
  findById(id) {
    return this.beasts.get(id) || null;
  }

  /**
   * 通过任意名字查找（支持别名、大小写不敏感）
   */
  findByName(name) {
    if (!name) return null;
    const normalized = name.toLowerCase().trim();

    // 直接匹配
    if (this.beasts.has(normalized)) return this.beasts.get(normalized);

    // 名字索引
    const byName = this.indexByName.get(normalized);
    if (byName) return this.beasts.get(byName);

    // 别名索引
    const byAlias = this.indexByAlias.get(normalized);
    if (byAlias) return this.beasts.get(byAlias);

    // 模糊匹配（包含关系）
    for (const [alias, id] of this.indexByAlias) {
      if (alias.includes(normalized) || normalized.includes(alias)) {
        return this.beasts.get(id);
      }
    }

    return null;
  }

  /**
   * 通过分类查找
   */
  findByCategory(category) {
    const ids = this.indexByCategory.get(category) || new Set();
    return [...ids].map(id => this.beasts.get(id)).filter(Boolean);
  }

  /**
   * 获取所有神兽
   */
  getAll() {
    return [...this.beasts.values()];
  }

  /**
   * 获取已注册ID列表
   */
  listIds() {
    return [...this.beasts.keys()];
  }

  /**
   * 将任意输入解析为canonical ID
   */
  resolveCanonicalId(input) {
    if (!input) return null;

    // 已经是canonical ID
    if (this.beasts.has(input)) return input;

    // 查找
    const beast = this.findByName(input);
    return beast ? beast.id : null;
  }

  /**
   * 获取视觉签名（用于Prompt注入）
   * 这是最关键的方法 — 确保所有模块使用统一的视觉描述
   */
  getVisualSignaturePrompt(beastIdOrName) {
    const id = this.resolveCanonicalId(beastIdOrName);
    if (!id) return null;

    const beast = this.beasts.get(id);
    if (!beast || !beast.visualSignature) return null;

    const vs = beast.visualSignature;
    const parts = [
      `[Creature: ${beast.canonicalName.english}]`,
      vs.description
    ];

    if (vs.keyFeatures && vs.keyFeatures.length > 0) {
      parts.push(`Key features: ${vs.keyFeatures.join(', ')}`);
    }
    if (vs.colorPalette && vs.colorPalette.length > 0) {
      parts.push(`Color palette: ${vs.colorPalette.join(', ')}`);
    }
    if (vs.negativePrompt) {
      parts.push(`[Exclude: ${vs.negativePrompt}]`);
    }

    return parts.join('. ');
  }

  /**
   * 获取Prompt模板（带场景占位符替换）
   */
  getPromptTemplate(beastIdOrName, scene = '') {
    const id = this.resolveCanonicalId(beastIdOrName);
    if (!id) return null;

    const beast = this.beasts.get(id);
    if (!beast || !beast.promptTemplate) return null;

    return beast.promptTemplate.replace(/\{scene\}/g, scene);
  }

  /**
   * 获取负面提示词
   */
  getNegativePrompt(beastIdOrName) {
    const id = this.resolveCanonicalId(beastIdOrName);
    if (!id) return null;

    const beast = this.beasts.get(id);
    return beast ? beast.negativePrompt || null : null;
  }

  /**
   * 获取神兽 lore 摘要
   */
  getLoreSummary(beastIdOrName) {
    const id = this.resolveCanonicalId(beastIdOrName);
    if (!id) return null;

    const beast = this.beasts.get(id);
    return beast ? beast.lore?.summary || null : null;
  }

  /**
   * 获取栖息地信息
   */
  getHabitat(beastIdOrName) {
    const id = this.resolveCanonicalId(beastIdOrName);
    if (!id) return null;

    const beast = this.beasts.get(id);
    return beast ? beast.habitat || null : null;
  }

  /**
   * 批量获取（用于批量渲染）
   */
  getBatch(ids) {
    return ids.map(id => this.findById(id) || this.findByName(id)).filter(Boolean);
  }

  /**
   * 搜索（模糊匹配）
   */
  search(query) {
    if (!query) return [];
    const normalized = query.toLowerCase();
    const results = [];

    for (const beast of this.beasts.values()) {
      let score = 0;

      // 名字匹配
      if (beast.canonicalName.pinyin.toLowerCase().includes(normalized)) score += 3;
      if (beast.canonicalName.english.toLowerCase().includes(normalized)) score += 3;
      if (beast.canonicalName.chinese && beast.canonicalName.chinese.includes(normalized)) score += 3;

      // 别名匹配
      for (const alias of (beast.aliases || [])) {
        if (alias.toLowerCase().includes(normalized)) score += 2;
      }

      // 描述匹配
      if (beast.description && beast.description.toLowerCase().includes(normalized)) score += 1;
      if (beast.lore?.summary && beast.lore.summary.toLowerCase().includes(normalized)) score += 1;

      if (score > 0) {
        results.push({ beast, score });
      }
    }

    return results.sort((a, b) => b.score - a.score);
  }

  /**
   * 兼容性：从旧版bestiary迁移
   */
  migrateFromLegacy(legacyData) {
    const migrated = [];

    for (const [legacyId, data] of Object.entries(legacyData)) {
      // 尝试解析canonical ID
      const canonicalId = this.resolveCanonicalId(legacyId) || legacyId.toLowerCase().replace(/[-\s]/g, '');

      const existing = this.beasts.get(canonicalId);
      if (existing) {
        console.log(`[BeastRepository] 已存在 ${canonicalId}，跳过迁移`);
        continue;
      }

      // 创建标准格式
      const beast = {
        id: canonicalId,
        canonicalName: {
          pinyin: legacyId,
          chinese: data.name?.replace(/[（(].*?[)）]/g, '') || legacyId,
          english: legacyId
        },
        aliases: [legacyId],
        category: 'hybrid_beast', // 默认分类，需人工确认
        source: data.source || '《山海经》+ Nirath',
        shanhaijingOriginal: data.shanhaijingOriginal || '',
        nirathCore: data.nirathCore || '',
        description: data.description || '',
        appearance: data.appearance || {},
        visualSignature: {
          description: data.description || '',
          keyFeatures: Object.values(data.appearance || {}).filter(v => typeof v === 'string'),
          colorPalette: (data.appearance?.colors || '').split(/[,，]/).map(s => s.trim()).filter(Boolean),
          negativePrompt: data.negativePrompt || ''
        },
        promptTemplate: data.promptTemplate || '',
        negativePrompt: data.negativePrompt || '',
        lore: {
          summary: data.description || '',
          abilities: [],
          temperament: 'neutral'
        },
        habitat: data.habitat || { primary: 'Nirath' },
        version: '1.0.0-migrated',
        approved: false // 迁移后需人工确认
      };

      this.register(beast);
      migrated.push(canonicalId);
    }

    return migrated;
  }

  /**
   * 统计信息
   */
  getStats() {
    const categories = {};
    for (const [cat, ids] of this.indexByCategory) {
      categories[cat] = ids.size;
    }

    return {
      total: this.beasts.size,
      categories,
      approved: [...this.beasts.values()].filter(b => b.approved).length,
      byNameIndex: this.indexByName.size,
      byAliasIndex: this.indexByAlias.size
    };
  }
}

// ============================================================
// 三、单例导出
// ============================================================

let instance = null;

function getBeastRepository() {
  if (!instance) {
    instance = new BeastRepository();
  }
  return instance;
}

function resetBeastRepository() {
  instance = null;
}

// 向后兼容：兼容旧版 Bestiary 接口
class Bestiary {
  constructor() {
    this.repo = getBeastRepository();
  }

  getCreature(id) {
    return this.repo.findById(id) || this.repo.findByName(id) || this.repo.findById('default');
  }

  getBeast(id) {
    return this.getCreature(id);
  }

  listCreatures() {
    return this.repo.listIds();
  }

  searchByLocation(location) {
    return this.repo.getAll().map(b => b.id);
  }
}

module.exports = {
  BeastRepository,
  getBeastRepository,
  resetBeastRepository,
  Bestiary,           // 向后兼容
  BEAST_REGISTRY
};
