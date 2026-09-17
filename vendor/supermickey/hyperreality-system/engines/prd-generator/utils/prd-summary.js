/**
 * PRD 摘要生成工具
 * 供用户快速审阅，5 秒理解项目核心
 */
function generateSummary(prd) {
  if (!prd) return {};
  
  const projectName = prd.projectDefinition?.projectName || '未命名';
  const productType = prd.productPositioning?.productType || '未指定';
  const genre = prd.productPositioning?.genre || '未指定';
  const duration = prd.productPositioning?.targetDuration || 52;
  
  const sceneCount = prd.scenePlan?.scenes?.length || 0;
  const shotCount = prd.scenePlan?.shotMapping?.reduce((s, m) => s + (m.estimatedShots || 0), 0) || 0;
  
  const characterNames = prd.characterSystem?.characters?.map(c => c.name).filter(Boolean) || [];
  
  const qualityTier = prd.budgetProfile?.qualityTier || 'standard';
  
  const hook = prd.creativeCore?.creativeHook || '未指定';
  
  const deliverables = prd.deliveryStandard?.deliverables?.filter(d => d.priority === 'required').map(d => d.item) || [];
  
  return {
    title: projectName,
    type: `${productType} | ${genre}`,
    duration: `${duration}秒`,
    scenes: `${sceneCount} 场景 / ${shotCount} 预估镜头`,
    characters: characterNames.join(', ') || '无角色',
    qualityTier: qualityTier,
    keyHook: hook.length > 50 ? hook.slice(0, 50) + '...' : hook,
    deliverables: deliverables,
    
    // 人类可读摘要
    humanReadable: `${projectName} (${productType}/${genre}, ${duration}秒) - ` +
      `${sceneCount}场景/${shotCount}镜头, ${characterNames.length}角色, ` +
      `品质档:${qualityTier}, 核心钩子:${hook.length > 30 ? hook.slice(0, 30) + '...' : hook}`
  };
}

module.exports = { generateSummary };
