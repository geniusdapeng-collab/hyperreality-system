/**
 * SmartImageReferencer — image_prompt 智能引用系统
 */
class SmartImageReferencer {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.logPrefix = options.logPrefix || '[SmartImageRef]';
    this.referenceImageDir = options.referenceImageDir || './reference-images';
  }

  async bind(shots, scenes = [], referenceImages = []) {
    if (!this.enabled || !shots || shots.length === 0) return shots;

    console.log(`${this.logPrefix} 智能引用绑定: ${shots.length} 镜头, ${referenceImages.length} 引用图`);

    for (let i = 0; i < shots.length; i++) {
      const shot = shots[i];
      const scene = scenes[i] || {};
      const sceneKeywords = this._extractKeywords(scene);
      const matchedImages = this._matchImages(sceneKeywords, referenceImages);

      if (matchedImages.length > 0) {
        shot.imageReferences = matchedImages.map(img => ({
          id: img.id || `ref_${i}`,
          role: this._determineRole(img, scene),
          path: img.path,
          confidence: img.confidence || 0.8
        }));

        shot.prompt = this._markImageReferences(shot.prompt, shot.imageReferences);
        shot.promptCharCount = shot.prompt.length;
      }
    }

    return shots;
  }

  _extractKeywords(scene) {
    const keywords = [];
    const textFields = [scene.setting, scene.description, scene.visual_notes, scene.scene_name, scene.scene_type];
    for (const field of textFields) {
      if (field && typeof field === 'string') {
        keywords.push(...field.split(/[，,\s]+/).filter(k => k.length >= 2));
      } else if (field && typeof field === 'object' && field !== null) {
        // 对象类型字段，尝试提取文本内容
        const text = field.text || field.description || field.content || JSON.stringify(field);
        if (typeof text === 'string') {
          keywords.push(...text.split(/[，,\s]+/).filter(k => k.length >= 2));
        }
      }
    }
    return [...new Set(keywords)];
  }

  _matchImages(keywords, images) {
    return images.filter(img => {
      if (!img.tags && !img.description) return false;
      const imgText = `${img.tags?.join(' ') || ''} ${img.description || ''}`;
      return keywords.some(kw => imgText.includes(kw));
    }).slice(0, 3);
  }

  _determineRole(img, scene) {
    if (img.tags?.some(t => t.includes('背景') || t.includes('场景'))) return 'background_reference';
    if (img.tags?.some(t => t.includes('氛围') || t.includes('色调'))) return 'atmosphere_reference';
    return 'style_reference';
  }

  _markImageReferences(prompt, imageReferences) {
    if (!prompt || !imageReferences || imageReferences.length === 0) return prompt;
    const refsText = imageReferences.map((ref, idx) => `image_ref_${idx + 1}: ${ref.role}`).join(', ');
    return prompt + `\n【引用图】${refsText}`;
  }
}

module.exports = { SmartImageReferencer };
