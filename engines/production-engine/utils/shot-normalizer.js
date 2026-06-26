/**
 * ShotNormalizer - 镜头标准化与构建工具
 * 
 * 职责：
 * - 标准化 LLM 输出
 * - 构建 mood、action、characterRef、backgroundSound
 * - 提取场景信息
 */

const fs = require('fs');
const path = require('path');

class ShotNormalizer {
  constructor(config = {}) {
    this.config = config;
  }

  /**
   * 标准化 LLM 输出
   */
  normalizeLLMOutput(shots, blueprint) {
    const characters = blueprint.characters || [];
    return shots.map(shot => {
      const normalized = { ...shot };

      // 确保字符字段为字符串
      if (shot.camera && typeof shot.camera === 'object') {
        normalized.cameraString = this._objectToString(shot.camera);
      }
      if (shot.lighting && typeof shot.lighting === 'object') {
        normalized.lightingString = this._objectToString(shot.lighting);
      }
      if (shot.timeline && typeof shot.timeline === 'object') {
        normalized.timelineString = this._objectToString(shot.timeline);
      }

      // 确保角色引用正确
      if (shot.characters && Array.isArray(shot.characters)) {
        normalized.characterRef = this.buildCharacterRef(shot, characters);
      }

      return normalized;
    });
  }

  _objectToString(obj) {
    if (typeof obj === 'string') return obj;
    if (Array.isArray(obj)) return obj.join(', ');
    if (typeof obj === 'object' && obj !== null) {
      return Object.entries(obj).map(([k, v]) => `${k}: ${v}`).join(', ');
    }
    return String(obj);
  }

  /**
   * 构建 mood
   */
  buildMood(scene) {
    if (scene.emotional_target) {
      const et = scene.emotional_target;
      const moods = [];
      if (et.valence > 0.5) moods.push('hopeful', 'positive');
      else if (et.valence < -0.3) moods.push('tense', 'serious');
      else moods.push('neutral', 'calm');

      if (et.arousal > 0.7) moods.push('intense', 'dramatic');
      else if (et.arousal < 0.3) moods.push('peaceful', 'gentle');

      if (scene.mood_tags && Array.isArray(scene.mood_tags)) {
        moods.push(...scene.mood_tags.slice(0, 2));
      }
      if (moods.length >= 3) return moods.slice(0, 5).join(', ');
    }

    const moodMap = {
      'opening': 'epic, mysterious, awe-inspiring',
      'establishing': 'mysterious, anticipation, wonder',
      'conflict': 'tense, determined, brave, confrontational',
      'emotional_climax': 'epic, emotional, powerful, cathartic',
      'resolution': 'peaceful, warm, nostalgic, hopeful',
      'discovery': 'curious, excited, surprised, wondrous',
      'transition': 'flowing, continuous, seamless'
    };
    return moodMap[scene.scene_type] || 'neutral, calm, steady';
  }

  /**
   * 构建 action
   */
  buildAction(scene) {
    if (scene.action && scene.action.length > 5) return scene.action;
    if (scene.visual_notes && scene.visual_notes.length > 5) return scene.visual_notes;

    if (scene.dialogue?.lines?.[0]?.text) {
      const emotion = scene.dialogue.lines[0].emotion || '';
      if (emotion.includes('紧张') || emotion.includes('tense')) {
        return 'tense posture, direct gaze, deliberate movement';
      }
      if (emotion.includes('兴奋') || emotion.includes('excited')) {
        return 'animated gesture, energetic movement, expressive';
      }
      return 'speaking to camera, clear hand gestures, professional delivery';
    }

    const actionMap = {
      'opening': 'establishing shot, camera slowly descending',
      'establishing': 'wide shot revealing environment',
      'conflict': 'confrontational stance, dynamic movement',
      'emotional_climax': 'intense emotional expression',
      'resolution': 'peaceful resolution gesture',
      'discovery': 'curious exploration, examining'
    };
    return actionMap[scene.scene_type] || 'neutral stance';
  }

  /**
   * 构建 characterRef
   */
  buildCharacterRef(scene, characters) {
    const refs = (scene.characters || []).map(cid => {
      let char = characters.find(c => c.character_id === cid);
      if (!char) char = characters.find(c => c.name === cid);
      if (!char) return null;

      const existingPaths = [];
      const refImages = char.visual_anchor?.reference_images || [];
      if (Array.isArray(refImages) && refImages.length > 0) {
        existingPaths.push(...refImages.filter(p => p && typeof p === 'string'));
      }
      if (char.portraits && typeof char.portraits === 'object') {
        existingPaths.push(...Object.values(char.portraits).filter(p => p && typeof p === 'string'));
      }
      if (Array.isArray(char.portraitPaths)) {
        existingPaths.push(...char.portraitPaths.filter(p => p && typeof p === 'string'));
      }

      const uniquePaths = [...new Set(existingPaths)];
      if (uniquePaths.length > 0) {
        return `${char.name}: ${uniquePaths.join(', ')}`;
      }

      // 兜底：搜索文件系统
      const charDir = char.character_id || cid;
      const baseDir = this.config?.charactersDir || 'characters';
      const foundPaths = this._searchPortraitFiles(charDir, char.name, baseDir);
      if (foundPaths.length > 0) {
        return `${char.name}: ${foundPaths.join(', ')}`;
      }

      return `${char.name}: PENDING_GENERATION`;
    }).filter(Boolean);

    return refs.length > 0 ? refs.join('; ') : 'NONE';
  }

  _searchPortraitFiles(charDir, charName, baseDir) {
    const foundPaths = [];
    const defaultAngles = ['front', 'profile', 'three-quarter', 'closeup', 'side', 'threeQuarter'];

    const searchDirRecursive = (dir) => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            searchDirRecursive(fullPath);
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) continue;
            const basename = path.basename(entry.name, ext);
            const isMatch = (basename.includes(charDir) || basename.includes(charName)) &&
              defaultAngles.some(angle => basename.includes(angle));
            if (isMatch) {
              const relativePath = path.relative(baseDir, fullPath);
              foundPaths.push(`image://characters/${relativePath}`);
            }
          }
        }
      } catch (e) {
        // 忽略目录不存在错误
      }
    };

    try {
      searchDirRecursive(baseDir);
    } catch (e) {
      // 忽略
    }
    return foundPaths;
  }

  /**
   * 构建 backgroundSound
   */
  buildBackgroundSound(shot) {
    const type = shot.sceneType || 'normal';
    const soundMap = {
      'opening': {
        ambient: 'deep earth rumble 20-60Hz, epic atmosphere',
        spatial: '3D audio pan synchronized with camera movement',
        intensity: { crescendo: '0-3s', peak: '3-7s', decay: '7-10s' }
      },
      'establishing': {
        ambient: 'natural environment, wind and distant sounds',
        spatial: 'ambient stereo field',
        intensity: { steady: '0-100%', variations: 'subtle' }
      },
      'conflict': {
        ambient: 'tension building, low frequency rumble',
        spatial: 'directional audio pan',
        intensity: { building: '0-5s', peak: '5-8s', decay: '8-10s' }
      },
      'emotional_climax': {
        ambient: 'full frequency spectrum, rich harmonics',
        spatial: 'immersive surround',
        intensity: { maximum: '0-3s', sustain: '3-10s' }
      },
      'resolution': {
        ambient: 'gentle atmosphere, soft reverb',
        spatial: 'wide stereo field',
        intensity: { fading: '0-5s', quiet: '5-10s' }
      }
    };

    const soundObj = soundMap[type] || {
      ambient: 'neutral atmosphere',
      spatial: 'centered mono',
      intensity: { steady: '100%' }
    };

    const intensityStr = Object.entries(soundObj.intensity).map(([k, v]) => `${k} ${v}`).join(', ');
    const soundStr = `AMBIENT: ${soundObj.ambient}; SPATIAL: ${soundObj.spatial}; INTENSITY: ${intensityStr}`;

    return { object: soundObj, string: soundStr };
  }

  /**
   * 构建 audioLayer
   */
  buildAudioLayer() {
    const segments = [
      { time: '0-3s', sound: 'sub-bass earth rumble fade in' },
      { time: '3-5s', sound: 'distant wind and environmental sounds' },
      { time: '5-8s', sound: 'string section long note' },
      { time: '8-10s', sound: 'timpani strike' }
    ];
    return {
      object: { segments },
      string: segments.map(s => s.sound).join(', ')
    };
  }

  /**
   * 构建 titleOverlay
   */
  buildTitleOverlay(blueprint) {
    const config = blueprint.config || {};
    const worldSetting = blueprint.worldSetting || {};
    const _metadata = config._metadata || blueprint._metadata || {};
    const title = _metadata.displayTitle || config.title || '未命名';
    const subtitle = worldSetting.name || _metadata.seriesName || '系列作品';
    const producer = config.producer || 'HAVS Team';

    return {
      object: {
        mainTitle: title,
        subtitle,
        producer: `by ${producer}`,
        titleAnim: 'light-vein carving growth 3.0-5.0s'
      },
      string: `MAIN_TITLE: "${title}"; SUBTITLE: "${subtitle}"; PRODUCER: "by ${producer}"; TITLE_ANIM: light-vein carving growth 3.0-5.0s`
    };
  }
}

module.exports = { ShotNormalizer };
