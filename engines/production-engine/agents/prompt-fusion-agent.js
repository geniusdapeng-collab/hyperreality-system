/**
 * PromptFusionAgent - Prompt融合Agent（核心）
 * 负责: 将L3-L7元素创造性融合成导演分镜脚本
 * 策略: L1/L2/L9硬约束走规则，L3-L7走LLM融合
 * v2.1.4-fix8: LLM输出标准字段格式（【约束】【基础】【场景】等）
 */
const { BaseAgent } = require('./base-agent');
const { normalizeFields, makeGetter } = require('../../field-standardizer');

// 【v2.1.4-fix10-P25-fix3】外部专家建议：填满 schema 解决 LLM 字段缺失问题
// 25 个标准字段的 schema 模板：键名 + 类型提示
// 这是给 LLM 看的"结构契约"，绝不能再传 fields: {}
// ⚠️ value 使用空字符串占位，避免 LLM 把描述当输出值（风险5）
const STANDARD_FIELDS_SCHEMA = {
  director_instruction: '',
  constraint: '',
  baseline: '',
  scene: '',
  lighting: '',
  composition: '',
  color_palette: '',
  depth_of_field: '',
  camera_movement: '',
  character: '',
  costume: '',
  makeup: '',
  action: '',
  props: '',
  portraits: '',
  dialogue: '',
  timeline: '',
  mood: '',
  pacing: '',
  transition: '',
  audio: '',
  negative: '',
  bright_constraint: '',
  character_constraint: '',
  consistency: ''
};

// 字段描述表（仅用于补齐 prompt，不放入 schema）
const FIELD_DESCS = {
  director_instruction: 'string，≥80字符，导演整体质感指令',
  constraint: 'string，画幅/分辨率/帧率/格式/禁用项',
  baseline: 'string，8K/电影级/写实等基础画质词',
  scene: 'string，≥120字符，场景空间细节',
  lighting: 'string，≥150字符，主光/辅光/色温/方向',
  composition: 'string，≥100字符，景别/主体位置/线条/留白',
  color_palette: 'string，≥80字符，主色/辅色/肤色/饱和度/对比度',
  depth_of_field: 'string，≥80字符，焦点/景深/前景背景虚化',
  camera_movement: 'string，≥100字符，分时间段运镜',
  character: 'string，角色外貌与姿态',
  costume: 'string，服装材质款式',
  makeup: 'string，妆造',
  action: 'string，≥120字符，肢体动作与走位',
  props: 'string，道具',
  portraits: 'string，定妆照引用 image://...',
  dialogue: 'string，台词/旁白原文',
  timeline: 'string，≥200字符，0-Xs 分镜时间轴',
  mood: 'string，情绪基调',
  pacing: 'string，节奏',
  transition: 'string，转场方式',
  audio: 'string，≥100字符，环境音/配乐/音效',
  negative: 'string，负面约束',
  bright_constraint: 'string，明亮约束',
  character_constraint: 'string，角色一致性约束',
  consistency: 'string，跨镜头一致性'
};

// 25 字段标准名称列表（用于校验）
const REQUIRED_FIELDS = Object.keys(STANDARD_FIELDS_SCHEMA);

// 字段最低字符数要求
const MIN_LEN = {
  scene: 120, lighting: 150, composition: 100, action: 120,
  camera_movement: 100, timeline: 200, director_instruction: 80,
  color_palette: 80, depth_of_field: 80, audio: 100
};

function buildFullSchema(shotId) {
  // 用真实字段键填充，让 LLM 在 JSON 模式下有明确的 key 列表
  // value 使用空字符串，避免描述污染（风险5）
  return { shotId, fields: { ...STANDARD_FIELDS_SCHEMA } };
}

class PromptFusionAgent extends BaseAgent {
  constructor(options = {}) {
    super({ name: 'PromptFusionAgent', enabled: true, llmTimeout: 300000, ...options });
const PromptLengthConfig = require('../../../config/prompt-length.js');
// ...
    // 【审计修复】从配置文件读取，不再硬编码
    this.maxPromptLength = options.maxPromptLength || PromptLengthConfig.HARD_MAX || 12000;
    this.concurrency = options.concurrency || 2;
    this.llmTimeout = 300000; // 5 分钟单次（结构化输出需要更长时间）
    this.llmMaxRetries = 2;
  }

  _getSystemPrompt() {
    return `你是一位资深电影导演和摄影师。根据镜头信息，为每个镜头生成结构化的导演分镜提示词。

【核心要求】
你必须按以下标准字段格式输出，每个字段独立清晰，不要混合成一段narrative文本：

字段列表（严格按此顺序）：
1. 【约束】：技术参数约束，必须包含画幅比例(Aspect ratio)、分辨率(Resolution)、格式(Format)、帧率(Frame rate)。标准格式："Aspect ratio: 16:9, Resolution: 1920x1080, Format: MP4, Frame rate: 24fps, no text, no subtitle, no caption, no watermark"
2. 【基础】：画质基础词，必须包含三类：①分辨率锚定(8K resolution/ultra high definition)、②风格质量(cinematic quality/photorealistic/hyperrealistic)、③细节增强(highly detailed/intricate textures/sharp focus)。标准格式："8K resolution, cinematic quality, highly detailed, photorealistic"
3. 【场景】：具体场景环境描述（地点、时间、空间深度、材质细节）
4. 【灯光/照明】：专业灯光设计（主光方向+色温K值+光比+特效光）。格式："主光：右侧45度顶光 5600K冷白光，柔光箱漫射；补光：左前侧反光板 3200K暖光，填充阴影；背景光：轮廓光分离人物与背景；特效：无"；必须包含主光方向（左/右/顶/底/正前/正后）、色温（K值）、光质（硬光/柔光/漫射）
5. 【构图】：景别+画面比例+主体位置+线条引导。格式："景别：中景（膝上）；主体位置：画面黄金分割右1/3处；线条引导：走廊纵深感由近及远；画框边缘：左侧留白1/4给背景信息"
6. 【色彩/色调】：调色方案+色温倾向+饱和度。格式："主色调：冷白偏青（医院感）；辅助色：暖木色讲台点缀；肤色：自然偏暖；饱和度：中等偏低，避免过度鲜艳；对比度：中高，保持清晰层次"
7. 【景深】：焦点控制+虚化程度+前景/背景层次。格式："焦点：人物面部；景深：中等（f/2.8），背景适度虚化可辨；前景：讲台边缘轻微虚化；背景：走廊纵深渐变模糊；层次：前景-中景（人物）-背景三层分离"
8. 【运镜】：镜头运动方式（推/拉/摇/移/跟/升降/手持/稳定器）。格式："0-3s：稳定器缓慢推近（0.3m/s）→ 3-6s：固定机位 → 6-10s：手持微晃跟拍（呼吸感）"
9. 【角色】：角色身份、姿态、表情（如：穿警服的示例角色，健康科普主讲人，站姿挺拔，表情关切）
10. 【服装】：详细服装描述（颜色、款式、质地、配饰）。格式："藏青色警服外套（毛呢质地，肩章完整），内搭浅蓝色衬衫（棉质，领口整洁），黑色西裤，黑色皮鞋"
11. 【化妆】：妆容、发型细节。格式："短发整齐（黑色，长度及耳），素颜淡妆，眉毛自然，唇色淡粉，无夸张妆容"
12. 【动作】：角色具体动作（手势、步伐、视线）。格式："右手自然抬起至胸前做强调手势，左手自然下垂，身体微微前倾，目光直视镜头"
13. 【道具】：关键道具（手持物、桌面物品、背景物件）。格式："手持：空白A4文件夹（白色，无文字）；背景：木质讲台（表面有细微划痕），不锈钢保温杯"
14. 【定妆照】：角色定妆照引用路径（如：image://characters/chen-zhuo/portraits/chen-zhuo-front.png）
15. 【台词】：角色直接说的话，格式：纯台词内容（不要写"画外音""旁白"）
16. 【时间轴】：镜头内部的微观导演调度时间轴。必须采用分段式描述，时间戳使用相对于镜头起始点的偏移格式 T00:XX（如 T00:00, T00:02, T00:04），每段包含画面内容和角色动作。要求至少分3段，时间戳不得重叠或跳跃中断。
   标准格式示例：
   "T00:00 - 中景，主角坐在窗前，阳光从侧面照入；主角缓缓抬起头，目光投向窗外
   T00:02 - 近景过渡，镜头缓慢推进至面部；主角眼神由迷茫转为坚定，嘴角微微抿紧
   T00:04 - 特写定格，主角眼部区域；眼睛眨动一次，瞳孔中反射出窗外景象"
17. 【情绪】：1-2个情绪关键词，必须具有清晰视觉指向性，避免语义对立。推荐词库：joyful/serene/hopeful/melancholic/tense/despairing/mysterious/eerie/epic/fierce/romantic/intimate
18. 【节奏】：五段式描述，必须包含：整体(Overall)、开头(Opening 0-20%)、中段(Middle 20%-80%)、高潮(Climax)、结尾(Ending 10%-20%)。
   标准格式："整体：沉稳中等节奏；开头：缓慢引入（2s）；中段：稍快推进（紧迫感）；高潮：停顿强调（1s留白）；结尾：平缓收尾"
19. 【转场】：与下一镜头的衔接方式。必须采用"类型+持续时间+方向/风格"三段式结构。类型：hard cut(切镜)/fade in(淡入)/fade out(淡出)/dissolve(叠化)/wipe(划像)/zoom transition(缩放转场)
20. 【音频】：三层描述法——环境音效(Ambient Sound)+音乐风格(Music Style)+音量层级(Volume Level)。格式："gentle ocean waves and seagull calls, ambient cinematic with strings and piano, peaceful, 70 BPM, volume level: balanced"
21. 【负面约束】：排除项，必须包含两类：①通用负面词(no text/no watermark/no blurry/no extra limbs/deformed/distorted/low quality)；②场景特定负面词（根据content_type动态加载：教育类/医疗类/剧情类/广告类）
22. 【角色一致性】：保持角色形象一致
23. 【明亮约束】：亮度/光照强制要求，确保画面明亮清晰（如：bright lighting, well-lit scene, clear visibility, no dark shadows on face, adequate illumination）。这是强制字段，必须输出
24. 【角色约束】：角色出现限制，防止多角色/分身问题。格式："只出现[角色名]一人，禁止其他人物入镜，禁止同一角色重复出现，禁止角色分身或克隆"
25. 【导演指令】：整体创作意图和风格控制。格式："好莱坞大导演质感，电影级画面，写实风格，无特效，无科幻元素"

输出JSON格式:
{
  "shots": [
    {
      "shotId": "SC01",
      "fields": {
        "constraint": "画幅比例、分辨率、格式、帧率等技术约束",
        "baseline": "8K分辨率、画质风格、细节增强词",
        "scene": "场景环境描述（≥120字符，含地点、时间、空间、材质）",
        "lighting": "灯光设计（≥150字符，含主光方向+色温K值+光质+补光+背景光）",
        "composition": "构图设计（≥100字符，含景别+主体位置+线条引导+画框边缘）",
        "color_palette": "色彩方案（≥80字符，含主色调+辅助色+肤色+饱和度+对比度）",
        "depth_of_field": "景深控制（≥80字符，含焦点+光圈+前景/背景虚化+层次）",
        "camera_movement": "运镜设计（≥100字符，含运动方式+速度+时间分布+起止点）",
        "character": "角色外貌与姿态（根据实际角色设定，不要套用固定示例）",
        "costume": "服装描述（颜色、款式、质地、配饰）",
        "makeup": "妆容发型细节",
        "action": "具体动作（≥120字符，含手势+步伐+视线+情绪+姿态）",
        "props": "关键道具（手持物、桌面物品、背景物件）",
        "portraits": "定妆照引用路径（如：image://characters/角色名/portrait.png）",
        "dialogue": "角色台词（纯台词内容，不要写画外音/旁白）",
        "timeline": "时间轴（≥200字符，分≥3段，T00:XX格式，每段含画面+动作）",
        "mood": "情绪关键词（1-2个，如calm/professional/tense）",
        "pacing": "节奏（五段式：整体/开头/中段/高潮/结尾）",
        "transition": "转场方式（类型+持续时间+方向）",
        "audio": "音频（≥100字符，环境音+音乐风格+音量+BPM）",
        "negative": "负面约束（通用负面词+场景特定负面词）",
        "bright_constraint": "明亮约束（亮度/光照强制要求）",
        "character_constraint": "角色约束（只出现指定角色，禁止分身/克隆）",
        "director_instruction": "导演指令（≥80字符，风格定位+质感要求+禁忌）",
        "consistency": "跨镜头一致性（角色/光线/色调统一）"
      }
    }
  ]
}

【⚠️ 重要：示例仅用于展示字段结构，不得直接复制内容】
上述示例中的具体描述（如"三甲医院检验科走廊"、"藏青色警服"等）仅为字段格式演示，
实际生成时必须根据当前项目的真实场景、真实角色、真实内容重新创作，严禁照搬示例内容。
每个字段必须根据镜头信息独立生成，与示例无关。

关键要求：
1. 【内容充分性要求】每个字段描述必须充分详细，参考以下最低字符数要求：
   - 【场景】≥120字符（须含地点、时间、空间布局、材质细节）
   - 【灯光/照明】≥150字符（须含主光方向+色温K值+光质+补光+背景光）
   - 【构图】≥100字符（须含景别+主体位置+线条引导+画框边缘）
   - 【动作】≥120字符（须含手势+步伐+视线+情绪表达+姿态变化）
   - 【运镜】≥100字符（须含运动方式+速度+时间分布+起止点）
   - 【时间轴】≥200字符（须分≥3段，每段含时间戳+画面内容+角色动作）
   - 【导演指令】≥80字符（须含风格定位+质感要求+禁忌声明）
   - 【色彩/色调】≥80字符（须含主色调+辅助色+肤色+饱和度+对比度）
   - 【景深】≥80字符（须含焦点位置+光圈值+前景/背景虚化+层次分离）
   - 【音频】≥100字符（须含环境音效+音乐风格+音量层级+BPM）
   - 如果某字段内容不足，请补充更多细节使其达标
2. 【台词】字段必须独立，角色直接对镜头说话，不要写"画外音""旁白"
3. 场景要具体真实（门诊室、宣教室、检查室），必须是写实环境，禁止科幻/抽象元素
3. 【动作】必须是真实物理动作和镜头运动：推近、跟拍、手持、站立、行走、手势、转身、注视镜头。严禁使用：全息投影、空间扭曲、时间残影、霓虹色、数据流、抽象构图、梦境流动性、湿版摄影、光即角色、AI瑕疵、宏大比例、微观世界
4. 禁止词汇（全字段通用）：全息、虚拟、投影、抽象、光影场域、数据空间、元宇宙、时间操控、霓虹、微观世界、宏观、抽象几何、流动光影、交织光影、色彩对冲、空间扭曲、时间残影、数据流、光即角色、梦境流动性、湿版摄影、AI瑕疵
5. 【场景】中不得出现含文字的物品描述：如"有文字的报告单"、"标牌上的文字"、"商标"、"有字的海报"等。可以描述"空白报告单"、"无文字标识牌"、"图形海报"等不含文字的物品
6. 不要混合成一段narrative，每个字段独立输出
7. 只描述本集内容，严禁预告后续集数
8. 保持角色视觉锚点一致
9. 负面约束要完整，包含两类：①通用负面词(no text/no watermark/no blurry等)；②场景特定负面词（教育类/医疗类/剧情类/广告类）
10. 【时间轴】必须使用T00:XX相对时间戳格式，至少3段
11. 【节奏】必须使用五段式描述（整体/开头/中段/高潮/结尾）
12. 【情绪】只使用1-2个关键词，避免堆砌同义词`;
  }

  async process(shots, blueprint) {
    console.log(`[PromptFusionAgent] 开始处理 ${shots.length} 个镜头（串行模式，避免并发超时）`);

    const ratio = blueprint.config?.aspectRatio || '16:9';
    const characters = blueprint.character_system?.characters || [];

    const results = new Array(shots.length);
    let failed = 0;

    // 【v2.1.4-fix11】串行处理，避免并发导致API超时
    for (let i = 0; i < shots.length; i++) {
      const shot = shots[i];
      console.log(`\n🎬 处理镜头 ${i + 1}/${shots.length}: ${shot.shotId}`);
      try {
        const fused = await this._fuseSingleShot(shot, ratio, characters);
        results[i] = fused;
        console.log(`  ✅ ${shot.shotId} 完成`);
      } catch (e) {
        failed++;
        console.warn(`  ❌ ${shot.shotId} 融合失败: ${e.message}`);
        // 尝试用fillMissingFields补全，而不是直接降级
        try {
          console.log(`  🔄 尝试补全缺失字段...`);
          const filled = await this._fillMissingFieldsWithRetry(shot, ratio, characters);
          results[i] = filled;
          console.log(`  ✅ ${shot.shotId} 补全完成`);
        } catch (fillError) {
          console.warn(`  ❌ ${shot.shotId} 补全也失败: ${fillError.message}，规则兜底`);
          results[i] = this._fallbackSingleShot(shot, ratio);
        }
      }
    }

    if (failed > 0) {
      console.warn(`[PromptFusionAgent] ⚠️ ${failed}/${shots.length} 镜头需要补全/兜底`);
    }
    console.log(`[PromptFusionAgent] 完成 ✓ | 降级: ${failed}/${shots.length}`);
    return { shots: results, degraded: failed > 0, degradeReason: null };
  }

  /**
   * 【v2.1.4-fix11】构建shot结果（用于补全后的组装）
   */
  _buildShotResult(shot, fields) {
    const expandedFields = { ...fields };
    const fullPrompt = this._assembleStandardPrompt(shot, fields, shot.ratio || '16:9');
    
    return {
      ...shot,
      ...expandedFields,
      fields,
      fusionText: fields.scene || '',
      prompt: fullPrompt,
      promptCharCount: this._countChars(fullPrompt),
      degraded: true,
      degradeReason: '主LLM超时，通过重试补全生成'
    };
  }

  async _fuseSingleShot(shot, ratio, characters) {
    const prompt = this._buildBatchPrompt([shot], ratio, characters);
    // 【v2.1.4-fix10-P25-fix3】把空 schema 换成带 25 字段键名的完整模板
    const schema = { shots: [buildFullSchema(shot.shotId)] };

    const llmResult = await this._callLLM(prompt, schema, () => {
      throw new Error('LLM fallback');
    });

    const fusionEntry = llmResult.result?.shots?.find(s => s.shotId === shot.shotId);
    let fields = fusionEntry?.fields || {};
    
    // 【v2.1.4-fix10】在 LLM 输出入口统一标准化为 snake_case
    fields = normalizeFields(fields);
    
    // 【v2.1.4-fix10-P25-fix3】字段完整性校验 + 定向补齐
    fields = await this._ensureFieldCompleteness(shot, fields, ratio, characters);
    
    // 【v2.1.4-fix9-P25-fix7】将 fields 中的关键字段展开到 shot 顶层
    const expandedFields = { ...fields };
    
    // 组装标准格式Prompt
    const fullPrompt = this._assembleStandardPrompt(shot, fields, ratio);

    return {
      ...shot,
      ...expandedFields,
      fields,
      fusionText: fields.scene || '',
      prompt: fullPrompt,
      promptCharCount: this._countChars(fullPrompt),
      degraded: false,
      degradeReason: null
    };
  }

  /**
   * 【v2.1.4-fix10-P25-fix3】字段完整性校验 + 定向补齐
   * 先校验，缺哪些就只让 LLM 补哪些，一次轻量调用搞定
   */
  async _ensureFieldCompleteness(shot, fields, ratio, characters) {
    // 1. 找出缺失或过短字段
    const missing = REQUIRED_FIELDS.filter(f => {
      const v = fields[f];
      if (!v || String(v).trim() === '') return true;
      const min = MIN_LEN[f] || 0;
      return min > 0 && this._countChars(String(v)) < min;
    });

    if (missing.length === 0) return fields; // 全齐，无需补

    console.log(`[PromptFusion] ${shot.shotId} 缺失/过短字段 ${missing.length} 个: ${missing.join(',')} → 定向补齐`);

    // 2. 只补缺失字段，给 LLM 一个极简、聚焦的 prompt
    const fillPrompt = this._buildFillPrompt(shot, missing, fields, ratio, characters);
    const fillSchema = { shotId: shot.shotId, fields: Object.fromEntries(missing.map(k => [k, STANDARD_FIELDS_SCHEMA[k]])) };

    try {
      const fillResult = await this._callLLM(fillPrompt, fillSchema, () => null, {
        maxRetries: 1,
        maxTokens: 4096 // 只补几个字段，预算充足
      });
      const fillFields = fillResult?.result?.fields || fillResult?.result?.[shot.shotId] || {};
      const normalized = normalizeFields(fillFields);
      for (const k of missing) {
        if (normalized[k] && String(normalized[k]).trim() !== '') {
          fields[k] = normalized[k];
        }
      }
    } catch (e) {
      console.warn(`[PromptFusion] ${shot.shotId} 补齐失败，保留已有: ${e.message}`);
    }

    // 3. 仍缺的字段，才用规则兜底（明确标记来源，便于审计）
    const stillMissing = REQUIRED_FIELDS.filter(f => !fields[f] || String(fields[f]).trim() === '');
    if (stillMissing.length > 0) {
      const shotData = this._extractFieldsFromShot(shot);
      for (const f of stillMissing) {
        if (shotData[f]) fields[f] = shotData[f];
        else fields[f] = this._defaultFieldValue(f, shot); // 见下
      }
      console.warn(`[PromptFusion] ${shot.shotId} 规则兜底 ${stillMissing.length} 字段`);
    }

    return fields;
  }

  /**
   * 【v2.1.4-fix13-审计修复】降为1次重试，去掉指数退避等待，失败后直接规则兜底
   */
  async _fillMissingFieldsWithRetry(shot, ratio, characters) {
    const maxRetries = 1;
    
    // 先从shot中提取已有数据
    const fields = {};
    const shotData = this._extractFieldsFromShot(shot);
    for (const f of REQUIRED_FIELDS) {
      fields[f] = shotData[f] || '';
    }
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      // 每次重试前检查剩余预算，避免重试吃掉全部时间
      const remaining = this._remainingMs();
      if (remaining < 30000) {
        console.warn(`  ⏰ 剩余预算不足(${remaining}ms)，中止重试，直接降级`);
        break;
      }

      try {
        console.log(`  🔄 补全尝试 ${attempt}/${maxRetries}...`);
        const filled = await this._ensureFieldCompleteness(shot, fields, ratio, characters);
        
        // 检查是否还有空字段
        const stillEmpty = REQUIRED_FIELDS.filter(f => !filled[f] || String(filled[f]).trim() === '');
        if (stillEmpty.length === 0) {
          console.log(`  ✅ 补全成功，所有字段已填充`);
          return this._buildShotResult(shot, filled);
        }
        console.log(`  ⚠️ 仍有 ${stillEmpty.length} 字段为空，继续重试...`);
      } catch (e) {
        console.warn(`  ❌ 补全尝试 ${attempt} 失败: ${e.message}`);
      }
    }
    
    // 【修复】重试用完仍有缺失，直接用规则兜底（不再 throw）
    console.warn(`  ⚠️ 补全重试耗尽，使用规则兜底`);
    return this._buildShotResult(shot, fields);
  }

  // 【v2.1.4-fix11】规则兜底默认值 - 25字段完整默认值，确保绝不返回空字符串
  _defaultFieldValue(field, shot) {
    const ratio = shot.ratio || '16:9';
    const sceneType = shot.sceneType || 'standard';
    const character = shot.character || '主角';
    
    const defaults = {
      director_instruction: '好莱坞电影级质感，写实风格，专业摄影布光，8K超高清',
      constraint: `Aspect ratio: ${ratio}, Resolution: 1920x1080, Format: MP4, Frame rate: 24fps, no text anywhere in frame, no subtitle, no caption, no watermark, no logo, no readable characters`,
      baseline: '8K resolution, cinematic quality, highly detailed, photorealistic, hyperrealistic, sharp focus, ultra high definition, lifelike textures, professional color grading',
      scene: `${sceneType}场景，室内写实环境，自然光线照射，真实材质质感，空间层次分明，环境细节丰富`,
      lighting: '主光：右侧45度自然光 5600K柔光漫射；补光：左前侧反光板填充阴影；背景光：轮廓光分离层次；光比3:1，整体明亮清晰',
      composition: '景别：中景（膝上）；主体位置：画面黄金分割点；线条引导：纵深层次感；画框边缘：适度留白',
      color_palette: '主色调：自然偏暖；辅助色：环境本色；肤色：自然健康；饱和度：中等自然；对比度：中高清晰',
      depth_of_field: '焦点：主体面部或动作中心；景深：中等（f/4），背景适度虚化；前景：轻微虚化增加层次；层次：前景-中景-背景三层分离',
      camera_movement: '0-3s：固定机位稳定构图；3-6s：缓慢推近或平移；6-10s：回到固定机位',
      character: `${character}，写实人物形象，自然姿态，真实表情，符合场景身份`,
      costume: '符合角色身份的写实服装，面料质感真实，颜色自然，款式简洁大方',
      makeup: '素颜或淡妆，妆容自然真实，发型整洁，符合日常生活场景',
      action: `${character}自然站立或行走，手部自然动作，眼神交流，真实肢体语言`,
      props: '场景中必要的写实道具，材质真实，无文字标识，符合场景功能',
      portraits: 'image://characters/default/portrait.png',
      dialogue: '',
      timeline: 'T00:00 - 开场构图，环境展示；T00:03 - 主体进入画面；T00:06 - 核心动作或对白；T00:09 - 收尾定格',
      mood: 'calm, professional, natural',
      pacing: '整体：沉稳中等节奏；开头：平缓引入；中段：自然推进；结尾：平稳收尾',
      transition: '自然切换，无特效转场，直接硬切或微淡入淡出',
      audio: '环境底噪真实自然，无明显配乐干扰，人声音量适中清晰，空间感真实',
      negative: 'no text anywhere in frame, no watermark, no logo, no subtitle, no caption, no blur, no distortion, no extra limbs, no deformed features, no cartoon style, no anime, no illustration, no painting, no 3D render, no CGI, no special effects, no abstract, no surreal',
      bright_constraint: 'bright lighting, well-lit scene, clear visibility, natural illumination, avoid dark shadows',
      character_constraint: '只出现指定角色一人，禁止其他人物入镜，禁止同一角色重复出现，禁止角色分身或克隆，保持角色形象一致',
      consistency: '保持角色面部特征、服装造型、发型妆容跨镜头一致，场景光线连续，色调统一'
    };
    
    const value = defaults[field];
    if (!value) {
      console.warn(`[PromptFusionAgent] 未知字段的默认值: ${field}`);
      return `[规则兜底] ${field} 默认值`;
    }
    return value;
  }

  // 补齐专用 prompt：只问缺失字段，附上已生成字段作为上下文
  _buildFillPrompt(shot, missing, existingFields, ratio, characters) {
    const ctx = Object.entries(existingFields)
      .filter(([k, v]) => v && String(v).trim())
      .map(([k, v]) => `${k}: ${String(v).slice(0, 80)}`)
      .join('\n');
    return `## 镜头补齐任务
镜头ID：${shot.shotId}（时长 ${shot.duration || '?'}s）
场景：${shot.scene || ''}
情绪：${shot.mood || ''}
台词：${(shot.dialogue?.lines?.map(l => l.content).join('; ') || shot.dialogue || '')}

## 已生成字段（保持风格一致）
${ctx}

## 本次只补齐以下字段，每个必须达到最低字符数
${missing.map(f => `- ${f}：${FIELD_DESCS[f]}`).join('\n')}

只输出 JSON，不要解释。`;
  }

  /**
   * 【v2.1.4-fix10-fix1】从 shot 对象提取字段数据，用于补充 LLM 缺失字段
   */
  _extractFieldsFromShot(shot) {
    const result = {};
    if (!shot) return result;
    
    // 提取已有数据
    if (shot.scene) result.scene = shot.scene;
    if (shot.mood) result.mood = shot.mood;
    if (shot.action) result.action = shot.action;
    if (shot.character) result.character = typeof shot.character === 'string' ? shot.character : shot.character?.name || '';
    if (shot.cameraString) result.camera_movement = shot.cameraString;
    if (shot.lightingString) result.lighting = shot.lightingString;
    if (shot.backgroundSoundString) result.audio = shot.backgroundSoundString;
    if (shot.dialogue) {
      const pureDialogue = shot.dialogueText || this._extractPureDialogue(shot.dialogue);
      if (pureDialogue) result.dialogue = `"${pureDialogue}"`;
    }
    if (shot.emotionalTarget) {
      const et = shot.emotionalTarget;
      result.mood = `${et.valence > 0.5 ? 'positive' : 'neutral'}, ${et.arousal > 0.5 ? 'high energy' : 'calm'}`;
    }
    if (shot.duration) {
      const d = shot.duration;
      const seg1 = Math.floor(d * 0.3);
      const seg2 = Math.floor(d * 0.6);
      result.timeline = `T00:00 - 全景establishing，环境展示；T00:0${seg1} - 中景推进，人物动作；T00:0${seg2} - 情绪收尾，光线平复`;
    }
    if (shot.characterRef) result.portraits = shot.characterRef;
    
    // 默认负面约束
    result.negative = 'no text anywhere in frame, no readable characters, no alphabets, no Chinese characters, no text on walls, no text on objects, no text on documents, no text on signs, no text on labels, no text on screens, no text on clothing, no text in background';
    result.bright_constraint = 'bright lighting, well-lit scene, clear visibility, no dark shadows on face, adequate illumination';
    result.character_constraint = `只出现${shot.character?.name || '角色'}一人，禁止其他人物入镜，禁止同一角色重复出现，禁止角色分身或克隆`;
    result.director_instruction = '好莱坞大导演质感，电影级画面，写实风格，无特效，无科幻元素';
    result.consistency = '保持角色形象一致，造型不变，面部特征与体型每帧统一';
    
    return result;
  }

  _fallbackSingleShot(shot, ratio) {
    const fallbackPrompt = this._assembleFullPrompt(shot, '', ratio);
    // 【v2.1.4-fix13-审计修复】保留原始 fields，避免降级时丢失所有字段
    const preservedFields = shot.fields && typeof shot.fields === 'object' && Object.keys(shot.fields).length > 0
      ? shot.fields
      : this._extractFieldsFromShot(shot);
    return {
      ...shot,
      fields: preservedFields,
      fusionText: '',
      prompt: fallbackPrompt,
      promptCharCount: this._countChars(fallbackPrompt),
      degraded: true,
      degradeReason: '单镜头 LLM 融合失败，规则兜底',
      _pf_fallback: true
    };
  }

  /**
   * 组装标准格式Prompt（按之前正常版本的字段格式）
   */
  _assembleStandardPrompt(shot, fields, ratio) {
    const parts = [];
    
    // 辅助函数：获取字段值（支持驼峰和下划线命名）
    const getField = (...names) => {
      for (const name of names) {
        if (fields[name] !== undefined && fields[name] !== null && fields[name] !== '') {
          return fields[name];
        }
      }
      return undefined;
    };

    // 【导演指令】⭐ 新增：整体创作意图
    const directorInstruction = getField('director_instruction', 'directorInstruction');
    if (directorInstruction) parts.push(`【导演指令】${directorInstruction}`);

    // 【约束】：必须包含画幅比例、分辨率、格式、帧率
    parts.push(`【约束】${fields.constraint || `Aspect ratio: ${ratio}, Resolution: 1920x1080, Format: MP4, Frame rate: 24fps, no text, no subtitle, no caption, no watermark, no text anywhere in frame, no readable characters, no alphabets, no Chinese characters, no text on walls, no text on objects, no text on documents, no text on signs, no text on labels, no text on screens, no text on clothing, no text in background`}`);

    // 【基础】：三类基础词——分辨率锚定+风格质量+细节增强
    parts.push(`【基础】${fields.baseline || '8K resolution, cinematic quality, highly detailed, photorealistic, intricate textures, sharp focus'}`);

    // 【场景】
    // 【v2.1.4-fix9-P5】场景强制写实：禁止科幻/抽象词汇
    let sceneDesc = fields.scene || shot.scene || '';
    const forbiddenWords = ['全息', '虚拟', '投影', '抽象', '光影场域', '数据空间', '元宇宙', '时间操控', '霓虹', '微观世界', '宏观', '抽象几何', '流动光影', '交织光影', '色彩对冲'];
    const hasForbidden = forbiddenWords.some(w => sceneDesc.includes(w));
    if (hasForbidden) {
      console.warn(`[PromptFusionAgent] ⚠️ 镜头 ${shot.shotId} 场景含禁止词汇: "${sceneDesc.substring(0, 50)}..."，强制替换为写实场景`);
      // 强制替换为写实场景
      const fallbackScenes = [
        '医院健康宣教室，白色荧光灯均匀照明，白墙面贴有无文字骨骼肌解剖图与运动损伤海报（纯图形版），木质讲台表面带有细微使用划痕，地面浅灰色防滑PVC地胶',
        '三甲医院检验科走廊，冷白色LED光源从走廊顶部连续排列向下照射，无文字箭头标识牌指向尿液检验窗口，地面浅色抛光瓷砖，墙面白色医用抗菌涂层',
        '医生诊室，白色墙面悬挂无文字人体解剖示意图（纯图形版），办公桌摆放听诊器与血压计，检查床铺有蓝色一次性床单，无影灯悬于上方，窗光透入',
        '医院健康管理中心，嵌入式LED灯带洒下柔和暖白光，接待台后方排列无文字健康宣传展板（纯图形版），前方皮质沙发与实木茶几，地面灰色哑光瓷砖'
      ];
      const index = parseInt(shot.shotId.replace(/\D/g, '')) || 0;
      sceneDesc = fallbackScenes[index % fallbackScenes.length];
    }
    if (sceneDesc) parts.push(`【场景】${sceneDesc}`);

    // 【灯光/照明】⭐ 新增：专业灯光设计
    const lightingField = getField('lighting');
    if (lightingField) parts.push(`【灯光/照明】${lightingField}`);

    // 【构图】⭐ 新增：景别+画面比例+主体位置+线条引导
    const compositionField = getField('composition');
    if (compositionField) parts.push(`【构图】${compositionField}`);

    // 【色彩/色调】⭐ 新增：调色方案+色温倾向+饱和度
    const colorPalette = getField('color_palette', 'colorPalette');
    if (colorPalette) parts.push(`【色彩/色调】${colorPalette}`);

    // 【景深】⭐ 新增：焦点控制+虚化程度+前景/背景层次
    const depthOfField = getField('depth_of_field', 'depthOfField');
    if (depthOfField) parts.push(`【景深】${depthOfField}`);

    // 【运镜】⭐ 新增：镜头运动方式（从【动作】拆分）
    const cameraMovement = getField('camera_movement', 'cameraMovement');
    if (cameraMovement) parts.push(`【运镜】${cameraMovement}`);

    // 【角色】
    // 【v2.1.4-fix9-P4】角色服装锁定：强制使用原始角色设定中的服装
    let characterDesc = fields.character || '';
    if (characterDesc && shot.character) {
      // 如果LLM输出的角色描述中没有"警"字，但原始角色设定有，则强制替换
      const originalChar = shot.character || '';
      if (originalChar.includes('警') && !characterDesc.includes('警')) {
        // LLM擅自改了服装，从原始角色描述中提取姓名+服装
        const nameMatch = originalChar.match(/([^,，]+警[^,，]+)/);
        if (nameMatch) {
          characterDesc = characterDesc.replace(/(身着|穿着|身穿|着)[^，]+/, nameMatch[1]);
          // 如果没替换成功，直接在描述开头插入正确服装
          if (!characterDesc.includes('警')) {
            characterDesc = originalChar + '，' + characterDesc;
          }
        }
      }
    }
    if (characterDesc) parts.push(`【角色】${characterDesc}`);

    // 【服装】⭐ 新增：详细服装描述（从【角色】拆分）
    const costumeField = getField('costume');
    if (costumeField) parts.push(`【服装】${costumeField}`);

    // 【化妆】⭐ 新增：妆容、发型细节
    const makeupField = getField('makeup');
    if (makeupField) parts.push(`【化妆】${makeupField}`);

    // 【动作】
    // 【v2.1.4-fix9-P9】动作强制写实：禁止科幻/抽象词汇
    let actionDesc = getField('action') || shot.action || '';
    const actionForbidden = ['全息', '虚拟', '投影', '空间扭曲', '时间残影', '霓虹', '数据流', '光即角色', '抽象构图', '梦境流动性', '手绘动画'];
    const actionHasForbidden = actionForbidden.some(w => actionDesc.includes(w));
    if (actionHasForbidden) {
      console.warn(`[PromptFusionAgent] ⚠️ 镜头 ${shot.shotId} 动作含禁止词汇: "${actionDesc.substring(0, 50)}..."，强制替换为写实动作`);
      // 提取角色名
      const charName = shot.character?.name || '示例角色';
      // 根据场景类型生成写实动作
      const fallbackActions = [
        '镜头缓慢推近，示例角色站立讲台前，自然手势讲解，眼神注视镜头，警服在荧光灯下轮廓清晰',
        '稳定机位中景，示例角色沿走廊缓步前行，侧头指向检验窗口，白大褂医生从背景走过',
        '手持微晃跟拍，示例角色靠近检查床，手指轻触医学挂图，无影灯在头顶形成柔和光晕',
        '固定机位中景，示例角色坐于沙发边缘，双手交叠置于膝上，LED灯带在身后形成均匀轮廓光',
        '缓慢后拉全景，示例角色站立检验窗口前，转身面向镜头，不锈钢台面反射冷白色光源'
      ];
      const idx = parseInt(shot.shotId.replace(/\D/g, '')) || 0;
      actionDesc = fallbackActions[idx % fallbackActions.length];
    }
    if (actionDesc) parts.push(`【动作】${actionDesc}`);

    // 【道具】⭐ 新增：关键道具（手持物、桌面物品、背景物件）
    const propsField = getField('props');
    if (propsField) parts.push(`【道具】${propsField}`);

    // 【定妆照】
    const portraitsField = getField('portraits');
    if (portraitsField) parts.push(`【定妆照】${portraitsField}`);

    // 台词
    // 【v2.1.6】优先使用 dialogueBlocks 渲染为 Seedance 2.0 内联格式
    if (shot.dialogueBlocks && Array.isArray(shot.dialogueBlocks) && shot.dialogueBlocks.length > 0) {
      const renderedDialogue = this._renderDialogueBlocks(shot.dialogueBlocks, shot.duration || 10);
      if (renderedDialogue) {
        parts.push(renderedDialogue);
      }
    } else {
      // 回退：使用旧的 dialogue 字段
      const dialogueField = getField('dialogue');
      if (dialogueField) {
        // 【v2.1.4-fix13】确保台词有【台词】前缀
        const dialogueText = dialogueField.startsWith('【台词】') ? dialogueField : `【台词】${dialogueField}`;
        parts.push(dialogueText);
      }
    }

    // 【时间轴】镜头内部微观导演调度（T00:XX相对时间戳格式）
    const timelineField = getField('timeline');
    if (timelineField) {
      parts.push(`【时间轴】${timelineField}`);
    } else {
      // 兜底：使用T00:XX相对时间戳格式，至少3段
      const duration = shot.duration || 10;
      const seg1 = Math.floor(duration * 0.3);
      const seg2 = Math.floor(duration * 0.6);
      parts.push(`【时间轴】T00:00 - 全景establishing，环境展示，冷静氛围；T00:0${seg1} - 中景推进，人物动作，情绪升温；T00:0${seg2} - 情绪收尾，光线平复`);
    }

    // 【情绪】
    const moodField = getField('mood');
    if (moodField) parts.push(`【情绪】${moodField}`);

    // 【节奏】⭐ 新增：镜头速度+紧迫感+舒缓度
    const pacingField = getField('pacing');
    if (pacingField) parts.push(`【节奏】${pacingField}`);

    // 【转场】⭐ 新增：与下一镜头的衔接方式
    const transitionField = getField('transition');
    if (transitionField) parts.push(`【转场】${transitionField}`);

    // 【音频】
    const audioField = getField('audio');
    if (audioField) parts.push(`【音频】${audioField}`);

    // 【负面约束】：通用负面词 + 场景特定负面词
    const negativeField = getField('negative');
    if (negativeField) {
      parts.push(`【负面约束】${negativeField}`);
    } else {
      // 兜底：通用负面词 + 教育/医疗场景特定负面词
      parts.push(`【负面约束】no text, no watermark, no caption, no subtitle, no logo, no blurry, no low resolution, no pixelated, no distorted, no artifacts, no compression noise, no extra limbs, no deformed hands, no malformed fingers, no extra fingers, no fused fingers`);
      parts.push(`no cartoon style, no flat lighting, no text anywhere in frame, no readable characters, no alphabets, no Chinese characters, no text on walls, no text on objects, no text on documents, no text on signs, no text on labels, no text on screens, no text on clothing, no text in background`);
      parts.push(`no brand logos with text, no text in medical charts, no text on posters, no text on billboards, no text on packaging, no handwritten text, no printed text, no signage text, no text overlays, no UI elements with text`);
    }

    // 【明亮约束】⭐ 新增：亮度/光照强制要求，防止暗场
    const brightConstraint = getField('bright_constraint', 'brightConstraint');
    if (brightConstraint) {
      parts.push(`【明亮约束】${brightConstraint}`);
    } else {
      // 兜底：强制明亮
      parts.push(`【明亮约束】bright lighting, well-lit scene, clear visibility, no dark shadows on face, adequate illumination`);
    }

    // 【角色约束】⭐ 新增：防止多角色/分身
    const characterConstraint = getField('character_constraint', 'characterConstraint');
    if (characterConstraint) {
      parts.push(`【角色约束】${characterConstraint}`);
    } else if (shot.character && shot.character !== 'NONE') {
      // 兜底：根据角色名自动生成
      const charName = shot.character.name || shot.character;
      parts.push(`【角色约束】只出现${charName}一人，禁止其他人物入镜，禁止同一角色重复出现，禁止角色分身或克隆`);
    }

    // 【角色一致性】
    const consistencyField = getField('consistency');
    if (consistencyField) parts.push(`【角色一致性】${consistencyField}`);

    // 合并
    let fullPrompt = parts.join('，');
    
    // 截断
    if (this._countChars(fullPrompt) > this.maxPromptLength) {
      fullPrompt = this._truncateStandardPrompt(fullPrompt);
    }

    return fullPrompt;
  }

  /**
   * 组装完整Prompt（降级路径，保留原有逻辑）
   */
  _assembleFullPrompt(shot, fusionText, ratio) {
    const parts = [];

    // L1: 约束层
    // 【v2.1.4-fix9-P25】约束字段：画幅+分辨率+格式+帧率+禁止项
    parts.push(`Aspect ratio: ${ratio}, Resolution: 1920x1080, Format: MP4, Frame rate: 24fps, no text, no subtitle, no caption, no watermark, no text anywhere in frame, no readable characters, no alphabets, no Chinese characters, no text on walls, no text on objects, no text on documents, no text on signs, no text on labels, no text on screens, no text on clothing, no text in background`);

    // L2: 基础层
    // 【v2.1.4-fix9-P25】基础字段：分辨率锚定+风格质量+细节增强
    parts.push('8K resolution, cinematic quality, highly detailed, photorealistic, intricate textures, sharp focus');

    // L3-L7: 融合段
    if (fusionText) {
      parts.push(fusionText);
    } else {
      // 【v2.1.4-fix9-P11】降级路径也强制写实场景和动作
      let sceneDesc = shot.scene || '';
      const sceneForbidden = ['全息', '虚拟', '投影', '抽象', '光影场域', '数据空间', '元宇宙', '时间操控', '霓虹', '微观世界', '宏观', '抽象几何', '流动光影', '交织光影', '色彩对冲'];
      if (sceneForbidden.some(w => sceneDesc.includes(w))) {
        const fallbackScenes = [
          '医院健康宣教室，白色荧光灯均匀照明，白墙面贴有无文字骨骼肌解剖图与运动损伤海报（纯图形版），木质讲台表面带有细微使用划痕，地面浅灰色防滑PVC地胶',
          '三甲医院检验科走廊，冷白色LED光源从走廊顶部连续排列向下照射，无文字箭头标识牌指向尿液检验窗口，地面浅色抛光瓷砖，墙面白色医用抗菌涂层',
          '医生诊室，白色墙面悬挂无文字人体解剖示意图（纯图形版），办公桌摆放听诊器与血压计，检查床铺有蓝色一次性床单，无影灯悬于上方，窗光透入',
          '医院健康管理中心，嵌入式LED灯带洒下柔和暖白光，接待台后方排列无文字健康宣传展板（纯图形版），前方皮质沙发与实木茶几，地面灰色哑光瓷砖'
        ];
        const idx = parseInt(shot.shotId?.replace(/\D/g, '') || '0') || 0;
        sceneDesc = fallbackScenes[idx % fallbackScenes.length];
      }
      parts.push(sceneDesc);
      
      if (shot.character && shot.character !== 'NONE') parts.push(shot.character);
      
      let actionDesc = shot.action || '';
      const actionForbidden = ['全息', '虚拟', '投影', '空间扭曲', '时间残影', '霓虹', '数据流', '光即角色', '抽象构图', '梦境流动性', '手绘动画', '湿版摄影', '黑色电影'];
      if (actionForbidden.some(w => actionDesc.includes(w))) {
        const fallbackActions = [
          '镜头缓慢推近，示例角色站立讲台前，自然手势讲解，眼神注视镜头，警服在荧光灯下轮廓清晰',
          '稳定机位中景，示例角色沿走廊缓步前行，侧头指向检验窗口，白大褂医生从背景走过',
          '手持微晃跟拍，示例角色靠近检查床，手指轻触医学挂图，无影灯在头顶形成柔和光晕',
          '固定机位中景，示例角色坐于沙发边缘，双手交叠置于膝上，LED灯带在身后形成均匀轮廓光',
          '缓慢后拉全景，示例角色站立检验窗口前，转身面向镜头，不锈钢台面反射冷白色光源'
        ];
        const idx = parseInt(shot.shotId?.replace(/\D/g, '') || '0') || 0;
        actionDesc = fallbackActions[idx % fallbackActions.length];
      }
      if (actionDesc) parts.push(actionDesc);
      
      const pureDialogue = shot.dialogueText || this._extractPureDialogue(shot.dialogue);
      if (pureDialogue && pureDialogue !== '') parts.push(`"${pureDialogue}"`);
      if (shot.cameraString) parts.push(shot.cameraString);
      if (shot.lightingString) parts.push(shot.lightingString);
      if (shot.mood) parts.push(`mood: ${shot.mood}`);
      if (shot.backgroundSoundString) parts.push(`audio: ${shot.backgroundSoundString}`);
    }

    // L9: 质控层
    // 【v2.1.4-fix9-P14】全局禁止文字：详细负面约束覆盖所有可能含文字的位置
    parts.push('no voiceover, no narration, no metal_gloss, no unnatural_eye_color, no text anywhere in frame, no readable characters, no alphabets, no Chinese characters');
    parts.push('no text on walls, no text on objects, no text on documents, no text on signs, no text on labels, no text on screens, no text on clothing, no text in background');
    parts.push('no brand logos with text, no text in medical charts, no text on posters, no text on billboards, no text on packaging, no handwritten text, no printed text, no signage text');
    parts.push('no text overlays, no UI elements with text, no text on book covers, no text on medicine bottles, no text on report forms, no text on devices, no text on badges, no text on nameplates');
    parts.push('no text on doors, no text on windows, no text on floors, no text on ceilings');

    let fullPrompt = parts.filter(p => p).join(', ');
    if (this._countChars(fullPrompt) > this.maxPromptLength) {
      fullPrompt = this._truncateWithPriority(fullPrompt, parts);
    }

    return fullPrompt;
  }

  /**
   * 【审计修复】按字段压缩而非整段砍除：保留全部25个【字段】标签，只压缩字段内文案
   */
  _truncateStandardPrompt(fullPrompt) {
    if (this._countChars(fullPrompt) <= this.maxPromptLength) return fullPrompt;
    // 按字段标签切分
    const segments = fullPrompt.split(/(?=【)/);
    if (segments.length <= 1) return fullPrompt.substring(0, this.maxPromptLength);
    // 计算每个字段当前字符数，等比压缩到目标长度
    const target = this.maxPromptLength;
    const totalNow = this._countChars(fullPrompt);
    const ratio = target / totalNow;
    const compressed = segments.map(seg => {
      const segLen = this._countChars(seg);
      const want = Math.max(40, Math.floor(segLen * ratio)); // 每字段至少保留40字符
      if (segLen <= want) return seg;
      // 保留字段标签头，截断内容
      const headMatch = seg.match(/^(【[^】]+】)/);
      const head = headMatch ? headMatch[1] : '';
      const body = seg.slice(head.length);
      let kept = body;
      while (this._countChars(head + kept) > want && kept.length > 20) {
        kept = kept.substring(0, kept.length - 10);
      }
      return head + kept;
    });
    return compressed.join('').trim();
  }

  _truncateWithPriority(fullPrompt, parts) {
    // 复用相同的按字段压缩逻辑
    return this._truncateStandardPrompt(fullPrompt);
  }

  _countChars(str) {
    if (!str) return 0;
    let count = 0;
    for (const char of str) {
      count += (char.charCodeAt(0) > 127) ? 1.5 : 1;
    }
    return Math.ceil(count);
  }

  _extractPureDialogue(dialogue) {
    if (!dialogue || typeof dialogue !== 'string') return dialogue;
    const parts = dialogue.split(/[|;]/);
    if (parts.length >= 5) {
      return parts[3].trim();
    }
    return dialogue.trim();
  }

  /**
   * 【v2.1.6】将 DIALOGUE_BLOCK 数组渲染为 Seedance 2.0 内联对话格式
   * 格式：【台词】[时间戳] 角色 trigger, emotion 说："line"
   */
  _renderDialogueBlocks(blocks, duration) {
    if (!blocks || blocks.length === 0) return '';
    
    const lines = [];
    const segmentDuration = duration / blocks.length;
    
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      const startTime = Math.round(i * segmentDuration);
      const endTime = Math.round((i + 1) * segmentDuration);
      const timeStr = `[${String(startTime).padStart(2, '0')}s-${String(endTime).padStart(2, '0')}s]`;
      
      // 构建内联格式
      const trigger = b.trigger || 'looks at camera';
      const emotion = b.emotion || 'neutral';
      const line = b.line || '';
      const speaker = b.speaker || '角色';
      
      // Seedance 2.0 格式：时间戳 + 动作触发 + 情绪副词 + 说："台词"
      lines.push(`${timeStr} ${speaker} ${trigger}, ${emotion} 说："${line}"`);
    }
    
    return '【台词】' + lines.join('\n');
  }

  _buildBatchPrompt(shots, ratio, characters) {
    const characterInfo = characters.map(c => `- ${c.name}: ${c.description || ''}`).join('\n');

    const shotsInfo = shots.map(s => {
      const pureDialogue = s.dialogue?.lines?.map(l => l.content).join('; ') || 
                          (s.dialogue ? this._extractPureDialogue(s.dialogue) : '');
      return `${s.shotId}(${s.duration || '?'}s): ${s.scene || ''} | ${s.mood || ''} | ${pureDialogue} | 运镜:${s.cameraString || ''} | 灯光:${s.lightingString || ''}`;
    }).join('\n');
    
    // 【v2.1.4-fix9-P1】构建导演上下文
    const directorContext = this._buildDirectorContext(shots);

    const sufficiency = [
      '【字段最低字符数 - 硬性要求，不达标会被打回重写】',
      ' scene ≥ 120 | lighting ≥ 150 | composition ≥ 100 | action ≥ 120',
      ' camera_movement ≥ 100 | timeline ≥ 200 | director_instruction ≥ 80',
      ' color_palette ≥ 80 | depth_of_field ≥ 80 | audio ≥ 100',
      ' 其余字段 ≥ 40 字符',
      ' 全部 25 个字段必须全部输出，禁止省略任何一个。'
    ].join('\n');

    return `${directorContext}
画幅:${ratio}
角色:${characterInfo || '无'}
镜头:\n${shotsInfo}

${sufficiency}

任务:为每个镜头生成标准字段格式的导演分镜提示词。

【角色服装锁定 - 强制不可修改】
角色服装必须与角色设定完全一致，禁止根据场景修改：
- 正确："示例角色女士，穿警服的陈女士，健康科普主讲人，短发，站姿挺拔"
- 错误："白色医生服"、"白大褂"、"浅蓝色衬衫"（禁止根据场景更换服装）
【角色】字段必须严格使用角色设定中的原始服装描述，不可自由发挥。

【动作写实锁定 - 强制不可修改】
【动作】字段必须是真实物理动作和镜头运动，严禁使用任何科幻/抽象/超现实词汇：
- 正确："镜头缓慢推近，示例角色站立讲台前，自然手势讲解"
- 错误："全息投影"、"空间扭曲"、"时间残影"、"霓虹色数据流"、"抽象构图"、"梦境流动性"、"湿版摄影"、"光即角色"
- 正确运镜：推近、跟拍、手持、稳定器、缓慢后拉、固定机位
- 错误运镜：无人机穿越微观世界、时间操控慢动作、宏大比例展示

要求：
1. 按标准字段输出：【约束】【基础】【场景】【灯光/照明】【构图】【色彩/色调】【景深】【运镜】【角色】【服装】【化妆】【动作】【道具】【定妆照】【台词】【时间轴】【情绪】【节奏】【转场】【音频】【负面约束】【明亮约束】【角色约束】【导演指令】【角色一致性】
2. 【台词】字段必须独立，角色直接对镜头说话，不要写"画外音""旁白"
3. 场景要具体专业（门诊室、宣教室、检查室），不要写"社区健身区"。场景中不得出现含文字的物品：如"有文字的报告单"、"标牌上的文字"、"商标"、"有字的海报"等。可以描述"空白报告单"、"无文字标识牌"、"图形海报"等不含文字的物品
4. 负面约束要完整，包含10+条排除项，必须包含全局禁止文字：no text anywhere in frame, no readable characters, no alphabets, no Chinese characters, no text on walls objects documents signs labels screens clothing packaging, no handwritten text, no printed text, no signage text, no text overlays, no UI elements with text
5. 只输出JSON，不要解释

输出:{"shots":[{"shotId":"SC01","fields":{...}}]}`;
  }
  
  /**
   * 【v2.1.4-fix9-P1】构建导演上下文
   */
  _buildDirectorContext(shots) {
    // 从第一个 shot 的 blueprint 引用中提取上下文
    const firstShot = shots[0];
    const blueprint = firstShot?._blueprint || {};
    const config = blueprint.config || {};
    
    const title = blueprint.title || config.title || '未命名';
    const contentTheme = config.content_theme || '';
    const sceneRequirement = config.scene_requirement || '';
    const characterDescription = config.character_description || '';
    const forbiddenScenes = config.forbidden_scenes || [];
    const keyMessages = config.key_messages || [];
    
    return `## 🎬 导演指令上下文
视频标题：${title}
内容主题：${contentTheme}
场景要求：${sceneRequirement}
角色设定：${characterDescription}
关键信息：${keyMessages.join('；') || '无'}
禁止场景：${forbiddenScenes.join('、') || '无'}

`;
  }

  _fallbackBatch(shots, ratio) {
    console.log(`[PromptFusionAgent] 批量降级...`);
    return {
      shots: shots.map(shot => ({
        shotId: shot.shotId,
        fields: {}
      }))
    };
  }
}

module.exports = { PromptFusionAgent };