/**
 * camera-coherence — 运镜协调性系统
 *
 * 模块地图：
 *   shot-scale-matrix       景别转换语法矩阵（七级景别 + 冲击切换白名单）
 *   coherence-validator     全片运镜规则校验（R1-R7，纯规则零LLM）
 *   choreography-context    邻镜上下文构建（VL/PromptFusion prompt 注入）
 *
 * @module camera-coherence
 */

const scaleMatrix = require('./shot-scale-matrix');
const { CoherenceValidator } = require('./coherence-validator');
const choreography = require('./choreography-context');

module.exports = {
  ...scaleMatrix,
  CoherenceValidator,
  ...choreography
};
