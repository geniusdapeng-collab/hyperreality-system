/**
 * AudioDesignAgent - 音频设计Agent（软性优化版）
 * 负责: 环境音效设计 + 视听融合描述
 * 
 * 优化内容：增强prompt模板，融入视听融合指导原则和场景情绪曲线
 * 调用子系统：audio-design-agent自身优化 + narrative-rhythm-adapter知识体系
 * 优化日期：2026-07-15
 * 约束：数据结构不变、接口契约不变、文件结构不变
 */

const { BaseAgent } = require('./base-agent');

class AudioDesignAgent extends BaseAgent {
  constructor(options = {}) {
    super({ name: 'AudioDesignAgent', ...options });
  }

  /**
   * 获取系统Prompt（优化版：增加视听融合指导）
   * 优化点：融入视听同步原则、情绪曲线音频映射、环境音效的电影化描述
   */
  _getSystemPrompt() {
    return `你是一位专业的声音设计师，精通影视声音设计和视听融合理论。

## 核心能力
根据场景信息，为每个镜头设计环境音效，确保音频与画面在情绪、节奏、空间三个维度上完美融合。

## 视听融合原则（优化新增）

### 1. 情绪同步原则
- 音频情绪必须与画面情绪同频共振
- 紧张画面→紧张音效（心跳加速的低频脉冲、不规则节奏）
- 平静画面→平静音效（稳定的自然声、柔和的环境底噪）
- 悲伤画面→悲伤音效（空旷回声、轻微失真、低频削减）
- 史诗画面→史诗音效（宏大混响、多层次音场、低频饱满）

### 2. 节奏同步原则（优化新增）
- 音频节奏必须与镜头运动匹配
- 推镜头→音强渐增（crescendo）
- 拉镜头→音强渐减（decrescendo）
- 固定镜头→稳定的背景音
- 快速剪辑→音效碎片化、节奏密集
- 慢速长镜头→音效延展、混响拉长

### 3. 空间同步原则（优化新增）
- 音频空间感必须与画面景别匹配
- 特写镜头→近场音效（细节清晰、亲密感）
- 全景镜头→远场音效（环境声为主、空间感大）
- 室内场景→封闭空间混响（短混响、声音偏干）
- 室外场景→开放空间混响（长混响、声音偏湿）

### 4. 频率映射原则（优化新增）
- 低频（20-250Hz）：对应画面的"重量感"——大地的震动、心跳、低音弦乐
- 中频（250-4kHz）：对应画面的"人声区域"——对话、脚步、主要动作声
- 高频（4k-20kHz）：对应画面的"细节感"——金属碰撞、风声、水声、环境微声

## 设计规范
1. 音效要与场景环境匹配：户外有风声/鸟鸣，室内有空调/人声
2. 音效强度服务情绪：紧张场景音强高，平静场景音强弱
3. 相邻镜头音效要有过渡和连贯性
4. 【优化新增】每个镜头的音效必须有明确的"情绪频率签名"（哪个频段主导）
5. 【优化新增】音效描述必须包含空间定位（前景/中景/背景音层）

输出JSON格式:
{
  "shots": [
    {
      "shotId": "SC01",
      "backgroundSound": {
        "environment": "环境音类型",
        "description": "详细音效描述（必须包含空间定位和情绪频率签名）",
        "intensity": "low/medium/high",
        "spatialLayer": "foreground/midground/background",
        "frequencySignature": "low/mid/high/full-spectrum"
      },
      "backgroundSoundString": "音效描述文本（电影化描述，包含视听融合要素）"
    }
  ]
}`;
  }

  /**
   * 处理shots（优化版：增加视听融合上下文）
   * @param {Array} shots - shots数组（数据结构不变）
   * @param {Object} blueprint - 蓝图（数据结构不变）
   * @returns {Object} 处理结果（接口契约不变）
   */
  async process(shots, blueprint) {
    console.log(`[AudioDesignAgent] 开始处理 ${shots.length} 个镜头...`);

    // 【优化新增】提取场景情绪曲线信息，用于指导音频设计
    const emotionCurveInfo = this._extractEmotionCurveInfo(shots, blueprint);

    const prompt = this._buildPrompt(shots, blueprint, emotionCurveInfo);

    const schema = {
      required: ['shots'], requiredArrays: ['shots'], rejectEmptyArray: true,
    };

    const llmResult = await this._callLLM(prompt, schema, () => {
      return this._fallback(shots);
    });

    if (llmResult.degraded) {
      return { shots: llmResult.result?.shots || shots, degraded: true, degradeReason: llmResult.degradeReason };
    }

    const designedShots = shots.map((shot) => {
      const designed = llmResult.result?.shots?.find(s => s.shotId === shot.shotId) || {};
      const bgSound = designed.backgroundSound || shot.backgroundSound;
      const bgSoundStr = designed.backgroundSoundString || shot.backgroundSoundString || '';
      // 同时输出 audio 字段，兼容25字段标准
      const audioStr = bgSoundStr || (bgSound ? `${bgSound.environment}: ${bgSound.description} (intensity: ${bgSound.intensity})` : '');

      // 【优化新增】融入视听融合描述
      const audiovisualFusion = this._buildAudiovisualFusion(shot, bgSound);

      return {
        ...shot,
        backgroundSound: bgSound,
        backgroundSoundString: bgSoundStr,
        audio: audioStr,
        // 【优化新增】增加视听融合标记（不改变原有字段，新增扩展字段）
        _audiovisualFusion: audiovisualFusion
      };
    });

    console.log(`[AudioDesignAgent] 完成 ✓`);
    return { shots: designedShots, degraded: false, degradeReason: null };
  }

  /**
   * 构建Prompt（优化版：融入情绪曲线和视听融合指导）
   */
  _buildPrompt(shots, blueprint, emotionCurveInfo) {
    const shotsInfo = shots.map(s => {
      const blocks = s.dialogueBlocks || [];
      const mannerInfo = blocks.map(b => `[${b.speaker}] ${b.manner || '无说话方式'}`).join('; ');

      // 【优化新增】为每个镜头提取视听融合上下文
      const cameraMovement = s.camera_movement || s.camera || '';
      const shotSize = s.shot_size || s.composition || '';
      const emotion = s.emotion_target || s.mood || '';

      return `镜头 ${s.shotId}: 场景"${(s.scene || '').substring(0, 50)}", 情绪"${s.mood || ''}", 说话方式"${mannerInfo.substring(0, 100)}"
【视听上下文】景别:${shotSize}, 运镜:${cameraMovement}, 情绪目标:${emotion}`;
    }).join('\n');

    // 【优化新增】构建情绪曲线指导文本
    const rhythmGuidance = emotionCurveInfo
      ? `\n## 场景情绪曲线\n${emotionCurveInfo}\n请确保音频设计严格跟随情绪曲线：上升时音强渐增，下降时音强渐减，转折点时音效有明确的"情绪标记"。`
      : '';
    
    // 【接线1 修复】提取 PRD 音频规格并注入 prompt
    const prd = blueprint?._prd || blueprint?.meta?._prd || null;
    const audioSpec = prd?.productionSpecification?.audioSpecification || prd?.audioSpecification || null;
    
    let audioSpecSection = '';
    if (audioSpec) {
      audioSpecSection = `\n## PRD 音频规格（必须遵循）\n` +
        `- 音乐风格: ${audioSpec.musicStyle || '未指定'}\n` +
        `- 音效设计方向: ${audioSpec.soundDesign || '未指定'}\n` +
        `- 配音策略: ${audioSpec.voicePolicy || '未指定'}\n` +
        `- 音频情绪: ${audioSpec.audioMood || '未指定'}\n` +
        (audioSpec.audioReferences?.length ? `- 音频参考: ${audioSpec.audioReferences.slice(0, 3).join(', ')}\n` : '');
    }

    return `## 镜头场景
${shotsInfo}
${rhythmGuidance}${audioSpecSection}

## 任务
为每个镜头设计环境音效。

【重要】每个镜头的"说话方式"信息已提供，你的音频设计必须与之配合：
- 如果说话方式是"quietly"，环境音强度应低（low），背景安静，突出角色低语
- 如果说话方式是"direct-address"，环境音应干净（low-medium），避免干扰直接对话
- 如果说话方式是"with a smile"，环境音可温暖柔和，氛围轻松

${audioSpec ? '【强制】以上音频设计必须严格遵循 PRD 音频规格中的音乐风格、音效方向和配音策略。' : ''}
- 如果说话方式是"firmly"，环境音可略高（medium），增强力量感

【优化新增】每个镜头的音效设计必须包含：
1. environment: 环境音类型（outdoor_urban/indoor_office/hospital/park等）
2. description: 音效描述（15-30字，必须呼应说话方式，包含空间定位和情绪频率签名）
3. intensity: 强度（low/medium/high，与说话方式匹配）
4. spatialLayer: 空间层次（foreground/midground/background，与景别匹配）
5. frequencySignature: 频率签名（low/mid/high/full-spectrum，与画面情绪匹配）

背景音描述必须是一个连贯的电影化句子，而非简单的关键词列表。

【声音设计心法】
1. 安静是全片最贵的声音：留白场景的环境音强度必须降到全片最低（甚至一声鸟叫都嫌多），否则后面的爆发没有落差。
2. 每个镜头指定一个'声音签名'——那颗观众闭上眼睛也能认出这场戏的声音：蝉鸣/麻绳摩擦/一声'绷'/两万人号子。一镜一个，多了就是噪音。
3. 高潮的声音往往是'小动作的放大'：咬牙声、绳绷紧声贴到前景，比配乐砸下来更致命。
4. 配乐做减法：60秒短片，弦乐长音≤2处进点，进点必须是情绪转折点（闪回/咬绳），其余交给环境音。结尾音乐让位给环境声回归（号子退潮后一声蝉鸣）。
5. 人声混响从干到湿对应距离感：低语=极干贴耳；号子=大空间全频场。台词再轻也要在声浪里清晰可辨。
6. 首尾声音闭环：开头出现过的环境音，结尾让它回来（蝉鸣→号子→蝉鸣），观众会无意识地感到'圆满'。

输出JSON: {"shots": [{"shotId":"SC01","backgroundSound":{"environment":"...","description":"...","intensity":"...","spatialLayer":"...","frequencySignature":"..."}}]}`;
  }

  /**
   * 【优化新增】提取场景情绪曲线信息
   * 用于指导音频设计的情绪起伏
   */
  _extractEmotionCurveInfo(shots, blueprint) {
    if (!shots || shots.length === 0) return null;

    const emotions = shots.map(s => ({
      shotId: s.shotId,
      emotion: s.emotion_target || s.mood || 'neutral',
      intensity: this._estimateEmotionIntensity(s)
    }));

    // 构建情绪曲线描述
    const parts = [];
    parts.push(`整体情绪走向: ${emotions.map(e => `${e.shotId}=${e.emotion}(${e.intensity})`).join(' → ')}`);

    // 检测情绪转折点
    for (let i = 1; i < emotions.length; i++) {
      const prev = emotions[i - 1];
      const curr = emotions[i];
      if (Math.abs(curr.intensity - prev.intensity) >= 2) {
        const direction = curr.intensity > prev.intensity ? '上升' : '下降';
        parts.push(`情绪转折点: ${prev.shotId}→${curr.shotId} 情绪${direction} (${prev.intensity}→${curr.intensity})`);
      }
    }

    return parts.join('\n');
  }

  /**
   * 【优化新增辅助】估算情绪强度
   */
  _estimateEmotionIntensity(shot) {
    const emotion = (shot.emotion_target || shot.mood || '').toLowerCase();
    const intensityMap = {
      'fear': 9, 'terror': 10, 'panic': 9,
      'anger': 8, 'rage': 9,
      'sadness': 6, 'grief': 8, 'despair': 9,
      'joy': 7, 'ecstasy': 9,
      'curious': 4, 'wonder': 5,
      'tense': 7, 'anxious': 6,
      'calm': 2, 'peaceful': 1,
      'epic': 8, 'awe': 7,
      'mysterious': 5, 'suspense': 6
    };
    return intensityMap[emotion] || 5;
  }

  /**
   * 【优化新增】构建视听融合描述
   * 用于将音频设计与画面描述融合
   */
  _buildAudiovisualFusion(shot, bgSound) {
    if (!bgSound || !shot) return null;

    const fusion = {
      audioVisualSync: '',
      spatialAudio: '',
      emotionalResonance: '',
      rhythmAlignment: ''
    };

    // 视听同步描述
    const cameraMovement = shot.camera_movement || shot.camera || '';
    if (cameraMovement.includes('push') || cameraMovement.includes('dolly in')) {
      fusion.audioVisualSync = 'audio intensity follows camera push — crescendo as we move closer';
    } else if (cameraMovement.includes('pull') || cameraMovement.includes('dolly out')) {
      fusion.audioVisualSync = 'audio expands with camera pull — wider soundscape as perspective opens';
    } else if (cameraMovement.includes('static') || cameraMovement.includes('lock')) {
      fusion.audioVisualSync = 'stable ambient bed supporting static frame — sound breathes naturally';
    }

    // 空间音频描述
    if (bgSound.spatialLayer) {
      const spatialMap = {
        'foreground': 'intimate close-field audio, details audible, personal space sound',
        'midground': 'balanced spatial audio, subject-centered sound field',
        'background': 'expansive distant ambience, environmental context sound'
      };
      fusion.spatialAudio = spatialMap[bgSound.spatialLayer] || 'balanced spatial audio';
    }

    // 情绪共振描述
    if (bgSound.frequencySignature) {
      const freqMap = {
        'low': 'weighty low-frequency presence grounding the emotional weight',
        'mid': 'vocal-range mid-frequencies carrying emotional narrative',
        'high': 'crystalline high-frequency detail adding tension and alertness',
        'full-spectrum': 'rich full-spectrum sound enveloping the scene completely'
      };
      fusion.emotionalResonance = freqMap[bgSound.frequencySignature] || '';
    }

    // 节奏对齐描述
    const rhythm = shot.rhythm_level || shot.pacing || '';
    if (rhythm.includes('fast') || rhythm.includes('快')) {
      fusion.rhythmAlignment = 'rapid audio cuts matching visual pace — staccato sound rhythm';
    } else if (rhythm.includes('slow') || rhythm.includes('缓') || rhythm.includes('静')) {
      fusion.rhythmAlignment = 'elongated audio decay matching slow visual pace — legato sound flow';
    }

    return fusion;
  }

  _fallback(shots) {
    console.log(`[AudioDesignAgent] 使用降级规则...`);
    return {
      shots: shots.map(shot => ({
        ...shot,
        shotId: shot.shotId,
        backgroundSound: shot.backgroundSound,
        backgroundSoundString: shot.backgroundSoundString || ''
      }))
    };
  }
}

module.exports = { AudioDesignAgent };
