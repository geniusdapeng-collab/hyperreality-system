// systems/llm-output-parser.js
// v6.3-patch5-expert-fix: 统一LLM输出解析，content优先，reasoning兜底

'use strict';

/**
 * 尝试从文本中提取JSON
 * 支持多种格式：纯JSON、JSON在markdown中、JSON在文本中
 */
function tryParseJSON(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();

  // 尝试直接解析
  try {
    return JSON.parse(trimmed);
  } catch (_) {}

  // 尝试从文本中提取JSON对象
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const candidate = trimmed.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(candidate);
    } catch (_) {}
  }

  // 尝试提取JSON数组
  const firstBracket = trimmed.indexOf('[');
  const lastBracket = trimmed.lastIndexOf(']');
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    const candidate = trimmed.slice(firstBracket, lastBracket + 1);
    try {
      return JSON.parse(candidate);
    } catch (_) {}
  }

  return null;
}

/**
 * 从reasoning_content中提取最终答案
 * 查找标记词后的内容，或提取最后N字符
 */
function extractFromReasoning(reasoningText, maxChars = 2000) {
  if (!reasoningText || typeof reasoningText !== 'string') return null;
  
  const markers = ['最终输出', '最终答案', '输出结果', '答案', 'Output:', 'Answer:', 'output:', 'answer:', 'RESULT:', 'FINAL OUTPUT:'];
  
  for (const marker of markers) {
    const regex = new RegExp(`${marker}\s*[:：]\s*([\s\S]+)$`, 'i');
    const match = reasoningText.match(regex);
    if (match && match[1].trim().length > 50) {
      return match[1].trim();
    }
  }
  
  // 没找到标记，提取最后N字符
  return reasoningText.slice(-maxChars);
}

/**
 * 统一解析LLM响应
 * 一级：content → 二级：reasoning_content → 三级：fallback
 */
function parseLLMResponse({ content, reasoning_content, fallbackFactory }) {
  const cleanContent = typeof content === 'string' ? content.trim() : '';
  const cleanReasoning = typeof reasoning_content === 'string' ? reasoning_content.trim() : '';

  // 一级路径：优先解析content
  if (cleanContent) {
    const parsed = tryParseJSON(cleanContent);
    if (parsed !== null) {
      return { success: true, source: 'content', parsed, raw: cleanContent };
    }
    // content不是JSON，返回文本
    return { success: true, source: 'content', parsed: cleanContent, raw: cleanContent };
  }

  // 二级路径：从reasoning_content提取
  if (cleanReasoning) {
    const extracted = extractFromReasoning(cleanReasoning);
    if (extracted) {
      const parsed = tryParseJSON(extracted);
      if (parsed !== null) {
        return { success: true, source: 'reasoning_content', parsed, raw: extracted };
      }
      // 提取的内容不是JSON，返回文本
      return { success: true, source: 'reasoning_content', parsed: extracted, raw: extracted };
    }
  }

  // 三级路径：fallback
  return {
    success: false,
    source: 'fallback',
    parsed: typeof fallbackFactory === 'function' ? fallbackFactory() : {},
    raw: ''
  };
}

module.exports = {
  parseLLMResponse,
  tryParseJSON,
  extractFromReasoning
};