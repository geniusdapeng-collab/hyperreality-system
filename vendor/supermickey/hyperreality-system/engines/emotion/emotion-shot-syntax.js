/**
 * Emotion Shot Syntax Injector — 情绪镜头语法注入器 (SuperMickey)
 *
 * 融入点: Layer 2 (制作引擎)
 * 在 ProductionEngine 的 PromptBuilder 中集成，将情绪弧线注入到镜头提示词中
 *
 * 核心能力：
 * 1. 根据情绪目标为每个镜头注入情绪描述词
 * 2. 根据情绪强度调整镜头语言（距离/角度/运动）
 * 3. 与 MicroMotion 联动（情绪 → 微动作）
 * 4. 输出增强后的提示词：在 Action/Scene 中注入情绪修饰
 */

class EmotionShotSyntaxInjector {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;

    // 情绪 → 镜头语法映射
    this.emotionToCamera = {
      joy: { distance: 'medium_close_up', angle: 'eye_level', movement: 'smooth_tracking', modifier: 'warm, golden hour glow' },
      sadness: { distance: 'close_up', angle: 'slightly_low', movement: 'slow_push_in', modifier: 'soft diffused light, muted palette' },
      anger: { distance: 'medium_close_up', angle: 'dramatic_low', movement: 'energetic_handheld', modifier: 'hard contrast, sharp shadows' },
      fear: { distance: 'extreme_close_up', angle: 'dutch_tilt', movement: 'unstable_shaky', modifier: 'cool blue tones, high contrast' },
      surprise: { distance: 'close_up', angle: 'eye_level', movement: 'quick_snap', modifier: 'bright flash, sudden illumination' },
      nostalgia: { distance: 'long_shot', angle: 'slightly_high', movement: 'slow_pan', modifier: 'warm sepia, film grain, soft focus edges' },
      tension: { distance: 'medium_shot', angle: 'neutral', movement: 'subtle_zoom', modifier: 'narrow depth of field, desaturated' },
      relief: { distance: 'medium_long_shot', angle: 'eye_level', movement: 'gentle_float', modifier: 'soft even light, breathable space' },
      awe: { distance: 'extreme_long_shot', angle: 'low_angle', movement: 'majestic_crane', modifier: 'grand scale, luminous atmosphere' },
      melancholy: { distance: 'medium_shot', angle: 'neutral', movement: 'slow_drift', modifier: 'cool muted, gentle haze' },
      hope: { distance: 'long_shot', angle: 'low_angle', movement: 'upward_crane', modifier: 'warm backlight, radiant edges' },
      despair: { distance: 'close_up', angle: 'high_angle', movement: 'static', modifier: 'harsh overhead, deep shadows' }
    };

    // 情绪 → 动作修饰词
    this.emotionToAction = {
      joy: 'with exuberant energy, movements light and buoyant',
      sadness: 'with heavy stillness, each gesture deliberate and weighed down',
      anger: 'with sharp, controlled force, movements explosive and decisive',
      fear: 'with frozen tension, micro-tremors betraying inner panic',
      surprise: 'with a sudden jolt, body recoiling then frozen in disbelief',
      nostalgia: 'with a distant gaze, movements slow as if moving through memory',
      tension: 'with coiled readiness, every muscle primed for action',
      relief: 'with collapsing shoulders, breath releasing in visible waves',
      awe: 'with head tilted upward, body motionless in reverence',
      melancholy: 'with languid movements, as if drained of vitality',
      hope: 'with chin lifted, posture straightening despite adversity',
      despair: 'with body curled inward, movements minimal and defeated'
    };

    // 情绪 → 光影修饰词
    this.emotionToLighting = {
      joy: 'warm golden light, soft highlights on skin, bright and airy atmosphere',
      sadness: 'cool blue-grey tones, soft shadows, gentle rim light from behind',
      anger: 'harsh directional light, deep shadows, high contrast chiaroscuro',
      fear: 'flickering uncertain light, moving shadows, cold color temperature',
      surprise: 'sudden bright flash, then normal exposure, stark contrast between',
      nostalgia: 'warm amber glow, soft halation, slight film grain, vintage color grading',
      tension: 'narrow slit of light, deep shadows, selective illumination, high contrast',
      relief: 'soft even fill light, gentle shadows, breathable negative space',
      awe: 'grand luminous atmosphere, volumetric light rays, epic scale illumination',
      melancholy: 'cool desaturated tones, gentle haze, soft diffused overcast light',
      hope: 'warm backlight creating rim glow, lens flare, radiant edges',
      despair: 'harsh overhead light, deep eye sockets, oppressive shadow coverage'
    };
  }

  /**
   * 主入口：注入情绪语法到镜头
   * @param {Array} shots - shots 数组
   * @param {Object} emotionArc - 情绪弧线 (EmotionArcDesigner 输出)
   * @returns {Array} 增强后的 shots
   */
  inject(shots, emotionArc) {
    if (!this.enabled || !shots || !emotionArc || !emotionArc.targets) {
      return shots;
    }

    console.log('\n💫 [EmotionShotSyntax] 情绪镜头语法注入...');
    let injectedCount = 0;

    for (let i = 0; i < shots.length; i++) {
      const shot = shots[i];
      const target = emotionArc.targets[i] || emotionArc.targets[emotionArc.targets.length - 1];

      if (!target) continue;

      const emotion = target.emotion || emotionArc.primaryEmotion || 'neutral';
      const intensity = target.intensity || 0.5;
      const descriptor = target.descriptor || '';

      // 1. 注入镜头语法
      const cameraSpec = this.emotionToCamera[emotion] || this.emotionToCamera.neutral || {};
      if (cameraSpec.distance && !shot.camera) {
        shot.camera = cameraSpec.distance;
      }
      if (cameraSpec.modifier && !shot.lighting) {
        shot.lighting = cameraSpec.modifier;
      }

      // 2. 注入动作修饰词
      const actionModifier = this.emotionToAction[emotion];
      if (actionModifier && shot.action) {
        shot.action = `${shot.action} ${actionModifier}`;
      }

      // 3. 注入光影修饰词
      const lightingModifier = this.emotionToLighting[emotion];
      if (lightingModifier) {
        shot.lighting = lightingModifier;
      }

      // 4. 标记情绪注入
      shot._emotionInjected = {
        emotion,
        intensity,
        descriptor,
        camera: cameraSpec,
        actionModifier: !!actionModifier,
        lightingModifier: !!lightingModifier
      };

      injectedCount++;
    }

    console.log(`   ✅ 情绪镜头语法注入完成: ${injectedCount}/${shots.length} 个镜头`);

    return shots;
  }
}

module.exports = { EmotionShotSyntaxInjector };
