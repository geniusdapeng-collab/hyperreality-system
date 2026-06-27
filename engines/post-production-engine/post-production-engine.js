// hyperreality-system/engines/post-production-engine/post-production-engine.js
// Post-Production Engine - 后期引擎（Layer 4）
// 功能：字幕、音乐、弹幕、多版本输出、HyperFrames 集成
// 版本：v1.0.0 | 日期：2026-06-08

const fs = require('fs').promises;
const path = require('path');

// v2.0.2-fix: HTML转义工具，防止XSS和结构破坏
function escapeHtml(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// 无版权音乐库配置
const ROYALTY_FREE_MUSIC_SOURCES = {
  pixabay: {
    baseUrl: 'https://pixabay.com/api/',
    search: 'https://pixabay.com/music/search/',
    download: 'https://pixabay.com/music/download/',
    license: 'Pixabay Content License - Free for commercial use, no attribution required'
  },
  bensound: {
    baseUrl: 'https://www.bensound.com/',
    license: 'CC BY 4.0 or Bensound License'
  },
  freesound: {
    baseUrl: 'https://freesound.org/',
    license: 'CC0 / CC BY / CC BY-NC - varies by sound'
  }
};

// 场景类型 → 音乐风格映射
const SCENE_MUSIC_MAP = {
  opening:     { mood: 'epic',       genre: 'orchestral',   tags: ['epic', 'cinematic', 'opening', 'heroic'] },
  establishing: { mood: 'ambient',    genre: 'atmospheric', tags: ['ambient', 'mysterious', 'wonder', 'exploration'] },
  conflict:     { mood: 'tense',      genre: 'action',      tags: ['tense', 'dramatic', 'battle', 'conflict'] },
  emotional_climax: { mood: 'emotional', genre: 'emotional', tags: ['emotional', 'dramatic', 'climax', 'intense'] },
  resolution:   { mood: 'hopeful',    genre: 'uplifting',   tags: ['hopeful', 'warm', 'resolution', 'peaceful'] }
};

// 角色身份介绍模板
const IDENTITY_INTRO_TEMPLATES = [
  "虚构星球探险者 | 人类 {name}",
  "虚构生命共生体 | 守护者 {name}",
  "记忆探寻者 | 旅人 {name}",
  "星界行者 | {name} 的人类形态"
];

class PostProductionEngine {
  constructor(options = {}) {
    this.config = {
      outputDir: options.outputDir || process.env.OUTPUT_DIR || './output/hyperreality-post',
      hyperframesBin: options.hyperframesBin || 'npx hyperframes',
      musicSource: options.musicSource || 'pixabay',
      enableSubtitles: options.enableSubtitles !== false,      // 默认开启字幕
      enableDanmaku: options.enableDanmaku || false,           // 默认关闭弹幕
      enableMusic: options.enableMusic !== false,              // 默认开启音乐
      subtitleStyle: options.subtitleStyle || 'identity-card', // identity-card / lower-third / none
      versions: options.versions || ['standard', 'clean', 'subtitled', 'raw'],
      ...options
    };

    this.logs = [];
  }

  log(stage, message) {
    const entry = { stage, message, timestamp: Date.now() };
    this.logs.push(entry);
    console.log(`[POST-PROD] [${stage}] ${message}`);
  }

  /**
   * 主入口：后期制作
   * @param {Object} productionResult - 制作引擎输出（shots + prompts）
   * @param {Object} scriptResult - 剧本引擎输出（blueprint）
   * @param {Object} renderResult - 渲染引擎输出（渲染后的视频文件）
   * @returns {Object} 后期制作结果
   */
  async postProduce(productionResult, scriptResult, renderResult) {
    const startTime = Date.now();
    this.log('POST-PROD', '🎬 PostProductionEngine 启动 | 后期制作');
    this.log('POST-PROD', `   版本: ${this.config.versions.join(', ')}`);
    this.log('POST-PROD', `   字幕: ${this.config.enableSubtitles ? '✅' : '❌'} | 音乐: ${this.config.enableMusic ? '✅' : '❌'} | 弹幕: ${this.config.enableDanmaku ? '✅' : '❌'}`);

    const result = {
      success: false,
      versions: {},
      stages: {},
      errors: [],
      timing: {}
    };

    try {
      // ========== Stage 1: 字幕生成（身份介绍式）==========
      this.log('POST-PROD', '\n🎬 [Stage 1] 字幕生成 - 身份介绍式字幕');
      const stage1Start = Date.now();
      
      const subtitleTracks = await this.generateIdentitySubtitles(scriptResult);
      result.stages.subtitles = {
        tracks: subtitleTracks,
        count: subtitleTracks.length,
        timing: Date.now() - stage1Start
      };
      this.log('POST-PROD', `✅ 字幕生成完成: ${subtitleTracks.length} 条字幕`);

      // ========== Stage 2: 音乐匹配（无版权）==========
      this.log('POST-PROD', '\n🎵 [Stage 2] 音乐匹配 - 无版权音乐库');
      const stage2Start = Date.now();
      
      const musicTracks = await this.matchMusicTracks(productionResult, scriptResult);
      result.stages.music = {
        tracks: musicTracks,
        count: musicTracks.length,
        timing: Date.now() - stage2Start
      };
      this.log('POST-PROD', `✅ 音乐匹配完成: ${musicTracks.length} 段音乐`);

      // ========== Stage 3: 弹幕生成（可选）==========
      if (this.config.enableDanmaku) {
        this.log('POST-PROD', '\n💬 [Stage 3] 弹幕生成');
        const stage3Start = Date.now();
        
        const danmakuList = await this.generateDanmaku(productionResult, scriptResult);
        result.stages.danmaku = {
          list: danmakuList,
          count: danmakuList.length,
          timing: Date.now() - stage3Start
        };
        this.log('POST-PROD', `✅ 弹幕生成完成: ${danmakuList.length} 条弹幕`);
      }

      // ========== Stage 4: 多版本组装（HyperFrames HTML）==========
      this.log('POST-PROD', '\n🎨 [Stage 4] 多版本组装 - HyperFrames 集成');
      const stage4Start = Date.now();
      
      for (const version of this.config.versions) {
        this.log('POST-PROD', `   生成版本: ${version}...`);
        const versionData = await this.assembleVersion(
          version,
          productionResult,
          scriptResult,
          renderResult,
          subtitleTracks,
          musicTracks,
          result.stages.danmaku?.list || []
        );
        result.versions[version] = versionData;
      }
      result.stages.assembly = {
        versions: Object.keys(result.versions),
        timing: Date.now() - stage4Start
      };
      this.log('POST-PROD', `✅ 版本组装完成: ${this.config.versions.length} 个版本`);

      // ========== Stage 5: 质量检查 ==========
      this.log('POST-PROD', '\n🛡️ [Stage 5] 质量检查');
      const stage5Start = Date.now();
      
      const qualityCheck = await this.qualityCheck(result.versions);
      result.stages.quality = {
        passed: qualityCheck.passed,
        issues: qualityCheck.issues,
        timing: Date.now() - stage5Start
      };
      this.log('POST-PROD', `✅ 质量检查: ${qualityCheck.passed ? '通过' : '未通过'} (${qualityCheck.issues.length} 问题)`);

      result.success = qualityCheck.passed;
      result.timing.total = Date.now() - startTime;
      
      this.log('POST-PROD', `\n🏁 后期制作完成: ${result.timing.total}ms | ${this.config.versions.length} 版本`);

    } catch (error) {
      result.success = false;
      result.errors.push({
        stage: 'POST_PRODUCTION',
        message: error.message
      });
      this.log('POST-PROD', `❌ 后期制作失败: ${error.message}`);
    }

    return result;
  }

  /**
   * 生成身份介绍式字幕（嘉宾信息卡风格）
   * 
   * 设计：当角色出场时，显示 3-5 秒的简洁信息卡片
   * 不依赖台词时间戳，而是作为角色出场标记
   * 
   * 示例：
   * ┌─────────────────┐
   * │ 示例角色              │
   * │ 虚构星球探险者 │
   * │ 人类 · 银灰装甲    │
   * └─────────────────┘
   */
  async generateIdentitySubtitles(scriptResult, productionResult = null) {
    const blueprint = scriptResult.blueprint;
    const scenes = blueprint?.structure?.scenes || [];
    // B1-fix: 角色在 character_system.characters，不在 structure.characters
    const characters = blueprint?.character_system?.characters || [];
    // 【v2.1.4-fix13-审计修复】优先从 productionResult.shots 提取实际画面内容
    const shots = productionResult?.shots || [];
    const subtitles = [];

    for (const scene of scenes) {
      const sceneChars = scene.characters || [];
      
      for (const charId of sceneChars) {
        // B1-fix: 兼容 character_id 和 id 两种字段名
        const char = characters.find(c => c.character_id === charId || c.id === charId || c.name === charId);
        if (!char) continue;

        // 生成身份信息介绍（LLM 生成或模板）
        const identity = this.generateCharacterIdentity(char, scene);
        
        subtitles.push({
          type: 'identity_card',
          characterId: charId,
          characterName: char.name || charId,
          sceneId: scene.scene_id,
          // 出现在场景开始的前 3-5 秒
          // B5-fix: start_time → start（与 ScriptBlueprint timing 结构一致）
          start: scene.timing?.start || 0,
          duration: 3.5, // 固定 3.5 秒显示
          // 信息内容
          content: {
            name: char.name || charId,
            title: identity.title,           // 如 "虚构星球探险者"
            species: identity.species,        // 如 "人类"
            trait: identity.trait,            // 如 "银灰装甲"
            role: identity.role               // 如 "主角"
          },
          // 视觉样式（HyperFrames CSS）
          style: {
            position: 'bottom-left',
            fontSize: '24px',
            fontFamily: 'system-ui',
            backgroundColor: 'rgba(0, 0, 0, 0.75)',
            borderLeft: '4px solid #00ff88',
            padding: '12px 20px',
            borderRadius: '0 8px 8px 0',
            animation: 'slideIn 0.5s ease-out'
          }
        });
      }
    }

    return subtitles;
  }

  /**
   * 生成角色身份信息（通用化）
   * B2-fix: 移除 虚构星球 硬编码，从角色数据动态生成
   */
  generateCharacterIdentity(character, scene) {
    const name = character.name || '未知';
    const isProtagonist = character.role === 'protagonist';

    // B2-fix: 从角色数据推断物种/身份
    const species = this.inferSpecies(character);
    const trait = this.extractTrait(character, scene);

    // B2-fix: 通用化标题，基于 role 而非 虚构星球
    let title;
    if (isProtagonist) {
      title = `${species} ${name}`;
    } else if (species.includes('异兽') || species.includes('creature')) {
      title = `${name}`;
    } else {
      title = `${species} ${name}`;
    }

    return {
      name,
      title,
      species,
      trait: trait || '主讲人',
      role: isProtagonist ? '主角' : '配角'
    };
  }

  /**
   * 推断物种（通用化）
   * B2-fix: 移除 example-role/示例神兽 硬编码，基于 visual_anchor 推断
   */
  inferSpecies(character) {
    // B2-fix: 从 visual_anchor.core_features 推断种族
    const features = character.visual_anchor?.core_features || [];
    const featureStr = features.join(' ').toLowerCase();

    // 通用种族判断
    if (featureStr.includes('human') || featureStr.includes('人类') || featureStr.includes('人物')) return '人类';
    if (featureStr.includes('beast') || featureStr.includes('兽') || featureStr.includes('creature')) return '异兽';
    if (featureStr.includes('robot') || featureStr.includes('机器人')) return '机器人';

    // 兜底：从 character_id/name 推断
    const idStr = (character.character_id || character.id || character.name || '').toLowerCase();
    if (idStr.includes('beast') || idStr.includes('兽')) return '异兽';

    return '人物';
  }

  /**
   * 提取特征（通用化）
   * B2-fix: 从 visual_anchor 动态提取，移除硬编码
   */
  extractTrait(character, scene) {
    // B2-fix: 优先从 visual_anchor.core_features 提取前2个特征
    const features = character.visual_anchor?.core_features || [];
    if (features.length > 0) {
      return features.slice(0, 2).join('，');
    }

    // 兜底：从 description 提取
    if (character.voice_profile?.persona) {
      return character.voice_profile.persona.substring(0, 20);
    }

    return '主讲人';
  }

  /**
   * 匹配无版权音乐
   * 
   * 策略：
   * 1. 按场景类型匹配音乐风格
   * 2. 从 Pixabay/Bensound 等免费库获取
   * 3. 使用场景标签搜索
   * 4. 下载并缓存
   */
  async matchMusicTracks(productionResult, scriptResult) {
    const blueprint = scriptResult.blueprint;
    const scenes = blueprint?.structure?.scenes || [];
    const tracks = [];

    for (const scene of scenes) {
      const sceneType = scene.scene_type;
      const mapping = SCENE_MUSIC_MAP[sceneType] || SCENE_MUSIC_MAP.establishing;
      
      tracks.push({
        sceneId: scene.scene_id,
        sceneType: sceneType,
        // 音乐搜索参数（实际使用时调用 API）
        searchParams: {
          mood: mapping.mood,
          genre: mapping.genre,
          tags: mapping.tags,
          duration: scene.timing?.duration || 25, // 匹配场景时长
          // 搜索关键词组合
          query: `${mapping.genre} ${mapping.mood} ${mapping.tags.join(' ')}`
        },
        // 推荐配置
        config: {
          volume: 0.35,           // 背景音乐音量（35%，不盖过台词）
          fadeIn: 2.0,           // 淡入 2 秒
          fadeOut: 3.0,          // 淡出 3 秒
          loop: false            // 不循环（每个场景独立音乐）
        },
        // 音乐来源信息
        source: {
          platform: this.config.musicSource,
          license: ROYALTY_FREE_MUSIC_SOURCES[this.config.musicSource]?.license || 'Unknown',
          url: null,              // 实际下载后填充
          filePath: null          // 本地缓存路径
        }
      });
    }

    return tracks;
  }

  /**
   * 生成弹幕（可选）
   * 
   * 弹幕设计：
   * - 从台词、角色信息、场景描述中提取
   * - 使用 LLM 生成短句弹幕
   * - 不同场景类型有不同弹幕风格
   */
  async generateDanmaku(productionResult, scriptResult) {
    const blueprint = scriptResult.blueprint;
    const scenes = blueprint?.structure?.scenes || [];
    const danmaku = [];

    for (const scene of scenes) {
      const sceneType = scene.scene_type;
      // B5-fix: start_time → start
      const startTime = scene.timing?.start || 0;
      const duration = scene.timing?.duration || 25;
      
      // 根据场景类型生成不同风格的弹幕
      const baseDanmaku = this.generateSceneDanmaku(scene, sceneType);
      
      for (const text of baseDanmaku) {
        danmaku.push({
          text,
          sceneId: scene.scene_id,
          startTime: startTime + Math.random() * duration * 0.8, // 随机分布在场景内
          duration: 4 + Math.random() * 3, // 4-7 秒显示
          speed: 1.0 + Math.random() * 0.5, // 1.0-1.5x 速度
          color: this.getDanmakuColor(sceneType),
          size: this.getDanmakuSize(sceneType),
          position: 'top' // 顶部飘过，避免遮挡画面
        });
      }
    }

    return danmaku;
  }

  generateSceneDanmaku(scene, sceneType) {
    const dialogues = scene.dialogue?.lines || [];
    const setting = scene.setting || '';
    const chars = scene.characters || [];
    
    const danmakuPool = [];
    
    // 从台词提取关键词
    for (const line of dialogues) {
      if (line.text && line.text.length > 5) {
        danmakuPool.push(line.text.substring(0, 15)); // 前15字
      }
    }
    
    // 场景类型弹幕
    // B9-fix: 通用化弹幕，移除神话项目硬编码
    const typeComments = {
      opening: ['🔥 开局！', '⚡ 来了来了', '期待！', '开始了'],
      establishing: ['🌟 好美', '学到了', '涨知识', '有意思'],
      conflict: ['💥 紧张', '小心！', '注意看', '好紧张！'],
      emotional_climax: ['😭 泪目', '太感人了', '讲得太好了', '燃！'],
      resolution: ['✨ 圆满', '期待下一集', '总结到位', '学到了']
    };
    
    if (typeComments[sceneType]) {
      danmakuPool.push(...typeComments[sceneType]);
    }
    
    // 从设定提取关键词弹幕
    if (setting.includes('虚构星球')) danmakuPool.push('虚构星球 星球！');
    if (setting.includes('晶体')) danmakuPool.push('晶体森林！');
    if (setting.includes('双月')) danmakuPool.push('双月当空！');
    if (chars.includes('示例神兽') || chars.includes('示例神兽')) danmakuPool.push('示例神兽！');
    
    // 随机选择 3-5 条
    const count = 3 + Math.floor(Math.random() * 3);
    return this.shuffleArray(danmakuPool).slice(0, count);
  }

  shuffleArray(arr) {
    return arr.sort(() => Math.random() - 0.5);
  }

  getDanmakuColor(sceneType) {
    const colors = {
      opening: '#ff6b6b',
      establishing: '#4ecdc4',
      conflict: '#ff4757',
      emotional_climax: '#ffa502',
      resolution: '#2ed573'
    };
    return colors[sceneType] || '#ffffff';
  }

  getDanmakuSize(sceneType) {
    const sizes = {
      opening: 'large',
      establishing: 'medium',
      conflict: 'large',
      emotional_climax: 'xlarge',
      resolution: 'medium'
    };
    return sizes[sceneType] || 'medium';
  }

  /**
   * 组装不同版本（生成 HyperFrames HTML）
   */
  async assembleVersion(version, productionResult, scriptResult, renderResult, subtitles, musicTracks, danmakuList) {
    const versionConfig = this.getVersionConfig(version);
    
    // 生成 HyperFrames HTML
    const html = this.generateHyperFramesHTML(
      version,
      versionConfig,
      productionResult,
      scriptResult,
      renderResult,
      subtitles,
      musicTracks,
      danmakuList
    );
    
    // 保存 HTML 文件
    const versionDir = path.join(this.config.outputDir, `version-${version}`);
    await fs.mkdir(versionDir, { recursive: true });
    
    const htmlPath = path.join(versionDir, 'composition.html');
    await fs.writeFile(htmlPath, html);
    
    // 保存配置 JSON
    const configPath = path.join(versionDir, 'config.json');
    await fs.writeFile(configPath, JSON.stringify({
      version,
      features: versionConfig,
      subtitleCount: subtitles.length,
      musicTrackCount: musicTracks.length,
      danmakuCount: danmakuList.length,
      generatedAt: new Date().toISOString()
    }, null, 2));
    
    return {
      version,
      htmlPath,
      configPath,
      features: versionConfig,
      // 渲染命令（实际使用时）
      renderCommand: `${this.config.hyperframesBin} render ${htmlPath} --output ${path.join(versionDir, 'output.mp4')}`,
      previewCommand: `${this.config.hyperframesBin} preview ${htmlPath}`
    };
  }

  getVersionConfig(version) {
    const configs = {
      // 标准版：全功能
      standard: {
        subtitles: true,
        music: true,
        danmaku: false, // 标准版无弹幕
        transitions: true,
        titleCard: true
      },
      // 纯净版：无字幕、无音乐、无弹幕
      clean: {
        subtitles: false,
        music: false,
        danmaku: false,
        transitions: true,
        titleCard: false
      },
      // 字幕版：带身份介绍字幕 + 音乐
      subtitled: {
        subtitles: true,
        music: true,
        danmaku: false,
        transitions: true,
        titleCard: true
      },
      // 弹幕版：带弹幕 + 字幕 + 音乐
      danmaku: {
        subtitles: true,
        music: true,
        danmaku: true,
        transitions: true,
        titleCard: true
      },
      // 原始版：仅渲染后的视频，无任何后期
      raw: {
        subtitles: false,
        music: false,
        danmaku: false,
        transitions: false,
        titleCard: false
      }
    };
    
    return configs[version] || configs.standard;
  }

  /**
   * 生成 HyperFrames HTML 合成文件
   * 
   * HyperFrames 格式：
   * - data-composition-id: 合成ID
   * - data-start: 开始时间（秒）
   * - data-duration: 持续时间（秒）
   * - data-track-index: 轨道索引
   * - class="clip": 可剪辑元素
   */
  generateHyperFramesHTML(version, config, productionResult, scriptResult, renderResult, subtitles, musicTracks, danmakuList) {
    const shots = productionResult.shots || [];
    const blueprint = scriptResult.blueprint;
      // B10-fix: 标准输出用 duration 字段，不是 timing.duration
      const totalDuration = shots.reduce((sum, s) => sum + (s.duration || s.timing?.duration || 25), 0);
    
    // 【P0-11 修复】构建 renderResult 映射，消费真实渲染路径
    const renderMap = new Map((renderResult?.results || []).map(r => [r.shotId, r]));
    
    let html = [];
    
    // HTML 头部
    html.push('<!DOCTYPE html>');
    html.push('<html>');
    html.push('<head>');
    html.push('  <meta charset="UTF-8">');
    html.push('  <style>');
    html.push('    * { margin: 0; padding: 0; box-sizing: border-box; }');
    html.push('    body { background: #000; overflow: hidden; }');
    html.push('    #stage { width: 1920px; height: 1080px; position: relative; background: #000; }');
    html.push('    .clip { position: absolute; }');
    html.push('    ');
    html.push('    /* 身份介绍字幕样式 */');
    html.push('    .identity-card { ');
    html.push('      position: absolute; bottom: 80px; left: 60px;');
    html.push('      background: rgba(0, 0, 0, 0.75);');
    html.push('      border-left: 4px solid #00ff88;');
    html.push('      padding: 16px 24px; border-radius: 0 8px 8px 0;');
    html.push('      font-family: system-ui, -apple-system, sans-serif;');
    html.push('      color: white; max-width: 400px;');
    html.push('    }');
    html.push('    .identity-card .name { font-size: 28px; font-weight: bold; margin-bottom: 8px; }');
    html.push('    .identity-card .title { font-size: 18px; color: #ccc; margin-bottom: 4px; }');
    html.push('    .identity-card .trait { font-size: 14px; color: #00ff88; }');
    html.push('    ');
    html.push('    /* 弹幕样式 */');
    html.push('    .danmaku { ');
    html.push('      position: absolute; white-space: nowrap;');
    html.push('      font-family: system-ui, sans-serif; font-weight: bold;');
    html.push('      text-shadow: 1px 1px 2px rgba(0,0,0,0.8);');
    html.push('      pointer-events: none;');
    html.push('    }');
    html.push('    ');
    html.push('    /* 转场遮罩 */');
    html.push('    .transition { ');
    html.push('      position: absolute; top: 0; left: 0; width: 100%; height: 100%;');
    html.push('      background: black; pointer-events: none;');
    html.push('    }');
    html.push('  </style>');
    html.push('</head>');
    html.push('<body>');
    html.push(`<div id="stage" data-composition-id="hyperreality-${version}" data-start="0" data-width="1920" data-height="1080">`);
    html.push('');
    
    let currentTime = 0;
    let trackIndex = 0;
    
    // ========== 视频片段轨道 ==========
    for (let i = 0; i < shots.length; i++) {
      const shot = shots[i];
      // B10-fix: 优先使用顶层 duration 字段
      const duration = shot.duration || shot.timing?.duration || 25;
      
      // 【P0-11 修复】视频源优先使用 renderResult 真实路径，非硬编码文件名
      const renderEntry = renderMap.get(shot.shotId);
      const videoSrc = renderEntry?.videoPath || renderEntry?.videoUrl || `shot-${shot.shotId}.mp4`;
      
      // 视频片段
      html.push(`  <!-- Shot ${shot.shotId} -->`);
      html.push(`  <video class="clip" data-start="${currentTime}" data-duration="${duration}" data-track-index="${trackIndex++}"`);
      html.push(`         src="${videoSrc}" muted playsinline style="width:100%; height:100%;"></video>`);
      html.push('');
      
      // 转场效果（镜头之间）
      if (config.transitions && i < shots.length - 1) {
        html.push(`  <!-- Transition ${shot.shotId} → ${shots[i+1].shotId} -->`);
        html.push(`  <div class="clip transition" data-start="${currentTime + duration - 0.5}" data-duration="0.5" data-track-index="${trackIndex++}"`);
        html.push(`       style="opacity: 0;"></div>`);
        html.push('');
      }
      
      currentTime += duration;
    }
    
    // ========== 字幕轨道（身份介绍式）==========
    if (config.subtitles) {
      html.push('  <!-- 字幕轨道 -->');
      for (const sub of subtitles) {
        html.push(`  <div class="clip identity-card" data-start="${sub.start}" data-duration="${sub.duration}" data-track-index="${trackIndex++}">`);
        html.push(`    <div class="name">${escapeHtml(sub.content.name)}</div>`);
        html.push(`    <div class="title">${escapeHtml(sub.content.title)}</div>`);
        html.push(`    <div class="trait">${escapeHtml(sub.content.species)} · ${escapeHtml(sub.content.trait)}</div>`);
        html.push('  </div>');
      }
      html.push('');
    }
    
    // ========== 音乐轨道 ==========
    if (config.music) {
      html.push('  <!-- 音乐轨道 -->');
      for (const track of musicTracks) {
        const start = track.sceneId ? this.getSceneStartTime(track.sceneId, shots) : 0;
        const duration = track.searchParams?.duration || 25;
        // 【P0-11 修复】音乐源优先使用真实 URL 或 filePath，不存在时不生成 audio 标签
        const musicSrc = track.source?.url || track.filePath;
        if (musicSrc) {
          html.push(`  <audio class="clip" data-start="${start}" data-duration="${duration}" data-track-index="${trackIndex++}"`);
          html.push(`         data-volume="${track.config.volume}" src="${musicSrc}"></audio>`);
        } else {
          html.push(`  <!-- 音乐 ${track.sceneId}: 无可用音源 -->`);
        }
      }
      html.push('');
    }
    
    // ========== 弹幕轨道 ==========
    if (config.danmaku) {
      html.push('  <!-- 弹幕轨道 -->');
      for (const dm of danmakuList) {
        const sizeMap = { small: '20px', medium: '28px', large: '36px', xlarge: '44px' };
        const size = sizeMap[dm.size] || '28px';
        html.push(`  <div class="clip danmaku" data-start="${dm.startTime}" data-duration="${dm.duration}" data-track-index="${trackIndex++}"`);
        html.push(`       style="top: ${50 + Math.random() * 300}px; color: ${dm.color}; font-size: ${size};"`);
        html.push(`       data-speed="${dm.speed}">${escapeHtml(dm.text)}</div>`);
      }
      html.push('');
    }
    
    // ========== GSAP 动画 ==========
    html.push('  <!-- GSAP 动画 -->');
    html.push('  <script src="https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js"></script>');
    html.push('  <script>');
    html.push('    const tl = gsap.timeline({ paused: true });');
    html.push('    ');
    html.push('    // 身份卡片滑入动画');
    html.push('    tl.from(".identity-card", { ');
    html.push('      opacity: 0, x: -100, duration: 0.5, ease: "power2.out", stagger: 0.1 ');
    html.push('    }, 0);');
    html.push('    ');
    html.push('    // 弹幕从右到左动画');
    html.push('    document.querySelectorAll(".danmaku").forEach(d => {');
    html.push('      const speed = parseFloat(d.dataset.speed) || 1;');
    html.push('      const startX = 1920;');
    html.push('      const endX = -d.offsetWidth;');
    html.push('      const duration = (startX - endX) / (200 * speed);');
    html.push('      tl.fromTo(d, ');
    html.push('        { x: startX },');
    html.push('        { x: endX, duration: duration, ease: "linear" },');
    html.push('        parseFloat(d.dataset.start) || 0');
    html.push('      );');
    html.push('    });');
    html.push('    ');
    html.push('    // 转场淡入');
    html.push('    tl.to(".transition", { opacity: 1, duration: 0.25, ease: "power2.in" }, "-=0.5");');
    html.push('    tl.to(".transition", { opacity: 0, duration: 0.25, ease: "power2.out" });');
    html.push('    ');
    html.push('    window.__timelines = window.__timelines || {};');
    html.push(`    window.__timelines["hyperreality-${version}"] = tl;`);
    html.push('  </script>');
    html.push('');
    html.push('</div>'); // #stage
    html.push('</body>');
    html.push('</html>');
    
    return html.join('\n');
  }

  getSceneStartTime(sceneId, shots) {
    let time = 0;
    for (const shot of shots) {
      if (shot.shotId === sceneId || shot.sceneId === sceneId) {
        return time;
      }
      time += shot.duration || shot.timing?.duration || 25;
    }
    return 0;
  }

  /**
   * 质量检查
   */
  async qualityCheck(versions) {
    const fs = require('fs');
    const issues = [];
    
    // 【P1-21 修复】qualityCheck 改为实质性检查：文件存在、引用有效、shots非空
    for (const [version, data] of Object.entries(versions)) {
      // 1. 检查 HTML 文件真实存在
      if (!data.htmlPath) {
        issues.push(`版本 ${version}: HTML 文件路径缺失`);
      } else if (!fs.existsSync(data.htmlPath)) {
        issues.push(`版本 ${version}: HTML 文件不存在 (${data.htmlPath})`);
      }
      
      // 2. 检查 shots 非空
      if (!data.shots || data.shots.length === 0) {
        issues.push(`版本 ${version}: shots 为空`);
      }
      
      // 3. 检查引用的视频/音频文件存在
      if (data.shots && data.shots.length > 0) {
        for (const shot of data.shots) {
          const videoSrc = shot.videoSrc || shot.videoPath || `shot-${shot.shotId}.mp4`;
          if (videoSrc && !videoSrc.startsWith('http') && !fs.existsSync(videoSrc)) {
            issues.push(`版本 ${version}: 视频文件不存在 (${videoSrc})`);
          }
        }
      }
      
      // 4. 检查音乐文件存在
      if (data.musicTracks && data.musicTracks.length > 0) {
        for (const track of data.musicTracks) {
          const musicSrc = track.source?.url || track.filePath;
          if (musicSrc && !musicSrc.startsWith('http') && !fs.existsSync(musicSrc)) {
            issues.push(`版本 ${version}: 音乐文件不存在 (${musicSrc})`);
          }
        }
      }
      
      // 5. 特征配置保留为辅助检查（非阻塞）
      const expectedFeatures = this.getVersionConfig(version);
      if (JSON.stringify(expectedFeatures) !== JSON.stringify(data.features)) {
        issues.push(`版本 ${version}: 特征配置不匹配(警告)`);
      }
    }
    
    return {
      passed: issues.filter(i => !i.includes('(警告)')).length === 0,
      issues
    };
  }

  /**
   * 生成后期制作报告（Markdown）
   */
  generateReport(postResult) {
    const lines = [];
    
    lines.push('# 🎬 后期制作报告');
    lines.push('');
    lines.push(`**版本**: ${this.config.versions.join(', ')}`);
    lines.push(`**状态**: ${postResult.success ? '✅ 成功' : '❌ 失败'}`);
    lines.push(`**总耗时**: ${postResult.timing?.total}ms`);
    lines.push('');
    
    // 各阶段耗时
    lines.push('## ⏱️ 各阶段耗时');
    lines.push('');
    lines.push(`| 阶段 | 耗时 | 产出 |`);
    lines.push(`|------|------|------|`);
    for (const [stage, data] of Object.entries(postResult.stages)) {
      const timing = data.timing || 'N/A';
      const count = data.count || data.tracks?.length || data.list?.length || data.versions?.length || 0;
      lines.push(`| ${stage} | ${timing}ms | ${count} |`);
    }
    lines.push('');
    
    // 版本详情
    lines.push('## 📦 版本详情');
    lines.push('');
    for (const [version, data] of Object.entries(postResult.versions)) {
      lines.push(`### ${version} 版`);
      lines.push(`- HTML: ${data.htmlPath}`);
      lines.push(`- 特征: ${Object.entries(data.features).map(([k, v]) => `${k}=${v}`).join(', ')}`);
      lines.push(`- 渲染命令: \`${data.renderCommand}\``);
      lines.push('');
    }
    
    // 字幕预览
    if (postResult.stages.subtitles?.tracks?.length > 0) {
      lines.push('## 🎭 字幕预览（身份介绍式）');
      lines.push('');
      lines.push(`| 角色 | 场景 | 时长 | 内容 |`);
      lines.push(`|------|------|------|------|`);
      for (const sub of postResult.stages.subtitles.tracks.slice(0, 5)) {
        lines.push(`| ${sub.characterName} | ${sub.sceneId} | ${sub.duration}s | ${sub.content.title} |`);
      }
      lines.push('');
    }
    
    // 音乐预览
    if (postResult.stages.music?.tracks?.length > 0) {
      lines.push('## 🎵 音乐配置');
      lines.push('');
      lines.push(`| 场景 | 风格 | 情绪 | 音量 | 淡入/出 |`);
      lines.push(`|------|------|------|------|--------|`);
      for (const track of postResult.stages.music.tracks.slice(0, 5)) {
        lines.push(`| ${track.sceneId} | ${track.searchParams.genre} | ${track.searchParams.mood} | ${track.config.volume} | ${track.config.fadeIn}s/${track.config.fadeOut}s |`);
      }
      lines.push('');
    }
    
    lines.push('---');
    lines.push(`*生成时间: ${new Date().toISOString()}*`);
    
    return lines.join('\n');
  }
}

module.exports = { PostProductionEngine, SCENE_MUSIC_MAP, ROYALTY_FREE_MUSIC_SOURCES };
