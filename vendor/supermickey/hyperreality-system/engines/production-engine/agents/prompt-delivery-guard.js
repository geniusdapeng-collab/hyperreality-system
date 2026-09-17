'use strict';

/**
 * PromptDeliveryGuard（交付守卫）
 * ------------------------------------------------------------
 * 【v2.4.5 新增】三段式混合生产的阶段4：语义精炼后的硬性规则闸机。
 *
 * 职责：对任何将要交付的镜头提示词做纯规则终验。
 * LLM 环节（语义精炼）的输出必须过此闸机；任一校验不过，
 * 调用方必须回退到语义精炼之前的机器精炼结果——LLM 犯错的代价归零。
 *
 * 校验项（全部确定性，规则驱动，永不交给 LLM）：
 *   1. 字段完整性：内容镜头必备 25 字段，片头镜头另备 5 专属字段（共 30）
 *   2. 长度口径：REFINED_MIN ≤ 字符数 ≤ HARD_MAX（两阶段口径②，唯一真源 prompt-length.js）
 *   3. 台词纪律：有台词镜头【台词】字段在场且格式规范（时间戳+角色+情绪副词+说:"…"）；
 *      无台词镜头禁止出现【台词】（空镜禁虚构）
 *   4. 台词速率：分段时间戳内字数 ≤ LIMIT（按 Profile 分流；英文平台按词/秒），
 *      总时长占比 ≤ MAX_DIALOGUE_RATIO(0.8)
 *   5. 必备锚点：【时间轴】【情绪】【负面约束】【角色一致性】在场
 *   6. 情绪可见性：【情绪】须含可见部位微动作描述（面部/眼/手/呼吸等），
 *      防止"紧张、温情"式关键词写法通过语义层漏网
 *
 * 不做的事：不评判文采、不压缩、不改写——只判定 pass/fail 并给出 issues。
 */

const PromptLengthConfig = require('../../../config/prompt-length.js');
const SpeechRate = require('../../../config/speech-rate.js');
const { resolveProfile, isSocialCommerce } = require('../../../config/platform-profiles.js');
const { MarketingComplianceGuard } = require('./marketing-compliance-guard.js');

const REQUIRED_CONTENT = [
  '语言约束', '导演意图', '基础', '约束', '场景', '灯光设计', '明亮约束', '构图',
  '色彩/色调', '景深', '运镜', '角色', '服装', '化妆', '动作', '道具', '定妆照',
  '时间轴', '情绪', '节奏', '转场', '音频', '负面约束', '角色约束', '角色一致性'
];
const REQUIRED_OPENING_EXTRA = ['主标题内容', '副标题内容', '标题动画设计', '标题字体设计', '开场音频设计'];
// 情绪字段可见部位判定（含"仅手部入画"类镜头的合法形态）
const EMOTION_VISIBLE_PATTERN = /眼|眉|嘴角|面部|瞳孔|眼睑|视线|喉结|鼻翼|指尖|拇指|手|肌肉|呼吸|心跳|步频|肩|背|颈/;

class PromptDeliveryGuard {
  /**
   * @param {string} promptText 待交付提示词（' | ' 分隔或换行分隔均可，不含序号前缀）
   * @param {object} shot 镜头数据（shotId/sceneType/duration/dialogueBlocks/dialogues/character）
   * @returns {{pass:boolean, issues:string[], fieldCount:number, charCount:number}}
   */
  verify(promptText, shot = {}) {
    const issues = [];
    // 【v2.9.0-fix】交付排版为"序号+独立行"（_formatNumberedFields 产物）时，
    // 行首序号会被多行字段体（如台词块）捕获造成误报；入口防御性剥离序号前缀，兼容两种排版
    const text = String(promptText || '').replace(/^\s*\d{1,2}\.\s*(?=【)/gm, '');
    const names = this._fieldNames(text);
    const isOpening = shot.sceneType === 'opening' || shot.shotId === 'SC00' || shot.shotId === 'S00';
    // 【v2.5.0】平台蓝图：台词速率/场景链校验按 Profile 分流（电影叙事 vs 社媒营销）
    const profile = resolveProfile(shot, shot.blueprint || {});
    const rateNormal = (profile.speechRate && profile.speechRate.normal) || SpeechRate.NORMAL;
    const rateLimit = (profile.speechRate && profile.speechRate.limit) || SpeechRate.LIMIT;
    // 【v2.5.0】英文平台按词计数：字幕语言为 en 且 Profile 提供词速率时切换计量口径，
    // 避免把英文台词当中文字符计算（"Done already." 13 字符≠13 字）
    const wordRate = (profile.subtitleLanguage === 'en' && profile.speechRateWords) || null;

    // 1. 字段完整性
    for (const f of REQUIRED_CONTENT) {
      if (!names.includes(f)) issues.push(`缺必备字段:${f}`);
    }
    if (isOpening) {
      for (const f of REQUIRED_OPENING_EXTRA) {
        if (!names.includes(f)) issues.push(`缺片头专属字段:${f}`);
      }
    }
    const expectedMin = isOpening ? 30 : 25;

    // 2. 长度口径
    const charCount = this._countChars(text);
    if (charCount > PromptLengthConfig.HARD_MAX) {
      issues.push(`长度超硬上限:${charCount}>${PromptLengthConfig.HARD_MAX}`);
    }
    if (charCount < PromptLengthConfig.REFINED_MIN) {
      issues.push(`长度低于精炼后下限:${charCount}<${PromptLengthConfig.REFINED_MIN}`);
    }

    // 3. 台词纪律
    const hasDialogueField = names.includes('台词');
    const expectsDialogue = this._shotExpectsDialogue(shot);
    if (expectsDialogue && !hasDialogueField) issues.push('数据层有台词但【台词】字段缺失');
    if (!expectsDialogue && hasDialogueField && !this._isEmptyShot(shot)) {
      // 数据层无台词但出现台词字段：LLM 可能虚构，记 issue（空镜走空镜分支）
      issues.push('数据层无台词但出现【台词】字段（疑似虚构）');
    }
    if (this._isEmptyShot(shot) && hasDialogueField) {
      const dlgBody = this._fieldBody(text, '台词');
      if (/说[:：]/.test(dlgBody)) issues.push('空镜出现实际台词内容（空镜禁虚构）');
    }

    // 4. 台词格式与速率
    if (hasDialogueField) {
      const dlgBody = this._fieldBody(text, '台词');
      const blocks = dlgBody.split(/\n/).map(l => l.trim()).filter(Boolean);
      let totalDialogueChars = 0;
      for (const block of blocks) {
        const m = block.match(/^\[(\d+)s-(\d+)s\]\s*(.+?)\s*[,，]\s*(.+?)\s*说[:：]\s*\\?["“](.+)\\?["”]\s*$/);
        if (!m) {
          issues.push(`台词格式不规范:${block.slice(0, 24)}`);
          continue;
        }
        const segSec = Math.max(1, parseInt(m[2], 10) - parseInt(m[1], 10));
        const cleanLine = m[5].replace(/[，。！？…—、；：""]/g, '');
        const units = wordRate
          ? cleanLine.replace(/[.,!?;:'"()\-—…]/g, ' ').split(/\s+/).filter(Boolean).length
          : cleanLine.length;
        totalDialogueChars += units;
        const segLimit = wordRate ? wordRate.limit : rateLimit;
        if (units / segSec > segLimit) {
          issues.push(`台词超速:${units}${wordRate ? '词' : '字'}/${segSec}s=${(units / segSec).toFixed(1)}${wordRate ? '词' : '字'}/秒>${segLimit}`);
        }
      }
      const duration = Number(shot.duration) || 0;
      const segNormal = wordRate ? wordRate.normal : rateNormal;
      if (duration > 0 && totalDialogueChars / segNormal > duration * SpeechRate.MAX_DIALOGUE_RATIO) {
        issues.push(`台词总占比超标:约${(totalDialogueChars / segNormal).toFixed(1)}s/${duration}s>${SpeechRate.MAX_DIALOGUE_RATIO * 100}%`);
      }
    }

    // 【v2.5.0】社媒营销场景链：画面文字设计 + 合规阻断
    if (isSocialCommerce(profile)) {
      // 1. 画面文字设计字段在场（营销镜头的文字层是转化武器，缺失即问题）
      if (!names.includes('画面文字设计') && !isOpening) {
        issues.push('社媒营销镜头缺【画面文字设计】字段');
      }
      // 2. CTA 纪律：平台要求 CTA 且为尾镜时，CTA 收尾字必须在场
      if (profile.cta && profile.cta.required && shot.isFinal) {
        const textDesign = this._fieldBody(text, '画面文字设计');
        if (!/CTA收尾字/.test(textDesign)) issues.push('尾镜缺 CTA 收尾字（平台规则强制）');
      }
      // 3. 文字时间戳不得超出镜头时长
      if (names.includes('画面文字设计')) {
        const td = this._fieldBody(text, '画面文字设计');
        const duration = Number(shot.duration) || 0;
        const re = /\[(\d+)s-(\d+)s\]/g;
        let tm;
        while ((tm = re.exec(td)) !== null) {
          if (parseInt(tm[2], 10) > duration) issues.push(`画面文字时间戳越界:[${tm[1]}s-${tm[2]}s]>镜头${duration}s`);
        }
        // 4. 花字单条 ≤12 字（移动端 1 秒可读上限）
        const fm = td.match(/卖点花字\[[^\]]*\]\s*"([^"]*)"/g) || [];
        for (const f of fm) {
          const t = f.match(/"([^"]*)"/);
          if (t && t[1].length > 12) issues.push(`卖点花字超 12 字:"${t[1]}"`);
        }
        // 5. 安全区声明
        if (!/安全区/.test(td)) issues.push('画面文字设计缺安全区声明');
      }
      // 6. 营销合规闸机（阻断式）
      const compliance = new MarketingComplianceGuard().check(text, {
        lang: profile.subtitleLanguage === 'en' ? 'en' : (profile.subtitleLanguage === 'zh' ? 'zh' : 'both')
      });
      for (const hit of compliance.hits) {
        issues.push(`合规阻断[${hit.level}] ${hit.field}字段命中"${hit.word}":${hit.reason}`);
      }
      // 7. 【v2.6.0 P1-4】商品锚点纪律：营销镜头商品必须实拍绑定，禁止虚构外观
      if (!isOpening) {
        if (!names.includes('商品锚点')) {
          issues.push('社媒营销镜头缺【商品锚点】字段');
        } else {
          const anchor = this._fieldBody(text, '商品锚点');
          if (!/实拍绑定（[A-Z0-9]+-[A-Z]+-\d{3}）/.test(anchor)) issues.push('【商品锚点】缺有效英雄照实拍绑定编号（禁止虚构商品外观）');
          if (!/LOGO锚点/.test(anchor)) issues.push('【商品锚点】缺 LOGO 锚点');
          if (!/特写锚点/.test(anchor)) issues.push('【商品锚点】缺卖点特写锚点');
        }
        if (!names.includes('商品一致性')) issues.push('社媒营销镜头缺【商品一致性】字段');
      }
      // 8. 【v2.6.0 P1-6】配乐纪律：卡点映射 + 版权红线 + 尾镜高潮对齐
      if (!isOpening) {
        if (!names.includes('配乐')) {
          issues.push('社媒营销镜头缺【配乐】字段');
        } else {
          const bgm = this._fieldBody(text, '配乐');
          if (/《[^》]+》/.test(bgm)) issues.push('【配乐】指定具体曲目（版权红线：只写风格类型与卡点策略）');
          if (!/卡点映射/.test(bgm)) issues.push('【配乐】缺卡点映射');
          if (!/版权策略/.test(bgm)) issues.push('【配乐】缺版权策略声明');
          if (shot.isFinal && !/高潮点对齐/.test(bgm)) issues.push('尾镜【配乐】缺高潮点对齐声明');
          const bgmDuration = Number(shot.duration) || 0;
          const bre = /T(\d+)s/g;
          let bm;
          while ((bm = bre.exec(bgm)) !== null) {
            if (parseInt(bm[1], 10) > bgmDuration) issues.push(`【配乐】卡点时间戳越界:T${bm[1]}s>镜头${bgmDuration}s`);
          }
        }
      }
    }

    // 5. 必备锚点
    for (const f of ['时间轴', '情绪', '负面约束', '角色一致性']) {
      if (!names.includes(f)) issues.push(`缺锚点字段:${f}`);
    }

    // 6. 情绪可见部位
    if (names.includes('情绪')) {
      const mood = this._fieldBody(text, '情绪');
      if (!EMOTION_VISIBLE_PATTERN.test(mood)) {
        issues.push('【情绪】缺可见部位微动作描述（疑似关键词式写法）');
      }
    }

    return {
      pass: issues.length === 0,
      issues,
      fieldCount: names.length,
      expectedMin,
      charCount
    };
  }

  _fieldNames(text) {
    const out = [];
    const re = /【([^【】]{1,12})】/g;
    let m;
    while ((m = re.exec(text)) !== null) out.push(m[1]);
    return out;
  }

  _fieldBody(text, name) {
    const re = new RegExp('【' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '】([^【]*)');
    const m = text.match(re);
    if (!m) return '';
    // 剥掉字段分隔符尾巴（' | ' 分隔格式下，捕获段会带上一个分隔符残留）
    return m[1].replace(/[\s|]+$/, '');
  }

  _countChars(text) {
    return String(text || '').length;
  }

  _shotExpectsDialogue(shot) {
    const blocks = shot.dialogueBlocks || shot.dialogues || shot.dialogue || [];
    if (Array.isArray(blocks)) return blocks.length > 0;
    return !!blocks;
  }

  _isEmptyShot(shot) {
    const c = shot.character;
    // 未提供角色信息不视为空镜（空镜判定以数据层显式标记为准，宁缺勿滥）
    if (c === undefined || c === null) return false;
    if (typeof c === 'string') return c === 'NONE' || c.trim() === '';
    if (typeof c === 'object' && (c.name === 'NONE' || c.empty === true)) return true;
    return false;
  }

  /**
   * 【v2.9.0 新增】作品级交付校验（营销包纪律）
   * 单镜校验 verify() 只能看一棵树，本方法看整片森林：
   *   1. 作品必须含片头镜头（sceneType=opening 或 S00/SC00）——执行纪律硬性要求，
   *      营销片同样适用（片头豁免营销场景链字段，由 fusion agent 分支保证）
   *   2. 单镜时长必须落在平台蓝图时长带内
   *   3. 镜头数 >2 时禁止全部同长（时长分配器未生效的典型特征）
   *   4. 总时长与 brief 目标时长容差 ±15%
   * @param {Array} shots 作品镜头数组 [{shotId, sceneType, duration, platform}]
   * @param {object} [options] { platform, targetDuration }
   * @returns {{pass:boolean, issues:string[]}}
   */
  verifyPackage(shots = [], options = {}) {
    const issues = [];
    const list = Array.isArray(shots) ? shots : [];
    if (list.length === 0) {
      return { pass: false, issues: ['作品镜头为空'] };
    }

    // 1. 片头镜头在场
    const hasOpening = list.some(s =>
      s.sceneType === 'opening' || s.shotId === 'S00' || s.shotId === 'SC00');
    if (!hasOpening) {
      issues.push('作品缺片头镜头（执行纪律：每部作品必须含片头，含主/副标题与片头动效5专属字段）');
    }

    // 2. 蓝图时长带
    const profile = resolveProfile(list[0] || {}, options.blueprint || {});
    const band = (options.platform ? resolveProfile({ platform: options.platform }) : profile).shotDuration;
    if (band) {
      for (const s of list) {
        const d = Number(s.duration) || 0;
        if (d > 0 && (d < band.min || d > band.max)) {
          issues.push(`镜头${s.shotId}时长${d}s越出蓝图时长带[${band.min}-${band.max}]`);
        }
      }
    }

    // 3. 禁止全部同长
    const durations = list.map(s => Number(s.duration) || 0).filter(d => d > 0);
    if (durations.length > 2 && new Set(durations).size === 1) {
      issues.push(`全部${durations.length}个镜头时长相同（${durations[0]}s）：时长分配机制未生效，禁止手写均分`);
    }

    // 4. 总时长容差
    if (Number(options.targetDuration) > 0) {
      const total = durations.reduce((a, b) => a + b, 0);
      const target = Number(options.targetDuration);
      if (Math.abs(total - target) / target > 0.15) {
        issues.push(`总时长${total}s与目标${target}s偏差超过±15%`);
      }
    }

    return { pass: issues.length === 0, issues };
  }
}

module.exports = { PromptDeliveryGuard };
