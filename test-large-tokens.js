// 测试大maxTokens是否导致延迟
const { LLMEngine } = require('../systems/llm-reasoning-engine');

async function test() {
  const engine = new LLMEngine({
    model: 'kimi-k2p6',
    timeoutMs: 120000
  });
  
  // 模拟ScriptGenerator的prompt
  const prompt = `你是一位顶级短视频编剧，专门为AI视频生成系统创作结构化剧本。

## 任务
为以下项目创作完整的结构化剧本，输出必须是严格的 JSON 格式。

## 项目信息
- 标题：超写实系统宣传片
- 叙事类型：dramatic
- 目标时长：60秒
- 主角：李大鹏
- 平台：官网, 社交媒体
- 语言：zh

## 系统约束（不可违反）
1. 禁止旁白（Voiceover），只保留角色对话（Dialogue）
2. 每个场景必须有角色对话（台词）
3. 台词必须口语化，适合短视频节奏（每句不超过30字）
4. 场景时长分配：根据内容重要性、台词长度、视觉复杂度三维度分配
5. 总时长必须严格等于 60 秒

## 输出格式要求
你必须输出一个严格的 JSON 对象，包含title, acts, scenes等字段。

请直接输出JSON，不要任何其他文字。`;

  console.log('[TEST] Prompt长度:', prompt.length);
  console.log('[TEST] 使用maxTokens=32000调用...');
  
  try {
    const start = Date.now();
    const result = await engine.generate(prompt, {
      systemPrompt: '你是一位专业的AI视频编剧。只输出严格格式的JSON。',
      maxTokens: 32000,
      timeoutMs: 120000,
      forceJson: true,
      allowReasoningFallback: false
    });
    console.log('[TEST] 成功！耗时:', (Date.now()-start)/1000, '秒');
    console.log('[TEST] content长度:', result.content?.length || 0);
  } catch (err) {
    console.error('[TEST] 错误:', err.message);
  }
}

test();
