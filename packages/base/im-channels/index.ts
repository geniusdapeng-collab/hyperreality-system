/**
 * @workloom/base/im-channels —— IM 通道域（D14/B11）
 * 边界：本包是纯服务层（不碰 HTTP/dsh）；dsh-im 为 L1 通道适配层（消息进出 dsh 会话），
 *       本包承载 WorkLoom 侧通道护城河：注册表对账 / 入站五元化 / 审批卡片出站 / 手势回调
 */
export * from "./registry.js";
export * from "./inbound.js";
export * from "./cards.js";
export * from "./callback.js";
