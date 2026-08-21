const { BaseAgent } = require('../../production-engine/agents/base-agent');

/**
 * Agent 2: CreativeDirectionAgent
 * 创意方向 Agent - 核心 LLM Agent
 * 职责：进行视角转换，从业务需求语言提炼产品制作语言
 * 耗时：30-60s
 */
class CreativeDirectionAgent extends BaseAgent {
  constructor(options = {}) {
    super(options);
    this.agentName = 'CreativeDirectionAgent';
    this.timeoutMs = options.timeoutMs || 120000; // 2 分钟
  }

  async process(discoveryResult) {
    // 保存 discoveryResult 供 _parseResult 使用
    this._lastDiscoveryResult = discoveryResult;
    const prompt = this._buildPrompt(discoveryResult);
    
    try {
      // 【审计修复】三处问题：
      // 1. 原调用把 { timeout } 当成 schema 传入, 会被注入提示词成为"目标JSON结构示例", 污染生成;
      // 2. timeout 应通过第4参数 options.timeoutMs 下发, 原写法自定义超时不生效;
      // 3. _callLLM 返回包装对象 { result, degraded, ... }, 真实数据在 .result 字段,
      //    原写法直接解析包装对象, LLM 创意产出 100% 被静默丢弃, 永远走模板兜底。
      const schema = {
        required: ['coreTheme', 'creativeHook', 'emotionalArc', 'keyMessages', 'endingType']
      };
      const llmResult = await this._callLLM(prompt, schema, null, { timeoutMs: this.timeoutMs });
      const data = (llmResult && typeof llmResult === 'object' && 'result' in llmResult)
        ? llmResult.result : llmResult;
      if (data === null || data === undefined) {
        console.warn(`[${this.agentName}] LLM 返回为空，使用 fallback`);
        return this.fallback(discoveryResult);
      }
      return this._parseResult(typeof data === 'string' ? data : JSON.stringify(data));
    } catch (error) {
      console.warn(`[${this.agentName}] LLM 调用失败: ${error.message}，使用 fallback`);
      return this.fallback(discoveryResult);
    }
  }

  _buildPrompt(discoveryResult) {
    const { upstreamFields, audienceProfile, sceneStructure, referenceCases, userModifications } = discoveryResult;
    
    const userModificationsSection = (userModifications && userModifications.length > 0)
      ? `\n【用户修改意见】\n${userModifications.map((m, i) => `${i + 1}. ${m}`).join('\n')}\n\n以上修改意见必须体现在创意核心中。`
      : '';
    
    // ⭐ v2.2.1-fix: 注入用户原始故事文本，供导演视角提炼参考
    const originalStory = discoveryResult._originalStoryText || discoveryResult.original_story_text || '';
    const originalStorySection = originalStory
      ? `\n【用户原始输入（创作素材源）】\n${originalStory}\n\n以上原始素材是用户提供的完整故事，请从中提炼核心意象、钉子台词、情感锚点，转化为导演视角的创意语言。`
      : '';
    
    return `你是一位资深视频导演/制片人，正在将客户的业务需求转化为产品制作需求。

【业务需求输入】
视频类型: ${upstreamFields.type || '通用'}
核心主题: ${upstreamFields.theme || '未指定'}
情绪基调: ${upstreamFields.tone || '中性'}
视觉风格: ${upstreamFields.visual_style || '未指定'}
主题描述: ${upstreamFields.description || upstreamFields.theme || '未指定'}

【受众洞察】
主要受众: ${audienceProfile?.primaryAudience?.ageRange || '25-30'}岁，${audienceProfile?.primaryAudience?.gender || 'all'}
兴趣标签: ${(audienceProfile?.primaryAudience?.interestTags || []).join(', ')}
情绪触发点: ${(audienceProfile?.emotionTriggers || []).join(', ')}
内容期望: ${(audienceProfile?.contentExpectations || []).join(', ')}

【场景结构】
叙事弧线: ${sceneStructure?.narrativeArc || 'setup→rising→climax→falling→resolution'}
场景数: ${sceneStructure?.sceneCount || '3'}
总时长: ${sceneStructure?.totalDuration || upstreamFields.duration_sec || '52'}秒

【参考案例】
参考影片: ${(referenceCases?.filmReferences || []).map(f => f.title || f).join(', ')}

请输出 JSON 格式的创意核心（不要添加任何解释文本，只输出 JSON）：

{
  "coreTheme": "核心主题（20-100字，导演视角的提炼，不是业务描述）",
  "creativeHook": "创意钩子（20-100字，必须包含'前3秒抓眼策略'和'为什么观众会被吸引'）",
  "emotionalArc": "setup→rising→climax→falling→resolution",
  "keyMessages": ["核心信息1（5-50字，标注优先级如P0）", "核心信息2"],
  "twistPoint": "反转/高潮点（可选，如没有则填空字符串）",
  "endingType": "开放式|闭合式|悬念式|升华式|反转式"
}

严格要求：
1. coreTheme 必须是导演视角的提炼，不是业务描述。例如不是"关于火星救援的故事"，而是"孤独与希望的对抗：一个被遗弃的星球上，人类用科学对抗绝望"
2. creativeHook 必须包含前3秒抓眼策略（如"第一帧即悬念"、"强烈视觉冲击开场"）
3. keyMessages 1-4个，每个5-50字，至少标注一个P0级
4. emotionalArc 必须从以下枚举选择：setup→rising→climax→falling→resolution, setup→rising→climax→resolution, setup→climax→resolution, loop, flat→peak→flat
5. endingType 必须从枚举选择：开放式, 闭合式, 悬念式, 升华式, 反转式
6. 所有字段必须存在，不能为 null
7. 时间线完整性：如果主题涉及"发展"、"历史"、"演变"、"变迁"等时间跨度概念，必须覆盖完整历史时间线（从最早的起源/起源事件开始，而非默认从1949年或现代开始）。例如"中国铁路发展"必须从晚清/京张铁路/詹天佑等起源讲起，而非仅从1949年开始
8. 只输出 JSON，不要任何 markdown 代码块标记，不要解释文本${originalStorySection}${userModificationsSection}

【导演心法——你必须遵守的提炼标准】
1. coreTheme 是导演视角的一句话哲学，结构为'悖论+具象'：不是'关于祇园祭绳结的故事'，而是'柔软的东西比坚硬的更长久：一根绳结 vs 一辆没有钉子的十七米木车'。写完自检：这句话能不能印在海报上？不能就重写。
2. creativeHook 必须含'第一帧画面'+'观众脑子里冒出的那个问题'：好钩子让观众自己提问（'他还能撑住吗'），坏钩子替观众回答。
3. twistPoint 找'绝境处显形'的瞬间：所有人以为主角不行了，他做出一个违背预期的动作——反转不是情节诡计，是人物深处的力量被看见。
4. keyMessages 的 P0 必须能用一句钉子台词说出来，且这句台词要'具体到只有这个故事能讲'（'钉子会锈，绳结会记住手心的汗'），禁止放之四海皆准的鸡汤。
5. 【用户原始输入】是最高事实源：原文的台词、特写、物理细节一字不减地融进你的提炼，禁止用抽象概括覆盖原文细节。`;
  }

  _parseResult(result) {
    try {
      // 如果 result 是对象，尝试转换为字符串
      if (typeof result !== 'string') {
        result = typeof result === 'object' ? JSON.stringify(result) : String(result);
      }
      
      // 清理可能的 markdown 代码块
      let clean = result.trim();
      if (clean.startsWith('```json')) clean = clean.slice(7);
      if (clean.startsWith('```')) clean = clean.slice(3);
      if (clean.endsWith('```')) clean = clean.slice(0, -3);
      clean = clean.trim();
      
      const parsed = JSON.parse(clean);
      
      // 【修复】字段缺失自动补全，不再抛错误
      const upstreamTheme = this._lastDiscoveryResult?.upstreamFields?.theme || '未指定主题';
      const upstreamType = this._lastDiscoveryResult?.upstreamFields?.type || '通用';
      const upstreamTone = this._lastDiscoveryResult?.upstreamFields?.tone || '中性';
      
      // 必填字段兜底
      if (!parsed.coreTheme || parsed.coreTheme === '待补充核心主题') {
        parsed.coreTheme = `${upstreamTheme}：在${upstreamType}背景下，探索人性与环境的对抗`;
        console.warn(`[${this.agentName}] ⚠️ coreTheme 缺失，自动补全: ${parsed.coreTheme.substring(0, 40)}...`);
      }
      if (!parsed.creativeHook) {
        parsed.creativeHook = `前3秒以强烈视觉冲击开场，迅速建立${upstreamTone}氛围，吸引观众注意力`;
        console.warn(`[${this.agentName}] ⚠️ creativeHook 缺失，自动补全`);
      }
      if (!parsed.emotionalArc) {
        parsed.emotionalArc = 'setup→rising→climax→falling→resolution';
        console.warn(`[${this.agentName}] ⚠️ emotionalArc 缺失，使用默认值`);
      }
      if (!parsed.keyMessages || !Array.isArray(parsed.keyMessages) || parsed.keyMessages.length === 0) {
        parsed.keyMessages = [`P0: ${upstreamTheme}的核心情感体验`];
        console.warn(`[${this.agentName}] ⚠️ keyMessages 缺失，自动补全`);
      }
      if (parsed.twistPoint === undefined || parsed.twistPoint === null) {
        parsed.twistPoint = '';
      }
      if (!parsed.endingType) {
        parsed.endingType = '闭合式';
        console.warn(`[${this.agentName}] ⚠️ endingType 缺失，使用默认值`);
      }
      
      // 确保 keyMessages 是数组
      if (!Array.isArray(parsed.keyMessages)) {
        parsed.keyMessages = [String(parsed.keyMessages)];
      }
      
      // 限制 keyMessages 长度
      parsed.keyMessages = parsed.keyMessages.slice(0, 4);
      
      return { creativeCore: parsed };
    } catch (error) {
      console.error(`[${this.agentName}] 解析失败: ${error.message}`);
      throw error;
    }
  }

  // Fallback：当 LLM 超时或失败时使用
  fallback(discoveryResult) {
    const { upstreamFields, sceneStructure } = discoveryResult;
    const theme = upstreamFields.theme || '未指定主题';
    const tone = upstreamFields.tone || '中性';
    
    // 构建简单的创意核心
    const coreTheme = `${theme}：在${upstreamFields.type || '通用'}背景下，探索人性与环境的对抗`;
    const creativeHook = `前3秒以强烈视觉冲击开场，迅速建立${tone}氛围，吸引观众注意力`;
    
    const emotionalArcMap = {
      '紧张': 'setup→rising→climax→falling→resolution',
      '悲伤': 'flat→peak→flat',
      '欢快': 'setup→climax→resolution',
      '悬疑': 'setup→rising→climax→falling→resolution',
      '中性': 'setup→rising→climax→falling→resolution'
    };
    
    const endingTypeMap = {
      '紧张': '闭合式', '悲伤': '开放式', '欢快': '闭合式', '悬疑': '悬念式', '中性': '闭合式'
    };
    
    return {
      creativeCore: {
        coreTheme: coreTheme.slice(0, 100),
        creativeHook: creativeHook.slice(0, 100),
        emotionalArc: emotionalArcMap[tone] || 'setup→rising→climax→falling→resolution',
        keyMessages: [`P0: ${theme}的核心价值`, `P1: 视觉体验`],
        twistPoint: '',
        endingType: endingTypeMap[tone] || '闭合式'
      }
    };
  }
}

module.exports = { CreativeDirectionAgent };
