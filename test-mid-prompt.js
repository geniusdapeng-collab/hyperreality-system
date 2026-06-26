// 测试中等长度prompt
const { LLMEngine } = require('../systems/llm-reasoning-engine');

async function test() {
  const engine = new LLMEngine({model: 'kimi-k2p6', timeoutMs: 120000});
  
  const prompt = `你是一位顶级短视频编剧。为"超写实系统宣传片"创作60秒剧本。

## 项目信息
- 标题：超写实系统宣传片
- 时长：60秒
- 主角：李大鹏（创始人）
- 风格：科技感、电影质感

## 用户痛点（必须从这些问题出发）
1. 写Prompt像写天书，3个月学不明白
2. 外包做视频10万预算，效果还差
3. 等3个月才出片，商机都错过了
4. 渲染出来的角色手指残缺、脸是歪的

## 反身性彩蛋
片尾要点出：本片也由超写实系统生成

## 输出要求
输出JSON格式：
{
  "title": "标题",
  "scenes": [
    {
      "id": "SC01",
      "content": "场景描述",
      "duration": 10,
      "dialogue": [{"speaker": "李大鹏", "text": "台词"}]
    }
  ]
}

要求：
- 5-7个场景
- 总时长=60秒
- 每句台词≤30字
- 只输出JSON，不要其他文字`;

  console.log('[TEST] Prompt长度:', prompt.length);
  console.log('[TEST] 中等长度prompt测试...');
  
  try {
    const start = Date.now();
    const result = await engine.generate(prompt, {
      maxTokens: 8192,
      timeoutMs: 120000,
      forceJson: true,
      allowReasoningFallback: false
    });
    console.log('[TEST] 成功！耗时:', (Date.now()-start)/1000, '秒');
    console.log('[TEST] content长度:', result.content?.length || 0);
    console.log('[TEST] content前300字符:', result.content?.substring(0, 300));
  } catch (err) {
    console.error('[TEST] 错误:', err.message);
  }
}

test();
