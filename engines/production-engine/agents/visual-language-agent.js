/**
 * VisualLanguageAgent - 视觉语言Agent
 * 负责: 运镜设计、灯光设计、动态时间轴
 */
const { BaseAgent } = require('./base-agent');

class VisualLanguageAgent extends BaseAgent {
  constructor(options = {}) {
    super({ name: 'VisualLanguageAgent', ...options });
  }

  _getSystemPrompt() {
    return `你是一位专业的电影摄影师和灯光师。根据剧本和场景信息，为每个镜头设计运镜方案和灯光方案。

输出JSON格式:
{
  "shots": [
    {
      "shotId": "SC01",
      "camera": {
        "shot_size": "wide/medium/close_up/extreme_close_up",
        "movement": "dolly_in/static/handheld/push_in/pull_back",
        "angle": "eye_level/low/high",
        "lens": "35mm/50mm/85mm",
        "speed": "slow/normal/fast"
      },
      "cameraString": "运镜描述文本",
      "lighting": {
        "key_light": "主光描述",
        "fill_light": "辅光描述",
        "time_of_day": "golden_hour/midday/blue_hour/night",
        "atmosphere": "氛围光描述"
      },
      "lightingString": "灯光描述文本",
      "timeline": [
        { "segment": 1, "timeRange": "0s-3s", "cameraMovement": "缓推全景", "shotType": "wide", "purpose": "建立空间" }
      ]
    }
  ]
}

设计原则:
1. 运镜要服务叙事：情绪紧张用手持晃动，情绪平和用稳定机位;
2. 时间轴动态切分：根据台词密度和情绪变化切分2-6段，不等分;
3. 灯光要场景化：不说"key light 3200K"，说"夕阳从右侧窗户斜射进来，在示例角色脸上形成温暖的侧光";
4. 考虑镜头间衔接：相邻镜头的景别和运动要有逻辑过渡;`;
  }

  async process(shots, blueprint) {
    console.log(`[VisualLanguageAgent] 开始处理 ${shots.length} 个镜头...`);

    const prompt = this._buildPrompt(shots, blueprint);

    const schema = {
      required: ['shots']
    };

    const llmResult = await this._callLLM(prompt, schema, () => {
      return this._fallback(shots);
    });

    if (llmResult.degraded) {
      return { shots: llmResult.result?.shots || shots, degraded: true, degradeReason: llmResult.degradeReason };
    }

    // 合并LLM结果
    const designedShots = shots.map((shot) => {
      const designed = llmResult.result?.shots?.find(s => s.shotId === shot.shotId) || {};
      return {
        ...shot,
        camera: designed.camera || shot.camera,
        cameraString: designed.cameraString || '',
        lighting: designed.lighting || shot.lighting,
        lightingString: designed.lightingString || '',
        timeline: designed.timeline || shot.timeline,
        cameraMovement: {
          ...shot.cameraMovement,
          timeline: designed.timeline
        }
      };
    });

    console.log(`[VisualLanguageAgent] 完成 ✓`);
    return { shots: designedShots, degraded: false, degradeReason: null };
  }

  _buildPrompt(shots, blueprint) {
    const shotsInfo = shots.map(s => {
      const dialogue = s.dialogue?.lines?.map(l => `"${l.content}"`).join('; ') || s.dialogue || '';
      // 【v2.1.6】读取 dialogueBlocks 中的 trigger 和 manner，供运镜设计参考
      const blocks = s.dialogueBlocks || [];
      const triggerInfo = blocks.map(b => `[${b.speaker}] ${b.trigger || '无动作触发'}`).join('; ');
      const mannerInfo = blocks.map(b => `[${b.speaker}] ${b.manner || '无说话方式'}`).join('; ');
      return `镜头 ${s.shotId}: ${s.duration || '?'}s; 场景: ${(s.scene || '').substring(0, 60)}; 情绪: ${s.mood || ''}; 台词: ${dialogue.substring(0, 80)}; 动作触发: ${triggerInfo.substring(0, 100)}; 说话方式: ${mannerInfo.substring(0, 100)}`;
    }).join('\n');

    return `## 镜头信息
${shotsInfo}

## 任务
为每个镜头设计运镜+灯光+时间轴。

【重要】每个镜头的"动作触发"和"说话方式"信息已提供，你的运镜设计必须与之配合：
- 如果动作触发是"looks at camera"，运镜应设计为正面中景或特写，角色直视镜头
- 如果动作触发是"pauses then smiles"，运镜应在停顿处放缓，微笑时轻微推近
- 如果说话方式是"quietly"，灯光应偏暗、氛围偏静，运镜应平稳
- 如果说话方式是"direct-address"，运镜应正面、稳定，景别不宜过大

输出每个镜头的:
1. camera: {shot_size, movement, angle, lens, speed}
2. cameraString: 运镜描述文本（30-50字，动态描述，必须呼应动作触发）
3. lighting: {key_light, fill_light, time_of_day, atmosphere}
4. lightingString: 灯光场景化描述（30-50字，必须呼应说话方式和情绪）
5. timeline: 运镜时间轴（动态切分4-6段，根据台词节奏和动作触发设计，每段包含时间范围、运镜动作、画面目的，必须详细具体）

设计要点:
- 台词密集处：短切+手持
- 情绪铺垫处：长镜头+缓慢推近
- 景别过渡：相邻镜头不要跳跃太大
- 灯光场景化：不用技术术语，用自然描述
- 必须呼应动作触发：运镜时机与角色动作同步

输出JSON: {"shots": [{"shotId":"SC01","camera":{},"cameraString":"...","lighting":{},"lightingString":"...","timeline":[]}]}`;
  }

  _fallback(shots) {
    console.log(`[VisualLanguageAgent] 使用降级规则...`);
    // v2.1.5-fix: 统一降级数据格式与LLM正常返回格式一致
    // timeline字段必须与正常返回格式一致: timeRange/cameraMovement/shotType/purpose
    return {
      shots: shots.map(shot => ({
        shotId: shot.shotId,
        camera: shot.camera || {
          shot_size: 'medium',
          movement: 'static',
          angle: 'eye_level',
          lens: '35mm',
          speed: 'normal'
        },
        cameraString: shot.cameraString || '中景静态镜头，35mm焦段，平视角度，平稳拍摄',
        lighting: shot.lighting || {
          key_light: '柔和顶光',
          fill_light: '自然补光',
          time_of_day: '白天',
          atmosphere: '自然明亮'
        },
        lightingString: shot.lightingString || '柔和顶光照明，自然补光填充，白天室内明亮氛围',
        timeline: shot.timeline || [
          { segment: 1, timeRange: '0s-3s', cameraMovement: '镜头稳定，角色入画', shotType: 'wide', purpose: '建立场景' },
          { segment: 2, timeRange: '3s-6s', cameraMovement: '保持构图，角色开始动作', shotType: 'medium', purpose: '推进叙事' }
        ]
      }))
    };
  }
}

module.exports = { VisualLanguageAgent };
