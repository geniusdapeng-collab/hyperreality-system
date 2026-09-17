#!/usr/bin/env node
/**
 * compile-skills.js — 技能结构化编译器（B1 地基）
 *
 * 把 149 个技能 MD 正文编译为运行时唯一输入 skills-compiled.json：
 *   triggers（类型/情绪/主体/运镜/导演/强度 五轴触发器）
 *   blocks（镜头手法/情绪设计/禁止词/时间轴/哲学/质检清单 结构化块）
 *   tier（S/A/B/C 质量分级，C 为可疑笛卡尔组合待重构）
 *   oneLiner（供 LLM 语义路由的候选清单）
 *
 * 此后路由器不再在热路径解析文本，MD 仅保留为人类可读源稿。
 *
 * 运行：node scripts/compile-skills.js
 */
const fs = require('fs');
const path = require('path');

const ROUTER = require('../hyperreality-system/skills/hollywood-cinematography/cinematography-skill-router.js');
const TAXONOMY = require('../hyperreality-system/skills/hollywood-cinematography/taxonomy.json');
const LIB = ROUTER.SKILL_LIB_ROOT;
const OUT = path.join(__dirname, '..', 'hyperreality-system', 'skills', 'hollywood-cinematography', 'skills-compiled.json');

const CAMERA_MODE_NORM = { '定场': 'establishing', '航拍': 'aerial', '手持': 'handheld', '斯坦尼康': 'steadicam' };
const INTENSITY_BY_TYPE = {
  war: ['L3', 'L5'], action: ['L3', 'L5'], horror: ['L3', 'L5'], thriller: ['L3', 'L5'],
  'sci-fi': ['L2', 'L5'], suspense: ['L2', 'L4'], drama: ['L1', 'L4'], comedy: ['L1', 'L4'],
  'micro-expression': ['L1', 'L4'], loneliness: ['L1', 'L3'], documentary: ['L1', 'L3'], fantasy: ['L2', 'L5']
};
// 可疑笛卡尔组合（待重构评审）：片种与导演气质明显冲突的组合
const TIER_C_RULES = [
  { type: 'comedy', directors: ['卡梅隆', '库布里克', '斯科塞斯', '芬奇'], reason: '喜剧×硬核导演气质冲突' }
];
// 已抽样验证的顶级正身（证据：逐行精读）
const TIER_S_FILES = new Set(['微表情_压抑悲伤_无声落泪.md', '剧情_卡梅隆_情感手持.md']);

function parseFrontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return {};
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w[\w-]*):\s*(.+)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return fm;
}

function extractSection(content, headingRe) {
  const lines = content.split('\n');
  let capture = false;
  const out = [];
  for (const line of lines) {
    if (/^## /.test(line)) {
      if (capture) break;
      if (headingRe.test(line)) { capture = true; continue; }
    }
    if (capture) out.push(line);
  }
  return out.join('\n').replace(/^---$/gm, '').trim();
}

function bulletsOf(text, max = 12) {
  return text.split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('**') || l.startsWith('- '))
    .slice(0, max);
}

function firstSentence(text, maxLen = 80) {
  const s = (text || '').replace(/\*\*/g, '').split(/[。！？\n]/).map(x => x.trim()).filter(Boolean)[0] || '';
  return s.length > maxLen ? s.slice(0, maxLen) + '…' : s;
}

function compileOne(file) {
  const content = fs.readFileSync(path.join(LIB, file), 'utf-8');
  const fm = parseFrontmatter(content);
  const meta = ROUTER.parseSkillFilename(file);
  const isActing = meta.type_zh === '微表情';

  const overview = extractSection(content, /^## 技能概述/);
  const positioning = (overview.match(/\*\*定位\*\*[:：]\s*(.+)/) || [])[1] || '';
  const philosophy = extractSection(content, /^## 第一部分/);
  const shotBlock = extractSection(content, /^## 第二部分/);
  const emotionBlock = extractSection(content, /^## 第三部分/);
  const promptBlock = extractSection(content, /^## 第四部分/);
  const forbiddenBlock = extractSection(content, /^## 第五部分/);
  const qcBlock = extractSection(content, /^## 第六部分/);

  const tlLine = promptBlock.split('\n').find(l => /时间轴/.test(l)) || '';
  const timeline = tlLine.replace(/^\s*\*\*时间轴分配\*\*[:：]\s*/, '').trim();

  const emotionCanon = TAXONOMY.emotion_alias[meta.emotion_zh] || meta.emotion || '';
  const cameraMode = meta.shotType ? (CAMERA_MODE_NORM[meta.shotType] || meta.shotType) : null;

  let tier = 'B';
  if (TIER_S_FILES.has(file)) tier = 'S';
  else if (TIER_C_RULES.some(r => r.type === meta.type && r.directors.includes(meta.director_zh))) tier = 'C';

  return {
    file,
    skill_id: fm.skill_id || meta.skill_id || file.replace('.md', ''),
    domain: isActing ? 'acting' : 'cinematography',
    type: meta.type,
    director: meta.director_zh || '',
    emotions: [emotionCanon].filter(Boolean),
    camera_modes: cameraMode ? [cameraMode] : [],
    intensity_range: INTENSITY_BY_TYPE[meta.type] || ['L1', 'L4'],
    tier,
    triggers: {
      types: [meta.type],
      emotions: [emotionCanon].filter(Boolean),
      subjects: isActing ? ['person'] : ['any'],
      camera_modes: cameraMode ? [cameraMode] : [],
      directors: meta.director_zh ? [meta.director_zh] : []
    },
    oneLiner: firstSentence(positioning || overview),
    blocks: {
      shot: bulletsOf(shotBlock, 8),
      emotion: bulletsOf(emotionBlock, 8),
      forbidden: bulletsOf(forbiddenBlock, 10).map(l => l.replace(/^-\s*/, '')),
      timeline,
      philosophy: firstSentence(philosophy, 160),
      qc: bulletsOf(qcBlock, 10).map(l => l.replace(/^-\s*/, ''))
    },
    source: { frontmatter_ok: !!fm.skill_id, minimum_granularity: fm.minimum_granularity || '' }
  };
}

function main() {
  const files = fs.readdirSync(LIB).filter(f => f.endsWith('.md')).sort();
  const skills = files.map(compileOne);
  const tierCount = {};
  skills.forEach(s => tierCount[s.tier] = (tierCount[s.tier] || 0) + 1);
  const noQc = skills.filter(s => s.blocks.qc.length === 0).map(s => s.file);
  const noTimeline = skills.filter(s => !s.blocks.timeline).map(s => s.file);

  const out = {
    schema: '1.0',
    built_at: new Date().toISOString(),
    count: skills.length,
    skills
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));

  console.log(`✅ 编译完成: ${skills.length} 个技能 → ${path.relative(process.cwd(), OUT)}`);
  console.log(`   分级分布: ${JSON.stringify(tierCount)}`);
  console.log(`   演技类: ${skills.filter(s => s.domain === 'acting').length}，摄影类: ${skills.filter(s => s.domain === 'cinematography').length}`);
  if (noQc.length) console.log(`   ⚠️ 缺质检清单: ${noQc.length} 个（${noQc.slice(0, 3).join('、')}…）`);
  if (noTimeline.length) console.log(`   ⚠️ 缺时间轴: ${noTimeline.length} 个（${noTimeline.slice(0, 3).join('、')}…）`);
}

main();
