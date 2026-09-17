/**
 * 领域中兜底素材唯一真源
 * 所有"写实校验触发后的场景/动作替换"必须从此处读取。
 * 
 * 铁律：本文件内容不得包含任何项目特定元素（医院/警服/神话角色等）。
 * 写新兜底素材时自问：这个描述放进"家庭聚会/商业广告/旅行vlog"里违和吗？违和就不许进。
 */
const FALLBACK_SCENES = [
  '室内明亮空间,白色顶灯均匀照明,浅色墙面挂有无文字图形装饰画,木质桌面带有细微使用痕迹,地面浅灰色地板',
  '现代开放式走廊,冷白色LED光源从顶部连续排列向下照射,无文字指示标识,地面浅色抛光瓷砖,墙面纯白涂层',
  '简约室内房间,白色墙面悬挂无文字示意图,桌面摆放日常器物,窗户透入自然光,浅色窗帘半掩',
  '开放式公共大厅,嵌入式灯带洒下柔和暖白光,接待台后方排列无文字图形展板,前方沙发与茶几,地面灰色哑光瓷砖'
];

const FALLBACK_ACTIONS = [
  '镜头缓慢推近,${name}站立桌前,自然手势讲解,眼神注视镜头,轮廓在顶光下清晰',
  '稳定机位中景,${name}沿走廊缓步前行,侧头指向远方,行人从背景自然走过',
  '手持微晃跟拍,${name}靠近窗边,手指轻触墙面挂画,顶光在头顶形成柔和光晕',
  '固定机位中景,${name}坐于沙发边缘,双手交叠置于膝上,灯带在身后形成均匀轮廓光',
  '缓慢后拉全景,${name}站立大厅中央,转身面向镜头,台面反射冷白色光源'
];

/**
 * 【v2.1.11-P1 修复】兜底动作渲染：用真实角色名替换 ${name}，防止"示例角色"占位符泄漏进 prompt
 * @param {string} name - 角色名（从 shot.character 提取）
 * @param {number} index - 索引（从 shotId 提取）
 * @returns {string} 渲染后的兜底动作描述
 */
function renderFallbackAction(name = '人物', index = 0) {
  const raw = FALLBACK_ACTIONS[index % FALLBACK_ACTIONS.length];
  return raw.replace(/\$\{name\}/g, name);
}

module.exports = {
  FALLBACK_SCENES,
  FALLBACK_ACTIONS,
  renderFallbackAction
};
