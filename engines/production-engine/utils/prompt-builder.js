/**
 * PromptBuilder - Prompt 构建与截断引擎
 * 
 * 职责：
 * - 构建单个镜头的完整 Prompt（L1-L9 七层架构）
 * - 优先级截断策略
 * - 字符计数
 */

class PromptBuilder {
  constructor(config = { maxPromptLength: 2000 }) {
    this.config = config;
  }

  /**
   * 构建单个镜头的完整 Prompt
   */
  buildShotPrompt(shot, blueprint, structuredStrings = {}, negativePromptInjector = null) {
    const { cameraStr, lightingStr, timelineStr } = structuredStrings;
    const hasFusion = shot.fusionText && shot.fusionText.length > 10;
    const _meta = blueprint._metadata || blueprint.config?._metadata || {};

    const parts = [];
    const partMeta = [];

    // === L1: 约束层 ===
    const ratio = blueprint.config?.aspectRatio || '16:9';
    const isOpening = shot.sceneType === 'opening' || shot.sceneType === 'establish';
    let negativePrompt = '';
    if (negativePromptInjector) {
      negativePrompt = isOpening
        ? negativePromptInjector.generateForOpeningShot({ maxLength: 250 })
        : negativePromptInjector.generateForContentShot({ maxLength: 300 });
      negativePrompt = negativePrompt.replace('【负面约束】', '');
    }
    const l1Constraint = `${ratio} cinematic, 24fps cinematic, ${negativePrompt}`;
    parts.push(`【约束】${l1Constraint}`);
    partMeta.push({ id: 'L1_constraint', priority: 'P0' });

    // === L2: 基础层 ===
    parts.push('【基础】hyperrealistic, ultra-detailed, high dynamic range, detail in highlights and shadows, film grain, 35mm texture, cinematic film');
    partMeta.push({ id: 'L2_base', priority: 'P0' });

    // === L3-L4: 空间层 + 主体层 ===
    if (hasFusion) {
      parts.push(`【场景】${shot.fusionText}`);
      partMeta.push({ id: 'L3-L7_fusion', priority: 'P1' });
    } else {
      if (shot.scene) {
        parts.push(`【场景】${shot.scene}`);
        partMeta.push({ id: 'L3_scene', priority: 'P1' });
      }
      if (shot.character && shot.character !== 'NONE') {
        parts.push(`【角色】${shot.character}`);
        partMeta.push({ id: 'L4_character', priority: 'P0' });
      }
      if (shot.action) {
        parts.push(`【动作】${shot.action}`);
        partMeta.push({ id: 'L4_action', priority: 'P1' });
      }
    }

    if (shot.characterRef && shot.characterRef !== 'NONE') {
      parts.push(`【定妆照】${shot.characterRef}`);
      partMeta.push({ id: 'L4_characterRef', priority: 'P0' });
    }

    // 台词
    if (shot.dialogueText && shot.dialogueText !== '') {
      const pureDialogue = shot.dialogueText.replace(/;/g, '；');
      parts.push(`"${pureDialogue}"`);
      partMeta.push({ id: 'L4_dialogue', priority: 'P0' });
    } else if (shot.dialogue && shot.dialogue !== '') {
      const pureDialogue = shot.dialogue.replace(/[^:]+:([^;]+);/g, '$1').replace(/LIP_SYNC:YES/g, '').replace(/;+/g, '；').replace(/^;+|;+$/g, '').trim();
      if (pureDialogue) {
        parts.push(`"${pureDialogue}"`);
        partMeta.push({ id: 'L4_dialogue', priority: 'P0' });
      }
    }

    // === L5: 动态层 ===
    const camera = cameraStr || (typeof shot.camera === 'string' ? shot.camera : '');
    if (camera) {
      parts.push(`【运镜】${camera}`);
      partMeta.push({ id: 'L5_camera', priority: 'P1' });
    }

    const timeline = timelineStr || (typeof shot.timeline === 'string' ? shot.timeline : '');
    if (timeline) {
      parts.push(`【时间轴】${timeline}`);
      partMeta.push({ id: 'L5_timeline', priority: 'P2' });
    }

    // === L6: 风格层 ===
    if (shot.mood) {
      parts.push(`【情绪】${shot.mood}`);
      partMeta.push({ id: 'L6_mood', priority: 'P2' });
    }

    const lighting = lightingStr || (typeof shot.lighting === 'string' ? shot.lighting : '');
    if (lighting) {
      parts.push(`【灯光】${lighting}`);
      partMeta.push({ id: 'L6_lighting', priority: 'P1' });
    }

    // === L7: 音频层 ===
    const bgSound = shot.backgroundSound?.string || shot.backgroundSound;
    if (bgSound && typeof bgSound === 'string') {
      parts.push(`【音频】${bgSound}`);
      partMeta.push({ id: 'L7_audio', priority: 'P1' });
    }

    const audioLayer = shot.audioLayer?.string || shot.audioLayer;
    if (audioLayer && audioLayer !== '' && typeof audioLayer === 'string') {
      parts.push(`【音频层】${audioLayer}`);
      partMeta.push({ id: 'L7_audio', priority: 'P1' });
    }

    // === L8: 内部层 ===
    ['physicsLayer', 'colorScience', 'renderStyle', 'directorStyle'].forEach(field => {
      if (shot[field] && shot[field] !== '') {
        parts.push(`【${field === 'physicsLayer' ? '物理' : field === 'colorScience' ? '色彩' : field === 'renderStyle' ? '渲染' : '导演'}】${shot[field]}`);
        partMeta.push({ id: 'L8_internal', priority: 'P2' });
      }
    });

    // === L9: 质控层 ===
    if (shot.worldId && shot.worldId !== 'default') {
      parts.push(`${shot.worldId} world`);
    }

    const negativeConstraints = [
      '【负面约束】no watermark, no logo, no text overlay, no subtitle, no caption, no text anywhere in frame, no readable characters, no alphabets, no Chinese characters',
      '【负面约束】no text on walls, no text on objects, no text on documents, no text on signs, no text on labels, no text on screens, no text on clothing, no text in background',
      '【负面约束】no brand logos with text, no text in medical charts, no text on posters, no text on billboards, no text on packaging, no handwritten text, no printed text, no signage text',
      '【负面约束】no text overlays, no UI elements with text, no text on book covers, no text on medicine bottles, no text on report forms, no text on devices, no text on badges, no text on nameplates',
      '【负面约束】no text on doors, no text on windows, no text on floors, no text on ceilings',
      '【负面约束】blurry, low resolution, pixelated, compression artifacts',
      '【负面约束】cartoon, anime, illustration, 3D render look, CGI appearance, plastic look',
      '【负面约束】distorted perspective, impossible geometry, floating objects',
      '【负面约束】flat lighting, overexposed, crushed blacks, double shadows',
      '【负面约束】unnatural physics, fake water, static water, cardboard texture, plastic foliage'
    ];

    if (shot.characters?.length > 0 || shot.character) {
      negativeConstraints.push('【负面约束】distorted face, deformed face, extra fingers, plastic skin, waxy skin, unnatural pose');
    }
    if (shot.worldId && shot.worldId !== 'default') {
      negativeConstraints.push('【负面约束】natural eye colors only, no metallic shine');
    }
    parts.push(...negativeConstraints);
    partMeta.push({ id: 'L9_negative', priority: 'P0' });

    if (shot.characters?.length > 0) {
      parts.push(`【角色一致性】保持${shot.characters.join('、')}形象一致,杜绝分身重影`);
    }

    const fullPrompt = parts.join(',');
    const truncated = this._truncateWithPriority(fullPrompt, this.config.maxPromptLength, partMeta, parts);
    const stripPipes = (str) => str.replace(/\|/g, '; ');

    return {
      fullPrompt: stripPipes(truncated),
      rawPrompt: fullPrompt,
      parts,
      partMeta,
      wasTruncated: fullPrompt.length !== truncated.length,
      audioIncluded: !!shot.backgroundSound
    };
  }

  /**
   * 优先级截断
   */
  _truncateWithPriority(prompt, maxLength, partMeta, parts) {
    if (prompt.length <= maxLength) return prompt;

    let workingParts = parts.map((p, i) => {
      if (partMeta[i]?.priority === 'P2') return this._minimizePart(p, 'P2');
      return p;
    });
    let result = workingParts.join(',');
    if (result.length <= maxLength) return result;

    workingParts = parts.map((p, i) => {
      if (partMeta[i]?.priority === 'P2') return this._minimizePart(p, 'P2');
      if (partMeta[i]?.priority === 'P1') return this._minimizePart(p, 'P1');
      return p;
    });
    result = workingParts.join(',');
    if (result.length <= maxLength) return result;

    const p2Indices = partMeta.map((m, i) => m?.priority === 'P2' ? i : -1).filter(i => i >= 0);
    for (const idx of p2Indices.slice().reverse()) {
      workingParts[idx] = null;
      result = workingParts.filter(p => p !== null).join(',');
      if (result.length <= maxLength) return result;
    }

    const p1Indices = partMeta.map((m, i) => m?.priority === 'P1' ? i : -1).filter(i => i >= 0);
    for (const idx of p1Indices.slice().reverse()) {
      workingParts[idx] = null;
      result = workingParts.filter(p => p !== null).join(',');
      if (result.length <= maxLength) return result;
    }

    return result.substring(0, maxLength);
  }

  _minimizePart(part, priority) {
    if (priority === 'P2') return part.substring(0, 20) + '...';
    if (priority === 'P1') {
      const core = part.split(/[,,]/)[0];
      return core.length < part.length ? core + '...' : part;
    }
    return part;
  }

  /**
   * 截断保护（保留音频层和角色一致性）
   */
  truncatePromptWithAudioProtection(prompt, maxLength) {
    if (prompt.length <= maxLength) return prompt;

    const lastPart = '角色一致性:保持形象一致,杜绝分身重影';
    const hasAudio = prompt.includes('伴随') && prompt.includes('氛围弥漫');
    let audioPart = '';
    if (hasAudio) {
      const audioMatch = prompt.match(/伴随[^,]*,[^,]*氛围弥漫[^,]*(?:,[^,]*声画精准同步[^,]*)?/);
      if (audioMatch) audioPart = audioMatch[0];
    }

    const protectParts = [lastPart];
    if (audioPart) protectParts.unshift(audioPart);

    const protectText = protectParts.join(',');
    const availableLength = maxLength - protectText.length - 2;

    if (availableLength > 50) {
      return prompt.substring(0, availableLength) + ',' + protectText;
    }
    return prompt.substring(0, maxLength);
  }

  truncatePrompt(prompt, maxLength) {
    return this.truncatePromptWithAudioProtection(prompt, maxLength);
  }

  countChars(text) {
    if (!text) return 0;
    let count = 0;
    for (const char of text) { count++; }
    return count;
  }
}

module.exports = { PromptBuilder };
