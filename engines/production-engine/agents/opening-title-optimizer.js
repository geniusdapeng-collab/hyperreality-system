/**
 * OpeningTitleOptimizer - 片头标题优化Agent（后处理环节）
 * 负责: 在最终提交前，专门为片头SC00生成营销向的标题、动画、音效设计
 * 策略: 不动现有链路，作为后处理环节插入
 * v1.0: 基于已有blueprint和prompt，生成片头专属字段
 */
const { BaseAgent } = require('./base-agent');

class OpeningTitleOptimizer extends BaseAgent {
  constructor(options = {}) {
    super({ name: 'OpeningTitleOptimizer', ...options });
  }

  _getSystemPrompt() {
    return `你是一位专业的电影片头营销设计师。你的任务是为片头设计极具吸引力的主标题、副标题、出场动画和开场音效。

设计原则:
1. 标题要带有营销属性，让用户产生点击欲望
2. 动画设计要精致、有电影感
3. 字体设计要匹配视频气质
4. 开场音效要有品牌辨识度
5. 所有设计要服务于"让用户停留"的目标

输出严格的JSON格式，不要markdown代码块。`;
  }

  /**
   * 主入口：优化片头
   * @param {Object} shot - SC00镜头数据（含已有fields和prompt）
   * @param {Object} blueprint - 完整剧本蓝图
   * @returns {Object} 优化后的片头字段
   */
  async optimize(shot, blueprint) {
    console.log(`[OpeningTitleOptimizer] 开始优化片头...`);

    const prompt = this._buildPrompt(shot, blueprint);

    const schema = {
      required: ['title_content', 'subtitle_content', 'title_animation', 'title_font_design', 'opening_audio_design']
    };

    const llmResult = await this._callLLM(prompt, schema, () => {
      return this._fallback(shot, blueprint);
    });

    // 【调试】打印返回结果
    console.log('[OpeningTitleOptimizer] LLM返回结果:', JSON.stringify(llmResult.result, null, 2));

    if (llmResult.degraded) {
      console.log(`[OpeningTitleOptimizer] 降级处理`);
      return { ...llmResult.result, degraded: true, degradeReason: llmResult.degradeReason };
    }

    console.log(`[OpeningTitleOptimizer] 完成 ✓`);
    return { ...llmResult.result, degraded: false, degradeReason: null };
  }

  _buildPrompt(shot, blueprint) {
    const title = blueprint.title || '未命名';
    const meta = blueprint._metadata || blueprint.config?._metadata || {};
    const episodeNumber = meta.episodeNumber || meta.series?.currentEpisode || 1;
    const totalEpisodes = meta.totalEpisodes || meta.series?.totalEpisodes || 1;
    const genre = blueprint.genre || '科普';
    const style = blueprint.style || 'REAL';
    const targetAudience = blueprint.targetAudience || '通用受众';
    
    // 提取已有prompt中的场景信息
    const existingPrompt = shot.prompt || '';
    const existingScene = shot.fields?.scene || '';
    const existingDialogue = shot.fields?.dialogue || '';
    const existingMood = shot.fields?.mood || '';
    const existingAudio = shot.fields?.audio || '';

    return `## 视频核心主题
主题: ${title}（这是视频的核心内容，标题必须围绕此主题展开）
体裁: ${genre}视频
风格: ${style === 'REAL' ? '写实纪实' : style}

## 片头场景信息
场景描述: ${existingScene}
情绪基调: ${existingMood}
已有音频: ${existingAudio}

## 片头台词（开场第一句）
${existingDialogue}

## 已有Prompt片段
${existingPrompt.substring(0, 300)}...

## 任务
为片头设计以下5个字段，输出JSON格式。

### ⚠️ 核心约束（必须遵守）
1. 标题必须围绕"${title}"主题展开，不得偏离
2. 主标题必须包含主题关键词或相关概念
3. 禁止使用与主题无关的夸张表述（如"猝死前4分钟"等，除非与主题直接相关）
4. 标题要有营销属性，但必须真实反映内容

### 字段要求

1. title_content: 主标题（10-15字，带营销属性，吸引点击）
   - 要求: 必须包含主题关键词或相关概念，有冲击力/悬念/关键词
   - 示例（横纹肌溶解主题）: "肌肉在溶解？尿出可乐色要警惕！" / "横纹肌溶解：藏在肌肉里的致命警报"
   - 错误示例: "猝死前4分钟：警医揭秘生死博弈"（偏离主题）

2. subtitle_content: 副标题（15-25字，补充说明，增强可信度）
   - 要求: 解释主标题、给出关键信息、或制造对比
   - 示例: "第1集 | 症状识别与实验室检查全解析" / "警医示例角色：从症状到化验单的权威解读"

3. title_animation: 出场动画设计（150-200字，详细描述）
   - 包含: 入场方式（淡入/滑入/缩放/爆裂等）、持续时长、出场节奏
   - 包含: 主标题和副标题的出场顺序、时间差
   - 包含: 动画质感（金属/玻璃/粒子/水墨等）

4. title_font_design: 字体设计（100-150字，详细描述）
   - 包含: 字体类型、风格、颜色、描边、阴影、质感

5. opening_audio_design: 开场音效设计（100-150字，详细描述）
   - 包含: 专属开场音效、品牌辨识度、与动画同步节奏

要求:
- 标题必须有营销属性（让用户想点击），但必须围绕主题
- 动画设计要有电影质感
- 字体设计要匹配写实风格
- 音效要有品牌辨识度
- 整体时长控制在3-5秒

直接输出JSON格式:
{
  "title_content": "...",
  "subtitle_content": "...",
  "title_animation": "...",
  "title_font_design": "...",
  "opening_audio_design": "..."
}`;
  }

  _fallback(shot, blueprint) {
    console.log(`[OpeningTitleOptimizer] 使用降级规则...`);
    const title = blueprint.title || '未命名';
    return {
      title_content: `${title} - 第1集`,
      subtitle_content: '症状与实验室检查全解析',
      title_animation: '主标题淡入入场，副标题延迟0.5秒跟随淡入，整体2秒',
      title_font_design: '粗体无衬线字体，白色，带微阴影',
      opening_audio_design: '环境音渐起，配合标题入场'
    };
  }
}

module.exports = { OpeningTitleOptimizer };
