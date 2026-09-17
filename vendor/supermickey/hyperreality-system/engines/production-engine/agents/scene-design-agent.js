/**
 * SceneDesignAgent - 场景设计Agent
 * 负责: 场景五维描述、情绪设计、动作设计
 */
const { BaseAgent } = require('./base-agent');

class SceneDesignAgent extends BaseAgent {
  constructor(options = {}) {
    super({ name: 'SceneDesignAgent', ...options });
    this._currentBlueprint = null; // 【v2.1.4-fix13】存储当前 blueprint 用于动态提示词
  }

  /**
   * 【v2.1.4-fix13-审计修复】动态生成系统提示词，使用当前 blueprint
   */
  _getSystemPrompt() {
    return this._getDynamicSystemPrompt(this._currentBlueprint || {});
  }

  /**
   * 【v2.1.4-fix13-审计修复】动态生成系统提示词，根据 blueprint 主题选择场景
   */
  _getDynamicSystemPrompt(blueprint = {}) {
    // 从 blueprint 提取主题信息
    const meta = blueprint._metadata || blueprint.config?._metadata || {};
    const title = blueprint.title || meta.title || '视频';
    const genre = blueprint.genre || meta.genre || '科普';
    const setting = blueprint.setting || meta.setting || '';
    
    // 动态生成场景选项，避免硬编码医院场景
    const sceneOptions = this._generateSceneOptions(blueprint);
    
    return `你是一位专业的电影场景设计师。根据剧本场景信息，为每个镜头设计完整的场景描述、情绪基调和角色动作。

【绝对约束 - 违反则输出无效】
1. 场景必须从以下选项中选择（或基于这些选项的合理变体）：
${sceneOptions}
2. 禁止自创科幻/抽象场景
3. 禁止词汇：全息、虚拟、投影、抽象、概念、光影场域、数据空间、数字、元宇宙、时间操控、霓虹、微观世界、宏观、抽象几何、流动光影、交织光影、色彩对冲
4. 光线必须是真实光源：荧光灯、LED顶灯、窗光、无影灯、自然光
5. 角色必须在真实地面站立，背景必须是真实墙面
6. 场景描述中不得出现含文字的物品：如"有文字的报告单"、"标牌上的文字"、"商标"、"有字的海报"等。可以描述"空白报告单"、"无文字标识牌"、"图形海报"等不含文字的物品
7. 场景描述中的"海报"、"展板"、"标识牌"等物品必须是无文字版本（纯图形/色彩/图案）

输出JSON格式要求:
{
  "shots": [
    {
      "shotId": "SC01",
      "scene": "具体场景描述，包含墙面材质、灯光类型、家具设备",
      "genre": "镜头影片类型（从 drama/sci-fi/war/horror/comedy/suspense/thriller/action/loneliness/documentary/fantasy 中选一个最贴切的）",
      "mood": "情绪关键词和氛围描述",
      "action": "角色动作描述（含肢体语言、走位）",
      "makeup": "角色妆容描述（妆容风格+发型+面部细节，20-40字）",
      "props": "关键道具描述（手持物、桌面物品、背景物件，20-40字）",
      "emotional_target": "场景情绪目标"
    }
  ]
}

设计原则:
1. 场景描述要具体真实：包含墙面材质、灯光类型、设备、地面材质
2. 情绪要与台词匹配
3. 动作要自然：走动、手势、转身、指向等
4. 化妆要场景化：手术室→无菌无妆，战场→汗水/泥土，舞会→精致妆容，日常→素颜/淡妆
5. 道具要具体：从台词和场景中推断，不是"必要道具"而是"具体物品"
6. 考虑镜头连续性：相邻场景的环境和光线要有逻辑关联;`;
  }

  /**
   * 【v2.1.6】删除硬编码场景池，改为开放式场景设计指导
   * LLM 根据剧本内容自由设计写实场景，系统通过约束规则保证质量
   */
  _generateSceneOptions(blueprint = {}) {
    const meta = blueprint._metadata || blueprint.config?._metadata || {};
    const genre = blueprint.genre || meta.genre || '';
    const title = blueprint.title || meta.title || '';
    const settingHint = blueprint.setting || meta.setting || '';
    
    // 【v2.1.6】不再提供固定场景选项，而是提供设计原则
    return `【场景设计原则】
1. 根据剧本的 setting、scene_theme、dialogue 自由设计具体写实场景
2. 场景描述必须包含：墙面材质、灯光类型（真实光源）、家具/设备、地面材质
3. 光线必须是真实光源：荧光灯、LED顶灯、窗光、无影灯、自然光
4. 角色必须在真实地面站立，背景必须是真实墙面
5. 场景描述中不得出现含文字的物品，可以描述"空白报告单"、"无文字标识牌"、"图形海报"
6. 禁止自创科幻/抽象场景
7. 禁止词汇：全息、虚拟、投影、抽象、概念、光影场域、数据空间、数字、元宇宙、时间操控、霓虹、微观世界、宏观、抽象几何、流动光影、交织光影、色彩对冲`;
  }

  async process(shots, blueprint) {
    console.log(`[SceneDesignAgent] 开始处理 ${shots.length} 个镜头...`);

    // 【v2.1.4-fix13-审计修复】存储 blueprint 供 _getSystemPrompt 动态使用
    this._currentBlueprint = blueprint;

    const prompt = this._buildPrompt(shots, blueprint);

    const schema = {
      required: ['shots'], requiredArrays: ['shots'], rejectEmptyArray: true, // 【P1-6 修复】启用数组类型校验
    };

    // 【2026-07-17】关键环节标记：场景设计必须 LLM 驱动
    const llmResult = await this._callLLM(prompt, schema, () => {
      // 降级：使用原规则方法
      return this._fallback(shots);
    }, { critical: true });

    if (llmResult.degraded) {
      return { shots: llmResult.result?.shots || shots, degraded: true, degradeReason: llmResult.degradeReason };
    }

    // 合并LLM结果回原shots
    const forbiddenWords = ['全息', '虚拟', '投影', '抽象', '光影场域', '数据空间', '元宇宙', '时间操控', '霓虹', '微观世界', '宏观', '抽象几何', '流动光影', '交织光影', '色彩对冲'];
    
    const designedShots = shots.map((shot, index) => {
      const designed = llmResult.result?.shots?.find(s => s.shotId === shot.shotId) || {};
      let scene = designed.scene || shot.scene || '';
      
      // 【v2.1.4-fix9-P5】场景校验：包含禁止词汇则使用兜底场景
      const hasForbidden = forbiddenWords.some(w => scene.includes(w));
      if (hasForbidden) {
        console.warn(`[SceneDesignAgent] ⚠️ 镜头 ${shot.shotId} 包含禁止词汇: "${scene}"，使用兜底场景`);
        // 根据镜头索引分配兜底场景
        const fallbackScenes = [
          '场景A: 室内主场景，自然光/顶灯照明，墙面材质真实，核心家具摆放有序，地面材质清晰可见',
          '场景B: 过渡空间走廊/通道，功能性指示牌，辅助照明，地面反光自然',
          '场景C: 专业场景/工作室，设备/仪器排列，工作台整洁，专业工具可见',
          '场景D: 公共空间/大厅，接待区布置，展示墙/展板，柔和照明，座椅舒适'
        ];
        scene = fallbackScenes[index % fallbackScenes.length];
      }
      
      return {
        ...shot,
        scene: scene,
        genre: designed.genre || shot.genre || '', // 【v2.3.3-A1】镜头级影片类型字段，供技能路由三级识别
        mood: designed.mood || shot.mood || '',
        action: designed.action || shot.action || '',
        // ⭐ v2.1.7: 新增化妆/道具
        makeup: designed.makeup || shot.makeup || '',
        props: designed.props || shot.props || '',
        emotional_target: designed.emotional_target || ''
      };
    });

    console.log(`[SceneDesignAgent] 完成 ✓`);
    return { shots: designedShots, degraded: false, degradeReason: null };
  }

  _buildPrompt(shots, blueprint) {
    const characters = blueprint.character_system?.characters || [];
    const characterDesc = characters.map(c =>
      `- ${c.name}: ${c.description || '无描述'}${c.portraitPaths ? ' [有定妆照]' : ''}`
    ).join('\n');

    const shotsInfo = shots.map((s, idx) => {
      const dialogue = s.dialogue?.lines?.map(l => `"${l.content}"`).join('; ') || s.dialogue || '';
      const existingScene = s.scene || '';
      return `镜头 ${s.shotId}: ${s.duration || '?'}s; 现有场景: ${existingScene.substring(0, 60)}; 台词: ${dialogue.substring(0, 80)}`;
    }).join('\n');
    
    // 【v2.1.4-fix13-审计修复】动态生成场景选项，避免硬编码
    const sceneOptions = this._generateSceneOptions(blueprint);
    const directorContext = this._buildDirectorContext(blueprint);

    return `${directorContext}

## 角色
${characterDesc || '无'}

## 镜头
${shotsInfo}

## 任务
为每个镜头设计场景、情绪和动作。

【重要】场景设计指导：
1. 如果现有场景已写实且具体，保留并细化细节
2. 如果现有场景为空或不写实，根据以下原则自由设计写实场景：
${sceneOptions}

【设计要求】
1. scene: 输出最终场景描述（必须是写实环境，50-80字）
2. mood: 情绪氛围（15-25字）
3. action: 角色动作（肢体语言、走位、手势，30-50字）
4. makeup: 角色妆容（根据场景自动推导：手术室→无菌无妆，战场→汗水/泥土，舞会→精致妆容，日常→素颜/淡妆，20-40字）
5. props: 关键道具（从台词和场景中推断具体物品：手持物、桌面物品、背景物件，20-40字）
6. emotional_target: 情绪目标（1个词）
7. genre: 镜头影片类型，从 drama/sci-fi/war/horror/comedy/suspense/thriller/action/loneliness/documentary/fantasy 中选一个最贴切的（依据故事世界判断：火星/太空→sci-fi，战场/军队→war，不要默认 drama）

【强制约束 - 违反则输出无效】
- 场景描述必须包含具体物理细节：墙面材质、灯光类型、家具/设备、地面材质
- 禁止使用以下任何词汇：全息、虚拟、投影、抽象、概念、光影场域、数据空间、数字、元宇宙、时间操控、霓虹、微观世界、宏观、抽象几何、流动光影、交织光影、色彩对冲
- 光线必须是真实光源：荧光灯、LED顶灯、窗光、无影灯、自然光
- 角色必须在真实地面站立，背景必须是真实墙面

输出JSON: {"shots": [{"shotId":"SC01","scene":"具体场景描述，50-80字","genre":"sci-fi等类型词","mood":"...","action":"...","makeup":"...","props":"...","emotional_target":"..."}]}

【电影场景设计心法（写实之上的第二层要求）】
1. 每个场景都是情绪的容器：先定情绪，再选材质。夜戏悬念=深木色+灯笼暖光+大面积暗部；晨戏释放=青灰/金色天光+通透空气感。材质、光源、色彩必须联手说同一种情绪。
2. scene 描述四件套升级五件套：墙面材质/地面/真实光源/家具设备 + 一个'情绪细节'（灯笼光晕里的浮尘/湿润反光的青石板），这个细节是观众潜意识感受到氛围的来源。
3. action 写'小动作里的情绪'：敬畏=退半步+垂眼；决绝=咬肌紧绷；松弛=肩膀松下来+一口长气。禁止'表情严肃''心情沉重'这类演不出来的描述。
4. makeup 与 props 必须服务身份与主题：工匠的旧茧、咬绳磨损的牙、腰间的绳圈——每一件都是故事的物证。
5. 相邻场景的光线必须有时间逻辑：同一条街，夜→黎明→清晨的色温变化（2800K→5000K→5500K）要写进设计，光是这个片子的时间轴。`;
  }
  
  /**
   * 【v2.1.4-fix9-P1】构建导演上下文
   */
  _buildDirectorContext(blueprint) {
    // 【v2.1.4-fix13-审计修复】兼容 adapted 对象和原始 blueprint 两种结构
    const config = blueprint.config || {};
    const meta = blueprint.metadata || blueprint.meta || {};
    const _metadata = config._metadata || blueprint._metadata || {};
    const title = meta.title || config.title || _metadata.title || '未命名';
    
    // 从多路径读取导演上下文信息
    const contentTheme = config.content_theme || _metadata.content_theme || '';
    const contentSummary = config.content_summary || _metadata.content_summary || '';
    const visualStyle = config.visual_style || _metadata.visual_style || 'REAL';
    const sceneRequirement = config.scene_requirement || _metadata.scene_requirement || '';
    const characterDescription = config.character_description || _metadata.character_description || '';
    const forbiddenScenes = config.forbidden_scenes || _metadata.forbidden_scenes || [];
    const keyMessages = config.key_messages || _metadata.key_messages || [];
    const creativeIntensity = config.creativeIntensity || _metadata.creativeIntensity || blueprint.config?.creativeIntensity || 0.5;
    
    // 【方案A-fix】原始故事文本直通：从 blueprint metadata 获取
    const originalStory = blueprint._originalStoryText || _metadata._originalStoryText || meta._originalStoryText || '';
    const storySection = originalStory ? `
## 📖 原始故事文本（镜头设计的核心依据，必须忠实还原）
${originalStory}
` : '';
    
    // 【v2.4.0-B3】全片导演风格注入：场景设计与技能路由共享同一位导演
    const filmDirectorLine = blueprint.filmDirector
      ? `\n全片导演风格：${blueprint.filmDirector}（一部片一位导演，场景光线与运镜质感向其靠齐）`
      : '';

    return `## 🎬 导演指令上下文
视频标题：${title}
内容主题：${contentTheme}
核心内容：${contentSummary}
视觉风格：${visualStyle}
创意指数：${creativeIntensity}（低创意=强制写实）
场景要求：${sceneRequirement}
角色设定：${characterDescription}
关键信息：${keyMessages.join('；') || '无'}
禁止场景：${forbiddenScenes.join('、') || '无'}
禁止元素：全息投影、虚拟空间、未来感、霓虹特效、元宇宙、数字空间、抽象几何${filmDirectorLine}
${storySection}`;
  }

  _fallback(shots) {
    console.log(`[SceneDesignAgent] 使用降级规则...`);
    return {
      shots: shots.map(shot => ({
        ...shot, // 【P1-5 修复】保留上游全部字段
        shotId: shot.shotId,
        scene: shot.scene || '',
        mood: shot.mood || '',
        action: shot.action || '',
        // ⭐ v2.1.7: 新增化妆/道具兜底
        makeup: shot.makeup || '',
        props: shot.props || '',
        emotional_target: shot.emotional_target || ''
      }))
    };
  }
}

module.exports = { SceneDesignAgent };