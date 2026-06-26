/**
 * 内容边界守卫 (Content Boundary Guard)
 * 
 * 职责：
 * - 检测并清除越界内容（预告下集、提前讲后续知识点等）
 * - 作为最后防线运行
 */

class ContentBoundaryGuard {
  constructor(logFn = console.log) {
    this.log = logFn;
  }

  /**
   * 强制过滤越界内容
   * @param {Array} shots - 镜头数组
   * @param {Object} blueprint - 剧本蓝图
   * @returns {Array} 清洗后的镜头数组
   */
  enforce(shots, blueprint) {
    const meta = blueprint.config?._metadata || blueprint._metadata || {};
    const isSeries = meta.isSeries || (meta.series?.totalEpisodes > 1) || (meta.total_episodes > 1);
    const noPreview = meta.noNextEpisodePreview || meta.no_next_episode_preview;

    if (!isSeries && !noPreview) return shots;

    const forbiddenPatterns = [
      /下一集/g, /下集/g, /后续.*介绍/g, /下次再说/g, /下次.*讲/g,
      /待.*续/g, /未完待续/g, /且听.*分解/g
    ];

    let violations = 0;
    const cleaned = shots.map(shot => {
      let prompt = shot.prompt || '';
      let fusionText = shot.fusionText || '';
      let changed = false;

      for (const pattern of forbiddenPatterns) {
        if (pattern.test(prompt)) {
          prompt = prompt.replace(pattern, '...');
          changed = true;
          violations++;
        }
        if (pattern.test(fusionText)) {
          fusionText = fusionText.replace(pattern, '...');
          changed = true;
          violations++;
        }
      }

      if (changed) {
        this.log('BOUNDARY-GUARD', `⚠️ 清除越界内容: ${shot.shotId}`);
      }
      return changed ? { ...shot, prompt, fusionText } : shot;
    });

    if (violations > 0) {
      this.log('BOUNDARY-GUARD', `✅ 共清除 ${violations} 处越界内容`);
    }
    return cleaned;
  }
}

module.exports = { ContentBoundaryGuard };
