import ts from "typescript-governance";

const VISIBLE_ATTRIBUTES = new Set([
  "alt",
  "aria-label",
  "aria-description",
  "aria-placeholder",
  "aria-valuetext",
  "data-label",
  "data-title",
  "data-tooltip",
  "description",
  "hint",
  "label",
  "placeholder",
  "title",
]);

/** 仅在大写 React 组件上视为可见文案，避免把领域对象的同名机器字段误报。 */
const VISIBLE_CUSTOM_COMPONENT_PROPS = new Set([
  "badge", "caption", "eyebrow", "failureText", "footnote", "kicker", "metaText", "noDataText",
  "note", "optionalLabel", "period", "source", "statusLabel", "subtitle", "tag", "ticketTitle",
  "tooltip", "unit", "updatedAt", "welcomeText",
]);
const VISIBLE_CUSTOM_COMPONENT_PROP_SUFFIX = /(?:Description|Label|Message|Placeholder|Text|Title)$/;

const VISIBLE_PROPERTY_NAMES = new Set([
  "actionLabel",
  "desc",
  "description",
  "hint",
  "label",
  "message",
  "body",
  "channelName",
  "content",
  "emptyLabel",
  "emptyText",
  "errorText",
  "fallbackReason",
  "helperText",
  "header",
  "mobileLabel",
  "noDataText",
  "summary",
  "sortLabel",
  "text",
  "title",
  "tooltip",
  "displayValue",
  "valueText",
]);
const NESTED_DYNAMIC_DISPLAY_PROPERTIES = new Set(["displayValue", "header", "mobileLabel", "sortLabel", "valueText"]);

// `value` 对原生表单与表单组件通常是机器值，不能一刀切当成展示文案；但在
// MetricCard、KpiGauge、CommandCard 等非表单组件上会直接渲染给用户。这里按
// 组件语义收口，既覆盖下游自定义展示组件，也避免把 input/select 的受控值误报。
const NON_DISPLAY_VALUE_COMPONENTS = new Set([
  "Checkbox", "Combobox", "DateInput", "Input", "PasswordInput", "Progress", "Radio",
  "Range", "SearchInput", "Select", "Slider", "Switch", "TextArea", "Textarea", "UrlQrCode",
]);

const VISIBLE_SETTER = /^(?:appendAi|enqueueSnackbar|notify|setBanner|setBindingError|setCaption|setDone|setErr|setError|setFeedback|setLoadMessage|setMessage|setMsg|setNotice|setRateError|setSiteResult|setSubtitle|setToast|showToast)$/;
const ENGINEERING_CODE = /(?:^|[^A-Za-z0-9])(?:P|F|E|L|M|D|G)\d+(?:\.\d+)?(?:$|[^A-Za-z0-9])/;
const RAW_CLIENT_TERM = /\b(?:Agent|Bundle|Profile|Rebase|schema|fence_bindings|preset_key|presetKey|overlay_version|base_version|bundle_id|bundleId|batchId|tenant_id|tenantId|workspace_id|workspaceId|event_id|eventId|request_id|requestId|requiredClauses|reasonEnum|input_tokens|output_tokens|latencyMs|cron|args|JSON|YAML|CLI|SQL|SSE|tRPC|npm|pip|git)\b/i;
const RAW_FIELD_SHAPE = /\b(?:[a-z][a-z0-9]*_[a-z0-9_]+|[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*)\b/;
const RAW_DYNAMIC_FIELD = new Set([
  "id", "status", "schedule", "cron",
  "eventId", "event_id", "requestId", "request_id", "resourceId", "resource_id",
  "ticketId", "ticket_id", "threadId", "thread_id", "taskId", "task_id",
  "memberId", "member_id", "workspaceId", "workspace_id", "tenantId", "tenant_id",
  "bundleId", "bundle_id", "presetKey", "preset_key", "model_id", "agent_id",
  "baseline_branch", "assigned_tool", "change_kind", "exit_reason",
  "credential_health", "rule_id",
]);
const SAFE_DISPLAY_FORMATTERS = new Set([
  "actionText", "actorText", "capabilityText", "clientChineseText", "clientIdentifierText", "clientNodeText",
  "clientStatusLabel", "clientValueText", "confidenceText", "cronText", "dictText",
  "chineseMessage", "displayNameOf", "formatDate", "formatDateTime", "formatTime", "inboxSpeechText",
  "docStatusChip", "kindLabel", "latencyText", "modelName", "operationFailure", "payloadText",
  "publicationSystemText", "roleTitleOf", "ticketStatusChip",
  "safeAiText", "safeMessage", "safeOnboardingError", "safeWizardError", "shortId", "speechText",
  "versionText",
]);
const SAFE_DISPLAY_MAPS = new Set([
  "ACTION_LABELS", "ATTRIBUTION_TEXT", "CHANNEL_STATUS", "ENVIRONMENT_LABELS", "EXAM_LABELS",
  "EXAM_STATUS_TEXT", "EXAM_TYPE_TEXT", "KIND_TEXT", "LAYER_TEXT", "MODE_LABEL", "MODE_TEXT",
  "NAVIGATION_GROUP_LABELS", "PERSONA_NAME", "POOL_LABEL", "PUBLICATION_STATUS", "RISK_LABELS",
  "ROLE_LABELS", "SOURCE_TEXT", "STATE_DEFAULTS", "STATUS", "SUBJECT_TEXT", "TASK_STATUS",
  "THREAD_MODE_TEXT", "TIER_TEXT", "TOAST_TITLES", "TOOL_TEXT", "TYPE_LABEL", "TYPE_TEXT",
  "VERDICT", "VERDICT_META", "STRUCTURE_TEXT", "chunkCounts", "workspaceNames",
]);
const AUTHORIZED_DIAGNOSTIC_FILE = /apps\/web\/src\/extensions\/ai-pm\/P25\.tsx$/;
const AUTHORIZED_LOCAL_GUIDE_FILE = /apps\/web\/src\/components\/BackendGate\.tsx$/;
const AUTHORIZED_COMPONENT_MATRIX_FILE = /apps\/web\/src\/pages\/dev\/DevMatrix\.tsx$/;
const SAFE_VISIBLE_LATIN_TERM = /^(?:AI|API|B|C|CSV|DeepSeek|DOCX|DSL|Esc|Excel|FAE|FAQ|GEO|GLM|GPS|H5|IM|Kimi|KPI|Lightning|LLM|MB|MD|MVP|Moonshot|OAuth|OpenAI|PC|PDF|PRD|RLS|ROI|SLA|SOP|SPA|TSV|TXT|Type-C|URL|USB|WiFi|WorkLoom|XLSX|XP|XX|Yunqi-Hotel|deepseek-chat|retail|sk)$/i;
const LATIN_TOKEN = /[A-Za-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*/g;
const UNTRUSTED_RESPONSE_FIELD = new Set(["answer", "code", "detail", "error", "message", "reason", "result", "summary"]);
const UNTRUSTED_RESPONSE_ROOT = /^(?:apiError|cause|e|err|error|exception|failure|payload|reply|res|response|result|serverResponse)$/i;
const CLIENT_SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/i;
const CLIENT_SOURCE_ROOT = /^(?:apps\/(?:web|webb|webc)\/src|packages\/ui\/src)\//;
const CLIENT_PUBLIC_WORKER = /^apps\/(?:web|webb|webc)\/public\/(?:.+\/)?(?:firebase-messaging-sw|sw|service-worker)\.(?:m?js|ts)$/i;
const CLIENT_PUBLIC_HTML_FILE = /^apps\/(?:web|webb|webc)\/public\/(?:.+\/)?[^/]+\.html?$/i;
export const GOVERNED_INDUSTRY_EXTENSION_PATHS = Object.freeze([
  "apps/*/src/extensions/**",
  "apps/*/src/projections/**",
  "apps/*/src/config/industry/**",
  "apps/*/src/theme/industry/**",
  "apps/*/public/industry/**",
]);
const PC_INDUSTRY_UI_ROOT = /^apps\/web\/(?:src\/(?:extensions|projections|config\/industry|theme\/industry)|public\/industry)\//;
const PC_INDUSTRY_NAVIGATION_SOURCE = /\.(?:[cm]?[jt]sx?|html?)$/i;
const INDUSTRY_UI_ROOT = /^apps\/(?:web|webb|webc)\/(?:src\/(?:extensions|projections|config\/industry|theme\/industry)|public\/industry)\//;
const INDUSTRY_STYLESHEET = /\.(?:css|scss)$/i;
const INDUSTRY_CLIENT_SOURCE = /\.(?:[cm]?[jt]sx?|html?)$/i;
const INDUSTRY_UI_CONFIG = /\.(?:json|ya?ml)$/i;
const INDUSTRY_HTML = /\.html?$/i;
const LABEL_DICTIONARY_FILE = /(?:^|\/)(?:copy|i18n|labels?|locales?|messages?|strings?)(?:[._-][^/]*)?\.(?:json|ya?ml)$/i;
const CLIENT_PUBLIC_INDUSTRY_SOURCE = /^apps\/(?:web|webb|webc)\/public\/industry\/.+\.[cm]?[jt]sx?$/i;
const MANAGED_SURFACE_STYLESHEET = "packages/ui/src/components.css";
/**
 * 上游 vendor 资产（`apps/<客户端>/src/vendor/<组件>/**`、`packages/ui/src/vendor/**`）：
 * 逐字节保留的上游源码（MIT 等，PINNED 锁 commit），其双语数据/文档字符串属于上游内容，
 * **不是产品文案面**——产品文案一律由组件层（中文）承担，故整目录豁免客户端文案与浮面治理；
 * 仍受供应链（oss-components 登记 + 许可证）、产物体积与安全门禁约束。
 */
const UPSTREAM_VENDOR_ASSET = /^(?:apps\/(?:web|webb|webc)\/src|packages\/ui\/src)\/vendor\/[A-Za-z0-9._-]+\//;
const CLIENT_SOURCE_EXCLUSION = /(?:^|\/)(?:__tests__|coverage|dist|node_modules)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$|\.d\.[cm]?ts$/i;
const BUNDLE_UI_CONFIG_FILE = /^(?:apps\/(?:web|webb|webc)\/public\/industry\/.+\.json|apps\/webc\/public\/service-front\.config\.json|bundles\/[^/]+\/(?:floor-scene\.json|service-front\/client\.json))$/;
const CLIENT_WEB_MANIFEST_FILE = /^apps\/(?:web|webb|webc)\/public\/(?:.+\/)?(?:manifest\.json|[^/]+\.webmanifest)$/i;
const BUNDLE_DISPLAY_KEY = new Set([
  "a", "agentName", "brandName", "desc", "description", "docTitle", "emptyOrders", "errorText",
  "hint", "label", "logoText", "message", "name", "note", "q", "sendText", "sla", "summary",
  "short_name", "symptoms", "text", "tip", "title", "titlePlaceholder", "tooltip", "unit", "welcomeText",
]);
const CUSTOM_GRAPHICS = Object.freeze({
  "agent-avatar": { file: /apps\/web\/src\/components\/AgentAvatar\.tsx$/, accessible: "image" },
  "generated-qr-code": { file: /apps\/web\/src\/components\/UrlQrCode\.tsx$/, accessible: "image" },
  "live-character": { file: /apps\/web\/src\/components\/loommate\/MateLive2D\.tsx$/, accessible: "nested" },
  "hologram-figure": { file: /apps\/web\/src\/pages\/p0\/P0\.tsx$/, accessible: "decorative" },
});
const FUNCTIONAL_GLYPH = /[\p{Extended_Pictographic}✓✗✕⚠⛔○◆◇▲▼✎✦✧❖▶◀■□▍◈⌃⌄⋯⧉↻⚙▾▴›‹＋]/gu;

function stripComments(source) {
  let result = "";
  let index = 0;
  let state = "code";
  let quote = "";
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (state === "line-comment") {
      if (char === "\n") { result += "\n"; state = "code"; }
      else result += " ";
      index += 1;
      continue;
    }
    if (state === "block-comment") {
      if (char === "*" && next === "/") { result += "  "; index += 2; state = "code"; continue; }
      result += char === "\n" ? "\n" : " ";
      index += 1;
      continue;
    }
    if (state === "string") {
      result += char;
      if (char === "\\") {
        if (next !== undefined) result += next;
        index += 2;
        continue;
      }
      if (char === quote) state = "code";
      index += 1;
      continue;
    }
    if (char === "/" && next === "/") { result += "  "; index += 2; state = "line-comment"; continue; }
    if (char === "/" && next === "*") { result += "  "; index += 2; state = "block-comment"; continue; }
    if (char === '"' || char === "'" || char === "`") { state = "string"; quote = char; }
    result += char;
    index += 1;
  }
  return result;
}

function scriptKindOf(fileName) {
  if (/\.tsx$/i.test(fileName)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(fileName)) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/i.test(fileName)) return ts.ScriptKind.JS;
  if (/\.[cm]?ts$/i.test(fileName)) return ts.ScriptKind.TS;
  return /<\/?[A-Za-z][^>]*>/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TSX;
}

function parseClientSource(source, fileName = "client.tsx") {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKindOf(fileName));
}

function jsxAttributeText(attribute) {
  if (!ts.isJsxAttribute(attribute) || !attribute.initializer) return "";
  if (ts.isStringLiteral(attribute.initializer)) return attribute.initializer.text;
  if (ts.isJsxExpression(attribute.initializer) && attribute.initializer.expression
    && (ts.isStringLiteral(attribute.initializer.expression) || ts.isNoSubstitutionTemplateLiteral(attribute.initializer.expression))) {
    return attribute.initializer.expression.text;
  }
  return "";
}

function jsxTagName(node) {
  const tag = node.tagName;
  return ts.isIdentifier(tag) ? tag.text : "";
}

function jsxAttributeOwnerName(attribute) {
  const attributes = attribute.parent;
  const opening = attributes?.parent;
  if (!opening || (!ts.isJsxOpeningElement(opening) && !ts.isJsxSelfClosingElement(opening))) return "";
  return jsxTagName(opening);
}

function isVisibleJsxAttribute(attribute, name) {
  if (VISIBLE_ATTRIBUTES.has(name) || VISIBLE_PROPERTY_NAMES.has(name)) return true;
  const owner = jsxAttributeOwnerName(attribute);
  if (/^[A-Z]/.test(owner)
    && (VISIBLE_CUSTOM_COMPONENT_PROPS.has(name) || name === "error" || VISIBLE_CUSTOM_COMPONENT_PROP_SUFFIX.test(name))) return true;
  if (name !== "value") return false;
  return /^[A-Z]/.test(owner) && !NON_DISPLAY_VALUE_COMPONENTS.has(owner);
}

function componentDeclarations(sourceFile) {
  const declarations = new Map();
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) declarations.set(statement.name.text, statement);
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      if (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer)) {
        declarations.set(declaration.name.text, declaration);
      }
    }
  }
  return declarations;
}

function componentNamesWithin(node) {
  const names = new Set();
  const visit = (current) => {
    if (ts.isJsxOpeningElement(current) || ts.isJsxSelfClosingElement(current)) {
      const name = jsxTagName(current);
      if (/^[A-Z]/.test(name)) names.add(name);
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return names;
}

function componentReferenceOffsets(sourceFile, componentName) {
  const offsets = [];
  const visit = (node) => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && jsxTagName(node) === componentName) {
      offsets.push(node.getStart(sourceFile));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return offsets;
}

function transitiveComponentRanges(sourceFile, seeds, authorizedCallSites = []) {
  const declarations = componentDeclarations(sourceFile);
  const ranges = [];
  const queued = [...seeds];
  const visited = new Set();
  while (queued.length > 0) {
    const name = queued.shift();
    if (!name || visited.has(name)) continue;
    visited.add(name);
    const declaration = declarations.get(name);
    if (!declaration) continue;
    const allowedReferences = [...authorizedCallSites, ...ranges];
    const references = componentReferenceOffsets(sourceFile, name);
    if (references.length === 0 || references.some((offset) => !offsetInRanges(offset, allowedReferences))) continue;
    ranges.push([declaration.getStart(sourceFile), declaration.getEnd()]);
    for (const childName of componentNamesWithin(declaration)) queued.push(childName);
  }
  return ranges;
}

function devGuideCallSiteRanges(sourceFile) {
  const ranges = [];
  const visit = (node) => {
    if (ts.isConditionalExpression(node)
      && node.condition.getText(sourceFile).replace(/\s+/g, "") === "import.meta.env.DEV"
      && componentNamesWithin(node.whenTrue).has("GuidePage")) {
      ranges.push([node.whenTrue.getStart(sourceFile), node.whenTrue.getEnd()]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return ranges;
}

function markedDiagnosticNodes(sourceFile, markerValue = "ai-pm.development") {
  const nodes = [];
  const visit = (node) => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      const marker = opening.attributes.properties.find((attribute) =>
        ts.isJsxAttribute(attribute)
        && attribute.name.getText(sourceFile) === "data-wl-authorized-diagnostics"
        && jsxAttributeText(attribute) === markerValue);
      if (marker) nodes.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return nodes;
}

/**
 * 技术文案只在真实的授权 DOM 子树及其本地组件依赖中豁免。仅在注释或字符串中
 * 写 marker 不会再放行整份 P25；生产 BackendGate 也只能放行 DEV 分支引用的向导组件。
 */
function authorizedTechnicalRanges(source, fileName) {
  const normalized = fileName.replaceAll("\\", "/");
  const sourceFile = parseClientSource(source, normalized);
  const ranges = [];
  if (AUTHORIZED_DIAGNOSTIC_FILE.test(normalized)) {
    const marked = markedDiagnosticNodes(sourceFile);
    const markedRanges = marked.map((node) => [node.getStart(sourceFile), node.getEnd()]);
    const names = new Set();
    for (const node of marked) {
      for (const name of componentNamesWithin(node)) names.add(name);
    }
    ranges.push(...markedRanges, ...transitiveComponentRanges(sourceFile, names, markedRanges));
  }
  if (AUTHORIZED_LOCAL_GUIDE_FILE.test(normalized)) {
    const callSites = devGuideCallSiteRanges(sourceFile);
    ranges.push(...callSites, ...transitiveComponentRanges(sourceFile, new Set(["GuidePage"]), callSites));
  }
  if (AUTHORIZED_COMPONENT_MATRIX_FILE.test(normalized)) {
    const marked = markedDiagnosticNodes(sourceFile, "ui-component-matrix");
    const markedRanges = marked.map((node) => [node.getStart(sourceFile), node.getEnd()]);
    const names = new Set();
    for (const node of marked) {
      for (const name of componentNamesWithin(node)) names.add(name);
    }
    ranges.push(...markedRanges, ...transitiveComponentRanges(sourceFile, names, markedRanges));
  }
  return ranges;
}

function offsetInRanges(offset, ranges) {
  return ranges.some(([start, end]) => offset >= start && offset < end);
}

function literalLanguageRules(text, kind = "页面文本") {
  const rules = [];
  let literalText = stripTemplateInterpolations(String(text));
  literalText = literalText.replace(/\{[A-Za-z][A-Za-z0-9_]*\}/g, "");
  // 地址与明确的键盘快捷键属于可执行输入，不把域名、F11 误判为产品英文或工程代号。
  literalText = literalText.replace(/\bhttps?:\/\/[^\s，。；）)]+/gi, "");
  literalText = literalText.replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|h|KB|MB|GB)\b/gi, "");
  literalText = literalText.replace(/(?:⌘(?:\/Ctrl)?|Ctrl)(?:\+Shift)?\+?[A-Z0-9]\b/g, "");
  if (/(?:快捷键|键盘|回车|方向键|按住)/.test(literalText)) literalText = literalText.replace(/\b(?:Shift|Ctrl|Alt|Cmd)\b/g, "");
  if (/(?:快捷键|键盘|全屏)/.test(literalText)) literalText = literalText.replace(/\bF(?:[1-9]|1\d|2[0-4])\b/g, "");
  const engineeringText = literalText;
  if (kind === "裸 JSON" || text === "JSON.stringify") rules.push("客户端不得直接渲染裸 JSON");
  if (ENGINEERING_CODE.test(engineeringText)) rules.push("客户端不得展示 P/F/E/L 工程代号");
  if (RAW_CLIENT_TERM.test(literalText) || RAW_FIELD_SHAPE.test(literalText)) {
    rules.push("客户端不得展示英文底层字段或工程术语");
  }
  const unknownLatin = [...literalText.matchAll(LATIN_TOKEN)]
    .map(([token]) => token)
    .filter((token) => !SAFE_VISIBLE_LATIN_TERM.test(token) && !/^v\d+(?:\.\d+)*$/i.test(token));
  if (unknownLatin.length > 0) rules.push(`客户端可见英文未登记中文边界：${[...new Set(unknownLatin)].slice(0, 3).join("、")}`);
  return [...new Set(rules)];
}

/** 门禁文件发现本身也做成可测试规则，避免新增扩展名或共享组件后静默漏扫。 */
export function isClientSurfaceSource(fileName) {
  const normalized = fileName.replaceAll("\\", "/").replace(/^\.\//, "");
  if (UPSTREAM_VENDOR_ASSET.test(normalized)) return false;
  return (CLIENT_SOURCE_ROOT.test(normalized) || CLIENT_PUBLIC_WORKER.test(normalized)
      || CLIENT_PUBLIC_INDUSTRY_SOURCE.test(normalized))
    && CLIENT_SOURCE_FILE.test(normalized)
    && !CLIENT_SOURCE_EXCLUSION.test(normalized);
}

export function isBundleUiConfig(fileName) {
  const normalized = fileName.replaceAll("\\", "/").replace(/^\.\//, "");
  return BUNDLE_UI_CONFIG_FILE.test(normalized);
}

export function isClientWebManifest(fileName) {
  const normalized = fileName.replaceAll("\\", "/").replace(/^\.\//, "");
  return CLIENT_WEB_MANIFEST_FILE.test(normalized);
}

export function isClientPublicHtml(fileName) {
  const normalized = fileName.replaceAll("\\", "/").replace(/^\.\//, "");
  return CLIENT_PUBLIC_HTML_FILE.test(normalized);
}

/**
 * clientFoundation 明确保留给行业的五类 PC 可写路径。导航门禁必须覆盖整个集合，
 * 不能只检查 extensions/projections 而让 config、theme 或 public 成为第二套导航入口。
 */
export function isPcIndustryNavigationSource(fileName) {
  const normalized = fileName.replaceAll("\\", "/").replace(/^\.\//, "");
  return PC_INDUSTRY_UI_ROOT.test(normalized)
    && PC_INDUSTRY_NAVIGATION_SOURCE.test(normalized)
    && !CLIENT_SOURCE_EXCLUSION.test(normalized);
}

/** clientFoundation 五类行业可写路径中的 CSS/SCSS 必须接受浮面治理。 */
export function isIndustryExtensionStylesheet(fileName) {
  const normalized = fileName.replaceAll("\\", "/").replace(/^\.\//, "");
  return INDUSTRY_UI_ROOT.test(normalized)
    && INDUSTRY_STYLESHEET.test(normalized)
    && !CLIENT_SOURCE_EXCLUSION.test(normalized);
}

export function isIndustryExtensionSource(fileName) {
  const normalized = fileName.replaceAll("\\", "/").replace(/^\.\//, "");
  return INDUSTRY_UI_ROOT.test(normalized)
    && INDUSTRY_CLIENT_SOURCE.test(normalized)
    && !CLIENT_SOURCE_EXCLUSION.test(normalized);
}

export function isIndustryUiConfig(fileName) {
  const normalized = fileName.replaceAll("\\", "/").replace(/^\.\//, "");
  return INDUSTRY_UI_ROOT.test(normalized)
    && INDUSTRY_UI_CONFIG.test(normalized)
    && !CLIENT_SOURCE_EXCLUSION.test(normalized);
}

function immutableAliasDeclarations(sourceFile) {
  const declarations = [];
  const visit = (node) => {
    if (ts.isVariableDeclaration(node)
      && (node.parent.flags & ts.NodeFlags.Const) !== 0
      && node.initializer) declarations.push(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return declarations;
}

function bindingPropertyName(element) {
  const property = element.propertyName ?? element.name;
  if (ts.isIdentifier(property) || ts.isStringLiteral(property) || ts.isNumericLiteral(property)) return property.text;
  return "";
}

function addObjectBindingAliases(declaration, sourceAliases, propertyName, targetAliases) {
  if (!ts.isObjectBindingPattern(declaration.name) || !sourceAliases(declaration.initializer)) return false;
  let changed = false;
  for (const element of declaration.name.elements) {
    if (element.dotDotDotToken || !ts.isIdentifier(element.name) || bindingPropertyName(element) !== propertyName) continue;
    if (!targetAliases.has(element.name.text)) {
      targetAliases.add(element.name.text);
      changed = true;
    }
  }
  return changed;
}

function staticStringValue(expression) {
  const target = unwrapExpression(expression);
  if (!target) return null;
  if (ts.isStringLiteral(target) || ts.isNoSubstitutionTemplateLiteral(target)) return target.text;
  if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticStringValue(target.left);
    const right = staticStringValue(target.right);
    return left === null || right === null ? null : left + right;
  }
  return null;
}

function memberName(expression) {
  const target = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(target)) return target.name.text;
  if (ts.isElementAccessExpression(target)) {
    return staticStringValue(target.argumentExpression) ?? "";
  }
  return "";
}

function hasDynamicMemberAccess(expression) {
  let current = unwrapExpression(expression);
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    if (ts.isElementAccessExpression(current) && staticStringValue(current.argumentExpression) === null) return true;
    current = unwrapExpression(current.expression);
  }
  return false;
}

function memberChainNames(expression) {
  const names = [];
  let current = unwrapExpression(expression);
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    names.unshift(memberName(current));
    current = unwrapExpression(current.expression);
  }
  return names;
}

function chainHasOwner(expression, predicate) {
  let current = unwrapExpression(expression);
  while (current) {
    if (predicate(current)) return true;
    if (!ts.isPropertyAccessExpression(current) && !ts.isElementAccessExpression(current)) return false;
    current = unwrapExpression(current.expression);
  }
  return false;
}

function memberDepthFromOwner(expression, predicate) {
  let current = unwrapExpression(expression);
  let depth = 0;
  while (current) {
    if (predicate(current)) return depth;
    if (!ts.isPropertyAccessExpression(current) && !ts.isElementAccessExpression(current)) return -1;
    current = unwrapExpression(current.expression);
    depth += 1;
  }
  return -1;
}

function isMemberOf(expression, ownerPredicate, name) {
  const target = unwrapExpression(expression);
  return (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target))
    && memberName(target) === name
    && ownerPredicate(target.expression);
}

function isBoundAliasOf(expression, targetPredicate) {
  const target = unwrapExpression(expression);
  return ts.isCallExpression(target)
    && isMemberOf(target.expression, targetPredicate, "bind");
}

function staticArrayArguments(expression) {
  const target = unwrapExpression(expression);
  if (!target || !ts.isArrayLiteralExpression(target)) return null;
  const values = [];
  for (const element of target.elements) {
    if (ts.isOmittedExpression(element)) return null;
    if (ts.isSpreadElement(element)) {
      const nested = staticArrayArguments(element.expression);
      if (!nested) return null;
      values.push(...nested);
    } else values.push(element);
  }
  return values;
}

function invocationArguments(call, targetPredicate) {
  const expression = unwrapExpression(call.expression);
  if (targetPredicate(expression)) return { matched: true, arguments: [...call.arguments], error: "" };
  if ((ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression))
    && memberName(expression) === "call" && targetPredicate(expression.expression)) {
    return { matched: true, arguments: [...call.arguments].slice(1), error: "" };
  }
  if ((ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression))
    && memberName(expression) === "apply" && targetPredicate(expression.expression)) {
    const args = staticArrayArguments(call.arguments[1]);
    return args
      ? { matched: true, arguments: args, error: "" }
      : { matched: true, arguments: [], error: "调用 apply 时参数必须是可静态展开的数组字面量" };
  }
  const reflectApply = isMemberOf(expression, (owner) => {
    const target = unwrapExpression(owner);
    return ts.isIdentifier(target) && target.text === "Reflect";
  }, "apply");
  if (reflectApply && call.arguments[0] && targetPredicate(call.arguments[0])) {
    const args = staticArrayArguments(call.arguments[2]);
    return args
      ? { matched: true, arguments: args, error: "" }
      : { matched: true, arguments: [], error: "调用 Reflect.apply 时参数必须是可静态展开的数组字面量" };
  }
  return { matched: false, arguments: [], error: "" };
}

function referenceFromArgument(sourceFile, argument, label, fallbackNode) {
  const lineNode = argument ?? fallbackNode;
  const line = sourceFile.getLineAndCharacterOfPosition(lineNode.getStart(sourceFile)).line + 1;
  const staticValue = argument ? staticStringValue(argument) : null;
  if (staticValue && !/[\\\0\r\n]/u.test(staticValue)) {
    return { line, path: staticValue, text: staticValue, rule: "" };
  }
  return {
    line,
    path: null,
    text: argument ? argument.getText(sourceFile).slice(0, 96) : "缺少路径",
    rule: `${label}必须使用静态本地路径`,
  };
}

function scriptSegments(source, fileName) {
  if (!/\.html?$/i.test(fileName)) return [{ source, lineOffset: 0 }];
  const clean = source.replace(/<!--[\s\S]*?-->/g, preserveLineBreaks);
  const segments = [];
  for (const match of clean.matchAll(/<script\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attributes = htmlAttributes(match[1] ?? "");
    const type = attributes.get("type")?.value.trim().toLowerCase() ?? "";
    if (attributes.has("src") || (type && !["module", "text/javascript", "application/javascript"].includes(type))) continue;
    const openingLength = match[0].indexOf(">") + 1;
    const bodyOffset = (match.index ?? 0) + openingLength;
    segments.push({ source: match[2] ?? "", lineOffset: sourceLineAt(source, bodyOffset) - 1 });
  }
  return segments;
}

function serviceWorkerAstReferences(source, fileName, lineOffset = 0) {
  const sourceFile = parseClientSource(source, fileName);
  const declarations = immutableAliasDeclarations(sourceFile);
  const navigatorAliases = new Set();
  const serviceWorkerAliases = new Set();
  const registerAliases = new Set();
  const isRootObject = (expression) => {
    const target = unwrapExpression(expression);
    return ts.isIdentifier(target) && ["globalThis", "self", "window"].includes(target.text);
  };
  const isNavigator = (expression) => {
    const target = unwrapExpression(expression);
    return (ts.isIdentifier(target) && (target.text === "navigator" || navigatorAliases.has(target.text)))
      || isMemberOf(target, isRootObject, "navigator");
  };
  const isServiceWorker = (expression) => {
    const target = unwrapExpression(expression);
    return (ts.isIdentifier(target) && serviceWorkerAliases.has(target.text))
      || isMemberOf(target, isNavigator, "serviceWorker");
  };
  const isRegister = (expression) => {
    const target = unwrapExpression(expression);
    return (ts.isIdentifier(target) && registerAliases.has(target.text))
      || isMemberOf(target, isServiceWorker, "register");
  };

  // 只追踪不可重新赋值的 const 别名；迭代允许 nav -> serviceWorker -> register 的常见链路。
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      if (ts.isIdentifier(declaration.name)) {
        const name = declaration.name.text;
        const initializer = unwrapExpression(declaration.initializer);
        const target = isBoundAliasOf(initializer, isRegister) ? registerAliases
          : isRegister(initializer) ? registerAliases
            : isServiceWorker(initializer) ? serviceWorkerAliases
              : isNavigator(initializer) ? navigatorAliases : null;
        if (target && !target.has(name)) { target.add(name); changed = true; }
      }
      changed = addObjectBindingAliases(declaration, isNavigator, "serviceWorker", serviceWorkerAliases) || changed;
      changed = addObjectBindingAliases(declaration, isServiceWorker, "register", registerAliases) || changed;
    }
  }

  const references = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const expression = unwrapExpression(node.expression);
      const invocation = invocationArguments(node, isRegister);
      if (invocation.matched) {
        if (invocation.error) {
          references.push({
            line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1 + lineOffset,
            path: null,
            text: node.getText(sourceFile).slice(0, 96),
            rule: `Service Worker register ${invocation.error}`,
          });
        } else {
          const reference = referenceFromArgument(sourceFile, invocation.arguments[0], "Service Worker 注册路径", node);
          references.push({ ...reference, line: reference.line + lineOffset });
        }
      } else {
        const navigatorDepth = memberDepthFromOwner(expression, isNavigator);
        const names = memberChainNames(expression);
        const dynamicRegistration = hasDynamicMemberAccess(expression) && navigatorDepth >= 0
          && (navigatorDepth >= 2 || names.includes("serviceWorker") || names.includes("register"));
        if (!dynamicRegistration) {
          ts.forEachChild(node, visit);
          return;
        }
        references.push({
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1 + lineOffset,
          path: null,
          text: expression.getText(sourceFile).slice(0, 96),
          rule: "Service Worker 的 serviceWorker 与 register 成员必须使用可折叠的静态名称",
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return references;
}

/** 任意文件名的 Service Worker 只能通过可追踪的静态本地路径注册；注释与字符串不会触发。 */
export function findServiceWorkerRegistrations(source, fileName = "client.tsx") {
  return scriptSegments(source, fileName).flatMap((segment, index) =>
    serviceWorkerAstReferences(
      segment.source,
      /\.html?$/i.test(fileName) ? `${fileName}.inline-${index + 1}.js` : fileName,
      segment.lineOffset,
    ));
}

function isExplicitLocalModuleSpecifier(path) {
  return /^(?:\.{1,2}\/|\/)/u.test(path)
    && !/^(?:\/\/|[a-z][a-z0-9+.-]*:)/iu.test(path);
}

/**
 * 已注册 Worker 的整个可执行依赖图都必须可定位。经典 importScripts 与模块
 * import/export-from 会递归扫描；动态 import、表达式路径与外部/裸模块说明符关闭失败。
 */
export function findWorkerScriptImports(source, fileName = "public-worker.js") {
  const sourceFile = parseClientSource(source, fileName);
  const declarations = immutableAliasDeclarations(sourceFile);
  const workerGlobalAliases = new Set();
  const importScriptsAliases = new Set();
  const isWorkerGlobal = (expression) => {
    const target = unwrapExpression(expression);
    return ts.isIdentifier(target) && (["globalThis", "self"].includes(target.text) || workerGlobalAliases.has(target.text));
  };
  const isImportScripts = (expression) => {
    const target = unwrapExpression(expression);
    return (ts.isIdentifier(target) && (target.text === "importScripts" || importScriptsAliases.has(target.text)))
      || isMemberOf(target, isWorkerGlobal, "importScripts");
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      if (ts.isIdentifier(declaration.name)) {
        const initializer = unwrapExpression(declaration.initializer);
        if (isWorkerGlobal(initializer) && !workerGlobalAliases.has(declaration.name.text)) {
          workerGlobalAliases.add(declaration.name.text);
          changed = true;
        }
        if ((isImportScripts(initializer) || isBoundAliasOf(initializer, isImportScripts))
          && !importScriptsAliases.has(declaration.name.text)) {
          importScriptsAliases.add(declaration.name.text);
          changed = true;
        }
      }
      changed = addObjectBindingAliases(declaration, isWorkerGlobal, "importScripts", importScriptsAliases) || changed;
    }
  }

  const references = [];
  const addModuleReference = (node, specifier, label) => {
    const reference = referenceFromArgument(sourceFile, specifier, label, node);
    if (!reference.rule && !isExplicitLocalModuleSpecifier(reference.path)) {
      references.push({ ...reference, path: null, rule: `${label}必须使用静态本地路径，禁止外部或裸模块说明符` });
    } else references.push(reference);
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
      addModuleReference(node, node.moduleSpecifier, "Worker 模块 import 路径");
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && !node.isTypeOnly) {
      addModuleReference(node, node.moduleSpecifier, "Worker 模块 export-from 路径");
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      references.push({
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        path: null,
        text: node.getText(sourceFile).slice(0, 96),
        rule: "Worker 禁止动态 import；请改为静态 import 或 export-from",
      });
    } else if (ts.isCallExpression(node)) {
      const invocation = invocationArguments(node, isImportScripts);
      if (invocation.matched) {
        if (invocation.error) {
          references.push({
            line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
            path: null,
            text: node.getText(sourceFile).slice(0, 96),
            rule: `Worker importScripts ${invocation.error}`,
          });
        } else {
          for (const argument of invocation.arguments) {
            references.push(referenceFromArgument(sourceFile, argument, "Worker importScripts 路径", node));
          }
        }
      } else if (hasDynamicMemberAccess(node.expression)
        && memberDepthFromOwner(node.expression, isWorkerGlobal) >= 1) {
        references.push({
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          path: null,
          text: node.expression.getText(sourceFile).slice(0, 96),
          rule: "Worker importScripts 成员必须使用可折叠的静态名称",
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return references;
}

/** 安装名称会进入系统桌面、启动器与安装提示，属于客户端可见文案而非普通机器配置。 */
export function findClientWebManifestRisks(source, fileName = "apps/web/public/manifest.webmanifest") {
  const risks = findBundleDisplayLanguageRisks(source, fileName);
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    return risks;
  }
  if (!/^zh(?:-CN|-Hans)?$/i.test(String(parsed.lang ?? ""))) {
    risks.push({ line: 1, text: String(parsed.lang ?? "未声明"), path: "$.lang", rule: "客户端安装清单必须明确声明中文语言" });
  }
  return risks;
}

function decodeBasicHtmlEntities(value) {
  return value
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replace(/&#(?:x([0-9a-f]+)|([0-9]+));?/gi, (entity, hex, decimal) => {
      const codePoint = Number.parseInt(hex ?? decimal, hex ? 16 : 10);
      if (!Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return entity;
      try { return String.fromCodePoint(codePoint); } catch { return entity; }
    });
}

function preserveLineBreaks(value) {
  return value.replace(/[^\r\n]/g, " ");
}

function htmlAttributes(tag) {
  const attributes = new Map();
  for (const match of tag.matchAll(/(?:^|\s)([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)) {
    attributes.set(match[1].toLowerCase(), {
      offset: match.index ?? 0,
      value: match[2] ?? match[3] ?? match[4] ?? "",
    });
  }
  return attributes;
}

/** HTML 外壳也会在 React 挂载前、安装预览或失败态中直接呈现，不能成为 JSX 门禁外的后门。 */
export function findHtmlVisibleLanguageRisks(source, fileName = "apps/web/index.html") {
  const clean = source.replace(/<!--[\s\S]*?-->/g, preserveLineBreaks);
  const risks = [];
  const add = (text, offset, kind) => {
    const normalized = decodeBasicHtmlEntities(String(text).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    if (!normalized) return;
    for (const rule of literalLanguageRules(normalized, kind)) {
      risks.push({ line: sourceLineAt(source, offset), text: normalized.slice(0, 96), rule });
    }
  };
  const htmlTag = clean.match(/<html\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/i);
  const lang = htmlTag ? htmlAttributes(htmlTag[0]).get("lang")?.value ?? "" : "";
  if (!/^zh(?:-CN|-Hans)?$/i.test(lang)) {
    risks.push({ line: 1, text: lang || "未声明", rule: "三端 HTML 外壳必须明确声明中文语言" });
  }
  for (const match of clean.matchAll(/<title\b[^>]*>([\s\S]*?)<\/title>/gi)) add(match[1], match.index ?? 0, "HTML 标题");
  for (const match of clean.matchAll(/<noscript\b[^>]*>([\s\S]*?)<\/noscript>/gi)) add(match[1], match.index ?? 0, "HTML 降级提示");
  for (const match of clean.matchAll(/<([a-z][\w:-]*)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi)) {
    const tagName = match[1].toLowerCase();
    const attributes = htmlAttributes(match[0]);
    const tagOffset = match.index ?? 0;
    if (tagName === "meta") {
      const metaName = attributes.get("name")?.value.toLowerCase() ?? "";
      const metaProperty = attributes.get("property")?.value.toLowerCase() ?? "";
      const visibleMeta = ["description", "application-name", "apple-mobile-web-app-title", "twitter:title", "twitter:description"].includes(metaName)
        || ["og:title", "og:description"].includes(metaProperty);
      const content = attributes.get("content");
      if (visibleMeta && content?.value) add(content.value, tagOffset + content.offset, "HTML 描述");
    }
    for (const attributeName of ["alt", "aria-label", "aria-description", "aria-placeholder", "aria-valuetext", "data-label", "data-title", "data-tooltip", "label", "placeholder", "title"]) {
      const attribute = attributes.get(attributeName);
      if (attribute?.value) add(attribute.value, tagOffset + attribute.offset, "HTML 可见属性");
    }
    const inputValue = attributes.get("value");
    if (tagName === "input" && attributes.get("type")?.value.toLowerCase() !== "hidden" && inputValue?.value) {
      add(inputValue.value, tagOffset + inputValue.offset, "HTML 输入初始值");
    }
  }
  const visibleText = clean.replace(/<(script|style|template|svg|title|noscript)\b[\s\S]*?<\/\1\s*>/gi, preserveLineBreaks);
  for (const match of visibleText.matchAll(/>([^<]+)</g)) {
    add(match[1], (match.index ?? 0) + 1, "HTML 页面正文");
  }
  return risks;
}

/**
 * Bundle 投影和场景配置会绕过 JSX 静态字面量检查，因此只扫描明确会成为界面内容的键。
 * 代码型 id/kind/role/category 等仍由各自契约校验，不误当作客户端展示文案。
 */
export function findBundleDisplayLanguageRisks(source, fileName = "bundle-ui.json") {
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    return [{
      line: 1,
      text: String(error instanceof Error ? error.message : error).slice(0, 96),
      path: "$",
      rule: "Bundle 客户端配置必须是有效 JSON",
    }];
  }
  const risks = [];
  const cursors = new Map();
  const lineOf = (value) => {
    const literal = JSON.stringify(value);
    const cursor = cursors.get(literal) ?? 0;
    const found = source.indexOf(literal, cursor);
    if (found < 0) return 1;
    cursors.set(literal, found + literal.length);
    return sourceLineAt(source, found);
  };
  const visit = (value, path, key = "") => {
    if (typeof value === "string" && BUNDLE_DISPLAY_KEY.has(key)) {
      for (const rule of literalLanguageRules(value, `Bundle 展示字段 ${key}`)) {
        risks.push({ line: lineOf(value), text: value, path, rule });
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`, key));
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [childKey, child] of Object.entries(value)) visit(child, `${path}.${childKey}`, childKey);
  };
  visit(parsed, "$", "");
  return risks;
}

/**
 * 行业本地 JSON/YAML 可被客户端直接 import，必须显式区分 display 与 machine。
 * 字典型文件默认把除 machine 外的字符串视为可见文案；普通配置沿用展示字段表。
 */
export function findIndustryConfigDisplayRisks(source, fileName, { requirePartition = false } = {}) {
  const normalizedFile = fileName.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!isIndustryUiConfig(normalizedFile)) return [];
  const labelDictionary = LABEL_DICTIONARY_FILE.test(normalizedFile);
  const risks = [];
  const addVisible = (value, line, path, key, visible) => {
    if (!visible || typeof value !== "string") return;
    for (const rule of literalLanguageRules(value, `行业配置展示字段 ${key || path}`)) {
      risks.push({ line, text: value.slice(0, 96), path, rule });
    }
  };
  const partitionRisk = (topLevelKeys, hasDisplay) => {
    if (!requirePartition) return;
    if (!hasDisplay || topLevelKeys.some((key) => !["display", "machine"].includes(key))) {
      risks.push({
        line: 1,
        text: topLevelKeys.join(", ") || "空配置",
        path: "$",
        rule: "被客户端导入的行业 JSON/YAML 必须只用 display 与 machine 顶层分区，避免机器字段进入界面",
      });
    }
  };

  if (/\.json$/i.test(normalizedFile)) {
    let parsed;
    try {
      parsed = JSON.parse(source);
    } catch (error) {
      return [{
        line: 1,
        text: String(error instanceof Error ? error.message : error).slice(0, 96),
        path: "$",
        rule: "行业客户端 JSON 必须是有效 JSON",
      }];
    }
    const rootObject = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    const topLevelKeys = rootObject ? Object.keys(rootObject) : [];
    partitionRisk(topLevelKeys, Boolean(rootObject && Object.hasOwn(rootObject, "display")));
    const cursors = new Map();
    const lineOf = (value) => {
      const literal = JSON.stringify(value);
      const cursor = cursors.get(literal) ?? 0;
      const found = source.indexOf(literal, cursor);
      if (found < 0) return 1;
      cursors.set(literal, found + literal.length);
      return sourceLineAt(source, found);
    };
    const visit = (value, path, key = "", rootZone = "") => {
      const zone = path === "$" ? rootZone : rootZone;
      if (typeof value === "string") {
        addVisible(value, lineOf(value), path, key, zone === "display" || (zone !== "machine" && (labelDictionary || BUNDLE_DISPLAY_KEY.has(key))));
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((item, index) => visit(item, `${path}[${index}]`, key, zone));
        return;
      }
      if (!value || typeof value !== "object") return;
      for (const [childKey, child] of Object.entries(value)) {
        const childZone = path === "$" && ["display", "machine"].includes(childKey) ? childKey : zone;
        visit(child, `${path}.${childKey}`, childKey, childZone);
      }
    };
    visit(parsed, "$", "", "");
    return risks;
  }

  for (const [index, rawLine] of source.split(/\r?\n/u).entries()) {
    const unsupported = /:\s*[|>][+-]?\s*(?:#.*)?$/u.test(rawLine)
      || /^\s*(?:---|\.\.\.)\s*(?:#.*)?$/u.test(rawLine)
      || /^\s*<<\s*:/u.test(rawLine)
      || /(?:^|:\s*|-\s*)[&*!][A-Za-z_][\w-]*/u.test(rawLine)
      || /:\s*[\[{]/u.test(rawLine);
    if (unsupported) {
      risks.push({
        line: index + 1,
        text: rawLine.trim().slice(0, 96),
        path: "$",
        rule: "行业客户端 YAML 禁止 block scalar、anchor、tag、merge 与多文档等未受支持语法，请改用静态标量或 JSON",
      });
    }
  }
  const stack = [];
  const topLevelKeys = [];
  let hasDisplay = false;
  for (const [index, rawLine] of source.split(/\r?\n/u).entries()) {
    if (!rawLine.trim() || /^\s*#/u.test(rawLine)) continue;
    const sequence = rawLine.match(/^(\s*)-\s+(.+?)\s*$/u);
    if (sequence) {
      const indent = sequence[1].replaceAll("\t", "  ").length;
      while (stack.length > 0 && stack.at(-1).indent >= indent) stack.pop();
      let value = sequence[2].replace(/\s+#.*$/u, "").trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (!/^(?:true|false|null|~|[-+]?\d+(?:\.\d+)?)$/iu.test(value)) {
        const rootZone = stack[0]?.key ?? "";
        addVisible(value, index + 1, `$.${stack.map((item) => item.key).join(".")}[]`, "item",
          rootZone === "display" || (rootZone !== "machine" && labelDictionary));
      }
      continue;
    }
    const match = rawLine.match(/^(\s*)([^:#][^:]*?)\s*:\s*(.*?)\s*$/u);
    if (!match) continue;
    const indent = match[1].replaceAll("\t", "  ").length;
    const key = match[2].trim().replace(/^(?:"([^"]*)"|'([^']*)')$/u, (_all, double, single) => double ?? single ?? "");
    let value = match[3].replace(/\s+#.*$/u, "").trim();
    while (stack.length > 0 && stack.at(-1).indent >= indent) stack.pop();
    if (indent === 0) {
      topLevelKeys.push(key);
      if (key === "display") hasDisplay = true;
    }
    const rootZone = indent === 0 && ["display", "machine"].includes(key)
      ? key : (stack[0]?.key ?? "");
    const path = [...stack.map((item) => item.key), key].join(".");
    if (!value) {
      stack.push({ indent, key });
      continue;
    }
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else if (/^(?:true|false|null|~|[-+]?\d+(?:\.\d+)?)$/iu.test(value)) continue;
    addVisible(value, index + 1, `$.${path}`, key,
      rootZone === "display" || (rootZone !== "machine" && (labelDictionary || BUNDLE_DISPLAY_KEY.has(key))));
  }
  partitionRisk([...new Set(topLevelKeys)], hasDisplay);
  return risks;
}

/** 返回客户端源码对本地 JSON/YAML 的静态依赖；动态路径保持 fail closed。 */
export function findIndustryConfigImports(source, fileName = "client.tsx") {
  const sourceFile = parseClientSource(source, fileName);
  const references = [];
  const add = (node, specifier) => {
    const value = staticStringValue(specifier);
    const text = specifier?.getText(sourceFile).slice(0, 96) ?? "缺少路径";
    if (value !== null && /\.(?:json|ya?ml)$/i.test(value)) {
      references.push({
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        path: value,
        text: value,
        rule: /^\.{1,2}\//u.test(value) ? "" : "行业 JSON/YAML 必须使用静态相对路径导入",
      });
    } else if (value === null && /(?:json|ya?ml)/i.test(text)) {
      references.push({
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        path: null,
        text,
        rule: "行业 JSON/YAML 导入路径必须是可折叠的静态相对字符串",
      });
    }
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) add(node, node.moduleSpecifier);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node, node.arguments[0]);
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") add(node, node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return references;
}

/** 行业样式依赖只允许静态相对路径；解析与边界验真由仓库级门禁完成。 */
export function findStylesheetImports(source, fileName = "industry.css") {
  const clean = stripComments(source);
  const references = [];
  for (const match of clean.matchAll(/@(import|use|forward)\s+([^;]+);/gi)) {
    const directive = match[1].toLowerCase();
    const raw = (match[2] ?? "").trim();
    let path = null;
    const url = raw.match(/^url\(\s*(?:(["'])(.*?)\1|([^)'"\s]+))\s*\)(?:\s+.*)?$/iu);
    const quoted = raw.match(/^(["'])(.*?)\1(?:\s+(?:as|with|layer|supports|screen|print|all|not|only|\().*)?$/iu);
    if (url) path = url[2] ?? url[3] ?? null;
    else if (quoted) path = quoted[2];
    const line = sourceLineAt(clean, match.index ?? 0);
    if (!path || /[#{}$]/u.test(path)) {
      references.push({ line, path: null, text: match[0].slice(0, 96), directive,
        rule: "行业 CSS/SCSS 依赖必须使用无插值的静态相对路径" });
      continue;
    }
    if (!/^\.{1,2}\//u.test(path) || /^(?:\/\/|[a-z][a-z0-9+.-]*:)/iu.test(path)
      || /[\\\0\r\n?#]/u.test(path)) {
      references.push({ line, path: null, text: path.slice(0, 96), directive,
        rule: "行业 CSS/SCSS 禁止外部、绝对、data 或裸模块依赖，只允许仓内相对路径" });
      continue;
    }
    references.push({ line, path, text: path, directive, rule: "" });
  }
  return references;
}

/** public/industry HTML 的脚本与样式依赖必须留在受治理的本地资源图。 */
export function findIndustryHtmlResourceReferences(source, fileName) {
  const normalizedFile = fileName.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!isIndustryExtensionSource(normalizedFile) || !INDUSTRY_HTML.test(normalizedFile)) return [];
  const clean = source.replace(/<!--[\s\S]*?-->/g, preserveLineBreaks);
  const references = [];
  const add = (match, attribute, kind, { embedded = false } = {}) => {
    const path = attribute?.value.trim() ?? "";
    const line = sourceLineAt(clean, match.index ?? 0);
    const allowedLocal = /^\.{1,2}\//u.test(path) || (embedded && /^\/industry\/[^/]+\//u.test(path));
    if (!path || !allowedLocal || /^(?:\/\/|[a-z][a-z0-9+.-]*:)/iu.test(path)
      || /[\\\0\r\n?#]/u.test(path)) {
      references.push({ line, path: null, text: path || match[0].slice(0, 96), kind,
        rule: `行业 HTML ${kind}只允许受治理的静态相对本地资源` });
    } else references.push({ line, path, text: path, kind, rule: "" });
  };
  for (const match of clean.matchAll(/<script\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>/gi)) {
    const attributes = htmlAttributes(match[1] ?? "");
    if (attributes.has("src")) add(match, attributes.get("src"), "脚本");
  }
  for (const match of clean.matchAll(/<link\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>/gi)) {
    const attributes = htmlAttributes(match[1] ?? "");
    const rel = attributes.get("rel")?.value.toLowerCase().split(/\s+/u) ?? [];
    const styleResource = rel.includes("stylesheet") || attributes.get("as")?.value.toLowerCase() === "style";
    if (styleResource) add(match, attributes.get("href"), "样式");
  }
  for (const match of clean.matchAll(/<(iframe|webview|object|embed)\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>/gi)) {
    const tagName = match[1].toLowerCase();
    const attributes = htmlAttributes(match[2] ?? "");
    if (attributes.has("srcdoc")) {
      references.push({
        line: sourceLineAt(clean, match.index ?? 0), path: null, text: match[0].slice(0, 96), kind: "嵌入界面",
        rule: "行业 HTML 禁止 srcdoc 嵌入分叉界面",
      });
      continue;
    }
    const attribute = tagName === "object" ? attributes.get("data") : attributes.get("src");
    if (attribute) add(match, attribute, "嵌入界面", { embedded: true });
  }
  return references;
}

/** 五类行业源码中的嵌入界面依赖；本地路径仍需由仓库级资源图验真。 */
export function findIndustryEmbeddedUiReferences(source, fileName = "client.tsx") {
  if (!isIndustryExtensionSource(fileName)) return [];
  const sourceFile = parseClientSource(source, fileName);
  const references = [];
  const visit = (node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tagName = jsxTagTerminalName(node, sourceFile).toLowerCase();
      if (!["iframe", "webview", "object", "embed"].includes(tagName)) {
        ts.forEachChild(node, visit);
        return;
      }
      const srcDoc = findJsxAttribute(node, sourceFile, "srcDoc") ?? findJsxAttribute(node, sourceFile, "srcdoc");
      const src = findJsxAttribute(node, sourceFile, tagName === "object" ? "data" : "src");
      let value = null;
      if (src && ts.isJsxAttribute(src) && src.initializer) {
        if (ts.isStringLiteral(src.initializer)) value = src.initializer.text;
        else if (ts.isJsxExpression(src.initializer)) value = staticStringValue(src.initializer.expression);
      }
      const remote = value !== null && /^(?:\/\/|[a-z][a-z0-9+.-]*:)/iu.test(value);
      if (srcDoc || (src && (value === null || remote))) {
        references.push({
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          path: null,
          text: node.getText(sourceFile).trim().slice(0, 96),
          kind: tagName,
          rule: "行业 iframe/webview/object/embed 禁止远端、动态或 srcDoc 嵌入界面，只允许受审本地资源",
        });
      } else if (src && value !== null) {
        references.push({
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          path: value,
          text: value,
          kind: tagName,
          rule: "",
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return references;
}

export function findIndustryEmbeddedUiRisks(source, fileName = "client.tsx") {
  return findIndustryEmbeddedUiReferences(source, fileName).filter((reference) => reference.rule);
}

/**
 * Extract only strings that can reach a client-facing text position. Comments, types,
 * imports, enum values and CSS class names are deliberately ignored so implementation
 * vocabulary can remain precise without leaking into the product surface.
 */
export function collectVisibleStrings(source, fileName = "client.tsx") {
  const sourceFile = parseClientSource(source, fileName);
  const rows = [];
  const seen = new Set();

  const add = (text, node, kind) => {
    const normalized = String(text).replace(/\s+/g, " ").trim();
    if (!normalized) return;
    const offset = node.getStart(sourceFile);
    const line = sourceFile.getLineAndCharacterOfPosition(offset).line + 1;
    const key = `${line}:${kind}:${normalized}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({ text: normalized, line, kind, offset });
  };

  const addLiteralPieces = (expression, kind) => {
    for (const piece of literalPieces(expression)) add(piece, expression, kind);
  };
  const visit = (node) => {
    if (ts.isJsxText(node)) add(node.text, node, "页面文本");
    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(sourceFile);
      if (isVisibleJsxAttribute(node, name)) {
        if (node.initializer && ts.isStringLiteral(node.initializer)) add(node.initializer.text, node.initializer, `属性 ${name}`);
        if (node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression) {
          addLiteralPieces(node.initializer.expression, `属性 ${name}`);
        }
      }
    }
    if (ts.isJsxExpression(node) && node.expression && !ts.isJsxAttribute(node.parent)) {
      const parentTag = ts.isJsxElement(node.parent) ? jsxTagName(node.parent.openingElement) : "";
      if (!/^(?:script|style)$/i.test(parentTag)) addLiteralPieces(node.expression, "页面文本兜底");
      if (ts.isCallExpression(node.expression) && calledName(node.expression.expression) === "stringify"
        && rootIdentifierOf(node.expression.expression) === "JSON") add("JSON.stringify", node.expression, "裸 JSON");
    }
    if (ts.isPropertyAssignment(node)) {
      const name = node.name && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) ? node.name.text : "";
      if (VISIBLE_PROPERTY_NAMES.has(name)) addLiteralPieces(node.initializer, `展示字段 ${name}`);
    }
    if (ts.isCallExpression(node)) {
      const name = calledName(node.expression);
      const fullName = node.expression.getText(sourceFile);
      if (VISIBLE_SETTER.test(name) || name === "toast" || /(?:^|\.)toast\.(?:error|info|success|warn|warning)$/.test(fullName)
        || name === "speak") {
        for (const argument of node.arguments) for (const value of objectTextValues(argument)) addLiteralPieces(value, `反馈 ${name}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return rows;
}

export function findVisibleLanguageRisks(source, fileName = "client.tsx") {
  const risks = [];
  const authorizedRanges = authorizedTechnicalRanges(source, fileName);
  for (const item of collectVisibleStrings(source, fileName)) {
    if (offsetInRanges(item.offset, authorizedRanges)) continue;
    for (const rule of literalLanguageRules(item.text, item.kind)) risks.push({ ...item, rule });
  }
  return risks;
}

function stripTemplateInterpolations(text) {
  let result = "";
  for (let index = 0; index < text.length;) {
    if (text[index] !== "$" || text[index + 1] !== "{") {
      result += text[index];
      index += 1;
      continue;
    }
    let depth = 1;
    index += 2;
    while (index < text.length && depth > 0) {
      if (text[index] === "{") depth += 1;
      else if (text[index] === "}") depth -= 1;
      index += 1;
    }
  }
  return result;
}

function unwrapExpression(node) {
  let current = node;
  while (current && (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current)
  )) current = current.expression;
  return current;
}

function calledName(expression) {
  const target = unwrapExpression(expression);
  if (ts.isIdentifier(target)) return target.text;
  if (ts.isPropertyAccessExpression(target)) return target.name.text;
  if (ts.isElementAccessExpression(target) && target.argumentExpression
    && (ts.isStringLiteral(target.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(target.argumentExpression))) {
    return target.argumentExpression.text;
  }
  return "";
}

function propertyNameOf(expression) {
  const target = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(target)) return target.name.text;
  if (ts.isElementAccessExpression(target) && target.argumentExpression
    && (ts.isStringLiteral(target.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(target.argumentExpression))) {
    return target.argumentExpression.text;
  }
  return "";
}

function rootIdentifierOf(expression) {
  let current = unwrapExpression(expression);
  while (current) {
    if (ts.isIdentifier(current)) return current.text;
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      current = unwrapExpression(current.expression);
      continue;
    }
    if (ts.isCallExpression(current)) {
      current = unwrapExpression(current.expression);
      continue;
    }
    return "";
  }
  return "";
}

function propertyPathOf(expression) {
  const parts = [];
  let current = unwrapExpression(expression);
  while (current) {
    if (ts.isIdentifier(current)) {
      parts.unshift(current.text);
      break;
    }
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      const property = propertyNameOf(current);
      if (property) parts.unshift(property);
      current = unwrapExpression(current.expression);
      continue;
    }
    break;
  }
  return parts;
}

function isSafeDisplayFormatterCall(node) {
  const target = unwrapExpression(node.expression);
  if (ts.isIdentifier(target)) return SAFE_DISPLAY_FORMATTERS.has(target.text);
  return ts.isPropertyAccessExpression(target)
    && target.name.text === "get"
    && ts.isIdentifier(target.expression)
    && SAFE_DISPLAY_MAPS.has(target.expression.text);
}

function unsafeDynamicNames(expression, taintedIdentifiers = new Set()) {
  const names = [];
  const seen = new Set();
  const add = (name) => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    names.push(name);
  };
  const visit = (rawNode) => {
    const node = unwrapExpression(rawNode);
    if (!node) return;
    if (ts.isCallExpression(node)) {
      const name = calledName(node.expression);
      if (isSafeDisplayFormatterCall(node)) return;
      if (name === "stringify" && rootIdentifierOf(node.expression) === "JSON") add("JSON.stringify");
      if (name === "map" || name === "flatMap") {
        for (const argument of node.arguments) visit(argument);
        return;
      }
      visit(node.expression);
      for (const argument of node.arguments) visit(argument);
      return;
    }
    if (ts.isConditionalExpression(node)) {
      visit(node.whenTrue);
      visit(node.whenFalse);
      return;
    }
    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind;
      if ([ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken,
        ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken].includes(operator)) return;
      if (operator === ts.SyntaxKind.AmpersandAmpersandToken) visit(node.right);
      else { visit(node.left); visit(node.right); }
      return;
    }
    if (ts.isTemplateExpression(node)) {
      for (const span of node.templateSpans) visit(span.expression);
      return;
    }
    if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression)
      && SAFE_DISPLAY_MAPS.has(node.expression.text)) return;
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const property = propertyNameOf(node);
      const root = rootIdentifierOf(node);
      const path = propertyPathOf(node);
      if (RAW_DYNAMIC_FIELD.has(property)) add(property);
      if (UNTRUSTED_RESPONSE_FIELD.has(property)
        && (UNTRUSTED_RESPONSE_ROOT.test(root) || path.slice(0, -1).some((part) => /^(?:error|failure|response)$/i.test(part)))) {
        add(path.join("."));
      }
      visit(node.expression);
      if (ts.isElementAccessExpression(node) && node.argumentExpression) visit(node.argumentExpression);
      return;
    }
    if (ts.isIdentifier(node)) {
      if (RAW_DYNAMIC_FIELD.has(node.text)) add(node.text);
      if (taintedIdentifiers.has(node.text)) add(node.text);
      return;
    }
    if (ts.isArrowFunction(node)) {
      if (ts.isBlock(node.body)) {
        const visitReturns = (child) => {
          if (ts.isReturnStatement(child) && child.expression
            && !ts.isJsxElement(child.expression) && !ts.isJsxSelfClosingElement(child.expression) && !ts.isJsxFragment(child.expression)) {
            visit(child.expression);
            return;
          }
          ts.forEachChild(child, visitReturns);
        };
        visitReturns(node.body);
      } else if (!ts.isJsxElement(node.body) && !ts.isJsxSelfClosingElement(node.body) && !ts.isJsxFragment(node.body)) visit(node.body);
      return;
    }
    if (ts.isFunctionExpression(node)) {
      const visitReturns = (child) => {
        if (ts.isReturnStatement(child) && child.expression
          && !ts.isJsxElement(child.expression) && !ts.isJsxSelfClosingElement(child.expression) && !ts.isJsxFragment(child.expression)) {
          visit(child.expression);
          return;
        }
        ts.forEachChild(child, visitReturns);
      };
      visitReturns(node.body);
      return;
    }
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) return;
    ts.forEachChild(node, visit);
  };
  visit(expression);
  return names;
}

function collectTaintedIdentifiers(sourceFile) {
  const tainted = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    const add = (name) => {
      if (!name || tainted.has(name)) return;
      tainted.add(name);
      changed = true;
    };
    const visit = (node) => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const root = rootIdentifierOf(node.initializer);
        const path = propertyPathOf(node.initializer);
        const initializer = unwrapExpression(node.initializer);
        const directAccess = ts.isPropertyAccessExpression(initializer)
          || ts.isElementAccessExpression(initializer)
          || (ts.isIdentifier(initializer) && tainted.has(initializer.text));
        const directField = propertyNameOf(initializer);
        const untrustedSource = directAccess && (
          (UNTRUSTED_RESPONSE_FIELD.has(directField)
            && (UNTRUSTED_RESPONSE_ROOT.test(root) || path.some((part) => /^(?:error|failure|response)$/i.test(part))))
          || RAW_DYNAMIC_FIELD.has(directField)
          || (ts.isIdentifier(initializer) && tainted.has(initializer.text))
        );
        if (ts.isIdentifier(node.name) && untrustedSource) add(node.name.text);
        if (ts.isObjectBindingPattern(node.name)
          && (untrustedSource || UNTRUSTED_RESPONSE_ROOT.test(root))) {
          for (const element of node.name.elements) {
            if (!ts.isIdentifier(element.name)) continue;
            const property = element.propertyName?.getText(sourceFile) ?? element.name.text;
            if (UNTRUSTED_RESPONSE_FIELD.has(property) || untrustedSource) add(element.name.text);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return tainted;
}

/** 使用 TypeScript AST 检查 JSX 文本与动态可见属性，覆盖可选链、计算属性和嵌套模板。 */
export function findRawDynamicValueRisks(source, fileName = "client.tsx") {
  const sourceFile = parseClientSource(source, fileName);
  const authorizedRanges = authorizedTechnicalRanges(source, fileName);
  const taintedIdentifiers = collectTaintedIdentifiers(sourceFile);
  const risks = [];
  const seen = new Set();
  const add = (node, name) => {
    const offset = node.getStart(sourceFile);
    if (offsetInRanges(offset, authorizedRanges)) return;
    const line = sourceFile.getLineAndCharacterOfPosition(offset).line + 1;
    const text = node.getText(sourceFile).trim().slice(0, 96);
    const key = `${line}:${name}:${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    risks.push({ line, text, rule: `客户端动态值 ${name} 必须先经过中文映射或编号脱敏` });
  };
  const check = (expression) => {
    if (!expression) return;
    for (const name of unsafeDynamicNames(expression, taintedIdentifiers)) add(expression, name);
  };
  const visit = (node) => {
    if (ts.isJsxExpression(node) && node.expression) {
      if (ts.isJsxAttribute(node.parent)) {
        const attribute = node.parent.name.getText(sourceFile);
        if (isVisibleJsxAttribute(node.parent, attribute)) check(node.expression);
      } else if (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent)) check(node.expression);
    }
    if (ts.isPropertyAssignment(node)) {
      const name = node.name && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) ? node.name.text : "";
      if (NESTED_DYNAMIC_DISPLAY_PROPERTIES.has(name)) check(node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return risks;
}

const TEXT_SINK_CALL = /^(?:appendAi|enqueueSnackbar|notify|setBanner|setBindingError|setCaption|setDone|setErr|setError|setFeedback|setLoadMessage|setMessage|setMsg|setNotice|setRateError|setSiteResult|setSubtitle|setToast|showToast)$/;
const SINK_OBJECT_TEXT_KEY = new Set(["body", "channelName", "content", "description", "detail", "emptyLabel", "emptyText", "errorText", "failureText", "fallbackReason", "helperText", "label", "message", "noDataText", "summary", "text", "ticketTitle", "title", "tooltip"]);

function objectTextValues(node) {
  const target = unwrapExpression(node);
  if (!target) return [];
  if (!ts.isObjectLiteralExpression(target)) return [target];
  const values = [];
  for (const property of target.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? property.name.text : "";
    if (SINK_OBJECT_TEXT_KEY.has(name)) values.push(property.initializer);
  }
  return values;
}

function literalPieces(node) {
  const target = unwrapExpression(node);
  if (!target) return [];
  if (ts.isStringLiteral(target) || ts.isNoSubstitutionTemplateLiteral(target)) return [target.text];
  if (ts.isTemplateExpression(target)) return [target.head.text, ...target.templateSpans.map((span) => span.literal.text)];
  if (ts.isConditionalExpression(target)) return [...literalPieces(target.whenTrue), ...literalPieces(target.whenFalse)];
  if (ts.isBinaryExpression(target) && [ts.SyntaxKind.PlusToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(target.operatorToken.kind)) {
    return [...literalPieces(target.left), ...literalPieces(target.right)];
  }
  return [];
}

function assignedPropertyName(node) {
  const target = unwrapExpression(node);
  if (ts.isPropertyAccessExpression(target)) return target.name.text;
  if (ts.isElementAccessExpression(target)) {
    const argument = unwrapExpression(target.argumentExpression);
    if (argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) return argument.text;
  }
  return "";
}

/** 检查 JSX 之外的高风险客户端文字出口：标题、Toast、通知、语音/字幕与 DOM/canvas。 */
export function findClientTextSinkRisks(source, fileName = "client.tsx") {
  const sourceFile = parseClientSource(source, fileName);
  const authorizedRanges = authorizedTechnicalRanges(source, fileName);
  const taintedIdentifiers = collectTaintedIdentifiers(sourceFile);
  const risks = [];
  const seen = new Set();
  const add = (node, rule, text = node.getText(sourceFile)) => {
    const offset = node.getStart(sourceFile);
    if (offsetInRanges(offset, authorizedRanges)) return;
    const line = sourceFile.getLineAndCharacterOfPosition(offset).line + 1;
    const clipped = String(text).trim().slice(0, 96);
    const key = `${line}:${rule}:${clipped}`;
    if (seen.has(key)) return;
    seen.add(key);
    risks.push({ line, text: clipped, rule });
  };
  const checkValue = (node) => {
    for (const name of unsafeDynamicNames(node, taintedIdentifiers)) add(node, `客户端文字出口中的 ${name} 必须先经过中文映射或编号脱敏`);
    for (const piece of literalPieces(node)) {
      for (const rule of literalLanguageRules(piece, "文字出口")) add(node, rule, piece);
    }
  };
  const visit = (node) => {
    if (ts.isBinaryExpression(node)
      && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      const left = node.left.getText(sourceFile);
      const property = assignedPropertyName(node.left);
      if (["innerHTML", "outerHTML"].includes(property)) {
        add(node.left, "客户端禁止通过 innerHTML/outerHTML 注入可见内容，请使用受控文本或组件");
      } else if (left === "document.title" || ["alt", "ariaDescription", "ariaLabel", "innerText", "placeholder", "textContent", "title"].includes(property)) {
        checkValue(node.right);
      }
    }
    if (ts.isNewExpression(node)) {
      const name = calledName(node.expression);
      if (name === "Notification" || name === "SpeechSynthesisUtterance") {
        for (const argument of node.arguments ?? []) for (const value of objectTextValues(argument)) checkValue(value);
      }
    }
    if (ts.isCallExpression(node)) {
      const name = calledName(node.expression);
      const fullName = node.expression.getText(sourceFile);
      if (TEXT_SINK_CALL.test(name) || name === "toast" || /(?:^|\.)toast\.(?:error|info|success|warn|warning)$/.test(fullName)
        || ["alert", "confirm", "fillText", "prompt", "share", "showNotification", "speak", "strokeText"].includes(name)) {
        const args = ["fillText", "strokeText"].includes(name) ? node.arguments.slice(0, 1) : node.arguments;
        for (const argument of args) for (const value of objectTextValues(argument)) checkValue(value);
      }
      if (["createTextNode", "insertAdjacentText"].includes(name)) {
        const value = name === "insertAdjacentText" ? node.arguments[1] : node.arguments[0];
        if (value) checkValue(value);
      }
      if (name === "insertAdjacentHTML" || (["write", "writeln"].includes(name) && rootIdentifierOf(node.expression) === "document")) {
        add(node, "客户端禁止通过 HTML 字符串写入可见内容，请使用受控文本或组件");
      }
      if (name === "setAttribute" && node.arguments.length >= 2) {
        const attribute = node.arguments[0];
        if ((ts.isStringLiteral(attribute) || ts.isNoSubstitutionTemplateLiteral(attribute))
          && VISIBLE_ATTRIBUTES.has(attribute.text)) checkValue(node.arguments[1]);
      }
    }
    if (ts.isJsxAttribute(node) && node.name.getText(sourceFile) === "dangerouslySetInnerHTML") {
      add(node, "客户端禁止 dangerouslySetInnerHTML 绕过中文与内容安全门禁");
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return risks;
}

const SURFACE_COMPONENT_NAME = /(?:Modal|Dialog|Drawer|Popover|Popup|Sheet|Overlay)/;
const NON_SURFACE_INFRASTRUCTURE_NAME = /(?:Manager|Provider|Context)$/;
const SHARED_SURFACE_COMPONENTS = new Set([
  "ConfirmDialog", "Dialog", "Drawer", "ExportDialog", "Overlay", "Popover", "Sheet",
]);
const SHARED_LEFT_NAVIGATION_COMPONENTS = new Set(["SectionNavigation", "SideNavigation"]);

function jsxTagPath(node, sourceFile) {
  return node.tagName.getText(sourceFile);
}

function jsxTagTerminalName(node, sourceFile) {
  return jsxTagPath(node, sourceFile).split(".").at(-1) ?? "";
}

function findJsxAttribute(node, sourceFile, name) {
  return node.attributes.properties.find((attribute) => ts.isJsxAttribute(attribute)
    && attribute.name.getText(sourceFile) === name);
}

function hasManagedSurfaceSpread(node, managedBindings) {
  return node.attributes.properties.some((attribute) => (
    ts.isJsxSpreadAttribute(attribute)
    && ts.isIdentifier(attribute.expression)
    && managedBindings.has(attribute.expression.text)
  ));
}

function importComponentBindings(sourceFile, sharedUiFile) {
  const imports = new Map();
  const trustedNamespaces = new Set();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const sourceName = statement.moduleSpecifier.text;
    const trustedSurfaceSource = sourceName === "@workloom/ui" || (sharedUiFile && /^\.{1,2}\//u.test(sourceName));
    const bindings = statement.importClause?.namedBindings;
    if (statement.importClause?.name) {
      imports.set(statement.importClause.name.text, { original: "default", sourceName, trustedSurfaceSource: false });
    }
    if (bindings && ts.isNamespaceImport(bindings)) {
      imports.set(bindings.name.text, { original: "*", sourceName, trustedSurfaceSource });
      if (trustedSurfaceSource) trustedNamespaces.add(bindings.name.text);
      continue;
    }
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      imports.set(element.name.text, {
        original: (element.propertyName ?? element.name).text,
        sourceName,
        trustedSurfaceSource,
      });
    }
  }
  return { imports, trustedNamespaces };
}

function shadowedImportNames(sourceFile, candidateNames) {
  const shadowed = new Set();
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) return;
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node))
      && node.name && ts.isIdentifier(node.name) && candidateNames.has(node.name.text)) {
      shadowed.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return shadowed;
}

function isSharedSurfaceTag(node, sourceFile, imports, trustedNamespaces, shadowedSurfaceImports = new Set()) {
  const path = jsxTagPath(node, sourceFile);
  const terminal = jsxTagTerminalName(node, sourceFile);
  if (!SURFACE_COMPONENT_NAME.test(terminal) || NON_SURFACE_INFRASTRUCTURE_NAME.test(terminal)) return false;
  if (path.includes(".")) {
    const namespace = path.split(".", 1)[0];
    return trustedNamespaces.has(namespace) && SHARED_SURFACE_COMPONENTS.has(terminal)
      && !shadowedSurfaceImports.has(namespace);
  }
  const binding = imports.get(path);
  return Boolean(binding?.trustedSurfaceSource && SHARED_SURFACE_COMPONENTS.has(binding.original)
    && !shadowedSurfaceImports.has(path));
}

function staticValueText(node) {
  const target = unwrapExpression(node);
  if (!target) return "";
  if (ts.isNumericLiteral(target) || ts.isStringLiteral(target) || ts.isNoSubstitutionTemplateLiteral(target)) return target.text;
  if (target.kind === ts.SyntaxKind.TrueKeyword) return "true";
  if (target.kind === ts.SyntaxKind.FalseKeyword) return "false";
  return literalPieces(target).join(" ");
}

function inlineStyleSignals(node, sourceFile) {
  const style = findJsxAttribute(node, sourceFile, "style");
  if (!style || !ts.isJsxAttribute(style) || !style.initializer || !ts.isJsxExpression(style.initializer)) return {};
  const expression = unwrapExpression(style.initializer.expression);
  if (!expression || !ts.isObjectLiteralExpression(expression)) return {};
  const properties = new Map();
  for (const property of expression.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? property.name.text : "";
    if (name) properties.set(name, staticValueText(property.initializer));
  }
  const isZero = (name) => /^(?:0|0px)$/i.test(properties.get(name)?.trim() ?? "");
  const zIndex = properties.get("zIndex")?.trim() ?? "";
  const numericZ = Number(zIndex);
  return {
    fixed: properties.get("position")?.trim().toLowerCase() === "fixed",
    fullCover: isZero("inset")
      || (isZero("insetBlock") && isZero("insetInline"))
      || ["top", "right", "bottom", "left"].every(isZero),
    backdrop: ["backdropFilter", "WebkitBackdropFilter"].some((name) => {
      const value = properties.get(name)?.trim().toLowerCase() ?? "";
      return Boolean(value && value !== "none");
    }),
    highLayer: (Number.isFinite(numericZ) && numericZ >= 40)
      || /--wl-z-(?:dialog|drawer|emergency|floating|fullscreen|overlay|toast)\b/.test(zIndex),
    passive: properties.get("pointerEvents")?.trim().toLowerCase() === "none",
  };
}

function classNameSignals(node, sourceFile) {
  const className = findJsxAttribute(node, sourceFile, "className") ?? findJsxAttribute(node, sourceFile, "class");
  if (!className || !ts.isJsxAttribute(className) || !className.initializer) return {};
  let text = "";
  if (ts.isStringLiteral(className.initializer)) text = className.initializer.text;
  else if (ts.isJsxExpression(className.initializer) && className.initializer.expression) {
    const classPieces = (expression) => {
      const target = unwrapExpression(expression);
      if (!target) return [];
      const direct = literalPieces(target);
      if (direct.length > 0) return direct;
      if (ts.isCallExpression(target)) return target.arguments.flatMap(classPieces);
      if (ts.isArrayLiteralExpression(target)) return target.elements.flatMap(classPieces);
      if (ts.isObjectLiteralExpression(target)) {
        return target.properties.flatMap((property) => {
          if (ts.isPropertyAssignment(property)) {
            const key = property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? property.name.text : "";
            return [key, ...classPieces(property.initializer)].filter(Boolean);
          }
          return [];
        });
      }
      return [];
    };
    text = classPieces(className.initializer.expression).join(" ");
  }
  const tokens = new Set(text.split(/\s+/u).filter(Boolean));
  const allEdges = ["top-0", "right-0", "bottom-0", "left-0"].every((token) => tokens.has(token));
  const highLayer = [...tokens].some((token) => {
    const plain = token.match(/^z-(\d+)$/u);
    if (plain) return Number(plain[1]) >= 40;
    const arbitrary = token.match(/^z-\[([0-9]+)\]$/u);
    if (arbitrary) return Number(arbitrary[1]) >= 40;
    return /^z-\[(?:var\()?--wl-z-(?:dialog|drawer|emergency|floating|fullscreen|overlay|toast)/u.test(token);
  });
  return {
    fixed: tokens.has("fixed"),
    fullCover: tokens.has("inset-0") || tokens.has("inset-[0]")
      || (tokens.has("inset-x-0") && tokens.has("inset-y-0")) || allEdges,
    // backdrop-blur 常用于常驻页头/侧栏；只有显式 backdrop 层才单独构成遮罩信号。
    backdrop: tokens.has("backdrop") || [...tokens].some((token) => /(?:^|-)overlay-backdrop$/u.test(token)),
    highLayer,
    passive: tokens.has("pointer-events-none"),
  };
}

function componentDeclarationName(node) {
  if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) return node.name.text;
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
    const initializer = unwrapExpression(node.initializer);
    if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) return node.name.text;
  }
  return "";
}

function runtimeBindingName(node) {
  if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)
      || ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node))
    && node.name && ts.isIdentifier(node.name)) return node.name.text;
  return "";
}

function isSurfaceComponentName(name) {
  return /^[A-Z]/u.test(name) && SURFACE_COMPONENT_NAME.test(name) && !NON_SURFACE_INFRASTRUCTURE_NAME.test(name);
}

function surfaceRuntimeBindings(sourceFile) {
  const records = [];
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) return;
    const name = runtimeBindingName(node);
    if (isSurfaceComponentName(name)) records.push({ name, node });
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return records;
}

function topLevelComponentDeclarations(sourceFile) {
  const records = [];
  for (const statement of sourceFile.statements) {
    const statementName = componentDeclarationName(statement);
    if (statementName) records.push({ name: statementName, node: statement });
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const name = componentDeclarationName(declaration);
      if (name) records.push({ name, node: declaration });
    }
  }
  return records;
}

function declarationLexicalScope(node, sourceFile) {
  let current = node.parent;
  while (current && current !== sourceFile) {
    if (ts.isBlock(current) || ts.isModuleBlock(current) || ts.isCaseBlock(current)) return current;
    current = current.parent;
  }
  return sourceFile;
}

function nodeIsWithinScope(node, scope) {
  let current = node;
  while (current) {
    if (current === scope) return true;
    current = current.parent;
  }
  return false;
}

function declarationContainsManagedSurface(declaration, isManagedNode) {
  const initializer = ts.isVariableDeclaration(declaration) && declaration.initializer
    ? unwrapExpression(declaration.initializer) : null;
  const root = initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
    ? initializer : declaration;
  let managed = false;
  const inspect = (node) => {
    if (managed) return;
    if (node !== root && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)
      || ts.isArrowFunction(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node))) return;
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && isManagedNode(node)) {
      managed = true;
      return;
    }
    ts.forEachChild(node, inspect);
  };
  inspect(root);
  return managed;
}

function declarationDirectlyDelegatesSurface(declaration, isManagedNode) {
  const initializer = ts.isVariableDeclaration(declaration) && declaration.initializer
    ? unwrapExpression(declaration.initializer) : null;
  const callable = initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
    ? initializer : declaration;
  let sawManaged = false;
  let invalid = false;
  /**
   * `return null` / `return false` / `return undefined` / 裸 `return;` 是「本组件此刻不渲染」
   * 的常规写法（例如 `if (!open) return null;`），不能算作“自建浮层”。
   * 2026-09-19 修复：此前这类早返回会被判为 invalid，导致 `export function XOverlay(){ if (!open) return null; return <Overlay/>; }`
   * 这种**完全委托**的组件证明不出来，行业仓正常实现被误报。
   */
  const isNoopReturn = (expression) => {
    if (!expression) return true;
    const target = unwrapExpression(expression);
    return !target
      || target.kind === ts.SyntaxKind.NullKeyword
      || target.kind === ts.SyntaxKind.FalseKeyword
      || (ts.isIdentifier(target) && target.text === "undefined");
  };
  const checkExpression = (expression) => {
    const target = unwrapExpression(expression);
    if (!target || target.kind === ts.SyntaxKind.NullKeyword || target.kind === ts.SyntaxKind.FalseKeyword
      || (ts.isIdentifier(target) && target.text === "undefined")) return false;
    if (ts.isJsxElement(target)) {
      if (!isManagedNode(target.openingElement)) return false;
      sawManaged = true;
      return true;
    }
    if (ts.isJsxSelfClosingElement(target)) {
      if (!isManagedNode(target)) return false;
      sawManaged = true;
      return true;
    }
    if (ts.isConditionalExpression(target)) {
      return checkExpression(target.whenTrue) && checkExpression(target.whenFalse);
    }
    return false;
  };
  const inspectReturns = (node, rootCallable) => {
    if (invalid) return;
    if (node !== rootCallable && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)
      || ts.isArrowFunction(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node))) return;
    if (ts.isReturnStatement(node)) {
      if (!isNoopReturn(node.expression) && !checkExpression(node.expression)) invalid = true;
      return;
    }
    ts.forEachChild(node, (child) => inspectReturns(child, rootCallable));
  };
  if (ts.isArrowFunction(callable) && !ts.isBlock(callable.body)) {
    invalid = !checkExpression(callable.body);
  } else if (ts.isClassDeclaration(callable) || ts.isClassExpression(callable)) {
    const render = callable.members.find((member) => ts.isMethodDeclaration(member)
      && member.name && member.name.getText() === "render");
    if (!render) return false;
    inspectReturns(render, render);
  } else {
    inspectReturns(callable, callable);
  }
  return !invalid && sawManaged;
}

function hasModifier(node, kind) {
  return Boolean(node.modifiers?.some((modifier) => modifier.kind === kind));
}

/**
 * 为仓库级扫描器提供最小、可证明的跨文件事实。只有直接渲染 @workloom/ui
 * 受管表面的导出组件才进入白名单；相对转发与第三方重导出不会被递归信任。
 */
export function findSurfaceModuleFacts(source, fileName = "client.tsx") {
  const sourceFile = parseClientSource(source, fileName);
  const sharedUiFile = fileName.replaceAll("\\", "/").startsWith("packages/ui/src/");
  const { imports, trustedNamespaces } = importComponentBindings(sourceFile, sharedUiFile);
  const surfaceImportNames = new Set([...imports]
    .filter(([, binding]) => binding.trustedSurfaceSource
      && (binding.original === "*" || SHARED_SURFACE_COMPONENTS.has(binding.original)))
    .map(([localName]) => localName));
  const shadowed = shadowedImportNames(sourceFile, surfaceImportNames);
  const bindingCounts = new Map();
  for (const { name } of surfaceRuntimeBindings(sourceFile)) {
    bindingCounts.set(name, (bindingCounts.get(name) ?? 0) + 1);
  }
  const safeDeclarations = new Set();
  for (const { name, node: declaration } of topLevelComponentDeclarations(sourceFile)) {
    if (!isSurfaceComponentName(name) || bindingCounts.get(name) !== 1) continue;
    if (declarationDirectlyDelegatesSurface(declaration, (node) => (
      isSharedSurfaceTag(node, sourceFile, imports, trustedNamespaces, shadowed)
    ))) safeDeclarations.add(declaration);
  }

  const provableExports = new Set();
  const relativeImports = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
      && /^\.{1,2}\//u.test(statement.moduleSpecifier.text) && !statement.importClause?.isTypeOnly) {
      const sourceName = statement.moduleSpecifier.text;
      if (statement.importClause?.name) {
        relativeImports.push({ localName: statement.importClause.name.text, importedName: "default", sourceName });
      }
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        relativeImports.push({ localName: bindings.name.text, importedName: "*", sourceName });
      } else if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if (element.isTypeOnly) continue;
          relativeImports.push({
            localName: element.name.text,
            importedName: (element.propertyName ?? element.name).text,
            sourceName,
          });
        }
      }
    }
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name
      && safeDeclarations.has(statement) && hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      provableExports.add(hasModifier(statement, ts.SyntaxKind.DefaultKeyword) ? "default" : statement.name.text);
    }
    if (ts.isVariableStatement(statement) && hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && safeDeclarations.has(declaration)) {
          provableExports.add(declaration.name.text);
        }
      }
    }
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      const sourceName = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text : "";
      for (const element of statement.exportClause.elements) {
        const original = (element.propertyName ?? element.name).text;
        if (sourceName === "@workloom/ui" && SHARED_SURFACE_COMPONENTS.has(original)) {
          provableExports.add(element.name.text);
        } else if (!sourceName && topLevelComponentDeclarations(sourceFile)
          .some((record) => record.name === original && safeDeclarations.has(record.node))) {
          provableExports.add(element.name.text);
        }
      }
    }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals && ts.isIdentifier(statement.expression)
      && topLevelComponentDeclarations(sourceFile)
        .some((record) => record.name === statement.expression.text && safeDeclarations.has(record.node))) {
      provableExports.add("default");
    }
  }
  return { provableExports: [...provableExports], relativeImports };
}

/** 自建模态表面绕过统一层级、焦点圈定与 Esc 后进先出；只信任共享 hook 的真实返回值。 */
export function findUnmanagedSurfaceRisks(source, fileName = "client.tsx", { trustedRelativeSurfaceImports = [] } = {}) {
  const sourceFile = parseClientSource(source, fileName);
  const risks = [];
  const seen = new Set();
  const trustedRelativeSurfaces = new Set(trustedRelativeSurfaceImports);
  const normalizedFile = fileName.replaceAll("\\", "/");
  const sharedUiFile = normalizedFile.startsWith("packages/ui/src/");
  const managedHookNames = new Set();
  const { imports, trustedNamespaces } = importComponentBindings(sourceFile, sharedUiFile);
  const sharedSurfaceImportNames = new Set([...imports]
    .filter(([, binding]) => binding.trustedSurfaceSource
      && (binding.original === "*" || SHARED_SURFACE_COMPONENTS.has(binding.original)))
    .map(([localName]) => localName));
  const shadowedSurfaceImports = shadowedImportNames(sourceFile, sharedSurfaceImportNames);
  for (const [localName, binding] of imports) {
    const trustedHookSource = binding.sourceName === "@workloom/ui"
      // 相对导入在本仓遵循 TypeScript ESM 约定带 `.js` 后缀（构建产物需扩展名）；
      // 判定时先剥离扩展名再比对，避免把 `./managed-surface.js` 误判为不可信来源。
      || (sharedUiFile && /^(?:\.\.\/)*\.\/?managed-surface$/u.test(binding.sourceName.replace(/\.js$/u, "")));
    if (trustedHookSource && binding.original === "useManagedSurface") managedHookNames.add(localName);
  }
  const managedBindings = new Set();
  const shadowedHookNames = new Set();
  const collectShadows = (node) => {
    if (ts.isImportDeclaration(node)) return;
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isFunctionDeclaration(node))
      && node.name && ts.isIdentifier(node.name) && managedHookNames.has(node.name.text)) {
      shadowedHookNames.add(node.name.text);
    }
    ts.forEachChild(node, collectShadows);
  };
  collectShadows(sourceFile);
  const collectBindings = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const initializer = unwrapExpression(node.initializer);
      if (ts.isCallExpression(initializer) && ts.isIdentifier(initializer.expression)
        && managedHookNames.has(initializer.expression.text)
        && !shadowedHookNames.has(initializer.expression.text)) managedBindings.add(node.name.text);
    }
    ts.forEachChild(node, collectBindings);
  };
  collectBindings(sourceFile);
  const add = (node, rule) => {
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    const text = node.getText(sourceFile).trim().slice(0, 96);
    const key = `${line}:${rule}:${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    risks.push({ line, text, rule });
  };
  const safeLocalSurfaceDeclarations = new Set();
  const surfaceBindings = surfaceRuntimeBindings(sourceFile);
  const bindingsByName = new Map();
  for (const record of surfaceBindings) {
    const group = bindingsByName.get(record.name) ?? [];
    group.push(record);
    bindingsByName.set(record.name, group);
  }
  const declarationUsesManagedSurface = (declaration) => {
    const predicate = (node) => (
      isSharedSurfaceTag(node, sourceFile, imports, trustedNamespaces, shadowedSurfaceImports)
      || trustedRelativeSurfaces.has(jsxTagPath(node, sourceFile))
      || hasManagedSurfaceSpread(node, managedBindings)
    );
    return sharedUiFile
      ? declarationContainsManagedSurface(declaration, predicate)
      : declarationDirectlyDelegatesSurface(declaration, predicate);
  };
  for (const { name, node: declaration } of surfaceBindings) {
    const duplicates = bindingsByName.get(name) ?? [];
    if (duplicates.length > 1) {
      add(declaration, "弹窗、抽屉与浮层组件不得用同名或词法阴影声明混淆真实实现");
    }
    if (componentDeclarationName(declaration) === name) {
      if (duplicates.length === 1 && declarationUsesManagedSurface(declaration)) {
        safeLocalSurfaceDeclarations.add(declaration);
      } else if (!declarationUsesManagedSurface(declaration)) {
        add(declaration, "自建弹窗、抽屉或浮层组件必须委托 @workloom/ui 的共享受管表面");
      }
    } else if (ts.isVariableDeclaration(declaration) || ts.isBindingElement(declaration)) {
      add(declaration, "弹窗、抽屉与浮层不得通过变量 alias、解构或 export assignment 隐藏真实来源");
    } else if (ts.isParameter(declaration)) {
      add(declaration, "弹窗、抽屉与浮层名称不得通过参数或词法阴影隐藏真实来源");
    }
  }
  const topLevelSurfaceDeclarations = topLevelComponentDeclarations(sourceFile)
    .filter((record) => isSurfaceComponentName(record.name));
  const isSafeTopLevelSurfaceName = (name) => topLevelSurfaceDeclarations
    .some((record) => record.name === name && safeLocalSurfaceDeclarations.has(record.node));
  const isSafeLocalSurfaceUse = (name, useNode) => surfaceBindings.some((record) => (
    record.name === name
    && safeLocalSurfaceDeclarations.has(record.node)
    && nodeIsWithinScope(useNode, declarationLexicalScope(record.node, sourceFile))
  ));
  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      const sourceName = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text : "";
      for (const element of statement.exportClause.elements) {
        if (statement.isTypeOnly || element.isTypeOnly) continue;
        const original = (element.propertyName ?? element.name).text;
        const exported = element.name.text;
        const surfaceExport = [original, exported].some((name) => SURFACE_COMPONENT_NAME.test(name)
          && !NON_SURFACE_INFRASTRUCTURE_NAME.test(name));
        if (!surfaceExport) continue;
        if (sourceName === "@workloom/ui" && SHARED_SURFACE_COMPONENTS.has(original)) continue;
        if (sharedUiFile && /^\.{1,2}\//u.test(sourceName) && SHARED_SURFACE_COMPONENTS.has(original)) continue;
        if (!sourceName && isSafeTopLevelSurfaceName(original)) continue;
        add(element, "弹窗、抽屉与浮层不得从非 @workloom/ui 来源重导出");
      }
    }
    if (ts.isExportAssignment(statement)) {
      const expression = unwrapExpression(statement.expression);
      const path = expression?.getText(sourceFile) ?? "";
      const terminal = path.split(".").at(-1) ?? "";
      const bindingName = path.split(".", 1)[0];
      const binding = imports.get(bindingName);
      const semanticName = binding && !path.includes(".") ? binding.original : terminal;
      const surfaceAssignment = [terminal, semanticName].some((name) => SURFACE_COMPONENT_NAME.test(name)
        && !NON_SURFACE_INFRASTRUCTURE_NAME.test(name));
      const directShared = Boolean(binding?.trustedSurfaceSource
        && ((path.includes(".") && binding.original === "*" && SHARED_SURFACE_COMPONENTS.has(terminal))
          || (!path.includes(".") && SHARED_SURFACE_COMPONENTS.has(binding.original)))
        && !shadowedSurfaceImports.has(bindingName));
      if (surfaceAssignment && !directShared && !isSafeTopLevelSurfaceName(path)) {
        add(statement, "弹窗、抽屉与浮层不得通过 export assignment 隐藏非 @workloom/ui 来源");
      }
    }
  }
  const visit = (node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tagPath = jsxTagPath(node, sourceFile);
      const tagName = jsxTagTerminalName(node, sourceFile);
      const intrinsic = /^[a-z]/.test(tagPath);
      const explicitlyManaged = hasManagedSurfaceSpread(node, managedBindings);
      const sharedSurface = isSharedSurfaceTag(node, sourceFile, imports, trustedNamespaces, shadowedSurfaceImports);
      const rootBindingName = tagPath.split(".", 1)[0];
      const binding = imports.get(tagPath) ?? imports.get(rootBindingName);
      const importedSurfaceName = tagPath.includes(".") ? tagName : binding?.original ?? "";
      const surfaceLike = [tagName, importedSurfaceName].some((name) => SURFACE_COMPONENT_NAME.test(name)
        && !NON_SURFACE_INFRASTRUCTURE_NAME.test(name));
      if (!intrinsic && surfaceLike
        && !sharedSurface && !isSafeLocalSurfaceUse(tagName, node)) {
        if (!binding || !/^\.{1,2}\//u.test(binding.sourceName) || !trustedRelativeSurfaces.has(tagPath)) {
          add(node, "弹窗、抽屉与浮层只能使用 @workloom/ui 共享组件，禁止未知或第三方包装");
        }
      }
      const role = findJsxAttribute(node, sourceFile, "role");
      const roleText = role && ts.isJsxAttribute(role) ? jsxAttributeText(role) : "";
      const ariaModal = findJsxAttribute(node, sourceFile, "aria-modal");
      const popoverAttribute = findJsxAttribute(node, sourceFile, "popover");
      if (intrinsic && !explicitlyManaged) {
        if (["dialog", "alertdialog"].includes(roleText) || ariaModal || popoverAttribute || tagName === "dialog") {
          add(node, "弹窗、抽屉与浮层必须接入共享受管表面，禁止绕过统一层级、焦点与关闭逻辑");
        }
        const inline = inlineStyleSignals(node, sourceFile);
        const classes = classNameSignals(node, sourceFile);
        const fixed = inline.fixed || classes.fixed;
        const fullCover = inline.fullCover || classes.fullCover;
        const backdrop = inline.backdrop || classes.backdrop;
        const highLayer = inline.highLayer || classes.highLayer;
        const ariaHidden = findJsxAttribute(node, sourceFile, "aria-hidden");
        const passiveSurface = Boolean(ariaHidden || inline.passive || classes.passive);
        const overlayContainer = ["article", "aside", "dialog", "div", "form", "main", "section"].includes(tagName);
        if (overlayContainer && fixed && (fullCover || backdrop || highLayer) && !passiveSurface && tagName !== "header") {
          add(node, "fixed 全屏、遮罩或高层浮面必须接入共享受管表面，禁止自建无 role 覆盖层");
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return risks;
}

/** PC 行业五类可写路径的页内导航必须复用共享左栏，禁止重新引入顶部横向导航。 */
export function findPcExtensionNavigationRisks(source, fileName = "client.tsx") {
  const normalized = fileName.replaceAll("\\", "/");
  if (!isPcIndustryNavigationSource(normalized)) return [];
  const sourceFile = parseClientSource(source, normalized);
  const risks = [];
  const { imports, trustedNamespaces } = importComponentBindings(sourceFile, false);
  const sharedNavigationNames = new Set();
  const sharedNavigationNamespaces = new Set();
  for (const [localName, binding] of imports) {
    if (binding.sourceName !== "@workloom/ui") continue;
    if (binding.original === "*" && trustedNamespaces.has(localName)) sharedNavigationNamespaces.add(localName);
    if (SHARED_LEFT_NAVIGATION_COMPONENTS.has(binding.original)) sharedNavigationNames.add(localName);
  }
  const shadowedNavigationImports = shadowedImportNames(sourceFile, new Set([
    ...sharedNavigationNames,
    ...sharedNavigationNamespaces,
  ]));
  const forbiddenComponent = /(?:Nav(?:igation)?(?:Tabs?)?|Navigation)$|^(?:Tabs|TabList)$/;
  const visit = (node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const path = jsxTagPath(node, sourceFile);
      const name = jsxTagTerminalName(node, sourceFile);
      const sharedLeftNavigation = (sharedNavigationNames.has(path) && !shadowedNavigationImports.has(path))
        || (path.includes(".") && sharedNavigationNamespaces.has(path.split(".", 1)[0])
          && !shadowedNavigationImports.has(path.split(".", 1)[0])
          && SHARED_LEFT_NAVIGATION_COMPONENTS.has(name));
      const navigationLike = name === "nav" || forbiddenComponent.test(name)
        || SHARED_LEFT_NAVIGATION_COMPONENTS.has(name);
      if (navigationLike && !sharedLeftNavigation) {
        risks.push({
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          text: node.getText(sourceFile).trim().slice(0, 96),
          rule: "PC 行业扩展不得自建顶部/横向导航；页内分区必须复用 @workloom/ui 左侧 SectionNavigation",
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return risks;
}

/** P25 可保留必要技术契约，但必须同时具备权限路由、醒目标识和审计说明。 */
export function findDiagnosticIsolationRisks(pageSource, appSource, playwrightSource = "", industryRouteSource = "") {
  const risks = [];
  const pageFile = parseClientSource(pageSource, "apps/web/src/extensions/ai-pm/P25.tsx");
  const marked = markedDiagnosticNodes(pageFile);
  const markedSource = marked.map((node) => pageSource.slice(node.getStart(pageFile), node.getEnd())).join("\n");
  const cleanApp = stripComments(appSource);
  const cleanPlaywright = stripComments(playwrightSource);
  const cleanIndustryRoute = stripComments(industryRouteSource);
  if (marked.length === 0) risks.push("开发场域缺少真实 DOM 授权诊断隔离标识");
  if (!markedSource.includes("授权开发诊断") || !markedSource.includes("仅限已获开发权限的管理员")) risks.push("开发场域授权子树缺少面向用户的授权提示");
  if (!markedSource.includes("开发事件、围栏审计与版本台账")) risks.push("开发场域授权子树缺少可审计性说明");
  if (!/capabilityId\s*:\s*["']ai-pm\.development["']/.test(cleanIndustryRoute)
    || !/path\s*:\s*["']\/development["']/.test(cleanIndustryRoute)
    || !/legacyPaths\s*:\s*\[[^\]]*["']\/p25["'][^\]]*\]/.test(cleanIndustryRoute)) {
    risks.push("开发场域未通过行业扩展契约声明语义路由、能力权限与受控历史地址");
  }
  if (!/import\.meta\.env\.DEV\s*&&\s*import\.meta\.env\.VITE_ENABLE_UI_DIAGNOSTICS\s*===\s*["']true["']/.test(cleanApp)) risks.push("组件矩阵必须同时受开发环境与显式开关约束");
  if (!/<Route\b[^>]*path\s*=\s*["']\/dev["'][^>]*element\s*=\s*\{<UiDiagnosticsRoute\s*\/>\}/.test(cleanApp)) risks.push("组件矩阵路由不得直接渲染诊断页面");
  if (playwrightSource && !cleanPlaywright.includes("VITE_ENABLE_UI_DIAGNOSTICS=true")) risks.push("视觉测试未显式开启组件矩阵");
  return risks;
}

/** /dev 组件矩阵可保留验收术语，但必须同时具备真实 DOM 标识和双重 DEV 路由门。 */
export function findComponentMatrixIsolationRisks(matrixSource, appSource, playwrightSource = "") {
  const risks = [];
  const matrixFile = parseClientSource(matrixSource, "apps/web/src/pages/dev/DevMatrix.tsx");
  if (markedDiagnosticNodes(matrixFile, "ui-component-matrix").length === 0) {
    risks.push("组件矩阵缺少真实 DOM 授权诊断隔离标识");
  }
  if (!matrixSource.includes("仅限本地开发环境") || !matrixSource.includes("显式开启诊断开关")) {
    risks.push("组件矩阵缺少面向开发者的隔离提示");
  }
  const cleanApp = stripComments(appSource);
  const cleanPlaywright = stripComments(playwrightSource);
  if (!/import\.meta\.env\.DEV\s*&&\s*import\.meta\.env\.VITE_ENABLE_UI_DIAGNOSTICS\s*===\s*["']true["']/.test(cleanApp)) {
    risks.push("组件矩阵必须同时受开发环境与显式开关约束");
  }
  if (!/return\s+enabled\s*\?\s*<Bridge>\s*<DevMatrix\s*\/>\s*<\/Bridge>\s*:\s*<NotFound\s*\/>/.test(cleanApp)) {
    risks.push("组件矩阵守卫必须实际消费双重开关并在关闭时返回未找到页");
  }
  if (!/<Route\b[^>]*path\s*=\s*["']\/dev["'][^>]*element\s*=\s*\{<UiDiagnosticsRoute\s*\/>\}/.test(cleanApp)) {
    risks.push("组件矩阵路由不得直接渲染诊断页面");
  }
  if (playwrightSource && !cleanPlaywright.includes("VITE_ENABLE_UI_DIAGNOSTICS=true")) {
    risks.push("视觉测试未显式开启组件矩阵");
  }
  return risks;
}

export function findViewportRisks(html) {
  const risks = [];
  if (/user-scalable\s*=\s*(?:no|0)/i.test(html)) risks.push("禁止关闭页面缩放（user-scalable）");
  if (/maximum-scale\s*=\s*1(?:\.0+)?(?:\s|[,"'])/i.test(html)) risks.push("禁止把最大缩放倍率锁定为 1");
  return risks;
}

export function findEntryStyleRisks(source) {
  const risks = [];
  for (const style of ["tokens.css", "content-safety.css", "components.css"]) {
    if (!source.includes(`@workloom/ui/${style}`)) risks.push(`缺少共享样式 ${style}`);
  }
  return risks;
}

export function findContentSafetyRisks(contentSafetyCss, pcCss = "") {
  const risks = [];
  const required = [
    ["min-inline-size: 0", "交互元素缺少可收缩约束"],
    ["white-space: normal", "按钮缺少长中文换行约束"],
    ["overflow-wrap: anywhere", "动态内容缺少任意断行约束"],
    ["word-break: break-word", "动态内容缺少单词断行约束"],
    [".wl-action-row", "移动端操作组缺少堆叠约束"],
    ["white-space: pre-wrap", "代码与回执内容缺少安全换行约束"],
  ];
  for (const [needle, message] of required) {
    if (!contentSafetyCss.includes(needle)) risks.push(message);
  }
  if (/code\s*,\s*\.font-mono\s*\{[^}]*white-space\s*:\s*nowrap/is.test(pcCss)) {
    risks.push("PC 兼容样式不得强制全部等宽内容不换行");
  }
  return risks;
}

function sourceLineAt(source, offset) {
  return source.slice(0, offset).split("\n").length;
}

function openingTags(source, startPattern) {
  const clean = stripComments(source);
  const starts = [...clean.matchAll(startPattern)];
  const tags = [];
  for (const start of starts) {
    let quote = "";
    let braces = 0;
    let index = start.index ?? 0;
    for (; index < clean.length; index += 1) {
      const char = clean[index];
      const next = clean[index + 1];
      if (quote) {
        if (char === "\\") { index += 1; continue; }
        if (char === quote) quote = "";
        continue;
      }
      if (char === '"' || char === "'" || char === "`") { quote = char; continue; }
      if (char === "{") { braces += 1; continue; }
      if (char === "}") { braces = Math.max(0, braces - 1); continue; }
      if (char === ">" && braces === 0) {
        tags.push({ text: clean.slice(start.index, index + 1), offset: start.index, end: index + 1 });
        break;
      }
      if (char === "/" && next === ">" && braces === 0) {
        tags.push({ text: clean.slice(start.index, index + 2), offset: start.index, end: index + 2 });
        break;
      }
    }
  }
  return tags;
}

function interactiveOpeningTags(source) {
  return openingTags(source, /<(?:button|a|Link|input|select|textarea)\b/g);
}

function allOpeningTags(source) {
  return openingTags(source, /<[A-Za-z][\w.:~-]*\b/g);
}

/**
 * 三端业务代码只能消费共享 Icon。只有机器可读二维码、数字员工形象、动态角色与
 * 首页全息人物可以保留自绘 SVG，且必须逐个声明用途与辅助技术语义。
 */
export function findSharedIconRisks(source, fileName = "client.tsx") {
  const clean = stripComments(source);
  const normalizedFile = fileName.replaceAll("\\", "/");
  const risks = [];
  const approvedRanges = [];
  const approvedMarkers = new Set();

  for (const tag of openingTags(source, /<svg\b/g)) {
    const marker = tag.text.match(/\bdata-wl-custom-graphic\s*=\s*["']([^"']+)["']/)?.[1];
    const contract = marker ? CUSTOM_GRAPHICS[marker] : undefined;
    const closing = clean.indexOf("</svg>", tag.end);
    if (!contract || !contract.file.test(normalizedFile)) {
      risks.push({
        line: sourceLineAt(clean, tag.offset),
        rule: "客户端不得自建功能 SVG；请使用 @workloom/ui Icon，特殊图形须登记用途",
        text: marker ? `未授权图形 ${marker}` : "svg",
      });
      continue;
    }
    if (closing < 0) {
      risks.push({ line: sourceLineAt(clean, tag.offset), rule: "特殊 SVG 图形缺少闭合标签", text: marker });
      continue;
    }
    if (contract.accessible === "image" && (!/\brole\s*=\s*["']img["']/.test(tag.text) || !/\baria-label\s*=/.test(tag.text))) {
      risks.push({ line: sourceLineAt(clean, tag.offset), rule: "有信息含义的特殊图形必须声明 role=img 与中文可访问名称", text: marker });
    }
    if (contract.accessible === "decorative" && !/\baria-hidden\s*=/.test(tag.text)) {
      risks.push({ line: sourceLineAt(clean, tag.offset), rule: "装饰性特殊图形必须对辅助技术隐藏", text: marker });
    }
    if (contract.accessible === "nested") {
      if (!/\baria-hidden\s*=/.test(tag.text)) {
        risks.push({ line: sourceLineAt(clean, tag.offset), rule: "角色内部矢量必须对辅助技术隐藏", text: marker });
      }
      if (!/\brole\s*=\s*["']img["'][\s\S]{0,180}\baria-label\s*=|\baria-label\s*=[\s\S]{0,180}\brole\s*=\s*["']img["']/.test(clean)) {
        risks.push({ line: sourceLineAt(clean, tag.offset), rule: "动态角色外层必须提供 role=img 与中文可访问名称", text: marker });
      }
    }
    approvedMarkers.add(marker);
    approvedRanges.push([tag.offset, closing + "</svg>".length]);
  }

  // 允许自绘图形把复杂矢量片段拆成同文件子组件，但片段必须位于显式登记的 g 容器内，
  // 且文件中必须存在同用途、已通过辅助技术校验的根 SVG。不能借此放行文件内其他 path。
  for (const tag of openingTags(source, /<g\b/g)) {
    const marker = tag.text.match(/\bdata-wl-custom-graphic-part\s*=\s*["']([^"']+)["']/)?.[1];
    if (!marker) continue;
    const contract = CUSTOM_GRAPHICS[marker];
    const closing = clean.indexOf("</g>", tag.end);
    if (!contract || !contract.file.test(normalizedFile) || !approvedMarkers.has(marker)) {
      risks.push({
        line: sourceLineAt(clean, tag.offset),
        rule: "特殊 SVG 子图形必须与已登记的根图形同文件同用途",
        text: marker,
      });
      continue;
    }
    if (closing < 0) {
      risks.push({ line: sourceLineAt(clean, tag.offset), rule: "特殊 SVG 子图形缺少闭合标签", text: marker });
      continue;
    }
    approvedRanges.push([tag.offset, closing + "</g>".length]);
  }

  for (const match of clean.matchAll(/<path\b/g)) {
    const offset = match.index ?? 0;
    if (approvedRanges.some(([start, end]) => offset >= start && offset < end)) continue;
    risks.push({
      line: sourceLineAt(clean, offset),
      rule: "客户端不得维护独立 path 图标；请使用 @workloom/ui Icon",
      text: "path",
    });
  }

  for (const match of clean.matchAll(FUNCTIONAL_GLYPH)) {
    risks.push({
      line: sourceLineAt(clean, match.index ?? 0),
      rule: "客户端不得用表情或字体符号充当功能图标/状态编码；请使用共享 Icon 并保留文字语义",
      text: match[0],
    });
  }
  return risks;
}

/**
 * Prevent the two recurring readability regressions reported in review:
 * arbitrary 9–13px client text and compact typography on body/actionable content.
 * Caption/micro tokens remain available only on explicitly marked, non-actionable
 * metadata (`data-wl-meta`), so a future field cannot silently turn body copy small.
 */
export function findTypographyRisks(source) {
  const clean = stripComments(source);
  const risks = [];
  for (const match of clean.matchAll(/\btext-\[(\d+(?:\.\d+)?)px\]/g)) {
    const size = Number(match[1]);
    if (size >= 9 && size < 14) {
      risks.push({
        line: sourceLineAt(clean, match.index ?? 0),
        rule: "客户端不得使用 9–13px 任意字号，请使用共享字号令牌",
        text: match[0],
      });
    }
  }
  for (const match of clean.matchAll(/\bfontSize\s*:\s*([^,\n}]+)/g)) {
    const expression = match[1] ?? "";
    const sizes = [...expression.matchAll(/(?:^|[^\w.])(\d+(?:\.\d+)?)(?:px)?\b/g)].map((item) => Number(item[1]));
    if (sizes.some((size) => size >= 9 && size < 14)) {
      risks.push({
        line: sourceLineAt(clean, match.index ?? 0),
        rule: "客户端内联样式字号不得低于 14px",
        text: match[0],
      });
    }
  }
  for (const match of clean.matchAll(/\bwhiteSpace\s*:\s*["']nowrap["']/g)) {
    risks.push({
      line: sourceLineAt(clean, match.index ?? 0),
      rule: "客户端内联样式不得强制单行，动态内容必须安全换行",
      text: match[0],
    });
  }
  const tags = allOpeningTags(source);
  for (const match of clean.matchAll(/\b(?:file:)?text-(?:micro|caption|xs)\b/g)) {
    const offset = match.index ?? 0;
    const tag = tags.find((candidate) => candidate.offset <= offset && candidate.end > offset);
    const explicitlyMetadata = Boolean(tag && /\bdata-wl-meta(?:\s|=)/.test(tag.text));
    const actionable = Boolean(tag && /^<(?:button|a|Link|input|select|textarea)\b/.test(tag.text));
    if (!explicitlyMetadata || actionable) {
      risks.push({
        line: sourceLineAt(clean, offset),
        rule: actionable
          ? "正文与交互控件字号不得低于 14px"
          : "10–13px 字号仅限显式标记的非关键元数据",
        text: match[0],
      });
    }
  }
  for (const tag of tags.filter((candidate) => /\b(?:truncate|whitespace-nowrap)\b/.test(candidate.text))) {
    if (/\btitle\s*=/.test(tag.text)) continue;
    risks.push({
      line: sourceLineAt(clean, tag.offset),
      rule: "截断或强制单行内容必须提供完整文本提示，关键动态内容应直接换行",
      text: tag.text.trim().slice(0, 72),
    });
  }
  return risks;
}

export function findStylesheetLayoutRisks(source) {
  const risks = [];
  for (const match of source.matchAll(/font-size\s*:\s*(\d*\.?\d+)(px|rem)\b/gi)) {
    const numeric = Number(match[1]);
    const pixels = match[2].toLowerCase() === "rem" ? numeric * 16 : numeric;
    if (pixels >= 9 && pixels < 14) {
      risks.push({
        line: sourceLineAt(source, match.index ?? 0),
        rule: "客户端样式不得硬编码 9–13px 字号，请使用共享字号令牌",
        text: match[0],
      });
    }
  }
  for (const match of source.matchAll(/body\s*\{[^}]*\bmin-width\s*:\s*([^;}]+)/gis)) {
    if (/^0(?:px|rem)?$/i.test(match[1].trim())) continue;
    risks.push({
      line: sourceLineAt(source, match.index ?? 0),
      rule: "页面根容器不得设置固定最小宽度",
      text: `min-width: ${match[1].trim()}`,
    });
  }
  for (const match of source.matchAll(/white-space\s*:\s*nowrap\b/gi)) {
    risks.push({
      line: sourceLineAt(source, match.index ?? 0),
      rule: "客户端业务样式不得强制单行，受控省略请使用共享安全类并提供完整提示",
      text: match[0],
    });
  }
  return risks;
}

/**
 * CSS module/SCSS 里的覆盖层不会出现在 JSX className 字面量中。行业可写路径
 * 因而按声明组合关闭：fixed 加全覆盖、backdrop 或高 z-index 必须移入共享受管表面。
 * 唯一豁免是基座共享组件本身的受管实现文件，行业仓同名文件不会获得豁免。
 */
export function findStylesheetSurfaceRisks(source, fileName = "industry.css") {
  const normalizedFile = fileName.replaceAll("\\", "/").replace(/^\.\//, "");
  if (normalizedFile === MANAGED_SURFACE_STYLESHEET) return [];
  const clean = stripComments(source);
  const risks = [];
  const isZero = (value) => {
    const normalized = (value ?? "").replace(/\s*!important\s*$/i, "").trim();
    if (!normalized) return false;
    return normalized.split(/\s+/u).every((part) => /^0(?:px|rem|em|%)?$/i.test(part));
  };
  for (const match of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = (match[1] ?? "").trim();
    const body = match[2] ?? "";
    const declarations = new Map();
    for (const declaration of body.matchAll(/(?:^|;)\s*(-?[a-z][\w-]*)\s*:\s*([^;}]+)/gi)) {
      declarations.set(declaration[1].toLowerCase(), declaration[2].trim());
    }
    const position = (declarations.get("position") ?? "").replace(/\s*!important\s*$/i, "").trim();
    if (position.toLowerCase() !== "fixed") continue;
    const fullCover = isZero(declarations.get("inset"))
      || (isZero(declarations.get("inset-block")) && isZero(declarations.get("inset-inline")))
      || ["top", "right", "bottom", "left"].every((property) => isZero(declarations.get(property)));
    const backdrop = ["backdrop-filter", "-webkit-backdrop-filter"].some((property) => {
      const value = (declarations.get(property) ?? "").replace(/\s*!important\s*$/i, "").trim().toLowerCase();
      return Boolean(value && value !== "none");
    });
    const zIndex = (declarations.get("z-index") ?? "").replace(/\s*!important\s*$/i, "").trim();
    const numericZ = Number(zIndex);
    const highLayer = (Number.isFinite(numericZ) && numericZ >= 40)
      || /--wl-z-(?:dialog|drawer|emergency|floating|fullscreen|overlay|toast)\b/i.test(zIndex);
    if (!fullCover && !backdrop && !highLayer) continue;
    risks.push({
      line: sourceLineAt(clean, match.index ?? 0),
      rule: "行业 CSS/SCSS 不得自建 fixed 全屏、遮罩或高层浮面，请使用 @workloom/ui 共享受管表面",
      text: `${selector} { ${body.trim()} }`.slice(0, 96),
    });
  }
  return risks;
}

/**
 * 告警条是三端公共反馈能力。它必须依靠内在 flex 换行而不是视口媒体查询，
 * 因为 PC 三栏布局在 1024px/200% 文字时可把内容区压缩到约 430px。
 */
export function findBannerAlertContractRisks(componentSource, stylesheetSource, pcAdapterSource) {
  const risks = [];
  const cssBody = (selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return stylesheetSource.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "s"))?.[1] ?? "";
  };
  const requires = (body, pattern, message) => {
    if (!pattern.test(body)) risks.push(message);
  };
  if (!/export\s+function\s+BannerAlert\b/u.test(componentSource)
    || !/wl-banner-alert__body/u.test(componentSource)
    || !/wl-banner-alert__copy/u.test(componentSource)
    || !/wl-banner-alert__actions/u.test(componentSource)) {
    risks.push("共享 BannerAlert 必须分离正文区与动作区");
  }
  const root = cssBody(".wl-banner-alert");
  requires(root, /display\s*:\s*flex\b/i, "共享 BannerAlert 根容器必须使用弹性布局");
  requires(root, /flex-wrap\s*:\s*wrap\b/i, "共享 BannerAlert 必须允许动作区在空间不足时换行");
  requires(root, /min-width\s*:\s*0\b/i, "共享 BannerAlert 根容器必须允许安全收缩");
  requires(root, /max-inline-size\s*:\s*100%(?:\s*;|\s*$)/i, "共享 BannerAlert 不得超出所在面板");
  const body = cssBody(".wl-banner-alert__body");
  requires(body, /flex\s*:\s*1\s+1\s+(?!0(?:\D|$))/i, "共享 BannerAlert 正文区必须保留换行动作所需的弹性基准宽度");
  requires(body, /min-width\s*:\s*0\b/i, "共享 BannerAlert 正文区必须允许安全收缩");
  requires(body, /grid-template-columns\s*:\s*auto\s+minmax\(0\s*,\s*1fr\)/i, "共享 BannerAlert 图标不得挤占正文最小宽度");
  const copy = cssBody(".wl-banner-alert__copy");
  requires(copy, /min-width\s*:\s*0\b/i, "共享 BannerAlert 文案必须允许收缩");
  requires(copy, /overflow-wrap\s*:\s*anywhere\b/i, "共享 BannerAlert 长文案必须可换行");
  if (!/export\s*\{\s*BannerAlert\s*\}\s*from\s*["']@workloom\/ui["']/u.test(pcAdapterSource)
    || /(?:function|class)\s+BannerAlert\b|const\s+BannerAlert\s*=/u.test(pcAdapterSource)) {
    risks.push("PC BannerAlert 只能从 @workloom/ui 重导出，不得保留本地实现");
  }
  return risks;
}

/** 伪元素内容会真实显示，却不会经过 JSX/AST；仅允许空装饰或已约束的中文展示属性。 */
export function findStylesheetGeneratedContentRisks(source) {
  const clean = stripComments(source);
  const risks = [];
  for (const match of clean.matchAll(/\bcontent\s*:\s*([^;}]+)/gi)) {
    const value = (match[1] ?? "").trim();
    if (!value || /^(?:none|normal|["']{2})$/i.test(value)) continue;
    for (const variable of value.matchAll(/var\(\s*(--[\w-]+)/gi)) {
      risks.push({
        line: sourceLineAt(clean, match.index ?? 0),
        rule: "CSS 伪元素不得通过变量注入可见内容；请使用受控中文 DOM 文本",
        text: variable[0],
      });
    }
    for (const attribute of value.matchAll(/attr\(\s*([\w-]+)(?:\s+[^)]*)?\)/gi)) {
      if (["aria-label", "data-label", "data-title", "data-tooltip", "title"].includes(attribute[1])) continue;
      risks.push({
        line: sourceLineAt(clean, match.index ?? 0),
        rule: "CSS 伪元素不得直接显示未治理属性；请先映射为中文 data-label/data-title/data-tooltip",
        text: attribute[0],
      });
    }
    for (const literal of value.matchAll(/["']([^"']+)["']/g)) {
      for (const rule of literalLanguageRules(literal[1], "CSS 伪元素")) {
        risks.push({ line: sourceLineAt(clean, match.index ?? 0), rule, text: literal[1].slice(0, 96) });
      }
    }
  }
  return risks;
}

export function findIconAccessibilityRisks(source) {
  const clean = stripComments(source);
  const risks = [];

  for (const tag of openingTags(source, /<IconButton\b/g)) {
    const labelText = tag.text.match(/\blabel\s*=\s*["']([^"']*)["']/)?.[1];
    if (labelText && /[\u3400-\u9fff]/.test(labelText)) continue;
    risks.push({
      line: sourceLineAt(clean, tag.offset),
      rule: "共享 IconButton 必须提供中文 label，并由组件同步生成 aria-label 与 title",
      text: labelText || "IconButton",
    });
  }

  for (const tag of interactiveOpeningTags(source)) {
    if (!tag.text.startsWith("<button")) continue;
    const closing = clean.indexOf("</button>", tag.end);
    if (closing < 0) continue;
    const inner = clean.slice(tag.end, closing);
    const withoutMarkup = inner
      .replace(/\{[^{}]*\}/g, "")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, "")
      .trim();
    const hasDynamicText = /\{[^{}]+\}/.test(inner);
    const emojiOnly = !hasDynamicText && withoutMarkup.length > 0
      && /[\p{Extended_Pictographic}✕×＋⚙⋯⌃⌄▶◀]/u.test(withoutMarkup)
      && !/[一-鿿A-Za-z0-9]/.test(withoutMarkup);
    const iconOnly = /<Icon\b/.test(inner) && !hasDynamicText && !/<span\b/.test(inner) && withoutMarkup.length === 0;
    if (!emojiOnly && !iconOnly) continue;
    const hasAriaLabel = /\baria-label\s*=/.test(tag.text);
    const hasTitle = /\btitle\s*=/.test(tag.text);
    const ariaLabelText = tag.text.match(/\baria-label\s*=\s*(?:["']([^"']*)["']|\{([^}]*)\})/)?.slice(1).find(Boolean) ?? "";
    const titleText = tag.text.match(/\btitle\s*=\s*(?:["']([^"']*)["']|\{([^}]*)\})/)?.slice(1).find(Boolean) ?? "";
    const chineseNames = /[\u3400-\u9fff]/.test(ariaLabelText) && /[\u3400-\u9fff]/.test(titleText);
    if (hasAriaLabel && hasTitle && chineseNames) continue;
    risks.push({
      line: sourceLineAt(clean, tag.offset),
      rule: !hasAriaLabel || !hasTitle
        ? "纯图标按钮必须同时提供中文 aria-label 与 title"
        : "纯图标按钮的 aria-label 与 title 必须使用中文可读名称",
      text: withoutMarkup || "Icon",
    });
  }
  return risks;
}
