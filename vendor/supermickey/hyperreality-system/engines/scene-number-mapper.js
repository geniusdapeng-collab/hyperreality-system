/**
 * SceneNumberMapper — 场景编号与核心内容映射系统
 */
class SceneNumberMapper {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.logPrefix = options.logPrefix || '[SceneMapper]';
    this.mappings = [];
  }

  map(shots, scenes, dialogues = []) {
    if (!shots || shots.length === 0) return { mappings: [], lookup: {} };

    console.log(`${this.logPrefix} 建立场景映射: ${shots.length} 镜头`);
    this.mappings = [];

    for (let i = 0; i < shots.length; i++) {
      const shot = shots[i];
      const scene = scenes[i] || {};
      const coreContent = this._extractCoreContent(scene, dialogues, i);

      const mapping = {
        index: i,
        shotId: shot.shotId || `S${String(i).padStart(2, '0')}`,
        sceneId: scene.scene_id || `SC${String(i).padStart(2, '0')}`,
        sceneType: scene.scene_type || shot.sceneType || 'unknown',
        sceneName: scene.scene_name || '',
        coreContent: coreContent,
        duration: scene.timing?.duration || shot.duration || 0,
        timing: scene.timing,
        characters: scene.characters || [],
        keyDialogue: this._extractKeyDialogue(scene, dialogues)
      };

      this.mappings.push(mapping);
    }

    const lookup = this._buildLookup(this.mappings);
    return { mappings: this.mappings, lookup };
  }

  _extractCoreContent(scene, dialogues, index) {
    const parts = [];
    if (scene.setting) parts.push(scene.setting);
    if (scene.scene_function) parts.push(`[${scene.scene_function}]`);
    const dialogue = this._extractKeyDialogue(scene, dialogues);
    if (dialogue) parts.push(`台词: "${dialogue}"`);
    if (scene.visual_notes) parts.push(scene.visual_notes);
    return parts.join(' | ');
  }

  _extractKeyDialogue(scene, dialogues) {
    if (scene.dialogue?.lines?.length > 0) return scene.dialogue.lines[0].text;
    if (scene.dialogue?.blocks?.length > 0) return scene.dialogue.blocks[0].line;
    const sceneDialogues = dialogues.filter(d => d.scene_id === scene.scene_id);
    if (sceneDialogues.length > 0) return sceneDialogues[0].text;
    return null;
  }

  _buildLookup(mappings) {
    const lookup = { byShotId: {}, bySceneId: {}, bySceneType: {}, byContent: {} };
    for (const m of mappings) {
      lookup.byShotId[m.shotId] = m;
      lookup.bySceneId[m.sceneId] = m;
      if (!lookup.bySceneType[m.sceneType]) lookup.bySceneType[m.sceneType] = [];
      lookup.bySceneType[m.sceneType].push(m);
      const keywords = m.coreContent.split(/[ |，,]/).filter(k => k.length >= 2);
      for (const kw of keywords) {
        if (!lookup.byContent[kw]) lookup.byContent[kw] = [];
        lookup.byContent[kw].push(m);
      }
    }
    return lookup;
  }

  generatePostProductionMap() {
    return this.mappings.map(m => ({
      shotId: m.shotId,
      sceneId: m.sceneId,
      sceneName: m.sceneName,
      sceneType: m.sceneType,
      coreContent: m.coreContent,
      keyDialogue: m.keyDialogue,
      subtitle: this._generateSubtitle(m)
    }));
  }

  _generateSubtitle(mapping) {
    if (mapping.keyDialogue) return mapping.keyDialogue;
    return mapping.coreContent.substring(0, 50);
  }

  getByShotId(shotId) {
    return this.mappings.find(m => m.shotId === shotId);
  }

  getBySceneType(sceneType) {
    return this.mappings.filter(m => m.sceneType === sceneType);
  }
}

module.exports = { SceneNumberMapper };
