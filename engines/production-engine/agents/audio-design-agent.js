/**
 * AudioDesignAgent - 音频设计Agent
 * 负责: 环境音效设计
 */
const { BaseAgent } = require('./base-agent');

class AudioDesignAgent extends BaseAgent {
  constructor(options = {}) {
    super({ name: 'AudioDesignAgent', ...options });
  }

  _getSystemPrompt() {
    return `你是一位专业的声音设计师。根据场景信息，为每个镜头设计环境音效。

输出JSON格式:
{
  "shots": [
    {
      "shotId": "SC01",
      "backgroundSound": {
        "environment": "环境音类型",
        "description": "详细音效描述",
        "intensity": "low/medium/high"
      },
      "backgroundSoundString": "音效描述文本"
    }
  ]
}

设计原则:
1. 音效要与场景环境匹配：户外有风声/鸟鸣，室内有空调/人声;
2. 音效强度服务情绪：紧张场景音强高，平静场景音强弱;
3. 相邻镜头音效要有过渡和连贯性;`;
  }

  async process(shots, blueprint) {
    console.log(`[AudioDesignAgent] 开始处理 ${shots.length} 个镜头...`);

    const prompt = this._buildPrompt(shots, blueprint);

    const schema = {
      required: ['shots'], requiredArrays: ['shots'], rejectEmptyArray: true, // 【P1-6 修复】启用数组类型校验
    };

    const llmResult = await this._callLLM(prompt, schema, () => {
      return this._fallback(shots);
    });

    if (llmResult.degraded) {
      return { shots: llmResult.result?.shots || shots, degraded: true, degradeReason: llmResult.degradeReason };
    }

    const designedShots = shots.map((shot) => {
      const designed = llmResult.result?.shots?.find(s => s.shotId === shot.shotId) || {};
      const bgSound = designed.backgroundSound || shot.backgroundSound;
      const bgSoundStr = designed.backgroundSoundString || shot.backgroundSoundString || '';
      // 【v2.1.4-fix13-审计修复】同时输出 audio 字段，兼容25字段标准
      const audioStr = bgSoundStr || (bgSound ? `${bgSound.environment}: ${bgSound.description} (intensity: ${bgSound.intensity})` : '');
      return {
        ...shot,
        backgroundSound: bgSound,
        backgroundSoundString: bgSoundStr,
        audio: audioStr // 新增：兼容25字段标准
      };
    });

    console.log(`[AudioDesignAgent] 完成 ✓`);
    return { shots: designedShots, degraded: false, degradeReason: null };
  }

  _buildPrompt(shots, blueprint) {
    const shotsInfo = shots.map(s => {
      // 【v2.1.6】读取 dialogueBlocks 中的 manner，供音频设计参考
      const blocks = s.dialogueBlocks || [];
      const mannerInfo = blocks.map(b => `[${b.speaker}] ${b.manner || '无说话方式'}`).join('; ');
      return `镜头 ${s.shotId}: 场景"${(s.scene || '').substring(0, 50)}", 情绪"${s.mood || ''}", 说话方式"${mannerInfo.substring(0, 100)}"`;
    }).join('\n');

    return `## 镜头场景
${shotsInfo}

## 任务
为每个镜头设计环境音效。

【重要】每个镜头的"说话方式"信息已提供，你的音频设计必须与之配合：
- 如果说话方式是"quietly"，环境音强度应低（low），背景安静，突出角色低语
- 如果说话方式是"direct-address"，环境音应干净（low-medium），避免干扰直接对话
- 如果说话方式是"with a smile"，环境音可温暖柔和，氛围轻松
- 如果说话方式是"firmly"，环境音可略高（medium），增强力量感

输出每个镜头的:
1. environment: 环境音类型（outdoor_urban/indoor_office/hospital/park等）
2. description: 音效描述（15-30字，必须呼应说话方式）
3. intensity: 强度（low/medium/high，与说话方式匹配）

输出JSON: {"shots": [{"shotId":"SC01","backgroundSound":{"environment":"...","description":"...","intensity":"..."}}]}`;
  }

  _fallback(shots) {
    console.log(`[AudioDesignAgent] 使用降级规则...`);
    return {
      shots: shots.map(shot => ({
        ...shot, // 【P1-5 修复】保留上游全部字段
        shotId: shot.shotId,
        backgroundSound: shot.backgroundSound,
        backgroundSoundString: shot.backgroundSoundString || ''
      }))
    };
  }
}

module.exports = { AudioDesignAgent };
