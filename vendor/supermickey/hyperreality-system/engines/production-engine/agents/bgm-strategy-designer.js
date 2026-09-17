'use strict';

/**
 * BgmStrategyDesigner（配乐策略设计器）
 * ------------------------------------------------------------
 * 【v2.6.0 新增】社媒营销包 SocialPack · P1-6
 *
 * 【音频】字段承载音效与环境声；【配乐】字段承载 BGM 策略——
 * 营销片的节奏骨架。两条纪律：
 *   1) 卡点对齐：BGM 节拍映射到镜头时间轴拍点（生成/翻页/CTA 定格瞬间）
 *   2) 版权红线：只写"风格类型与卡点策略"，禁止指定任何受版权保护的具体曲目
 *      （AI 生成同风格曲目无版权风险；指定原曲名=直接侵权）
 *
 * 输出要素（守卫可校验）：
 *   风格类型 / BPM / 卡点映射（T秒:事件→重拍）/ 人声与声床配比（台词 ducking）/
 *   高潮点对齐（尾镜 CTA 强制）/ 版权策略声明
 *
 * 平台热歌类型基线（类型而非曲目）：
 *   tiktok: phonk / lo-fi house / sped-up pop（140-150 BPM 快节奏档）
 *   douyin: 国风电子 / 卡点舞曲 / 热榜 BGM 类型
 *   xiaohongshu: chill / city pop / 轻爵士（90-110 BPM 氛围档）
 *   instagram-reels: deep house / indie electronic
 */

const PLATFORM_BGM_STYLES = {
  tiktok: { styles: ['phonk 鼓点电子', 'lo-fi house', '加速流行电子'], bpm: [138, 148] },
  douyin: { styles: ['国风电子卡点', '卡点舞曲', '热榜节奏型 BGM'], bpm: [128, 140] },
  xiaohongshu: { styles: ['chill 氛围电子', 'city pop', '轻爵士'], bpm: [92, 108] },
  'instagram-reels': { styles: ['deep house', 'indie electronic'], bpm: [118, 128] },
  cinematic: { styles: ['电影配乐氛围声床'], bpm: [70, 90] }
};

class BgmStrategyDesigner {
  /**
   * 生成【配乐】字段
   * @param {object} shot 镜头数据（shotId/duration/isFinal/dialogueBlocks/timelineBeats）
   * @param {object} profile 平台 Profile
   * @param {object} brief 营销 Brief（goal/brand）
   * @returns {{fieldText:string, strategy:object}}
   */
  design(shot = {}, profile = {}, brief = {}) {
    const duration = Number(shot.duration) || 5;
    const key = profile.platformKey || 'tiktok';
    const base = PLATFORM_BGM_STYLES[key] || PLATFORM_BGM_STYLES.tiktok;
    const style = this._pick(base.styles, shot.shotId);
    const bpm = this._pickBpm(base.bpm, shot.shotId);
    const beatMap = this._buildBeatMap(shot, duration);
    const hasDialogue = Array.isArray(shot.dialogueBlocks) && shot.dialogueBlocks.length > 0;
    const ducking = hasDialogue
      ? '台词出现时声床自动 ducking -6dB，人声清晰度优先，台词间隙鼓点回到前景'
      : '无人声，鼓点与旋律全程前景，声床饱满';
    const climax = shot.isFinal
      ? `高潮点对齐：音乐在 CTA 定格帧（约 T${Math.max(0, duration - 2)}s）收束至最强拍后戛然而止，留 0.3s 静默强化 CTA 记忆点`
      : `能量曲线随镜头推进上行，段落末拍（T${duration}s）预留下一镜切入重拍`;

    const strategy = { style, bpm, beatMap, ducking, climax, copyright: 'AI 生成风格类似曲目，零版权风险' };
    const fieldText = [
      `风格类型：${style}（平台热歌类型，不指定具体曲目）`,
      `BPM：${bpm}`,
      `卡点映射：${beatMap}`,
      `人声与声床配比：${ducking}`,
      climax,
      '版权策略：AI 生成风格类似曲目，零版权风险，禁止引用任何受版权保护的具体曲目'
    ].join('；');
    return { fieldText, strategy };
  }

  /** 从镜头时间轴/台词块构建卡点映射（确定性推导，非虚构） */
  _buildBeatMap(shot, duration) {
    const beats = [];
    const seen = new Set();
    const dlg = Array.isArray(shot.dialogueBlocks) ? shot.dialogueBlocks : [];
    // 【v2.9.0-fix】start 缺失时按块序号均摊估算 + 去重，
    // 修复多台词块镜头卡点映射全部塌缩为 "T0s:台词起" 重复文案的问题
    dlg.forEach((b, i) => {
      const est = Math.round((duration / Math.max(1, dlg.length)) * i);
      const s = Math.max(0, Math.min(duration, Number(b.start) || est));
      const line = `T${s}s:台词起→轻鼓点垫底`;
      if (!seen.has(line)) { seen.add(line); beats.push(line); }
    });
    if (Array.isArray(shot.timelineBeats)) {
      for (const t of shot.timelineBeats) {
        const sec = Math.max(0, Math.min(duration, Number(t.t) || 0));
        const line = t.event ? `T${sec}s:${t.event}→重拍` : null;
        if (line && !seen.has(line)) { seen.add(line); beats.push(line); }
      }
    }
    if (!beats.length) beats.push(`T0s:进场重拍`, `T${duration}s:段落末拍衔接`);
    return beats.slice(0, 4).join('；');
  }

  _pick(arr, seed) {
    const h = String(seed || 'S0').split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    return arr[h % arr.length];
  }

  _pickBpm([lo, hi], seed) {
    const h = String(seed || 'S0').split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    return lo + (h % Math.max(1, hi - lo + 1));
  }
}

module.exports = { BgmStrategyDesigner, PLATFORM_BGM_STYLES };
