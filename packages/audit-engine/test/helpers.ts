/**
 * 测试公共工具：固定钟 + 快照构造器。
 * 所有测试注入同一个 now（确定性纪律：同快照 + 同 now 必得同发现）。
 */
import type { AccountInfo, AuditSnapshot, CommentRecord, LeadRecord, VideoRecord } from "../src/types.js";

export const NOW = new Date("2026-08-29T10:00:00+08:00");

export function hoursAgo(h: number): string {
  return new Date(NOW.getTime() - h * 3_600_000).toISOString();
}

export function daysAgo(d: number): string {
  return hoursAgo(d * 24);
}

export function baseAccount(overrides: Partial<AccountInfo> = {}): AccountInfo {
  return {
    accountId: "acc-1",
    platformId: "douyin",
    accountName: "测试主号",
    category: "美妆",
    followers: 12000,
    profile: { avatar: true, bio: true, showcase: true, booking: true, contact: true },
    violations: [],
    sensitiveOps30d: 0,
    autoReply: { configured: true, active: true },
    ...overrides,
  };
}

export function baseVideo(overrides: Partial<VideoRecord> = {}): VideoRecord {
  return {
    accountId: "acc-1",
    videoId: "v-1",
    title: "测试视频",
    publishedAt: daysAgo(10),
    plays: 10000,
    completionRate: 0.3,
    likes: 500,
    comments: 50,
    shares: 30,
    hasConversionComponent: true,
    ...overrides,
  };
}

export function baseComment(overrides: Partial<CommentRecord> = {}): CommentRecord {
  return {
    accountId: "acc-1",
    commentId: "c-1",
    text: "这个真不错",
    createdAt: hoursAgo(5),
    sentiment: "positive",
    ...overrides,
  };
}

export function baseLead(overrides: Partial<LeadRecord> = {}): LeadRecord {
  return {
    accountId: "acc-1",
    leadId: "lead-1",
    inquiryAt: hoursAgo(10),
    ...overrides,
  };
}

export function emptySnapshot(overrides: Partial<AuditSnapshot> = {}): AuditSnapshot {
  return {
    snapshotId: "SNAP-TEST",
    generatedAt: NOW.toISOString(),
    accounts: [],
    videos: [],
    comments: [],
    leads: [],
    sensitiveWords: [],
    ...overrides,
  };
}
