/**
 * 配置驱动模板化：基座只管理 public/service-front.config.json 加载壳，行业
 * 内容由 Bundle 生成到 public/industry/service-front.config.json。
 * - 启动时先验加载壳、再读取行业投影；任一步失败 → 中性安全态
 * - 主题色运行时注入 CSS 变量（Tailwind v4 @theme 令牌全部走 var()，改色零改码）
 * - 文案支持 {brand} / {agent} 占位符
 */

import { accessibleForeground, clientChineseText, parseHexColor, validateLightBrandTheme } from "@workloom/ui";

export type TabKey = "chat" | "service" | "tickets" | "messages" | "me";

export const FRONT_CONFIG_SHELL_PATH = "service-front.config.json";
export const INDUSTRY_FRONT_CONFIG_PATH = "industry/service-front.config.json";

export interface FrontConfigShell {
  schemaVersion: "workloom.service-front-shell/v1";
  industryProjectionPath: typeof INDUSTRY_FRONT_CONFIG_PATH;
}

export interface QuickReply {
  label: string;
  /** 点击后直接发送的文本 */
  sendText?: string;
  /** 点击后跳转服务页并预填的工单 kind */
  serviceKind?: string;
}

export interface ServiceEntry {
  kind: string;
  title: string;
  desc: string;
  icon: string;
  sla: string;
  titlePlaceholder?: string;
}

export interface FrontConfig {
  /** 公开站点标识；仅用于命中服务端 SERVICE_C_WORKSPACE_MAP，不是 workspaceId */
  workspaceKey?: string;
  brandName: string;
  agentName: string;
  /** 头像/Logo 字符（emoji 或单字） */
  logoText: string;
  theme: { primary: string; secondary: string };
  welcomeText: string;
  quickReplies: QuickReply[];
  serviceEntries: ServiceEntry[];
  /** @deprecated 兼容旧投影；新版权益标题由行业适配器直接输出，客户端不再解释等级枚举。 */
  memberLevels?: Record<string, { label: string }>;
  /** 账号页能力必须由 Bundle 投影显式开启；基座不默认假设会员或订单模型。 */
  profile: {
    identityBinding: boolean;
    membership: boolean;
    orders: boolean;
    labels: {
      identity: string;
      membership: string;
      points: string;
      orders: string;
      emptyOrders: string;
    };
  };
  /** 演示对话历史（首开非空·全场景运行态剧本；可选） */
  demoHistory?: Array<{ role: "user" | "ai"; text: string }>;
  /** 可关闭的底部 Tab */
  enableTabs: TabKey[];
  supportPhone: string;
  projection: {
    bundleId: string;
    bundleVersion: string;
    contractVersion: string;
    uiVersion: string;
    manifestDigest: string;
  };
}

export const SAFE_CONFIG: FrontConfig = {
  brandName: "企业服务中心",
  agentName: "服务助手",
  logoText: "服",
  theme: { primary: "#334155", secondary: "#075985" },
  welcomeText: "服务配置暂未就绪。您可以查看已有记录；需要新增服务时，请稍后重试或联系服务方。",
  quickReplies: [],
  serviceEntries: [],
  profile: {
    identityBinding: false,
    membership: false,
    orders: false,
    labels: {
      identity: "服务身份",
      membership: "用户权益",
      points: "当前权益值",
      orders: "近期记录",
      emptyOrders: "暂无记录",
    },
  },
  enableTabs: ["chat", "tickets", "messages", "me"],
  supportPhone: "",
  projection: {
    bundleId: "unavailable",
    bundleVersion: "0.0.0",
    contractVersion: "未知",
    uiVersion: "未知",
    manifestDigest: "配置不可用",
  },
};

export interface ConfigLoadState {
  ready: boolean;
  source: "remote" | "safe";
  message?: string;
}

let current: FrontConfig = SAFE_CONFIG;
let loadState: ConfigLoadState = {
  ready: false,
  source: "safe",
  message: "服务配置尚未加载",
};

export function getConfig(): FrontConfig {
  return current;
}

export function getConfigState(): ConfigLoadState {
  return loadState;
}

/** 文案占位符插值：{brand} / {agent} */
export function tpl(text: string, cfg: FrontConfig = current): string {
  return text.replaceAll("{brand}", cfg.brandName).replaceAll("{agent}", cfg.agentName);
}

/* ---------------- 主题色注入 ---------------- */

/** 行业配置只能覆盖共享 token 白名单中的品牌变量，语义状态色仍由基座拥有。 */
function applyTheme(cfg: FrontConfig): void {
  const root = document.documentElement.style;
  if (parseHexColor(cfg.theme.primary)) {
    root.setProperty("--wl-brand-primary", cfg.theme.primary);
    root.setProperty("--wl-brand-on-primary", accessibleForeground(cfg.theme.primary));
  }
  if (parseHexColor(cfg.theme.secondary)) root.setProperty("--wl-brand-accent", cfg.theme.secondary);
}

const TAB_KEYS = new Set<TabKey>(["chat", "service", "tickets", "messages", "me"]);

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** 普通客户端配置文案必须已完成中文本地化，并通过共享机器字段拦截。 */
function displayText(value: unknown): value is string {
  if (!nonEmptyString(value)) return false;
  const withoutTemplates = value.replaceAll("{brand}", "").replaceAll("{agent}", "");
  if (clientChineseText(withoutTemplates, "") !== withoutTemplates.trim()) return false;
  const safeTerm = /^(?:3D|AI|API|B|C|DSL|GEO|H5|IM|KPI|LLM|MVP|OAuth|PC|RLS|ROI|SLA|URL|WorkLoom)$/i;
  return [...withoutTemplates.matchAll(/[A-Za-z][A-Za-z0-9._-]*/g)].every(([token]) => safeTerm.test(token));
}

const EMOJI_GRAPHEME = /^\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*$/u;

/** 品牌与服务图符只允许一个汉字或一个 emoji 字素，禁止机器字段伪装成图标。 */
function displayGlyph(value: unknown): value is string {
  if (!nonEmptyString(value)) return false;
  const text = value.trim();
  return /^[\u3400-\u9fff]$/u.test(text) || EMOJI_GRAPHEME.test(text);
}

export function validateFrontConfig(value: unknown): value is FrontConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Partial<FrontConfig>;
  if (
    (raw.workspaceKey !== undefined && !nonEmptyString(raw.workspaceKey))
    ||
    !displayText(raw.brandName)
    || !displayText(raw.agentName)
    || !displayGlyph(raw.logoText)
    || !displayText(raw.welcomeText)
    || !raw.theme
    || validateLightBrandTheme(raw.theme).length > 0
    || !Array.isArray(raw.quickReplies)
    || !Array.isArray(raw.serviceEntries)
    || (raw.memberLevels !== undefined && typeof raw.memberLevels !== "object")
    || !raw.profile
    || typeof raw.profile.identityBinding !== "boolean"
    || typeof raw.profile.membership !== "boolean"
    || typeof raw.profile.orders !== "boolean"
    || !raw.profile.labels
    || Object.values(raw.profile.labels).some((label) => !displayText(label))
    || !Array.isArray(raw.enableTabs)
    || raw.enableTabs.length === 0
    || raw.enableTabs.some((tab) => !TAB_KEYS.has(tab))
    || typeof raw.supportPhone !== "string"
    || (raw.supportPhone !== "" && !/^[\d\s()+-]{5,30}$/.test(raw.supportPhone))
    || !raw.projection
    || !nonEmptyString(raw.projection.bundleId)
    || !nonEmptyString(raw.projection.bundleVersion)
    || !nonEmptyString(raw.projection.contractVersion)
    || !nonEmptyString(raw.projection.uiVersion)
    || !nonEmptyString(raw.projection.manifestDigest)
  ) return false;

  const memberLevelsValid = raw.memberLevels === undefined
    || Object.values(raw.memberLevels).every((item) => displayText(item?.label));
  const demoHistoryValid = raw.demoHistory === undefined || (
    Array.isArray(raw.demoHistory)
    && raw.demoHistory.every((item) => (item?.role === "user" || item?.role === "ai") && displayText(item.text))
  );

  return memberLevelsValid && demoHistoryValid && raw.quickReplies.every((item) =>
    displayText(item?.label)
    && (item.sendText === undefined || displayText(item.sendText))
    && (item.serviceKind === undefined || nonEmptyString(item.serviceKind))
    && (item.sendText !== undefined || item.serviceKind !== undefined),
  ) && raw.serviceEntries.every((item) =>
    nonEmptyString(item?.kind)
    && displayText(item.title)
    && displayText(item.desc)
    && displayGlyph(item.icon)
    && displayText(item.sla)
    && (item.titlePlaceholder === undefined || displayText(item.titlePlaceholder)),
  );
}

/** 受管加载壳只允许访问约定的行业扩展目录，禁止远程 URL、绝对路径和路径穿越。 */
export function validateFrontConfigShell(value: unknown): value is FrontConfigShell {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Partial<FrontConfigShell>;
  return raw.schemaVersion === "workloom.service-front-shell/v1"
    && raw.industryProjectionPath === INDUSTRY_FRONT_CONFIG_PATH
    && Object.keys(raw).length === 2;
}

function useSafeConfig(message: string): void {
  current = SAFE_CONFIG;
  loadState = { ready: false, source: "safe", message };
}

/** 启动加载：受管壳与行业投影都完整有效才启用；任何失败都进入中性安全态。 */
export async function loadConfig(): Promise<FrontConfig> {
  try {
    const shellResponse = await fetch(FRONT_CONFIG_SHELL_PATH, { cache: "no-cache" });
    if (!shellResponse.ok) {
      useSafeConfig(`服务配置入口加载失败（${shellResponse.status}）`);
    } else {
      const shell: unknown = await shellResponse.json();
      if (!validateFrontConfigShell(shell)) {
        useSafeConfig("服务配置入口不完整或格式错误");
      } else {
        const projectionResponse = await fetch(shell.industryProjectionPath, { cache: "no-cache" });
        if (!projectionResponse.ok) {
          useSafeConfig(`行业服务配置加载失败（${projectionResponse.status}）`);
        } else {
          const projection: unknown = await projectionResponse.json();
          if (!validateFrontConfig(projection)) useSafeConfig("行业服务配置不完整或格式错误");
          else {
            current = projection;
            loadState = { ready: true, source: "remote" };
          }
        }
      }
    }
  } catch {
    useSafeConfig("服务配置加载失败，请检查网络后重试");
  }
  applyTheme(current);
  document.title = `${current.brandName} · AI 服务前台`;
  return current;
}
