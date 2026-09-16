import { clientChineseText } from "@workloom/ui";

const IMPORTANT_REMINDER_FALLBACK = "有一条重要提醒，请打开小织查看详情";

/** 服务端 Inbox 文案进入字幕/TTS 前的中文边界；不用于用户输入。 */
export function inboxSpeechText(title: unknown, body: unknown): string {
  const safeTitle = clientChineseText(title, "");
  const safeBody = clientChineseText(body, "");
  return [safeTitle, safeBody].filter((part) => part.length > 0).join("。") || IMPORTANT_REMINDER_FALLBACK;
}
