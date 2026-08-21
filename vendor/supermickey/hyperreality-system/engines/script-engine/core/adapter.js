// engines/script-engine/core/adapter.js
// Adapter - 将 ScriptBlueprint 转换为现有系统可消费的格式
// 版本：v1.0 | 日期：2026-06-07

const path = require('path');
// 【v2.1.22-fix 片头字段丢失】场景类型归一化（双保险：覆盖一切 blueprint 来源）
const { normalizeSceneTypes } = require('./scene-type-normalizer');

class ScriptBlueprintAdapter {
  constructor(options = {}) {
    this.config = {
      charactersDir: options.charactersDir || path.join(__dirname, '../../../characters'),
      // v2.1.4-fix13-审计修复: 与超级小香宝标准(3000)对齐
      maxPromptLength: options.maxPromptLength || 12000,
      ...options
    };
  }

  /**
   * 主入口：将 ScriptBlueprint 转换为现有 Pipeline 输入格式
   * @param {ScriptBlueprint} blueprint - 剧本蓝图
   * @returns {object} 现有系统可消费的格式
   */
  adapt(blueprint) {
    console.log(`[Adapter] 适配剧本: ${blueprint.meta.title}`);

    const result = {
      // 基础配置
      config: this._adaptConfig(blueprint),
      
      // 场景列表（对应现有 SC00~SC04）
      scenes: this._adaptScenes(blueprint),
      
      // 角色系统（对应现有 characters/）
      characters: this._adaptCharacters(blueprint),
      
      // 台词系统
      dialogues: this._adaptDialogues(blueprint),
      
      // 世界观设定
      worldSetting: this._adaptWorldSetting(blueprint),
      
      // 【fix】透传原始 blueprint 的 meta 和 character_system，供 CONTRACT 校验使用
      meta: blueprint.meta || {},
      character_system: blueprint.character_system || { characters: [] },
      
      // 元数据
      metadata: {
        blueprint_id: blueprint.blueprint_id,
        version: blueprint.version,
        title: blueprint.meta.title,
        narrative_mode: blueprint.meta.narrative_mode,
        target_duration: blueprint.meta.target_duration,
        total_scenes: blueprint.structure.scenes.length
      }
    };

    console.log(`[Adapter] 适配完成: ${result.scenes.length} 场景, ${result.characters.length} 角色`);
    return result;
  }

  /**
   * 适配配置
   */
  _adaptConfig(blueprint) {
    // v1.2.5: 从blueprint.meta._metadata中提取系列和平台信息
    const meta = blueprint.meta || {};
    return {
      title: meta.title,
      narrative_mode: meta.narrative_mode,
      target_duration: meta.target_duration,
      world_setting: blueprint.world_setting?.world_id || 'default',
      featured_beast_id: blueprint.extensions?.nirath_extension?.featured_beast_id || null,
      // v1.2.7-fix-A10: 移除 示例角色 硬编码
      protagonist: blueprint.character_system?.characters?.find(c => c.role === 'protagonist')?.character_id || null,
      
      // v1.2.5: 传递系列和平台元数据
      aspectRatio: meta._metadata?.aspectRatio || meta.aspectRatio || '16:9',
      // 【2026-07-17 修复】创意指数挂到 config 顶层（PromptFusion 读 blueprint.config?.creativeIntensity）
      creativeIntensity: meta._metadata?.creativeIntensity ?? null,
      _metadata: meta._metadata || {},
      
      // 【v2.1.4-fix9-P1】传递导演上下文信息
      content_theme: meta.content_theme || this._extractContentTheme(meta.title, meta),
      content_summary: meta.content_summary || '',
      visual_style: meta.visual_style || 'REAL',
      scene_requirement: meta.scene_requirement || '',
      character_description: meta.character_description || '',
      forbidden_scenes: meta.forbidden_scenes || [],
      key_messages: meta.key_messages || [],
      
      // 约束配置
      constraints: {
        max_prompt_length: this.config.maxPromptLength,
        reference_image_count: 2,
        forbidden_elements: ['voiceover', 'metal_gloss', 'unnatural_eye_color']
      },
      
      // 视觉配置
      visual: {
        style: 'hyper-realistic cinematic',
        color_temperature: 'warm',
        lighting: 'cinematic',
        forbidden: ['dark', 'night', 'metal_gloss']
      }
    };
  }

  /**
   * 适配场景列表
   * 【v2.1.22-fix 片头字段丢失】scene_type 先经 normalizeSceneTypes 归一化再透传：
   * LLM 路径已在 script-generator 归一过一次，此处兜底覆盖模板降级/外部注入等
   * 其他 blueprint 来源，保证进入生产引擎的 scene_type 一定是标准五型，
   * 且第一个场景一定是 opening。visual_direction 推断同步使用归一化后的类型。
   */
  _adaptScenes(blueprint) {
    const rawScenes = blueprint.structure.scenes || [];

    // 归一化（就地修改 scene_type，返回同一数组）
    normalizeSceneTypes(rawScenes, {
      logger: (msg) => console.warn(`[Adapter] ${msg}`)
    });

    return rawScenes.map((scene, index) => {
      const adaptedScene = {
        scene_id: scene.scene_id || `SC${String(index).padStart(2, '0')}`,
        scene_name: scene.scene_name || `场景${index + 1}`,
        scene_type: scene.scene_type, // ← 已是归一化后的标准五型
        scene_function: scene.scene_function || 'establish',
        
        // 时序
        timing: {
          start: scene.timing?.start || 0,
          duration: scene.timing?.duration || 20,
          end: scene.timing?.end || 20
        },
        
        // 设定
        setting: scene.setting || '',
        time_of_day: scene.time_of_day || '',
        atmosphere: scene.atmosphere || '',
        visual_style: scene.visual_style || '',
        space_depth: scene.space_depth || '',
        key_props: scene.key_props || [],
        director_notes: scene.director_notes || '',
        visual_notes: scene.visual_notes || '',
        
        // 【v2.1.4-fix9-P1】场景主题标记
        scene_theme: scene.scene_theme || '',
        
        // 角色
        characters: scene.characters || [],
        
        // 对话
        // 【v2.1.5-fix-C】透传 blocks 字段，保持完整 DIALOGUE_BLOCK 结构
        dialogue: scene.dialogue || { has_dialogue: false, lines: [], blocks: [] },
        
        // 情感目标
        emotional_target: scene.emotional_target || { valence: 0, arousal: 0.5, dominance: 0.5 },
        
        // 视觉方向（为制作引擎准备）
        // 【v2.1.22-fix】使用归一化后的 scene_type 推断，英雄之旅词汇不再全部掉到默认值
        visual_direction: {
          shot_type: this._inferShotType(scene.scene_type),
          camera_movement: this._inferCameraMovement(scene.scene_type),
          lighting: this._inferLighting(scene.scene_type),
          color_temperature: this._inferColorTemperature(scene.emotional_target)
        }
      };

      // 生成镜头 Prompt 的基础文本（供制作引擎使用）
      adaptedScene.prompt_base = this._generatePromptBase(adaptedScene, blueprint);

      return adaptedScene;
    });
  }

  /**
   * 推断镜头类型
   */
  _inferShotType(sceneType) {
    const shotMap = {
      'opening': 'wide',
      'establishing': 'medium',
      'conflict': 'close_up',
      'emotional_climax': 'extreme_close_up',
      'resolution': 'medium'
    };
    return shotMap[sceneType] || 'medium';
  }

  /**
   * 推断运镜方式
   */
  _inferCameraMovement(sceneType) {
    const movementMap = {
      'opening': '缓慢推进',
      'establishing': '稳定机位',
      'conflict': '手持晃动',
      'emotional_climax': '快速推近',
      'resolution': '缓慢后拉'
    };
    return movementMap[sceneType] || '稳定机位';
  }

  /**
   * 推断布光
   */
  _inferLighting(sceneType) {
    const lightingMap = {
      'opening': '自然光+环境光',
      'establishing': '均匀明亮',
      'conflict': '戏剧性明暗对比',
      'emotional_climax': '伦勃朗光',
      'resolution': '温暖柔光'
    };
    return lightingMap[sceneType] || '均匀明亮';
  }

  /**
   * 推断色温
   */
  _inferColorTemperature(emotionalTarget) {
    if (!emotionalTarget) return 'neutral';
    
    const valence = emotionalTarget.valence || 0;
    if (valence > 0.5) return 'warm';
    if (valence < -0.3) return 'cool';
    return 'neutral';
  }

  /**
   * 【P0-PROMPT-01 修复】安全的setting字符串化
   * @param {string|object} setting
   * @returns {string|null}
   */
  _stringifySetting(setting) {
    if (!setting) return null;
    if (typeof setting === 'string') {
      return setting;
    }
    if (typeof setting === 'object' && !Array.isArray(setting)) {
      const parts = [];
      if (setting.location) parts.push(setting.location);
      if (setting.time) parts.push(setting.time);
      if (setting.description) parts.push(setting.description);
      if (setting.scene) parts.push(setting.scene);
      if (parts.length === 0) {
        for (const [key, value] of Object.entries(setting)) {
          if (typeof value === 'string' && value.trim()) {
            parts.push(`${key}:${value}`);
          }
        }
      }
      return parts.length > 0 ? parts.join('，') : null;
    }
    const str = String(setting);
    return str.startsWith('[object ') ? null : str;
  }

  /**
   * 生成 Prompt 基础文本
   */
  _generatePromptBase(scene, blueprint) {
    const parts = [];
    
    // 1. 场景类型和风格
    parts.push(`电影级${scene.scene_function === 'climax' ? '高潮' : ''}镜头`);
    parts.push('超写实');
    
    // 2. 世界观
    if (blueprint.world_setting?.world_id === 'nirath') {
      parts.push('Nirath星球');
    }
    
    // 3. 设定 —— 【P0-PROMPT-01 修复】安全序列化
    if (scene.setting) {
      const settingStr = this._stringifySetting(scene.setting);
      if (settingStr) {
        parts.push(settingStr);
      }
    }
    
    // 4. 角色
    if (scene.characters && scene.characters.length > 0) {
      const characterDescs = scene.characters.map(cid => {
        const char = blueprint.character_system?.characters?.find(c => c.character_id === cid);
        if (char) {
          return `${char.name}（${char.visual_anchor?.core_features?.join('、') || ''}）`;
        }
        return cid;
      });
      parts.push(characterDescs.join('，'));
    }
    
    // 5. 视觉方向
    if (scene.visual_direction) {
      const vd = scene.visual_direction;
      const shotType = typeof vd.shot_type === 'string' ? vd.shot_type : '';
      const cameraMovement = typeof vd.camera_movement === 'string' ? vd.camera_movement : '';
      if (shotType && cameraMovement) {
        parts.push(`${shotType}，${cameraMovement}`);
      }
    }
    
    // 6. 对话提示（如果有）
    if (scene.dialogue?.has_dialogue && scene.dialogue.lines?.length > 0) {
      const line = scene.dialogue.lines[0];
      const lineText = line.text || line.line || '';
      if (lineText) {
        parts.push(`台词：「${lineText}」`);
      }
    }
    
    return parts.join('，');
  }

  /**
   * 适配角色系统
   */
  _adaptCharacters(blueprint) {
    return (blueprint.character_system?.characters || []).map((char, index) => {
      const adapted = {
        character_id: char.character_id,
        name: char.name,
        role: char.role,
        // 【v2.1.4-fix9-P1】补全 description 字段，确保 LLM 能看到角色完整描述
        description: char.description || char.visual_anchor?.persona || char.name,
        
        // 视觉锚点
        visual_anchor: {
          core_features: char.visual_anchor?.core_features || [],
          reference_images: char.visual_anchor?.reference_images || []
        },
        
        // 定妆照路径
        // 【v2.1.8-fix】防御性处理：LLM可能返回 id 而非 character_id
        portraits: this._resolvePortraitPaths(
          char.character_id || char.id || `char_${index}`,
          char.visual_anchor?.reference_images
        )
      };

      return adapted;
    });
  }

  /**
   * 解析定妆照路径
   */
  _resolvePortraitPaths(characterId, referenceImages) {
    const fs = require('fs');
    const path = require('path');
    const paths = {};

    // 【v2.1.7-fix】防御性检查：characterId 必须有效
    if (!characterId || typeof characterId !== 'string') {
      console.warn(`[Adapter._resolvePortraitPaths] characterId 无效 (${characterId})，跳过定妆照解析`);
      return paths;
    }
    
    if (referenceImages && referenceImages.length > 0) {
      for (const imgPath of referenceImages) {
        const angle = this._extractAngleFromPath(imgPath);
        if (angle) {
          paths[angle] = imgPath;
        }
      }
    }
    
    // 如果没有提供路径，尝试默认路径（支持 portraits/ 子目录和带前缀文件名）
    if (Object.keys(paths).length === 0) {
      const defaultAngles = ['front', 'threeQuarter', 'closeup', 'side'];
      const charDir = characterId;
      const searchDirs = [
        path.join(this.config.charactersDir, charDir),
        path.join(this.config.charactersDir, charDir, 'portraits')
      ];
      
      for (const searchDir of searchDirs) {
        for (const angle of defaultAngles) {
          const possibleNames = [
            `${angle}`,
            `${charDir}-${angle}`,
            `${charDir}_${angle}`
          ];
          for (const name of possibleNames) {
            for (const ext of ['.jpg', '.png', '.jpeg', '.webp']) {
              const filePath = path.join(searchDir, `${name}${ext}`);
              if (fs.existsSync(filePath)) {
                paths[angle] = filePath;
                break;
              }
            }
            if (paths[angle]) break;
          }
          if (paths[angle]) break;
        }
      }
    }
    
    return paths;
  }

  /**
   * 从路径提取角度
   */
  _extractAngleFromPath(imgPath) {
    const basename = path.basename(imgPath, path.extname(imgPath));
    const angleMap = {
      'front': 'front',
      'threeQuarter': 'threeQuarter',
      'three_quarter': 'threeQuarter',
      'closeup': 'closeup',
      'side': 'side',
      'side_profile': 'side'
    };
    return angleMap[basename] || basename;
  }

  /**
   * 适配台词系统
   * 【v2.1.5-fix-C】同时透传 blocks 字段（DIALOGUE_BLOCK 格式）
   */
  _adaptDialogues(blueprint) {
    const dialogues = [];
    
    for (const scene of blueprint.structure.scenes || []) {
      // 【P1-10 修复】blocks 优先，避免与 lines 重复 push 导致下游双倍音频
      const hasBlocks = scene.dialogue?.blocks && Array.isArray(scene.dialogue.blocks) && scene.dialogue.blocks.length > 0;

      if (hasBlocks) {
        // 优先使用 blocks（新格式），跳过 lines
        for (const block of scene.dialogue.blocks) {
          dialogues.push({
            scene_id: scene.scene_id,
            speaker: block.speaker,
            text: block.line,
            emotion: block.emotion || 'neutral',
            trigger: block.trigger || '',
            manner: block.manner || '',
            type: block.type || 'monologue',
            timing: {
              start: scene.timing?.start || 0,
              duration: scene.timing?.duration || 20
            }
          });
        }
      } else if (scene.dialogue?.has_dialogue && scene.dialogue.lines) {
        // 仅当 blocks 不存在时才用 lines（向后兼容）
        for (const line of scene.dialogue.lines) {
          dialogues.push({
            scene_id: scene.scene_id,
            speaker: line.speaker,
            text: line.text,
            emotion: line.emotion || 'neutral',
            timing: {
              start: scene.timing?.start || 0,
              duration: scene.timing?.duration || 20
            }
          });
        }
      }
    }
    
    return dialogues;
  }

  /**
   * 适配世界观设定
   */
  _adaptWorldSetting(blueprint) {
    const ws = blueprint.world_setting;
    if (!ws) return null;
    
    return {
      world_id: ws.world_id,
      world_name: ws.world_name,
      era: ws.era,
      core_rules: ws.core_rules || [],
      environment_tags: ws.environment_tags || [],
      visual_constraints: {
        must_have: ws.world_id === 'nirath' ? [
          '明亮多色彩强质感',
          '超写实风格',
          'Nirath环境特征'
        ] : [],
        forbidden: [
          '暗黑风格',
          '夜晚场景',
          '金属光泽',
          '人物眼睛非自然色'
        ]
      }
    };
  }

  /**
   * 生成适配报告
   */
  generateReport(adaptedData) {
    return {
      blueprint_id: adaptedData.metadata.blueprint_id,
      adaptation_status: 'success',
      scenes_count: adaptedData.scenes.length,
      characters_count: adaptedData.characters.length,
      dialogues_count: adaptedData.dialogues.length,
      total_duration: adaptedData.scenes.reduce((sum, s) => sum + s.timing.duration, 0),
      warnings: this._generateWarnings(adaptedData),
      timestamp: new Date().toISOString()
    };
  }

  /**
   * 生成警告信息
   */
  _generateWarnings(adaptedData) {
    const warnings = [];
    
    // 检查场景时长
    const totalDuration = adaptedData.scenes.reduce((sum, s) => sum + s.timing.duration, 0);
    if (totalDuration !== adaptedData.metadata.target_duration) {
      warnings.push({
        type: 'duration_mismatch',
        message: `总时长 ${totalDuration}s 不等于目标时长 ${adaptedData.metadata.target_duration}s`,
        severity: 'warning'
      });
    }
    
    // 检查角色定妆照
    for (const char of adaptedData.characters) {
      const portraitCount = Object.keys(char.portraits || {}).length;
      if (portraitCount === 0) {
        warnings.push({
          type: 'missing_portraits',
          message: `角色 ${char.name} 没有定妆照`,
          severity: 'warning'
        });
      }
    }
    
    // 检查台词
    const scenesWithDialogue = adaptedData.scenes.filter(s => s.dialogue?.has_dialogue).length;
    if (scenesWithDialogue === 0) {
      warnings.push({
        type: 'no_dialogue',
        message: '没有场景包含台词',
        severity: 'critical'
      });
    }
    
    return warnings;
  }
  /**
   * 【v2.1.4-fix9-P1】从标题提取内容主题
   */
  _extractContentTheme(title, meta) {
    if (!title) return '';
    // 【v2.1.4-fix13-审计修复】优先从 metadata 提取，消除硬编码
    if (meta?.content_theme) return meta.content_theme;
    if (meta?.videoType) return meta.videoType;
    if (meta?.genre) return meta.genre;
    // 通用提取：取标题前10字 + "主题"
        // 【v2.1.15-fix 主题漂移】取标题第一个语义完整子句（≤20字符）+ "主题"
        // 原实现硬截前10字："滕王阁穿越记：60多主题"式的腰斩标签
        const clause = String(title).split(/[，。！？；：:]/)[0].trim();
        const base = (clause.length <= 20 ? clause : clause.substring(0, 20)) || String(title).substring(0, 20);
        return base + '主题';
  }
}

module.exports = { ScriptBlueprintAdapter };