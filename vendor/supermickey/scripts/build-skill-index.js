#!/usr/bin/env node
/**
 * 技能索引构建器：扫描技能库 → frontmatter 优先、文件名解析兜底 →
 * 校验枚举合法性 → 编译 skills-index.json
 * 用法：node scripts/build-skill-index.js（新增技能后跑一次，或纳入 preflight 自动跑）
 */
const fs = require('fs');
const path = require('path');

const SKILL_LIB = path.join(__dirname, '..', 'hyperreality-system', 'skills', '好莱坞工业电影技能工厂', '技能系列', '镜头级专项');
const TAXONOMY = require(path.join(__dirname, '..', 'hyperreality-system', 'skills', 'hollywood-cinematography', 'taxonomy.json'));
const OUT = path.join(__dirname, '..', 'hyperreality-system', 'skills', 'hollywood-cinematography', 'skills-index.json');

// —— 旧文件名解析（兼容 149 个存量技能，已实测 0 警告通过）——
function parseFilename(name) {
 const parts = name.replace('.md', '').split('_');
 // 微表情演技技能有两类命名：微表情_<导演>_<情绪> 或 微表情_<情绪>_<描述>，按导演名单判别
 const KNOWN_DIRECTORS = ['维伦纽瓦','诺兰','卡梅隆','卢卡斯','库布里克','斯皮尔伯格','斯科塞斯','昆汀','达米恩','韦斯安德森','索金','博伊尔','大卫林奇','芬奇','希区柯克','卡萨维茨','德尼罗','曼','斯派克琼斯','黑泽明','奥卡萨姆','闪电'];
 if (parts[0] === '微表情') {
 if (KNOWN_DIRECTORS.includes(parts[1])) {
 return { type: '微表情', director: parts[1], emotions: parts[2] ? [parts[2]] : [], camera_modes: [] };
 }
 return { type: '微表情', director: '', emotions: parts[1] ? [parts[1]] : [], camera_modes: [], descriptor: parts.slice(2).join('_') };
 }
 // 摄影技能命名：<类型>_<导演>_<情绪><运镜词>，拆分尾部运镜词、去 IMAX 技术标签
 // 【v2.3.2】第二槽未注册为导演时按情绪类别处理——孤独_午夜独醒 等技能的情绪此前被吞为空数组
 if (!KNOWN_DIRECTORS.includes(parts[1])) {
 return { type: parts[0] || '', director: '', emotions: parts[1] ? [parts[1]] : [], camera_modes: [], descriptor: parts.slice(2).join('_') };
 }
 const CAM_WORDS = ['手持', '斯坦尼康', '定场', '航拍'];
 const rest = parts.slice(2).join('_');
 const camModes = CAM_WORDS.filter(w => rest.includes(w));
 let emotion = CAM_WORDS.reduce((t, w) => t.replace(w, ''), rest);
 emotion = emotion.replace(/^_+|_+$/g, '').replace(/_?IMAX$/i, '');
 return { type: parts[0] || '', director: parts[1] || '', emotions: emotion ? [emotion] : [], camera_modes: camModes };
}

function parseFrontmatter(content) {
 const m = content.match(/^---\n([\s\S]*?)\n---/);
 if (!m) return null;
 const meta = {};
 for (const line of m[1].split('\n')) {
 const kv = line.match(/^(\w+):\s*(.*)$/);
 if (!kv) continue;
 let v = kv[2].trim();
 if (v.startsWith('[')) {
 try { v = JSON.parse(v.replace(/'/g, '"')); } catch (_) { v = v.replace(/[\[\]]/g, '').split(',').map(s => s.trim()); }
 }
 meta[kv[1]] = v;
 }
 return meta;
}

function main() {
 const files = fs.readdirSync(SKILL_LIB).filter(f => f.endsWith('.md'));
 const index = [];
 const warnings = [];

 for (const file of files) {
 const content = fs.readFileSync(path.join(SKILL_LIB, file), 'utf8');
 const fm = parseFrontmatter(content);
 const legacy = parseFilename(file);
 const meta = {
 file,
 skill_id: fm?.skill_id || file.replace('.md', ''),
 domain: fm?.domain || (legacy.type === '微表情' ? 'acting' : 'cinematography'),
 type: fm?.type || legacy.type,
 director: fm?.director || legacy.director || '',
 emotions: fm?.emotions || legacy.emotions,
 camera_modes: fm?.camera_modes || legacy.camera_modes,
 intensity_range: fm?.intensity_range || null,
 hasManifest: !!fm
 };

 // 枚举归一与校验：未知情绪/类型只警告不阻断（兼容期），但记入报告
 meta.emotions = [].concat(meta.emotions).map(x => TAXONOMY.emotion_alias[x] || x);
 for (const e of [].concat(meta.emotions)) {
 if (!TAXONOMY.emotions.includes(e)) {
 warnings.push(`${file}: 未知情绪 "${e}"（可在 taxonomy.json 注册）`);
 }
 }
 meta.type = TAXONOMY.type_alias[meta.type] || meta.type;
 if (meta.type && !TAXONOMY.types.includes(meta.type)) {
 warnings.push(`${file}: 未知类型 "${meta.type}"`);
 }
 // 运镜词归一
 meta.camera_modes = [].concat(meta.camera_modes).map(c => TAXONOMY.camera_alias[c] || c);
 index.push(meta);
 }

 fs.writeFileSync(OUT, JSON.stringify({ built_at: new Date().toISOString(), count: index.length, skills: index }, null, 2));
 console.log(`✅ 技能索引构建完成: ${index.length} 个技能 → ${OUT}`);
 console.log(`⚠️ ${warnings.length} 个警告:`);
 warnings.forEach(w => console.log(' ' + w));
 if (warnings.length > 0) process.exitCode = 2; // 警告非零退出，供 preflight/CI 感知
}
main();
