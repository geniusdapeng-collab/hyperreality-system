/**
 * publish-rpa · 类型与 zod schema（fusion-design §7，publish_tasks 表）
 * 平台枚举与 0009 迁移 CHECK 约束同源；行形态即 DB 投影（RLS workspace 隔离）
 */
import { z } from "zod";

/** 全平台枚举（决策 5：抖音/TikTok/小红书/视频号/B站/YouTube） */
export const PlatformSchema = z.enum(["douyin", "tiktok", "xiaohongshu", "shipinhao", "bilibili", "youtube"]);
export type Platform = z.infer<typeof PlatformSchema>;

export const PLATFORMS = PlatformSchema.options;

/** 发布任务状态机：pending → running → succeeded / failed / manual；围栏挂起 → pending_review */
export const PublishTaskStatusSchema = z.enum([
  "pending", "running", "pending_review", "succeeded", "failed", "manual",
]);
export type PublishTaskStatus = z.infer<typeof PublishTaskStatusSchema>;

export const PublishTaskSchema = z.object({
  id: z.string().min(1),
  workspace_id: z.string().min(1),
  platform: PlatformSchema,
  account_id: z.string().min(1),
  /** 关联成片（video_assets kind='final_cut'） */
  asset_id: z.string().nullable(),
  video_path: z.string().min(1),
  cover_path: z.string().nullable(),
  caption: z.string(),
  tags: z.array(z.string()),
  schedule_at: z.string().nullable(),
  status: PublishTaskStatusSchema,
  receipt: z.unknown().nullable(),
  error: z.string().nullable(),
  executed_at: z.string().nullable(),
  created_by: z.string().min(1),
  created_at: z.string(),
});
export type PublishTask = z.infer<typeof PublishTaskSchema>;

/** 发布回执（落 publish_tasks.receipt + 五元事件 receipt 位，L3.6/E3.7：无回执=未核实） */
export const PublishReceiptSchema = z.object({
  taskId: z.string().min(1),
  platform: PlatformSchema,
  /** 平台侧帖子/视频 ID（回执探测拿到才填） */
  platformPostId: z.string().optional(),
  url: z.string().optional(),
  /** 证据快照（截图/页面归档 URI） */
  evidenceUri: z.string().optional(),
  synced: z.boolean(),
  verifiedAt: z.iso.datetime({ offset: true }).optional(),
});
export type PublishReceipt = z.infer<typeof PublishReceiptSchema>;
