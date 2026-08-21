/**
 * LLM Enforcement Layer v1.0
 * 关键链路LLM强制驱动机制
 * 
 * 设计原则：
 * 1. LLM优先：核心环节必须先走LLM
 * 2. 关键链路无兜底：关键链路LLM失败不重试到规则，而是重试LLM直到成功或明确失败
 * 3. 失败即报告：LLM走不通时，报告失败原因，不静默降级
 * 4. 质量>速度：不为了省token或提速而跳过LLM
 */

const SpeechRate = require('../hyperreality-system/config/speech-rate');

const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = [1000, 3000, 10000]; // 指数退避

const LLM_REQUIRED_STAGES = [
  'STAGE-1',   // PRD生成：LLM分析需求，生成完整PRD
  'STAGE-2',   // 对齐检查：LLM检查需求完整性、冲突
  'STAGE-5A',  // 剧本：已有LLM
  'STAGE-5B',  // 视觉：已有LLM
  'STAGE-6',   // 时长分配：LLM根据内容复杂度智能分配
  'STAGE-7',   // 故事板：LLM生成视觉化故事板
  'STAGE-9',   // 运镜：LLM设计运镜方案
  'STAGE-11',  // 渲染：LLM优化最终Prompt
];

const LLM_OPTIONAL_STAGES = [
  'STAGE-5.5', // FPV决策：可选LLM增强
  'STAGE-10',  // 连续性：规则为主，LLM可选
  'STAGE-12',  // 合规：规则为主
  'STAGE-14',  // 风格注入：规则
  'STAGE-15',  // 后期：规则
];

class LLMEnforcementLayer {
  constructor(logger) {
    this.log = logger || console.log;
    this.stats = {
      totalCalls: 0,
      llmCalls: 0,
      fallbackCalls: 0,
      failures: 0,
      retries: 0
    };
  }

  /**
   * 核心方法：强制LLM调用
   * @param {string} stageId - Stage标识
   * @param {Function} llmPromptFn - 返回LLM prompt的函数
   * @param {Function} fallbackFn - 降级函数（仅在非关键链路使用）
   * @param {Object} options - 配置选项
   * @returns {Object} { result, driver: 'llm'|'rule', attempts, success }
   */
  async enforceLLM(stageId, llmPromptFn, fallbackFn, options = {}) {
    const isRequired = LLM_REQUIRED_STAGES.includes(stageId);
    const maxRetries = options.maxRetries || MAX_RETRIES;
    const llmEngine = options.llmEngine || this._createDefaultLLMEngine();
    
    this.stats.totalCalls++;
    this.log(`[LLM-ENFORCE] ${stageId} 开始 | 关键链路: ${isRequired ? '是' : '否'}`);

    // 尝试LLM调用
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const prompt = llmPromptFn();
        
        // v6.5.64-P2-fix: 支持结构化JSON输出（强制模型在content中输出JSON）
        if (options.structured && options.schema) {
          const result = await llmEngine.reasonStructured(prompt, options.schema, options.llmOptions || {});
          
          if (result.success) {
            this.stats.llmCalls++;
            this.log(`[LLM-ENFORCE] ${stageId} ✅ LLM结构化成功 | attempt=${attempt}/${maxRetries}`);
            return {
              result: result.data,  // 直接返回解析好的JSON对象
              rawContent: result.rawContent,
              reasoning_content: result.reasoning_content,
              driver: 'llm',
              attempts: attempt,
              success: true,
              error: null
            };
          } else {
            throw new Error(`结构化输出失败: ${result.error}`);
          }
        }
        
        const result = await llmEngine.generate(prompt, options.llmOptions || {});
        
        this.stats.llmCalls++;
        this.log(`[LLM-ENFORCE] ${stageId} ✅ LLM成功 | attempt=${attempt}/${maxRetries}`);
        
        return {
          result,
          driver: 'llm',
          attempts: attempt,
          success: true,
          error: null
        };
      } catch (err) {
        this.stats.retries++;
        this.log(`[LLM-ENFORCE] ${stageId} ⚠️ LLM失败 | attempt=${attempt}/${maxRetries}: ${err.message}`);
        
        if (attempt < maxRetries) {
          const backoff = RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)];
          this.log(`[LLM-ENFORCE] ${stageId} ⏳ 等待${backoff}ms后重试...`);
          await this._sleep(backoff);
        }
      }
    }

    // 关键链路：LLM失败不允许降级，直接抛错
    if (isRequired) {
      this.stats.failures++;
      const error = new Error(
        `[LLM-ENFORCE] ${stageId} 关键链路LLM调用失败(${maxRetries}次重试)` +
        `。不允许降级到规则。请检查LLM服务状态或调整Prompt。`
      );
      error.stageId = stageId;
      error.attempts = maxRetries;
      error.driver = 'none';
      throw error;
    }

    // 非关键链路：降级到规则
    this.log(`[LLM-ENFORCE] ${stageId} ⚠️ 降级到规则执行`);
    this.stats.fallbackCalls++;
    
    try {
      const result = await fallbackFn();
      return {
        result,
        driver: 'rule',
        attempts: maxRetries,
        success: true,
        error: null
      };
    } catch (fallbackErr) {
      this.stats.failures++;
      throw new Error(
        `[LLM-ENFORCE] ${stageId} LLM失败且规则降级也失败: ${fallbackErr.message}`
      );
    }
  }

  /**
   * 快速调用：不带fallback，失败直接抛错
   */
  async requireLLM(stageId, llmPromptFn, options = {}) {
    return this.enforceLLM(stageId, llmPromptFn, () => {
      throw new Error(`${stageId} 关键链路不允许规则降级`);
    }, options);
  }

  /**
   * 获取统计报告
   */
  getStats() {
    return {
      ...this.stats,
      llmRate: this.stats.totalCalls > 0 ? (this.stats.llmCalls / this.stats.totalCalls * 100).toFixed(1) + '%' : '0%',
      fallbackRate: this.stats.totalCalls > 0 ? (this.stats.fallbackCalls / this.stats.totalCalls * 100).toFixed(1) + '%' : '0%',
      failureRate: this.stats.totalCalls > 0 ? (this.stats.failures / this.stats.totalCalls * 100).toFixed(1) + '%' : '0%'
    };
  }

  _createDefaultLLMEngine() {
    const { LLMEngine } = require('./llm-reasoning-engine');
    return new LLMEngine({
      model: 'kimi-k2p6',
      mode: 'production',
      maxRetries: 1, // 外层已处理重试
      maxTokens: 4096,
      temperature: 1,
      topP: 0.95
    });
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// 各Stage的LLM Prompt模板
const StagePrompts = {
  /**
   * STAGE-1: LLM-PRD生成 (统一数据结构版)
   * 输出统一视频需求结构，兼容用户需求解析、PRD、Schema校验三层
   */
  STAGE_1_PRD: (input) => {
    // 提取创意指数（从 input 或创意参数）
    const cp = input.creativityIndex || input.creativity || input.creativityParameter || 0.2;
    
    return `你是一位专业的视频制作PRD策划Agent。
请分析以下用户需求，生成完整的视频需求文档（PRD）。

## 统一输出规范
你必须输出符合以下结构的 JSON，所有字段严格使用指定名称：

{
  // 一、视频任务基本信息
  "title": "视频标题/主题",
  "topic": "核心话题/主题描述",
  "videoType": "视频类型编码(EDU/SOC/ADV/DOC/DRAMA/COR/EVT/VLOG/MV)",
  "targetAudience": "目标受众",
  "platform": "投放平台",
  
  // 二、制作规格
  "targetDuration": 目标时长秒数,
  "aspectRatio": "画幅比例(9:16/16:9/1:1/3:4)",
  "visualStyle": "画面风格组合(如REAL+WARM)",
  "qualityLevel": "画质等级(标准/电影/艺术/极致)",
  "colorTone": "色彩基调",
  
  // 三、内容创意要求
  "creativityIndex": 创意指数0.0-1.0,
  "narrativeStyle": "叙事方式/讲解形式",
  "contentStyle": "内容风格",
  "visualStyleDetail": "视觉风格详细描述",
  "musicStyle": "音乐/音效风格",
  
  // 四、角色信息
  "characters": {
    "角色ID": {
      "id": "角色ID",
      "name": "角色名",
      "age": "年龄",
      "gender": "性别",
      "role": "角色定位",
      "appearance": "外观描述",
      "personality": "性格特征",
      "visualAnchors": "视觉锚点"
    }
  },
  
  // 五、场景定义
  "scenes": [
    {
      "id": "S01",
      "name": "场景名称",
      "type": "场景类型(intro/content/ending)",
      "description": "场景描述",
      "characters": ["角色ID"],
      "duration": 场景时长秒数,
      "visualComplexity": 1-10,
      "importance": 1-10,
      "narration": "旁白/台词文本",
      "dialogue": "对白文本"
    }
  ],
  
  // 六、结构与分镜
  "opening": {
    "hasOpening": true/false,
    "title": "片头标题",
    "subtitle": "片头副标题",
    "duration": 片头时长秒数
  },
  "ending": {
    "hasEnding": true/false,
    "previewNext": false,
    "content": "结尾内容"
  },
  "keyPoints": ["核心要点1", "核心要点2"],
  
  // 七、系列规划
  "isSeries": true/false,
  "totalEpisodes": 总集数,
  "currentEpisode": 当前集数,
  "episodeThemes": ["第一集主题", "第二集主题"],
  "contentIsolation": "跨集内容隔离要求",
  
  // 八、世界观
  "world": {
    "name": "世界名称",
    "setting": "场景设定",
    "location": "地点",
    "lighting": "光线环境",
    "atmosphere": "氛围",
    "style": "风格"
  },
  
  // 九、风格与约束
  "style": {
    "visualStyle": "视觉风格",
    "colorPalette": "色彩方案",
    "pacing": "节奏",
    "mood": "情绪",
    "reference": "参考作品"
  },
  "constraints": {
    "technical": ["技术约束1"],
    "content": ["内容约束1"],
    "legal": ["法律约束1"]
  },
  
  // 十、元数据
  "meta": {
    "version": "v1.0",
    "mode": "模式",
    "createdAt": "创建时间ISO格式",
    "aiReasoning": "AI决策说明"
  }
}

## 用户输入
- 项目名称：${input.projectName || '未指定'}
- 项目类型：${input.projectType || '未指定'}
- 目标时长：${input.targetDuration || '未指定'}秒
- 场景列表（必须严格遵循，不可修改）：
${(input.scenes || []).map(s => `  ${s.id}: ${s.name} | 类型:${s.type} | 时长:${s.duration}s | 描述:${s.description}`).join('\n')}
- 角色：${Object.keys(input.characters || {}).join(', ')}
- 风格：${input.style || '未指定'}
- 世界观：${input.world?.setting || '未指定'}
- 核心内容：${input.core?.narrative?.focus || input.core?.theme || '未指定'}
- 创意指数：${cp}

## 关键要求
1. 必须包含所有顶层字段（title, topic, keyPoints, targetDuration, scenes, characters, world, style, constraints, meta）
2. title 和 topic 必须有实际内容，不能为空字符串
3. keyPoints 必须是字符串数组，至少包含1个核心要点
4. targetDuration 必须是数字，与用户需求一致
5. scenes 必须是数组，每个场景必须有 id, name, type, description
6. 如果用户提供创意指数，必须在 creativityIndex 字段中使用该值
7. 如果用户提到系列内容，必须填充 isSeries, totalEpisodes, currentEpisode 等字段
8. 【场景约束】⚠️ 必须严格遵循上述场景定义，场景名称、类型、描述和时长不可修改。场景描述是最终设定，不可偏离。

## 输出要求
只输出JSON，不要任何解释或markdown标记。确保JSON格式完全合法。`;
  },

  /**
   * STAGE-2: LLM-需求对齐
   */
  STAGE_2_ALIGNMENT: (input, prd) => {
    return `你是一位专业的视频制作需求对齐Agent。
请检查以下PRD的完整性和一致性，识别潜在问题。

## PRD内容
${JSON.stringify(prd, null, 2)}

## 原始输入
- 目标时长：${input.targetDuration || '未指定'}秒
- 场景数：${(input.scenes || []).length}
- 角色数：${Object.keys(input.characters || {}).length}

## 检查项
1. 字段完整性：PRD是否包含所有必需字段（meta, core, world, characters, scenes, style, constraints）
2. 时长合理性：总场景时长是否与目标时长匹配（±20%容差）
3. 角色-场景关联：每个场景是否有角色？角色是否在characters中定义？
4. 风格一致性：world.style、core.emotionalArc、scenes[].type是否风格一致？
5. 逻辑冲突：是否有矛盾的需求（如同时要求快节奏和慢镜头）
6. 可行性：技术约束是否可实现？

## 输出格式
{
  "passed": true/false,
  "score": 0-100,
  "checks": {
    "fieldCompleteness": { "passed": true, "score": 95, "issues": [] },
    "durationReasonableness": { "passed": true, "score": 90, "issues": [] },
    "characterSceneAssociation": { "passed": true, "score": 100, "issues": [] },
    "styleConsistency": { "passed": true, "score": 85, "issues": [] },
    "logicalConflict": { "passed": true, "score": 100, "issues": [] },
    "feasibility": { "passed": true, "score": 95, "issues": [] }
  },
  "criticalIssues": [],
  "warnings": [],
  "suggestions": []
}

只输出JSON，不要解释。`;
  },

  /**
   * STAGE-6: LLM-时长分配
   */
  STAGE_6_DURATION: (scenes, totalDuration) => {
    const sceneDesc = scenes.map((s, i) => 
      `${i+1}. ${s.id}: ${s.type} | 台词字数:${(s.dialogue || '').length} | 重要性:${s.importance || 5} | 视觉复杂度:${s.visualComplexity || 5} | 内容:"${(s.dialogue || '').substring(0, 50)}..."`
    ).join('\n');
    
    return `你是一位专业的视频时长分配Agent。
请根据场景内容复杂度、台词字数、视觉复杂度，智能分配每个场景的时长。

## 总时长预算
${totalDuration}秒

## 场景列表
${sceneDesc}

## 分配原则
1. 内容密度：台词字数多的场景需要更多时间（按${SpeechRate.NORMAL}字/秒计算基线，含停顿）
2. 重要性：importance高的场景应获得更多时间
3. 视觉复杂度：visualComplexity高的场景需要更多时间展示
4. 节奏变化：开头和结尾可以稍短，中间核心内容应充分展开
5. 最小时长：每场景至少3秒
6. 最大时长：单场景不超过15秒（超短视频）

## 输出格式
{
  "allocations": [
    { "sceneId": "S01", "duration": 8, "reason": "开场，简短引入" },
    { "sceneId": "S02", "duration": 12, "reason": "核心内容，台词56字，需要充分展开" }
  ],
  "totalAllocated": 58,
  "optimizationLevel": "L0",
  "strategy": "根据内容密度和重要性分配，核心场景给予充足时间"
}

只输出JSON，不要解释。`;
  },

  /**
   * STAGE-7: LLM-故事板生成
   */
  /**
   * STAGE-7: LLM-故事板生成（v6.7.0-patch: 输出完整25字段）
   */
  STAGE_7_STORYBOARD: (scenes, world, characters) => {
    const sceneDesc = scenes.map((s, i) =>
      `${i+1}. ${s.id}: ${s.type} | ${s.duration}s | 台词:"${(s.dialogue || '').substring(0, 60)}..." | 角色:${(s.characters || []).join(',')}`
    ).join('\n');

    const charDesc = Object.entries(characters || {}).map(([id, c]) =>
      `- ${id}: ${c.name || id}, ${c.baseIdentity?.gender || '未知'}, ${c.baseIdentity?.age || '未知'}岁, ${c.baseIdentity?.role || '未知'}, 外观:${c.visualIdentity?.distinguishingMarks || '未描述'}`
    ).join('\n');

    return `你是一位专业的视频故事板设计Agent。
请为每个场景设计详细的视觉化故事板，必须输出完整的 25 字段规格内容（v6.7.0 标准）。

## 世界观
${world?.setting || '未指定'} | ${world?.atmosphere || '未指定'} | ${world?.lighting || '未指定'}

## 角色
${charDesc}

## 场景列表
${sceneDesc}

## 25字段规格（必须严格遵守字符区间，内容要专业、具体、可执行）

| 优先级 | 字段(JSON key) | 中文名 | 字符区间 | 必填 |
|--------|----------------|--------|----------|------|
| P0 | director_instruction | 导演指令 | 50-80 | 是 |
| P0 | constraint | 约束 | 100-150 | 是 |
| P0 | baseline | 基础 | 80-100 | 是 |
| P0 | scene | 场景 | 150-200 | 是 |
| P0 | lighting | 灯光 | 100-150 | 是 |
| P0 | camera_movement | 运镜 | 80-120 | 是 |
| P0 | character | 角色 | 50-80 | 是 |
| P0 | action | 动作 | 100-150 | 是 |
| P0 | dialogue | 台词 | 0-9999 | 是 |
| P0 | negative | 负面约束 | 200-300 | 是 |
| P0 | portraits | 定妆照 | 0-9999 | 是(可空) |
| P0 | consistency | 角色一致性 | 50-80 | 是 |
| P1 | composition | 构图 | 80-120 | 是 |
| P1 | color_palette | 色彩 | 80-120 | 是 |
| P1 | depth_of_field | 景深 | 60-100 | 是 |
| P1 | timeline | 时间轴 | 150-200 | 是 |
| P1 | mood | 情绪 | 30-50 | 是 |
| P1 | bright_constraint | 明亮约束 | 50-80 | 是 |
| P1 | character_constraint | 角色约束 | 50-80 | 是 |
| P2 | costume | 服装 | 60-100 | 否 |
| P2 | props | 道具 | 40-80 | 否 |
| P2 | pacing | 节奏 | 60-100 | 否 |
| P2 | audio | 音频 | 60-100 | 否 |
| P3 | makeup | 化妆 | 40-60 | 否 |
| P3 | transition | 转场 | 30-50 | 否 |

## 各字段内容要求
- director_instruction：风格定位+写实要求+情绪基调+技术方向（如"超写实纪录片质感，无特效无科幻，冷静专业的科普基调，8K影视级渲染"）
- constraint：必须含画幅比例+分辨率+输出格式+帧率（如"Aspect ratio 16:9, Resolution 1920x1080, Format MP4, Frame rate 30fps, 横屏教育片规格"）
- baseline：画质锚定词（如"8K, cinematic, photorealistic, highly detailed, sharp focus, professional color grading"）
- scene：室内/室外空间类型+具体环境+五维空间布局（前景/中景/背景/材质/标识），150字符以上
- lighting：主光+辅光+色温+光质+光位（如"key light from front-right 45°, fill light left side, 5500K daylight, soft diffusion, 2:1 light ratio"）
- camera_movement：运动方式+速度+时间分布（如"dolly in, slow, 0-3s stationary then 3-8s push from 3m to 1.5m"）
- character：角色身份+外观+服装概要，50字符以上
- action：纯动作指令，动态丰富（不要只写"站立"），100字符以上
- dialogue：该镜头台词（无配音则填空字符串），句末须有。！？…
- negative：基础排除+场景专属排除，200字符以上，必须含 no text, no watermark
- portraits：定妆照引用，无角色则填空字符串
- consistency：角色一致性锚定（如"画面中仅出现主讲人一人，禁止分身、克隆、重复角色"）
- composition：景别等级+主体位置（如"medium shot, subject centered-left, rule of thirds"）
- color_palette：主色+辅色+饱和度+对比度
- depth_of_field：焦点位置+虚化程度（如"shallow depth of field, focus on face, background bokeh"）
- timeline：至少3段时间锚点（如"T00:00-T00:03 establishing, T00:03-T00:06 dialogue, T00:06-T00:08 closing"）
- mood：情绪+色调+色温（如"calm professional, warm neutral tone, 5500K"）
- bright_constraint：亮度+可见性+面部明亮（如"bright well-lit, clear visibility, no dark shadows on face"）
- character_constraint：单角色限制+禁止分身
- costume/props/pacing/audio/makeup/transition：按字段语义专业描述

## 输出格式（严格JSON，每个shot必须包含全部25个key）
{
  "shots": [
    {
      "id": "S01",
      "director_instruction": "...",
      "constraint": "...",
      "baseline": "...",
      "scene": "...",
      "lighting": "...",
      "camera_movement": "...",
      "character": "...",
      "action": "...",
      "dialogue": "...",
      "negative": "...",
      "portraits": "",
      "consistency": "...",
      "composition": "...",
      "color_palette": "...",
      "depth_of_field": "...",
      "timeline": "...",
      "mood": "...",
      "bright_constraint": "...",
      "character_constraint": "...",
      "costume": "...",
      "props": "...",
      "pacing": "...",
      "audio": "...",
      "makeup": "...",
      "transition": "..."
    }
  ],
  "styleNotes": "整体风格说明"
}

## 强制要求
1. 每个 shot 必须包含全部 25 个 key，缺失字段填空字符串""，但 P0/P1 必填字段必须有达标内容
2. 字段内容必须具体、专业、可执行，禁止用"自然""正常""一般"等模糊词
3. 各 shot 字段内容必须差异化，不能互相复制
4. scene/lighting/composition 等画面字段优先使用英文专业术语
5. 只输出JSON，不要任何解释或markdown标记`;
  },

  /**
   * STAGE-9: LLM-运镜设计
   * v6.5.64-P1-fix: 修复durations类型问题，支持数组和对象两种传入方式
   */
  STAGE_9_CAMERA: (scenes, durations) => {
    // v6.5.64-P1-fix: 兼容durations为数组、对象或字符串的情况
    const durationList = Array.isArray(durations) ? durations :
                         (durations && durations.allocations && Array.isArray(durations.allocations)) ? durations.allocations :
                         (typeof durations === 'string') ? [] :  // 防止传入mode字符串
                         [];
    
    const sceneDesc = scenes.map((s, i) => {
      const dur = durationList.find(d => d.sceneId === s.id);
      return `${i+1}. ${s.id}: ${s.type} | ${dur?.duration || s.duration}s | 情绪:${s.emotionPhase || 'neutral'} | 动作:${s.cameraMovement?.type || '未指定'}`;
    }).join('\n');
    
    return `你是一位专业的电影摄影指导（DP）。
请为每个场景设计具体的运镜方案，与角色动作和情绪配合。

## 场景列表
${sceneDesc}

## 设计原则
1. 情绪匹配：紧张场景用快节奏运镜（快速推拉、晃动），平静场景用慢速稳定运镜
2. 角色配合：运镜要跟随或衬托角色动作，不要脱离角色单独运动
3. 叙事节奏：开场稳定，发展期开始运动，高潮最激烈，结尾回落
4. 镜头多样性：避免所有镜头都是固定或都是推镜头，要有变化
5. 技术可实现：运镜描述要具体可执行（速度、方向、幅度）

## 运镜类型参考
- 推(dolly in)：强调、聚焦、揭示
- 拉(dolly out)：展开、交代环境、抽离
- 摇(pan)：跟随、展示、连接
- 移(truck)：平行跟随、展示空间
- 跟(follow)：跟随移动的主体
- 升(crane up)：升华、抽离、俯瞰
- 降(crane down)：深入、聚焦、压迫
- 环绕(orbit)：展示、环绕主体
- 手持(handheld)：紧张、真实、纪录片感
- 固定(lock-off)：稳定、权威、冷静

## 输出格式
{
  "cameraDesigns": [
    {
      "sceneId": "S01",
      "primaryMovement": "dolly_in",
      "speed": "slow",
      "reasoning": "开场从全景缓慢推近到人物，建立亲近感",
      "secondaryMovement": "slight_pan",
      "technical": "50mm镜头，f/2.8，从3m推近到1.5m，匀速"
    }
  ],
  "overallArc": "稳定→动态→高潮→回落"
}

只输出JSON，不要解释。`;
  },

  /**
   * STAGE-11: LLM-渲染Prompt优化
   * v6.7.0-fix: 强制按25字段标准规范输出，消除新旧格式混用
   */
  STAGE_11_RENDER: (shots, stages, mode) => {
    // 统一处理：支持单shot或多shots数组
    const shotArray = Array.isArray(shots) ? shots : [shots];
    const characters = stages?.characters || {};
    
    // 构建每个shot的详细信息
    const shotDetails = shotArray.map((shot, index) => {
      const charId = (shot.characters || [])[0];
      const char = characters?.[charId];
      
      return `
## 镜头 ${index + 1}: ${shot.id}
- 类型：${shot.type || '未指定'}
- 时长：${shot.duration}s
- 场景：${shot.scene || '未指定'}
- 台词：${(shot.dialogue || '').substring(0, 100)}
- 角色：${charId} (${char?.name || '未命名'})
- 角色动作：${shot.action || '未指定'}
- 运镜设计：${shot.cameraMovement?.description || shot.cameraMovement?.type || '未指定'}
- 景别：${shot.camera?.shotSize || shot.shotSize || '未指定'}
`;
    }).join('\n');
    
    return `你是一位专业的视频渲染Prompt优化Agent。
请为以下每个镜头生成独立的、差异化的渲染Prompt。

## 核心要求（不可违反）
1. 必须严格使用25字段标准格式（见下方字段列表）
2. 每个字段以【字段名】开头，以 | 或下一个【字段名】结尾
3. 禁止混用旧格式（如【视觉】【空间】【纵深】【方位】【氛围】【时间】【光影】【渲染】【导演】等）
4. 每个镜头的场景描述必须独特，不能与其他镜头重复
5. 教育片场景应使用中文描述，避免英文通用模板
6. 角色动作必须动态丰富
7. 总字符数控制在2500以内

## 25字段标准规范（必须全部包含）
P0-致命级（12个，不可缺失）：
【导演指令】风格定位+写实要求+情绪基调+技术方向
【约束】Aspect ratio 16:9, Resolution 1920x1080, Format MP4, Frame rate 24fps
【基础】8K, cinematic, photorealistic, highly detailed, sharp focus
【场景】空间类型+环境特征+时代背景（中文，差异化）
【灯光】主光/补光/氛围光/色温/光比（五要素）
【运镜】运动方式+景别+镜头参数
【角色】身份+姿态+表情（三维度）
【动作】具体动作指令（边走边说、手势等）
【对话指令】说话者+情绪+台词文本（如有配音，供Seedance对口型参考）
【负面约束】no text, no watermark, no blurry, no extra limbs...
【定妆照】@image1 @image2...（如有定妆照）
【角色一致性】画面中仅出现目标角色一人，禁止分身

P1-核心级（7个）：
【构图】景别+主体位置+线条引导
【色彩】主色调+辅助色+饱和度+对比度
【景深】焦点位置+虚化程度+清晰范围
【时间轴】T00:00-T00:XX / 时长:Xs
【情绪】情绪基调+色温关联
【明亮约束】bright well-lit, clear visibility, no dark shadows
【角色约束】禁止重复角色入镜，禁止角色分身

P2-增强级（4个）：
【服装】外套上装+内搭+下装+鞋履配饰
【道具】具体道具列表
【节奏】整体节奏+开头+中段+高潮+结尾
【音频】环境音效+音乐+人声处理

P3-可选级（2个）：
【化妆】面部妆容+发型+整体造型
【转场】转场方式

## 镜头列表
${shotDetails}

## 输出格式
只输出JSON，不要解释：
{
  "prompts": [
    {
      "shotId": "S01",
      "prompt": "【导演指令】... | 【约束】... | 【基础】... | 【场景】... | 【灯光】... | 【运镜】... | 【角色】... | 【动作】... | 【对话指令】... | 【负面约束】... | 【定妆照】... | 【角色一致性】... | 【构图】... | 【色彩】... | 【景深】... | 【时间轴】... | 【情绪】... | 【明亮约束】... | 【角色约束】... | 【服装】... | 【道具】... | 【节奏】... | 【音频】... | 【化妆】... | 【转场】..."
    }
  ]
}`;
  }
};

module.exports = { LLMEnforcementLayer, StagePrompts, LLM_REQUIRED_STAGES };
