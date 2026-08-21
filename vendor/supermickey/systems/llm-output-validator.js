// systems/llm-output-validator.js
// v6.3-patch5-expert-fix: LLM输出可用性检查，API成功≠输出可用

'use strict';

/**
 * 不同Agent的必填字段定义
 */
const REQUIRED_FIELDS = {
  director: ['score', 'issues', 'strengths', 'rewritePlan', 'finalAdvice'],
  screenwriter: ['dialoguePlan', 'emotionBeats', 'lineNotes'],
  camera: ['shotPlan', 'timeline', 'cameraNotes'],
  compositor: ['finalPrompt', 'usedBlocks', 'droppedBlocks'],
  reviewer: ['passed', 'issues', 'score']
};

/**
 * 禁用格式检查
 */
const FORBIDDEN_PATTERNS = [
  { pattern: /```/, desc: 'markdown代码块' },
  { pattern: /以下是/, desc: '解释性前言' },
  { pattern: /undefined/, desc: 'undefined文本' },
  { pattern: /\bnull\b/, desc: 'null文本' },
  { pattern: /未指定/, desc: '未指定文本' },
  { pattern: /^(以下是|这里是|下面是我)/, desc: '解释性开头' },
  { pattern: /抱歉|对不起|不好意思/, desc: '道歉文本' }
];

/**
 * 验证LLM输出是否可用
 * @param {string} agentType - Agent类型
 * @param {any} output - LLM输出
 * @returns {object} { valid, issues, score }
 */
function validateLLMOutput(agentType, output) {
  const issues = [];
  let score = 0;

  // 基本空值检查
  if (output === null || output === undefined) {
    issues.push('output is null/undefined');
    return { valid: false, issues, score: 0 };
  }

  if (typeof output === 'string') {
    const text = output.trim();
    if (!text) {
      issues.push('output string is empty');
    } else {
      score = Math.min(text.length / 100, 10); // 基础长度分
      
      // 检查禁用格式
      for (const { pattern, desc } of FORBIDDEN_PATTERNS) {
        if (pattern.test(text)) {
          issues.push(`contains forbidden: ${desc}`);
          score -= 2;
        }
      }
    }
    return { valid: issues.length === 0, issues, score: Math.max(0, score) };
  }

  if (typeof output !== 'object') {
    issues.push(`output type is ${typeof output}, expected object`);
    return { valid: false, issues, score: 0 };
  }

  // 对象类型检查必填字段
  const required = REQUIRED_FIELDS[agentType] || [];
  for (const key of required) {
    if (!(key in output)) {
      issues.push(`missing field: ${key}`);
      score -= 1;
    }
  }

  // 检查字段值是否有效
  for (const [key, value] of Object.entries(output)) {
    if (value === undefined || value === null) {
      issues.push(`field ${key} is null/undefined`);
      score -= 1;
    }
    if (typeof value === 'string' && !value.trim()) {
      // 空字符串是允许的（表示无内容）
    }
  }

  // 计算综合分数
  const totalFields = Object.keys(output).length;
  score = Math.max(0, score + totalFields * 2);

  return { valid: issues.length === 0, issues, score: Math.max(0, score) };
}

/**
 * 快速检查：是否为空输出
 */
function isEmptyOutput(output) {
  if (!output) return true;
  if (typeof output === 'string') return !output.trim();
  if (typeof output === 'object') return Object.keys(output).length === 0;
  return true;
}

/**
 * 检查是否包含禁用内容
 */
function containsForbiddenContent(text) {
  if (!text || typeof text !== 'string') return false;
  
  for (const { pattern, desc } of FORBIDDEN_PATTERNS) {
    if (pattern.test(text)) {
      return { hasForbidden: true, reason: desc };
    }
  }
  return { hasForbidden: false };
}

module.exports = {
  validateLLMOutput,
  isEmptyOutput,
  containsForbiddenContent,
  REQUIRED_FIELDS,
  FORBIDDEN_PATTERNS
};
