'use strict';

/**
 * Safe Prompt Trim
 * 目标：
 * 1. 截断时保护 【】 结构块
 * 2. 优先按块裁剪，而不是裸 substring
 * 3. 自动修复未闭合标记
 * 4. 兼容：
 *    - 块格式：【CHARACTER】... | 【ACTION】...
 *    - 自然语言逗号串
 *    - 混合格式
 */

function repairBrokenBlocks(text) {
  let out = String(text || '');

  // 如果出现单独的左书名号但没有右书名号，尽量补齐
  const leftCount = (out.match(/【/g) || []).length;
  const rightCount = (out.match(/】/g) || []).length;
  if (leftCount > rightCount) {
    out += '】'.repeat(leftCount - rightCount);
  }

  // 修正常见错误：`【明亮约束 ` -> `【明亮约束】`
  out = out.replace(/【([^【】\n]{1,30})(?=\s|，|,|\||$)/g, '【$1】');

  return out;
}

function splitStructuredBlocks(text) {
  const repaired = repairBrokenBlocks(text);
  const blocks = [];
  const regex = /【([^】]+)】([\s\S]*?)(?=(?:\s*\|\s*【)|(?:【[^】]+】)|$)/g;

  let match;
  while ((match = regex.exec(repaired)) !== null) {
    const label = match[1].trim();
    const content = (match[2] || '').trim().replace(/^\|\s*/, '');
    blocks.push({
      label,
      content,
      full: `【${label}】${content}`
    });
  }

  return blocks;
}

function splitNaturalSegments(text) {
  return String(text || '')
    .split(/[,，]\s*/)
    .map(s => s.trim())
    .filter(Boolean);
}

function trimTextAtBoundary(text, maxLen) {
  const raw = String(text || '');
  if (raw.length <= maxLen) return raw;

  // 优先在句号、逗号、空格边界截断
  const boundaryChars = ['。', '，', ',', ' ', '|'];
  let cut = maxLen;

  for (let i = maxLen; i >= Math.max(0, maxLen - 80); i--) {
    if (boundaryChars.includes(raw[i])) {
      cut = i;
      break;
    }
  }

  return raw.slice(0, cut).trim();
}

function safeTrimStructuredPrompt(text, maxLen, protectedLabels = ['CHARACTER', 'ACTION', 'SCENE', 'CAMERA']) {
  let repaired = repairBrokenBlocks(text);
  if (repaired.length <= maxLen) return repaired;

  const blocks = splitStructuredBlocks(repaired);
  if (!blocks.length) {
    return safeTrimPlainPrompt(repaired, maxLen);
  }

  // 按保护优先级排序：protected 在前，其他在后
  const sorted = [
    ...blocks.filter(b => protectedLabels.includes(b.label.toUpperCase())),
    ...blocks.filter(b => !protectedLabels.includes(b.label.toUpperCase()))
  ];

  // 先整块拼接，尽量保留更多块
  let kept = [];
  let currentLen = 0;

  for (const block of sorted) {
    const blockText = `【${block.label}】${block.content}`;
    const extraLen = kept.length ? 3 : 0; // " | "
    if (currentLen + extraLen + blockText.length <= maxLen) {
      kept.push(block);
      currentLen += extraLen + blockText.length;
    }
  }

  // 如果还没达到至少一个块，就强行裁第一个保护块
  if (!kept.length) {
    const first = sorted[0];
    const head = `【${first.label}】`;
    const remain = Math.max(0, maxLen - head.length);
    return repairBrokenBlocks(head + trimTextAtBoundary(first.content, remain));
  }

  let output = kept.map(b => `【${b.label}】${b.content}`).join(' | ');

  if (output.length <= maxLen) return repairBrokenBlocks(output);

  // 第二轮：逐块裁内容（只裁非核心块优先）
  let mutable = kept.map(b => ({ ...b }));

  const trimOrder = [
    ...mutable.filter(b => !protectedLabels.includes(b.label.toUpperCase())),
    ...mutable.filter(b => protectedLabels.includes(b.label.toUpperCase()))
  ];

  for (const block of trimOrder) {
    output = mutable.map(b => `【${b.label}】${b.content}`).join(' | ');
    if (output.length <= maxLen) break;

    const overflow = output.length - maxLen;
    const newContentLen = Math.max(12, block.content.length - overflow - 5);
    block.content = trimTextAtBoundary(block.content, newContentLen);
  }

  output = mutable.map(b => `【${b.label}】${b.content}`).join(' | ');

  if (output.length > maxLen) {
    output = trimTextAtBoundary(output, maxLen);
  }

  return repairBrokenBlocks(output);
}

function safeTrimPlainPrompt(text, maxLen) {
  const raw = String(text || '');
  if (raw.length <= maxLen) return raw;

  const segments = splitNaturalSegments(raw);
  if (!segments.length) return trimTextAtBoundary(raw, maxLen);

  let kept = [];
  let len = 0;

  for (const seg of segments) {
    const extra = kept.length ? 2 : 0; // "，"
    if (len + extra + seg.length <= maxLen) {
      kept.push(seg);
      len += extra + seg.length;
    } else {
      break;
    }
  }

  if (!kept.length) return trimTextAtBoundary(raw, maxLen);

  let out = kept.join('，');
  if (out.length > maxLen) out = trimTextAtBoundary(out, maxLen);
  return out;
}

function safeTrimPrompt(text, maxLen, options = {}) {
  const protectedLabels = options.protectedLabels || ['CHARACTER', 'ACTION', 'SCENE', 'CAMERA'];
  const raw = repairBrokenBlocks(text);

  if (/【[^】]+】/.test(raw)) {
    return safeTrimStructuredPrompt(raw, maxLen, protectedLabels);
  }

  return safeTrimPlainPrompt(raw, maxLen);
}

module.exports = {
  repairBrokenBlocks,
  splitStructuredBlocks,
  safeTrimStructuredPrompt,
  safeTrimPlainPrompt,
  safeTrimPrompt
};
