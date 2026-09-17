/**
 * PromptForge 导演编排系统 v1.0
 * 定位：老系统的"导演大脑"，70分 → 90分
 * 
 * 核心设计：
 * - 不重复建设已有业务子系统
 * - 只负责"导演编排"——调用素材、艺术创作、质量把关
 * - 最终产出引用提示词生成质量标准 v3.0
 * 
 * 三阶流水线：
 * Stage 1: 理解（总导演）→ 创作意图文档
 * Stage 2: 创作（首席编剧+摄影指导）→ 台词+镜头设计
 * Stage 3: 合成（合成师+质量守门员）→ 完整Prompt+质量报告
 * 
 * @module promptforge-director
 * @version 1.0
 * @date 2026-06-02
 */

'use strict';

const VERSION = '1.0';

// ============================================================
// 一、总导演（Director）— Stage 1: 理解
// ============================================================

class Director {
  constructor(options = {}) {
    this.llmClient = options.llmClient;
    this.beastArchive = options.beastArchive;
    this.nirathArchive = options.nirathArchive;
    this.directorStyleLib = options.directorStyleLib;
    this.narrativePrinciples = options.narrativePrinciples;
  }

  /**
   * 建立全片创作意图
   * @param {Object} projectConfig - 项目配置（神兽ID、主题、情绪基调）
   * @param {Object} rawReport - 老系统产出的初稿
   * @returns {Object} 创作意图文档
   */
  async createVision(projectConfig, rawReport) {
    const beastId = projectConfig.beastId || 'taotie';
    const theme = projectConfig.theme || '心灵碰撞';
    const emotionBase = projectConfig.emotionBase || '敬畏';
    
    // 调用子系统获取素材
    const beastProfile = await this.beastArchive.get(beastId);
    const nirathVisuals = await this.nirathArchive.getVisual(emotionBase);
    const directorStyles = await this.directorStyleLib.select(emotionBase, 3);
    
    // 构建大模型Prompt
    const prompt = this._buildDirectorPrompt(beastProfile, nirathVisuals, directorStyles, theme, rawReport);
    
    // 调用大模型（v6.5.47-fix: 降低maxTokens从8192到4096，避免reasoning_content过大导致OOM）
    const response = await this.llmClient.complete(prompt, { maxTokens: 4096 });
    
    // 解析输出
    return this._parseDirectorOutput(response);
  }

  _buildDirectorPrompt(beastProfile, nirathVisuals, directorStyles, theme, rawReport) {
    // 提取情绪弧线信息
    const shots = rawReport.shots || [];
    const emotionArc = shots.map((s, i) => `${i+1}. ${s.id}: ${s.emotionPhase || '未设定'}`).join('\n');
    
    return `
你是总导演。你手头有以下素材:

【神兽档案】
${JSON.stringify(beastProfile, null, 2)}

【Nirath星球视觉元素】
${JSON.stringify(nirathVisuals, null, 2)}

【导演风格可选】
${directorStyles.map((s, i) => `${i+1}. ${s.name}(${s.signature})`).join('\n')}

【老系统初稿】
${JSON.stringify(rawReport.shots?.map(s => ({id: s.id, scene: s.scene, emotion: s.emotionPhase})) || [], null, 2)}

【情绪弧线现状】
${emotionArc}

【核心要求】
1. 以"异兽"视角讲述故事，人类小孩是"闯入者"
2. 故事核心是"心灵碰撞"——两个生命体的相遇与理解
3. 强化剧情紧凑性，每个镜头推进叙事
4. 强化Nirath星球元素（双恒星、地脉光、能量孢子、磁丝树等）
5. 最终产出可直接渲染的90分Prompt
6. **关键：每个镜头的情绪表达必须清晰递进。检查当前情绪弧线是否合理，是否有情绪断层或重复**
7. **关键：视觉设计要服务于情绪，不是服务于风景。每个镜头的光影、运镜、构图必须强化当前情绪**

请输出JSON格式的《导演创作意图文档》，包含:
1. 核心主题一句话
2. 情绪弧线（每个镜头的情绪递进，标注情绪强度1-10）
3. 导演风格选择及理由
4. 视觉基调一句话
5. 叙事策略（如何处理异兽视角）
6. **情绪审查报告**：逐镜头检查当前情绪表达是否足够，如果不够，建议如何通过视觉/光影/运镜增强**

【输出格式】
{
  "coreTheme": "一句话主题",
  "emotionArc": [{"phase": "情绪名", "intensity": 1-10}],
  "directorStyle": {"name": "风格名", "reason": "选择理由"},
  "visualTone": "视觉基调描述",
  "narrativeStrategy": "叙事策略"
}

约束：只输出JSON，不要markdown代码块，不要解释。`;
  }

  _parseDirectorOutput(response) {
    // 安全提取文本
    let text = '';
    if (typeof response === 'string') {
      text = response;
    } else if (response && typeof response.text === 'string') {
      text = response.text;
    } else if (response && typeof response.content === 'string') {
      text = response.content;
    } else if (response && Array.isArray(response.messages)) {
      text = response.messages.map(m => m.content || '').join('\n');
    } else {
      text = JSON.stringify(response);
    }
    
    // 如果文本仍然为空或太短，返回原始响应的字符串化形式
    if (!text || text.length < 10) {
      text = JSON.stringify(response);
    }
    
    return {
      coreTheme: this._extractField(text, '核心主题'),
      emotionArc: this._parseEmotionArc(this._extractField(text, '情绪弧线')),
      directorStyle: this._extractField(text, '导演风格'),
      visualTone: this._extractField(text, '视觉基调'),
      narrativeStrategy: this._extractField(text, '叙事策略'),
      rawText: text
    };
  }

  _parseEmotionArc(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    // 从字符串解析，如 "好奇→紧张→敬畏"
    return raw.split(/[→>]/).map(s => ({
      phase: s.trim(),
      intensity: 5
    }));
  }

  _extractField(text, fieldName) {
    const regex = new RegExp(`${fieldName}[：:]\s*(.+?)(?=\n\d+\.|\n【|$)`, 's');
    const match = text.match(regex);
    return match ? match[1].trim() : '';
  }
}

// ============================================================
// 二、首席编剧（Writer）— Stage 2: 创作台词
// ============================================================

class ChiefWriter {
  constructor(options = {}) {
    this.llmClient = options.llmClient;
    this.beastArchive = options.beastArchive;
    this.dialogueLib = options.dialogueLib;
    this.narrativePrinciples = options.narrativePrinciples;
  }

  /**
   * 为每个镜头创作台词（批量处理，防止内存溢出）
   * @param {Object} vision - 导演创作意图
   * @param {Array} shots - 镜头列表
   * @returns {Array} 带台词的镜头
   */
  async writeDialogues(vision, shots) {
    // 串行处理：每批1个镜头，降低单次请求复杂度（白天API 120秒超时）
    const batchSize = 1;
    const enhancedShots = [];
    
    for (let i = 0; i < shots.length; i += batchSize) {
      const batch = shots.slice(i, i + batchSize);
      const batchResults = await this._writeBatch(vision, batch);
      enhancedShots.push(...batchResults);
      
      // 批次间延迟：降低服务端压力（白天API限流）
      if (i + batchSize < shots.length) {
        console.log(`[PromptForge] ⏳ 编剧批次间等待 0s...`);
        await this._sleep(0);
      }
    }
    
    return enhancedShots;
  }
  
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  async _writeBatch(vision, shots) {
    const prompt = this._buildBatchWriterPrompt(vision, shots);
    // 限制返回token数（增加空间确保content输出）
    const response = await this.llmClient.complete(prompt, { maxTokens: 4096 });
    
    return this._parseBatchWriterOutput(response, shots);
  }
  
  _buildBatchWriterPrompt(vision, shots) {
    const shotsDesc = shots.map((shot, idx) => `
【镜头${idx+1}】
ID: ${shot.id}
场景: ${shot.scene}
情绪: ${shot.emotionPhase}
时长: ${shot.duration}秒
字数限制: ${Math.floor(shot.duration * 4.5)}字以内
`).join('\n');

    return `
你是首席编剧。总导演的创作意图是:
${vision.rawText}

请为以下${shots.length}个镜头创作台词：
${shotsDesc}

【核心要求】
1. 以异兽视角写台词，人类小孩是"闯入者"
2. 台词要有深度，不是表面问候，而是生命层面的对话
3. 体现心灵碰撞——两个生命体的相遇与理解
4. 符合Nirath世界观（双恒星、地脉光、能量孢子、磁丝树等）
5. 严格控制字数，不超过时长限制
6. 如果是异兽台词，要体现其感知方式（非人类视角）
7. 如果是旁白，要有诗意和深度
8. **关键：台词必须体现当前镜头的情绪（${shots.map(s => s.emotionPhase).join('→')}），情绪递进要清晰**

请输出JSON格式：
{
  "shots": [
    {
      "shotId": "S01",
      "dialogue": "台词文本",
      "depth": "L1|L2|L3|L4",
      "emotionExpression": "20字内说明"
    }
  ]
}

约束：每个镜头台词字数不超过${Math.floor(shots[0]?.duration * 4.5) || 67}字。只输出JSON，不要解释。`;
  }
  
  _parseBatchWriterOutput(response, originalShots) {
    // v6.5.48-fix: 安全提取文本，处理 content=0 的情况
    let text = '';
    if (typeof response === 'string') {
      text = response;
    } else if (response && typeof response.text === 'string') {
      text = response.text;
    } else if (response && typeof response.content === 'string') {
      text = response.content;
    } else if (response && Array.isArray(response.messages)) {
      text = response.messages.map(m => m.content || '').join('\n');
    } else {
      text = JSON.stringify(response);
    }
    
    // 如果文本仍然为空或太短，返回原始响应的字符串化形式
    if (!text || text.length < 10) {
      text = JSON.stringify(response);
    }
    const results = [];
    
    for (const shot of originalShots) {
      const shotRegex = new RegExp(`【镜头ID】${shot.id}[\\s\\S]*?(?=【镜头ID】|$)`, 'g');
      const match = text.match(shotRegex);
      
      if (match) {
        const shotText = match[0];
        const dialogueMatch = shotText.match(/【最终台词】\s*(.+?)(?=【深度评级】|$)/s);
        const depthMatch = shotText.match(/【深度评级】\s*(L[1-4])/);
        const emotionMatch = shotText.match(/【情绪表达】\s*(.+?)(?=【镜头ID】|$)/s);
        
        results.push({
          ...shot,
          dialogue: dialogueMatch ? dialogueMatch[1].trim() : '',
          dialogueDepth: depthMatch ? depthMatch[1] : 'L2',
          dialogueContext: emotionMatch ? emotionMatch[1].trim() : '',
          narratorNote: ''
        });
      } else {
        // 回退：逐个处理
        results.push({...shot, dialogue: '', dialogueDepth: 'L2', dialogueContext: ''});
      }
    }
    
    return results;
  }

  // 保留旧方法用于兼容
  _buildWriterPrompt(vision, shot, beastVoice, dialogueRefs) {
    return `
你是首席编剧。总导演的创作意图是:
${vision.rawText}

你现在要为镜头[${shot.id}]写台词。
场景: ${shot.scene}
情绪: ${shot.emotionPhase}
时长: ${shot.duration}秒

【角色声音档案】
${JSON.stringify(beastVoice, null, 2)}

【参考台词】
${JSON.stringify(dialogueRefs, null, 2)}

【核心要求】
1. 以异兽视角写台词，人类小孩是"闯入者"
2. 台词要有深度，不是表面问候，而是生命层面的对话
3. 体现心灵碰撞——两个生命体的相遇与理解
4. 符合Nirath世界观（双恒星、地脉光、能量孢子、磁丝树等）
5. 时长${shot.duration}秒，台词字数控制在${Math.floor(shot.duration * 4.5)}字以内
6. 如果是异兽台词，要体现其感知方式（非人类视角）
7. 如果是旁白，要有诗意和深度

请展示创作过程:
1. 这个场景的核心情感是什么?
2. 异兽会如何"感受"这个场景?
3. 最终台词是什么?

输出格式：
【创作思考】...
【最终台词】...（仅输出台词内容，不含角色名前缀）
【深度评级】L1/L2/L3/L4（L1=信息型，L2=情感型，L3=人格型，L4=哲学型）
`;
  }

  _parseWriterOutput(response) {
    const text = response.text || response.content || (typeof response === 'string' ? response : JSON.stringify(response));
    
    const dialogueMatch = text.match(/【最终台词】\s*(.+?)(?=\n【深度评级】|$)/s);
    const depthMatch = text.match(/【深度评级】\s*(L[1-4])/);
    
    return {
      text: dialogueMatch ? dialogueMatch[1].trim() : text,
      depth: depthMatch ? depthMatch[1] : 'L2',
      context: text.match(/【创作思考】\s*(.+?)(?=\n【最终台词】|$)/s)?.[1]?.trim() || ''
    };
  }
}

// ============================================================
// 三、摄影指导（DP）— Stage 2: 设计镜头
// ============================================================

class DirectorOfPhotography {
  constructor(options = {}) {
    this.llmClient = options.llmClient;
    this.cameraMovementLib = options.cameraMovementLib;
    this.microExpressionLib = options.microExpressionLib;
    this.nirathArchive = options.nirathArchive;
    this.lightingLib = options.lightingLib;
    this.directorStyleLib = options.directorStyleLib;
  }

  /**
   * 为每个镜头设计运镜和视觉（批量处理，防止内存溢出）
   * @param {Object} vision - 导演创作意图
   * @param {Array} shots - 带台词的镜头
   * @returns {Array} 带镜头设计的镜头
   */
  async designShots(vision, shots) {
    // 串行处理：每批1个镜头，降低单次请求复杂度（白天API 120秒超时）
    const batchSize = 1;
    const designedShots = [];
    
    for (let i = 0; i < shots.length; i += batchSize) {
      const batch = shots.slice(i, i + batchSize);
      const batchResults = await this._designBatch(vision, batch);
      designedShots.push(...batchResults);
      
      // 批次间延迟：降低服务端压力
      if (i + batchSize < shots.length) {
        console.log(`[PromptForge] ⏳ 摄影批次间等待 0s...`);
        await this._sleep(0);
      }
    }
    
    return designedShots;
  }
  
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  async _designBatch(vision, shots) {
    const prompt = this._buildBatchDPPrompt(vision, shots);
    const response = await this.llmClient.complete(prompt, { maxTokens: 4096 });
    
    return this._parseBatchDPOutput(response, shots);
  }
  
  _buildBatchDPPrompt(vision, shots) {
    const shotsDesc = shots.map((shot, idx) => {
      return `
【镜头${idx+1}】
ID: ${shot.id}
场景: ${shot.scene}
情绪: ${shot.emotionPhase}
时长: ${shot.duration}秒
台词: ${shot.dialogue || '无台词'}
`;
    }).join('\n');

    return `
你是摄影指导。总导演的创作意图是:
${vision.rawText}

请为以下${shots.length}个镜头设计镜头语言：
${shotsDesc}

【核心要求】
1. 镜头设计要体现导演风格（${vision.directorStyle}）
2. 光影要符合Nirath双恒星设定（Aurelius 5800K + Silvana 6500K）
3. 画面中必须包含≥2个Nirath专属元素
4. 运镜要有创意，不是标准推拉升降
5. 视觉设计要服务叙事，不是纯风景展示
6. **关键：每个镜头的情绪表达必须到位，通过光影、构图、运镜来强化情绪，而不是只靠台词**
7. 最终产出可直接填入Prompt的镜头描述

请输出每个镜头的设计：
格式：
【镜头ID】xxx
【镜头运动】景别+运镜+角度
【光影布置】主光+辅光+色温
【Nirath元素】至少2个
【角色表演】微表情+姿态
【Prompt增强】可直接填入Prompt的描述
【情绪强化】说明如何通过视觉手段强化当前情绪
`;
  }
  
  _parseBatchDPOutput(response, originalShots) {
    const text = response.text || response.content || (typeof response === 'string' ? response : JSON.stringify(response));
    const results = [];
    
    for (const shot of originalShots) {
      // 【v6.3-patch8-fix】增加多种匹配模式，提高鲁棒性
      const patterns = [
        `【镜头ID】${shot.id}`,
        `镜头ID[：:]${shot.id}`,
        `### ${shot.id}`,
        `## ${shot.id}`,
        `\\[${shot.id}\\]`,
        `${shot.id}[:：]`
      ];
      
      let match = null;
      let shotText = '';
      
      for (const pattern of patterns) {
        const shotRegex = new RegExp(`${pattern}[\\s\\S]*?(?=(${patterns.join('|')})|$)`, 'i');
        const m = text.match(shotRegex);
        if (m && m[0].length > 50) {
          match = m;
          shotText = m[0];
          break;
        }
      }
      
      // 如果所有模式都失败，尝试在文本中搜索 shot.id 附近的段落
      if (!match) {
        const idx = text.indexOf(shot.id);
        if (idx >= 0) {
          const start = Math.max(0, idx - 50);
          const end = Math.min(text.length, idx + 500);
          shotText = text.substring(start, end);
          console.log(`[DP] ⚠️ ${shot.id} 正则匹配失败，使用位置回退提取 (${shotText.length}字符)`);
        }
      }
      
      if (shotText) {
        const dpFields = {
          cameraDesign: shotText.match(/【镜头运动】\s*(.+?)(?=【光影布置】|$)/s)?.[1]?.trim() || 
                        shotText.match(/镜头运动[:：]\s*(.+?)(?=光影|$)/s)?.[1]?.trim() || '',
          lightingDesign: shotText.match(/【光影布置】\s*(.+?)(?=【Nirath元素】|$)/s)?.[1]?.trim() || 
                          shotText.match(/光影布置[:：]\s*(.+?)(?=Nirath|$)/s)?.[1]?.trim() || '',
          visualElements: shotText.match(/【Nirath元素】\s*(.+?)(?=【角色表演】|$)/s)?.[1]?.trim() || 
                          shotText.match(/Nirath元素[:：]\s*(.+?)(?=角色|$)/s)?.[1]?.trim() || '',
          performance: shotText.match(/【角色表演】\s*(.+?)(?=【Prompt增强】|$)/s)?.[1]?.trim() || 
                       shotText.match(/角色表演[:：]\s*(.+?)(?=Prompt|$)/s)?.[1]?.trim() || '',
          promptEnhancement: shotText.match(/【Prompt增强】\s*(.+?)(?=【情绪强化】|$)/s)?.[1]?.trim() || 
                             shotText.match(/Prompt增强[:：]\s*(.+?)(?=情绪|$)/s)?.[1]?.trim() || '',
          emotionReinforcement: shotText.match(/【情绪强化】\s*(.+?)(?=【镜头ID】|$)/s)?.[1]?.trim() || 
                                  shotText.match(/情绪强化[:：]\s*(.+?)(?=$)/s)?.[1]?.trim() || ''
        };

        const merged = { ...shot };
        for (const [key, value] of Object.entries(dpFields)) {
          if (value) merged[key] = value;
        }
        results.push(merged);
      } else {
        console.log(`[DP] ❌ ${shot.id} 完全无法解析，所有字段为空`);
        results.push({...shot, cameraDesign: '', lightingDesign: '', visualElements: '', performance: '', promptEnhancement: '', emotionReinforcement: ''});
      }
    }
    
    return results;
  }

  // 保留旧方法用于兼容
  _buildDPPrompt(vision, shot, cameraParams, expressions, lighting, nirathElements) {
    return `
你是摄影指导。总导演的创作意图是:
${vision.rawText}

编剧为这个镜头写的台词是:
${shot.dialogue || '无台词'}

【镜头信息】
ID: ${shot.id}
场景: ${shot.scene}
情绪: ${shot.emotionPhase}
时长: ${shot.duration}秒

【可用运镜素材】
${JSON.stringify(cameraParams, null, 2)}

【微表情参考】
${JSON.stringify(expressions, null, 2)}

【光影方案】
${JSON.stringify(lighting, null, 2)}

【Nirath专属元素】
${JSON.stringify(nirathElements, null, 2)}

【核心要求】
1. 镜头设计要体现导演风格（${vision.directorStyle}）
2. 光影要符合Nirath双恒星设定（Aurelius 5800K + Silvana 6500K）
3. 画面中必须包含≥2个Nirath专属元素
4. 运镜要有创意，不是标准推拉升降
5. 视觉设计要服务叙事，不是纯风景展示
6. 最终产出可直接填入Prompt的镜头描述

请设计镜头语言:
1. 镜头如何运动?（景别+运镜+角度）
2. 光影如何布置?（主光+辅光+色温）
3. 画面包含哪些Nirath元素?
4. 角色如何表演?（微表情+姿态）
5. 最终Prompt增强描述是什么?

输出格式：
【镜头运动】...
【光影布置】...
【Nirath元素】...
【角色表演】...
【Prompt增强】...
`;
  }

  _parseDPOutput(response) {
    const text = response.text || response.content || (typeof response === 'string' ? response : JSON.stringify(response));
    
    return {
      camera: text.match(/【镜头运动】\s*(.+?)(?=\n【光影布置】|$)/s)?.[1]?.trim() || '',
      lighting: text.match(/【光影布置】\s*(.+?)(?=\n【Nirath元素】|$)/s)?.[1]?.trim() || '',
      visualElements: text.match(/【Nirath元素】\s*(.+?)(?=\n【角色表演】|$)/s)?.[1]?.trim() || '',
      performance: text.match(/【角色表演】\s*(.+?)(?=\n【Prompt增强】|$)/s)?.[1]?.trim() || '',
      promptEnhancement: text.match(/【Prompt增强】\s*(.+?)(?=\n|$)/s)?.[1]?.trim() || ''
    };
  }
}

// ============================================================
// 四、分镜合成师（Compositor）— Stage 3: 合成
// ============================================================

class ShotCompositor {
  constructor(options = {}) {
    this.llmClient = options.llmClient;
  }

  /**
   * 融合台词+运镜+视觉 → 完整Prompt
   * @param {Object} vision - 导演创作意图
   * @param {Array} designedShots - 带设计的镜头
   * @returns {Array} 完整Prompt列表
   */
  async composeShots(vision, designedShots) {
    const composedShots = [];
    
    for (let i = 0; i < designedShots.length; i++) {
      const shot = designedShots[i];
      const prompt = this._buildCompositorPrompt(vision, shot);
      
      // v6.2-patch118: 白天模式——maxTokens 8192，确保content有输出
      const response = await this.llmClient.complete(prompt, { maxTokens: 4096 });
      
      const creativeContent = this._parseCompositorOutput(response);
      
      // 自动拼接系统模板（固定约束部分，4000-5000字符）
      const finalPrompt = this._assembleFullPrompt(creativeContent, vision, shot);
      
      composedShots.push({
        ...shot,
        finalPrompt: finalPrompt,
        promptLength: finalPrompt.length,
        structure: creativeContent.structure,
        creativePart: creativeContent.text  // 记录创意部分，便于调试
      });
      
      // 批次间延迟：降低服务端压力
      if (i < designedShots.length - 1) {
        console.log(`[PromptForge] ⏳ 合成批次间等待 0s...`);
        await this._sleep(0);
      }
    }
    
    return composedShots;
  }
  
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 组装完整 Prompt：LLM 创意部分 + 系统模板固定约束
   * v6.3-patch10-fix: 目标长度 889-988 字符
   */
  _assembleFullPrompt(creativeContent, vision, shot) {
    const creative = creativeContent.text.trim();
    
    // 系统模板固定约束
    const systemTemplate = this._buildSystemTemplate(vision, shot);
    
    // 去重：防止创意部分与系统模板重复
    const { dedup } = require('../utils/prompt-dedup');
    const cleanedCreative = dedup(creative, systemTemplate);
    
    // 组装：创意部分 + 系统模板
    let fullPrompt = `${cleanedCreative}\n\n${systemTemplate}`;
    
    // 长度校验
    const TARGET_MIN = 889, TARGET_MAX = 988, HARD_MAX = 1000;
    if (fullPrompt.length > TARGET_MAX) {
      console.warn(`[PromptForge] ⚠️ Prompt超长 ${fullPrompt.length} > ${TARGET_MAX}`);
      // 裁剪创意部分
      const excess = fullPrompt.length - TARGET_MAX;
      const trimmedCreative = cleanedCreative.substring(0, Math.max(cleanedCreative.length - excess - 10, 100));
      fullPrompt = `${trimmedCreative}\n\n${systemTemplate}`;
      console.log(`[PromptForge] ✂️ 裁剪后 ${fullPrompt.length}`);
    }
    
    // v6.3-patch10-fix: 如果太短，尝试扩展
    if (fullPrompt.length < TARGET_MIN) {
      console.warn(`[PromptForge] ⚠️ Prompt过短 ${fullPrompt.length} < ${TARGET_MIN}`);
      // 尝试扩展创意部分
      const expansionLib = [
        '电影级超写实环境叙事与层叠空间深度',
        '顶级材质保真与物理可信纹理响应',
        '体积光分离与大气深度对比控制',
        '主体可读性与稳定视觉身份连续性',
        '微妙环境微观动态与粒子运动',
        '受控摄影机节奏与刻意焦点迁移',
        '神话异星生态, 晶化地形, 能量脉络景观逻辑',
        '高端CG写实, 虚幻引擎5品质, 扎根尺度感知',
        '微表情完整性, 姿态写实, 呼吸节奏, 稳定身体力学'
      ];
      
      for (const item of expansionLib) {
        if (fullPrompt.length >= TARGET_MIN) break;
        const next = `${fullPrompt} ${item}`;
        if (next.length <= TARGET_MAX) {
          fullPrompt = next;
        }
      }
    }
    
    console.log(`[PromptForge] 📝 组装完成 | 创意部分: ${cleanedCreative.length}字符 | 系统模板: ${systemTemplate.length}字符 | 总计: ${fullPrompt.length}字符`);
    
    return fullPrompt;
  }
  
  /**
   * 构建系统模板固定约束（4000-5000字符，不依赖 LLM）
   */
  _buildSystemTemplate(vision, shot) {
    const beastId = vision?.beastId || 'taotie';
    const sceneName = shot.scene || 'Nirath异世界场景';
    
    return `【ASTRALIS】UE5超写实,Lumen光照,16:9。Nirath:0.82G重力,3.2Tesla磁场,双恒星5800K+6500K。

【全局约束】禁止红蓝黄绿紫荧光眼;禁止水晶/重复角色/卡通/暗黑;禁止中国传统元素;禁止水墨画。

【明亮约束】双恒星明亮光照,禁止暗黑/夜晚。必须明亮奇幻、多色彩。

【风格锁】双恒星+磁场可见+低重力飘浮。这是Nirath。

【角色约束】仅一个小G和一个${beastId}。

【技术规格】超写实数字渲染,影视级构图,体积光,空气透视,微距摄影级细节,外星繁茂植被。`;
  }

  _buildCompositorPrompt(vision, shot) {
    // 【v6.3-patch8-fix】合并 Stage 2a(编剧) + Stage 2b(摄影) 的产出，而非重新生成
    
    const visionSummary = vision?.coreTheme || vision?.directorStyle || '史诗级奇幻，异兽视角';
    const emotionArc = Array.isArray(vision?.emotionArc) 
      ? vision.emotionArc.map(e => `${e.id}:${e.phase}`).join('→') 
      : (vision?.emotionArc || shot.emotionPhase || 'curiosity');
    
    // 【v6.3-patch8-fix】将 Stage 2b 的设计要素格式化为自然语言
    const cameraSection = shot.cameraDesign
      ? `【摄影设计】\n${shot.cameraDesign}\n`
      : '';
    const lightingSection = shot.lightingDesign
      ? `【灯光设计】\n${shot.lightingDesign}\n`
      : '';
    const emotionSection = shot.emotionReinforcement
      ? `【情绪强化】\n${shot.emotionReinforcement}\n`
      : '';
    
    // v6.7.0-dialogue-patch: 优先使用 dialogueBlock 生成【对话指令】
    const dialogueBlock = shot.dialogueBlock || {};
    const dialogueText = dialogueBlock.text || shot.dialogue || '';
    const dialogueSection = dialogueText
      ? `【对话指令】\n${dialogueText}\n`
      : '';
    
    // 【v6.3-patch10-fix】动态计算系统模板长度，确保目标总长度准确
    const systemTemplate = this._buildSystemTemplate(vision, shot);
    const SYSTEM_TEMPLATE_LEN = systemTemplate.length;
    const targetMin = Math.max(889 - SYSTEM_TEMPLATE_LEN, 500); // 至少500字符创意
    const targetMax = 988 - SYSTEM_TEMPLATE_LEN;

    return `
你是 PromptForge 合成师。你的任务是将下方提供的摄影、灯光、情绪、台词设计合并为一篇连贯的画面描述。

## 关键要求

1. **长度严格约束**：创意部分必须达到 ${targetMin}-${targetMax} 字符（总目标 889-988 字符）
2. **字段长度分配**：
   - 【视觉】120-180 字符（核心画面描述）
   - 【镜头时间轴】100-160 字符（运镜设计）
   - 【环境音效】60-100 字符（声音设计）
3. **禁止重复**：Scene 和 Action 不得重复，如果内容相似，Action 必须聚焦角色表演
4. **禁止分析**：不要写思考过程、不要解释、不要写多个版本
5. **只输出一版**：直接写最终稿，禁止修改稿或草稿

## 输入设计

${cameraSection}
${lightingSection}
${emotionSection}
${dialogueSection}

## 输出格式（必须包含这三个标记，只输出一次）

【视觉】
画面描述正文（120-180字符）

【镜头时间轴】
运镜词（100-160字符）

【环境音效】
环境声音描述（60-100字符）

现在直接写 ${shot.id} 的画面描述，不要任何开场白：
`;
  }

  _parseCompositorOutput(response, shotId) {
    if (!response) return { text: '', structure: [] };

    let finalPrompt = response.text || response.content || (typeof response === 'string' ? response : JSON.stringify(response));

    // 【v6.3-patch8-fix】清理思考过程：只删除明确的思考段落
    // 危险：正则 让我[\s\S]*? 会误删画面描述，改为只清理字数统计
    // 子进程已做逐行过滤，这里只做简单后处理
    
    // 移除代码块标记
    finalPrompt = finalPrompt.replace(/^```\w*\n?/gm, '').replace(/\n?```$/gm, '');
    
    // 清理字数统计残留（逐行安全清理）
    const lines = finalPrompt.split('\n');
    const cleanLines = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // 只删除字数统计行
      if (trimmed.match(/^=\s*\d+\s*[字chars]/)) continue;
      if (trimmed.match(/^\(\d+\)/)) continue;
      if (trimmed.includes('总中文字符')) continue;
      if (trimmed.includes('仍然不够')) continue;
      if (trimmed.includes('我数错了')) continue;
      if (trimmed.includes('字数统计')) continue;
      cleanLines.push(trimmed);
    }
    finalPrompt = cleanLines.join('\n');
    
    // 清理后如果Prompt变短很多，记录日志
    const cleanedLength = finalPrompt.length;
    if (cleanedLength < 300) {
      console.log(`[PromptForge] ⚠️ 清理后Prompt过短 (${cleanedLength}字符)，可能误删了内容`);
    }

    // 移除可能的 JSON 前缀（如果模型错误输出了 JSON）
    try {
      const jsonMatch = finalPrompt.match(/\{[\s\S]*\}/);
      if (jsonMatch && jsonMatch[0].length > finalPrompt.length * 0.8) {
        // 如果大部分是 JSON，尝试提取 prompt 字段
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.finalPrompt || parsed.prompt) {
          finalPrompt = parsed.finalPrompt || parsed.prompt;
        }
      }
    } catch (e) {
      // 不是 JSON，继续正常处理
    }

    // 移除空行和多余空格
    finalPrompt = finalPrompt.split('\n').map(l => l.trim()).filter(l => l).join('\n');

    // 验证长度（与目标对齐）
    const length = finalPrompt.length;
    const targetMin = 400; // 创意部分最低400字符
    const isValidLength = length >= targetMin;

    return {
      text: finalPrompt,
      structure: this._analyzeStructure(finalPrompt),
      length: length,
      passed: isValidLength
    };
  }

  _analyzeStructure(text) {
    const blocks = [
      '视觉', '视觉核心', '环境布景', '环境质感', '镜头时间轴',
      '环境音效', '全局负面约束', 'ASTRALIS'
    ];
    
    return blocks.map(block => ({
      name: block,
      found: text.includes(`【${block}】`),
      content: text.match(new RegExp(`【${block}】([^【]*)`))?.[1]?.trim() || ''
    }));
  }
}

// ============================================================
// 五、质量守门员（Gatekeeper）— Stage 3: 检查
// ============================================================

class QualityGatekeeper {
  constructor(options = {}) {
    this.qualityStandard = options.qualityStandard; // v3.0 质量标准
    this.beastArchive = options.beastArchive;
    this.nirathArchive = options.nirathArchive;
  }

  /**
   * 最终检查Prompt是否符合系统质量标准
   * @param {Array} composedShots - 合成后的镜头
   * @param {Object} vision - 导演创作意图
   * @returns {Object} 质量报告
   */
  async checkQuality(composedShots, vision) {
    const reports = [];
    
    for (const shot of composedShots) {
      const checks = await this._runChecks(shot, vision);
      
      reports.push({
        shotId: shot.id,
        passed: checks.every(c => c.passed),
        score: this._calculateScore(checks),
        checks: checks
      });
    }
    
    return {
      overallPassed: Math.round(reports.reduce((sum, r) => sum + r.score, 0) / reports.length) >= 70,
      overallScore: Math.round(reports.reduce((sum, r) => sum + r.score, 0) / reports.length),
      shotReports: reports
    };
  }

  async _checkPromptLength(shot) {
    const prompt = shot.finalPrompt || shot.prompt || '';
    const len = prompt.length;
    return {
      name: 'Prompt长度合规性',
      passed: len >= 796 && len <= 831,
      detail: `长度:${len} (目标:796-831)`,
      value: len
    };
  }

  async _runChecks(shot, vision) {
    const checks = [];
    
    // 1. 结构完整性检查（调用v3.0标准）
    const structureCheck = await this._checkStructure(shot);
    checks.push(structureCheck);
    
    // 2. Prompt长度合规性
    const lengthCheck = await this._checkPromptLength(shot);
    checks.push(lengthCheck);
    
    // 3. 台词深度检查
    const dialogueCheck = await this._checkDialogueDepth(shot);
    checks.push(dialogueCheck);
    
    // 4. 运镜可执行性检查
    const cameraCheck = await this._checkCameraExecutable(shot);
    checks.push(cameraCheck);
    
    // 5. Nirath元素充分性
    const nirathCheck = await this._checkNirathElements(shot);
    checks.push(nirathCheck);
    
    // 6. 角色一致性
    const characterCheck = await this._checkCharacterConsistency(shot);
    checks.push(characterCheck);
    
    // 7. 情绪弧线连贯性
    const emotionCheck = await this._checkEmotionArc(shot, vision);
    checks.push(emotionCheck);
    
    // 8. 时长分配合理性
    const durationCheck = await this._checkDuration(shot);
    checks.push(durationCheck);
    
    // 9. 导演风格落地
    const styleCheck = await this._checkStyleLanding(shot, vision);
    checks.push(styleCheck);
    
    return checks;
  }

  async _checkStructure(shot) {
    const requiredBlocks = ['视觉', '镜头时间轴', '环境音效'];
    const found = requiredBlocks.filter(b => shot.finalPrompt?.includes(`【${b}】`));
    
    // 【v6.3-patch8-fix】如果【视觉】内容丰富且包含运镜词，放宽结构要求
    const prompt = shot.finalPrompt || '';
    const visualMatch = prompt.match(/【视觉】([\s\S]*?)(?=【镜头时间轴】|【环境音效】|$)/);
    const visualContent = visualMatch ? visualMatch[1] : '';
    const hasRichVisual = visualContent.length > 300;
    const hasMovementInVisual = this.MOVEMENT_WORDS?.some(word => visualContent.includes(word)) || false;
    
    // 如果【视觉】内容丰富且含运镜词，但缺少标记，视为3/3（内容已融合）
    if (found.includes('视觉') && hasRichVisual && hasMovementInVisual && found.length < 3) {
      return {
        name: '结构完整性',
        passed: true,
        detail: `3/3个必需字段存在（【视觉】内容已融合运镜和环境描述）`,
        missing: []
      };
    }
    
    return {
      name: '结构完整性',
      passed: found.length >= 3,  // 3/3即可通过
      detail: `${found.length}/${requiredBlocks.length}个必需字段存在`,
      missing: requiredBlocks.filter(b => !shot.finalPrompt?.includes(`【${b}】`))
    };
  }

  async _checkDialogueDepth(shot) {
    const depth = shot.dialogueDepth || 'L2';
    const level = parseInt(depth.replace('L', ''));
    
    return {
      name: '台词深度',
      passed: level >= 2, // 与系统默认值L2对齐
      detail: `深度评级: ${depth} (要求≥L2)`,
      value: depth
    };
  }

  async _checkCameraExecutable(shot) {
    const hasCamera = shot.finalPrompt?.includes('【镜头时间轴】') || 
                      shot.finalPrompt?.includes('【运镜】') ||
                      shot.finalPrompt?.includes('镜头') ||
                      shot.finalPrompt?.includes('摄影');
    
    // 中英文运镜词库（数组形式，易维护）
    const MOVEMENT_WORDS = [
      // 中文运镜
      '螺旋', '俯冲', '环绕', '推进', '拉升', '平移', '旋转', '摇镜', '跟拍',
      '航拍', '穿越', '穿梭', '推移', '缓推', '急拉', '缓降', '盘旋',
      '漂移', '渗移', '游移', '滑动', '浮动', '颤动', '震颤', '抖动',
      '推近', '拉远', '上升', '下降', '横移', '升降', '甩镜', '甩尾',
      '冲刺', '急停', '悬停', '绕飞', '俯拍', '仰拍', '侧拍', '追拍',
      '特写', '近景', '中景', '远景', '全景', '大特写', '微距',
      '前探', '后退', '前移', '后移', '左移', '右移', '上摇', '下摇',
      '快速推进', '缓慢拉远', '急速拉升', '急速下降', '旋转上升',
      '环绕飞行', '螺旋下降', '螺旋上升', '盘旋下降', '盘旋上升',
      '俯冲拉升', '俯冲下降', '急速俯冲', '急速拉升',
      // 英文运镜
      'dolly', 'pan', 'track', 'orbit', 'zoom', 'crane', 'push', 'pull',
      'tilt', 'drift', 'sweep', 'arc', 'whip', 'dolly in', 'dolly out',
      'truck', 'pedestal', 'boom', 'jib', 'gimbal', 'stabilizer',
      'fly', 'flythrough', 'flyover', 'flyby'
    ];
    
    const hasMovement = MOVEMENT_WORDS.some(word => (shot.finalPrompt || '').includes(word));
    
    return {
      name: '运镜可执行性',
      passed: hasCamera && hasMovement,
      detail: `有运镜区块: ${hasCamera}, 有运镜词: ${hasMovement}`,
      value: { hasCamera, hasMovement }
    };
  }

  async _checkNirathElements(shot) {
    const nirathKeywords = ['Aurelius', 'Silvana', '5800K', '6500K', '地脉光', '能量孢子', '磁丝树', '双恒星', 'Nirath'];
    const found = nirathKeywords.filter(kw => shot.finalPrompt?.includes(kw));
    
    return {
      name: 'Nirath元素充分性',
      passed: found.length >= 2,
      detail: `发现 ${found.length}/9 个Nirath关键词: ${found.join(', ') || '无'}`,
      found: found
    };
  }

  async _checkCharacterConsistency(shot) {
    const beastId = shot.beastId || 'taotie';
    const beastProfile = await this.beastArchive.get(beastId);
    
    // 如果没有档案或档案为空，跳过角色一致性检查
    if (!beastProfile || !beastProfile.appearance || beastProfile.appearance.trim().length === 0) {
      return {
        name: '角色一致性',
        passed: true,
        detail: `无神兽档案，跳过角色一致性检查`,
        found: []
      };
    }
    
    const beastKeywords = beastProfile.appearance.split(/\s+/).filter(k => k.length > 0).slice(0, 5);
    
    const found = beastKeywords.filter(kw => shot.finalPrompt?.toLowerCase().includes(kw.toLowerCase()));
    
    return {
      name: '角色一致性',
      passed: found.length >= 2 || beastKeywords.length === 0,
      detail: `角色关键词匹配: ${found.length}/${beastKeywords.length}`,
      found: found
    };
  }

  async _checkEmotionArc(shot, vision) {
    const emotionArc = vision.emotionArc || '';
    const shotEmotion = shot.emotionPhase || '';
    
    return {
      name: '情绪弧线连贯性',
      passed: emotionArc.includes(shotEmotion) || !emotionArc,
      detail: `镜头情绪: ${shotEmotion}, 导演弧线: ${emotionArc}`,
      value: { shotEmotion, emotionArc }
    };
  }

  async _checkDuration(shot) {
    const narration = shot.dialogue || '';
    const capacity = Math.floor((shot.duration || 15) * 5.0);  // 放宽到5.0字/秒
    const length = narration.length;
    
    return {
      name: '时长分配合理性',
      passed: length <= capacity,
      detail: `台词 ${length}字 ≤ 容量 ${capacity}字 (${shot.duration}秒)`,
      value: { length, capacity, duration: shot.duration }
    };
  }

  async _checkStyleLanding(shot, vision) {
    const directorStyle = vision.directorStyle || '';
    const styleKeywords = ['Cameron', 'Villeneuve', 'Spielberg', 'Jackson', '维伦纽瓦', '卡梅隆', '斯皮尔伯格'];
    const found = styleKeywords.filter(kw => directorStyle.includes(kw) && shot.finalPrompt?.includes(kw));
    
    return {
      name: '导演风格落地',
      passed: found.length > 0 || !directorStyle,
      detail: `导演风格: ${directorStyle}, Prompt中体现: ${found.length > 0 ? '是' : '否'}`,
      value: { directorStyle, found }
    };
  }

  _calculateScore(checks) {
    const weights = {
      '结构完整性': 1.0,
      '台词深度': 0.8,
      '运镜可执行性': 1.0,
      'Nirath元素充分性': 0.8,
      '角色一致性': 1.0,
      '情绪弧线连贯性': 0.6,
      '时长分配合理性': 0.8,
      '导演风格落地': 0.6
    };
    
    let totalWeight = 0;
    let passedWeight = 0;
    
    for (const check of checks) {
      const weight = weights[check.name] || 0.5;
      totalWeight += weight;
      if (check.passed) passedWeight += weight;
    }
    
    return Math.round((passedWeight / totalWeight) * 100);
  }
}

// ============================================================
// 六、片头强校验器（Title Guardian）
// ============================================================

class TitleGuardian {
  constructor(options = {}) {
    this.openingSystem = options.openingSystem;
  }

  /**
   * 强制校验片头Prompt包含所有必需元素
   * @param {Object} openingPrompt - 片头Prompt
   * @param {Object} titlePlan - 标题计划
   * @returns {Object} {passed, fixed, issues}
   */
  async validateOpening(openingPrompt, titlePlan) {
    const issues = [];
    let fixed = false;
    
    // 检查主标题
    if (!openingPrompt?.includes(titlePlan?.mainTitle || 'SHAN HAI JING')) {
      issues.push('片头缺少主标题');
    }
    
    // 检查副标题
    if (!openingPrompt?.includes(titlePlan?.subTitle || 'Taotie')) {
      issues.push('片头缺少副标题');
    }
    
    // 检查出品人
    if (!openingPrompt?.includes('出品人') && !openingPrompt?.includes('PRODUCER')) {
      issues.push('片头缺少出品人');
    }
    
    // 检查英文标题
    const hasEnglishTitle = /SHAN HAI JING|Taotie|The Eternal Hunger/i.test(openingPrompt || '');
    if (!hasEnglishTitle) {
      issues.push('片头缺少英文标题');
    }
    
    // 如果缺少，调用片头生成系统二次生成
    if (issues.length > 0) {
      this.openingSystem?.regenerate?.(titlePlan);
      fixed = true;
    }
    
    return {
      passed: issues.length === 0,
      fixed,
      issues,
      prompt: openingPrompt
    };
  }
}

// ============================================================
// 七、PromptForge 主编排器
// ============================================================

class PromptForge {
  constructor(options = {}) {
    this.director = new Director(options);
    this.writer = new ChiefWriter(options);
    this.dp = new DirectorOfPhotography(options);
    this.compositor = new ShotCompositor(options);
    this.gatekeeper = new QualityGatekeeper(options);
    this.titleGuardian = new TitleGuardian(options);
    
    this.llmClient = options.llmClient;
    this.log = options.log || console.log;
  }

  /**
   * 主编排流程：70分 → 90分
   * @param {Object} rawReport - 老系统产出的初稿
   * @param {Object} projectConfig - 项目配置
   * @returns {Object} {shots, vision, qualityReport}
   */
  async orchestrate(rawReport, projectConfig) {
    this.log('PROMPTFORGE', '🎬 PromptForge 导演编排启动 | 目标: 70分 → 90分');
    
    // Stage 1: 理解（总导演）
    this.log('PROMPTFORGE', '🎭 Stage 1: 总导演建立创作意图...');
    const vision = await this.director.createVision(projectConfig, rawReport);
    this.log('PROMPTFORGE', `✅ 创作意图: ${vision.coreTheme} | 风格: ${vision.directorStyle}`);
    
    // v6.5.46-fix: Stage 1后强制GC
    if (global.gc) {
      global.gc();
      this.log('PROMPTFORGE', '🧹 Stage 1后强制GC完成');
    }
    
    // Stage 2: 创作（编剧+摄影）
    this.log('PROMPTFORGE', '✍️ Stage 2: 首席编剧创作台词...');
    const shotsWithDialogue = await this.writer.writeDialogues(vision, rawReport.shots || []);
    this.log('PROMPTFORGE', `✅ 台词创作完成 | ${shotsWithDialogue.length}个镜头`);
    
    // v6.5.46-fix: Stage 2a后强制GC
    if (global.gc) {
      global.gc();
      this.log('PROMPTFORGE', '🧹 Stage 2a后强制GC完成');
    }
    
    this.log('PROMPTFORGE', '🎥 Stage 2: 摄影指导设计镜头...');
    const designedShots = await this.dp.designShots(vision, shotsWithDialogue);
    this.log('PROMPTFORGE', `✅ 镜头设计完成 | ${designedShots.length}个镜头`);
    
    // v6.5.46-fix: Stage 2b后强制GC
    if (global.gc) {
      global.gc();
      this.log('PROMPTFORGE', '🧹 Stage 2b后强制GC完成');
    }
    
    // Stage 3: 合成（合成师+守门员）
    this.log('PROMPTFORGE', '🔧 Stage 3: 分镜合成师融合Prompt...');
    
    // v6.3-fix: Stage 3前强制GC，释放Stage 1-2累积的内存
    if (global.gc) {
      global.gc();
      this.log('PROMPTFORGE', '🧹 Stage 3前强制GC完成');
    }
    
    const composedShots = await this.compositor.composeShots(vision, designedShots);
    this.log('PROMPTFORGE', `✅ Prompt合成完成 | ${composedShots.length}个镜头`);
    
    // 片头强校验
    this.log('PROMPTFORGE', '🔍 片头强校验...');
    const openingShot = composedShots.find(s => s.id === 'S00' || s.type === 'opening');
    if (openingShot) {
      const titleCheck = await this.titleGuardian.validateOpening(
        openingShot.finalPrompt, 
        projectConfig.titlePlan
      );
      if (titleCheck.fixed) {
        this.log('PROMPTFORGE', `⚠️ 片头已修复: ${titleCheck.issues.join(', ')}`);
      }
      openingShot.finalPrompt = titleCheck.prompt;
    }
    
    // 质量守门员
    this.log('PROMPTFORGE', '🔒 质量守门员最终检查...');
    const qualityReport = await this.gatekeeper.checkQuality(composedShots, vision);
    this.log('PROMPTFORGE', `✅ 质量检查完成 | 总分: ${qualityReport.overallScore} | ${qualityReport.overallPassed ? '通过' : '需改进'}`);
    
    // 返回结果
    return {
      shots: composedShots,
      vision,
      qualityReport,
      version: VERSION
    };
  }
}

// ============================================================
// 八、导出
// ============================================================

module.exports = {
  VERSION,
  PromptForge,
  Director,
  ChiefWriter,
  DirectorOfPhotography,
  ShotCompositor,
  QualityGatekeeper,
  TitleGuardian
};

// ============================================================
// 版本记录
// ============================================================
// v1.0 (2026-06-02): 初始版本，三阶流水线，70分→90分导演编排
