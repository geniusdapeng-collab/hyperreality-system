import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { OverlayManager } from "@workloom/ui";
import "@workloom/ui/tokens.css";
import "@workloom/ui/content-safety.css";
import "@workloom/ui/components.css";
import "./styles.css";
import App from "./App";

document.documentElement.dataset.wlTheme = "dark";
document.documentElement.lang = "zh-CN";

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => undefined));
}

createRoot(document.getElementById("root")!).render(<StrictMode><OverlayManager><App /></OverlayManager></StrictMode>);
