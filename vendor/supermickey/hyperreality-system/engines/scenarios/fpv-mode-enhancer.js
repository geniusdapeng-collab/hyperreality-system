/**
 * FPV Mode Enhancer — 第一人称视角/极限运动模式增强 (SuperMickey 适配版)
 *
 * 融入点: Layer 2 (制作引擎后) 或可选模式
 * 当需求检测到极限运动/FPV/沉浸式内容时自动启用
 *
 * 核心能力：
 * 1. POV 镜头注入（第一人称视角）
 * 2. 外部跟拍视角（第三人称跟拍）
 * 3. 肾上腺镜头库（极限运动震撼镜头）
 * 4. 运动节奏增强（快速剪辑/运动模糊/速度感）
 */

class FPVModeEnhancer {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.sportType = options.sportType || 'auto'; // auto, skiing, surfing, climbing, parkour, racing, flying
    
    // 运动类型 → 镜头模板映射
    this.sportTemplates = {
      skiing: {
        pov: 'FPV helmet camera, rapid descent through powder snow, snow spray filling frame, edges of skis visible at bottom, speed blur on periphery, goggle reflection showing mountain panorama',
        follow: 'drone tracking shot from 3m behind, skier carving through fresh powder, snow plume trailing, dynamic follow-cam motion, wide angle showing mountain scale',
        wide: 'drone aerial establishing shot, vast mountain slope, skier as small figure carving S-turns, snow-capped peaks in background, epic scale'
      },
      surfing: {
        pov: 'FPV surfboard camera, inside the barrel looking out, water curling overhead, light refracting through wave, board nose visible, tunnel vision',
        follow: 'water-level tracking shot, surfer riding barrel wave, spray and foam, dynamic lateral motion, close proximity to wave face',
        wide: 'drone aerial shot, massive wave forming, surfer paddling into position, ocean expanse, power of nature'
      },
      climbing: {
        pov: 'helmet camera looking straight up, vertical rock face, chalked hands gripping holds, rope slack visible, dizzying height perspective',
        follow: 'ground camera tilting up, climber ascending rock face, belayer at bottom, scale contrast, human against nature',
        wide: 'drone circling shot, cliff face with climber, surrounding mountain range, golden hour light, epic scale'
      },
      parkour: {
        pov: 'chest-mounted camera, running across rooftops, gap jumps, wall runs, first-person perspective, parkour flow',
        follow: 'steadicam chase shot, traceur running through urban environment, vaults and rolls, dynamic camera movement matching subject',
        wide: 'drone establishing shot, urban landscape, traceur on rooftop, city skyline, dramatic perspective'
      },
      racing: {
        pov: 'dashboard camera, racing through track, steering wheel visible, G-force effects, speed blur, other cars in peripheral vision',
        follow: 'tracking drone shot, race car cornering at speed, tire smoke, sparks from undercarriage, dynamic low-angle follow',
        wide: 'crane shot, race track with multiple cars, grandstands, sunset lighting, epic motorsport atmosphere'
      },
      flying: {
        pov: 'wing-mounted camera, flying through clouds, wings visible at edges, horizon tilt, wind effects, freedom of flight',
        follow: 'drone chase shot, wingsuit flyer through mountain valley, proximity to terrain, dynamic aerobatic motion',
        wide: 'drone aerial shot, vast landscape below, wingsuit flyer as small figure, clouds, mountains, epic scale'
      }
    };

    // 通用 FPV 效果词
    this.fpvEffects = [
      'speed blur on edges',
      'motion blur trails',
      'g-force compression',
      'wind distortion',
      'rapid perspective shift',
      'adrenaline-pumping motion',
      'high-velocity dynamics',
      'immersive first-person perspective'
    ];
  }

  /**
   * 主入口：检测并增强 FPV 内容
   * @param {Array} shots - shots 数组
   * @param {string} intent - 用户意图（用于检测运动类型）
   * @returns {Object} { shots, fpvEnabled, sportType, enhancements }
   */
  enhance(shots, intent = '') {
    if (!this.enabled || !shots || shots.length === 0) {
      return { shots, fpvEnabled: false, sportType: null, enhancements: [] };
    }

    // 自动检测运动类型
    const detectedSport = this._detectSportType(intent);
    if (!detectedSport) {
      return { shots, fpvEnabled: false, sportType: null, enhancements: [] };
    }

    const sportType = this.sportType === 'auto' ? detectedSport : this.sportType;
    const templates = this.sportTemplates[sportType];

    if (!templates) {
      return { shots, fpvEnabled: false, sportType, enhancements: [] };
    }

    console.log(`\n🎬 [FPVMode] 极限运动模式增强 (${sportType})...`);

    const enhancements = [];
    let fpvCount = 0;

    for (let i = 0; i < shots.length; i++) {
      const shot = shots[i];
      const phase = this._getPhase(i, shots.length);
      
      // 根据阶段选择镜头类型
      let template = templates.follow; // 默认跟拍
      if (phase === 'buildup' || i === 0) {
        template = templates.wide; // 开场用广角
      } else if (phase === 'peak' || i === Math.floor(shots.length / 2)) {
        template = templates.pov; // 高潮用 POV
      }

      // 注入 FPV 描述
      const fpvDesc = template;
      const { SafeRandom } = require('../../utils/safe-random');
      const effect = SafeRandom.randomChoice(this.fpvEffects);
      
      if (shot.camera) {
        shot.camera = `${shot.camera}, ${fpvDesc}`;
      } else {
        shot.camera = fpvDesc;
      }
      
      shot._fpvEnhanced = {
        sportType,
        phase,
        template: phase === 'buildup' ? 'wide' : phase === 'peak' ? 'pov' : 'follow',
        effect
      };

      enhancements.push({
        shotId: shot.shotId || i,
        sportType,
        phase,
        template: phase === 'buildup' ? 'wide' : phase === 'peak' ? 'pov' : 'follow'
      });

      fpvCount++;
    }

    console.log(`   ✅ FPV 增强完成: ${fpvCount}/${shots.length} 个镜头`);
    console.log(`      运动类型: ${sportType} | 镜头序列: 广角→跟拍→POV`);

    return {
      shots,
      fpvEnabled: true,
      sportType,
      enhancements
    };
  }

  _detectSportType(intent) {
    const text = intent.toLowerCase();
    
    if (/滑雪|ski|snowboard|雪板|单板|双板/.test(text)) return 'skiing';
    if (/冲浪|surf|wave|海浪|划水/.test(text)) return 'surfing';
    if (/攀岩|climb|rock|mountain|登山/.test(text)) return 'climbing';
    if (/跑酷|parkour|freerun| urban/.test(text)) return 'parkour';
    if (/赛车|race|car|motor|speed|drift|f1/.test(text)) return 'racing';
    if (/飞行|fly|wingsuit|paraglid|skydiv|跳伞|翼装/.test(text)) return 'flying';
    
    return null;
  }

  _getPhase(index, total) {
    if (index < total * 0.2) return 'buildup';
    if (index < total * 0.5) return 'action';
    if (index < total * 0.8) return 'peak';
    return 'release';
  }
}

module.exports = { FPVModeEnhancer };
