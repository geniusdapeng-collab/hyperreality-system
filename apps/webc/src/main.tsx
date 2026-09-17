import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { OverlayManager } from "@workloom/ui";
import App from "./App";
import { loadConfig } from "./lib/config";
import { getH5EntryToken } from "./lib/api";
import "./styles/tokens.css";
import "@workloom/ui/tokens.css";
import "@workloom/ui/content-safety.css";
import "@workloom/ui/components.css";

// 在任何网络请求前捕获并移除短期入口凭据，避免它进入 Referer、访问日志或截图。
getH5EntryToken();
// 再加载企业配置（品牌/主题/入口）——配置失败时进入中性安全态。
await loadConfig();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <OverlayManager>
      <App />
    </OverlayManager>
  </StrictMode>,
);
