'use strict';

/**
 * AngleCatalog — 定妆照角度目录
 * ------------------------------------------------------------
 * 角色与商品定妆照的角度/视角标准化定义。
 *
 * 角色按重要性三档分配角度包：
 *   lead       主角  —— 8 角度全集（形象建立+表演覆盖）
 *   supporting 配角  —— 4 角度（识别度+基本表演）
 *   cameo      客串  —— 2 角度（识别度即可）
 *
 * 商品固定 5 视角（电商级定妆标准）：
 *   主视觉45度 / 正面平视 / 侧面轮廓 / 细节特写 / 使用场景
 *
 * 每个角度定义包含：
 *   id          角度标识（用于文件命名）
 *   name        中文名称
 *   purpose     用途说明（该角度服务什么镜头需求）
 *   framing     构图指令（注入生成 prompt）
 *   priority    生成优先级（1 最高，资源紧张时按此裁剪）
 */

// ========== 角色角度库 ==========
const CHARACTER_ANGLES = {
  front_full: {
    id: 'front_full',
    name: '正面全身',
    purpose: '角色形象主锚点，全片一致性的基准参照',
    framing: '正面全身像，角色直立平视镜头，完整身形入画，四肢无裁切',
    priority: 1
  },
  side_full: {
    id: 'side_full',
    name: '侧面全身',
    purpose: '锁定侧轮廓与体态厚度，防止转身镜头形态漂移',
    framing: '正侧面全身像，角色90度侧身，轮廓线清晰完整',
    priority: 3
  },
  back_full: {
    id: 'back_full',
    name: '背面全身',
    purpose: '锁定背部结构与服饰细节，服务背影/离去镜头',
    framing: '正背面全身像，角色背对镜头直立，背部细节完整呈现',
    priority: 4
  },
  three_quarter: {
    id: 'three_quarter',
    name: '45度半身',
    purpose: '最常用叙事角度，兼顾面部与体态，服务对话镜头',
    framing: '45度侧身半身像，腰部以上入画，面部转向镜头',
    priority: 2
  },
  face_closeup: {
    id: 'face_closeup',
    name: '面部特写',
    purpose: '五官与表情的终极锚点，服务一切情绪特写镜头',
    framing: '面部特写，头肩入画，五官细节极致清晰，直视镜头',
    priority: 1
  },
  hand_detail: {
    id: 'hand_detail',
    name: '手部特写',
    purpose: '锁定手部/爪部/持物结构，服务道具交互镜头',
    framing: '手部特写，自然姿态与持物姿态各结构清晰，指节细节完整',
    priority: 5
  },
  action_pose: {
    id: 'action_pose',
    name: '动作姿态',
    purpose: '角色标志性动作定版，服务动态镜头的体态一致性',
    framing: '角色标志性动作姿态全身像，动态张力与身体结构同时清晰',
    priority: 3
  },
  emotion_closeup: {
    id: 'emotion_closeup',
    name: '情绪特写',
    purpose: '核心情绪表情定版，服务高潮戏的表情基准',
    framing: '面部情绪特写，呈现角色核心情绪状态，微表情层次清晰',
    priority: 4
  }
};

// 重要性档位 → 角度包（按 priority 排序）
const CHARACTER_TIER_PACKAGES = {
  lead: ['front_full', 'face_closeup', 'three_quarter', 'side_full', 'action_pose', 'back_full', 'emotion_closeup', 'hand_detail'],
  supporting: ['front_full', 'face_closeup', 'three_quarter', 'action_pose'],
  cameo: ['front_full', 'face_closeup']
};

// ========== 商品视角库 ==========
const PRODUCT_VIEWS = {
  hero_45: {
    id: 'hero_45',
    name: '主视觉45度',
    purpose: '商品定妆主图，海报与封面镜头的形象基准',
    framing: '商品45度俯视角主视觉，产品主体居中，完整轮廓入画，商业摄影布光',
    priority: 1
  },
  front_eye: {
    id: 'front_eye',
    name: '正面平视',
    purpose: '正面识别锚点，服务产品正对镜头的展示镜头',
    framing: '商品正面平视角度，对称构图，LOGO与正面细节完整清晰',
    priority: 1
  },
  side_profile: {
    id: 'side_profile',
    name: '侧面轮廓',
    purpose: '厚度与工艺轮廓锚点，服务旋转/扫过镜头',
    framing: '商品正侧面轮廓视角，侧面材质与工艺细节清晰',
    priority: 2
  },
  detail_macro: {
    id: 'detail_macro',
    name: '细节特写',
    purpose: '材质与做工证据，服务卖点特写镜头',
    framing: '商品核心卖点部位微距特写，材质纹理与工艺细节极致呈现',
    priority: 2
  },
  in_context: {
    id: 'in_context',
    name: '使用场景',
    purpose: '商品与短片世界观的融合验证，服务场景化镜头',
    framing: '商品置于短片典型场景中，环境光影与整体视觉风格统一，商品为视觉焦点',
    priority: 3
  }
};

const PRODUCT_VIEW_PACKAGE = ['hero_45', 'front_eye', 'side_profile', 'detail_macro', 'in_context'];

// ========== 服务/虚拟商品视角库（v2.10.0 新增） ==========
// 服务与虚拟商品无实物外观可抠图白底，定妆照以"品牌视觉+履约场景"为锚点
const SERVICE_VIEWS = {
  brand_hero: {
    id: 'brand_hero',
    name: '品牌主视觉',
    purpose: '服务品牌定妆主图，海报与封面镜头的形象基准',
    framing: '服务品牌主视觉定妆，LOGO/品牌色/官方视觉元素居中完整呈现，商业布光',
    priority: 1
  },
  service_scene: {
    id: 'service_scene',
    name: '履约场景',
    purpose: '服务过程的真实感锚点，服务演示镜头',
    framing: '服务履约过程场景（门店/上门/线上操作），环境与人物状态真实自然',
    priority: 1
  },
  ui_closeup: {
    id: 'ui_closeup',
    name: '界面特写',
    purpose: '软件/线上服务的功能证据，服务卖点特写镜头',
    framing: '官方界面/凭证/物料特写，界面元素与文字清晰可读，禁止虚构界面',
    priority: 2
  },
  staff: {
    id: 'staff',
    name: '人员形象',
    purpose: '到店/上门类服务的人员信任锚点',
    framing: '服务人员标准形象（制服/工牌/专业仪态），真实人像摄影',
    priority: 2
  },
  user_context: {
    id: 'user_context',
    name: '用户场景',
    purpose: '服务与用户世界观的融合验证，服务场景化镜头',
    framing: '用户享受服务的典型场景，环境光影与整体视觉风格统一',
    priority: 3
  }
};

const SERVICE_VIEW_PACKAGE = ['brand_hero', 'service_scene', 'ui_closeup', 'staff', 'user_context'];

/**
 * 取商品视角包（按商品类型分派：实物=商业摄影5视角；服务/虚拟=品牌履约5视角）
 * @param {string} [kind] physical|service（缺省按实物，向后兼容）
 * @returns {Array} 视角定义数组（按 priority 升序）
 */
function getServiceViewPackage() {
  return SERVICE_VIEW_PACKAGE
    .map(id => SERVICE_VIEWS[id])
    .filter(Boolean)
    .sort((a, b) => a.priority - b.priority);
}

/**
 * 取角色角度包
 * @param {string} tier lead|supporting|cameo
 * @returns {Array} 角度定义数组（按 priority 升序）
 */
function getCharacterAnglePackage(tier) {
  const ids = CHARACTER_TIER_PACKAGES[tier] || CHARACTER_TIER_PACKAGES.cameo;
  return ids
    .map(id => CHARACTER_ANGLES[id])
    .filter(Boolean)
    .sort((a, b) => a.priority - b.priority);
}

/**
 * 取商品视角包
 * @returns {Array} 视角定义数组（按 priority 升序）
 */
function getProductViewPackage() {
  return PRODUCT_VIEW_PACKAGE
    .map(id => PRODUCT_VIEWS[id])
    .filter(Boolean)
    .sort((a, b) => a.priority - b.priority);
}

module.exports = {
  CHARACTER_ANGLES,
  CHARACTER_TIER_PACKAGES,
  PRODUCT_VIEWS,
  PRODUCT_VIEW_PACKAGE,
  SERVICE_VIEWS,
  SERVICE_VIEW_PACKAGE,
  getCharacterAnglePackage,
  getProductViewPackage,
  getServiceViewPackage
};
