// boundary-prompt-templates.js
// 跨集内容边界提示词模板
// 为ScriptGenerator提供标准化的多集边界约束提示词

/**
 * 构建跨集边界约束提示词
 * @param {object} params - 参数
 * @param {number} params.episodeIndex - 当前集编号（1-based）
 * @param {number} params.totalEpisodes - 总集数
 * @param {object} params.seriesPlan - 系列内容规划
 * @param {string} params.previousSummary - 前一集摘要（可选）
 * @returns {string} 边界约束提示词
 */
function buildBoundaryPrompt({ episodeIndex, totalEpisodes, seriesPlan, previousSummary }) {
  const currentEpisode = seriesPlan?.episodes?.[episodeIndex - 1];
  if (!currentEpisode) {
    // 如果没有详细规划，回退到简单约束
    return buildSimpleBoundaryPrompt({ episodeIndex, totalEpisodes });
  }

  const position = episodeIndex === 1 ? 'first' : 
                   episodeIndex === totalEpisodes ? 'last' : 'middle';

  switch (position) {
    case 'first':
      return buildFirstEpisodePrompt({ episodeIndex, totalEpisodes, currentEpisode, seriesPlan });
    case 'middle':
      return buildMiddleEpisodePrompt({ episodeIndex, totalEpisodes, currentEpisode, seriesPlan, previousSummary });
    case 'last':
      return buildLastEpisodePrompt({ episodeIndex, totalEpisodes, currentEpisode, seriesPlan, previousSummary });
    default:
      return buildSimpleBoundaryPrompt({ episodeIndex, totalEpisodes });
  }
}

/**
 * 第一集提示词模板
 */
function buildFirstEpisodePrompt({ episodeIndex, totalEpisodes, currentEpisode, seriesPlan }) {
  const laterEpisodes = seriesPlan.episodes
    .filter((_, i) => i > episodeIndex - 1)
    .map((ep, i) => `  第${ep.index}集：${ep.title}（将讲：${ep.coreTopics?.join('、') || '待定'}）`)
    .join('\n');

  return `
## 【跨集内容边界约束 — 第1集/共${totalEpisodes}集】（极其重要 - 违反则本集作废）

你是本系列第1集的编剧。本系列共${totalEpisodes}集，后续集规划如下：
${laterEpisodes}

✅ 本集核心任务（必须完成）：
${currentEpisode.mustCover?.map(t => `  - ${t}`).join('\n') || '  - ' + currentEpisode.title}

🟡 共享缓冲区（可以提及，但每处严格≤15秒，一句话带过）：
${currentEpisode.canMention?.map(t => `  - ${t}`).join('\n') || '  - 与主题相关的背景信息（一句话）'}

🔴 绝对禁区（本集不可深入，如果剧情需要提及必须≤5秒，不给出细节）：
${currentEpisode.mustNotCover?.map(t => `  - ${t}`).join('\n') || '  - 后续集将要详细讲解的内容'}

⚠️ 关键规则：
1. 本集只讲本集核心任务，不跨集
2. **严禁在结尾预告"下一集讲什么"** — 用自然收束结尾，如"这是第一步，了解症状才能早发现"
3. **严禁说"敬请期待/未完待续/下次分享"**等引导语
4. 如果其他集的内容需要提及，严格控制在15秒内，一句话带过
5. 不要暗示"还有后续内容"，每集都是完整的独立篇章
`;
}

/**
 * 中间集提示词模板
 */
function buildMiddleEpisodePrompt({ episodeIndex, totalEpisodes, currentEpisode, seriesPlan, previousSummary }) {
  // 【P2-8 修复】防御越界：第一集无前一集
  const prevEpisode = episodeIndex > 1 ? seriesPlan.episodes[episodeIndex - 2] : null;
  const laterEpisodes = seriesPlan.episodes
    .filter((_, i) => i > episodeIndex - 1)
    .map((ep, i) => `  第${ep.index}集：${ep.title}（将讲：${ep.coreTopics?.join('、') || '待定'}）`)
    .join('\n');

  const prevEpisodeInfo = prevEpisode
    ? `- 第${prevEpisode.index}集（已讲完）：${prevEpisode.title}\n  已覆盖：${previousSummary || prevEpisode.coreTopics?.join('、') || '详见前集'}`
    : '- 本集为系列首集，无前序内容';

  const prevEpisodeRules = prevEpisode
    ? `1. 第${prevEpisode.index}集已详细讲过${prevEpisode.mustCover?.join('、') || prevEpisode.title}，本集不需要重复展开\n2. 如果提到第${prevEpisode.index}集的内容，用"前面讲过"一句话带过即可`
    : '1. 本集为系列首集，无需回顾前序内容';

  return `
## 【跨集内容边界约束 — 第${episodeIndex}集/共${totalEpisodes}集】（极其重要 - 违反则本集作废）

你是本系列第${episodeIndex}集的编剧。系列上下文：
${prevEpisodeInfo}
- 第${episodeIndex}集（本集）：${currentEpisode.title}
  核心任务：${currentEpisode.coreTopics?.join('、') || currentEpisode.title}
- 后续集规划：
${laterEpisodes}

✅ 本集核心任务（必须完成）：
${currentEpisode.mustCover?.map(t => `  - ${t}`).join('\n') || '  - ' + currentEpisode.title}

🟡 共享缓冲区（可以提及，但每处严格≤15秒，一句话带过）：
${currentEpisode.canMention?.map(t => `  - ${t}`).join('\n') || '  - 与主题相关的背景信息（一句话）'}

🔴 绝对禁区（本集不可深入，如果提及必须≤5秒）：
${currentEpisode.mustNotCover?.map(t => `  - ${t}`).join('\n') || '  - 其他集已讲或待讲的内容'}

⚠️ 关键规则：
${prevEpisodeRules}
3. **严禁在结尾预告"下一集讲什么"** — 用自然收束结尾
4. **严禁说"敬请期待/未完待续/下次分享"**等引导语
5. 后续集内容不要提前展开，只讲本集核心任务
6. 每集都是完整的独立篇章，不要暗示"还有后续"
`;
}

/**
 * 最后一集提示词模板
 */
function buildLastEpisodePrompt({ episodeIndex, totalEpisodes, currentEpisode, seriesPlan, previousSummary }) {
  const prevEpisodes = seriesPlan.episodes
    .filter((_, i) => i < episodeIndex - 1)
    .map(ep => `  - 第${ep.index}集：${ep.title}（已覆盖：${ep.coreTopics?.join('、') || '详见该集'}）`)
    .join('\n');

  return `
## 【跨集内容边界约束 — 第${episodeIndex}集（最后一集）/共${totalEpisodes}集】（极其重要 - 违反则本集作废）

你是本系列最后一集的编剧。前面已讲完的内容：
${prevEpisodes}

✅ 本集核心任务（必须完成）：
${currentEpisode.mustCover?.map(t => `  - ${t}`).join('\n') || '  - ' + currentEpisode.title}

🟡 共享缓冲区（可以提及，但每处严格≤15秒，一句话带过）：
${currentEpisode.canMention?.map(t => `  - ${t}`).join('\n') || '  - 前面集的核心结论（一句话回顾）'}

🔴 绝对禁区（本集不可深入）：
${currentEpisode.mustNotCover?.map(t => `  - ${t}`).join('\n') || '  - 前面集已详细讲过的内容'}

⚠️ 关键规则：
1. 前面集已详细讲过的内容，本集不需要重复展开
2. 如果回顾前面集的内容，用"前面我们讲过"一句话带过
3. 本集是最后一集，**不需要预告任何后续内容**
4. 结尾自然收束即可，如"希望这些知识能帮到大家"或"掌握这些方法，就能有效预防"
5. 不要暗示"还有后续课程/系列"
`;
}

/**
 * 简单回退提示词（当没有详细规划时）
 */
function buildSimpleBoundaryPrompt({ episodeIndex, totalEpisodes }) {
  return `
## 【系列作品约束 — 第${episodeIndex}集/共${totalEpisodes}集】
- 只讲本集主题，不跨集（不重复已讲内容，不提前讲后续内容）
- **严禁在台词或叙述中提及后续集数内容**（如"下一集""下次再说"）
- **严禁在结尾预告或暗示下一集内容**
- **严禁说"敬请期待/未完待续"**
- 用自然收束结尾，不要预告
${episodeIndex > 1 ? '- 本集无片头标题画面（片头仅第一集有）' : ''}
`;
}

/**
 * 从metadata提取系列规划信息
 * @param {object} metadata - 用户意图metadata
 * @returns {object|null} 系列规划对象
 */
function extractSeriesPlan(metadata) {
  if (!metadata) return null;

  // 优先从 metadata.series 提取
  if (metadata.series && metadata.series.episodes) {
    return {
      totalEpisodes: metadata.series.totalEpisodes,
      episodes: metadata.series.episodes.map((ep, i) => ({
        index: i + 1,
        title: ep.title || `第${i + 1}集`,
        coreTopics: ep.coreTopics || [],
        mustCover: ep.boundary?.mustCover || ep.coreTopics || [],
        canMention: ep.boundary?.canMention || [],
        mustNotCover: ep.boundary?.mustNotCover || []
      }))
    };
  }

  // 从 metadata.seriesContentPlan 提取（【v2.1.4-fix13-审计修复】增加结构适配）
  if (metadata.seriesContentPlan) {
    const plan = metadata.seriesContentPlan;
    return {
      seriesTitle: plan.seriesTitle || plan.title || '',
      totalEpisodes: plan.totalEpisodes,
      episodes: (plan.episodes || []).map(ep => ({
        index: ep.episodeIndex || ep.index || 1,
        title: ep.title || `第${ep.episodeIndex || ep.index || 1}集`,
        coreTopics: ep.coreTopics || (ep.contentScope ? ep.contentScope.split(/[，,；;]/) : []),
        mustCover: ep.mustCover || (ep.contentScope ? ep.contentScope.split(/[，,；;]/) : [ep.title]),
        canMention: ep.canMention || [],
        mustNotCover: ep.mustNotCover || (ep.excludedContent ? ep.excludedContent.split(/[，,；;]/) : [])
      }))
    };
  }

  // 兼容旧格式：从 episodeTitles 构造简单规划
  if (metadata.total_episodes > 1 || metadata.series?.totalEpisodes > 1) {
    const totalEpisodes = metadata.total_episodes || metadata.series?.totalEpisodes;
    const episodeTitles = metadata.series?.episodeTitles || metadata.episode_titles || [];
    return {
      totalEpisodes,
      episodes: Array.from({ length: totalEpisodes }, (_, i) => ({
        index: i + 1,
        title: episodeTitles[i] || `第${i + 1}集`,
        coreTopics: [],
        mustCover: [],
        canMention: [],
        mustNotCover: []
      }))
    };
  }

  return null;
}

/**
 * 从metadata提取前一集摘要
 * @param {object} metadata - 用户意图metadata
 * @returns {string|null} 前一集摘要
 */
function extractPreviousSummary(metadata) {
  if (!metadata) return null;
  return metadata.series?.previousSummary || 
         metadata.previous_episode_summary || 
         null;
}

module.exports = {
  buildBoundaryPrompt,
  extractSeriesPlan,
  extractPreviousSummary
};