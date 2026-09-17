function normalizeForCompare(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function jaccardSimilarity(a, b) {
  const sa = new Set(normalizeForCompare(a).split(' ').filter(Boolean));
  const sb = new Set(normalizeForCompare(b).split(' ').filter(Boolean));
  if (!sa.size || !sb.size) return 0;

  let intersection = 0;
  for (const x of sa) {
    if (sb.has(x)) intersection++;
  }
  const union = new Set([...sa, ...sb]).size;
  return union ? intersection / union : 0;
}

function rewriteActionFromScene(scene, characterText) {
  return [
    'performance-focused motion only',
    characterText || 'character identity continuity preserved',
    'measured breathing rhythm',
    'subtle shoulder and neck tension',
    'controlled head turn',
    'micro facial response',
    'eye focus shift',
    'muscle restraint',
    'posture transfer of weight',
    'delayed reaction beat'
  ].join(', ');
}

function dedupeShotFields(data) {
  if (!data || typeof data !== 'object') return data;

  const sceneActionSim = jaccardSimilarity(data.Scene, data.Action);
  if (sceneActionSim >= 0.72) {
    data.Action = rewriteActionFromScene(data.Scene, data.Character);
  }

  const cameraSceneSim = jaccardSimilarity(data.Camera, data.Scene);
  if (cameraSceneSim >= 0.72) {
    data.Camera = '电影级航拍转中景下降, 刻意镜头运动, 缓慢推近与焦点迁移, 稳定画框配受控视差与从容节奏';
  }

  const lightingSceneSim = jaccardSimilarity(data.Lighting, data.Scene);
  if (lightingSceneSim >= 0.72) {
    data.Lighting = '暖冷双星光照, 矿物反射补光, 大气薄雾, 体积光柱, 柔和阴影层次, 发光边缘分离, 丰富材质响应';
  }

  return data;
}

module.exports = {
  dedupeShotFields,
  jaccardSimilarity
};
