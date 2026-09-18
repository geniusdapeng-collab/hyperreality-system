/**
 * 酒店行业巡检适配器。
 *
 * 渠道、价格、评价阈值、对象类型与面向用户的文案全部留在行业边界；只有
 * 已验证且处于 active 的 hotel Bundle 才能经服务端受控注册表选择本适配器。
 */
import type {
  CheckDef,
  Finding,
  InspectionAdapter,
  InspectionSnapshot,
  Probe,
} from "@workloom/base/inspection";
import { z } from "zod";

const HotelInspectionSnapshotSchema = z.object({
  channels: z.array(z.object({
    channel: z.string().min(1),
    price: z.number().optional(),
    parity: z.boolean().optional(),
    status: z.string().optional(),
  }).passthrough()).optional(),
  stateUnits: z.array(z.object({
    unit: z.string().min(1),
    synced: z.boolean(),
  }).passthrough()).optional(),
  reviews: z.array(z.object({
    id: z.string().min(1),
    channel: z.string().min(1),
    score: z.number().finite(),
  }).passthrough()).optional(),
  violations: z.array(z.object({
    id: z.string().min(1),
    kind: z.string().min(1),
    detail: z.string(),
  }).passthrough()).optional(),
}).passthrough();

type HotelInspectionSnapshot = z.infer<typeof HotelInspectionSnapshotSchema>;

function hotelSnapshot(snapshot: InspectionSnapshot): HotelInspectionSnapshot {
  return HotelInspectionSnapshotSchema.parse(snapshot);
}

export const HOTEL_INSPECTION_CHECKS: readonly CheckDef[] = Object.freeze([
  Object.freeze({ id: "chk-channel-price", kind: "hotel.channel-price", name: "多渠道房价一致性" }),
  Object.freeze({ id: "chk-room-state-sync", kind: "hotel.room-state-sync", name: "房态同步" }),
  Object.freeze({ id: "chk-guest-review", kind: "hotel.guest-review", name: "住客评价扫描" }),
  Object.freeze({ id: "chk-operation-violation", kind: "hotel.operation-violation", name: "经营违规巡检" }),
]);

const channelPriceProbe: Probe = (check, snapshot) => {
  const channels = hotelSnapshot(snapshot).channels;
  if (!channels || channels.length === 0) {
    return [{ checkId: check.id, status: "nodata", summary: "无酒店渠道房价快照", objectType: "hotel-channel", source: "hotel.channel-price" }];
  }
  return channels.map((channel): Finding => {
    if (channel.status && channel.status !== "online") {
      return {
        checkId: check.id,
        status: "anomaly",
        severity: "high",
        summary: `酒店渠道「${channel.channel}」状态异常（${channel.status}）`,
        objectType: "hotel-channel",
        objectId: channel.channel,
        source: "hotel.channel-price",
      };
    }
    if (channel.parity === false) {
      return {
        checkId: check.id,
        status: "anomaly",
        severity: "medium",
        summary: `酒店渠道「${channel.channel}」房价不一致`,
        objectType: "hotel-channel",
        objectId: channel.channel,
        source: "hotel.channel-price",
      };
    }
    return {
      checkId: check.id,
      status: "ok",
      summary: `酒店渠道「${channel.channel}」房价正常`,
      objectType: "hotel-channel",
      objectId: channel.channel,
      source: "hotel.channel-price",
    };
  });
};

const roomStateProbe: Probe = (check, snapshot) => {
  const stateUnits = hotelSnapshot(snapshot).stateUnits;
  if (!stateUnits || stateUnits.length === 0) {
    return [{ checkId: check.id, status: "nodata", summary: "无房态同步快照", objectType: "hotel-room-state", source: "hotel.room-state-sync" }];
  }
  return stateUnits.map((unit): Finding => unit.synced
    ? {
      checkId: check.id,
      status: "ok",
      summary: `房态单元「${unit.unit}」已同步`,
      objectType: "hotel-room-state",
      objectId: unit.unit,
      source: "hotel.room-state-sync",
    }
    : {
      checkId: check.id,
      status: "anomaly",
      severity: "medium",
      summary: `房态单元「${unit.unit}」尚未同步`,
      objectType: "hotel-room-state",
      objectId: unit.unit,
      source: "hotel.room-state-sync",
    });
};

const guestReviewProbe: Probe = (check, snapshot) => {
  const reviews = hotelSnapshot(snapshot).reviews;
  if (!reviews) {
    return [{ checkId: check.id, status: "nodata", summary: "无住客评价快照", objectType: "hotel-review", source: "hotel.guest-review" }];
  }
  if (reviews.length === 0) {
    return [{ checkId: check.id, status: "ok", summary: "无新增住客评价", objectType: "hotel-review", source: "hotel.guest-review" }];
  }
  return reviews.map((review): Finding => review.score <= 3
    ? {
      checkId: check.id,
      status: "anomaly",
      severity: "high",
      summary: `住客差评 ${review.score} 分（渠道 ${review.channel}）待跟进`,
      objectType: "hotel-review",
      objectId: review.id,
      source: "hotel.guest-review",
    }
    : {
      checkId: check.id,
      status: "ok",
      summary: `住客评价 ${review.score} 分（渠道 ${review.channel}）正常`,
      objectType: "hotel-review",
      objectId: review.id,
      source: "hotel.guest-review",
    });
};

const operationViolationProbe: Probe = (check, snapshot) => {
  const violations = hotelSnapshot(snapshot).violations;
  if (!violations) {
    return [{ checkId: check.id, status: "nodata", summary: "无酒店经营违规快照", objectType: "hotel-violation", source: "hotel.operation-violation" }];
  }
  if (violations.length === 0) {
    return [{ checkId: check.id, status: "ok", summary: "无酒店经营违规", objectType: "hotel-violation", source: "hotel.operation-violation" }];
  }
  return violations.map((violation): Finding => ({
    checkId: check.id,
    status: "anomaly",
    severity: "high",
    summary: `酒店经营违规（${violation.kind}）：${violation.detail}`,
    objectType: "hotel-violation",
    objectId: violation.id,
    source: "hotel.operation-violation",
  }));
};

export const hotelInspectionAdapter: InspectionAdapter = Object.freeze({
  id: "hotel.inspection-v1",
  presetKey: "inspection-agent",
  checks: HOTEL_INSPECTION_CHECKS,
  probes: Object.freeze({
    "hotel.channel-price": channelPriceProbe,
    "hotel.room-state-sync": roomStateProbe,
    "hotel.guest-review": guestReviewProbe,
    "hotel.operation-violation": operationViolationProbe,
  }),
});
