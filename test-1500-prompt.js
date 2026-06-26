// 测试1500字符prompt
const { LLMEngine } = require('../systems/llm-reasoning-engine');

async function test() {
  const engine = new LLMEngine({model: 'kimi-k2p6', timeoutMs: 300000});
  
  const prompt = `你是一位顶级短视频编剧。为"超写实系统宣传片"创作60秒剧本。

## 项目信息
- 标题：超写实系统宣传片
- 时长：60秒
- 主角：李大鹏（创始人，38岁，千问AI产品经理，Coding之神追求者）
- 风格：科技感、电影质感、专业可信
- 平台：官网、社交媒体
- 目标受众：中小企业主、创意工作者、AI视频创作者

## 核心叙事策略（用户视角优先 - P0级规则）
不是讲"我们有什么功能"，而是讲"你再也不用忍受什么"。
必须从用户真实痛点出发，用具体数字说话。

## 用户痛点（必须深入展现）
1. 写Prompt像写天书，3个月学不明白，试了100次还是垃圾输出
2. 外包做视频10万预算，效果还差，改到第20版还是不满意，钱打了水漂
3. 等3个月才出片，商机都错过了，竞品早就跑远了，黄花菜都凉了
4. 渲染出来的角色手指残缺、脸是歪的、背景穿帮，根本没法商用

## 解决方案（轻描淡写，不要罗列功能）
- 一句话描述你的创意，系统自动生成导演级视频
- 成本从10万降到500元（降低200倍）
- 时间从3个月缩到10分钟（缩短13000倍）
- 质量稳定，角色一致，每次输出都是电影级

## 反身性彩蛋（片尾必须）
片尾要点出：本片也由超写实系统生成

## 情绪曲线设计
压抑（痛点共鸣）→ 希望（解决方案）→ 震撼（数字冲击）→ 行动号召（立即体验）

## 输出格式
输出JSON：
{
  "title": "标题",
  "scenes": [
    {
      "id": "SC01",
      "content": "场景描述（包含画面、运镜、情绪、视觉风格）",
      "duration": 10,
      "dialogue": [{"speaker": "李大鹏", "text": "台词（口语化，不超过30字）"}],
      "emotion": "情绪标签"
    }
  ]
}

要求：
- 5-7个场景
- 总时长=60秒
- 每句台词≤30字
- 必须有反身性彩蛋场景
- 只输出JSON，不要其他文字`;

  console.log('[TEST] Prompt长度:', prompt.length);
  console.log('[TEST] 1500字符prompt测试...');
  
  try {
    const start = Date.now();
    const result = await engine.generate(prompt, {
      maxTokens: 8192,
      timeoutMs: 300000,
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
