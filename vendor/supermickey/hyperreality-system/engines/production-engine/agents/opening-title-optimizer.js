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
    return `你是一位专业的电影片头设计师。你的任务是为片头设计主标题、副标题、出场动画和开场音效。

设计原则（按优先级）:
1. 真实高于点击：标题的吸引力来自'具体到只有这个故事能讲'的细节冲突（无钉之车/牙与手/最后一结），禁止惊悚夸张、禁止与主题无关的钩子。
2. 主标题结构='核心意象+悬念/反差'（≤15字），副标题结构='时空/事件背景 | 人物+动作+stakes'（15-25字），两者合读必须让人预感到一个完整故事。
3. title_animation 的动效素材必须取自本片核心物象（绳/纤维/灯笼光），写清三段时间轴：hook(0-20%)→reveal(20-70%，标题成型=情绪峰值)→freeze(70-100%，留一拍静默)。
4. title_font_design 匹配影片气质：纪实=书法/手刻/材质纹理；写明字体性格、材质、勾边光色、呼吸感动效。
5. opening_audio_design 必须含'0-1秒声音签名'（一个真实环境音+一个低沉器乐音的接驳），并标注与动效逐拍对齐的同步点。
6. 所有设计服务于'让观众带着正确预期看正片'，而不是'骗一个点击'。

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
    const genre = blueprint.genre || blueprint.type || '通用';
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
   - 示例结构（以实际主题填充）: "[核心关键词]+[悬念/反差]" / "[主题]：[价值点提炼]"
   - 错误示例: "与主题无关的夸张惊悚表述"（偏离主题）

2. subtitle_content: 副标题（15-25字，补充说明，增强可信度）
   - 要求: 解释主标题、给出关键信息、或制造对比
   - 示例结构: "第1集 | [本集核心内容]全解析" / "[主讲人]：从[起点]到[落点]的权威解读"

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
    // 【2026-07-17 修复】删除医疗测试硬编码，改为通用库驱动兜底
    const title = blueprint.title || blueprint.config?.title || '未命名';
    const meta = blueprint._metadata || blueprint.config?._metadata || {};
    const ep = meta.episodeNumber || meta.series?.currentEpisode || 1;
    const isSeries = meta.isSeries || ep > 1;

    let generic;
    try {
      const { designTypography } = require('../../../../systems/opening-cinematic/typography-designer');
      const { designAudio } = require('../../../../systems/opening-cinematic/opening-audio-architect');
      const genre = blueprint.genre || blueprint.type || '通用';
      const mood = meta.mood || 'epic';
      const typo = designTypography({ genre, mood });
      const au = designAudio({ mood, durationSec: 8 });
      generic = {
        title_animation: '主标题以动效模式入场（0-20% 钩子悬念 → 20-60% 标题成型为情绪峰值 → 60-100% 定格收束），副标题延迟 0.5 秒跟进，整体 3-5 秒',
        title_font_design: typo.promptText,
        opening_audio_design: `${au.layers.find(l => l.layer === 'L1-signature')?.content || '声音签名'}；${au.layers.find(l => l.layer === 'L2-bed')?.content || '氛围铺底渐入'}`
      };
    } catch (_) {
      generic = {
        title_animation: '主标题淡入入场，副标题延迟0.5秒跟随淡入，整体2秒',
        title_font_design: '粗体无衬线字体，白色，带微阴影',
        opening_audio_design: '环境音渐起，配合标题入场'
      };
    }

    return {
      title_content: isSeries ? `${title} - 第${ep}集` : title,
      subtitle_content: isSeries ? `第${ep}集 | ${title}核心内容全解析` : `${title} | 核心内容全解析`,
      ...generic
    };
  }
}

module.exports = { OpeningTitleOptimizer };