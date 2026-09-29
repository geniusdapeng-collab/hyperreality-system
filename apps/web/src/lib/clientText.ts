/**
 * 客户端自然语言展示边界（N-13，2026-09-28 真机实证）。
 *
 * 问题：右侧「织伴」对话框的 AI 回答此前统一走 `@workloom/ui` 的 `clientChineseText`——
 * 该函数是**系统字符串**闸门（字段名、枚举、状态码不许上屏），只要文本里出现一个未登记英文词
 * 就整段换成兜底文案。模型回答里回显提示词标签（如「依据：<facts> 显示…」）属于极常见写法，
 * 于是"问什么都是：应答内容暂时无法显示，请稍后再试"——用户看到的"AI 对话框不能用"。
 *
 * 口径（与 `clientChineseText` 分工）：
 *  - 系统字符串（岗位名、状态、枚举、标题）→ 继续用 `clientChineseText`（严格白名单）；
 *  - 模型/服务端**自然语言**（回答、解释、反问话术）→ 用本模块：
 *    ① 剥掉提示词标签、控制字符；② 机器标识（snake_case / camelCase / 点分代码、SQL、内部字段名）
 *    命中即**局部替换**，不再整段丢弃；③ 纯 JSON 或内部字段名满天飞时仍兜底（保持治理边界）；
 *    ④ 必须含中文（纯英文回答走兜底），保持"客户端以中文为默认展示边界"的产品口径。
 */

/** 内部标识的**自然语言替换**：能翻成人话就翻，不因一个字段名丢掉整段回答 */
const FIELD_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\b(?:preset_key|presetKey)\b/g, "岗位"],
  [/\b(?:workspace_id|workspaceId)\b/g, "工作区"],
  [/\b(?:tenant_id|tenantId)\b/g, "租户"],
  [/\b(?:event_id|eventId)\b/g, "事件编号"],
  [/\b(?:bundle_id|bundleId)\b/g, "行业包"],
  [/\b(?:request_id|requestId)\b/g, "请求编号"],
  [/\b(?:fence_bindings|fenceBindings)\b/g, "围栏绑定"],
];
/** 硬拒绝串：只有真·内部错误/SQL 这种"翻译也没意义"的内容才整段兜底 */
const HARD_MACHINE_TEXT = /Internal Server Error|\b(?:SELECT|INSERT|UPDATE|DELETE)\s+(?:FROM|INTO|SET|WHERE)\b/i;
/** 机器标识 token（snake_case / camelCase / 点分）——局部替换为「该字段」 */
const RAW_FIELD_TOKEN = /(?:^|[^A-Za-z0-9])(?:[a-z][a-z0-9]*_[a-z0-9_]+|[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*|[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+)(?=$|[^A-Za-z0-9])/g;
/** 工程代号（P1/F3.2/L4 一类）——局部剔除 */
const ENGINEERING_CODE = /(?:^|[^A-Za-z0-9])(?:P|F|E|L)\d+(?:\.\d+)?(?=$|[^A-Za-z0-9])/g;
/** 提示词标签的自然化替换：模型常回显这些标签名 */
const TAG_REPLACEMENTS: Array<[RegExp, string]> = [
  [/<\/?(?:facts?|data)>/gi, "实时数据"],
  [/<\/?(?:goal|question|user_input|task)>/gi, "任务"],
  [/<\/?[A-Za-z][A-Za-z0-9_-]{0,24}>/g, ""],
];

/** 单行化 + 去控制字符（保留换行：回答里的分段对可读性重要） */
function normalize(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[ \t]{3,}/g, "  ")
    .trim();
}

/**
 * 自然语言展示边界：能修则修，不能修才兜底。
 * @param value 服务端/模型返回的自然语言
 * @param fallback 兜底文案（默认与右侧对话框既有文案一致）
 */
export function clientNaturalText(value: unknown, fallback = "内容暂时无法显示，请稍后再试。"): string {
  if (typeof value !== "string") return fallback;
  let text = normalize(value);
  if (!text) return fallback;
  // 整段 JSON（模型把结构化输出当回答）→ 兜底，不把机器数据糊到用户脸上
  if (/^[[{][\s\S]*[\]}]$/.test(text.trim())) return fallback;
  if (HARD_MACHINE_TEXT.test(text)) return fallback;
  for (const [pattern, replacement] of FIELD_REPLACEMENTS) text = text.replace(pattern, replacement);
  for (const [pattern, replacement] of TAG_REPLACEMENTS) text = text.replace(pattern, replacement);
  text = text.replace(RAW_FIELD_TOKEN, "该字段").replace(ENGINEERING_CODE, " ");
  text = text.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  // 客户端以中文为默认展示边界：整段无中文（纯英文/纯符号）仍走兜底
  if (!/[\u3400-\u9fff]/.test(text)) return fallback;
  return text;
}

/** 允许为空语义的版本（列表/摘要用：没有可用文案时返回 null，由调用方决定是否隐藏） */
export function clientNaturalTextOrNull(value: unknown): string | null {
  const text = clientNaturalText(value, "");
  return text ? text : null;
}
