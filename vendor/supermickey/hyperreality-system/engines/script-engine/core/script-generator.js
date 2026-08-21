// engines/script-engine/core/script-generator.js
// Script Generator - 调用 LLM 生成结构化剧本
// 版本：v1.0 | 日期：2026-06-07

const fs = require('fs');
const path = require('path');
const { ScriptBlueprint } = require('./script-blueprint');
const { buildBoundaryPrompt, extractSeriesPlan, extractPreviousSummary } = require('./boundary-prompt-templates');
// 【v2.1.22-fix 片头字段丢失】场景类型归一化（确定性修正 LLM 的非标准 scene_type）
const { normalizeSceneTypes, buildSceneTypeConstraintText } = require('./scene-type-normalizer');

// 复用现有LLM引擎
const LLM_ENGINE_PATH = path.join(__dirname, '../../../../systems/llm-reasoning-engine.js');
let LLMEngine;
try {
  ({ LLMEngine } = require(LLM_ENGINE_PATH));
} catch (e) {
  console.warn('[ScriptGenerator] 无法加载LLMEngine:', e.message);
}

// 【P0-DATA-02 修复】自定义错误类，支持结构化错误信息
class ScriptGenerationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ScriptGenerationError';
    this.code = code;
    this.details = details;
    this.timestamp = new Date().toISOString();
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
      timestamp: this.timestamp,
      stack: this.stack
    };
  }
}

class ScriptGenerator {
  constructor(options = {}) {
    const model = options.model || process.env.STORMAXE_LLM_MODEL || null;
    if (!model) {
      console.warn('[ScriptGenerator] ⚠️ 未配置模型名，请设置 SUPERMICKEY_LLM_MODEL（兼容旧名 STORMAXE_LLM_MODEL）或传入 options.model');
    }
    this.config = {
      llmEndpoint: options.llmEndpoint || process.env.LLM_ENDPOINT || 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
      apiKey: options.apiKey || process.env.VOLCENGINE_ARK_API_KEY,
      // 【v2.1.4-fix13-审计修复】从环境变量读取，消除硬编码
      model: model,
      maxTokens: options.maxTokens || 32000, // 【v2.1.8-fix14】maxTokens提升到32000，覆盖reasoning+content
      temperature: options.temperature || 1,
      promptTemplateDir: options.promptTemplateDir || path.join(__dirname, '../prompts'),
      templateDir: options.templateDir || path.join(__dirname, '../templates'),
      timeout: options.timeout || 300000,
      maxRetries: options.maxRetries || 3,
      ...options
    };
    
    // 初始化LLM引擎（优先使用现有引擎）
    this.llmEngine = null;
    if (LLMEngine) {
      this.llmEngine = new LLMEngine({
        // 【v2.1.4-fix13-审计修复】使用统一变量，不再写死
        model: model,
        maxTokens: this.config.maxTokens,
        timeoutMs: this.config.timeout,
        maxRetries: this.config.maxRetries
      });
      console.log(`[ScriptGenerator] 使用LLMEngine (${model})`);
    }
  }

  /**
   * 主入口：生成剧本
   * @param {object} userIntent - 用户意图对象
   * @param {object} templateData - 模板数据（可选）
   * @returns {ScriptBlueprint} 生成的剧本蓝图
   */
  async generate(userIntent, templateData = null) {
    console.log(`[ScriptGenerator] 开始生成剧本: ${userIntent.metadata?.title}`);

    const maxAttempts = 3;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // 1. 加载模板
        const template = templateData || await this._loadTemplate(userIntent);

        // 2. 构建 LLM Prompt
        const prompt = this._buildGenerationPrompt(userIntent, template);

        // 3. 调用 LLM
        const llmResponse = await this._callLLM(prompt);

        // 4. 解析并构建 Blueprint
        const blueprint = this._parseLLMResponse(llmResponse, userIntent);

        // 5. 验证scenes存在且非空
        if (!blueprint.structure?.scenes || !Array.isArray(blueprint.structure.scenes) || blueprint.structure.scenes.length === 0) {
          throw new ScriptGenerationError('JSON_NO_SCENES', 'LLM输出JSON中structure.scenes为空或缺失');
        }

        // 5.5 【v2.1.22-fix 片头字段丢失】场景类型归一化：
        // 把 LLM 输出的非标准 scene_type（hook/setup/rising_action 等英雄之旅词汇）
        // 确定性映射到标准五型，并强制 scenes[0] = opening，
        // 防止下游 phase-1 片头注入与最终导出片头查找静默跳过。
        normalizeSceneTypes(blueprint.structure.scenes, {
          logger: (msg) => console.log(`[ScriptGenerator] ${msg}`)
        });

        console.log(`[ScriptGenerator] 剧本生成完成: ${blueprint.blueprint_id}, ${blueprint.structure.scenes.length} 场景`);
        return blueprint;

      } catch (error) {
        lastError = error;
        console.error(`[ScriptGenerator] 第${attempt}/${maxAttempts}次生成失败:`, error.message);

        if (attempt < maxAttempts) {
          // 等待后重试
          const delay = attempt * 2000;
          console.log(`[ScriptGenerator] ${delay}ms后重试...`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }

    // 所有重试都失败，抛出错误
    throw new ScriptGenerationError(
      'GENERATE_FAILED',
      `剧本生成失败，已重试${maxAttempts}次: ${lastError?.message}`,
      { lastError: lastError?.toJSON?.() || lastError?.message }
    );
  }

  /**
   * 加载模板
   */
  async _loadTemplate(userIntent) {
    const mode = userIntent.parsed?.primary_mode || 'dramatic';
    const templatePath = path.join(this.config.templateDir, `${mode}-template.json`);

    try {
      const templateContent = fs.readFileSync(templatePath, 'utf-8');
      return JSON.parse(templateContent);
    } catch (err) {
      console.warn(`[ScriptGenerator] 模板加载失败: ${templatePath}, 使用默认模板`);
      return this._getDefaultTemplate();
    }
  }

  /**
   * 获取默认模板
   */
  _getDefaultTemplate() {
    return {
      structure: {
        acts: [
          { act_id: 'ACT-1', act_name: '第一幕', act_function: 'establish', beats: [] },
          { act_id: 'ACT-2', act_name: '第二幕', act_function: 'confront', beats: [] },
          { act_id: 'ACT-3', act_name: '第三幕', act_function: 'resolve', beats: [] }
        ]
      },
      default_scene_count: 5,
      default_duration_per_scene: 20
    };
  }

  /**
   * 【v2.1.10-fix 台词真空】本片旁白策略解析（生成侧）
   * PRD voicePolicy / 主题 dialogue_requirement / 叙事模式任一命中"旁白/画外音"即允许旁白。
   * 供 _buildGenerationPrompt 动态调整系统约束，供 _normalizeScenesDialogue 归位游离旁白。
   */
  _resolveVoiceoverPolicy(userIntent) {
    const meta = userIntent?.metadata || {};
    const prd = meta._prd || meta._metadata?._prd || null;
    const voicePolicy = prd?.audioSpecification?.voicePolicy || '';
    const dialogueReq = meta._creativeTheme?.dialogue_requirement
      || meta.dialogue_requirement
      || meta.dialogueRequirement
      || '';
    const narrativeMode = meta.narrative_mode || meta.narrativeMode || '';

    const allowed = /旁白|画外音/.test(voicePolicy)
      || /旁白|画外音|narration|voiceover/i.test(dialogueReq)
      || String(narrativeMode).toLowerCase() === 'narration';

    return {
      allowed,
      voicePolicy,
      dialogueRequirement: dialogueReq,
      narrativeMode
    };
  }

  /**
   * 构建 LLM 生成 Prompt
   */
  _buildGenerationPrompt(userIntent, template) {
    const meta = userIntent.metadata;
    const constraints = userIntent.constraints;
    const parsed = userIntent.parsed;

    // 【v2.1.10-fix 台词真空】本片旁白策略（驱动下方系统约束的措辞）
    const voiceoverPolicy = this._resolveVoiceoverPolicy(userIntent);
    const voiceoverAllowed = voiceoverPolicy.allowed;

    const prompt = `你是一位顶级短视频编剧，专门为AI视频生成系统创作结构化剧本。

## 任务
为以下项目创作完整的结构化剧本，输出必须是严格的 JSON 格式。

## 项目信息
- 标题：${meta.title}
- 叙事类型：${parsed.primary_mode} ${parsed.hybrid_config ? '+ ' + parsed.secondary_modes.join(', ') : ''}
- 目标时长：${meta.target_duration}秒
- 世界观：${meta.world_setting || '现实世界'}
${meta.featured_beast_id ? '- 主角异兽：' + meta.featured_beast_id : ''}
- 主角：${meta.protagonist}
- 平台：${(meta.target_platform || []).join(', ') || '通用平台'}
- 语言：${meta.language || '中文'}
${(() => {
  // 【方案A-fix】原始故事文本直通：将用户完整故事原文注入剧本LLM
  const originalStory = meta._originalStoryText || meta._creativeTheme?.original_story_text || '';
  if (originalStory) {
    return `
## 📖 原始故事文本（核心依据，必须忠实还原）
${originalStory}
`;
  }
  return '';
})()}
${(() => {
  // 【审计修复】消费上游已被提取却从未进入剧本 prompt 的关键字段:
  // 主题情绪(tone)/视觉风格(visual_style)/目标受众(target_audience)/情绪画像(_emotionProfile)/PRD创意核心(_prd)
  // 此前这些字段在 script-engine/index.js 被写入 metadata 后全库无人消费, 剧本 LLM 完全看不到风格与受众要求
  const sections = [];
  const tone = meta._creativeThemeTone;
  const vs = meta._creativeThemeVisualStyle;
  const audience = meta._creativeThemeTargetAudience;
  const ep = meta._emotionProfile;
  const prdCore = meta._prd?.creativeDirection?.creativeCore || meta._prd?.creativeCore || null;
  if (tone || vs || audience) {
    sections.push('## 主题风格要求（来自已确认的创意主题，必须体现）' +
      (tone ? `\n- 情绪基调：${tone}` : '') +
      (vs ? `\n- 视觉风格：${vs}` : '') +
      (audience ? `\n- 目标受众：${audience}` : ''));
  }
  if (ep && ep.primary) {
    sections.push(`## 情绪画像\n- 主导情绪：${ep.primary}${ep.secondary ? ' + ' + ep.secondary : ''}（强度 ${(Math.round((ep.intensity || 0.5) * 100))}%）\n- 剧本的情绪节奏必须服务于该情绪目标`);
  }
  if (prdCore && (prdCore.coreTheme || prdCore.creativeHook)) {
    sections.push('## PRD 创意核心（已经用户确认，剧本必须对齐）' +
      (prdCore.coreTheme ? `\n- 核心主题：${prdCore.coreTheme}` : '') +
      (prdCore.creativeHook ? `\n- 创意钩子：${prdCore.creativeHook}` : '') +
      (prdCore.emotionalArc ? `\n- 情绪弧线：${prdCore.emotionalArc}` : '') +
      (Array.isArray(prdCore.keyMessages) && prdCore.keyMessages.length ? `\n- 关键信息：${prdCore.keyMessages.join('；')}` : ''));
  }
  return sections.length ? '\n' + sections.join('\n\n') + '\n' : '';
})()}

## 系统约束（不可违反）
${voiceoverAllowed
  ? `1. 本片允许旁白/画外音：旁白必须写进 dialogue.blocks，speaker 固定为 "旁白"，type 固定为 "narration"；角色对话的 type 用 monologue/dialogue/reaction。严禁把旁白放到 scene.narration 或 scene.voice_over 等游离字段`
  : `1. 禁止旁白（Voiceover），只保留角色对话（Dialogue）；严禁出现 speaker 为"旁白/voiceover"的台词，严禁 scene.narration / scene.voice_over 字段`}
2. 每个场景必须有台词（${voiceoverAllowed ? '角色对话或旁白均可' : '角色对话'}）
3. 台词必须口语化，适合短视频节奏（每句不超过30字）
4. 【v2.1.5-fix-C】台词必须生成 blocks 字段：每句台词需包含 speaker/line/emotion/trigger/manner/type，emotion 必须是副词（如 confidently/hesitates/gently），trigger 必须是物理动作触发（如 looks at camera/pauses then smiles）
5. 场景时长分配：根据内容重要性、台词长度、视觉复杂度三维度分配
6. 总时长必须严格等于 ${meta.target_duration} 秒（所有场景 timing.duration 之和）
7. 角色视觉锚点必须保持一致（定妆照引用）
8. 【v2.1.10-fix】dialogue 对象三要素缺一不可：has_dialogue（布尔，有台词时必须为 true）、lines（数组）、blocks（数组）
9. 【v2.1.10-fix】character_system.characters 中每个角色必须包含 character_id、name、role；有且仅有一个 role="protagonist"，其余用 "supporting"；scene.characters 只允许引用已定义的 character_id
10. 【v2.1.22-fix】${buildSceneTypeConstraintText()}

## 剧本结构模板
采用三幕式结构：
${JSON.stringify(template.structure.acts, null, 2)}

## 世界观设定
${meta.world_setting === '示例世界' ? `
- 示例世界是地球前身，一个虚构与碳基生命共存的星球
- 《古籍神话》实为示例世界往事的记录
- 核心主题：记忆即存在
- 环境特征：硅晶草原、双月当空、等离子河流、晶体森林
- 禁止暗黑风格，要求明亮多色彩强质感
` : meta.world_setting ? `
- 世界观：${meta.world_setting}
` : `
- 现实世界设定，真实场景，写实风格
- 环境特征：根据内容主题选择合适场景（办公室、演播室、户外、居家等）
- 要求明亮、专业、可信的视觉效果
`}

## 输出格式要求
你必须输出一个严格的 JSON 对象，包含以下顶级字段：
- meta: {title, narrative_mode, target_duration, acts_count, scenes_count}
- structure: {acts: [...], scenes: [...]}
- character_system: {characters: [...]}
- voice_system: {global_voice_policy, voice_profiles: [...]}
- world_setting: {world_id, world_name, era, core_rules, environment_tags}

每个场景(scenes)必须包含：scene_id, scene_name, scene_type（仅限 opening/establishing/conflict/emotional_climax/resolution 五选一，第一个场景必须是 opening）, scene_function, act_id, timing(start/duration/end), characters, setting, dialogue, visual_notes, emotional_target(valence/arousal/dominance)

dialogue 对象的标准结构（必须严格遵守）：
"dialogue": {
  "has_dialogue": true,
  "lines": [{"speaker": "角色ID", "text": "台词原文", "emotion": "情绪"}],
  "blocks": [{"speaker": "角色ID", "line": "台词原文", "emotion": "副词", "trigger": "物理动作", "manner": "说话方式", "type": "monologue"}]
}
${voiceoverAllowed ? '旁白台词写法：{"speaker": "旁白", "line": "旁白原文", "emotion": "副词", "trigger": "镜头动作", "manner": "叙述", "type": "narration"}\n' : ''}
character_system.characters 每个角色必须包含：character_id, name, role（有且仅有一个 "protagonist"）, visual_anchor: {core_features: [2-5个特征]}

## 关键要求
1. 只输出纯JSON，不要markdown代码块，不要解释文字
2. 使用最紧凑格式（减少换行和缩进）
3. 场景数量建议 5-7 个，总时长严格等于 ${meta.target_duration} 秒
4. 每个场景的台词必须包含在场景中（不能旁白）
5. 场景时长分配需严格计算，总和必须精确等于${meta.target_duration}秒
6. 角色视觉锚点必须保持一致（定妆照引用）
${meta.characters?.length > 0 ? `
## 角色信息（必须严格使用，禁止自创角色）
${meta.characters.map(c => `- ${c.name} (ID: ${c.id || c.name}): ${c.description || '主讲人'}`).join('\n')}

【角色约束 - 不可违反】
- 所有场景的角色必须是以上指定的角色，严禁自创其他角色（如"医生""患者""路人"等）
- 场景描述(setting)和视觉备注(visual_notes)中提到的角色必须与指定角色一致
- 如果只有一个角色，所有场景都必须是该角色出镜或该角色的视角
` : ''}
${(() => {
  // 【v2.1.4】跨集边界约束 - 使用新的边界契约提示词
  const seriesPlan = extractSeriesPlan(meta);
  if (!seriesPlan || seriesPlan.totalEpisodes <= 1) return '';
  
  const episodeIndex = meta.series?.currentEpisode || meta.episode || 1;
  const previousSummary = extractPreviousSummary(meta);
  
  return buildBoundaryPrompt({
    episodeIndex,
    totalEpisodes: seriesPlan.totalEpisodes,
    seriesPlan,
    previousSummary
  });
})()}

## 创意指数指导（创意指数 = ${meta._creativeIntensity?.intensity || meta.creativeIntensity || '未设置'}）
${meta._creativeIntensity?.instructions?.script ? meta._creativeIntensity.instructions.script : ''}
${meta._creativeIntensity?.instructions?.production ? `
## 视觉表现指导
${meta._creativeIntensity.instructions.production}` : ''}
${meta._creativeIntensity?.instructions?.rendering ? `
## 渲染质感指导
${meta._creativeIntensity.instructions.rendering}` : ''}

${meta._directorStyle ? `
## 导演风格指导
${meta._directorStyle}` : ''}

5. 高潮场景必须包含情感张力和视觉冲击力

请直接输出 JSON，不要包含任何其他解释文字。

【编剧自检清单（输出前逐项过）】
□ 删掉任何一个场景，故事都会残缺吗？有删了无所谓的场景就合并。
□ 每句台词是否都能用动作演出来而不是说出来？
□ climax 场景时长是否全场最长？
□ 高潮与结尾之间是否有一个让观众喘气的留白场景？
□ 原文的钉子台词与特写细节是否原样保留？`;

    return prompt;
  }

  /**
   * 调用 LLM API
   * v1.1: 优先使用LLMEngine (kimi-k2p6)
   */
  async _callLLM(prompt) {
    // 【v2.1.4-fix13-审计修复】增加 Promise.race 超时保护，防止 LLM 调用 hang 住
    // 【v2.1.5-fix】修复 Promise.race + finally 死锁问题：改为手动清除定时器
    const timeoutMs = this.config.timeout || 600000;
    let timer;
    
    // 优先使用LLMEngine
    if (this.llmEngine) {
      try {
        console.log('[ScriptGenerator] 使用LLMEngine调用...');
        
        // 【v2.1.5-fix-B-REV】恢复systemPrompt，约束指令走system role
        // 原因：systemPrompt移除后LLM约束变弱，导致角色服装被篡改、科幻词汇混入
        const systemInstruction = `你是一位为国际电影节写过获奖短片的编剧，现在为 AI 视频生成系统创作结构化剧本。只输出严格格式的 JSON，不要 markdown 代码块，不要解释，不要思考过程。使用最紧凑的 JSON 格式（不要换行和缩进）。

【创作心法（与格式要求同等重要）】
1. 好故事是短片的灵魂：你的剧本必须有一条'人物在绝境中做出违背预期动作'的脊椎，所有场景挂在这条脊椎上，挂不上的删掉。
2. 台词极简主义：每句≤30字，全片台词宁少勿多。最好的台词是'具体到只有这个故事能讲'的钉子台词；次好的是两个字的台词（'成了'）；最差的是解释情绪的台词（禁止写'我很感动'类）。
3. 每句台词必须挂在物理动作上（trigger）：攥手/咬绳/退半步/仰头——情绪不许用嘴说，用身体演。
4. 场景时长按情感权重分配：climax 场景必须最长，留白场景必须有（高潮后的喘息），平均分配时长=没有节奏。
5. 闪回的使用标准：只在'当下的动作需要一个过去的锚点'时使用，闪回与当下必须有一个跨时空呼应的物理动作（如两次攥手）。
6. scenes[0] 的 scene_type 必须是 opening，且它必须完成'3秒抛出全片最大悬念'的任务。
7. 如果内容较长，优先保证 JSON 结构完整闭合。必要时压缩场景描述，但必须有合法的 JSON 结尾。`;
        
        // 创建超时promise
        const timeoutPromise = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`ScriptGenerator LLM 超时(${timeoutMs}ms)`)), timeoutMs);
        });
        
        // 调用LLM（恢复systemPrompt参数）
        // 【P1-11 修复】统一超时阈值与 maxTokens，不再硬编码
        // 【v2.1.6-fix16】增加maxTokens到16000，解决JSON输出被截断问题
        const llmPromise = this.llmEngine.generate(prompt, {
          systemPrompt: systemInstruction,
          maxTokens: this.config.maxTokens || 24000,
          timeoutMs: timeoutMs, // 与外层 race 同一阈值
          forceJson: false,
          allowReasoningFallback: true
        });
        // 【P1-11 修复】挂 catch 防止超时后 llmPromise 悬空 rejection 崩溃进程
        llmPromise.catch(() => {});
        
        // 等待结果（带超时保护）
        const result = await Promise.race([llmPromise, timeoutPromise]);
        
        // 成功后清除定时器
        if (timer) clearTimeout(timer);
        
        // v1.2.6-fix: 正确处理LLM引擎返回结构
        if (!result.success) {
          console.error('[ScriptGenerator] LLM引擎返回失败:', result.error);
          throw new Error(`LLM引擎错误: ${result.error}`);
        }
        
        // 【v2.1.6-fix14】增强JSON提取：从content和reasoning中智能提取
        let extractedJson = null;
        let jsonSource = null;
        
        // 优先尝试从content中提取JSON
        if (result.content && result.content.trim()) {
          const content = result.content.trim();
          
          // 快速验证：尝试解析并检查关键字段
          let contentValid = false;
          try {
            const parsed = JSON.parse(content);
            if (parsed.meta && parsed.structure && parsed.structure.scenes && parsed.structure.scenes.length > 0) {
              contentValid = true;
              console.log(`[ScriptGenerator] content JSON 验证通过: ${content.length}字符, scenes=${parsed.structure.scenes.length}`);
            } else {
              console.warn(`[ScriptGenerator] ⚠️ content JSON 缺少关键字段: meta=${!!parsed.meta}, structure=${!!parsed.structure}, scenes=${parsed.structure?.scenes?.length || 0}`);
            }
          } catch (e) {
            console.warn(`[ScriptGenerator] ⚠️ content JSON 解析失败: ${e.message}, 长度=${content.length}`);
          }
          
          if (contentValid) {
            return content;
          }
          
          // content 不是有效 JSON，尝试使用增强提取方法
          console.warn('[ScriptGenerator] ⚠️ content非有效JSON，尝试增强提取...');
          extractedJson = this._extractJsonFromText(content);
          if (extractedJson) {
            try {
              const parsed = JSON.parse(extractedJson);
              if (parsed.meta && parsed.structure && parsed.structure.scenes) {
                jsonSource = 'content-enhanced';
                console.log(`[ScriptGenerator] 从content增强提取JSON成功: ${extractedJson.length}字符, scenes=${parsed.structure.scenes.length}`);
                return extractedJson;
              }
            } catch (e) {
              console.warn(`[ScriptGenerator] 增强提取的JSON解析失败: ${e.message}`);
            }
          }
          
          // content 不完整，尝试从 reasoning 提取
          if (result.reasoning_content && result.reasoning_content.trim()) {
            console.warn('[ScriptGenerator] ⚠️ content 不完整，尝试从 reasoning 提取完整 JSON...');
            // DEBUG: 保存reasoning内容到文件以便分析
            const debugPath = path.join(process.cwd(), 'debug_reasoning.json');
            try {
              fs.writeFileSync(debugPath, JSON.stringify({
                content_length: content.length,
                reasoning_length: result.reasoning_content.length,
                reasoning_preview: result.reasoning_content.substring(0, 500),
                reasoning_last_500: result.reasoning_content.substring(result.reasoning_content.length - 500),
                timestamp: new Date().toISOString()
              }, null, 2));
              console.log(`[ScriptGenerator] DEBUG: 保存reasoning到 ${debugPath}`);
            } catch (e) {
              console.warn(`[ScriptGenerator] DEBUG保存失败: ${e.message}`);
            }
            extractedJson = this._extractJsonFromText(result.reasoning_content);
            if (extractedJson) {
              try {
                const parsed = JSON.parse(extractedJson);
                if (parsed.meta && parsed.structure && parsed.structure.scenes) {
                  jsonSource = 'reasoning';
                  console.log(`[ScriptGenerator] ✅ 从 reasoning 提取完整 JSON: ${extractedJson.length}字符, scenes=${parsed.structure.scenes.length}`);
                  return extractedJson;
                }
              } catch (e) {
                console.warn(`[ScriptGenerator] reasoning提取的JSON解析失败: ${e.message}`);
              }
            }
            console.warn('[ScriptGenerator] ⚠️ 从 reasoning 提取也失败，回退使用不完整的 content');
          }
          
          return content; // 返回不完整的 content，让 _parseLLMResponse 继续处理
        }
        
        // 兜底：从 reasoning 中提取 JSON 对象
        if (result.reasoning_content && result.reasoning_content.trim()) {
          console.warn('[ScriptGenerator] ⚠️ content为空，尝试从reasoning提取');
          const extracted = this._extractJsonFromText(result.reasoning_content);
          if (extracted) {
            try {
              const parsed = JSON.parse(extracted);
              if (parsed.meta && parsed.structure && parsed.structure.scenes) {
                console.log(`[ScriptGenerator] 从reasoning提取JSON: ${extracted.length}字符, scenes=${parsed.structure.scenes.length}`);
                return extracted;
              }
            } catch (e) {
              console.warn(`[ScriptGenerator] reasoning提取的JSON解析失败: ${e.message}`);
            }
          }
        }
        throw new Error('LLM返回空内容且无法从reasoning提取有效JSON');
      } catch (error) {
        // 错误时也要清除定时器
        if (timer) clearTimeout(timer);
        console.error('[ScriptGenerator] LLMEngine调用失败:', error.message);
        throw error;
      }
    }
    
    // 降级：直接HTTP调用（保留旧逻辑作为fallback）
    const axios = require('axios');
    let lastError = null;

    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      try {
        console.log(`[ScriptGenerator] LLM 直接调用尝试 ${attempt}/${this.config.maxRetries}`);

        const response = await axios.post(
          this.config.llmEndpoint,
          {
            model: this.config.model,
            messages: [
              { role: 'system', content: '你是一位专业的AI视频编剧，只输出严格格式的JSON。' },
              { role: 'user', content: prompt }
            ],
            max_tokens: this.config.maxTokens,
            temperature: 1,
            top_p: 0.95,
            thinking: { type: 'disabled' } // 【v2.1.8-fix13】禁用reasoning，释放token配额给content
          },
          {
            headers: {
              'Authorization': `Bearer ${this.config.apiKey}`,
              'Content-Type': 'application/json'
            },
            timeout: timeoutMs
          }
        );

        const content = response.data.choices?.[0]?.message?.content;
        if (!content) {
          throw new Error('LLM 返回内容为空');
        }

        return content;

      } catch (error) {
        lastError = error;
        console.warn(`[ScriptGenerator] LLM 调用失败 (${attempt}/${this.config.maxRetries}): ${error.message}`);

        if (attempt < this.config.maxRetries) {
          const delay = Math.pow(2, attempt) * 1000; // 指数退避
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw new Error(`LLM 调用失败，已重试 ${this.config.maxRetries} 次: ${lastError?.message}`);
  }

  /**
   * 解析 LLM 响应
   */
  _parseLLMResponse(response, userIntent) {
    try {
      // 清理响应中的 markdown 代码块标记
      let jsonStr = response;
      if (jsonStr.includes('```json')) {
        jsonStr = jsonStr.split('```json')[1].split('```')[0].trim();
      } else if (jsonStr.includes('```')) {
        jsonStr = jsonStr.split('```')[1].split('```')[0].trim();
      }

      // v1.2.5: 尝试解析JSON，失败则尝试从截断文本中提取
      let parsed = this._tryParseJson(jsonStr);
      
      // 如果主解析失败，尝试从文本中提取最长有效JSON
      if (!parsed) {
        console.warn('[ScriptGenerator] 主JSON解析失败，尝试提取有效JSON...');
        parsed = this._extractValidJson(jsonStr);
      }
      
      if (!parsed) {
        throw new Error('无法从响应中提取有效JSON');
      }

      // v1.2.6-fix4: 从metadata注入角色信息（彻底覆盖LLM生成的错误角色）
      const metadataChars = userIntent.metadata?.characters || [];
      if (metadataChars.length > 0) {
        const overrideCharacters = metadataChars.map(c => ({
          character_id: c.character_id || c.id || c.name,
          name: c.name,
          role: c.role || 'protagonist',
          visual_anchor: {
            core_features: c.description ? c.description.split(/[,，、]/).filter(s => s.trim()) : ['写实人物'],
            reference_images: c.portraitPaths || c.portraits || []
          },
          voice_profile: {
            persona: c.description || c.name,
            tone: '专业',
            speaking_style: '口语化科普'
          }
        }));

        const primaryName = overrideCharacters[0]?.name || '主讲人';
        const primaryDesc = metadataChars[0]?.description || primaryName;
        const validNames = overrideCharacters.map(c => c.name);
        const validIds = overrideCharacters.map(c => c.character_id);
        // 【P1-15 修复】合法speaker集合：只替换非法speaker，保留多角色对话
        const validSpeakerSet = new Set([...validNames, ...validIds, primaryName]);

        // 1. 替换角色系统
        parsed.character_system = { characters: overrideCharacters };

        // 2. 替换 voice_system 中的角色引用
        if (parsed.voice_system?.characters) {
          parsed.voice_system.characters = overrideCharacters;
        }

        // 3. 彻底替换所有场景中的角色引用（兼容多种 dialogue 结构）
        if (parsed.structure?.scenes) {
          for (const scene of parsed.structure.scenes) {
            // 3a. 替换场景角色ID列表
            if (Array.isArray(scene.characters)) {
              scene.characters = validIds.slice(0, scene.characters.length || 1);
            }

            // 3b. 兼容多种 dialogue 结构
            // 结构A: scene.dialogue.lines = [{speaker, text, ...}]
            if (scene.dialogue?.lines && Array.isArray(scene.dialogue.lines)) {
              for (const line of scene.dialogue.lines) {
                if (line && typeof line === 'object' && !validSpeakerSet.has(line.speaker)) {
                  line.speaker = primaryName;
                }
              }
            }
            // 结构B: scene.dialogue = [{speaker, text, ...}] (直接数组)
            else if (Array.isArray(scene.dialogue)) {
              scene.dialogue = scene.dialogue.map(line => {
                if (typeof line === 'string') {
                  return { speaker: primaryName, text: line, type: '独白', emotion: '平静' };
                }
                if (line && typeof line === 'object') {
                  if (!validSpeakerSet.has(line.speaker)) line.speaker = primaryName;
                  return line;
                }
                return line;
              });
            }
            // 结构C: scene.lines = [...] (部分LLM用这个)
            else if (scene.lines && Array.isArray(scene.lines)) {
              for (const line of scene.lines) {
                if (line && typeof line === 'object' && !validSpeakerSet.has(line.speaker)) {
                  line.speaker = primaryName;
                }
              }
            }
            // 结构D: scene.dialogue 是字符串
            else if (typeof scene.dialogue === 'string' && scene.dialogue.trim()) {
              let newDialogue = scene.dialogue;
              newDialogue = newDialogue.replace(/示例角色|角色R|角色A|角色B|医生小[A-Z]|患者小[A-Z]/g, primaryName);
              scene.dialogue = newDialogue;
            }

            // 3c. 替换场景描述中的角色名和身份描述
            if (typeof scene.description === 'string') {
              scene.description = scene.description.replace(/示例角色|角色R|角色A|角色B/g, primaryName);
            }
            if (typeof scene.scene_description === 'string') {
              scene.scene_description = scene.scene_description.replace(/示例角色|角色R|角色A|角色B/g, primaryName);
            }
            // v2.1.4-fix8: 替换 setting 和 visual_notes 中的错误角色身份
            // 【P0-5 修复】删除硬编码的"医生→警服/女性"正则替换。
            // 角色一致性应通过 prompt 约束 + ScriptValidator 保证，
            // 而非在解析层对场景文本做暴力正则改写。
            if (typeof scene.setting === 'string') {
              // 只保留示例角色占位符替换，不强制替换职业/性别
              scene.setting = scene.setting.replace(/示例角色|角色R|角色A|角色B/g, primaryName);
            }
            if (typeof scene.visual_notes === 'string') {
              scene.visual_notes = scene.visual_notes.replace(/示例角色|角色R|角色A|角色B/g, primaryName);
            }

            // 3d. 替换 narration 字段
            if (scene.narration) {
              if (typeof scene.narration === 'string') {
                scene.narration = scene.narration.replace(/示例角色|角色R|角色A|角色B/g, primaryName);
              } else if (Array.isArray(scene.narration)) {
                scene.narration = scene.narration.map(n => {
                  if (typeof n === 'string') return n.replace(/示例角色|角色R|角色A|角色B/g, primaryName);
                  if (n && typeof n === 'object') { if (!validSpeakerSet.has(n.speaker)) n.speaker = primaryName; return n; }
                  return n;
                });
              }
            }
          }
        }

        // 4. 清理 world_setting 中可能的角色引用
        if (parsed.world_setting?.characters) {
          parsed.world_setting.characters = overrideCharacters;
        }

        console.log(`[ScriptGenerator] 角色覆盖完成: ${validNames.join(', ')}（已替换所有场景角色引用和身份描述）`);
      }

      // ===== 【v2.1.10-fix】LLM 产出归一化（三道保险）=====
      // 无论用户是否提供角色档案，都执行——原角色覆盖仅在 metadata.characters 非空时生效，
      // 本次事故（用户未提供角色）暴露了 LLM 自由发挥的结构性风险
      const voiceoverPolicy = this._resolveVoiceoverPolicy(userIntent);
      const targetDuration = userIntent.metadata?.target_duration || 60;

      // 保险1：角色系统归一化（主角缺失/场景引用未定义角色的自动修复）
      this._normalizeCharacters(parsed);

      // 保险2：台词归一化（has_dialogue 回填、lines/blocks 互转、游离旁白字段归位）
      this._normalizeScenesDialogue(parsed, voiceoverPolicy.allowed);

      // 保险3：时长强制对齐（LLM 对"总时长=Ns"的遵守不可靠，按比例缩放到目标值）
      this._enforceTargetDuration(parsed, targetDuration);

      // v1.2.5: 注入metadata._metadata到blueprint meta
      const meta = {
        ...parsed.meta,
        narrative_mode: userIntent.parsed?.narrative_mode || 'dramatic',
        // 【v2.1.10-fix 时长断层】兜底与 production-profile 唯一真源对齐(60s)
        target_duration: userIntent.metadata?.target_duration || 60,
        _metadata: {
          // 【v2.1.10-fix 台词真空】旁白策略盖戳，供校验器单点读取
          voiceoverAllowed: voiceoverPolicy.allowed,
          dialogueRequirement: voiceoverPolicy.dialogueRequirement || null,
          isSeries: userIntent.metadata?.series?.totalEpisodes > 1 || userIntent.metadata?.series?.total_episodes > 1,
          episodeNumber: userIntent.metadata?.series?.currentEpisode || userIntent.metadata?.series?.episode || 1,
          totalEpisodes: userIntent.metadata?.series?.totalEpisodes || userIntent.metadata?.series?.total_episodes || 1,
          hasOpening: userIntent.metadata?.hasOpening !== false,
          noNextEpisodePreview: userIntent.metadata?.noNextEpisodePreview || false,
          aspectRatio: userIntent.metadata?.aspectRatio || '16:9',
          // 【v2.1.4】传递系列内容规划
          seriesContentPlan: userIntent.metadata?.seriesContentPlan || null,
          // 【脱节2 修复】透传 PRD 完整内容到剧本生成
          _prd: userIntent.metadata?._prd || null,
          // 【2026-07-17 修复】创意指数透传（SceneDesign 读 _metadata.creativeIntensity）
          creativeIntensity: userIntent.metadata?._creativeIntensity?.intensity ?? userIntent.metadata?.creativeIntensity ?? null,
          ...userIntent.metadata?._metadata
        }
      };

      // 构建 Blueprint
      const blueprint = new ScriptBlueprint({
        intent_ref: userIntent.intent_id,
        meta: meta,
        structure: parsed.structure,
        character_system: parsed.character_system,
        voice_system: parsed.voice_system,
        world_setting: parsed.world_setting,
        extensions: {
          dramatic_extension: parsed.dramatic_extension || {},
          nirath_extension: {
            featured_beast_id: userIntent.metadata?.featured_beast_id,
            memory_theme: '记忆即存在'
          }
        }
      });

      return blueprint;

    } catch (err) {
      console.error('[ScriptGenerator] JSON 解析失败:', err.message);
      console.error('[ScriptGenerator] 原始响应:', response.substring(0, 500));

      // 【P0-DATA-02 修复】抛出异常，不静默吞错，让调用方重试
      throw new ScriptGenerationError(
        'JSON_PARSE_FAILED',
        '无法从LLM响应中提取有效JSON: ' + err.message,
        { rawResponse: response.substring(0, 2000) }
      );
    }
  }

  /**
   * v1.2.5: 尝试解析JSON字符串
   * @returns {object|null} 解析成功返回对象，失败返回null
   */
  _tryParseJson(str) {
    try {
      return JSON.parse(str);
    } catch (e) {
      return null;
    }
  }

  /**
   * v1.2.5: 从可能截断的文本中提取最长有效JSON
   * 策略：从字符串末尾逐步截断，尝试找到能解析的最长前缀
   */
  /**
   * v1.2.6-fix11: 从可能截断的文本中提取最长有效JSON
   * 策略：1.直接解析 2.逐步截断前缀尝试 3.括号匹配找完整对象 4.🆕自动补全缺失的闭合括号
   */
  _extractValidJson(str) {
    if (!str || typeof str !== 'string') return null;

    // 先使用增强的文本提取获取JSON字符串
    const jsonStr = this._extractJsonFromText(str);
    if (jsonStr) {
      try {
        const parsed = JSON.parse(jsonStr);
        if (parsed.meta && parsed.structure) {
          console.log(`[ScriptGenerator] _extractValidJson: 通过_extractJsonFromText提取成功, ${jsonStr.length}/${str.length} 字符`);
          return parsed;
        }
      } catch (e) { /* 继续尝试其他方法 */ }
    }

    // 兜底：使用原有逻辑（逐步截断等）
    // 先找到最外层的大括号范围
    let start = str.indexOf('{');
    if (start === -1) return null;

    // 策略1：直接解析整段（快速路径）
    let parsed = this._tryParseJson(str.substring(start));
    if (parsed && parsed.meta && parsed.structure) return parsed;

    // 策略2：单次栈扫描定位匹配括号（O(n)，替代原暴力截断）
    {
      let braceCount = 0;
      let inString = false;
      let escaped = false;
      let lastValidEnd = -1;

      for (let i = start; i < str.length; i++) {
        const ch = str[i];
        if (inString) {
          if (escaped) { escaped = false; }
          else if (ch === '\\') { escaped = true; }
          else if (ch === '"') { inString = false; }
          continue;
        }
        if (ch === '"') { inString = true; }
        else if (ch === '{') { braceCount++; }
        else if (ch === '}') {
          braceCount--;
          if (braceCount === 0) lastValidEnd = i + 1;
        }
      }

      if (lastValidEnd > start) {
        const candidate = str.substring(start, lastValidEnd);
        try {
          const p = JSON.parse(candidate);
          if (p.meta && p.structure) {
            console.log(`[ScriptGenerator] 通过括号匹配提取JSON成功，使用 ${lastValidEnd}/${str.length} 字符`);
            return p;
          }
        } catch (e) { /* 失败，进入策略3 */ }
      }
    }

    // 策略3：自动补全缺失的闭合括号（处理未闭合的截断JSON）
    // 【P0-DATA-03 修复】避免合并多个独立对象：只修复第一个完整顶层对象
    {
      // 首先找到第一个完整的顶层对象边界（braceCount回到0的位置）
      let braceCount = 0;
      let bracketCount = 0;
      let inString = false;
      let escaped = false;
      let firstObjectEnd = -1;

      for (let i = start; i < str.length; i++) {
        const ch = str[i];
        if (inString) {
          if (escaped) { escaped = false; }
          else if (ch === '\\') { escaped = true; }
          else if (ch === '"') { inString = false; }
          continue;
        }
        if (ch === '"') { inString = true; }
        else if (ch === '{') { braceCount++; }
        else if (ch === '}') {
          braceCount--;
          if (braceCount === 0 && firstObjectEnd === -1) {
            firstObjectEnd = i + 1;
            break; // 只取第一个完整对象，忽略后面的截断内容
          }
        }
        else if (ch === '[') { bracketCount++; }
        else if (ch === ']') { bracketCount--; }
      }

      // 如果找到第一个完整对象，尝试解析它（它已经是完整的，无需补全）
      if (firstObjectEnd > start) {
        const firstObject = str.substring(start, firstObjectEnd);
        try {
          const p = JSON.parse(firstObject);
          if (p.meta && p.structure) {
            console.log(`[ScriptGenerator] 通过第一个完整对象提取JSON成功，使用 ${firstObjectEnd}/${str.length} 字符（忽略后面截断内容）`);
            return p;
          }
        } catch (e) { /* 第一个对象不完整，继续补全 */ }
      }

      // 未找到完整对象，需要补全：计算未闭合数
      let openBraces = 0;
      let openBrackets = 0;
      let inStr = false;
      let esc = false;

      for (let i = start; i < str.length; i++) {
        const ch = str[i];
        if (inStr) {
          if (esc) { esc = false; }
          else if (ch === '\\') { esc = true; }
          else if (ch === '"') { inStr = false; }
          continue;
        }
        if (ch === '"') { inStr = true; }
        else if (ch === '{') { openBraces++; }
        else if (ch === '}') { openBraces--; }
        else if (ch === '[') { openBrackets++; }
        else if (ch === ']') { openBrackets--; }
      }

      // 如果字符串未闭合，补上引号
      let base = str.substring(start);
      if (inStr) base += '"';

      // 【P0-DATA-03 修复】只补全第一个顶层对象，避免合并多个独立对象
      // 策略：在原始字符串末尾补全缺失的括号，然后找到第一个完整的顶层对象
      let candidate = base;
      
      // 由内到外补全：先补数组，再补对象
      if (openBrackets > 0) candidate += ']'.repeat(openBrackets);
      if (openBraces > 0) candidate += '}'.repeat(openBraces);

      // 尝试解析补全后的结果
      try {
        const p = JSON.parse(candidate);
        if (p && p.meta && p.structure) {
          // 【P0-DATA-03 修复】验证：确保没有重复键（合并对象的特征）
          const hasDuplicateKeys = this._checkDuplicateKeys(candidate);
          if (!hasDuplicateKeys) {
            console.log(`[ScriptGenerator] 通过自动补全括号提取JSON成功（补 ${openBrackets}个] ${openBraces}个}），使用 ${candidate.length}/${str.length} 字符`);
            return p;
          } else {
            console.warn(`[ScriptGenerator] 补全后检测到重复键，可能合并了多个对象，拒绝使用`);
          }
        }
      } catch (e) { /* 补全失败 */ }

      // 如果补全失败，尝试从补全后的字符串中提取第一个完整对象
      if (openBraces > 0) {
        // 逐步减少补全的对象括号数，尝试找到能解析的最小补全
        for (let reducedBraces = openBraces - 1; reducedBraces >= 0; reducedBraces--) {
          const testCandidate = base + ']'.repeat(openBrackets) + '}'.repeat(reducedBraces);
          try {
            const p = JSON.parse(testCandidate);
            if (p && p.meta && p.structure && !this._checkDuplicateKeys(testCandidate)) {
              console.log(`[ScriptGenerator] 通过减少对象补全提取JSON成功（补 ${openBrackets}个] ${reducedBraces}个}），使用 ${testCandidate.length}/${str.length} 字符`);
              return p;
            }
          } catch (e) { /* 继续尝试 */ }
        }
      }
    }

    return null;
  }

  /**
   * 【P0-DATA-03 修复】检测JSON字符串中是否有重复键（合并多个对象的特征）
   */
  _checkDuplicateKeys(jsonStr) {
    try {
      // 简单检测：统计顶层键出现次数
      const topLevelKeys = new Set();
      const keyMatches = jsonStr.match(/"([^"]+)"\s*:/g);
      if (!keyMatches) return false;
      
      for (const match of keyMatches) {
        const key = match.match(/"([^"]+)"/)[1];
        if (topLevelKeys.has(key)) return true;
        topLevelKeys.add(key);
      }
      return false;
    } catch (e) {
      return false; // 检测失败时不阻止解析
    }
  }

  // 【v2.1.6-fix14】增强JSON提取：从文本中智能提取JSON（支持markdown代码块、括号匹配等）
  // 【v2.1.6-fix15】增强JSON提取：支持markdown代码块、括号匹配、字符串截断补全、键值对清理
  _extractJsonFromText(text) {
    if (!text || typeof text !== 'string') return null;

    // 1. 从 markdown 代码块中提取
    const codeBlockMatch = text.match(/```json\s*([\s\S]*?)\s*```/i);
    if (codeBlockMatch?.[1]) {
      const candidate = codeBlockMatch[1].trim();
      try { JSON.parse(candidate); return candidate; } catch (_) {}
    }

    // 2. 从 ``` 代码块中提取（无语言标识）
    const genericBlockMatch = text.match(/```\s*([\s\S]*?)\s*```/);
    if (genericBlockMatch?.[1]) {
      const candidate = genericBlockMatch[1].trim();
      try { JSON.parse(candidate); return candidate; } catch (_) {}
    }

    // 3. 整体尝试解析
    const trimmed = text.trim();
    try { JSON.parse(trimmed); return trimmed; } catch (_) {}

    // 4. 从文本中搜索JSON对象（使用括号匹配）
    let start = text.indexOf('{');
    if (start === -1) return null;

    let braceCount = 0;
    let inString = false;
    let escaped = false;
    let lastValidEnd = -1;

    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) { escaped = false; }
        else if (ch === '\\') { escaped = true; }
        else if (ch === '"') { inString = false; }
        continue;
      }
      if (ch === '"') { inString = true; }
      else if (ch === '{') { braceCount++; }
      else if (ch === '}') {
        braceCount--;
        if (braceCount === 0) lastValidEnd = i + 1;
      }
    }

    if (lastValidEnd > start) {
      const candidate = text.substring(start, lastValidEnd);
      try { JSON.parse(candidate); return candidate; } catch (_) {}
    }

    // 5. 尝试补全不闭合的JSON（处理截断）
    // 先检测字符串是否未闭合
    let stringOpen = false;
    let escapeState = false;
    let lastNonStringBrace = 0;
    let braceStack = 0;
    
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (stringOpen) {
        if (escapeState) { escapeState = false; }
        else if (ch === '\\') { escapeState = true; }
        else if (ch === '"') { stringOpen = false; }
      } else {
        if (ch === '"') { stringOpen = true; }
        else if (ch === '{') { braceStack++; }
        else if (ch === '}') { braceStack--; }
      }
    }
    
    let candidate = text.substring(start);
    // 如果字符串未闭合，先补全引号
    if (stringOpen) {
      candidate += '"';
    }
    // 补全括号
    let open = 0, close = 0, bracketOpen = 0, bracketClose = 0;
    let inStr = false, esc = false;
    for (const ch of candidate) {
      if (inStr) {
        if (esc) { esc = false; }
        else if (ch === '\\') { esc = true; }
        else if (ch === '"') { inStr = false; }
      } else {
        if (ch === '"') { inStr = true; }
        else if (ch === '{') { open++; }
        else if (ch === '}') { close++; }
        else if (ch === '[') { bracketOpen++; }
        else if (ch === ']') { bracketClose++; }
      }
    }
    
    // 先补全括号（由内到外）
    candidate += ']'.repeat(Math.max(0, bracketOpen - bracketClose));
    candidate += '}'.repeat(Math.max(0, open - close));
    
    // 清理末尾不完整的键值对
    candidate = candidate.replace(/,\s*"[^"]*"?\s*:\s*"[^"]*$/, '');
    candidate = candidate.replace(/,\s*"[^"]*"?\s*:\s*$/, '');
    candidate = candidate.replace(/,\s*"[^"]*"?\s*$/, '');
    candidate = candidate.replace(/,\s*$/, '');
    
    try { JSON.parse(candidate); return candidate; } catch (_) {}

    // 6. 最终尝试：从最后一个完整键值对之后截断
    const lastCompletePair = candidate.lastIndexOf('",');
    if (lastCompletePair > 0) {
      const truncated = candidate.substring(0, lastCompletePair + 2) + '}';
      try { JSON.parse(truncated); return truncated; } catch (_) {}
    }

    return null;
  }

  /**
   * 【v2.1.10-fix 角色缺失】角色系统归一化（主角缺失/场景引用未定义角色的自动修复）
   * 无论用户是否提供角色档案都执行。
   */
  _normalizeCharacters(parsed) {
    const scenes = parsed?.structure?.scenes || [];
    if (!parsed.character_system || typeof parsed.character_system !== 'object') {
      parsed.character_system = { characters: [] };
    }
    const cs = parsed.character_system;
    if (!Array.isArray(cs.characters)) cs.characters = [];

    const definedIds = new Set();
    for (const c of cs.characters) {
      const id = c?.character_id || c?.id;
      if (id) {
        definedIds.add(String(id));
        if (!c.character_id && c.id) c.character_id = c.id;
      }
    }

    // 1. 收集场景引用 & 统计引用次数
    const refCount = new Map();
    for (const scene of scenes) {
      const chars = Array.isArray(scene.characters) ? scene.characters : [];
      for (const ch of chars) {
        const id = String(ch);
        refCount.set(id, (refCount.get(id) || 0) + 1);
      }
    }

    // 2. 为未定义的引用 ID 生成 stub
    const prettify = (id) => id
      .replace(/^CHAR[_-]?/i, '')
      .replace(/[_-]+/g, ' ')
      .trim()
      .toLowerCase()
      .replace(/\b\w/g, s => s.toUpperCase()) || id;

    let stubsCreated = 0;
    for (const id of refCount.keys()) {
      if (!definedIds.has(id)) {
        cs.characters.push({
          character_id: id,
          name: prettify(id),
          role: 'supporting',
          visual_anchor: { core_features: ['写实人物', '自然外观'], reference_images: [] },
          _auto_stub: true
        });
        definedIds.add(id);
        stubsCreated++;
      }
    }
    if (stubsCreated > 0) {
      console.warn(`[ScriptGenerator] ⚠️ 场景引用了 ${stubsCreated} 个未定义角色，已自动生成 stub 定义`);
    }

    // 3. 确保有且仅有一个主角
    const hasProtagonist = cs.characters.some(c => c && (c.role === 'protagonist'));
    if (!hasProtagonist && cs.characters.length > 0) {
      let pick = null;
      if (refCount.size > 0) {
        let best = -1;
        for (const [id, cnt] of refCount.entries()) {
          if (cnt > best) { best = cnt; pick = id; }
        }
      }
      const target = pick
        ? cs.characters.find(c => String(c.character_id || c.id) === pick)
        : cs.characters[0];
      if (target) {
        target.role = 'protagonist';
        console.warn(`[ScriptGenerator] ⚠️ LLM 未标记主角，已将引用最多的角色 ${target.character_id}(${target.name}) 标记为 protagonist`);
      }
    }

    // 4. 多余主角收敛
    let protagonistSeen = false;
    for (const c of cs.characters) {
      if (c && c.role === 'protagonist') {
        if (protagonistSeen) c.role = 'supporting';
        protagonistSeen = true;
      }
    }
  }

  /**
   * 【v2.1.10-fix 台词真空】台词归一化（has_dialogue 回填、lines/blocks 互转、游离旁白字段归位）
   */
  _normalizeScenesDialogue(parsed, voiceoverAllowed) {
    const scenes = parsed?.structure?.scenes || [];
    let fixedFlag = 0, converted = 0, derived = 0;

    for (const scene of scenes) {
      // 1. dialogue 为字符串 → 包装成 lines
      if (typeof scene.dialogue === 'string' && scene.dialogue.trim()) {
        scene.dialogue = { has_dialogue: true, lines: [{ speaker: null, text: scene.dialogue.trim() }], blocks: [] };
        converted++;
      } else if (!scene.dialogue || typeof scene.dialogue !== 'object') {
        scene.dialogue = { has_dialogue: false, lines: [], blocks: [] };
      }
      const d = scene.dialogue;
      if (!Array.isArray(d.lines)) d.lines = [];
      if (!Array.isArray(d.blocks)) d.blocks = [];

      // 2. 游离旁白字段归位
      const strayNarrations = [];
      if (typeof scene.narration === 'string' && scene.narration.trim()) {
        strayNarrations.push(scene.narration.trim());
      } else if (Array.isArray(scene.narration)) {
        for (const n of scene.narration) {
          if (typeof n === 'string' && n.trim()) strayNarrations.push(n.trim());
          else if (n && typeof n === 'object' && (n.text || n.line)) strayNarrations.push(String(n.text || n.line));
        }
      }
      if (scene.voice_over?.text) strayNarrations.push(String(scene.voice_over.text));
      if (typeof scene.voiceover === 'string' && scene.voiceover.trim()) strayNarrations.push(scene.voiceover.trim());

      if (strayNarrations.length > 0 && d.lines.length === 0 && d.blocks.length === 0) {
        const fallbackSpeaker = voiceoverAllowed
          ? '旁白'
          : (Array.isArray(scene.characters) && scene.characters.length > 0 ? String(scene.characters[0]) : '旁白');
        const narrationType = voiceoverAllowed ? 'narration' : 'monologue';
        for (const text of strayNarrations) {
          d.lines.push({ speaker: fallbackSpeaker, text, emotion: 'neutral' });
          d.blocks.push({
            speaker: fallbackSpeaker,
            line: text,
            emotion: 'calmly',
            trigger: voiceoverAllowed ? 'camera moves slowly' : 'looks into distance',
            manner: voiceoverAllowed ? '叙述' : '独白',
            type: narrationType
          });
        }
        converted++;
      }
      delete scene.narration;
      if (scene.voice_over) delete scene.voice_over;
      if (scene.voiceover) delete scene.voiceover;

      // 3. lines/blocks 互转补齐
      if (d.lines.length > 0 && d.blocks.length === 0) {
        d.blocks = d.lines.map(l => ({
          speaker: l.speaker || null,
          line: l.text || l.line || '',
          emotion: 'neutrally',
          trigger: 'looks at camera',
          manner: '自然',
          type: 'monologue'
        })).filter(b => b.line);
        derived++;
      } else if (d.blocks.length > 0 && d.lines.length === 0) {
        d.lines = d.blocks.map(b => ({
          speaker: b.speaker || null,
          text: b.line || b.text || '',
          emotion: b.emotion || 'neutral'
        })).filter(l => l.text);
        derived++;
      }

      // 4. has_dialogue 标志与实际内容对齐
      const hasContent = d.lines.length > 0 || d.blocks.length > 0;
      if (hasContent && d.has_dialogue !== true) { d.has_dialogue = true; fixedFlag++; }
      if (!hasContent && d.has_dialogue !== false) { d.has_dialogue = false; fixedFlag++; }
    }

    if (fixedFlag || converted || derived) {
      console.log(`[ScriptGenerator] 台词归一化: 标志回填 ${fixedFlag} 处, 游离旁白归位 ${converted} 处, lines/blocks 互转 ${derived} 处`);
    }
  }

  /**
   * 【v2.1.10-fix 时长断层】时长强制对齐（LLM 对"总时长=Ns"的遵守不可靠，按比例缩放到目标值）
   */
  _enforceTargetDuration(parsed, targetDuration) {
    const scenes = parsed?.structure?.scenes || [];
    const target = Number(targetDuration);
    if (scenes.length === 0 || !Number.isFinite(target) || target <= 0) return;

    const MIN_SCENE = 3;
    const MAX_SCENE = 60;
    const sum = () => scenes.reduce((t, s) => t + (Number(s?.timing?.duration) || 0), 0);

    let currentTotal = sum();
    if (currentTotal <= 0) {
      const per = Math.max(MIN_SCENE, Math.min(MAX_SCENE, Math.round(target / scenes.length)));
      for (const s of scenes) {
        s.timing = s.timing || {};
        s.timing.duration = per;
      }
      console.warn(`[ScriptGenerator] ⚠️ 场景时长全部缺失，已按目标 ${target}s 均分`);
    } else if (Math.abs(currentTotal - target) > 2) {
      const ratio = target / currentTotal;
      for (const s of scenes) {
        s.timing = s.timing || {};
        const d0 = Number(s.timing.duration) || (target / scenes.length);
        s.timing.duration = Math.max(MIN_SCENE, Math.min(MAX_SCENE, Math.round(d0 * ratio)));
      }
      console.warn(`[ScriptGenerator] ⚠️ 总时长 ${currentTotal}s 偏离目标 ${target}s，已按比例缩放`);
    }

    // 残差摊销
    let guard = 1000;
    while (guard-- > 0) {
      const diff = target - sum();
      if (diff === 0) break;
      const step = diff > 0 ? 1 : -1;
      const candidates = [...scenes]
        .filter(s => {
          const d = Number(s?.timing?.duration) || 0;
          return step > 0 ? d < MAX_SCENE : d > MIN_SCENE;
        })
        .sort((a, b) => (step > 0
          ? (Number(a.timing.duration) - Number(b.timing.duration))
          : (Number(b.timing.duration) - Number(a.timing.duration))));
      if (candidates.length === 0) {
        console.warn(`[ScriptGenerator] ⚠️ 时长残差 ${diff}s 无法完全摊销，当前总和 ${sum()}s`);
        break;
      }
      candidates[0].timing.duration += step;
    }

    // 重建 start/end 时间轴
    let cursor = 0;
    for (const s of scenes) {
      s.timing.start = cursor;
      s.timing.end = cursor + s.timing.duration;
      cursor = s.timing.end;
    }

    const finalTotal = sum();
    if (finalTotal !== Number(parsed?.meta?.total_duration)) {
      parsed.meta = parsed.meta || {};
      parsed.meta.total_duration = finalTotal;
    }
    console.log(`[ScriptGenerator] 时长对齐完成: 目标 ${target}s, 实际 ${finalTotal}s, ${scenes.length} 个场景`);
  }

  /**
   * 保存剧本到文件
   */
  async saveBlueprint(blueprint, outputPath) {
    try {
      const json = blueprint.toJSON();
      fs.writeFileSync(outputPath, json, 'utf-8');
      // v2.1.5-audit: 验证文件写入成功
      if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
        throw new Error(`文件写入失败或为空: ${outputPath}`);
      }
      console.log(`[ScriptGenerator] 剧本已保存: ${outputPath}`);
      return outputPath;
    } catch (e) {
      console.error(`[ScriptGenerator] 保存剧本失败: ${e.message}`);
      throw e; // 向上传播，让调用方决定如何处理
    }
  }

  /**
   * 从文件加载剧本
   */
  static loadBlueprint(filePath) {
    try {
      if (!fs.existsSync(filePath)) {
        throw new Error(`剧本文件不存在: ${filePath}`);
      }
      const json = fs.readFileSync(filePath, 'utf-8');
      if (!json || json.trim().length === 0) {
        throw new Error(`剧本文件为空: ${filePath}`);
      }
      return ScriptBlueprint.fromJSON(json);
    } catch (e) {
      console.error(`[ScriptGenerator] 加载剧本失败: ${e.message}`);
      throw e;
    }
  }
}

module.exports = { ScriptGenerator };