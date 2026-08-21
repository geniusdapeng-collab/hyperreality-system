#!/usr/bin/env node
'use strict';

/**
 * agent-preflight.js — AI Agent 执行前预检（Step 0 单命令入口）
 *
 * 设计目标：把"执行前必须人工核对的一堆规范"收敛为一条命令。
 * 所有输出均从引擎代码/配置实时提取，不在本脚本硬编码任何规范数值，
 * 避免双写漂移（本脚本只做"读取与呈现"，不做"第二份规范"）。
 *
 * 用法：
 *   node scripts/agent-preflight.js          # 人类可读的执行规范卡
 *   node scripts/agent-preflight.js --json   # 机器可读 JSON（供 Agent 程序化消费）
 *
 * 退出码：0 = 全部通过；1 = 存在阻断项（工作区不完整 / 版本三源不一致 / 权威文件缺失）
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const JSON_MODE = process.argv.includes('--json');

const blockers = [];
const warnings = [];
const report = { checks: {}, spec: {} };

/* ---------- 1. 工作区完整性（克隆文件检出丢失防护） ---------- */
try {
  const status = execSync('git status --short', { cwd: ROOT, encoding: 'utf-8' });
  // 仅未暂存的检出丢失（' D'）视为工作区不完整；已暂存删除（'D '）属正常变更，不阻断
  const lost = status.split('\n').filter(l => l.startsWith(' D '));
  if (lost.length > 0) {
    blockers.push(`工作区不完整：${lost.length} 个文件检出丢失（${lost.slice(0, 5).map(l => l.slice(3)).join(', ')}${lost.length > 5 ? ' 等' : ''}）。先执行 git checkout -- . 恢复后再继续`);
    report.checks.worktree = { ok: false, lostFiles: lost.map(l => l.slice(3)) };
  } else {
    report.checks.worktree = { ok: true };
  }
} catch (e) {
  warnings.push(`无法执行 git status（${e.message}），跳过工作区检查`);
  report.checks.worktree = { ok: null, note: 'git unavailable' };
}

/* ---------- 2. 版本号（唯一权威：package.json） ---------- */
let version = null;
try {
  version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')).version;
  report.spec.version = version;
} catch (e) {
  blockers.push('package.json 读取失败，无法确认系统版本');
}

/* ---------- 3. 版本三源一致性（复用 version-check.js，不重复实现） ---------- */
try {
  const out = execSync('node scripts/version-check.js', { cwd: ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  report.checks.versionConsistency = { ok: true, detail: out.trim().split('\n').pop() };
} catch (e) {
  blockers.push('版本三源不一致（.current-version / package.json / index.js 头部注释），请先运行 node scripts/version-check.js --fix');
  report.checks.versionConsistency = { ok: false, detail: String(e.stdout || e.message).slice(0, 500) };
}

/* ---------- 4. 渲染 Prompt 字段规范（从 prompt-fusion-agent.js 源码实时解析） ---------- */
const FUSION_FILE = path.join(ROOT, 'hyperreality-system/engines/production-engine/agents/prompt-fusion-agent.js');
try {
  const src = fs.readFileSync(FUSION_FILE, 'utf-8');
  // 内容镜头字段：在 _assembleStandardPrompt 函数体内逐行扫描【标签】，按出现顺序去重。
  // 兼容三种注入形态：parts.push(`【X】…)、parts.push('【X】…)、变量拼接 `【X】${…}`（如台词）。
  const fnStart = src.indexOf('_assembleStandardPrompt(shot, fields, ratio) {');
  const fnEnd = src.indexOf('_assembleFullPrompt', fnStart);
  const body = src.slice(fnStart, fnEnd > fnStart ? fnEnd : undefined);
  const contentFields = [];
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('//') || line.startsWith('*') || line.includes('console.warn')) continue;
    const labelRe = /【([一-龥/]{1,8})】/g;
    let lm;
    while ((lm = labelRe.exec(line)) !== null) {
      const label = lm[1];
      if (label === '强制中文输出') continue; // 语言修正前缀，非内容字段
      if (!contentFields.includes(label)) contentFields.push(label);
    }
  }
  // 片头专属字段：openingFields 数组的 label 值，按数组顺序
  const openingFields = [];
  const ofRe = /\{\s*key:\s*'[^']+',\s*label:\s*'([^']+)'\s*\}/g;
  let m;
  while ((m = ofRe.exec(src)) !== null) {
    if (!openingFields.includes(m[1])) openingFields.push(m[1]);
  }
  if (contentFields.length < 25) {
    warnings.push(`字段解析结果异常：内容镜头仅解析到 ${contentFields.length} 个字段标签，请以 prompt-fusion-agent.js 原文为准`);
  }
  // 【v2.2.7-fix】台词字段格式规范：从 _renderDialogueBlocks 头部注释实时解析（单一真源）。
  // 历史事故：规范卡只列字段名、不携带台词的渲染格式，Agent 执行时台词字段整体丢失。
  const dlgFnStart = src.indexOf('_renderDialogueBlocks(blocks, duration) {');
  const dlgCommentStart = src.lastIndexOf('格式:', dlgFnStart);
  const dlgCommentEnd = src.indexOf('\n', dlgCommentStart);
  if (dlgFnStart > 0 && dlgCommentStart > 0) {
    report.spec.dialogueFormat = src.slice(dlgCommentStart, dlgCommentEnd).replace(/^[\s*]+/, '').replace(/^格式[:：]/, '').trim();
  } else {
    warnings.push('台词格式规范解析失败：请以 prompt-fusion-agent.js _renderDialogueBlocks 原文为准');
  }
  report.spec.contentFields = contentFields;
  report.spec.openingExclusiveFields = openingFields;
  report.spec.fieldCounts = { content: contentFields.length, opening: contentFields.length + openingFields.length };
} catch (e) {
  blockers.push(`规范权威文件缺失：${FUSION_FILE}`);
}

/* ---------- 5. 长度标准（从 config/prompt-length.js 实时读取） ---------- */
try {
  const PromptLengthConfig = require(path.join(ROOT, 'hyperreality-system/config/prompt-length.js'));
  report.spec.promptLength = {
    targetMin: PromptLengthConfig.TARGET_MIN,
    targetMax: PromptLengthConfig.TARGET_MAX,
    hardMax: PromptLengthConfig.HARD_MAX,
    refinedMin: PromptLengthConfig.REFINED_MIN,
  };
} catch (e) {
  blockers.push('长度配置读取失败：hyperreality-system/config/prompt-length.js');
}

/* ---------- 5b. 台词速率与审核门槛（从 config 实时读取，禁止就地硬编码） ---------- */
try {
  const SpeechRate = require(path.join(ROOT, 'hyperreality-system/config/speech-rate.js'));
  report.spec.speechRate = { normal: SpeechRate.NORMAL, limit: SpeechRate.LIMIT, maxDialogueRatio: SpeechRate.MAX_DIALOGUE_RATIO };
} catch (e) {
  blockers.push('语速配置读取失败：hyperreality-system/config/speech-rate.js');
}
try {
  const AuditStandards = require(path.join(ROOT, 'hyperreality-system/config/audit-standards.js'));
  report.spec.auditStandards = { contentMin: AuditStandards.CONTENT_MIN, openingMin: AuditStandards.OPENING_MIN };
} catch (e) {
  blockers.push('审核门槛配置读取失败：hyperreality-system/config/audit-standards.js');
}

/* ---------- 6. 中间环节交付物格式（从三个引擎模块的生成函数源码实时解析） ---------- */
// 与第 4 节同一思路：规范结构只从引擎代码读，不在本脚本硬编码第二份。
function sliceFn(src, startMarker, endMarker) {
  const s = src.indexOf(startMarker);
  if (s < 0) return '';
  const e = endMarker ? src.indexOf(endMarker, s + startMarker.length) : -1;
  return src.slice(s, e > s ? e : undefined);
}
try {
  // ① 创意主题确认单：generateConfirmationSummary 盒内字段标签（含原始故事文本盒）
  const themeSrc = fs.readFileSync(path.join(ROOT, 'hyperreality-system/skills/creative-theme-generator/index.js'), 'utf-8');
  const themeBody = sliceFn(themeSrc, 'generateConfirmationSummary(result) {', 'adjustTask(result');
  const themeFields = [];
  const themeRe = /║\s*(?:\p{Extended_Pictographic}\s*)?([一-龥A-Za-z]+(?:（完整版）)?)\s*:/gu;
  let tm;
  while ((tm = themeRe.exec(themeBody)) !== null) {
    if (!themeFields.includes(tm[1])) themeFields.push(tm[1]);
  }
  // 按确认单真实布局排序：原始故事文本盒沉底
  const storyIdx = themeFields.findIndex(f => f.includes('原始故事文本'));
  if (storyIdx >= 0) themeFields.push(themeFields.splice(storyIdx, 1)[0]);
  report.spec.intermediateFormats = report.spec.intermediateFormats || {};
  report.spec.intermediateFormats.creativeTheme = { authority: 'hyperreality-system/skills/creative-theme-generator/index.js → generateConfirmationSummary', fields: themeFields };
} catch (e) {
  blockers.push('创意主题生成器解析失败：hyperreality-system/skills/creative-theme-generator/index.js');
}
try {
  // ② 业务需求对齐清单：generateMarkdown 的 markdown 章节标题
  const discSrc = fs.readFileSync(path.join(ROOT, 'hyperreality-system/engines/requirement-discovery-engine.js'), 'utf-8');
  const discBody = sliceFn(discSrc, 'generateMarkdown(discoveryResult) {', 'module.exports');
  const discSections = [];
  for (const line of discBody.split('\n')) {
    const h = line.match(/^(#{2,3})\s+(.+?)#*\s*$/);
    if (h) discSections.push(h[2].replace(/\$\{[^}]+\}/g, '…').trim());
  }
  // 条件插入的原始故事文本段（storySection 模板内）
  if (/原始故事文本（完整版）/.test(discBody) && !discSections.some(s => s.includes('原始故事文本'))) {
    discSections.unshift('📖 原始故事文本（完整版）（开头直通）');
  }
  report.spec.intermediateFormats.requirementDiscovery = { authority: 'hyperreality-system/engines/requirement-discovery-engine.js → generateMarkdown', sections: discSections };
} catch (e) {
  blockers.push('需求洞察引擎解析失败：hyperreality-system/engines/requirement-discovery-engine.js');
}
try {
  // ③ PRD 文档：generateMarkdown 的 markdown 章节标题
  const prdSrc = fs.readFileSync(path.join(ROOT, 'hyperreality-system/engines/prd-generator/prd-generator.js'), 'utf-8');
  const prdBody = sliceFn(prdSrc, 'generateMarkdown(prd) {', null);
  const prdSections = [];
  for (const line of prdBody.split('\n')) {
    const h = line.match(/^(#{2})\s+(.+?)#*\s*$/);
    if (h && !prdSections.includes(h[2].trim())) prdSections.push(h[2].trim());
  }
  // 条件插入的用户原始输入段（originalStorySection 模板内，行中匹配）
  if (/用户原始输入（创作素材源）/.test(prdBody) && !prdSections.some(s => s.includes('用户原始输入'))) {
    prdSections.splice(1, 0, '📖 用户原始输入（创作素材源）（直通段）');
  }
  report.spec.intermediateFormats.prd = { authority: 'hyperreality-system/engines/prd-generator/prd-generator.js → generateMarkdown', sections: prdSections };
} catch (e) {
  blockers.push('PRD 生成器解析失败：hyperreality-system/engines/prd-generator/prd-generator.js');
}

/* ---------- 7. 内容精炼规则（从 field-content-refiner.js 头部注释实时解析） ---------- */
try {
  const refinerSrc = fs.readFileSync(path.join(ROOT, 'hyperreality-system/engines/production-engine/agents/field-content-refiner.js'), 'utf-8');
  const ruleLine = refinerSrc.match(/只精炼内容[:：]\s*([^\n*]+)/);
  const rules = ruleLine ? ruleLine[1].split('/').map(s => s.trim()).filter(Boolean) : [];
  const mountLine = refinerSrc.match(/挂载位置[:：]\s*([^\n*]+)/);
  report.spec.contentRefiner = {
    authority: 'hyperreality-system/engines/production-engine/agents/field-content-refiner.js',
    mountPoint: mountLine ? mountLine[1].trim() : 'PromptFusionAgent._assembleStandardPrompt return 之前',
    rules,
  };
} catch (e) {
  blockers.push('内容精炼器解析失败：hyperreality-system/engines/production-engine/agents/field-content-refiner.js');
}

/* ---------- 8. 文档陈旧字面值扫描（阻断项：防止"第二份规范"复活） ---------- */
// 规则：*.md 文档中不得出现长度类陈旧字面值，除非该行带有失效标注；
// SPEC-AUTHORITY.md 是唯一的"宣告失效"合法载体，豁免；
// 文件名含日期（YYYY-MM-DD）的为历史快照，降级为警告。
try {
  const STALE_PATTERNS = [
    { re: /MAX_PROMPT_LENGTH\s*=\s*\d+/i, label: 'MAX_PROMPT_LENGTH 字面值' },
    { re: /max_prompt_length"?\s*[:=]\s*\d+/i, label: 'max_prompt_length 字面值' },
    { re: /"max_length"\s*:\s*\d+/i, label: 'max_length 字面值' },
    { re: /(?<![\d.])980(?![\d.])/, label: '980' },
    { re: /(?<![\d.])990(?![\d.])/, label: '990' },
    { re: /1400-1500/, label: '1400-1500' },
  ];
  const NEGATION_MARKERS = ['无效', '失效', '已弃用', '弃用', '历史遗留', '旧数字', '禁止', '勿再', '不再', '权威源'];
  const EXEMPT_FILES = new Set(['SPEC-AUTHORITY.md']);
  const mdFiles = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      // legacy/ 为 v2.2.8 审计设立的退役资产隔离区（见 legacy/README.md），
      // 内容为冻结历史材料，不参与现行规范字面值扫描。
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'legacy') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.md')) mdFiles.push(full);
    }
  })(ROOT);
  const staleHits = [];
  const staleWarns = [];
  for (const file of mdFiles) {
    const rel = path.relative(ROOT, file);
    if (EXEMPT_FILES.has(path.basename(file))) continue;
    const isDatedSnapshot = /\d{4}-\d{2}-\d{2}/.test(path.basename(file));
    const lines = fs.readFileSync(file, 'utf-8').split('\n');
    lines.forEach((line, idx) => {
      if (NEGATION_MARKERS.some(m => line.includes(m))) return;
      for (const p of STALE_PATTERNS) {
        if (p.re.test(line)) {
          const hit = `${rel}:${idx + 1} 命中陈旧字面值「${p.label}」`;
          (isDatedSnapshot ? staleWarns : staleHits).push(hit);
        }
      }
    });
  }
  if (staleHits.length > 0) {
    blockers.push(`文档陈旧字面值 ${staleHits.length} 处（唯一权威源为引擎代码，文档不得登记长度字面值）: ${staleHits.slice(0, 8).join('；')}${staleHits.length > 8 ? ' 等' : ''}`);
  }
  staleWarns.forEach(w => warnings.push(`历史快照含陈旧字面值（不阻断）: ${w}`));
  report.checks.staleLiterals = { ok: staleHits.length === 0, hits: staleHits, snapshotWarnings: staleWarns.length };
} catch (e) {
  warnings.push(`陈旧字面值扫描执行失败（${e.message}），跳过`);
}

/* ---------- 9. 固定执行纪律（非数值规范，属行为约束） ---------- */
report.spec.discipline = {
  auditReportAuthority: 'hyperreality-system/index.js 提示词审核报告生成器（镜头总览五列核验 + 序号化完整提示词 + 审核须知7条）',
  openingShotRequired: '每部作品必须含片头镜头（shotId=S00/SC00 或 sceneType=opening），片头=内容字段+片头专属字段',
  originalStoryPassthrough: '用户输入原文必须原样进入业务需求洞察与 PRD（_originalStoryText 链路），禁止改写省略',
  languageConstraint: '字段正文全部中文；英文仅允许【负面约束】固定短语与【基础】质量锚点词',
  emotionField: '【情绪】字段必须有具体面部/眼神描述，禁止只写关键词',
  dialogueField: '【台词】字段按上方【台词字段格式】渲染：带角色名+动作触发+情绪副词+说:"台词内容"；数据层有台词的镜头禁止丢字段，无台词镜头（空镜）禁止虚构台词',
  shotDuration: `单镜 3-12 秒，系统上限 15 秒；台词速率基准 ${report.spec.speechRate?.normal} 字/秒、极限 ${report.spec.speechRate?.limit} 字/秒、占镜头时长 ≤${(report.spec.speechRate?.maxDialogueRatio ?? 0.8) * 100}%（唯一真源: config/speech-rate.js）`,
  templatesWarning: 'templates/ 目录仅为中间态参考或弃用指引，禁止作为最终渲染 Prompt 格式与长度依据（镜头卡25字段≠渲染Prompt25字段）',
  specAuthorityMap: 'SPEC-AUTHORITY.md 为规范裁决唯一权威地图，引擎代码 > 文档',
  intermediateFormats: '中间环节交付物（创意主题确认单/业务需求对齐清单/PRD）的字段结构以各引擎模块生成函数为唯一权威，禁止按技能或文档自带的格式清单执行',
  contentRefiner: '提示词组装完成后必须执行内容精炼（六类规则见上方【内容精炼规则】），再按两阶段口径核验长度（见上方【长度标准】）；精炼环节归属须在交付时说明',
  skillExecution: '技能库环节（如好莱坞摄影技能路由）必须用镜头真实元数据实际运行匹配逻辑，禁止虚构技能命中',
};

/* ---------- 输出 ---------- */
const ok = blockers.length === 0;
report.ok = ok;
report.blockers = blockers;
report.warnings = warnings;

if (JSON_MODE) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const f = report.spec.contentFields || [];
  const of = report.spec.openingExclusiveFields || [];
  const L = report.spec.promptLength || {};
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║        SuperMickey Agent 执行前预检 · 规范卡             ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`  系统版本: v${version || '?'}（package.json 唯一权威）`);
  console.log(`  工作区完整: ${report.checks.worktree?.ok ? '✅' : '❌'}   版本三源一致: ${report.checks.versionConsistency?.ok ? '✅' : '❌'}`);
  console.log('');
  console.log(`  【内容镜头字段】共 ${f.length} 个标签（序号 01-${String(f.length).padStart(2, '0')}，【】标签格式；审核标准 ${report.spec.auditStandards?.contentMin ?? 25}，≥${report.spec.auditStandards?.contentMin ?? 25} 即 ✅）：`);
  f.forEach((label, i) => console.log(`    ${String(i + 1).padStart(2, '0')}.【${label}】`));
  console.log(`  【片头专属字段】共 ${of.length} 个（片头镜头 = 上述 ${f.length} + 以下 ${of.length} = ${report.spec.fieldCounts?.opening} 个标签；审核标准 ${report.spec.auditStandards?.openingMin ?? 30}，≥${report.spec.auditStandards?.openingMin ?? 30} 即 ✅）：`);
  of.forEach((label, i) => console.log(`    ${String(f.length + i + 1).padStart(2, '0')}.【${label}】`));
  console.log('');
  console.log(`  【长度标准】组装阶段目标 ${L.targetMin}-${L.targetMax} 字符，硬上限 ${L.hardMax}；精炼完成后交付口径 ≥${L.refinedMin} 且 ≤${L.hardMax}（两阶段口径，唯一真源 config/prompt-length.js）`);
  if (report.spec.dialogueFormat) {
    console.log(`  【台词字段格式】${report.spec.dialogueFormat}；台词必须是角色直接对话（带角色名），禁止画外音/旁白；数据层有台词的镜头，最终 Prompt 必须出现【台词】字段，缺失即渲染守卫硬阻断`);
  }
  console.log('');
  const IF = report.spec.intermediateFormats || {};
  if (IF.creativeTheme) {
    console.log('  【中间环节交付物格式】（实时解析自引擎生成函数，唯一权威）');
    console.log(`    ① 创意主题确认单（${IF.creativeTheme.fields.length} 字段）: ${IF.creativeTheme.fields.join(' / ')}`);
    console.log(`    ② 业务需求对齐清单（${(IF.requirementDiscovery?.sections || []).length} 节）: ${(IF.requirementDiscovery?.sections || []).join(' / ')}`);
    console.log(`    ③ PRD 文档（${(IF.prd?.sections || []).length} 节）: ${(IF.prd?.sections || []).join(' / ')}`);
    console.log('');
  }
  if (report.spec.contentRefiner) {
    const cr = report.spec.contentRefiner;
    console.log(`  【内容精炼规则】共 ${cr.rules.length} 类（挂载点: ${cr.mountPoint}）: ${cr.rules.join(' / ')}`);
    console.log('');
  }
  console.log(`  【文档陈旧字面值扫描】${report.checks.staleLiterals?.ok ? '未命中 ✅' : '命中 ❌'}（980/990/1400-1500/MAX_PROMPT_LENGTH 等字面值无失效标注不得出现于文档）`);
  console.log('');
  console.log('  【执行纪律】');
  for (const [k, v] of Object.entries(report.spec.discipline)) console.log(`    · ${v}`);
  console.log('');
  if (warnings.length) { console.log('  ⚠️ 警告:'); warnings.forEach(w => console.log(`    - ${w}`)); console.log(''); }
  if (!ok) {
    console.log('  ⛔ 阻断项（必须先解决再执行）:');
    blockers.forEach(b => console.log(`    - ${b}`));
    console.log('');
  } else {
    console.log('  ✅ 预检通过，可按上述规范执行。');
    console.log('');
  }
}

process.exit(ok ? 0 : 1);
