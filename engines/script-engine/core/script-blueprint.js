// engines/script-engine/core/script-blueprint.js
// ScriptBlueprint 数据模型 - 系统的"单一真相源"
// 版本：v1.0 | 日期：2026-06-07

class ScriptBlueprint {
  constructor(data = {}) {
    this.blueprint_id = data.blueprint_id || this._generateUUID();
    this.version = data.version || '1.0.0';
    this.intent_ref = data.intent_ref || null;

    this.meta = {
      title: data.meta?.title || 'Untitled',
      narrative_mode: data.meta?.narrative_mode || 'dramatic',
      target_duration: data.meta?.target_duration || 120,
      acts_count: data.meta?.acts_count || 3,
      scenes_count: data.meta?.scenes_count || 5,
      ...data.meta
    };

    this.structure = {
      acts: data.structure?.acts || [],
      scenes: data.structure?.scenes || []
    };

    this.character_system = {
      characters: data.character_system?.characters || []
    };

    this.voice_system = {
      global_voice_policy: data.voice_system?.global_voice_policy || 'dialogue_only_no_voiceover',
      voice_profiles: data.voice_system?.voice_profiles || []
    };

    this.world_setting = {
      world_id: data.world_setting?.world_id || 'default',
      world_name: data.world_setting?.world_name || 'Default World',
      era: data.world_setting?.era || 'modern',
      core_rules: data.world_setting?.core_rules || [],
      environment_tags: data.world_setting?.environment_tags || []
    };

    this.extensions = {
      dramatic_extension: data.extensions?.dramatic_extension || {},
      nirath_extension: data.extensions?.nirath_extension || {},
      ...data.extensions
    };

    this.quality_report = {
      evaluator: data.quality_report?.evaluator || 'DramaBench',
      scores: data.quality_report?.scores || {},
      passed: data.quality_report?.passed || false
    };
  }

  _generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  // 获取指定场景
  getScene(sceneId) {
    return this.structure.scenes.find(s => s.scene_id === sceneId);
  }

  // 获取指定角色
  getCharacter(characterId) {
    return this.character_system.characters.find(c => c.character_id === characterId);
  }

  // 获取所有包含对话的场景
  getScenesWithDialogue() {
    return this.structure.scenes.filter(s => s.dialogue?.has_dialogue);
  }

  // 获取指定幕的所有场景
  getScenesByAct(actId) {
    return this.structure.scenes.filter(s => s.act_id === actId);
  }

  // 获取剧本总时长
  getTotalDuration() {
    return this.structure.scenes.reduce((sum, s) => sum + (s.timing?.duration || 0), 0);
  }

  // 验证剧本完整性
  validate() {
    const errors = [];

    if (!this.meta.title) errors.push('Missing title');
    if (!this.meta.narrative_mode) errors.push('Missing narrative_mode');
    if (!this.structure.acts.length) errors.push('No acts defined');
    if (!this.structure.scenes.length) errors.push('No scenes defined');

    // 验证场景完整性
    this.structure.scenes.forEach((scene, idx) => {
      if (!scene.scene_id) errors.push(`Scene ${idx}: Missing scene_id`);
      if (!scene.scene_type) errors.push(`Scene ${scene.scene_id || idx}: Missing scene_type`);
      if (!scene.timing) errors.push(`Scene ${scene.scene_id || idx}: Missing timing`);
    });

    // 验证角色一致性
    const characterIds = this.character_system.characters.map(c => c.character_id);
    this.structure.scenes.forEach(scene => {
      if (scene.characters) {
        scene.characters.forEach(cid => {
          if (!characterIds.includes(cid)) {
            errors.push(`Scene ${scene.scene_id}: Character ${cid} not defined`);
          }
        });
      }
    });

    return {
      valid: errors.length === 0,
      errors
    };
  }

  // 导出为 JSON
  toJSON() {
    return JSON.stringify({
      blueprint_id: this.blueprint_id,
      version: this.version,
      intent_ref: this.intent_ref,
      meta: this.meta,
      structure: this.structure,
      character_system: this.character_system,
      voice_system: this.voice_system,
      world_setting: this.world_setting,
      extensions: this.extensions,
      quality_report: this.quality_report
    }, null, 2);
  }

  // 从 JSON 导入
  static fromJSON(jsonString) {
    const data = JSON.parse(jsonString);
    return new ScriptBlueprint(data);
  }

  // 创建副本
  clone() {
    return new ScriptBlueprint(JSON.parse(this.toJSON()));
  }
}

module.exports = { ScriptBlueprint };
