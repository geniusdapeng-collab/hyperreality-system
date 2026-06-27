// ContinuityReviewAgent 孤立测试
// 验证 Agent 是否能正常处理 5 个镜头

const { ContinuityReviewAgent } = require('./engines/production-engine/agents/continuity-review-agent');

async function test() {
  console.log('=== ContinuityReviewAgent 孤立测试 ===\n');

  const agent = new ContinuityReviewAgent({
    llmModel: 'kimi-k2p6',
    llmTimeout: 180000,
    llmMaxTokens: 8000,
    enabled: true
  });

  // 模拟 5 个镜头（简化版）
  const shots = [
    { shotId: 'SC01', duration: 10, scene: '深灰色墙面，导演椅', mood: 'epic mysterious awe-inspiring', action: 'adjusts glasses, looks at camera' },
    { shotId: 'SC02', duration: 10, scene: '深色办公桌前，显示器', mood: 'mysterious anticipation wonder', action: 'gestures toward screen' },
    { shotId: 'SC03', duration: 12, scene: '中景，站起身，OLED屏幕', mood: 'awe-inspiring wonder', action: 'pauses, turns back' },
    { shotId: 'SC04', duration: 14, scene: '白色瓷砖，不锈钢工作台', mood: 'curious anticipation', action: 'walks around table' },
    { shotId: 'SC05', duration: 14, scene: '清水混凝土墙面，超写实Logo', mood: 'awe-inspiring triumph', action: 'spreads arms' }
  ];

  const blueprint = {
    config: { _metadata: { series: { totalEpisodes: 1, currentEpisode: 1 } } },
    characters: [{ name: '李大鹏', role: 'protagonist' }]
  };

  console.log('输入镜头数:', shots.length);
  console.log('Agent 名称:', agent.name);
  console.log('Agent 启用:', agent.enabled);
  console.log('LLM 超时:', agent.llmTimeout);
  console.log('全局截止时间:', agent._globalDeadline);
  console.log('');

  try {
    console.log('[TEST] 调用 process...');
    const start = Date.now();
    const result = await agent.process(shots, blueprint, { totalEpisodes: 1, episodeIndex: 1 });
    const elapsed = Date.now() - start;
    console.log(`\n[TEST] process 完成，耗时 ${elapsed}ms`);
    console.log('[TEST] 结果:', JSON.stringify(result, null, 2).substring(0, 500));
  } catch (err) {
    console.error('[TEST] process 抛出异常:', err.message);
    console.error(err.stack);
  }
}

test().catch(e => {
  console.error('顶层错误:', e);
  process.exit(1);
});
