/**
 * 文件: systems/final-shot-standardizer.js
 * 作用：在最终输出前，对 S00 + 内容镜头做一次统一中文标准化
 * 生成一个稳定的 标准镜头清单
 */

const {
  归一化全片镜头,
  校验镜头字段
} = require('./unified-shot-schema-zh');

function 标准化最终输出(stages, input = {}) {
  const storyboardShots = stages?.storyboard?.shots || [];
  const renderShots = Array.isArray(stages?.style)
    ? stages.style
    : (Array.isArray(stages?.render) ? stages.render : []);
  const charactersMap = stages?.characters || {};

  // 片头
  const openingShot = storyboardShots.find(s => s.id === 'S00' || s.shotId === 'S00' || s.isOpening);

  // 内容镜头：优先 merge render/style 与 storyboard
  const contentShots = storyboardShots
    .filter(s => !(s.id === 'S00' || s.shotId === 'S00' || s.isOpening))
    .map(sb => {
      const rr = renderShots.find(r =>
        (r.shotId && r.shotId === sb.id) ||
        (r.id && r.id === sb.id)
      ) || {};
      return {
        ...sb,
        ...rr,
        id: sb.id || rr.id,
        shotId: rr.shotId || sb.id
      };
    });

  const 标准镜头清单 = 归一化全片镜头({
    openingShot,
    contentShots,
    charactersMap,
    defaultTitle: input.projectName || input.title || '',
    defaultSubtitle: input.topic || ''
  });

  const 校验结果 = 标准镜头清单.map(镜头 => ({
    镜头编号: 镜头.镜头编号,
    ...校验镜头字段(镜头)
  }));

  return {
    标准镜头清单,
    校验结果,
    全部通过: 校验结果.every(x => x.valid)
  };
}

module.exports = { 标准化最终输出 };
