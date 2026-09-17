/**
 * MicroMotion Adapter — 微动作增强系统 (SuperMickey 适配版)
 *
 * 来源: 暴风战斧 micromotion-adapter.js
 * 适配: SuperMickey 四层架构，在 Layer 2 后、Prompt Guardian 前调用
 *
 * 核心能力：角色微表情/动作增强
 * - 根据情绪自动推断微动作（眼神、手势、呼吸、姿态）
 * - 根据镜头距离调整描述粒度
 * - 与情绪弧线联动，增强情感传达
 *
 * 降级策略：如果 MicroMotion 子系统未安装，使用 LLM 代理简化增强
 */

const fs = require('fs');
const path = require('path');

class MicroMotionAdapter {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.intensity = options.intensity || 0.5; // 0.0-1.0，增强强度
    this.outputDir = options.outputDir || path.join(__dirname, '..', '..', 'output', 'micromotion');
    this.logPath = options.logPath || path.join(this.outputDir, 'micromotion-log.json');

    // 尝试加载 MicroMotion 子系统（降级兼容）
    this.microMotionSystem = null;
    try {
      const mmPath = path.join(__dirname, '..', '..', '..', 'seedance-micromotion');
      if (fs.existsSync(mmPath)) {
        const { MicroMotionSystem } = require(path.join(mmPath, 'scripts/micromotion'));
        this.microMotionSystem = MicroMotionSystem;
      }
    } catch (e) {
      // 降级：不使用 MicroMotion 子系统
    }

    // 微动作模板库（降级时使用）
    this.microMotionTemplates = {
      'joy': {
        facial: ['嘴角微微上扬', '眼角出现笑意', '眉毛舒展'],
        gesture: ['轻轻点头', '手指轻触', '身体前倾'],
        breathing: ['呼吸轻快']
      },
      'sadness': {
        facial: ['眼眶微红', '嘴角下垂', '眼神黯淡'],
        gesture: ['微微低头', '手指轻颤', '肩膀微垂'],
        breathing: ['呼吸沉重']
      },
      'anger': {
        facial: ['眉头紧锁', '咬紧牙关', '眼神锐利'],
        gesture: ['握拳', '身体紧绷', '微微前倾'],
        breathing: ['呼吸急促']
      },
      'fear': {
        facial: ['瞳孔微缩', '嘴唇微张', '眼神闪烁'],
        gesture: ['微微后退', '手指收紧', '肩膀微耸'],
        breathing: ['呼吸急促']
      },
      'surprise': {
        facial: ['眼睛微睁', '眉毛上扬', '嘴巴微张'],
        gesture: ['身体后仰', '手微抬', '肩膀微耸'],
        breathing: ['呼吸一滞']
      },
      'nostalgia': {
        facial: ['眼神柔和', '嘴角微带笑意', '目光远眺'],
        gesture: ['微微侧头', '手指轻触', '身体放松'],
        breathing: ['呼吸平稳']
      },
      'tension': {
        facial: ['眼神专注', '眉头微皱', '嘴唇紧抿'],
        gesture: ['身体前倾', '手指微动', '肩膀紧绷'],
        breathing: ['呼吸放缓']
      },
      'relief': {
        facial: ['眉毛舒展', '嘴角放松', '眼神柔和'],
        gesture: ['身体后靠', '肩膀下沉', '手指放松'],
        breathing: ['深呼吸']
      }
    };

    // 镜头距离 → 描述粒度映射
    this.distanceGranularity = {
      'extreme_close_up': 3, // 只描述面部细节
      'close_up': 3,
      'medium_close_up': 2, // 面部 + 上半身
      'medium_shot': 2,
      'medium_long_shot': 1, // 全身
      'long_shot': 1,
      'extreme_long_shot': 0 // 不描述微动作
    };
  }

  /**
   * SuperMickey 主入口：增强 Prompts
   * @param {Array} prompts - SuperMickey 格式的 prompts 数组 [{shotId, prompt, ...}]
   * @param {Object} context - { characters, style, emotionArc }
   * @returns {Object} { prompts, enhancedCount, details }
   */
  enhance(prompts, context = {}) {
    if (!this.enabled) {
      return { prompts, enhancedCount: 0, details: [] };
    }

    console.log('\n🎭 [MicroMotion] 微动作增强...');

    let enhancedCount = 0;
    const details = [];
    const enhancedPrompts = [];

    for (const promptObj of prompts) {
      const promptText = typeof promptObj === 'string' ? promptObj : (promptObj.prompt || '');
      const shotId = promptObj.shotId || 'unknown';

      // 从 context 或 prompt 中提取情绪信息
      const emotion = this._extractEmotion(promptObj, context);
      const cameraDistance = this._extractCameraDistance(promptObj);

      // 根据镜头距离决定增强粒度
      const granularity = this._getGranularity(cameraDistance);
      if (granularity === 0) {
        // 远景不增强
        enhancedPrompts.push(promptObj);
        continue;
      }

      // 生成微动作描述
      const microMotion = this._generateMicroMotion(emotion, granularity);

      if (microMotion) {
        // 将微动作注入 prompt
        const enhancedPrompt = this._injectMicroMotion(promptText, microMotion);

        if (typeof promptObj === 'string') {
          enhancedPrompts.push(enhancedPrompt);
        } else {
          enhancedPrompts.push({
            ...promptObj,
            prompt: enhancedPrompt,
            _microMotion: {
              emotion,
              cameraDistance,
              granularity,
              added: microMotion
            }
          });
        }

        enhancedCount++;
        details.push({
          shotId,
          emotion,
          cameraDistance,
          granularity,
          addedLength: enhancedPrompt.length - promptText.length
        });
      } else {
        enhancedPrompts.push(promptObj);
      }
    }

    console.log(`   ✅ 微动作增强完成: ${enhancedCount}/${prompts.length} 个镜头`);
    if (details.length > 0) {
      const avgAdded = Math.round(details.reduce((s, d) => s + d.addedLength, 0) / details.length);
      console.log(`      平均每个镜头新增 ${avgAdded} 字符`);
    }

    // 保存报告
    this._saveReport(details, prompts.length);

    return {
      prompts: enhancedPrompts,
      enhancedCount,
      details
    };
  }

  // ========== 私有方法 ==========

  _extractEmotion(promptObj, context) {
    // 优先从 promptObj 的 emotion 字段提取
    if (promptObj.emotion) return promptObj.emotion;
    if (promptObj.emotionStart) return promptObj.emotionStart;
    if (promptObj._rhythm?.emotionStart) return promptObj._rhythm.emotionStart;

    // 从 prompt 文本中提取情绪关键词
    const promptText = String(promptObj.prompt || promptObj || '');
    const emotionKeywords = {
      'joy': ['喜悦', '开心', '笑', '欢乐', '愉快'],
      'sadness': ['悲伤', '难过', '哭泣', '痛苦', '哀伤'],
      'anger': ['愤怒', '生气', '怒火', '暴怒', '愤慨'],
      'fear': ['恐惧', '害怕', '惊恐', '畏惧', '恐慌'],
      'surprise': ['惊讶', '震惊', '意外', '惊愕'],
      'nostalgia': ['怀旧', '回忆', '思念', '怀念'],
      'tension': ['紧张', '焦虑', '不安', '紧绷'],
      'relief': ['放松', '释然', '安心', '解脱']
    };

    for (const [emotion, keywords] of Object.entries(emotionKeywords)) {
      if (keywords.some(k => promptText.includes(k))) {
        return emotion;
      }
    }

    // 从 context 的 emotionArc 中提取
    if (context.emotionArc && promptObj.shotIndex !== undefined) {
      return context.emotionArc.getTargetForShot?.(promptObj.shotIndex) || 'neutral';
    }

    return 'neutral';
  }

  _extractCameraDistance(promptObj) {
    const camera = promptObj.camera || promptObj._camera || '';
    const cameraStr = typeof camera === 'string' ? camera : JSON.stringify(camera);

    if (cameraStr.includes('特写') || cameraStr.includes('微距') || cameraStr.includes('extreme close')) {
      return 'extreme_close_up';
    }
    if (cameraStr.includes('近景') || cameraStr.includes('close up')) {
      return 'close_up';
    }
    if (cameraStr.includes('中近景') || cameraStr.includes('medium close')) {
      return 'medium_close_up';
    }
    if (cameraStr.includes('中景') || cameraStr.includes('medium')) {
      return 'medium_shot';
    }
    if (cameraStr.includes('中全景') || cameraStr.includes('medium long')) {
      return 'medium_long_shot';
    }
    if (cameraStr.includes('全景') || cameraStr.includes('long')) {
      return 'long_shot';
    }
    if (cameraStr.includes('大全景') || cameraStr.includes('extreme long')) {
      return 'extreme_long_shot';
    }

    // 从 prompt 文本推断
    const promptText = promptObj.prompt || '';
    if (promptText.includes('面部特写') || promptText.includes('眼神')) {
      return 'close_up';
    }
    if (promptText.includes('全身') || promptText.includes('全景')) {
      return 'long_shot';
    }

    return 'medium_shot'; // 默认
  }

  _getGranularity(cameraDistance) {
    return this.distanceGranularity[cameraDistance] || 1;
  }

  _generateMicroMotion(emotion, granularity) {
    const templates = this.microMotionTemplates[emotion] || this.microMotionTemplates['neutral'] || {};

    if (!templates || Object.keys(templates).length === 0) {
      return null;
    }

    const parts = [];

    // 根据粒度选择描述层次
    if (granularity >= 3) {
      // 面部细节 + 手势 + 呼吸
      if (templates.facial) {
        const facial = this._selectRandom(templates.facial, 2);
        parts.push(`面部细节：${facial.join('，')}`);
      }
      if (templates.gesture) {
        const gesture = this._selectRandom(templates.gesture, 1);
        parts.push(`微动作：${gesture.join('，')}`);
      }
      if (templates.breathing) {
        parts.push(`呼吸：${templates.breathing[0]}`);
      }
    } else if (granularity >= 2) {
      // 面部 + 手势
      if (templates.facial) {
        const facial = this._selectRandom(templates.facial, 1);
        parts.push(`表情：${facial.join('，')}`);
      }
      if (templates.gesture) {
        const gesture = this._selectRandom(templates.gesture, 1);
        parts.push(`姿态：${gesture.join('，')}`);
      }
    } else {
      // 仅姿态
      if (templates.gesture) {
        const gesture = this._selectRandom(templates.gesture, 1);
        parts.push(`身体语言：${gesture.join('，')}`);
      }
    }

    return parts.join('；');
  }

  _selectRandom(array, count) {
    if (!array || array.length === 0) return [];
    const shuffled = [...array].sort(() => 0.5 - Math.random());
    return shuffled.slice(0, Math.min(count, shuffled.length));
  }

  _injectMicroMotion(promptText, microMotion) {
    const text = String(promptText || '');
    // 在 prompt 末尾添加微动作描述
    // 避免重复添加
    if (text.includes('面部细节') || text.includes('微动作') || text.includes('表情：')) {
      return text;
    }

    return `${text}\n\n【微动作】${microMotion}`;
  }

  _saveReport(details, totalShots) {
    try {
      const report = {
        timestamp: new Date().toISOString(),
        totalShots,
        enhancedShots: details.length,
        intensity: this.intensity,
        details
      };

      if (!fs.existsSync(this.outputDir)) {
        fs.mkdirSync(this.outputDir, { recursive: true });
      }

      let logs = [];
      if (fs.existsSync(this.logPath)) {
        logs = JSON.parse(fs.readFileSync(this.logPath, 'utf8'));
      }
      logs.push(report);
      fs.writeFileSync(this.logPath, JSON.stringify(logs, null, 2));
    } catch (e) {
      console.warn('⚠️ MicroMotion 报告保存失败:', e.message);
    }
  }
}

module.exports = { MicroMotionAdapter };
