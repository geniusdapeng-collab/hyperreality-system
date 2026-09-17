/**
 * ID 生成工具
 * - event_id：由数据库 seq 生成后用 formatEventId 格式化（服务端单调递增 + 幂等键，L1.4）
 * - 业务可读编号：MEM-041（成员）、T-102（线程）等 → makeReadableId
 * - 技术主键：newId（uuid 短码，租户内唯一即可）
 */
import { randomUUID } from "node:crypto";

/** seq → E-88xx（PRD 展示口径） */
export function formatEventId(seq: number | bigint): string {
  return `E-${seq}`;
}

/** 业务可读编号：makeReadableId("MEM", 41) → "MEM-041" */
export function makeReadableId(prefix: string, n: number): string {
  return `${prefix}-${String(n).padStart(3, "0")}`;
}

/** 技术主键：newId("APR") → "APR-3f9a2c71" */
export function newId(prefix: string): string {
  return `${prefix}-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

/** 完整 uuid（需要全局唯一时使用，如 tenant/workspace 主键） */
export function newUuid(): string {
  return randomUUID();
}
