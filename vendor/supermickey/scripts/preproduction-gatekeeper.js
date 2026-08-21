/**
 * 预生产人工确认检查点 - 防跳过机制
 * 
 * 规则：
 * 1. 系统生成 .md 确认文件后，必须等待用户回复"确认"/"OK"才能创建 .json
 * 2. 任何情况下，AI 不得擅自读取 .md 内容并自行判断"应该可以确认"
 * 3. 如果用户未回复，流程必须暂停，不得继续
 * 
 * 这是硬规则，不是建议。违反视为流程失效。
 */

const fs = require('fs');
const path = require('path');

const CONFIRMATIONS_DIR = path.join(__dirname, '..', 'hyperreality-system', 'output', 'confirmations');

/**
 * 检查指定步骤是否需要用户确认
 * @param {string} step - 步骤名称: creative-theme | requirement | prd | prompt
 * @returns {Object} { needsApproval: boolean, reason: string }
 */
function checkApprovalStatus(step) {
  const mdFile = path.join(CONFIRMATIONS_DIR, `confirmation-${step}.md`);
  const jsonFile = path.join(CONFIRMATIONS_DIR, `confirmation-${step}.json`);
  
  // 情况1: .md 不存在 → 系统还没生成，不需要确认
  if (!fs.existsSync(mdFile)) {
    return { needsApproval: false, reason: '确认文件尚未生成' };
  }
  
  // 情况2: .md 存在但 .json 不存在 → 需要用户确认
  if (!fs.existsSync(jsonFile)) {
    return { 
      needsApproval: true, 
      reason: `confirmation-${step}.md 已生成，等待用户确认`,
      mdPath: mdFile
    };
  }
  
  // 情况3: 两者都存在 → 已确认
  return { needsApproval: false, reason: '已确认' };
}

/**
 * 获取所有步骤的确认状态
 */
function getAllApprovalStatus() {
  const steps = ['creative-theme', 'requirement', 'prd', 'prompt'];
  return steps.map(step => ({
    step,
    ...checkApprovalStatus(step)
  }));
}

/**
 * 断言：当前步骤必须通过用户确认
 * 如果未确认，抛出错误阻止流程继续
 */
function assertApproved(step) {
  const status = checkApprovalStatus(step);
  if (status.needsApproval) {
    throw new Error(
      `⛔ 流程阻断: Step "${step}" 需要人工确认\n` +
      `确认文件: ${status.mdPath}\n` +
      `操作: 请用户查看确认文件并回复"确认"或"OK"\n` +
      `注意: AI 不得擅自创建 confirmation-${step}.json`
    );
  }
}

module.exports = {
  checkApprovalStatus,
  getAllApprovalStatus,
  assertApproved,
  CONFIRMATIONS_DIR
};

// 如果直接运行，打印当前状态
if (require.main === module) {
  console.log('=== 预生产确认状态检查 ===\n');
  const statuses = getAllApprovalStatus();
  for (const s of statuses) {
    const icon = s.needsApproval ? '⏳' : fs.existsSync(path.join(CONFIRMATIONS_DIR, `confirmation-${s.step}.json`)) ? '✅' : '⬜';
    console.log(`${icon} ${s.step}: ${s.reason}`);
  }
}
