/**
 * C 端行业业务适配契约。
 *
 * 基座只理解订单摘要、身份摘要、目录摘要等稳定的服务前台投影，不理解
 * 房型、入住、商品、咨询项目等行业字段。行业实现负责意图、用户文案、
 * 数据读取和卡片序列化；网关只在已验证的活动 Bundle 显式声明 adapterId
 * 后才会调用实现。
 */
import type pg from "pg";
import type { KbSearchLexicon } from "@workloom/base/service-kb";

export const BUSINESS_TOOLS = ["query_order", "query_member", "query_catalog"] as const;
export type BusinessTool = (typeof BUSINESS_TOOLS)[number];

export interface BusinessContext {
  workspaceId: string;
  cUserId: string;
  /** 工作区内已验证并绑定的业务主体；不允许适配器据空值回退到全量数据。 */
  memberId?: string | null;
}

/**
 * 行业数据进入 C 端前的唯一展示单元。
 * label 必须是中文业务名词，value 必须是已经本地化后的展示值；客户端不得
 * 根据字段 key 猜测标签，也不得自行拼装金额、日期、状态或行业对象。
 */
export interface BusinessDisplayField {
  label: string;
  value: string;
}

/** 订单/预约/项目等行业记录的通用展示投影；id 只作交互锚点，不得直接展示。 */
export interface BusinessOrder {
  id: string;
  cardTitle: string;
  title: string;
  statusText: string;
  referenceText?: string;
  details: BusinessDisplayField[];
  amountText?: string;
}

/** 会员/客户/伙伴等行业身份权益的通用展示投影。 */
export interface BusinessMember {
  title: string;
  metric?: BusinessDisplayField;
  benefits: string[];
  demo?: boolean;
}

/** 商品、房型、服务或方案等目录项的通用展示投影；id 同样只作交互锚点。 */
export interface BusinessCatalogItem {
  id: string;
  title: string;
  summary?: string;
  priceText?: string;
  details: BusinessDisplayField[];
}

export interface BusinessQueryMeta {
  demo: boolean;
  bindRequired?: boolean;
  hint?: string;
}

export type BusinessOrderResult = BusinessQueryMeta & { orders: BusinessOrder[] };
export type BusinessMemberResult = BusinessQueryMeta & { member: BusinessMember | null };
export type BusinessCatalogResult = BusinessQueryMeta & { cardTitle: string; items: BusinessCatalogItem[] };

export interface BusinessDialogMatch {
  tool: BusinessTool;
  /** 面向用户的中文动作说明，由行业包适配器提供，基座不得猜行业名词。 */
  answer: string;
  params?: Record<string, unknown>;
}

export interface BusinessIdentityChallenge {
  state: "demo" | "pending";
  message: string;
  demoCode?: string;
}

export interface BusinessIdentityMatch {
  subjectId: string;
  demo: boolean;
}

export class BusinessAdapterError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = "BusinessAdapterError";
  }
}

export interface ServiceFrontBusinessAdapter {
  readonly id: string;
  /** 仅在该适配器由已验证活动 Bundle 选中后注入知识检索；基座没有行业默认词表。 */
  readonly kbLexicon?: KbSearchLexicon;
  classify(text: string): BusinessDialogMatch | null;
  ticketKind?(text: string): string | null;
  departmentForTicket?(kind: string): string | null;
  queryOrder(ctx: BusinessContext): Promise<BusinessOrderResult>;
  queryMember(ctx: BusinessContext): Promise<BusinessMemberResult>;
  queryCatalog(ctx: BusinessContext): Promise<BusinessCatalogResult>;
  identity?: {
    requestCode(phone: string): Promise<BusinessIdentityChallenge>;
    verifyCode(
      client: pg.PoolClient,
      ctx: Pick<BusinessContext, "workspaceId" | "cUserId">,
      input: { phone: string; code: string },
    ): Promise<BusinessIdentityMatch>;
  };
}

/**
 * 构建期行业适配器登记项。运行时 Bundle 只能按 adapterId 选择这里已经登记的
 * 实现，不能把清单中的任意路径直接 import 成代码。生产签名仍由 Bundle 门禁
 * 强制校验；trustedSignerKeyIds 可进一步把某实现限制到指定签名方。
 */
export interface BusinessAdapterRegistration {
  adapter: ServiceFrontBusinessAdapter;
  bundleIds: readonly string[];
  trustedSignerKeyIds?: readonly string[];
}

const HAS_CHINESE = /\p{Script=Han}/u;
const DISPLAY_VALUE = /^(?:[\d\s.,:%+\-/¥￥()]+|(?:AI|API|H5|OAuth|SLA|URL|WorkLoom))$/i;
const MACHINE_TEXT = /\b(?:bundle_id|bundleId|event_id|eventId|fence_bindings|preset_key|reasonEnum|request_id|requestId|tenant_id|tenantId|workspace_id|workspaceId|SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|Internal Server Error)\b/i;
const ENGINEERING_TEXT = /(?:^|[^A-Za-z0-9])(?:P|F|E|L)\d+(?:\.\d+)?(?:$|[^A-Za-z0-9])/;
const LATIN_TOKEN = /[A-Za-z][A-Za-z0-9._-]*/g;
const SAFE_LATIN_TERM = /^(?:AI|API|H5|OAuth|SLA|URL|WorkLoom)$/i;

function hasOnlyAllowedLatin(text: string, numeric: boolean): boolean {
  return [...text.matchAll(LATIN_TOKEN)].every(([token]) =>
    SAFE_LATIN_TERM.test(token) || (numeric && /\d/.test(token)));
}

export function businessDisplayText(value: unknown, field: string, options: { numeric?: boolean } = {}): string {
  if (typeof value !== "string") throw new BusinessAdapterError("行业展示数据未通过安全校验", 502, "BUSINESS_PROJECTION_INVALID");
  const text = value.trim();
  const safe = text.length > 0
    && text.length <= 300
    && !MACHINE_TEXT.test(text)
    && !ENGINEERING_TEXT.test(text)
    && !/^[\[{][\s\S]*[\]}]$/.test(text)
    && hasOnlyAllowedLatin(text, options.numeric === true)
    && (HAS_CHINESE.test(text) || (options.numeric === true && DISPLAY_VALUE.test(text)));
  if (!safe) {
    // field 只进入服务端日志，响应永远使用稳定中文错误，不回显原值或字段内容。
    console.warn(`[service-c] 行业展示投影字段校验失败：${field}`);
    throw new BusinessAdapterError("行业展示数据未通过安全校验", 502, "BUSINESS_PROJECTION_INVALID");
  }
  return text;
}

function displayFields(value: unknown, field: string): BusinessDisplayField[] {
  if (!Array.isArray(value) || value.length > 20) {
    throw new BusinessAdapterError("行业展示数据未通过安全校验", 502, "BUSINESS_PROJECTION_INVALID");
  }
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new BusinessAdapterError("行业展示数据未通过安全校验", 502, "BUSINESS_PROJECTION_INVALID");
    }
    const raw = item as Record<string, unknown>;
    return {
      label: businessDisplayText(raw.label, `${field}.${index}.label`),
      value: businessDisplayText(raw.value, `${field}.${index}.value`, { numeric: true }),
    };
  });
}

function optionalDisplayText(value: unknown, field: string, numeric = false): string | undefined {
  return value === undefined || value === null || value === ""
    ? undefined
    : businessDisplayText(value, field, { numeric });
}

function projectOrder(raw: unknown, index: number): BusinessOrder {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new BusinessAdapterError("行业展示数据未通过安全校验", 502, "BUSINESS_PROJECTION_INVALID");
  }
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== "string" || !value.id.trim()) {
    throw new BusinessAdapterError("行业展示数据未通过安全校验", 502, "BUSINESS_PROJECTION_INVALID");
  }
  const referenceText = optionalDisplayText(value.referenceText, `orders.${index}.referenceText`, true);
  const amountText = optionalDisplayText(value.amountText, `orders.${index}.amountText`, true);
  return {
    id: value.id,
    cardTitle: businessDisplayText(value.cardTitle, `orders.${index}.cardTitle`),
    title: businessDisplayText(value.title, `orders.${index}.title`),
    statusText: businessDisplayText(value.statusText, `orders.${index}.statusText`),
    details: displayFields(value.details, `orders.${index}.details`),
    ...(referenceText ? { referenceText } : {}),
    ...(amountText ? { amountText } : {}),
  };
}

function projectMember(raw: unknown): BusinessMember {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new BusinessAdapterError("行业展示数据未通过安全校验", 502, "BUSINESS_PROJECTION_INVALID");
  }
  const value = raw as Record<string, unknown>;
  if (!Array.isArray(value.benefits) || value.benefits.length > 30) {
    throw new BusinessAdapterError("行业展示数据未通过安全校验", 502, "BUSINESS_PROJECTION_INVALID");
  }
  const metric = value.metric === undefined ? undefined : displayFields([value.metric], "member.metric")[0];
  return {
    title: businessDisplayText(value.title, "member.title"),
    ...(metric ? { metric } : {}),
    benefits: value.benefits.map((benefit, index) => businessDisplayText(benefit, `member.benefits.${index}`)),
    ...(typeof value.demo === "boolean" ? { demo: value.demo } : {}),
  };
}

function projectCatalogItem(raw: unknown, index: number): BusinessCatalogItem {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new BusinessAdapterError("行业展示数据未通过安全校验", 502, "BUSINESS_PROJECTION_INVALID");
  }
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== "string" || !value.id.trim()) {
    throw new BusinessAdapterError("行业展示数据未通过安全校验", 502, "BUSINESS_PROJECTION_INVALID");
  }
  const summary = optionalDisplayText(value.summary, `catalog.items.${index}.summary`);
  const priceText = optionalDisplayText(value.priceText, `catalog.items.${index}.priceText`, true);
  return {
    id: value.id,
    title: businessDisplayText(value.title, `catalog.items.${index}.title`),
    details: displayFields(value.details, `catalog.items.${index}.details`),
    ...(summary ? { summary } : {}),
    ...(priceText ? { priceText } : {}),
  };
}

/**
 * 适配器输出的唯一出口：白名单复制字段并校验中文展示语义。即使实现绕过
 * TypeScript 塞入行业私有字段，它们也不会进入客户端。
 */
export function projectBusinessToolResult(
  tool: BusinessTool,
  raw: BusinessOrderResult | BusinessMemberResult | BusinessCatalogResult,
): BusinessOrderResult | BusinessMemberResult | BusinessCatalogResult {
  const meta: BusinessQueryMeta = {
    demo: raw.demo === true,
    ...(raw.bindRequired === true ? { bindRequired: true } : {}),
    ...(raw.hint ? { hint: businessDisplayText(raw.hint, "hint") } : {}),
  };
  if (tool === "query_order") {
    const orders = (raw as BusinessOrderResult).orders;
    if (!Array.isArray(orders) || orders.length > 100) {
      throw new BusinessAdapterError("行业展示数据未通过安全校验", 502, "BUSINESS_PROJECTION_INVALID");
    }
    return { ...meta, orders: orders.map(projectOrder) };
  }
  if (tool === "query_member") {
    const member = (raw as BusinessMemberResult).member;
    return { ...meta, member: member === null ? null : projectMember(member) };
  }
  const catalog = raw as BusinessCatalogResult;
  if (!Array.isArray(catalog.items) || catalog.items.length > 100) {
    throw new BusinessAdapterError("行业展示数据未通过安全校验", 502, "BUSINESS_PROJECTION_INVALID");
  }
  return {
    ...meta,
    cardTitle: businessDisplayText(catalog.cardTitle, "catalog.cardTitle"),
    items: catalog.items.map(projectCatalogItem),
  };
}

/** 对话分类文案同样必须由行业适配器输出为中文展示文本。 */
export function projectBusinessDialogMatch(match: BusinessDialogMatch | null): BusinessDialogMatch | null {
  if (!match) return null;
  if (!(BUSINESS_TOOLS as readonly string[]).includes(match.tool)) {
    throw new BusinessAdapterError("行业展示数据未通过安全校验", 502, "BUSINESS_PROJECTION_INVALID");
  }
  return {
    tool: match.tool,
    answer: businessDisplayText(match.answer, "dialog.answer"),
    ...(match.params ? { params: match.params } : {}),
  };
}

/** 身份挑战文案会直接进入客户端，禁止适配器返回英文错误或机器字段。 */
export function projectBusinessIdentityChallenge(challenge: BusinessIdentityChallenge): BusinessIdentityChallenge {
  if (challenge.state !== "demo" && challenge.state !== "pending") {
    throw new BusinessAdapterError("行业展示数据未通过安全校验", 502, "BUSINESS_PROJECTION_INVALID");
  }
  return {
    state: challenge.state,
    message: businessDisplayText(challenge.message, "identity.message"),
    ...(typeof challenge.demoCode === "string" && /^\d{4,8}$/.test(challenge.demoCode)
      ? { demoCode: challenge.demoCode }
      : {}),
  };
}

export async function runBusinessTool(
  adapter: ServiceFrontBusinessAdapter,
  tool: BusinessTool,
  ctx: BusinessContext,
): Promise<BusinessOrderResult | BusinessMemberResult | BusinessCatalogResult> {
  switch (tool) {
    case "query_order": return projectBusinessToolResult(tool, await adapter.queryOrder(ctx));
    case "query_member": return projectBusinessToolResult(tool, await adapter.queryMember(ctx));
    case "query_catalog": return projectBusinessToolResult(tool, await adapter.queryCatalog(ctx));
  }
}
