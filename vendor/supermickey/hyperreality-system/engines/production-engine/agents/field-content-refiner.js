'use strict';

/**
 * FieldContentRefiner - 25字段内容精炼器 (新增模块)
 * ============================================================
 * 挂载位置: PromptFusionAgent._assembleStandardPrompt 的 return 之前
 * (见 patch 02, 对拼接完成的完整 prompt 做最后一道内容精炼)
 *
 * 设计原则(与产品约束一一对应):
 * 1. 不改字段结构: 25 个【字段】标签一个不少、顺序不变; 片头 30 字段同理
 * 2. 每镜头自包含: baseline/constraint 等必要重复保留, 只做"写法统一 + 内容瘦身"
 * 3. 只精炼内容: 剥英文标签前缀 / 去同义堆叠 / 分句去重 / 矛盾仲裁 / 碎片清理 / 句级闭合
 * 4. 不损失质量: 所有删除项必须是"重复、矛盾、碎片、内部残留"四者之一, 有效细节一律保留
 *
 * 精炼前后对比(中国铁路 run-20260719-153813-084b79 实测):
 * 单镜 prompt 2700~2927 字符 → 约 1500~1800 字符, 矛盾指令清零
 *
 * 长度口径(两阶段, 唯一真源 config/prompt-length.js):
 * ① 组装阶段目标 [TARGET_MIN, TARGET_MAX]; ② 精炼完成后交付口径 [REFINED_MIN, HARD_MAX]
 * 精炼使 prompt 变短是设计预期, 不再要求精炼后仍落在组装目标区间。
 * ============================================================
 */

/** 需要做"英文标签前缀剥离"的字段(历史上被 autoFix 拼了英文枚举的字段) */
const EN_PREFIX_FIELDS = new Set([
 '【灯光设计】', '【灯光/照明】', '【色彩/色调】', '【景深】', '【运镜】', '【音频】'
]);

/** 不做任何内容改动的字段(只保证闭合) */
const PROTECTED_FIELDS = new Set(['【语言约束】']);

/** 空镜(无角色)检测信号: 出现在【角色】字段正文中即判定空镜 */
const EMPTY_SHOT_SIGNALS = /无角色|无人物|无指定角色|空镜|空车厢|画面纯粹以空间|人的缺席/;

/** 空镜时字段内容的标准化文案(字段保留, 内容极简) */
const EMPTY_SHOT_CONTENT = {
 '【服装】': '无角色出场，本字段不适用。',
 '【化妆】': '无角色出场，本字段不适用。',
 '【定妆照】': '无角色出场，无定妆照。',
 '【角色约束】': '画面无人物，禁止任何人物入镜。',
 '【角色一致性】': '本镜头无角色，保持场景材质与光线同全片一致。'
};

/** 服装 fallback 模板句(RuleRepairer 补齐残留), 非空镜镜头中属于冗余, 一律剔除 */
const COSTUME_FALLBACK_PATTERN = /[，,]?\s*外套：合身外套[，,]\s*内搭：简约内衬[，,]\s*下装：合体长裤[，,]\s*鞋履：整洁鞋靴/g;

/** 角色锚定泄漏(_alignWithPrd 残留): "，角色锚定：李明、小周" */
const CHARACTER_ANCHOR_PATTERN = /[，,]?\s*角色锚定：[^。；;]*/g;

/** 负面约束中"禁止文字"同义家族 → 合并为三条代表 */
const NEGATIVE_TEXT_FAMILY = /text|alphabet|letter|character|signage|handwritten|printed|subtitle|caption|watermark|logo|UI element|brand mark/i;
const NEGATIVE_TEXT_REPRESENTATIVES = ['no text', 'no watermark', 'no signage'];

class FieldContentRefiner {
 constructor(options = {}) {
 this.logger = options.logger || console;
 // 技术规格统一模板: 全片所有镜头一字不差(消除 H.264/H.265 打架)
 // 可由外部按项目实际画幅注入, 默认 16:9/4K/24fps/MP4
 this.constraintTemplate = options.constraintTemplate || '16:9画幅，4K分辨率，24fps，MP4格式';
 // 【fix-精炼盲区D】记录模板是否为外部注入: 注入模板尊重原样(可能已含项目分辨率),
 // 默认模板允许按【基础】字段动态调整分辨率
 this._templateInjected = !!options.constraintTemplate;
 this.stats = {
 strippedEnPrefix: 0,
 removedFragments: 0,
 dedupedClauses: 0,
 negativeMerged: 0,
 fallbackRemoved: 0,
 charsBefore: 0,
 charsAfter: 0
 };
 }

 /**
 * 主入口: 精炼完整 prompt 字符串
 * @param {string} promptText - _assembleStandardPrompt 拼接完成的完整 prompt
 * @param {object} [shot] - 镜头对象(可选, 用于读取 ratio 等上下文)
 * @returns {string} 精炼后的完整 prompt (字段结构与顺序不变)
 */
 refinePrompt(promptText, shot = {}) {
 if (!promptText || typeof promptText !== 'string') return promptText;
 this.stats.charsBefore += promptText.length;

 // 【v2.5.0】社媒营销包：约束模板画幅按镜头平台蓝图解析（9:16 竖屏等），
 // 电影叙事场景保持调用方注入/默认模板（16:9）
 try {
 const { resolveProfile, constraintTemplateOf, isSocialCommerce } = require('../../../config/platform-profiles.js');
 const profile = resolveProfile(shot, (shot && shot.blueprint) || {});
 this._shotConstraintTemplate = isSocialCommerce(profile) ? constraintTemplateOf(profile) : null;
 } catch (_) { this._shotConstraintTemplate = null; }

 const sections = this._splitSections(promptText);
 const refinedSections = this._processSections(sections, shot);
 const result = refinedSections.map(s => s.head + s.body + s.sep).join('');
 this.stats.charsAfter += result.length;
 return result;
 }

 /**
 * fields 回写入口: 对 shot.fields 对象做同样的内容精炼, 返回补丁对象
 * 用途: 保证 shot.prompt 与 shot.fields 内容一致 —— 报告生成/二次校验/
 * 以 fields 为准的下游重新渲染时, 读到的也是精炼后内容。
 * 调用: Object.assign(shot.fields, refiner.refineFields(shot.fields, shot))
 *
 * 回写规则:
 * - 1:1 字段(场景/构图/色彩/景深/运镜/角色/服装/化妆/动作/道具/定妆照/
 * 时间轴/情绪/节奏/转场/音频/负面约束/角色约束/角色一致性) → 精炼后直接回写
 * - 灯光设计 = lighting + bright_constraint 合并段 → 精炼后按 [亮度要求] 拆回两个字段
 * - 导演意图/constraint/baseline/dialogue 不回写:
 * 导演意图是三字段合并的展示形态, fields 层三字段是档案数据, 职责分离;
 * dialogue 以结构化的 dialogueBlocks 为准(源数据无截断问题)
 * @param {object} fields - shot.fields
 * @param {object} [shot]
 * @returns {object} 字段补丁(只含发生精炼的字段)
 */
 refineFields(fields, shot = {}) {
 if (!fields || typeof fields !== 'object') return {};
 const getF = (...names) => {
 for (const n of names) {
 if (fields[n] !== undefined && fields[n] !== null && fields[n] !== '') return fields[n];
 }
 return undefined;
 };
 const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

 // 1:1 映射字段(含拆分后的独立字段)
 const DIRECT_MAP = [
 ['【场景】', 'scene'], ['【构图】', 'composition'], ['【色彩/色调】', 'color_palette'],
 ['【景深】', 'depth_of_field'], ['【运镜】', 'camera_movement'], ['【角色】', 'character'],
 ['【服装】', 'costume'], ['【化妆】', 'makeup'], ['【动作】', 'action'],
 ['【道具】', 'props'], ['【定妆照】', 'portraits'], ['【时间轴】', 'timeline'],
 ['【情绪】', 'mood'], ['【节奏】', 'pacing'], ['【转场】', 'transition'],
 ['【音频】', 'audio'], ['【负面约束】', 'negative'],
 ['【角色约束】', 'character_constraint'], ['【角色一致性】', 'consistency'],
 ['【灯光设计】', 'lighting'], ['【明亮约束】', 'bright_constraint'],
 ['【导演意图】', 'director_instruction'], ['【基础】', 'baseline'], ['【约束】', 'constraint']
 ];

 const sections = [];
 const backMap = [];
 for (const [head, key] of DIRECT_MAP) {
 const v = getF(key, camel(key));
 if (typeof v === 'string' && v.trim()) { // 结构化时间轴对象等跳过, 不精炼
 sections.push({ head, body: v, sep: '' });
 backMap.push({ type: 'direct', key });
 }
 }

 const refined = this._processSections(sections, shot);

 const patch = {};
 refined.forEach((sec, i) => {
 const meta = backMap[i];
 if (meta.type === 'direct') {
 patch[meta.key] = sec.body;
 }
 });
 return patch;
 }

 /**
 * 段处理核心(refinePrompt 与 refineFields 共用):
 * 逐段内容精炼 + 空镜标准化
 * @param {Array<{head:string, body:string, sep:string}>} sections
 * @param {object} shot
 * @returns {Array} 处理后的 sections
 */
 _processSections(sections, shot) {
 const hasCharacter = !this._detectEmptyShot(sections);
 const sceneBody = this._getSectionBody(sections, '【场景】');

 const refinedSections = sections.map(({ head, body, sep }) => {
 let core = body;

 // ---- 通用精炼(按字段类型分流) ----
 if (PROTECTED_FIELDS.has(head)) {
 // 语言约束: 常量字段, 若被上游截断成残句则统一重写为标准全文
 core = this._normalizeLanguageConstraint(core);
 } else if (head === '【定妆照】') {
 core = this._repairPortraits(core);
 } else if (head === '【转场】') {
 core = this._normalizeTransition(core);
 } else if (head === '【负面约束】') {
 core = this._refineNegative(core);
 } else if (head === '【台词】') {
 core = this._repairDialogue(core);
 } else if (head === '【时间轴】') {
 core = this._dedupeClauses(core); // 时间轴保留全部拍点, 仅去重
 } else {
 // 其余字段: 剥英文前缀(白名单字段) + 剥T00碎片(所有字段) + 分句去重
 if (EN_PREFIX_FIELDS.has(head)) {
 core = this._stripLeadingJunk(core);
 }
 core = this._stripTimelineFragments(core);
 core = this._dedupeClauses(core);

 // ---- 字段专属精炼 ----
 if (head === '【灯光设计】' || head === '【灯光/照明】') {
 // bright_constraint 已拆为独立标签【明亮约束】, 此处无需拆分
 core = this._dedupeClauses(core);
 } else if (head === '【导演意图】') {
 // baseline/constraint 已拆为独立标签【基础】/【约束】, 此处无需拆分
 core = this._dedupeClauses(core);
 } else if (head === '【基础】') {
 core = this._normalizeBaseline(core);
 } else if (head === '【约束】') {
 // 【fix-精炼盲区D】传入【基础】正文, 供模板分辨率跟随
 core = this._normalizeConstraint(core, this._getSectionBody(sections, '【基础】') || '');
 } else if (head === '【明亮约束】') {
 core = this._normalizeBrightConstraint(core);
 } else if (head === '【主标题内容】' || head === '【副标题内容】' || head === '【标题动画设计】' || head === '【标题字体设计】' || head === '【开场音频设计】') {
 // 片头专属字段: 只去重, 不特殊处理
 core = this._dedupeClauses(core);
 } else if (head === '【节奏】') {
 core = this._stripTimeRedundancy(core);
 } else if (head === '【道具】') {
 core = this._dedupePropsAgainstScene(core, sceneBody);
 } else if (head === '【角色】') {
 core = this._stripAnchors(core);
 } else if (head === '【服装】') {
 core = this._stripCostumeFallback(core);
 }
 }

 core = this._ensureClosure(core);
 return { head, body: core, sep };
 });

 // ---- 空镜标准化(字段保留, 内容极简) ----
 if (!hasCharacter) {
 for (const sec of refinedSections) {
 if (EMPTY_SHOT_CONTENT[sec.head] !== undefined) {
 sec.body = EMPTY_SHOT_CONTENT[sec.head];
 }
 }
 }

 return refinedSections;
 }

 // ==================== 切段 ====================

 /**
 * 按【字段】标签切段, 保留段间分隔符(原拼接为 ' | ')
 * @returns {Array<{head:string, body:string, sep:string}>}
 */
 _splitSections(text) {
 const heads = [];
 const re = /【[^【】]{1,12}】/g;
 let m;
 while ((m = re.exec(text)) !== null) {
 heads.push({ head: m[0], start: m.index, end: m.index + m[0].length });
 }
 if (heads.length === 0) return [{ head: '', body: text, sep: '' }];

 const sections = [];
 for (let i = 0; i < heads.length; i++) {
 const contentStart = heads[i].end;
 const contentEnd = i + 1 < heads.length ? heads[i + 1].start : text.length;
 let raw = text.slice(contentStart, contentEnd);
 // 分离尾部分隔符(' | ' / 空白 / 换行), 重组时原样接回
 let sep = '';
 const sepMatch = raw.match(/(\s*\|\s*|\s+)$/);
 if (sepMatch) {
 sep = sepMatch[0];
 raw = raw.slice(0, raw.length - sepMatch[0].length);
 }
 sections.push({ head: heads[i].head, body: raw, sep });
 }
 return sections;
 }

 _getSectionBody(sections, headName) {
 const sec = sections.find(s => s.head === headName);
 return sec ? sec.body : '';
 }

 _detectEmptyShot(sections) {
 const charBody = this._getSectionBody(sections, '【角色】');
 return EMPTY_SHOT_SIGNALS.test(charBody);
 }

 // ==================== 1. 英文标签前缀 + T00 碎片剥离 ====================

 /**
 * 循环剥离字段开头的"纯英文标签 clause"与"T00 碎片 clause",
 * 直到遇到第一个含中文的有效 clause。最多 5 轮防死循环。
 * 覆盖 case: "hard directional lighting, high contrast, dramatic shadows; 主光为…"
 * "slow static camera, stable composition; T00:6缓慢稳定构图; handheld camera, …; 固定机位…"
 * "clear voice and dialogue, 环境音为…"
 * 保护: 不含空格/逗号的单个技术词(如 "8K超高清"开头含中文, 天然不匹配)不受影响
 */
 _stripLeadingJunk(body) {
 let result = body;
 for (let round = 0; round < 5; round++) {
 const before = result;
 result = this._stripOneEnPrefix(result);
 result = this._stripOneT00Fragment(result);
 if (result === before) break;
 }
 return result;
 }

 _stripOneEnPrefix(body) {
 // 开头为纯英文序列(含空格/逗号/点/连字符/斜杠), 以分号/逗号收尾, 且紧跟中文
 // 【fix-精炼盲区B】向前看补充数字: 摄影字段常以 28mm/240fps/5600K 等数字开头,
 // 旧正则 (?=[一-鿿T]) 对数字开头字段体永不命中; 前缀起始同步放宽数字,
 // 配合 _stripLeadingJunk 多轮循环逐段剥净(如 "handheld tracking, 28mm lens, 28mm 手持…")
 const m = body.match(/^\s*([A-Za-z0-9][A-Za-z0-9 .,'\/()\-]{7,}?)[;；,，]\s*(?=[\u4e00-\u9fffT0-9])/);
 if (!m) return body;
 const prefix = m[1];
 // 保护: 单个无空格技术词不剥(理论上到不了这里, 双保险)
 if (!/[\s,]/.test(prefix.trim())) return body;
 this.stats.strippedEnPrefix++;
 return body.slice(m[0].length);
 }

 _stripOneT00Fragment(body) {
 // 开头为 T00 时间碎片 clause: "T00:6缓慢稳定构图; " / "T00:6快速推轨+手持晃动，强化冲击感; "
 const m = body.match(/^\s*T\d{2}:\d{1,2}[^;；\u4e00-\u9fff]{0,10}[^(;；]{0,24}[;；]\s*/);
 if (m && m[0].length <= 45) {
 this.stats.removedFragments++;
 return body.slice(m[0].length);
 }
 // 变体: 直接以中文开头的碎片 "T00:6缓慢稳定构图；"
 const m2 = body.match(/^\s*T\d{2}:\d{1,2}[\u4e00-\u9fff+A-Za-z0-9，、+]{2,24}[;；]\s*/);
 if (m2 && m2[0].length <= 45) {
 this.stats.removedFragments++;
 return body.slice(m2[0].length);
 }
 return body;
 }

 /** 剥离字段中部/尾部的 T00 碎片(非时间轴字段专用): "…画面微动; T00:0转身" → "…画面微动" */
 _stripTimelineFragments(body) {
 // 尾部碎片
 let result = body.replace(/[;；]\s*T\d{2}:\d{1,2}[^;；]{0,24}$/, (match) => {
 this.stats.removedFragments++;
 return '';
 });
 // 中部碎片(后还有中文内容): "…定焦85mm电影镜头；T00:6缓慢稳定构图；前四秒…" 的异常形态
 result = result.replace(/[;；]\s*T\d{2}:\d{1,2}[\u4e00-\u9fff+A-Za-z0-9，、+]{2,20}(?=[;；])/g, (match) => {
 this.stats.removedFragments++;
 return '';
 });
 return result;
 }

 // ==================== 2. 分句去重 ====================

 /**
 * 按中文句读(。；)切分, 删除:
 * a) 规范化后完全重复的句子
 * b) 被更长句包含的句子(长度≥12才参与包含判定, 防误删)
 * 保留原语序与原始标点。
 */
 _dedupeClauses(body) {
 if (!body || body.length < 40) return body;
 const units = body.split(/(?<=[。；;])/).filter(u => u.trim());
 // 【fix-精炼盲区A】两句结构(原句+重复句)也要去重, 旧阈值<3直接早退, 相邻重复句永不触发
 if (units.length < 2) return body;

 const norm = (s) => s.replace(/[\s。；;，,、：:""'（）()【】\[\]]/g, '');
 const kept = [];
 const keptNorms = [];

 for (const unit of units) {
 const n = norm(unit);
 if (!n) continue;
 // 完全重复
 if (keptNorms.includes(n)) {
 this.stats.dedupedClauses++;
 continue;
 }
 // 包含关系(仅长句参与): 新句被已有句包含 → 跳过新句
 if (n.length >= 12 && keptNorms.some(k => k.length > n.length && k.includes(n))) {
 this.stats.dedupedClauses++;
 continue;
 }
 kept.push(unit);
 keptNorms.push(n);
 }
 return kept.join('');
 }

 // ==================== 3. 负面约束: 同义家族合并 + token 去重 ====================

 _refineNegative(body) {
 const tokens = body.split(/[,，;；]/).map(t => t.trim()).filter(Boolean);
 const others = [];
 const seenOthers = new Set();
 let textFamilyCount = 0;

 for (const token of tokens) {
 if (NEGATIVE_TEXT_FAMILY.test(token)) {
 textFamilyCount++;
 continue; // 文字类同义条全部跳过, 统一用代表
 }
 const key = token.toLowerCase();
 if (seenOthers.has(key)) {
 this.stats.negativeMerged++;
 continue;
 }
 seenOthers.add(key);
 others.push(token);
 }
 if (textFamilyCount > NEGATIVE_TEXT_REPRESENTATIVES.length) {
 this.stats.negativeMerged += textFamilyCount - NEGATIVE_TEXT_REPRESENTATIVES.length;
 }
 return [...NEGATIVE_TEXT_REPRESENTATIVES, ...others].join(', ');
 }

 // ==================== 4. 基础: 统一技术规格写法 ====================

 /**
 * 【基础】= 8K/cinematic/photorealistic 等画质词
 * 统一写法, 去重(8K/cinematic/photorealistic 只保留一次)
 */
 _normalizeBaseline(body) {
 return this._dedupeClauses(body);
 }

 // ==================== 5. 约束: 统一技术规格模板 ====================

 /**
 * 【约束】= 画幅/分辨率/帧率/格式
 * 统一替换为 constraintTemplate, 消除 H.264/H.265/48kHz/4:2:2 打架
 *
 * 【fix-精炼盲区D】双保险:
 * 1. 含镜头级创作约束信号(时长/一镜到底/台词/唇形/慢动作/蒙太奇等)时不模板化,
 *    只做去重——旧实现把"时长10秒,一镜到底,唇形同步开启"整段覆盖为
 *    "16:9画幅,4K分辨率,24fps,MP4格式", 镜头级渲染约束全灭;
 * 2. 默认模板分辨率跟随【基础】字段(8K/6K/4K), 不再硬编码 4K,
 *    消除"基础 8K vs 约束 4K"的自相矛盾。
 */
 _normalizeConstraint(body, baselineBody = '') {
 // 镜头级创作约束信号: 命中即不模板化
 if (/时长|一镜到底|台词|唇形|慢动作|蒙太奇|叠化|手持|航拍|斯坦尼康|定场/.test(body)) {
 return this._dedupeClauses(body);
 }
 const techPattern = /画幅|分辨率|帧率|fps|格式|MP4|编码|色域/;
 if (techPattern.test(body) && body.length < 120) {
 // 【v2.5.0】营销镜头：模板画幅跟随平台蓝图（如 TikTok 9:16）
 if (this._shotConstraintTemplate) return this._shotConstraintTemplate;
 // 分辨率跟随【基础】( baseline 出现 8K/6K 则模板同步, 否则用调用方注入/默认模板 )
 const resMatch = String(baselineBody).match(/\b(4K|6K|8K)\b/);
 if (resMatch && !this._templateInjected) {
 return this.constraintTemplate.replace(/4K分辨率/, `${resMatch[1]}分辨率`);
 }
 return this.constraintTemplate;
 }
 return body;
 }

 // ==================== 5b. 导演意图: 去重 ====================

 /**
 * 【导演意图】= director_instruction (已拆分, 不再包含 baseline/constraint)
 * 只需去重, 无需处理技术规格
 */
 _normalizeDirectorIntent(body, shot) {
 return this._dedupeClauses(body);
 }

 // ==================== 5c. 明亮约束: 统一写法 ====================

 /**
 * 【明亮约束】= 亮度要求
 * 统一替换为标准短句
 */
 _normalizeBrightConstraint(body, shot) {
    // 【DXB-fix】调用方可能不传 shot 或结构不符，先从 body 其余字段推断是否空镜
    let hasCharacter;
    if (shot && typeof shot === 'object') {
      hasCharacter = shot.character === undefined
        || (typeof shot.character === 'string' && !/无角色|无人物|空镜/.test(shot.character))
        || (shot.character && typeof shot.character === 'object');
    } else {
      // shot 缺失时，从已拼装的正文中找角色痕迹（定妆照/角色字段有实质内容即非空镜）
      hasCharacter = !/无角色出场|无人物|空镜/.test(String(body || ''));
    }
    return hasCharacter
      ? '主体面部明亮清晰，阴影保留层次不死黑'
      : '主体照度均匀，画面无死黑区域';
  }

 // ==================== 6. 节奏: 删除与时间轴重复的逐秒描述 ====================

 /**
 * 【节奏】与【时间轴】重复的部分是"逐秒分布描述", 保留纯质性概括句。
 * 规则: 删除含 "X-Y秒" / "T00:XX" 时间标记的分句; 若删完则保留原第一句。
 */
 _stripTimeRedundancy(body) {
 // 【fix-精炼盲区C】分句补充逗号: 节奏字段常以逗号连接全句(无。；;),
 // 旧实现单句仅 1 个 unit 直接早退, 句内 T00 冗余永不清理
 const units = body.split(/(?<=[。；;，,])/).filter(u => u.trim());
 if (units.length <= 1) return body;
 const qualitative = units.filter(u => !/\d+\s*[-–—~]\s*\d+\s*秒|T\d{2}:\d{2}|\d+-\d+s/i.test(u));
 if (qualitative.length === 0) return units[0]; // 全是时间描述 → 保留第一句保底
 if (qualitative.length < units.length) {
 this.stats.dedupedClauses += units.length - qualitative.length;
 }
 return qualitative.join('');
 }

 // ==================== 7. 道具: 与场景去重 ====================

 /**
 * 道具项(顿号/逗号分隔)的"名称头"(括号前文本)若已在【场景】中出现 → 删除该项。
 * 只保留场景未提及、与动作/台词直接交互的道具。
 */
 _dedupePropsAgainstScene(propsBody, sceneBody) {
 if (!sceneBody) return propsBody;
 const items = propsBody.split(/[、，,；;]/).map(t => t.trim()).filter(Boolean);
 if (items.length < 2) return propsBody;
 const kept = items.filter(item => {
 const name = item.replace(/（[^（）]*）/g, '').replace(/\([^()]*\)/g, '').trim();
 const key = name.slice(0, 4);
 if (key.length >= 3 && sceneBody.includes(key)) {
 this.stats.dedupedClauses++;
 return false;
 }
 return true;
 });
 if (kept.length === 0) return '无特殊道具';
 return kept.join('、');
 }

 // ==================== 8. 角色/服装: 锚定与 fallback 清理 ====================

 /** 【角色】: 剥除 "，角色锚定：李明、小周" 与 "，身着无角色服装…" 泄漏尾巴 */
 _stripAnchors(body) {
 return body
 .replace(CHARACTER_ANCHOR_PATTERN, '')
 .replace(/[，,]?\s*身着无角色服装[^。；;]*/g, '')
 .replace(/[，,]?\s*场景以空镜头形式呈现/g, (m) => {
 // 该句在空镜时是有效信息, 保留——只在前面已出现"无角色出场"时才删
 return m; // 保守: 保留, 由分句去重处理重复
 });
 }

 /** 【服装】: 剔除 "外套：合身外套，内搭：简约内衬，下装：合体长裤，鞋履：整洁鞋靴" 模板 */
 _stripCostumeFallback(body) {
 if (COSTUME_FALLBACK_PATTERN.test(body)) {
 this.stats.fallbackRemoved++;
 }
 COSTUME_FALLBACK_PATTERN.lastIndex = 0;
 const result = body.replace(COSTUME_FALLBACK_PATTERN, '').replace(/[，,]\s*$/, '');
 return result.trim() || body; // 删空(空镜)→ 返回原文, 由空镜标准化覆盖
 }

 // ==================== 9. 台词: 修复被截断的半截台词块 ====================

 /**
 * 【台词】Seedance 2.0 内联格式: "[00s-02s] speaker trigger, emotion 说:"…""
 * 截断函数可能把最后一行砍成半截(如 "[02s-04s] xiao_zhou leans forward, cu"),
 * 规则: 以时间戳开头但未以闭合引号结尾的行 → 整行删除(半行台词比少一行更伤模型)
 */
 _repairDialogue(body) {
 // 兼容字面 \n(JSON源码形式)与真实换行两种形态
 const lines = body.replace(/\\n/g, '\n').split(/\r?\n/);
 const repaired = lines.filter(line => {
 const t = line.trim();
 if (!t) return false;
 if (/^\[\d+s-\d+s\]/.test(t)) {
 return /说[:：]\s*\\?[""][^""\\]*\\?[""]\s*$/.test(t);
 }
 return true; // 非时间戳格式(旧格式纯台词)保留
 });
 return repaired.join('\n');
 }

 // ==================== 9b. 语言约束: 常量字段统一重写 ====================

 /**
 * 【语言约束】是固定模板字段, 上游截断会产生"禁止。"这类残句。
 * 内容偏离标准模板时直接重写为全文(常量字段重写无信息损失)。
 */
 _normalizeLanguageConstraint(body) {
 const STANDARD = '全部字段必须使用中文输出，禁止出现英文单词、英文短语、英文描述。';
 // 已完整包含关键要素则保留原文
 if (body.includes('中文') && body.includes('禁止') && body.length >= 25) return body;
 this.stats.removedFragments++;
 return STANDARD;
 }

 // ==================== 9c. 定妆照: 半截 URI 修复 ====================

 /**
 * 【定妆照】正常形态为完整 image:// URI (.png/.jpg 结尾)。
 * 被上游截断的半截 URI(如 "image://characters/railw")对模型无意义, 替换为文字引用。
 * 空镜时由空镜标准化覆盖, 此处只处理有角色镜头。
 */
 _repairPortraits(body) {
 const t = body.trim();
 if (/^image:\/\/\S+\.(png|jpg|jpeg|webp)$/i.test(t)) return t; // 完整URI保留
 if (t.startsWith('image://')) {
 this.stats.removedFragments++;
 return '角色定妆照参考图'; // 半截URI → 文字引用
 }
 return body;
 }

 // ==================== 9d. 转场: 标准化映射 ====================

 /**
 * 【转场】字段信息量低且常被截成"直接切入下。"这类残句。
 * 提取转场类型关键词, 统一为标准短句; 识别不到类型则保留原文+闭合。
 */
 _normalizeTransition(body) {
 const types = [
 [/闪白|白闪/, '闪白转场'], [/叠化|溶解/, '叠化转场'],
 [/匹配剪辑|match_cut/i, '匹配剪辑转场'], [/移焦|rack_focus/i, '移焦转场'],
 [/淡入淡出|淡入|淡出/, '淡入淡出转场'], [/硬切|切镜|直接切/, '硬切转场']
 ];
 for (const [pattern, label] of types) {
 if (pattern.test(body)) {
 // 【fix-转场保真】含创作内容的转场描述只闭合不覆盖——旧实现对命中类型词的
 // 字段一律改写为"xx转场，衔接下一镜头。", 镜头级创作细节(衔接画面/情绪意图)全灭。
 // 仅当正文只是干类型词/英文枚举(无创作内容)时才标准化。
 const bare = String(body).replace(/[，,。；;\s]/g, '');
 const isBareType = bare.length <= 10 || /^[A-Za-z_\s,]+$/.test(String(body).trim());
 if (isBareType) return `${label}，衔接下一镜头`;
 return this._ensureClosure(body);
 }
 }
 return body;
 }

 // ==================== 10. 句级闭合(防半截句子) ====================

 /**
 * 保证字段内容以闭合标点结尾, 括号/引号配平。
 * 处理截断残留: "…幅度不超过画面高度的百分之零点五；第七秒恢复绝对静止，形成"
 * → 回退到最后一个闭合标点 "…百分之零点五；"
 */
 _ensureClosure(body) {
 if (!body) return body;
 let result = body.trim();
 if (!result) return result;

 // 括号配平: 末尾存在未闭合的 （ " 「 → 截到该符号之前
 const pairs = { '（': '）', '"': '"', '「': '」', '【': '】', '[': ']' };
 for (const [open, close] of Object.entries(pairs)) {
 const openCount = (result.match(new RegExp('\\' + open, 'g')) || []).length;
 const closeCount = (result.match(new RegExp('\\' + close, 'g')) || []).length;
 if (openCount > closeCount) {
 const lastOpen = result.lastIndexOf(open);
 if (lastOpen > 0) result = result.slice(0, lastOpen);
 }
 }

 // 尾部标点判定分两级:
 // HARD_CLOSERS(。；;) — 可作为回退截断点的句级闭合符
 // SOFT_CLOSERS(引号/括号/冒号等) — 仅用于判定"结尾已闭合", 不作为回退截断点
 // (防止把段中标记如 [亮度要求] 的 ']' 误判为回退点, 误删其后内容)
 const HARD_CLOSERS = '。；;';
 const SOFT_CLOSERS = '""』」）)]…—：';
 const lastChar = result.slice(-1);
 if (HARD_CLOSERS.includes(lastChar) || SOFT_CLOSERS.includes(lastChar)) return result;

 // 剥除尾部悬空顿号/逗号(列举被截断的残留)
 result = result.replace(/[、，,]\s*$/, '');

 const lastCloseIdx = Math.max(
 ...[...HARD_CLOSERS].map(c => result.lastIndexOf(c))
 );
 if (lastCloseIdx > result.length * 0.5) {
 // 回退点保留过半内容 → 安全回退
 return result.slice(0, lastCloseIdx + 1);
 }
 // 找不到合适回退点 → 不截断, 补句号(宁全勿缺)
 return result + '。';
 }

 /** 输出精炼统计(接入日志用) */
 getStats() {
 return { ...this.stats };
 }

 resetStats() {
 Object.keys(this.stats).forEach(k => { this.stats[k] = 0; });
 }
}

module.exports = { FieldContentRefiner };

// ==================== 自测(直接 node 运行本文件时执行) ====================
if (require.main === module) {
 const refiner = new FieldContentRefiner();

 // 用例1: S2 运镜四源拼接(static+handheld矛盾+T00碎片)
 const s2Camera = 'slow static camera, stable composition; T00:6缓慢稳定构图; handheld camera, fast movement, shaky motion, quick pans; 固定机位，无物理位移，模拟重型三脚架锁死状态，镜头为定焦85mm电影镜头；前四秒保持绝对静止，第五秒至第六秒引入极微弱呼吸感；T00:6快速推轨+手持晃动，强化冲击感';
 console.log('=== 运镜精炼 ===');
 console.log('前:', s2Camera);
 console.log('后:', refiner._ensureClosure(refiner._dedupeClauses(refiner._stripLeadingJunk(s2Camera))));

 // 用例2: 负面约束12条no-text堆叠
 const negative = 'no text anywhere in frame, no readable characters, no alphabets, no Chinese characters, no text on walls objects documents signs labels screens clothing packaging, no handwritten text, no printed text, no signage text, no text overlays, no UI elements with text, no watermark, no blurry image, no sci-fi elements, no neon color, no AI artifact, no extra limb, no extra limb';
 console.log('\n=== 负面约束精炼 ===');
 console.log('后:', refiner._refineNegative(negative));

 // 用例3: 灯光(已拆分, 无亮度要求合并)
 const lighting = 'hard directional lighting, high contrast, dramatic shadows; 主光为桌面白炽台灯，色温2700K硬光直射；补光来自北窗微弱天光';
 console.log('\n=== 灯光设计精炼 ===');
 console.log('后:', refiner._ensureClosure(refiner._dedupeClauses(refiner._stripLeadingJunk(lighting))));

 // 用例4: 道具与场景去重
 const scene = '1980年代废弃蒸汽火车站台，红砖墙面斑驳，锈蚀铸铁长椅与木质长凳散置各处，角落堆放破损信号灯与废弃道岔扳手';
 const props = '锈蚀铸铁长椅（椅背镂空花纹局部断裂）、木质长凳（漆面剥落）、废弃信号灯（玻璃罩碎裂）、道岔扳手（手柄腐朽）、鸭嘴绘图笔（金属笔杆）';
 console.log('\n=== 道具去重 ===');
 console.log('后:', refiner._dedupePropsAgainstScene(props, scene));

 // 用例5: 服装fallback剔除
 const costume = '深蓝色工装制服，左胸口袋插两支钢笔，袖口磨损起球，外套：合身外套，内搭：简约内衬，下装：合体长裤，鞋履：整洁鞋靴';
 console.log('\n=== 服装fallback剔除 ===');
 console.log('后:', refiner._stripCostumeFallback(costume));

 // 用例6: 台词半截修复
 const dialogue = '[00s-02s] li_ming touches rusted rail, proudly 说:"四十年前，我就在这。"\n[02s-04s] xiao_zhou leans forward, cu';
 console.log('\n=== 台词半截修复 ===');
 console.log('后:', refiner._repairDialogue(dialogue));

 // 用例7: fields 回写(与 prompt 精炼保持一致)
 const mockFields = {
 scene: '1980年代废弃蒸汽火车站台，锈蚀铸铁长椅与木质长凳散置各处',
 camera_movement: 'slow static camera, stable composition; 固定机位凝视，全程无推拉升降',
 color_palette: 'cool blue tones, high contrast, saturated colors, sharp separation; 主色调为砖红褐色系，饱和度降低30%',
 negative: 'no text anywhere in frame, no readable characters, no alphabets, no watermark, no blurry image',
 character: '无角色出场，画面纯粹以空间环境作为叙事主体, 身着无角色服装，角色锚定：李明、小周',
 costume: '无角色服装，场景以空镜头形式呈现',
 makeup: '无角色妆容发型',
 lighting: 'indoor lighting, 主光为西侧窗洞夕照，色温3200K;[亮度要求] well-lit自然光照明，阴影区域保留可见层次非死黑，整体画面明暗分布符合人眼适应范围，无过曝高光与欠曝死区',
 props: '锈蚀铸铁长椅（椅背断裂）、木质长凳（漆面剥落）、鸭嘴绘图笔（金属笔杆）'
 };
 const patch = refiner.refineFields(mockFields, { shotId: 'S1' });
 console.log('\n=== fields回写(patch) ===');
 for (const [k, v] of Object.entries(patch)) console.log(`${k}: ${v}`);

 console.log('\n=== 统计 ===', refiner.getStats());
}
