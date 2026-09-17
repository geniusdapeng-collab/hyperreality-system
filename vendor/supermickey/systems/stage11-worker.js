/**
 * Stage 11 Worker - 子进程隔离渲染
 * v6.6.0-P2: 每个 shot 独立子进程，OS级内存回收
 */

const fs = require('fs');
const path = require('path');

// 从父进程接收任务
process.on('message', async (task) => {
  const { shotId, shotData, outputDir } = task;
  
  try {
    // 模拟渲染工作（实际应调用真实渲染逻辑）
    // 这里只做内存密集型操作的代表
    const result = {
      shotId,
      prompt: shotData.prompt || '',
      timestamp: Date.now(),
      memory: process.memoryUsage(),
    };
    
    // 写入增量结果
    const jsonlPath = path.join(outputDir, 'stage11-shots.jsonl');
    fs.appendFileSync(jsonlPath, JSON.stringify(result) + '\n', 'utf8');
    
    // 通知父进程完成
    process.send({ type: 'done', shotId, result });
    
    // 主动退出，释放内存
    process.exit(0);
  } catch (err) {
    process.send({ type: 'error', shotId, error: err.message });
    process.exit(1);
  }
});

// 超时保护（60秒）
setTimeout(() => {
  console.error('[Worker] Timeout, force exit');
  process.exit(2);
}, 60000);
