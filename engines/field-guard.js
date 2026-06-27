'use strict';

/**
 * 全局字段守门器 v1.0
 * 适配超现实系统四层架构
 * 
 * 在关键节点强制校验字段完整性，防止字段丢失和降级不透明
 */

const { standardizeShots, validateShots, validateShot, markDegraded, CRITICAL_FIELDS } = require('./field-standardizer');

class FieldGuard {
  constructor(options = {}) {
    this.strict = options.strict !== false;
    this.allowWarnings = options.allowWarnings !== false;
    this.logPrefix = options.logPrefix || '[FieldGuard]';
  }

  /**
   * 标准化并校验镜头数组
   * @param {Array} shots - 原始镜头数组
   * @param {string} context - 校验上下文（如 'Layer2-Production'）
   * @returns {Object} { shots, report }
   */
  normalizeAndValidate(shots = [], context = 'unknown') {
    // 【审计修复】单镜头失败不拖垮整批：先标准化全部，再隔离校验失败的镜头
    const normalized = standardizeShots(shots);
    const details = normalized.map(s => validateShot(s));
    const failingIdx = [];
    const errors = [];
    details.forEach((d, i) => {
      if (!d.passed) {
        failingIdx.push(i);
        errors.push(`[${normalized[i].shotId}] ${d.errors.join('; ')}`);
      }
    });

    // 对失败镜头做就地修复（补默认值），而不是整批 throw
    for (const i of failingIdx) {
      const shot = normalized[i];
      console.warn(`${this.logPrefix} ${context} 镜头 ${shot.shotId} 校验失败，就地修复: ${details[i].errors.join('; ')}`);
      // 关键 P0 字段补默认值
      if (!shot.negative || !shot.negative.includes('no text')) {
        shot.negative = 'no text anywhere in frame, no watermark, no logo, no subtitle, no caption, no blur, no distortion, no extra limbs, no deformed, no cartoon style';
      }
      // 其余空 P0 用最小默认值
      const p0Defaults = {
        director_instruction: '好莱坞电影级质感，写实风格，8K超高清',
        constraint: 'Aspect ratio: 16:9, Resolution: 1920x1080, Format: MP4, Frame rate: 24fps, no text, no watermark',
        baseline: '8K resolution, cinematic quality, photorealistic, sharp focus',
        scene: shot.scene || '写实室内场景，自然光线，真实材质',
        lighting: shot.lighting || '主光：自然光5600K柔光漫射；补光：反光板填充；整体明亮清晰',
        camera_movement: shot.camera_movement || '0-3s固定机位；3-6s缓慢推近',
        character: shot.character || '主角，写实形象，自然姿态',
        action: shot.action || '自然站立，手部自然动作，眼神交流',
        portraits: shot.portraits && shot.portraits.length ? shot.portraits : ['image://characters/default/portrait.png'],
        dialogue: shot.dialogue && (Array.isArray(shot.dialogue) ? shot.dialogue.length : true) ? shot.dialogue : [{ speaker: '', text: '' }],
        consistency: shot.consistency || '保持角色形象跨镜头一致'
      };
      for (const [k, v] of Object.entries(p0Defaults)) {
        if (!shot[k] || (typeof shot[k] === 'string' && !shot[k].trim())) shot[k] = v;
      }
      shot.degraded = true;
      shot.degradeReason = `FieldGuard就地修复: ${details[i].errors.join('; ')}`;
    }

    if (errors.length > 0) {
      console.warn(`${this.logPrefix} ${context} 已就地修复 ${failingIdx.length} 个镜头`);
    }

    // 【FieldGuard 修复】区分严格模式：strict=true 时 P0 缺失视为失败
    const criticalErrors = errors.filter(e => /P0 Missing/.test(e));
    const passed = this.strict ? criticalErrors.length === 0 : true;
    
    return {
      shots: normalized,
      report: {
        passed,
        errors: this.strict ? criticalErrors : [],
        warnings: this.strict ? errors.filter(e => !/P0 Missing/.test(e)) : errors,
        details,
        summary: { totalShots: normalized.length, fixedShots: failingIdx.length }
      }
    };
  }

  /**
   * 快速校验（不抛异常，返回报告）
   */
  check(shots = [], context = 'unknown') {
    const normalized = standardizeShots(shots);
    const report = validateShots(normalized);
    
    return {
      shots: normalized,
      report,
      passed: report.passed
    };
  }

  /**
   * 标记降级并记录原因
   */
  markDegraded(shot, reason) {
    return markDegraded(shot, reason);
  }

  /**
   * 批量标记降级
   */
  markDegradedArray(shots, reason) {
    return shots.map(shot => markDegraded(shot, reason));
  }

  /**
   * 断言关键片头字段
   */
  assertOpeningFields(shots = []) {
    const openingShots = shots.filter(s => 
      s.sceneType === 'opening' || /^S00($|-|_)/.test(s.shotId || '')
    );
    
    for (const shot of openingShots) {
      if (!shot.title) {
        throw new Error(`[FieldGuard] Opening shot ${shot.shotId} missing [title]`);
      }
      if (!shot.subtitle) {
        throw new Error(`[FieldGuard] Opening shot ${shot.shotId} missing [subtitle]`);
      }
    }
    
    return true;
  }

  /**
   * 打印镜头字段摘要（用于调试和日志）
   * v2.1.4-fix9-P25: 适配25字段标准输出
   */
  printShotSummary(shots = [], context = 'unknown') {
    console.log(`\n${this.logPrefix} ${context} shot summary:`);
    for (const shot of shots) {
      // v2.1.4-fix9-P25: 统计25字段完整性
      const p0Fields = CRITICAL_FIELDS.p0;
      const p1Fields = CRITICAL_FIELDS.p1;
      const p0Present = p0Fields.filter(f => !!shot[f]).length;
      const p1Present = p1Fields.filter(f => !!shot[f]).length;
      
      // 台词统计
      const dialogueStr = typeof shot.dialogue === 'string' ? shot.dialogue : String(shot.dialogue || '');
      const dialogueCount = dialogueStr === 'NONE' || !dialogueStr ? 0 : dialogueStr.split('||').length;
      
      // 定妆照统计
      const refCount = (typeof shot.characterRef === 'string' && shot.characterRef !== 'NONE')
        ? (shot.characterRef.split('image://').length - 1)
        : 0;

      const summary = {
        shotId: shot.shotId,
        sceneType: shot.sceneType || '',
        duration: shot.duration || shot.timing?.duration || 0,
        scene: (shot.scene || '').substring(0, 40),
        character: (shot.character || 'NONE').substring(0, 30),
        p0Fields: `${p0Present}/${p0Fields.length}`,
        p1Fields: `${p1Present}/${p1Fields.length}`,
        characterRefCount: refCount,
        dialogueCount,
        promptLength: shot.promptCharCount || (typeof shot.prompt === 'string' ? shot.prompt.length : 0),
        degraded: !!shot.degraded,
        degradeReason: shot.degradeReason || ''
      };
      console.log(JSON.stringify(summary, null, 2));
    }
  }
}

module.exports = { FieldGuard };
