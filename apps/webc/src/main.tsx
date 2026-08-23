import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { loadConfig } from "./lib/config";
import "./styles/tokens.css";

// 先加载企业配置（品牌/主题/入口），再渲染——配置失败时自动落内置默认
await loadConfig();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
