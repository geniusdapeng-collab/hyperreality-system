/**
 * LLM Agent输出标准化层
 * 将LLM Agent的各种输出格式（对象/数组）统一转换为字符串
 * 确保与v1.x的 _engineerPrompts 完全兼容
 */

class LLMOutputNormalizer {
  /**
   * 标准化镜头数组
   * @param {Array} shots - 原始镜头数据
   * @param {object} blueprint - 剧本蓝图
   * @returns {Array} 标准化后的镜头
   */
  static normalizeShots(shots, blueprint) {
    return shots.map(shot => this.normalizeShot(shot));
  }

  /**
   * 标准化单个镜头
   * @param {object} shot - 原始镜头
   * @returns {object} 标准化后的镜头
   */
  static normalizeShot(shot) {
    const normalized = { ...shot };

    // 1. timeline: 数组 → 字符串
    normalized.timelineString = this._normalizeTimeline(shot.timeline);

    // 2. camera: 对象 → 字符串
    normalized.cameraString = this._normalizeCamera(shot.camera);

    // 3. lighting: 对象 → 字符串
    normalized.lightingString = this._normalizeLighting(shot.lighting);

    // 4. color: 对象 → 字符串
    normalized.colorString = this._normalizeColor(shot.color);

    // 5. composition: 对象 → 字符串
    normalized.compositionString = this._normalizeComposition(shot.composition);

    return normalized;
  }

  static _normalizeTimeline(timeline) {
    if (Array.isArray(timeline)) {
      return timeline.map(seg => 
        `${seg.timeRange || ''}: ${seg.cameraMovement || ''} (${seg.purpose || ''})`
      ).join('; ');
    } else if (timeline?.string && typeof timeline.string === 'string') {
      return timeline.string;
    } else if (typeof timeline === 'string') {
      return timeline;
    }
    return '';
  }

  static _normalizeCamera(camera) {
    if (!camera) return '';
    if (typeof camera === 'string') return camera;
    if (camera.string && typeof camera.string === 'string') return camera.string;

    const parts = [];
    if (camera.shotSize) parts.push(camera.shotSize);
    if (camera.movement) parts.push(camera.movement);
    if (camera.lens) parts.push(camera.lens);
    if (camera.focus) parts.push(camera.focus);
    return parts.join(', ');
  }

  static _normalizeLighting(lighting) {
    if (!lighting) return '';
    if (typeof lighting === 'string') return lighting;
    if (lighting.string && typeof lighting.string === 'string') return lighting.string;

    const parts = [];
    if (lighting.key) parts.push(lighting.key);
    if (lighting.fill) parts.push(lighting.fill);
    if (lighting.rim) parts.push(lighting.rim);
    if (lighting.colorTemp) parts.push(lighting.colorTemp);
    return parts.join(', ');
  }

  static _normalizeColor(color) {
    if (!color) return '';
    if (typeof color === 'string') return color;
    if (color.string && typeof color.string === 'string') return color.string;

    const parts = [];
    if (color.palette) parts.push(color.palette);
    if (color.tone) parts.push(color.tone);
    if (color.mood) parts.push(color.mood);
    return parts.join(', ');
  }

  static _normalizeComposition(composition) {
    if (!composition) return '';
    if (typeof composition === 'string') return composition;
    if (composition.string && typeof composition.string === 'string') return composition.string;

    const parts = [];
    if (composition.rule) parts.push(composition.rule);
    if (composition.placement) parts.push(composition.placement);
    if (composition.depth) parts.push(composition.depth);
    return parts.join(', ');
  }
}

module.exports = { LLMOutputNormalizer };
