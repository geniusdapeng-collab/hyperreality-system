import { clientChineseText, clientValueText } from "@workloom/ui";
import type {
  BusinessCard,
  BusinessDisplayField,
  BusinessRecord,
  CatalogInfo,
  MemberInfo,
} from "./types";

const LATIN_TOKEN = /[A-Za-z][A-Za-z0-9._-]*/g;
const SAFE_LATIN_TERM = /^(?:AI|API|H5|OAuth|SLA|URL|WorkLoom)$/i;

function hasOnlyAllowedLatin(text: string, identifierAllowed: boolean): boolean {
  return [...text.matchAll(LATIN_TOKEN)].every(([token]) =>
    SAFE_LATIN_TERM.test(token) || (identifierAllowed && /\d/.test(token)));
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function chinese(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return clientChineseText(text, "") === text && hasOnlyAllowedLatin(text, false) ? text : null;
}

function displayValue(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  const safe = clientValueText(text);
  return safe === text && safe !== "信息待确认" && hasOnlyAllowedLatin(text, true) ? text : null;
}

function displayFields(value: unknown): BusinessDisplayField[] | null {
  if (!Array.isArray(value) || value.length > 20) return null;
  const result: BusinessDisplayField[] = [];
  for (const item of value) {
    const raw = recordOf(item);
    const label = chinese(raw?.label);
    const fieldValue = displayValue(raw?.value);
    if (!label || !fieldValue) return null;
    result.push({ label, value: fieldValue });
  }
  return result;
}

export function businessRecordOf(value: unknown): BusinessRecord | null {
  const raw = recordOf(value);
  if (!raw || typeof raw.id !== "string" || !raw.id.trim()) return null;
  const cardTitle = chinese(raw.cardTitle);
  const title = chinese(raw.title);
  const statusText = chinese(raw.statusText);
  const details = displayFields(raw.details);
  const referenceText = raw.referenceText === undefined ? undefined : displayValue(raw.referenceText);
  const amountText = raw.amountText === undefined ? undefined : displayValue(raw.amountText);
  if (!cardTitle || !title || !statusText || !details || referenceText === null || amountText === null) return null;
  return {
    id: raw.id,
    cardTitle,
    title,
    statusText,
    details,
    ...(referenceText ? { referenceText } : {}),
    ...(amountText ? { amountText } : {}),
  };
}

export function memberInfoOf(value: unknown): MemberInfo | null {
  const raw = recordOf(value);
  const title = chinese(raw?.title);
  if (!raw || !title || !Array.isArray(raw.benefits) || raw.benefits.length > 30) return null;
  const benefits = raw.benefits.map(chinese);
  if (benefits.some((item) => item === null)) return null;
  let metric: BusinessDisplayField | undefined;
  if (raw.metric !== undefined) {
    const projected = displayFields([raw.metric]);
    if (!projected?.[0]) return null;
    metric = projected[0];
  }
  return {
    title,
    ...(metric ? { metric } : {}),
    benefits: benefits as string[],
    ...(typeof raw.demo === "boolean" ? { demo: raw.demo } : {}),
  };
}

export function catalogInfoOf(value: unknown): CatalogInfo | null {
  const raw = recordOf(value);
  const cardTitle = chinese(raw?.cardTitle);
  if (!raw || !cardTitle || !Array.isArray(raw.items) || raw.items.length > 100) return null;
  const items: CatalogInfo["items"] = [];
  for (const item of raw.items) {
    const source = recordOf(item);
    if (!source || typeof source.id !== "string" || !source.id.trim()) return null;
    const title = chinese(source.title);
    const details = displayFields(source.details);
    const summary = source.summary === undefined ? undefined : chinese(source.summary);
    const priceText = source.priceText === undefined ? undefined : displayValue(source.priceText);
    if (!title || !details || summary === null || priceText === null) return null;
    items.push({
      id: source.id,
      title,
      details,
      ...(summary ? { summary } : {}),
      ...(priceText ? { priceText } : {}),
    });
  }
  return {
    cardTitle,
    items,
    ...(typeof raw.demo === "boolean" ? { demo: raw.demo } : {}),
  };
}

export function businessCardOf(value: unknown): BusinessCard | null {
  const raw = recordOf(value);
  if (raw?.kind === "order") {
    const data = businessRecordOf(raw.data);
    return data ? { kind: "order", data } : null;
  }
  if (raw?.kind === "member") {
    const data = memberInfoOf(raw.data);
    return data ? { kind: "member", data } : null;
  }
  if (raw?.kind === "catalog") {
    const data = catalogInfoOf(raw.data);
    return data ? { kind: "catalog", data } : null;
  }
  return null;
}

export function businessCardsOf(value: unknown): BusinessCard[] {
  if (!Array.isArray(value)) return [];
  return value.map(businessCardOf).filter((item): item is BusinessCard => item !== null);
}
