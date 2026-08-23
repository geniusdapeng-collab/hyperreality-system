/**
 * service-kb · 出站抓取守卫（H7 SSRF 防控）
 *  - 仅允许 http/https；解析主机名（DNS）后拒绝内网/回环地址：
 *    127.0.0.0/8、10/8、172.16/12、192.168/16、169.254/16、0.0.0.0、::1、fc00::/7、fe80::/10、localhost
 *  - readResponseLimited：响应体读取上限（默认 2MB），超限抛错
 * base（sources.ts）与 server（service/kb.ts）共用同一守卫，禁止各自为政。
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** 响应体读取上限（2MB） */
export const MAX_FETCH_BYTES = 2 * 1024 * 1024;

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map((x) => Number(x));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true; // 0/8、10/8、127/8
  if (a === 169 && b === 254) return true; // 169.254/16 链路本地
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const s = ip.toLowerCase();
  if (s === "::1" || s === "::") return true; // 回环 / 未指定
  if (s.startsWith("fe80") || s.startsWith("fe90") || s.startsWith("fea0") || s.startsWith("feb0")) return true; // fe80::/10
  if (s.startsWith("fc") || s.startsWith("fd")) return true; // fc00::/7 ULA
  // IPv4-mapped（::ffff:127.0.0.1）
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]!);
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isPrivateIPv4(ip);
  if (v === 6) return isPrivateIPv6(ip);
  return true; // 无法识别一律拒绝（安全默认）
}

/** 校验抓取 URL：协议白名单 + 主机解析后非内网（返回规范化 URL） */
export async function assertPublicHttpUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`非法抓取 URL：${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`仅允许 http/https 抓取（收到 ${url.protocol}）：${rawUrl}`);
  }
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error(`禁止抓取本机/内部主机名：${host}`);
  }
  const ips = isIP(host) !== 0
    ? [host]
    : (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
  if (ips.length === 0) throw new Error(`主机名无法解析：${host}`);
  for (const ip of ips) {
    if (isPrivateAddress(ip)) throw new Error(`禁止抓取内网/回环地址：${host}（${ip}）`);
  }
  return url;
}

/** 受限读取响应体（超 maxBytes 抛错；默认 2MB） */
export async function readResponseLimited(res: Response, maxBytes = MAX_FETCH_BYTES): Promise<string> {
  if (!res.body) {
    const text = await res.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw new Error(`抓取内容超过 ${maxBytes} 字节上限`);
    return text;
  }
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`抓取内容超过 ${maxBytes} 字节上限`);
      parts.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { buf.set(p, off); off += p.byteLength; }
  return new TextDecoder().decode(buf);
}

/** 守卫后的抓取（SSRF 校验 → fetch → 重定向目标复校 → 受限读取） */
export async function guardedFetchText(rawUrl: string, timeoutMs = 15_000): Promise<string> {
  await assertPublicHttpUrl(rawUrl);
  const res = await fetch(rawUrl, { signal: AbortSignal.timeout(timeoutMs) });
  // 跟进重定向后的最终地址再过一次守卫（防 302 跳内网绕过）
  if (res.url && res.url !== rawUrl) await assertPublicHttpUrl(res.url);
  if (!res.ok) throw new Error(`抓取失败：HTTP ${res.status}（${rawUrl}）`);
  return readResponseLimited(res);
}
