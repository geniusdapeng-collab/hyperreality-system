#!/usr/bin/env node
/**
 * 【系统级】山海经系列节奏模板库 v1.0
 * 
 * 职责：
 * 1. 将五段式节奏控制固化为导演系统的标准节奏模块
 * 2. 为每种情绪类型提供标准节奏模板
 * 3. 新剧集生成时自动注入节奏模板，无需人工配置
 * 
 * 五段式节奏定义（基于FPV经验包提炼）：
 * Phase 1: 爆发启动（0-1秒）— 突然启动，打破静止
 * Phase 2: 擦碰穿梭（1-5秒）— 穿越微观世界，建立空间认知
 * Phase 3: 加速混乱（5-7秒）— 速度提升，空间扭曲
 * Phase 4: 终极动作（7-9秒）— 高潮爆发，视觉奇观
 * Phase 5: 戛然而止（9-10秒）— 突然制动，余韵留存
 * 
 * 调用时机：导演系统生成剧集计划时，自动注入节奏模板
 */

// ========== 五段式节奏模板库 ==========
const RHYTHM_TEMPLATES = {
  // 模板元数据
  metadata: {
    name: '山海经系列节奏模板库',
    version: '1.0',
    lastUpdated: '2026-05-22',
    totalTemplates: 6,
    rhythmDefinition: '五段式节奏控制（爆发→擦碰→加速→终极→戛然而止）'
  },

  // 五段式节奏定义（时间轴标准）
  fivePhaseRhythm: {
    name: 'FPV五段式标准节奏',
    description: '基于FPV穿越机实战提炼的15秒标准节奏',
    totalDuration: 15,
    phases: [
      {
        name: '爆发启动',
        timeRange: '0-2秒',
        duration: 2,
        description: '突然启动，打破静止，从0到100的瞬间爆发力',
        camera: '急速推轨/猛然拉升/突然下坠',
        speed: '从静止到极限速度的瞬间变化',
        sound: '启动瞬间的破空声/环境突然激活',
        emotionalImpact: '肾上腺素瞬间飙升，观众被猛然拉入'
      },
      {
        name: '擦碰穿梭',
        timeRange: '2-8秒',
        duration: 6,
        description: '穿越微观世界，与物体擦身而过，建立空间认知',
        camera: '近距离擦碰物体表面，贴地/贴墙飞行',
        speed: '中等速度，强调贴靠感而非距离感',
        sound: '物体表面擦过的摩擦声/气流声',
        emotionalImpact: '紧张感建立，空间尺度感形成'
      },
      {
        name: '加速混乱',
        timeRange: '8-11秒',
        duration: 3,
        description: '速度提升，空间开始扭曲，环境进入动态混乱',
        camera: '加速推进，景别快速变化，边缘畸变加剧',
        speed: '持续加速，接近极限',
        sound: '风声加剧，环境音混杂',
        emotionalImpact: '失控感与兴奋感交织，临界点迫近'
      },
      {
        name: '终极动作',
        timeRange: '11-14秒',
        duration: 3,
        description: '高潮爆发，视觉奇观呈现，情绪达到顶点',
        camera: '终极动作执行（穿越/俯冲/跃升/爆炸）',
        speed: '极限速度，动态模糊最大化',
        sound: '高潮音效（爆炸/能量释放/终极环境音）',
        emotionalImpact: '情绪顶点，肾上腺素峰值'
      },
      {
        name: '戛然而止',
        timeRange: '14-15秒',
        duration: 1,
        description: '突然制动，画面定格，余韵留存',
        camera: '突然停止/急停/悬停，画面定格',
        speed: '从极限速度到静止的瞬间',
        sound: '突然安静，只剩环境余音',
        emotionalImpact: '余韵悠长，回味无穷'
      }
    ]
  },

  // 按情绪类型的节奏模板
  emotionRhythms: {
    // 温暖/初见 — 柔和启动，渐进式节奏
    '温暖': {
      name: '温暖渐进式',
      description: '适合初见、温馨、治愈场景',
      baseTemplate: 'fivePhaseRhythm',
      modifications: {
        '爆发启动': { speed: '柔和启动，非爆发', camera: '缓慢推轨' },
        '擦碰穿梭': { speed: '优雅穿越', camera: '丝滑贴靠' },
        '加速混乱': { speed: '轻微加速', camera: '渐进拉升' },
        '终极动作': { speed: '温暖高潮', camera: '绽放式展开' },
        '戛然而止': { speed: '温柔停驻', camera: '缓缓定格' }
      }
    },

    // 神秘/探索 — 悬疑启动，探索式节奏
    '神秘': {
      name: '悬疑探索式',
      description: '适合探索、发现、未知场景',
      baseTemplate: 'fivePhaseRhythm',
      modifications: {
        '爆发启动': { speed: '突然惊醒', camera: '猛然抬头' },
        '擦碰穿梭': { speed: '谨慎穿越', camera: '贴墙探索' },
        '加速混乱': { speed: '加速发现', camera: '推进揭秘' },
        '终极动作': { speed: '真相揭露', camera: '全景展开' },
        '戛然而止': { speed: '发现定格', camera: '悬停凝视' }
      }
    },

    // 末日/史诗 — 爆发启动，史诗式节奏
    '末日': {
      name: '末日史诗式',
      description: '适合灾难、史诗、敬畏场景',
      baseTemplate: 'fivePhaseRhythm',
      modifications: {
        '爆发启动': { speed: '爆炸启动', camera: '冲击波推动' },
        '擦碰穿梭': { speed: '穿越碎片', camera: '擦碰废墟' },
        '加速混乱': { speed: '混乱加速', camera: '扭曲空间' },
        '终极动作': { speed: '终极灾难', camera: '毁灭高潮' },
        '戛然而止': { speed: '毁灭定格', camera: '废墟悬停' }
      }
    },

    // 战斗/对抗 — 爆发启动，战斗式节奏
    '战斗': {
      name: '战斗爆发式',
      description: '适合对抗、追逐、战斗场景',
      baseTemplate: 'fivePhaseRhythm',
      modifications: {
        '爆发启动': { speed: '爆发冲刺', camera: '猛然追击' },
        '擦碰穿梭': { speed: '闪避穿越', camera: '侧身擦碰' },
        '加速混乱': { speed: '战况加剧', camera: '旋转混乱' },
        '终极动作': { speed: '决胜一击', camera: '终极碰撞' },
        '戛然而止': { speed: '胜负定格', camera: '悬停对峙' }
      }
    },

    // 激烈 — 爆发启动，战斗式节奏（战斗的近义词）
    '激烈': {
      name: '激烈爆发式',
      description: '适合对抗、冲突、高潮场景',
      baseTemplate: 'fivePhaseRhythm',
      modifications: {
        '爆发启动': { speed: '爆发冲刺', camera: '猛然追击' },
        '擦碰穿梭': { speed: '闪避穿越', camera: '侧身擦碰' },
        '加速混乱': { speed: '战况加剧', camera: '旋转混乱' },
        '终极动作': { speed: '决胜一击', camera: '终极碰撞' },
        '戛然而止': { speed: '胜负定格', camera: '悬停对峙' }
      }
    },

    // 飞翔/自由 — 柔和启动，飞翔式节奏
    '自由': {
      name: '飞翔自由式',
      description: '适合飞行、翱翔、自由场景',
      baseTemplate: 'fivePhaseRhythm',
      modifications: {
        '爆发启动': { speed: '起飞启动', camera: '猛然拉升' },
        '擦碰穿梭': { speed: '穿越云层', camera: '贴云飞行' },
        '加速混乱': { speed: '加速翱翔', camera: '螺旋上升' },
        '终极动作': { speed: '俯瞰高潮', camera: '极限高度' },
        '戛然而止': { speed: '悬停定格', camera: '云端停驻' }
      }
    },

    // 悲伤/离别 — 缓慢启动，沉郁式节奏
    '悲伤': {
      name: '沉郁离别式',
      description: '适合离别、失去、追忆场景',
      baseTemplate: 'fivePhaseRhythm',
      modifications: {
        '爆发启动': { speed: '沉郁启动', camera: '缓慢下沉' },
        '擦碰穿梭': { speed: '穿越回忆', camera: '模糊擦碰' },
        '加速混乱': { speed: '加速流逝', camera: '时间扭曲' },
        '终极动作': { speed: '离别高潮', camera: '远去定格' },
        '戛然而止': { speed: '空寂停驻', camera: '虚无悬停' }
      }
    },

    // 敬畏 — 神圣启动，崇高式节奏
    '敬畏': {
      name: '敬畏崇高式',
      description: '适合神圣、庄严、史诗场景',
      baseTemplate: 'fivePhaseRhythm',
      modifications: {
        '爆发启动': { speed: '神圣启动', camera: '缓缓升起' },
        '擦碰穿梭': { speed: '庄严穿越', camera: '仰视推进' },
        '加速混乱': { speed: '崇高加速', camera: '螺旋上升' },
        '终极动作': { speed: '史诗高潮', camera: '全景展开' },
        '戛然而止': { speed: '神圣定格', camera: '云端停驻' }
      }
    },

    // 惊奇 — 发现启动，探索式节奏
    '惊奇': {
      name: '惊奇发现式',
      description: '适合探索、发现、惊叹场景',
      baseTemplate: 'fivePhaseRhythm',
      modifications: {
        '爆发启动': { speed: '突然惊醒', camera: '猛然抬头' },
        '擦碰穿梭': { speed: '好奇穿越', camera: '贴墙探索' },
        '加速混乱': { speed: '发现加速', camera: '推进揭秘' },
        '终极动作': { speed: '惊叹高潮', camera: '奇观展开' },
        '戛然而止': { speed: '发现定格', camera: '悬停凝视' }
      }
    },

    // 震撼 — 爆发启动，冲击式节奏
    '震撼': {
      name: '震撼冲击式',
      description: '适合冲击、爆发、力量场景',
      baseTemplate: 'fivePhaseRhythm',
      modifications: {
        '爆发启动': { speed: '爆炸启动', camera: '冲击波推动' },
        '擦碰穿梭': { speed: '冲击穿越', camera: '擦碰废墟' },
        '加速混乱': { speed: '力量加速', camera: '扭曲空间' },
        '终极动作': { speed: '力量高潮', camera: '毁灭爆发' },
        '戛然而止': { speed: '冲击定格', camera: '废墟悬停' }
      }
    },

    // 庄严 — 神圣启动，崇高式节奏
    '庄严': {
      name: '庄严神圣式',
      description: '适合庄严、神圣、肃穆场景',
      baseTemplate: 'fivePhaseRhythm',
      modifications: {
        '爆发启动': { speed: '肃穆启动', camera: '缓缓升起' },
        '擦碰穿梭': { speed: '庄严穿越', camera: '仰视推进' },
        '加速混乱': { speed: '崇高加速', camera: '螺旋上升' },
        '终极动作': { speed: '神圣高潮', camera: '全景展开' },
        '戛然而止': { speed: '庄严定格', camera: '云端停驻' }
      }
    },

    // 悠远 — 缓慢启动，沉淀式节奏
    '悠远': {
      name: '悠远沉淀式',
      description: '适合沉淀、回味、悠远场景',
      baseTemplate: 'fivePhaseRhythm',
      modifications: {
        '爆发启动': { speed: '缓慢启动', camera: '缓缓推轨' },
        '擦碰穿梭': { speed: '沉淀穿越', camera: '优雅掠过' },
        '加速混乱': { speed: '轻微加速', camera: '渐进拉升' },
        '终极动作': { speed: '回味高潮', camera: '绽放式展开' },
        '戛然而止': { speed: '沉淀定格', camera: '缓缓停驻' }
      }
    },

    // 平静 — 宁静启动，平和式节奏
    '平静': {
      name: '平静宁和式',
      description: '适合平静、安宁、日常场景',
      baseTemplate: 'fivePhaseRhythm',
      modifications: {
        '爆发启动': { speed: '宁静启动', camera: '缓缓推轨' },
        '擦碰穿梭': { speed: '平和穿越', camera: '优雅掠过' },
        '加速混乱': { speed: '轻微加速', camera: '渐进拉升' },
        '终极动作': { speed: '宁静高潮', camera: '绽放式展开' },
        '戛然而止': { speed: '平和定格', camera: '缓缓停驻' }
      }
    },

    // 好奇 — 探索启动，发现式节奏
    '好奇': {
      name: '好奇探索式',
      description: '适合好奇、探索、求知场景',
      baseTemplate: 'fivePhaseRhythm',
      modifications: {
        '爆发启动': { speed: '探索启动', camera: '抬头仰望' },
        '擦碰穿梭': { speed: '好奇穿越', camera: '贴墙探索' },
        '加速混乱': { speed: '求知加速', camera: '推进揭秘' },
        '终极动作': { speed: '发现高潮', camera: '奇观展开' },
        '戛然而止': { speed: '探索定格', camera: '悬停凝视' }
      }
    },

    // 紧张 — 紧绷启动，对抗式节奏
    '紧张': {
      name: '紧张紧绷式',
      description: '适合紧张、对抗、追逐场景',
      baseTemplate: 'fivePhaseRhythm',
      modifications: {
        '爆发启动': { speed: '紧绷启动', camera: '猛然追击' },
        '擦碰穿梭': { speed: '闪避穿越', camera: '侧身擦碰' },
        '加速混乱': { speed: '战况加剧', camera: '旋转混乱' },
        '终极动作': { speed: '决胜高潮', camera: '终极碰撞' },
        '戛然而止': { speed: '胜负定格', camera: '悬停对峙' }
      }
    },

    // 顿悟 — 觉醒启动，升华式节奏
    '顿悟': {
      name: '顿悟觉醒式',
      description: '适合顿悟、觉醒、升华场景',
      baseTemplate: 'fivePhaseRhythm',
      modifications: {
        '爆发启动': { speed: '觉醒启动', camera: '猛然睁眼' },
        '擦碰穿梭': { speed: '洞察穿越', camera: '推进揭秘' },
        '加速混乱': { speed: '认知加速', camera: '思维扭曲' },
        '终极动作': { speed: '顿悟高潮', camera: '光芒展开' },
        '戛然而止': { speed: '觉醒定格', camera: '悬停凝视' }
      }
    },

    // 回味 — 余韵启动，悠长式节奏
    '回味': {
      name: '回韵悠长式',
      description: '适合回味、余韵、沉淀场景',
      baseTemplate: 'fivePhaseRhythm',
      modifications: {
        '爆发启动': { speed: '余韵启动', camera: '缓缓推轨' },
        '擦碰穿梭': { speed: '回味穿越', camera: '优雅掠过' },
        '加速混乱': { speed: '思绪加速', camera: '渐进拉升' },
        '终极动作': { speed: '回味高潮', camera: '绽放式展开' },
        '戛然而止': { speed: '余韵定格', camera: '缓缓停驻' }
      }
    },

    // 压抑 — 沉重启动，挣扎式节奏
    '压抑': {
      name: '压抑沉重式',
      description: '适合压抑、沉重、困顿场景',
      baseTemplate: 'fivePhaseRhythm',
      modifications: {
        '爆发启动': { speed: '沉重启动', camera: '缓慢下沉' },
        '擦碰穿梭': { speed: '压抑穿越', camera: '贴地爬行' },
        '加速混乱': { speed: '挣扎加速', camera: '扭曲翻滚' },
        '终极动作': { speed: '爆发高潮', camera: '冲破束缚' },
        '戛然而止': { speed: '释放定格', camera: '悬停喘息' }
      }
    },

    // 渴望 — 期盼启动，向往式节奏
    '渴望': {
      name: '渴望向往式',
      description: '适合渴望、向往、追求场景',
      baseTemplate: 'fivePhaseRhythm',
      modifications: {
        '爆发启动': { speed: '期盼启动', camera: '抬头仰望' },
        '擦碰穿梭': { speed: '追寻穿越', camera: '推进攀爬' },
        '加速混乱': { speed: '渴望加速', camera: '螺旋上升' },
        '终极动作': { speed: '达成高潮', camera: '光芒展开' },
        '戛然而止': { speed: '满足定格', camera: '悬停凝视' }
      }
    },

    // 痛苦 — 挣扎启动，撕裂式节奏
    '痛苦': {
      name: '痛苦撕裂式',
      description: '适合痛苦、挣扎、蜕变场景',
      baseTemplate: 'fivePhaseRhythm',
      modifications: {
        '爆发启动': { speed: '撕裂启动', camera: '猛然扭曲' },
        '擦碰穿梭': { speed: '挣扎穿越', camera: '翻滚擦碰' },
        '加速混乱': { speed: '痛苦加速', camera: '空间撕裂' },
        '终极动作': { speed: '蜕变高潮', camera: '冲破极限' },
        '戛然而止': { speed: '蜕变定格', camera: '悬停喘息' }
      }
    },

    // 解放 — 释放启动，自由式节奏
    '解放': {
      name: '解放自由式',
      description: '适合解放、释放、突破场景',
      baseTemplate: 'fivePhaseRhythm',
      modifications: {
        '爆发启动': { speed: '释放启动', camera: '猛然拉升' },
        '擦碰穿梭': { speed: '自由穿越', camera: '贴云飞行' },
        '加速混乱': { speed: '解放加速', camera: '螺旋上升' },
        '终极动作': { speed: '自由高潮', camera: '俯瞰绽放' },
        '戛然而止': { speed: '自由定格', camera: '云端停驻' }
      }
    },

    // 悲壮 — 沉重启动，史诗式节奏
    '悲壮': {
      name: '悲壮史诗式',
      description: '适合悲壮、牺牲、史诗场景',
      baseTemplate: 'fivePhaseRhythm',
      modifications: {
        '爆发启动': { speed: '悲壮启动', camera: '缓慢下沉' },
        '擦碰穿梭': { speed: '牺牲穿越', camera: '沉重掠过' },
        '加速混乱': { speed: '命运加速', camera: '时间扭曲' },
        '终极动作': { speed: '牺牲高潮', camera: '远去定格' },
        '戛然而止': { speed: '悲壮定格', camera: '空寂悬停' }
      }
    },

    // 沉思 — 静默启动，思考式节奏
    '沉思': {
      name: '沉思静默式',
      description: '适合沉思、反思、沉淀场景',
      baseTemplate: 'fivePhaseRhythm',
      modifications: {
        '爆发启动': { speed: '静默启动', camera: '缓缓推轨' },
        '擦碰穿梭': { speed: '思考穿越', camera: '优雅掠过' },
        '加速混乱': { speed: '思绪加速', camera: '渐进拉升' },
        '终极动作': { speed: '顿悟高潮', camera: '绽放式展开' },
        '戛然而止': { speed: '沉思定格', camera: '缓缓停驻' }
      }
    },

    // 欢乐 — 轻快启动，活力式节奏
    '欢乐': {
      name: '欢乐活力式',
      description: '适合欢乐、生机、祥和场景',
      baseTemplate: 'fivePhaseRhythm',
      modifications: {
        '爆发启动': { speed: '轻快启动', camera: '跳跃升起' },
        '擦碰穿梭': { speed: '欢乐穿越', camera: '灵动掠过' },
        '加速混乱': { speed: '活力加速', camera: '螺旋飞舞' },
        '终极动作': { speed: '欢乐高潮', camera: '绽放式展开' },
        '戛然而止': { speed: '活力定格', camera: '灵动停驻' }
      }
    },

    // 感动 — 深情启动，温暖式节奏
    '感动': {
      name: '感动温暖式',
      description: '适合感动、温情、共鸣场景',
      baseTemplate: 'fivePhaseRhythm',
      modifications: {
        '爆发启动': { speed: '深情启动', camera: '缓缓推轨' },
        '擦碰穿梭': { speed: '温暖穿越', camera: '贴近掠过' },
        '加速混乱': { speed: '情感加速', camera: '渐进拉升' },
        '终极动作': { speed: '感动高潮', camera: '绽放式展开' },
        '戛然而止': { speed: '温情定格', camera: '缓缓停驻' }
      }
    },

    // 生机 — 活力启动，生长式节奏
    '生机': {
      name: '生机生长式',
      description: '适合生机、成长、希望场景',
      baseTemplate: 'fivePhaseRhythm',
      modifications: {
        '爆发启动': { speed: '萌芽启动', camera: '破土而出' },
        '擦碰穿梭': { speed: '生长穿越', camera: '向上攀爬' },
        '加速混乱': { speed: '生机加速', camera: '螺旋上升' },
        '终极动作': { speed: '绽放高潮', camera: '向阳展开' },
        '戛然而止': { speed: '生机定格', camera: '摇曳停驻' }
      }
    },

    // 祥和 — 宁静启动，和谐式节奏
    '祥和': {
      name: '祥和宁静式',
      description: '适合祥和、宁静、和谐场景',
      baseTemplate: 'fivePhaseRhythm',
      modifications: {
        '爆发启动': { speed: '宁静启动', camera: '缓缓推轨' },
        '擦碰穿梭': { speed: '祥和穿越', camera: '优雅掠过' },
        '加速混乱': { speed: '和谐加速', camera: '渐进拉升' },
        '终极动作': { speed: '圆满高潮', camera: '绽放式展开' },
        '戛然而止': { speed: '祥和定格', camera: '缓缓停驻' }
      }
    }
  }
};

// ========== 节奏模板引擎 ==========
class RhythmTemplateEngine {
  constructor() {
    this.templates = RHYTHM_TEMPLATES;
  }

  /**
   * 获取五段式基础节奏
   */
  getFivePhaseRhythm() {
    return this.templates.fivePhaseRhythm;
  }

  /**
   * 按情绪获取节奏模板
   * @param {string} emotion - 情绪类型（温暖/神秘/末日/战斗/自由/悲伤）
   */
  getRhythmByEmotion(emotion) {
    const emotionKey = Object.keys(this.templates.emotionRhythms).find(
      key => emotion.includes(key)
    );
    
    if (!emotionKey) {
      console.warn(`[RhythmEngine] 未找到情绪"${emotion}"的节奏模板，使用默认`);
      return this.templates.fivePhaseRhythm;
    }

    const emotionTemplate = this.templates.emotionRhythms[emotionKey];
    const baseRhythm = this.templates.fivePhaseRhythm;

    // 合并基础节奏和情绪修改
    return {
      ...baseRhythm,
      name: emotionTemplate.name,
      description: emotionTemplate.description,
      phases: baseRhythm.phases.map((phase, index) => {
        const phaseName = phase.name;
        const modification = emotionTemplate.modifications[phaseName] || {};
        return {
          ...phase,
          ...modification,
          originalPhase: phaseName
        };
      })
    };
  }

  /**
   * 为一镜到底镜头生成完整节奏定义
   * @param {Object} shot - 镜头定义
   * @param {string} emotion - 主导情绪
   */
  generateOneShotRhythm(shot, emotion = '神秘') {
    const rhythm = this.getRhythmByEmotion(emotion);
    const shotDuration = shot.duration || 10;

    // 根据镜头时长调整节奏时间轴
    const scaleFactor = shotDuration / 10;
    const adjustedPhases = rhythm.phases.map(phase => ({
      ...phase,
      duration: Math.round(phase.duration * scaleFactor * 10) / 10,
      timeRange: `${(parseFloat(phase.timeRange.split('-')[0]) * scaleFactor).toFixed(1)}-${(parseFloat(phase.timeRange.split('-')[1]) * scaleFactor).toFixed(1)}秒`
    }));

    return {
      rhythmTemplate: rhythm.name,
      totalDuration: shotDuration,
      phases: adjustedPhases,
      appliedTo: shot.id || 'unknown',
      generatedAt: new Date().toISOString()
    };
  }

  /**
   * 为普通镜头生成节奏建议
   * @param {Object} shot - 镜头定义
   * @param {string} emotion - 主导情绪
   */
  generateShotRhythm(shot, emotion = '神秘') {
    const shotDuration = shot.duration || 5;
    const rhythm = this.getRhythmByEmotion(emotion);

    // 普通镜头（5秒）简化节奏：起→承→转
    if (shotDuration <= 5) {
      return {
        rhythmTemplate: `${rhythm.name}（简化版）`,
        totalDuration: shotDuration,
        phases: [
          {
            name: '起',
            timeRange: `0-${(shotDuration * 0.2).toFixed(1)}秒`,
            description: '情绪建立，画面展开',
            camera: '缓慢推轨/固定机位',
            emotionalImpact: '建立场景认知'
          },
          {
            name: '承',
            timeRange: `${(shotDuration * 0.2).toFixed(1)}-${(shotDuration * 0.7).toFixed(1)}秒`,
            description: '主体呈现，信息展开',
            camera: '中景展示/动作呈现',
            emotionalImpact: '信息传递，情绪铺垫'
          },
          {
            name: '转',
            timeRange: `${(shotDuration * 0.7).toFixed(1)}-${shotDuration}秒`,
            description: '情绪转折/收尾',
            camera: '收尾动作/情绪定格',
            emotionalImpact: '情绪收束或转折'
          }
        ],
        appliedTo: shot.id || 'unknown'
      };
    }

    // 中等长度镜头（6-9秒）：起→承→转→合
    if (shotDuration <= 9) {
      return {
        rhythmTemplate: `${rhythm.name}（标准版）`,
        totalDuration: shotDuration,
        phases: [
          {
            name: '起',
            timeRange: `0-${(shotDuration * 0.15).toFixed(1)}秒`,
            description: '情绪建立',
            camera: '缓慢推轨',
            emotionalImpact: '建立认知'
          },
          {
            name: '承',
            timeRange: `${(shotDuration * 0.15).toFixed(1)}-${(shotDuration * 0.45).toFixed(1)}秒`,
            description: '主体展开',
            camera: '中景展示',
            emotionalImpact: '信息传递'
          },
          {
            name: '转',
            timeRange: `${(shotDuration * 0.45).toFixed(1)}-${(shotDuration * 0.75).toFixed(1)}秒`,
            description: '情绪转折',
            camera: '动作转折',
            emotionalImpact: '情绪变化'
          },
          {
            name: '合',
            timeRange: `${(shotDuration * 0.75).toFixed(1)}-${shotDuration}秒`,
            description: '情绪收束',
            camera: '定格收尾',
            emotionalImpact: '余韵留存'
          }
        ],
        appliedTo: shot.id || 'unknown'
      };
    }

    // 长镜头（10秒+）：使用完整五段式
    return this.generateOneShotRhythm(shot, emotion);
  }

  /**
   * 验证节奏是否符合标准
   */
  validateRhythm(rhythm) {
    const issues = [];

    if (!rhythm.phases || rhythm.phases.length === 0) {
      issues.push('节奏缺少阶段定义');
    }

    if (rhythm.totalDuration > 10 && rhythm.phases.length < 5) {
      issues.push('长镜头（>10秒）应使用五段式节奏');
    }

    const totalPhaseDuration = rhythm.phases.reduce((sum, p) => sum + (p.duration || 0), 0);
    if (Math.abs(totalPhaseDuration - rhythm.totalDuration) > 0.5) {
      issues.push(`阶段时长总和(${totalPhaseDuration})与总时长(${rhythm.totalDuration})不匹配`);
    }

    return {
      valid: issues.length === 0,
      issues,
      rhythmName: rhythm.rhythmTemplate || 'unknown'
    };
  }

  /**
   * 获取所有可用的情绪模板列表
   */
  getAvailableEmotions() {
    return Object.keys(this.templates.emotionRhythms);
  }
}

// ========== 音效铁律引擎 ==========
class SoundDesignEngine {
  constructor() {
    this.diegeticRule = {
      name: '纯环境音效铁律（Diegetic）',
      description: '所有声音必须来自画面内世界，禁止任何外部音乐/旁白',
      rules: [
        '✅ 允许：环境音（风声/水声/动物声）',
        '✅ 允许：动作音（脚步声/摩擦声/碰撞声）',
        '✅ 允许：生物音（呼吸/鸣叫/翅膀振动）',
        '✅ 允许：环境氛围音（雷声/能量声/自然共鸣）',
        '❌ 禁止：背景音乐/配乐/歌曲',
        '❌ 禁止：旁白/解说/画外音',
        '❌ 禁止：文字提示音/UI音效',
        '❌ 禁止：非画面内的声音源'
      ]
    };
  }

  /**
   * 为一镜到底镜头生成音效设计
   */
  generateOneShotSound(shot, environment = '通用') {
    const soundMap = {
      '青丘灵原': ['草叶摩擦声', '荧光孢子爆裂声', '翅膀嗡鸣', '双恒星低频共鸣'],
      '太素崩坏': ['能量撕裂轰鸣', '光粒爆裂噼啪声', '空间扭曲低频嗡鸣', '维度裂缝呼啸声'],
      '弱水河': ['液态汞水面波动声', '旋龟游水声', '水下共鸣', '水流切割声'],
      '钟山': ['龙骨山脉风声', '龙鳞摩擦声', '银角共鸣', '远古低语'],
      '不周山': ['岩石崩塌声', '青铜废墟碰撞声', '九尾狐足音', '远古机关运转声'],
      '通用': ['环境风声', '动作摩擦声', '生物活动声', '自然氛围音']
    };

    const elements = soundMap[environment] || soundMap['通用'];

    return {
      type: 'Diegetic',
      rule: this.diegeticRule.name,
      elements,
      noMusic: true,
      noNarration: true,
      environment,
      appliedTo: shot.id || 'unknown',
      generatedAt: new Date().toISOString()
    };
  }

  /**
   * 验证音效是否符合铁律
   */
  validateSound(sound) {
    const issues = [];

    if (!sound.noMusic) {
      issues.push('违反铁律：检测到背景音乐');
    }

    if (!sound.noNarration) {
      issues.push('违反铁律：检测到旁白');
    }

    if (sound.type !== 'Diegetic') {
      issues.push('违反铁律：音效类型必须为Diegetic');
    }

    return {
      valid: issues.length === 0,
      issues,
      rule: this.diegeticRule.name
    };
  }

  /**
   * 获取铁律定义
   */
  getDiegeticRule() {
    return this.diegeticRule;
  }
}

// ========== 导演系统集成接口 ==========

/**
 * 将节奏模板集成到导演系统
 * @param {Object} episodePlan - 导演系统生成的剧集计划
 */
function integrateRhythmWithDirector(episodePlan) {
  const rhythmEngine = new RhythmTemplateEngine();
  const soundEngine = new SoundDesignEngine();

  // 为每个幕生成节奏模板
  episodePlan.acts = episodePlan.acts.map(act => {
    const emotion = act.emotion || '神秘';
    const rhythm = rhythmEngine.generateShotRhythm(
      { id: act.actNumber, duration: act.duration },
      emotion
    );

    // 为每个幕生成音效设计
    const sound = soundEngine.generateOneShotSound(
      { id: act.actNumber },
      act.environment || '通用'
    );

    return {
      ...act,
      rhythm,
      sound
    };
  });

  // 如果存在一镜到底镜头，为其生成完整五段式节奏
  if (episodePlan.oneShotInfo) {
    const oneShotEmotion = episodePlan.oneShotInfo.emotion || '神秘';
    const oneShotRhythm = rhythmEngine.generateOneShotRhythm(
      { id: 'one-shot', duration: 10 },
      oneShotEmotion
    );

    const oneShotSound = soundEngine.generateOneShotSound(
      { id: 'one-shot' },
      episodePlan.oneShotInfo.scene?.setting || '通用'
    );

    episodePlan.oneShotRhythm = oneShotRhythm;
    episodePlan.oneShotSound = oneShotSound;
  }

  // 添加音效铁律到全局配置
  episodePlan.soundDesignRule = soundEngine.getDiegeticRule();

  console.log(`[RhythmIntegration] 节奏模板已注入: ${episodePlan.acts.length}幕`);
  console.log(`[RhythmIntegration] 音效铁律已生效: ${soundEngine.diegeticRule.name}`);

  return episodePlan;
}

// ========== 导出 ==========
module.exports = {
  RhythmTemplateEngine,
  SoundDesignEngine,
  integrateRhythmWithDirector,
  RHYTHM_TEMPLATES
};

// CLI 测试入口
if (require.main === module) {
  console.log('\n🎵 山海经系列节奏模板库测试\n');

  const engine = new RhythmTemplateEngine();
  const soundEngine = new SoundDesignEngine();

  // 测试五段式节奏
  console.log('1. 五段式基础节奏:');
  const baseRhythm = engine.getFivePhaseRhythm();
  console.log(`   ${baseRhythm.name} (${baseRhythm.totalDuration}秒)`);
  baseRhythm.phases.forEach(phase => {
    console.log(`   ${phase.name}: ${phase.timeRange} — ${phase.description}`);
  });

  // 测试情绪节奏
  console.log('\n2. 情绪节奏模板:');
  ['温暖', '神秘', '末日'].forEach(emotion => {
    const rhythm = engine.getRhythmByEmotion(emotion);
    console.log(`   ${emotion}: ${rhythm.name}`);
  });

  // 测试一镜到底节奏生成
  console.log('\n3. 一镜到底节奏（10秒）:');
  const oneShotRhythm = engine.generateOneShotRhythm({ id: 'S01', duration: 10 }, '温暖');
  oneShotRhythm.phases.forEach(phase => {
    console.log(`   ${phase.name}: ${phase.timeRange} — ${phase.camera}`);
  });

  // 测试音效铁律
  console.log('\n4. 音效铁律:');
  const rule = soundEngine.getDiegeticRule();
  console.log(`   ${rule.name}`);
  rule.rules.forEach(r => console.log(`   ${r}`));

  // 测试音效生成
  console.log('\n5. 一镜到底音效（青丘灵原）:');
  const sound = soundEngine.generateOneShotSound({ id: 'S01' }, '青丘灵原');
  console.log(`   类型: ${sound.type}`);
  console.log(`   元素: ${sound.elements.join(', ')}`);

  console.log('\n✅ 节奏模板库测试完成\n');
}