/**
 * 显式离线示例：只帮助用户理解对话交互，不返回订单、会员、工单等业务事实。
 * 示例内容必须来自当前已校验的行业投影，不能在基座中硬编码行业数据。
 */
import { getConfig } from "./config";

export function demoChatAnswer(): {
  intent: string;
  answer: string;
  confidence: number;
  citations: [];
} {
  const config = getConfig();
  const configuredExample = config.demoHistory?.find((item) => item.role === "ai")?.text;
  return {
    intent: "离线示例",
    answer: configuredExample
      ? `以下仅为当前行业包提供的离线示例，不会查询数据或创建工单：${configuredExample}`
      : "当前无法连接服务。这里仅演示对话界面，不会查询数据、创建工单或转接人工。恢复连接后请重试。",
    confidence: 0,
    citations: [],
  };
}
