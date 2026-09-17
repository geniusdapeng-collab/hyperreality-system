// PRD Schema v3.0 - 12 模块 48 字段
// 版本：v3.0 | 日期：2026-07-05

const PRDSchema = {
  type: "object",
  required: [
    "projectDefinition",
    "productPositioning",
    "creativeCore",
    "visualSpecification",
    "audioSpecification",
    "characterSystem",
    "scenePlan",
    "productionConstraints",
    "audienceProfile",
    "referenceCases",
    "deliveryStandard"
  ],
  properties: {
    // ========== 1. 项目定义（5 字段）==========
    projectDefinition: {
      type: "object",
      required: ["projectId", "projectName", "version", "createdAt", "sourceIntent"],
      properties: {
        projectId: { type: "string" },
        projectName: { type: "string" },
        version: { type: "string", enum: ["1.0.0"] },
        createdAt: { type: "string" },
        sourceIntent: { type: "string" }
      },
      additionalProperties: false
    },
    
    // ========== 2. 产品定位（7 字段）==========
    productPositioning: {
      type: "object",
      required: ["productType", "genre", "targetPlatform", "targetDuration", "aspectRatio", "resolution", "frameRate"],
      properties: {
        productType: {
          type: "string",
          enum: ["商业广告", "品牌宣传", "纪录片", "剧情短片", "音乐MV", "科普教育", "社交媒体内容", "艺术实验"]
        },
        genre: {
          type: "string",
          enum: ["硬科幻", "赛博朋克", "武侠动作", "恐怖悬疑", "自然纪录片", "家庭温情", "浪漫爱情", "喜剧荒诞", "历史战争", "社会现实", "艺术实验", "运动竞技", "美食文化", "文化遗产", "旅游推广", "通用"]
        },
        targetPlatform: {
          type: "string",
          enum: ["抖音", "视频号", "B站", "小红书", "YouTube", "TikTok", "Instagram", "通用"]
        },
        targetDuration: { type: "number", minimum: 5, maximum: 180 },
        aspectRatio: { type: "string", enum: ["16:9", "9:16", "1:1", "4:3"] },
        resolution: { type: "string", enum: ["1080p", "2K", "4K", "8K"] },
        frameRate: { type: "number", enum: [24, 25, 30, 60] }
      },
      additionalProperties: false
    },
    
    // ========== 3. 创意核心（6 字段）==========
    creativeCore: {
      type: "object",
      required: ["coreTheme", "creativeHook", "emotionalArc", "keyMessages", "twistPoint", "endingType"],
      properties: {
        coreTheme: { type: "string", minLength: 10, maxLength: 200 },
        creativeHook: { type: "string", minLength: 10, maxLength: 200 },
        emotionalArc: {
          type: "string",
          enum: ["setup→rising→climax→falling→resolution", "setup→rising→climax→resolution", "setup→climax→resolution", "loop", "flat→peak→flat"]
        },
        keyMessages: {
          type: "array",
          items: { type: "string", minLength: 5, maxLength: 100 },
          minItems: 1,
          maxItems: 4
        },
        twistPoint: { type: "string" },
        endingType: {
          type: "string",
          enum: ["开放式", "闭合式", "悬念式", "升华式", "反转式"]
        }
      },
      additionalProperties: false
    },
    
    // ========== 4. 视觉规格（7 字段）==========
    visualSpecification: {
      type: "object",
      required: ["primaryStyle", "colorPalette", "lightingDirection", "cameraLanguage", "visualReferences", "textureQuality", "specialVisualEffects"],
      properties: {
        primaryStyle: {
          type: "string",
          enum: ["电影级写实", "纪录片风格", "广告级商业", "艺术实验", "赛博朋克", "极简主义", "复古风格", "动漫风格"]
        },
        colorPalette: {
          type: "object",
          required: ["dominant", "accent", "mood"],
          properties: {
            dominant: { type: "string" },
            accent: { type: "string" },
            mood: { type: "string" }
          },
          additionalProperties: false
        },
        lightingDirection: { type: "string" },
        cameraLanguage: { type: "string" },
        visualReferences: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 5
        },
        textureQuality: {
          type: "string",
          enum: ["超写实8K", "写实", "风格化", "卡通", "油画", "像素"]
        },
        specialVisualEffects: {
          type: "array",
          items: { type: "string" },
          maxItems: 3
        }
      },
      additionalProperties: false
    },
    
    // ========== 5. 音频规格（5 字段）==========
    audioSpecification: {
      type: "object",
      required: ["musicStyle", "soundDesign", "voicePolicy", "audioMood", "audioReferences"],
      properties: {
        musicStyle: { type: "string" },
        soundDesign: { type: "string" },
        voicePolicy: {
          type: "string",
          enum: ["无对白", "纯旁白", "纯对白", "旁白+对白", "字幕+音乐", "环境音为主"]
        },
        audioMood: { type: "string" },
        audioReferences: {
          type: "array",
          items: { type: "string" },
          maxItems: 3
        }
      },
      additionalProperties: false
    },
    
    // ========== 6. 角色系统（1 字段，内部数组）==========
    characterSystem: {
      type: "object",
      required: ["characters"],
      properties: {
        characters: {
          type: "array",
          items: {
            type: "object",
            required: ["characterId", "name", "role", "ageRange", "appearance", "personality", "costume", "portraitPath", "consistencyRequirements"],
            properties: {
              characterId: { type: "string" },
              name: { type: "string" },
              role: { type: "string", enum: ["主角", "配角", "反派", "群演", "旁白"] },
              ageRange: { type: "string", enum: ["儿童", "青少年", "青年", "中年", "老年", "不限"] },
              appearance: { type: "string", minLength: 10, maxLength: 300 },
              personality: { type: "string", minLength: 5, maxLength: 200 },
              costume: { type: "string", minLength: 5, maxLength: 200 },
              portraitPath: { type: "string" },
              consistencyRequirements: { type: "string" }
            },
            additionalProperties: false
          },
          maxItems: 5
        }
      },
      additionalProperties: false
    },
    
    // ========== 7. 场景规划（2 字段：scenes + shotMapping）==========
    scenePlan: {
      type: "object",
      required: ["scenes", "shotMapping"],
      properties: {
        scenes: {
          type: "array",
          items: {
            type: "object",
            required: ["sceneId", "sequence", "purpose", "duration", "emotionalBeat", "setting", "timeOfDay", "keyProps", "visualRequirements", "audioRequirements", "dialogue"],
            properties: {
              sceneId: { type: "string" },
              sequence: { type: "number" },
              purpose: { type: "string", minLength: 10, maxLength: 200 },
              duration: { type: "number", minimum: 3, maximum: 60 },
              emotionalBeat: { type: "string", enum: ["setup", "rising", "climax", "falling", "resolution", "twist"] },
              setting: { type: "string" },
              timeOfDay: { type: "string", enum: ["清晨", "上午", "正午", "下午", "傍晚", "夜晚", "深夜", "不限"] },
              keyProps: { type: "array", items: { type: "string" }, maxItems: 5 },
              visualRequirements: { type: "array", items: { type: "string" }, maxItems: 5 },
              audioRequirements: { type: "array", items: { type: "string" }, maxItems: 5 },
              dialogue: { type: "string" }
            },
            additionalProperties: false
          },
          minItems: 2,
          maxItems: 8
        },
        shotMapping: {
          type: "array",
          items: {
            type: "object",
            required: ["sceneId", "estimatedShots", "shotBreakdownHint"],
            properties: {
              sceneId: { type: "string" },
              estimatedShots: { type: "number", minimum: 1, maximum: 6 },
              shotBreakdownHint: {
                type: "array",
                items: {
                  type: "string",
                  enum: ["establishing", "wide", "medium", "close-up", "extreme-close-up", "POV", "drone", "tracking", "static"]
                },
                maxItems: 6
              }
            },
            additionalProperties: false
          }
        }
      },
      additionalProperties: false
    },
    
    // ========== 8. 制作约束（5 字段）==========
    productionConstraints: {
      type: "object",
      required: ["technicalConstraints", "businessConstraints", "forbiddenElements", "qualityThresholds", "modelCapabilityBounds"],
      properties: {
        technicalConstraints: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 5
        },
        businessConstraints: {
          type: "array",
          items: { type: "string" },
          maxItems: 3
        },
        forbiddenElements: {
          type: "array",
          items: { type: "string" },
          maxItems: 5
        },
        qualityThresholds: {
          type: "object",
          required: ["visual", "audio", "narrative", "consistency"],
          properties: {
            visual: { type: "number", minimum: 0.5, maximum: 1.0 },
            audio: { type: "number", minimum: 0.5, maximum: 1.0 },
            narrative: { type: "number", minimum: 0.5, maximum: 1.0 },
            consistency: { type: "number", minimum: 0.5, maximum: 1.0 }
          },
          additionalProperties: false
        },
        modelCapabilityBounds: {
          type: "object",
          required: ["maxPromptComplexity", "supportedEffects", "consistencyStrategy"],
          properties: {
            maxPromptComplexity: {
              type: "string",
              enum: ["simple", "moderate", "complex"]
            },
            supportedEffects: {
              type: "array",
              items: { type: "string" },
              maxItems: 5
            },
            consistencyStrategy: {
              type: "string",
              enum: ["character-seed", "style-reference", "textual-description", "hybrid"]
            }
          },
          additionalProperties: false
        }
      },
      additionalProperties: false
    },
    
    // ========== 9. 受众定位（3 字段）==========
    audienceProfile: {
      type: "object",
      required: ["primaryAudience", "emotionTriggers", "contentExpectations"],
      properties: {
        primaryAudience: {
          type: "object",
          required: ["ageRange", "gender", "interests", "consumptionLevel"],
          properties: {
            ageRange: { type: "string", enum: ["18-24", "25-30", "31-35", "36-40", "40+"] },
            gender: { type: "string", enum: ["male", "female", "all"] },
            interests: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 5 },
            consumptionLevel: { type: "string", enum: ["low", "medium", "high", "luxury"] }
          },
          additionalProperties: false
        },
        emotionTriggers: {
          type: "array",
          items: { type: "string" },
          minItems: 2,
          maxItems: 5
        },
        contentExpectations: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 4
        }
      },
      additionalProperties: false
    },
    
    // ========== 10. 参考案例（3 字段）==========
    referenceCases: {
      type: "object",
      required: ["filmReferences", "adReferences", "styleReferences"],
      properties: {
        filmReferences: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 4
        },
        adReferences: {
          type: "array",
          items: { type: "string" },
          maxItems: 3
        },
        styleReferences: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 4
        }
      },
      additionalProperties: false
    },
    
    // ========== 11. 交付标准（6 字段）==========
    deliveryStandard: {
      type: "object",
      required: ["deliverables", "acceptanceCriteria", "outputFormat", "revisionPolicy", "fallbackPlan", "continuityCheckpoints"],
      properties: {
        deliverables: {
          type: "array",
          items: {
            type: "object",
            required: ["item", "spec", "priority"],
            properties: {
              item: {
                type: "string",
                enum: ["video_master", "character_portraits", "script_document", "shot_list", "audio_stems", "prompt_log"]
              },
              spec: { type: "string" },
              priority: { type: "string", enum: ["required", "optional"] }
            },
            additionalProperties: false
          },
          minItems: 1,
          maxItems: 6
        },
        acceptanceCriteria: {
          type: "object",
          required: ["visualScore", "audioScore", "narrativeScore", "consistencyScore"],
          properties: {
            visualScore: { type: "number", minimum: 0.7, maximum: 1.0 },
            audioScore: { type: "number", minimum: 0.7, maximum: 1.0 },
            narrativeScore: { type: "number", minimum: 0.7, maximum: 1.0 },
            consistencyScore: { type: "number", minimum: 0.7, maximum: 1.0 }
          },
          additionalProperties: false
        },
        outputFormat: {
          type: "object",
          required: ["videoCodec", "audioCodec", "container"],
          properties: {
            videoCodec: { type: "string", enum: ["H.264", "H.265", "ProRes"] },
            audioCodec: { type: "string", enum: ["AAC", "PCM", "FLAC"] },
            container: { type: "string", enum: ["MP4", "MOV"] }
          },
          additionalProperties: false
        },
        revisionPolicy: {
          type: "object",
          required: ["maxRevisions", "revisionScope"],
          properties: {
            maxRevisions: { type: "number", minimum: 0, maximum: 3 },
            revisionScope: {
              type: "array",
              items: {
                type: "string",
                enum: ["visual", "audio", "narrative", "character", "scene"]
              },
              maxItems: 5
            }
          },
          additionalProperties: false
        },
        fallbackPlan: {
          type: "object",
          required: ["trigger", "action", "expectedOutput"],
          properties: {
            trigger: { type: "string" },
            action: { type: "string" },
            expectedOutput: { type: "string" }
          },
          additionalProperties: false
        },
        continuityCheckpoints: {
          type: "array",
          items: {
            type: "object",
            required: ["checkpoint", "validationMethod"],
            properties: {
              checkpoint: {
                type: "string",
                enum: ["character-appearance", "costume-continuity", "prop-continuity", "lighting-continuity", "scene-logic"]
              },
              validationMethod: { type: "string" }
            },
            additionalProperties: false
          },
          maxItems: 5
        }
      },
      additionalProperties: false
    }
  },
  additionalProperties: false
};

// 模块级枚举映射（用于 fallback 填充）
const ENUM_DEFAULTS = {
  genre: '通用',
  targetPlatform: '通用',
  aspectRatio: '16:9',
  resolution: '1080p',
  frameRate: 24,
  emotionalArc: 'setup→rising→climax→falling→resolution',
  endingType: '闭合式',
  primaryStyle: '电影级写实',
  textureQuality: '写实',
  voicePolicy: '环境音为主',
  role: '配角',
  ageRange: '不限',
  timeOfDay: '不限',
  emotionalBeat: 'setup',
  maxPromptComplexity: 'moderate',
  consistencyStrategy: 'textual-description',
  ageRange_audience: '25-30',
  gender: 'all',
  consumptionLevel: 'medium',
  videoCodec: 'H.264',
  audioCodec: 'AAC',
  container: 'MP4',
  qualityTier: 'standard'};

// 类型到产品类型映射
const TYPE_TO_PRODUCT_TYPE = {
  '硬科幻': '剧情短片', '赛博朋克': '剧情短片', '武侠动作': '剧情短片',
  '恐怖悬疑': '剧情短片', '自然纪录片': '纪录片', '商业广告': '商业广告',
  '科普教育': '科普教育', '音乐MV': '音乐MV', '家庭温情': '剧情短片',
  '浪漫爱情': '剧情短片', '喜剧荒诞': '剧情短片', '历史战争': '剧情短片',
  '社会现实': '纪录片', '艺术实验': '艺术实验', '运动竞技': '社交媒体内容',
  '美食文化': '社交媒体内容', '文化遗产': '纪录片', '旅游推广': '品牌宣传',
  '通用': '剧情短片'
};

// 受众到平台映射
const AUDIENCE_TO_PLATFORM = {
  '抖音用户': '抖音', '年轻人': '抖音', 'B站用户': 'B站',
  '小红书用户': '小红书', '国际用户': 'YouTube', '通用': '通用'
};

// 品质档位到质量阈值映射
const QUALITY_TIER_THRESHOLDS = {
  'standard': { visual: 0.75, audio: 0.70, narrative: 0.75, consistency: 0.70 },
  'premium': { visual: 0.85, audio: 0.80, narrative: 0.85, consistency: 0.80 },
  'film': { visual: 0.92, audio: 0.88, narrative: 0.92, consistency: 0.90 }
};

// 品质档位到模型能力边界映射
const QUALITY_TIER_BOUNDS = {
  'standard': {
    maxPromptComplexity: 'moderate',
    supportedEffects: ['基础调色', '简单转场'],
    consistencyStrategy: 'textual-description'
  },
  'premium': {
    maxPromptComplexity: 'complex',
    supportedEffects: ['粒子特效', '光效', '景深模拟', '运动模糊'],
    consistencyStrategy: 'style-reference'
  },
  'film': {
    maxPromptComplexity: 'complex',
    supportedEffects: ['粒子特效', '光效', '景深模拟', '运动模糊', '体积光', '镜头畸变'],
    consistencyStrategy: 'hybrid'
  }
};

// 视频类型到禁止元素映射
const TYPE_TO_FORBIDDEN = {
  '硬科幻': ['卡通风格', '过度简化', '模糊镜头'],
  '赛博朋克': ['自然光线', '田园风光', '暖色调为主'],
  '恐怖悬疑': ['明亮色调', '喜剧元素', '欢快音乐'],
  '商业广告': ['负面信息', '政治敏感', '暴力内容'],
  '艺术实验': ['商业模板', '套路化', '标准分镜'],
  '自然纪录片': ['虚构情节', '夸张特效', '人物表演'],
  '通用': ['低质量', '模糊', '不稳定']
};

// 视频类型到交付物映射
const TYPE_TO_DELIVERABLES = {
  '剧情短片': [
    { item: 'video_master', spec: 'MP4/H.264, 1080p', priority: 'required' },
    { item: 'character_portraits', spec: '定妆照全套', priority: 'required' },
    { item: 'script_document', spec: '完整剧本+分镜', priority: 'required' },
    { item: 'shot_list', spec: '镜头清单+Prompt日志', priority: 'optional' }
  ],
  '商业广告': [
    { item: 'video_master', spec: 'MP4/H.265, 4K', priority: 'required' },
    { item: 'audio_stems', spec: '分轨音频', priority: 'optional' },
    { item: 'prompt_log', spec: '完整Prompt审计日志', priority: 'required' }
  ],
  '纪录片': [
    { item: 'video_master', spec: 'MP4/H.264, 1080p', priority: 'required' },
    { item: 'script_document', spec: '旁白脚本', priority: 'required' },
    { item: 'shot_list', spec: '镜头清单', priority: 'optional' }
  ],
  '音乐MV': [
    { item: 'video_master', spec: 'MP4/H.265, 4K', priority: 'required' },
    { item: 'audio_stems', spec: '分轨音频', priority: 'required' }
  ],
  '通用': [
    { item: 'video_master', spec: 'MP4/H.264, 1080p', priority: 'required' },
    { item: 'script_document', spec: '剧本文档', priority: 'optional' }
  ]
};

module.exports = {
  PRDSchema,
  ENUM_DEFAULTS,
  TYPE_TO_PRODUCT_TYPE,
  AUDIENCE_TO_PLATFORM,
  QUALITY_TIER_THRESHOLDS,
  QUALITY_TIER_BOUNDS,
  TYPE_TO_FORBIDDEN,
  TYPE_TO_DELIVERABLES
};
