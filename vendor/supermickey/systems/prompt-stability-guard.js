/**
 * Prompt Stability Guard v6.7.0
 * 文件: systems/prompt-stability-guard.js
 * 作用：
 * 1. 保护关键字段不丢失（25字段体系，P0-P3四级优先级）
 * 2. 裁剪时按优先级保关键块（P0不可裁，P1优先保，P2/P3优先裁）
 * 3. 避免 prompt 被重复重组洗坏
 * 4. 字符上限：3000（v6.7.0从1500扩展）
 */

function 是非空字符串(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

// === v6.7.0: 25字段优先级映射 ===
const 字段优先级 = {
  P0: ['导演指令', '约束', '基础', '场景', '灯光', '运镜', '角色', '动作', '台词', '对话指令', '负面约束', '定妆照', '角色一致性'],
  P1: ['构图', '色彩', '景深', '时间轴', '情绪', '明亮约束', '角色约束'],
  P2: ['服装', '道具', '节奏', '音频'],
  P3: ['化妆', '转场']
};

const 字段标签映射 = {
  导演指令: '【导演指令】',
  约束: '【约束】',
  基础: '【基础】',
  场景: '【场景】',
  灯光: '【灯光】',
  运镜: '【运镜】',
  角色: '【角色】',
  动作: '【动作】',
  台词: '【台词】',
  对话指令: '【对话指令】',
  负面约束: '【负面约束】',
  定妆照: '【定妆照】',
  角色一致性: '【角色一致性】',
  构图: '【构图】',
  色彩: '【色彩】',
  景深: '【景深】',
  时间轴: '【时间轴】',
  情绪: '【情绪】',
  明亮约束: '【明亮约束】',
  角色约束: '【角色约束】',
  服装: '【服装】',
  道具: '【道具】',
  节奏: '【节奏】',
  音频: '【音频】',
  化妆: '【化妆】',
  转场: '【转场】'
};

function 提取区块(prompt, 标签) {
  if (!是非空字符串(prompt)) return '';
  const reg = new RegExp(`(${标签}[^【]*)(?=【|$)`, 'g');
  const m = prompt.match(reg);
  return m ? m[0].trim() : '';
}

function 提取英文区块(prompt, prefix) {
  if (!是非空字符串(prompt)) return '';
  const reg = new RegExp(`(${prefix}\s*:[^|]*)(?=\||$)`, 'i');
  const m = prompt.match(reg);
  return m ? m[0].trim() : '';
}

function 去重片段(parts = []) {
  const out = [];
  const seen = new Set();
  for (const p of parts) {
    const k = String(p || '').trim();
    if (!k) continue;
    const kk = k.toLowerCase();
    if (!seen.has(kk)) {
      seen.add(kk);
      out.push(k);
    }
  }
  return out;
}

// v6.7.0: 扩展为25字段关键块提取
function 提取关键块(prompt) {
  const blocks = [];

  // P0 致命级字段（12个）
  for (const field of 字段优先级.P0) {
    const tag = 字段标签映射[field];
    if (tag) {
      const block = 提取区块(prompt, tag);
      if (block) blocks.push(block);
    }
  }

  // P1 核心级字段（7个）
  for (const field of 字段优先级.P1) {
    const tag = 字段标签映射[field];
    if (tag) {
      const block = 提取区块(prompt, tag);
      if (block) blocks.push(block);
    }
  }

  // P2 增强级字段（4个）
  for (const field of 字段优先级.P2) {
    const tag = 字段标签映射[field];
    if (tag) {
      const block = 提取区块(prompt, tag);
      if (block) blocks.push(block);
    }
  }

  // P3 可选级字段（2个）
  for (const field of 字段优先级.P3) {
    const tag = 字段标签映射[field];
    if (tag) {
      const block = 提取区块(prompt, tag);
      if (block) blocks.push(block);
    }
  }

  // 保留英文区块兼容（向后兼容）
  blocks.push(
    提取英文区块(prompt, 'CHARACTER'),
    提取英文区块(prompt, 'SCENE'),
    提取英文区块(prompt, 'ACTION'),
    提取英文区块(prompt, 'DIALOGUE'),
    提取英文区块(prompt, 'CAMERA'),
    提取英文区块(prompt, 'TIMELINE'),
    提取英文区块(prompt, 'LIGHTING'),
    提取英文区块(prompt, 'AUDIO'),
    提取英文区块(prompt, 'NEGATIVE')
  );

  return 去重片段(blocks).filter(Boolean);
}

// v6.7.0: 扩展为25字段存在检测
function 关键字段存在(prompt) {
  const out = {};

  // 所有25字段
  for (const [field, tag] of Object.entries(字段标签映射)) {
    out[field] = prompt.includes(tag);
  }

  // 兼容旧字段名
  out.时间轴 = out.时间轴 || prompt.includes('【镜头时间轴】') || /TIMELINE\s*:/i.test(prompt);
  out.对话指令 = out.对话指令 || prompt.includes('【对话指令】') || prompt.includes('【旁白/台词】');
  out.台词 = out.台词 || prompt.includes('【旁白/台词】');
  out.定妆照 = out.定妆照 || /@image\d+/i.test(prompt);
  out.角色 = out.角色 || /CHARACTER\s*:/i.test(prompt);
  out.场景 = out.场景 || /SCENE\s*:/i.test(prompt);
  out.动作 = out.动作 || /ACTION\s*:/i.test(prompt);
  out.灯光 = out.灯光 || /LIGHTING\s*:/i.test(prompt);
  out.音频 = out.音频 || /AUDIO\s*:/i.test(prompt);
  out.负面约束 = out.负面约束 || /NEGATIVE\s*:/i.test(prompt);

  return out;
}

// v6.7.0: 按优先级分组的六步截断策略
function 稳定裁剪(prompt, maxLength = 3000) {
  if (!是非空字符串(prompt)) return '';
  if (prompt.length <= maxLength) return prompt;

  // 步骤1: 提取所有关键块
  const 所有关键块 = 提取关键块(prompt);

  // 步骤2: 按优先级分组
  const P0块 = [];
  const P1块 = [];
  const P2块 = [];
  const P3块 = [];

  for (const block of 所有关键块) {
    let 优先级 = null;
    for (const field of 字段优先级.P0) {
      if (block.includes(字段标签映射[field])) { 优先级 = 'P0'; break; }
    }
    if (!优先级) {
      for (const field of 字段优先级.P1) {
        if (block.includes(字段标签映射[field])) { 优先级 = 'P1'; break; }
      }
    }
    if (!优先级) {
      for (const field of 字段优先级.P2) {
        if (block.includes(字段标签映射[field])) { 优先级 = 'P2'; break; }
      }
    }
    if (!优先级) {
      for (const field of 字段优先级.P3) {
        if (block.includes(字段标签映射[field])) { 优先级 = 'P3'; break; }
      }
    }

    if (优先级 === 'P0') P0块.push(block);
    else if (优先级 === 'P1') P1块.push(block);
    else if (优先级 === 'P2') P2块.push(block);
    else if (优先级 === 'P3') P3块.push(block);
    else P0块.push(block); // 未识别优先级，默认P0
  }

  // 步骤3: 六步截断
  // Step 1: 先保留所有P0块
  let 结果 = P0块.join(' | ');

  if (结果.length <= maxLength) {
    // Step 2: 尝试加入P1块
    const withP1 = 结果 + (P1块.length > 0 ? ' | ' + P1块.join(' | ') : '');
    if (withP1.length <= maxLength) {
      结果 = withP1;
      // Step 3: 尝试加入P2块
      const withP2 = 结果 + (P2块.length > 0 ? ' | ' + P2块.join(' | ') : '');
      if (withP2.length <= maxLength) {
        结果 = withP2;
        // Step 4: 尝试加入P3块
        const withP3 = 结果 + (P3块.length > 0 ? ' | ' + P3块.join(' | ') : '');
        if (withP3.length <= maxLength) {
          结果 = withP3;
        }
      }
    }
  } else {
    // P0块已超限，需要压缩P0块（理论上不应发生，因为P0块是最关键的）
    结果 = P0块.join(' | ').slice(0, maxLength);
  }

  // 步骤4: 如果仍有剩余空间，添加原始主体描述（非关键块内容）
  if (结果.length < maxLength) {
    let 主体 = prompt;
    for (const block of 所有关键块) {
      if (block) 主体 = 主体.replace(block, '');
    }
    主体 = 主体.replace(/\s{2,}/g, ' ').replace(/\|\s*\|/g, '|').trim();

    const remain = maxLength - 结果.length - 3;
    if (remain > 50) {
      主体 = 主体.slice(0, remain);
      结果 = `${结果} | ${主体}`.slice(0, maxLength);
    }
  }

  return 结果.slice(0, maxLength);
}

// v6.7.0: 恢复关键块，按P0>P1>P2>P3优先级恢复
function 恢复关键块(当前prompt, 原始prompt, maxLength = 3000) {
  let out = 当前prompt || '';
  const 当前状态 = 关键字段存在(out);
  const 原始关键块 = 提取关键块(原始prompt || '');

  // 按优先级排序原始块：P0优先，P1其次，P2再次，P3最后
  const 优先级排序 = [];
  for (const block of 原始关键块) {
    let 优先级 = 4; // P3
    for (const field of 字段优先级.P0) {
      if (block.includes(字段标签映射[field])) { 优先级 = 1; break; }
    }
    if (优先级 === 4) {
      for (const field of 字段优先级.P1) {
        if (block.includes(字段标签映射[field])) { 优先级 = 2; break; }
      }
    }
    if (优先级 === 4) {
      for (const field of 字段优先级.P2) {
        if (block.includes(字段标签映射[field])) { 优先级 = 3; break; }
      }
    }
    优先级排序.push({ block, 优先级 });
  }
  优先级排序.sort((a, b) => a.优先级 - b.优先级);

  for (const { block } of 优先级排序) {
    if (!block) continue;

    // 检查该块对应的字段是否已存在
    let 已存在 = false;
    for (const [field, tag] of Object.entries(字段标签映射)) {
      if (block.includes(tag) && 当前状态[field]) {
        已存在 = true;
        break;
      }
    }
    if (已存在) continue;

    // 空间检查
    if (out.length + block.length + 3 > maxLength) continue;

    out += ` | ${block}`;

    // 更新状态
    for (const [field, tag] of Object.entries(字段标签映射)) {
      if (block.includes(tag)) 当前状态[field] = true;
    }
  }

  return out.slice(0, maxLength);
}

// v6.7.0: 最小补洞，支持25字段
function 最小补洞(prompt, shot = {}) {
  let out = prompt || '';
  const 状态 = 关键字段存在(out);

  // P0 致命级补洞
  if (!状态.动作 && shot.action) {
    out += ` | 【动作】${shot.action}`;
  }

  const dialogue = shot.dialogue || shot.narration || '';
  const dialogueText = shot.dialogueBlock?.text || shot.dialogue || shot.narration || '';
  if (!状态.对话指令 && !状态.台词 && dialogueText) {
    out += ` | 【对话指令】${dialogueText}`;
  }

  if (!状态.时间轴 && shot.duration) {
    out += ` | 【镜头时间轴】00:00-00:${String(Math.floor(shot.duration)).padStart(2, '0')} / 时长:${shot.duration}s`;
  }

  if (!状态.场景 && shot.scene) {
    out += ` | 【场景】${shot.scene}`;
  }

  if (!状态.角色 && shot.character) {
    out += ` | 【角色】${shot.character}`;
  }

  if (!状态.负面约束 && shot.negativePrompt) {
    out += ` | 【负面约束】${shot.negativePrompt}`;
  }

  if (!状态.明亮约束 && shot.brightConstraint) {
    out += ` | 【明亮约束】${shot.brightConstraint}`;
  }

  if (!状态.角色约束 && shot.characterConstraint) {
    out += ` | 【角色约束】${shot.characterConstraint}`;
  }

  // P1 核心级补洞（次要）
  if (!状态.构图 && shot.composition) {
    out += ` | 【构图】${shot.composition}`;
  }

  if (!状态.色彩 && shot.colorPalette) {
    out += ` | 【色彩/色调】${shot.colorPalette}`;
  }

  if (!状态.景深 && shot.depthOfField) {
    out += ` | 【景深】${shot.depthOfField}`;
  }

  if (!状态.情绪 && shot.emotion) {
    out += ` | 【情绪】${shot.emotion}`;
  }

  return out;
}

module.exports = {
  提取关键块,
  关键字段存在,
  稳定裁剪,
  恢复关键块,
  最小补洞,
  // v6.7.0: 新增导出
  字段优先级,
  字段标签映射
};
