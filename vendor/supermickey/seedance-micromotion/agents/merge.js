/**
 * Merge Agent v9.2.0-Peng
 * 融合官 — 将五路增强合并为Seedance可解析的单一提示词
 */

const fs = require('fs').promises;
const fss = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const MOTION_LIBRARY = JSON.parse(fss.readFileSync(path.join(DATA_DIR, 'motion-library.json'), 'utf8'));

class MergeAgent {
  constructor() {
    this.rules = MOTION_LIBRARY.mergeRules;
    
    // v5.1-Peng: 距离敏感微动作可见性映射
    this.DISTANCE_VISIBILITY_MAP = {
      'ECU': { // 大特写：面部占80%+
        visible: ['face', 'eye'],
        description: '瞳孔、睫毛、皮肤毛孔、嘴角0.5mm移动',
        maxDetail: '极高',
        seedanceFocus: '全力投入面部微表情描述'
      },
      'CU': { // 特写：头肩
        visible: ['face', 'eye', 'body_upper'],
        description: '面部表情、颈部肌肉、肩膀微耸、手指入画',
        maxDetail: '高',
        seedanceFocus: '面部70% + 颈部/肩部30%'
      },
      'MCU': { // 中近景：腰以上
        visible: ['body', 'hand', 'breath_upper', 'eye'],
        description: '手势、手臂交叉、身体前倾/后仰、呼吸起伏',
        maxDetail: '中',
        seedanceFocus: '身体语言为主 + 面部为辅'
      },
      'MS': { // 中景：全身
        visible: ['stance', 'gesture', 'movement', 'body', 'breath_upper'],
        description: '站姿、重心分布、步态、身体朝向、呼吸起伏',
        maxDetail: '低',
        seedanceFocus: '姿态语言 + 空间关系'
      },
      'LS': { // 全景：人+环境
        visible: ['position', 'spacing', 'environment', 'world'],
        description: '人物与环境的比例、移动轨迹、群体站位',
        maxDetail: '极低',
        seedanceFocus: '空间关系 + 氛围元素'
      }
    };
    
    // 距离分类关键词映射
    this.DISTANCE_KEYWORDS = {
      'ECU': ['大特写', 'extreme close', 'ecu', '微距', '瞳孔特写', '眼部特写'],
      'CU': ['特写', 'close up', 'cu', '面部特写', '头肩', '近景'],
      'MCU': ['中近景', 'medium close', 'mcu', '腰上', '半身'],
      'MS': ['中景', 'medium shot', 'ms', '全身', '站姿'],
      'LS': ['全景', 'long shot', 'ls', '远景', '大场景', '环境']
    };
  }

  /**
   * 解析镜头距离
   * @param {string} cameraDesc - 镜头描述
   * @returns {string} 距离分类 (ECU/CU/MCU/MS/LS)
   */
  _parseCameraDistance(cameraDesc) {
    if (!cameraDesc) return 'MCU';
    
    const desc = cameraDesc.toLowerCase();
    
    // v5.1-Peng: 按优先级匹配（更具体的距离优先）
    // 顺序：ECU -> MCU -> CU -> MS -> LS
    const priorityOrder = [
      { distance: 'ECU', keywords: ['大特写', 'extreme close', 'ecu', '微距', '瞳孔特写', '眼部特写'] },
      { distance: 'MCU', keywords: ['中近景', 'medium close', 'mcu', '腰上', '半身'] },
      { distance: 'CU', keywords: ['特写', 'close up', 'cu', '面部特写', '头肩', '近景'] },
      { distance: 'MS', keywords: ['中景', 'medium shot', 'ms', '全身', '站姿'] },
      { distance: 'LS', keywords: ['全景', 'long shot', 'ls', '远景', '大场景', '环境'] }
    ];
    
    for (const { distance, keywords } of priorityOrder) {
      if (keywords.some(kw => desc.includes(kw.toLowerCase()))) {
        return distance;
      }
    }
    
    return 'MCU';
  }

  /**
   * 根据距离过滤微动作增强
   * @param {Object} enhancements - 五路增强结果
   * @param {string} distance - 距离分类
   * @returns {Object} 过滤后的增强结果
   */
  _filterEnhancementsByDistance(enhancements, distance) {
    const visibility = this.DISTANCE_VISIBILITY_MAP[distance];
    if (!visibility) return enhancements;
    
    const visibleCategories = visibility.visible;
    const filtered = {};
    
    for (const [category, data] of Object.entries(enhancements)) {
      // v5.1-Peng: 使用宽泛匹配检查可见性
      if (this._isCategoryVisible(category, visibleCategories)) {
        filtered[category] = data;
      } else {
        // 不可见的类别：保留元数据但标记为不可见
        filtered[category] = {
          ...data,
          _distanceFiltered: true,
          _reason: `在${distance}距离下不可见（可见类别: ${visibleCategories.join(',')}）`
        };
      }
    }
    
    return filtered;
  }

  /**
   * 将增强类别名映射到标准键（支持宽泛匹配）
   */
  _mapCategoryToKey(category) {
    const map = {
      'face': 'face',
      'eye': 'eye',
      'body': 'body', // body 匹配 body, body_upper, stance, gesture, movement
      'breath': 'breath',
      'world': 'environment'
    };
    return map[category] || category;
  }

  /**
   * 检查类别在当前距离下是否可见（支持宽泛匹配）
   */
  _isCategoryVisible(category, visibleCategories) {
    const key = this._mapCategoryToKey(category);
    
    // 直接匹配
    if (visibleCategories.includes(key)) return true;
    
    // 宽泛匹配规则
    if (key === 'body') {
      // body 匹配 body, body_upper, stance, gesture, movement
      // 但 CU 下只有 body_upper（上半身），没有完整 body
      const bodyMatches = ['body', 'body_upper', 'stance', 'gesture', 'movement'];
      return visibleCategories.some(v => bodyMatches.includes(v));
    }
    
    // face 在 ECU/CU/MCU 下可见（只要有 face 或 eye 即可）
    if (key === 'face') {
      return visibleCategories.some(v => ['face', 'eye'].includes(v));
    }
    
    // breath 匹配 breath 或 breath_upper
    if (key === 'breath') {
      return visibleCategories.some(v => v.includes('breath'));
    }
    
    // world 匹配 environment 或 world
    if (key === 'world') {
      return visibleCategories.some(v => ['world', 'environment'].includes(v));
    }
    
    return false;
  }

  /**
   * 合并五路增强为单一输出
   * @param {Object} shot - 原始镜头信息
   * @param {Object} enhancements - 五路增强结果
   * @returns {Object} 合并后的增强结果
   */
  merge(shot, enhancements) {
    const { face, body, eye, breath, world } = enhancements;
    
    // v5.1-Peng: 距离敏感微动作过滤
    const cameraDesc = shot.camera || shot.cameraDistance || '';
    const distance = this._parseCameraDistance(cameraDesc);
    const visibility = this.DISTANCE_VISIBILITY_MAP[distance];
    
    // 过滤微动作：只保留在当前距离下可见的
    const filteredEnhancements = this._filterEnhancementsByDistance(enhancements, distance);
    
    console.log(`🔍 Merge: 镜头距离=${distance} (${visibility?.description || '未知'}), 可见微动作=${visibility?.visible?.join(',') || '全部'}`);
    
    // 记录被过滤的增强
    const filteredOut = Object.entries(enhancements)
      .filter(([cat, data]) => data._distanceFiltered)
      .map(([cat]) => cat);
    if (filteredOut.length > 0) {
      console.log(`   ⚠️ 过滤掉的微动作: ${filteredOut.join(',')}（在当前距离下不可见）`);
    }
    
    const isCloseUp = distance === 'ECU' || distance === 'CU';
    
    // 解析原始提示词
    const originalPrompt = shot.originalPrompt || shot.description || '';
    
    // 构建增强版提示词（使用过滤后的增强）
    const enhancedPrompt = this._buildEnhancedPrompt(originalPrompt, filteredEnhancements, isCloseUp, distance);
    
    // 构建特殊效果描述
    const specialEffects = this._buildSpecialEffects(filteredEnhancements);
    
    // 构建对白提示（如果有）
    const dialogueCue = this._buildDialogueCue(shot, filteredEnhancements);
    
    return {
      shotId: shot.shotId,
      agent: 'Merge',
      original: originalPrompt,
      enhanced: enhancedPrompt,
      mood: this._resolveMood(shot, filteredEnhancements),
      camera: shot.camera || '',
      transition: shot.transition || '',
      dialogueCue: dialogueCue,
      specialEffects: specialEffects,
      enhancementSummary: this._buildSummary(filteredEnhancements),
      distanceInfo: { // v5.1-Peng: 附加距离信息
        distance,
        visibleDetails: visibility?.description || '',
        maxDetail: visibility?.maxDetail || '中',
        seedanceFocus: visibility?.seedanceFocus || ''
      },
      seedanceCompatible: true
    };
  }

  _buildEnhancedPrompt(original, enhancements, isCloseUp, distance = 'MCU') {
    let parts = original.split(',').map(p => p.trim()).filter(Boolean);
    
    if (parts.length === 0) parts = ['角色', '场景'];
    
    const visibility = this.DISTANCE_VISIBILITY_MAP[distance];
    const visibleCategories = visibility?.visible || ['face', 'eye', 'body', 'breath', 'world'];
    
    // v5.1-Peng: 距离感知注入 — 只注入在当前距离下可见的微动作
    
    // 注入面部增强（ECU/CU/MCU 可见）
    if (this._isCategoryVisible('face', visibleCategories) && enhancements.face && enhancements.face.seedancePrompt && !enhancements.face._distanceFiltered) {
      const faceEnhanced = enhancements.face.seedancePrompt.enhanced || '';
      if (faceEnhanced && parts[0]) {
        parts[0] = this._injectEnhancement(parts[0], faceEnhanced);
      }
    }
    
    // 注入身体增强（CU/MCU/MS 可见，通过宽泛匹配）
    if (this._isCategoryVisible('body', visibleCategories) && enhancements.body && enhancements.body.seedancePrompt && !enhancements.body._distanceFiltered) {
      const bodyEnhanced = enhancements.body.seedancePrompt.enhanced || '';
      if (bodyEnhanced) {
        let injected = false;
        for (let i = 1; i < parts.length; i++) {
          if (this._isActionPart(parts[i])) {
            parts[i] = this._injectEnhancement(parts[i], bodyEnhanced);
            injected = true;
            break;
          }
        }
        // 如果没找到动作部分，追加到末尾
        if (!injected) {
          parts.push(bodyEnhanced);
        }
      }
    }
    
    // 注入呼吸增强（MCU/MS 可见上半身呼吸）
    if (visibleCategories.includes('breath_upper') && enhancements.breath && enhancements.breath.seedancePrompt && !enhancements.breath._distanceFiltered) {
      const breathEnhanced = enhancements.breath.seedancePrompt.enhanced || '';
      if (breathEnhanced) {
        parts.push(breathEnhanced);
      }
    }
    
    // 注入世界/环境增强（MS/LS 可见）
    if (this._isCategoryVisible('world', visibleCategories) && enhancements.world && enhancements.world.seedancePrompt && !enhancements.world._distanceFiltered) {
      const worldEnhanced = enhancements.world.seedancePrompt.enhanced || '';
      if (worldEnhanced) {
        parts.push(worldEnhanced);
      }
    }
    
    // 注入眼神增强（ECU/CU/MCU 可见）
    if (this._isCategoryVisible('eye', visibleCategories) && enhancements.eye && enhancements.eye.seedancePrompt && !enhancements.eye._distanceFiltered) {
      const eyeEnhanced = enhancements.eye.seedancePrompt.enhanced || '';
      if (eyeEnhanced) {
        if (isCloseUp) {
          parts.splice(1, 0, eyeEnhanced);
        } else {
          parts.push(eyeEnhanced);
        }
      }
    }
    
    // 去重和清理
    const uniqueParts = [...new Set(parts)];
    let result = uniqueParts.join(', ');
    
    // ====== 长度截断控制（Seedance 兼容性）======
    const maxLength = this.rules?.maxPromptLength || 490; // v7.1-Peng: 同步官方上限 490字
    if (result.length > maxLength) {
      const overflow = result.length - maxLength;
      
      if (overflow < 100) {
        result = this._truncateEnhancementMarkers(result, maxLength);
      } else {
        result = this._removeLowPriorityParts(result, uniqueParts, isCloseUp, maxLength);
      }
    }
    
    return result;
  }

  /**
   * 截断 **增强** 标记内的冗余内容（小溢出策略）
   */
  _truncateEnhancementMarkers(text, maxLength) {
    // 移除 **增强** 中最长的片段，直到长度符合要求
    let current = text;
    const markerRegex = /\*\*([^*]+)\*\*/g;
    
    while (current.length > maxLength) {
      const markers = [];
      let match;
      while ((match = markerRegex.exec(current)) !== null) {
        markers.push({ full: match[0], content: match[1], index: match.index });
      }
      
      if (markers.length === 0) break;
      
      // 移除最长的增强标记
      markers.sort((a, b) => b.content.length - a.content.length);
      const longest = markers[0];
      
      // 保留内容但移除 ** 包装（减少 4 个字符开销）
      current = current.substring(0, longest.index) + longest.content + current.substring(longest.index + longest.full.length);
      
      // 如果仍然超长，继续移除下一个
      if (current.length > maxLength && markers.length > 1) {
        // 移除次长的标记
        const next = markers[1];
        current = current.substring(0, next.index) + current.substring(next.index + next.full.length);
      }
    }
    
    // 最后硬截断（保留完整字符）
    if (current.length > maxLength) {
      current = current.substring(0, maxLength);
    }
    
    return current;
  }

  /**
   * 移除最低优先级的增强部分（大溢出策略）
   */
  _removeLowPriorityParts(result, parts, isCloseUp, maxLength) {
    // 优先级定义（从低到高，先移除低优先级）
    const priority = isCloseUp
      ? { world: 1, body: 2, breath: 3, eye: 4, face: 5 }  // 特写：面部最高
      : { face: 1, eye: 2, breath: 3, body: 4, world: 5 }; // 远景：身体/世界最高
    
    let currentParts = [...parts];
    
    // 尝试移除非原始提示词的增强部分（从最低优先级开始）
    const removableKeywords = {
      world: ['微尘', '温度', '风向', '湿度', '气流', '环境'],
      body: ['肩部', '重心', '膝盖', '指节', '姿态', '身体'],
      breath: ['呼吸', '胸部起伏', '喘息', '气息'],
      eye: ['眼神', '瞳孔', '视线', '眨眼'],
      face: ['眉', '眼', '瞳孔', '咬肌', '下颌', '鼻翼', '嘴角']
    };
    
    for (const [agent, prio] of Object.entries(priority).sort((a, b) => a[1] - b[1])) {
      if (currentParts.length <= 2) break; // 至少保留 2 部分
      
      const keywords = removableKeywords[agent] || [];
      const idx = currentParts.findIndex(p => keywords.some(kw => p.includes(kw)) && !this._isOriginalPart(p, result));
      
      if (idx >= 0) {
        currentParts.splice(idx, 1);
        const newResult = currentParts.join(', ');
        if (newResult.length <= maxLength + 50) { // 允许 50 字符容错
          return newResult;
        }
      }
    }
    
    // 兜底：硬截断到 maxLength
    return currentParts.join(', ').substring(0, maxLength);
  }

  /**
   * 判断某部分是否属于原始提示词
   */
  _isOriginalPart(part, originalPrompt) {
    return originalPrompt.includes(part);
  }

  _injectEnhancement(originalPart, enhancement) {
    if (!enhancement) return originalPart;
    if (originalPart.includes(enhancement)) return originalPart;
    
    // 将增强内容用 ** 包裹并注入
    const enhanced = enhancement.split(',').map(e => {
      const trimmed = e.trim();
      if (trimmed && !originalPart.includes(trimmed)) {
        return `**${trimmed}**`;
      }
      return '';
    }).filter(Boolean).join(', ');
    
    if (enhanced) {
      return `${originalPart}, ${enhanced}`;
    }
    return originalPart;
  }

  _isActionPart(part) {
    const actionKeywords = ['站立', '行走', '奔跑', '战斗', '跳跃', '手持', '动作', '姿态', 'pose', 'action'];
    return actionKeywords.some(kw => part.includes(kw));
  }

  _buildSpecialEffects(enhancements) {
    const effects = [];
    
    if (enhancements.breath && enhancements.breath.visualCue) {
      effects.push(enhancements.breath.visualCue);
    }
    if (enhancements.world && enhancements.world.seedancePrompt) {
      effects.push(enhancements.world.seedancePrompt.enhanced || '');
    }
    if (enhancements.face && enhancements.face.microActions) {
      const skinEffect = enhancements.face.microActions.find(a => a.bodyPart === 'skin');
      if (skinEffect) effects.push('面部微汗/泛红效果');
    }
    
    return effects.filter(Boolean).join(', ');
  }

  _buildDialogueCue(shot, enhancements) {
    const character = shot.character || '';
    const emotion = shot.emotion || '';
    const faceEnhancement = enhancements.face || {};
    
    if (!character && !emotion) return '';
    
    let cue = '';
    if (character) cue += `，角色${character}`;
    if (emotion) cue += `正在说话，${emotion}的语气`;
    if (faceEnhancement.intensityDescription) {
      cue += `，${faceEnhancement.intensityDescription}`;
    }
    
    return cue;
  }

  _resolveMood(shot, enhancements) {
    const mood = shot.mood || shot.emotion || '';
    const face = enhancements.face || {};
    
    if (face.emotion && face.intensity >= 4) {
      return `${mood}压抑`;
    }
    return mood;
  }

  _buildSummary(enhancements) {
    const summary = [];
    if (enhancements.face) summary.push(`面部:${enhancements.face.emotion || ''}(${enhancements.face.intensity || ''})`);
    if (enhancements.body) summary.push(`身体:${enhancements.body.stance || ''}`);
    if (enhancements.eye) summary.push(`眼神:${enhancements.eye.eyeType || ''}`);
    if (enhancements.breath) summary.push(`呼吸:${enhancements.breath.pattern || ''}`);
    if (enhancements.world) summary.push(`环境:${enhancements.world.sceneType || ''}`);
    return summary.join(' | ');
  }
}

module.exports = { MergeAgent };
