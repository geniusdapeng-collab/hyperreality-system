/**
 * service-channels · C 端用户归一（resolveCUser）
 * 幂等 upsert：UNIQUE(workspace_id, channel, openid)；同渠道同 openid 重复进入返回同一用户
 * （nickname 后写覆盖）。id 取内容哈希前 12 位（确定性，天然幂等）。
 */
import { createHash } from "node:crypto";
import type { Queryable } from "../service-kb/kb.js";
import { assertChannel, type Channel } from "./channels.js";

export interface CUser {
  id: string;
  workspace_id: string;
  channel: Channel;
  openid: string;
  nickname: string | null;
  member_id: string | null;
  phone_hash: string | null;
  created_at: string;
}

/** 确定性 C 端用户 id（同 workspace+channel+openid 恒定） */
export function cUserIdOf(workspaceId: string, channel: string, openid: string): string {
  const hex = createHash("sha256").update(`${workspaceId}|${channel}|${openid}`, "utf-8").digest("hex");
  return `cu-${hex.slice(0, 12)}`;
}

export async function resolveCUser(
  db: Queryable,
  input: { workspaceId: string; channel: string; openid: string; nickname?: string },
): Promise<{ user: CUser; created: boolean }> {
  assertChannel(input.channel);
  const id = cUserIdOf(input.workspaceId, input.channel, input.openid);
  const existing = await db.query<CUser & Record<string, unknown>>(
    `SELECT * FROM c_users WHERE workspace_id=$1 AND channel=$2 AND openid=$3`,
    [input.workspaceId, input.channel, input.openid],
  );
  if (existing.rows[0]) {
    // 幂等命中：昵称有更新则覆盖
    if (input.nickname && input.nickname !== (existing.rows[0] as CUser).nickname) {
      const upd = await db.query<CUser & Record<string, unknown>>(
        `UPDATE c_users SET nickname=$4 WHERE workspace_id=$1 AND channel=$2 AND openid=$3 RETURNING *`,
        [input.workspaceId, input.channel, input.openid, input.nickname],
      );
      return { user: upd.rows[0] as CUser, created: false };
    }
    return { user: existing.rows[0] as CUser, created: false };
  }
  const ins = await db.query<CUser & Record<string, unknown>>(
    `INSERT INTO c_users (id, workspace_id, channel, openid, nickname) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (workspace_id, channel, openid) DO NOTHING RETURNING *`,
    [id, input.workspaceId, input.channel, input.openid, input.nickname ?? null],
  );
  if (ins.rows[0]) return { user: ins.rows[0] as CUser, created: true };
  // 并发撞键：回查返回
  const again = await db.query<CUser & Record<string, unknown>>(
    `SELECT * FROM c_users WHERE workspace_id=$1 AND channel=$2 AND openid=$3`,
    [input.workspaceId, input.channel, input.openid],
  );
  return { user: again.rows[0] as CUser, created: false };
}
