/**
 * Shot Quality Enhancer — 镜头质量增强系统 (SuperMickey 适配版)
 *
 * 来源: 暴风战斧 shot-quality-enhancer.js
 * 适配: SuperMickey 四层架构，在 Layer 2 制作引擎后、FieldGuard 前调用
 *
 * 核心能力：
 * 1. 叙事目的推断（establish/reveal/climax/resolution/conflict/emotion/progress）
 * 2. 视觉钩子注入（根据场景特征推断唯一视觉标签）
 * 3. 相邻镜头差异化（相似度>0.75时提示差异化）
 * 4. 角色行为逻辑（根据情绪推断身体反应）
 * 5. 高潮镜头升级（Lighting/Camera/Mood 增强）
 * 6. 片头钩子（前3秒强视觉冲击）
 * 7. 前景/中景/背景层次规划
 * 8. 第一视觉重点推断
 * 9. 可拍摄化约束（单一焦点、可读分离、可信动作）
 * 10. 统一打包入口
 */

class ShotQualityEnhancer {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.intensity = options.intensity || 0.7; // 0.0-1.0，增强强度
    // 【P2-QUAL-01 修复】阈值不再固定，可根据intensity动态调整
    this.similarityThreshold = options.similarityThreshold || (0.6 + (1 - this.intensity) * 0.3); // intensity越高阈值越低（越敏感）
  }

  /**
   * SuperMickey 主入口：增强 shots 数组
   * @param {Array} shots - SuperMickey 格式的 shots 数组
   * @param {Object} options - { duration, intent, style }
   * @returns {Object} { shots, enhancedCount, report }
   */
  enhance(shots, options = {}) {
    if (!this.enabled || !shots || shots.length === 0) {
      return { shots, enhancedCount: 0, report: {} };
    }

    console.log('\n✨ [ShotQualityEnhancer] 镜头质量增强...');
    let enhancedCount = 0;
    const report = {
      narrativePurpose: 0,
      visualHook: 0,
      diversify: 0,
      behaviorLogic: 0,
      climaxUpgrade: 0,
      openingHook: 0,
      depthPlan: 0,
      primaryFocus: 0,
      cinematicReadability: 0,
      first3Seconds: 0
    };

    // 【审计修复·P0】深拷贝输入数组，避免副作用
    const enhancedShots = shots.map(s => ({ ...s }));

    // 1. 叙事目的推断
    for (let i = 0; i < enhancedShots.length; i++) {
      const purpose = this._inferNarrativePurpose(enhancedShots[i], i, enhancedShots.length);
      enhancedShots[i]._narrativePurpose = purpose;
      report.narrativePurpose++;
    }

    // 2. 视觉钩子注入
    for (const shot of enhancedShots) {
      const hook = this._inferVisualHook(shot);
      shot._visualHook = hook;
      report.visualHook++;
    }

    // 3. 相邻镜头差异化
    for (let i = 1; i < enhancedShots.length; i++) {
      const sim = this._simpleSimilarity(
        `${enhancedShots[i - 1].scene || ''} ${enhancedShots[i - 1].action || ''} ${enhancedShots[i - 1].description || ''}`,
        `${enhancedShots[i].scene || ''} ${enhancedShots[i].action || ''} ${enhancedShots[i].description || ''}`
      );
      if (sim > this.similarityThreshold) {
        enhancedShots[i]._diversifyHint = 'Change shot scale, focal subject, and spatial emphasis from previous shot.';
        enhancedShots[i].camera = enhancedShots[i].camera || 'cinematic reframing with different shot scale';
        enhancedShots[i].mood = enhancedShots[i].mood || 'heightened contrast and fresh visual emphasis';
        report.diversify++;
      }
    }

    // 4. 角色行为逻辑
    for (const shot of enhancedShots) {
      const logic = this._inferBehaviorLogic(shot);
      if (logic) {
        shot._behaviorLogic = logic;
        report.behaviorLogic++;
      }
    }

    // 5. 高潮镜头升级
    for (const shot of enhancedShots) {
      const tension = Number(shot.tension || 0);
      const type = String(shot.type || '').toLowerCase();
      const isClimax = type.includes('climax') || type.includes('reveal') || tension >= 8;
      if (isClimax) {
        shot._climaxUpgrade = true;
        // 【审计修复·P0】防止重复追加
        const lightingAddon = ' hard contrast, strong rim separation, dramatic directional highlight';
        const cameraAddon = ' decisive push-in or scale-reveal composition';
        const moodAddon = ' heightened tension, irreversible turning point';
        if (!shot.lighting || !shot.lighting.includes('strong rim separation')) {
          shot.lighting = (shot.lighting || '') + lightingAddon;
        }
        if (!shot.camera || !shot.camera.includes('push-in')) {
          shot.camera = (shot.camera || '') + cameraAddon;
        }
        if (!shot.mood || !shot.mood.includes('irreversible')) {
          shot.mood = (shot.mood || '') + moodAddon;
        }
        report.climaxUpgrade++;
      }
    }

    // 6. 片头钩子 + 前3秒杀手
    for (let i = 0; i < Math.min(3, enhancedShots.length); i++) {
      const shot = enhancedShots[i];
      const type = String(shot.type || '').toLowerCase();
      const forbiddenTypes = ['establishing', 'establish', 'transition', 'explanation'];
      if (forbiddenTypes.some(f => type.includes(f))) {
        shot.type = 'action';
        shot._typeAdjusted = true;
        shot._originalType = shot._originalType || type;
      }
      // 强制提升情绪张力
      const emotion = String(shot.emotion || '').toLowerCase();
      if (!emotion.includes('intense') && !emotion.includes('tension') && !emotion.includes('excitement')) {
        shot.emotion = 'intense';
        shot._emotionBoosted = true;
      }
      shot._openingHook = [
        'massive scale contrast',
        'mysterious world anomaly',
        'beast silhouette reveal',
        'human curiosity anchor',
        'sub-bass atmospheric impact'
      ];
      report.first3Seconds++;
    }

    // 7. 前景/中景/背景层次
    for (const shot of enhancedShots) {
      const depth = this._buildDepthPlan(shot);
      shot._depthPlan = depth;
      report.depthPlan++;
    }

    // 8. 第一视觉重点
    for (const shot of enhancedShots) {
      const focus = this._inferPrimaryFocus(shot);
      shot._primaryFocus = focus;
      report.primaryFocus++;
    }

    // 9. 可拍摄化约束
    for (const shot of enhancedShots) {
      shot._cinematicReadability = 'single clear focal point, readable subject separation, believable physical motion, no competing action layers';
      report.cinematicReadability++;
    }

    enhancedCount = enhancedShots.length;

    console.log(`   ✅ 镜头质量增强完成: ${enhancedCount}/${shots.length} 个镜头`);
    console.log(`      叙事目的: ${report.narrativePurpose} | 视觉钩子: ${report.visualHook}`);
    console.log(`      差异化: ${report.diversify} | 行为逻辑: ${report.behaviorLogic}`);
    console.log(`      高潮升级: ${report.climaxUpgrade} | 前3秒钩子: ${report.first3Seconds}`);

    return { shots: enhancedShots, enhancedCount, report };
  }

  // ========== 私有方法 ==========

  _inferNarrativePurpose(shot, index = 0, total = 1) {
    const type = String(shot.type || '').toLowerCase();
    const emotion = String(shot.emotion || '').toLowerCase();

    if (index === 0 || shot.id === 'S00' || shot.id === 'SC00') return 'establish';
    if (type.includes('opening')) return 'establish';
    if (type.includes('reveal')) return 'reveal';
    if (type.includes('climax')) return 'climax';
    if (type.includes('resolution') || type.includes('ending')) return 'resolution';
    if (emotion.includes('fear') || emotion.includes('tense') || emotion.includes('angry')) return 'conflict';
    if (emotion.includes('sad') || emotion.includes('awe') || emotion.includes('tender')) return 'emotion';
    if (index === total - 1) return 'resolution';
    return 'progress';
  }

  _inferVisualHook(shot) {
    const text = `${shot.scene || ''} ${shot.action || ''} ${shot.description || ''}`.toLowerCase();

    // 现有关键词匹配（保持原有逻辑）
    if (/竖眼|pupil|eye/.test(text)) return 'glowing vertical pupil close-up';
    if (/裂缝|cliff|rock|岩壁/.test(text)) return 'fractured cliff face with hard texture contrast';
    if (/孢子|spore|particle/.test(text)) return 'floating luminous spores in layered depth';
    if (/手|hand|触碰|reach/.test(text)) return 'trembling hand reaching into uncertain space';
    if (/尾|tail/.test(text)) return 'tail motion creating elegant spatial rhythm';
    if (/火|flame|burn/.test(text)) return 'heat shimmer and ember drift around the subject';
    if (/水|water|river/.test(text)) return 'reflective liquid surface with moving light distortion';

    // 【P0-QE-01 新增】类型感知默认钩子
    const type = String(shot.type || '').toLowerCase();
    const typeHooks = {
      'opening': 'first glimpse of the world, something never seen before',
      'establish': 'the world revealed in a single breath, scale and detail in one frame',
      'climax': 'moment of irreversible change, the point of no return',
      'reveal': 'secret unveiled, the hidden made visible',
      'resolution': 'emotional landing, the exhale after tension',
      'hero': 'iconic frame that defines the entire piece',
      'transition': 'liminal space between two realities',
      'conflict': 'tension crystallized into a single decisive visual',
      'emotion': 'feeling made visible through body and light',
      'progress': 'forward motion compressed into one telling moment'
    };

    const typeHook = typeHooks[type];
    if (typeHook) return typeHook;

    // 【P0-QE-01 优化】匹配不到时也不返回空泛描述
    const emotion = String(shot.emotion || '').toLowerCase();
    const emotionHooks = {
      'intense': 'pressure visible in clenched muscles and held breath',
      'tense': 'coiled stillness before the inevitable release',
      'curious': 'eyes tracking movement, body leaning into the unknown',
      'awe': 'scale so vast it redefines the subject in the frame',
      'fear': 'protective posture against something unseen but felt',
      'joy': 'light catching the face at the exact moment of delight',
      'sad': 'weight in the shoulders, the world slightly out of focus'
    };

    const emotionHook = emotionHooks[emotion];
    if (emotionHook) return emotionHook;

    return 'unique visual moment that demands attention';
  }

  _simpleSimilarity(a, b) {
    const wa = new Set(String(a).toLowerCase().split(/\s+/).filter(Boolean));
    const wb = new Set(String(b).toLowerCase().split(/\s+/).filter(Boolean));
    const inter = [...wa].filter(x => wb.has(x)).length;
    return inter / Math.max(1, Math.min(wa.size, wb.size));
  }

  _inferBehaviorLogic(shot) {
    const emotion = String(shot.emotion || '').toLowerCase();

    if (emotion.includes('fear') || emotion.includes('scared')) {
      return 'instinctive half-step backward, tense shoulders, interrupted breathing';
    }
    if (emotion.includes('curious') || emotion.includes('wonder')) {
      return 'slight forward lean, eyes locked, hand subtly reaching before full commitment';
    }
    if (emotion.includes('awe')) {
      return 'stillness, upward gaze, softened jaw, quiet breath hold';
    }
    if (emotion.includes('angry') || emotion.includes('determination')) {
      return 'spine straightened, jaw set, controlled forward tension';
    }
    if (emotion.includes('sad') || emotion.includes('tender')) {
      return 'small restrained movement, lowered breath, softened eye focus';
    }
    return 'clear readable body reaction aligned with the emotional beat';
  }

  _buildDepthPlan(shot) {
    const text = `${shot.scene || ''} ${shot.description || ''}`.toLowerCase();

    let foreground = 'subtle environmental framing element';
    let midground = 'primary subject action zone';
    let background = 'large-scale spatial context';

    if (/岩壁|cliff|rock/.test(text)) foreground = 'broken rock edge in foreground';
    if (/孢子|spore/.test(text)) foreground = 'floating luminous spores in foreground depth';
    if (/水|river|lake/.test(text)) foreground = 'reflective surface distortion in foreground';
    if (/神兽|白泽|beast|baize/.test(text)) midground = 'beast body or face as dominant midground subject';
    if (/AgentX|boy|少年/.test(text)) midground = 'xiaoG body reaction as readable midground anchor';
    if (/山|sky|cliff|mountain/.test(text)) background = 'monumental geological backdrop';
    if (/洞|cave/.test(text)) background = 'deep cave darkness with readable depth falloff';

    return { foreground, midground, background };
  }

  _inferPrimaryFocus(shot) {
    const text = `${shot.action || ''} ${shot.scene || ''} ${shot.description || ''}`.toLowerCase();

    if (/眼|eye|竖眼|pupil/.test(text)) return 'the eye region as the first visual focal point';
    if (/手|hand|触碰|reach/.test(text)) return 'the reaching hand as the first visual focal point';
    if (/裂缝|crack|光脉|glow/.test(text)) return 'the glowing crack as the first visual focal point';
    if (/白泽|baize|神兽/.test(text)) return 'the beast silhouette or face as the first visual focal point';
    if (/AgentX|boy|少年/.test(text)) return 'xiaoG facial reaction as the first visual focal point';

    return 'single readable visual center with no competing subject';
  }
}

module.exports = { ShotQualityEnhancer };
